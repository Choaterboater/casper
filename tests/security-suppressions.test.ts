import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectStateDirectory } from "../src/project/model";
import { changesSinceHead, gitState } from "../src/security/git";
import { readRepoText, SecurityCheck } from "../src/security/run";
import {
  applyIgnores, approvalsPath, approveIgnore, configIgnores, judgeIgnoreFiles, loadApprovals, markersOnLine, newIgnores, pythonStatementRanges,
  type IgnoreContext,
} from "../src/security/suppressions";
import type { SecurityFinding } from "../src/security/types";
import { fakeTools, gitIn } from "./fixtures/security-tools/setup";
import { needsSymlinks } from "./support/platform";
import { removeTempDir } from "./support/temp-dir";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

// Like hpe-networking-mcp advisory_index.py: ruff reports the call's first lines, bandit's nosec sits on
// the statement's last line.
const DB_PY = `import sqlite3


def lookup(db: sqlite3.Connection, name: str) -> list:
    return db.execute(
        "SELECT * FROM devices WHERE name = '%s'"
        % name
    ).fetchall()  # nosec B608


def other(db: sqlite3.Connection, name: str) -> list:
    return db.execute("SELECT * FROM t WHERE n = '%s'" % name).fetchall()
`;

const s608 = (line: number, endLine?: number): SecurityFinding => ({ tool: "ruff", file: "db.py", line, ...(endLine ? { endLine } : {}), rule: "S608", severity: "medium", text: "Possible SQL injection" });

async function repo(files: Record<string, string>, commit = true): Promise<string> {
  const root = await temp("casper-security-ignores-");
  for (const [file, text] of Object.entries(files)) {
    await Bun.write(path.join(root, file), text);
  }
  gitIn(root, "init", "-q");
  if (commit) { gitIn(root, "add", "-A"); gitIn(root, "commit", "-qm", "init"); }
  return root;
}

async function context(root: string, home: string): Promise<IgnoreContext> {
  const git = await gitState(root);
  const changes = await changesSinceHead(root, git);
  return { root, git, changed: changes?.changed, untracked: changes?.untracked, approvals: await loadApprovals(root, home), readText: (file) => readRepoText(root, file) };
}

test("a statement's range covers every line of a multi-line call", () => {
  const ranges = pythonStatementRanges(DB_PY);
  expect(ranges[5]).toEqual([5, 8]);
  expect(ranges[6]).toEqual([5, 8]);
  expect(ranges[8]).toEqual([5, 8]);
  expect(ranges[12]).toEqual([12, 12]);
  expect(pythonStatementRanges("x = '''a\n# nosec\n'''\ny = 1\n")[1]).toEqual([1, 3]);
});

test("a committed # nosec B608 hides ruff S608 on the same statement, even on its last line", async () => {
  const root = await repo({ "db.py": DB_PY });
  const home = await temp("casper-security-home-");
  const outcome = await applyIgnores([s608(6, 7), s608(12)], await context(root, home));
  expect(outcome.visible.map((finding) => finding.line)).toEqual([12]);
  expect(outcome.hidden.committed).toBe(1);
  expect(outcome.flagged).toEqual([]);
});

test("a new, uncommitted # nosec hides nothing and is listed as a new ignore", async () => {
  const root = await repo({ "db.py": DB_PY });
  const home = await temp("casper-security-home-");
  await writeFile(path.join(root, "db.py"), DB_PY.replace("% name).fetchall()\n", "% name).fetchall()  # nosec\n"));
  const ctx = await context(root, home);
  const outcome = await applyIgnores([s608(6, 7), s608(12)], ctx);
  expect(outcome.visible.map((finding) => finding.line)).toEqual([12]);
  expect(outcome.flagged).toEqual([{ tool: "ruff", file: "db.py", line: 12, marker: "# nosec", codes: [], status: "new" }]);
  expect((await newIgnores(ctx)).map((entry) => `${entry.file}:${entry.line} ${entry.marker}`)).toEqual(["db.py:12 # nosec"]);
});

test("a marker in an untracked file or a repo with no commit is new", async () => {
  const root = await repo({ "db.py": DB_PY });
  const home = await temp("casper-security-home-");
  await writeFile(path.join(root, "new.py"), "import os\nos.system(cmd)  # nosec\n");
  const outcome = await applyIgnores([{ tool: "ruff", file: "new.py", line: 2, rule: "S605", severity: "medium", text: "shell" }], await context(root, home));
  expect(outcome.visible).toHaveLength(1);
  expect(outcome.flagged[0]!.status).toBe("new");
  const fresh = await repo({ "db.py": DB_PY }, false);
  const noHead = await applyIgnores([s608(6, 7)], await context(fresh, home));
  expect(noHead.visible).toHaveLength(1);
});

test("approving writes only to ~/.casper/projects/<project>/security-approved.json, and then the marker counts", async () => {
  const root = await repo({ "db.py": DB_PY });
  const home = await temp("casper-security-home-");
  const line = "    return db.execute(\"SELECT * FROM t WHERE n = '%s'\" % name).fetchall()  # nosec B608";
  await writeFile(path.join(root, "db.py"), DB_PY.replace(/^ {4}return db\.execute\("SELECT \* FROM t.*$/m, line));
  const before = await applyIgnores([s608(12)], await context(root, home));
  expect(before.visible).toHaveLength(1);
  const written = await approveIgnore(root, home, before.flagged[0]!, line);
  // Kept under the project's real folder (macOS's temp folder is behind a link: /var is /private/var).
  expect(written).toBe(approvalsPath(await realpath(root), home));
  expect(written.startsWith(projectStateDirectory(await realpath(root), home))).toBe(true);
  expect(written.startsWith(root)).toBe(false);
  expect(gitIn(root, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean)).toEqual([" M db.py"]);
  expect(JSON.parse(await readFile(written, "utf8")).markers).toHaveLength(1);
  const after = await applyIgnores([s608(12)], await context(root, home));
  expect(after.visible).toEqual([]);
  expect(after.hidden.approved).toBe(1);
});

test("a git-ignored file was never committed: its markers and ignore files do not count", async () => {
  const root = await repo({ ".gitignore": ".env\n.gitleaks.toml\n", "db.py": DB_PY });
  const home = await temp("casper-security-home-");
  await writeFile(path.join(root, ".env"), "API=abc # gitleaks:allow\n");
  await writeFile(path.join(root, ".gitleaks.toml"), "[allowlist]\npaths = ['''.*''']\n");
  const ctx = await context(root, home);
  const outcome = await applyIgnores([{ tool: "gitleaks", file: ".env", line: 1, rule: "generic-api-key", severity: "high", text: "secret" }], ctx);
  expect(outcome.visible).toHaveLength(1);
  expect(outcome.flagged[0]).toMatchObject({ tool: "gitleaks", status: "new" });
  expect(await judgeIgnoreFiles(ctx)).toEqual([expect.objectContaining({ file: ".gitleaks.toml", status: "changed", used: false })]);
});

test("outside git Casper can't tell who added an ignore, so it hides nothing", async () => {
  const root = await temp("casper-security-nogit-");
  await writeFile(path.join(root, "db.py"), DB_PY);
  const home = await temp("casper-security-home-");
  const outcome = await applyIgnores([s608(6, 7)], await context(root, home));
  expect(outcome.visible).toHaveLength(1);
  expect(outcome.flagged[0]!.status).toBe("unknown");
});

test("markers: nosec codes map to ruff S numbers; nosemgrep, gitleaks:allow, zizmor and ansible noqa are read", () => {
  expect(markersOnLine("a.py", 1, "x = 1  # nosec: B608, B105")[0]!.codes).toEqual(["S608", "S105"]);
  expect(markersOnLine("a.py", 1, "x = 1  # noqa: E501")).toEqual([]);
  expect(markersOnLine("a.py", 1, "x = 1  # noqa: S105")[0]!.codes).toEqual(["S105"]);
  expect(markersOnLine("a.py", 1, "run(x)  # nosemgrep: casper.mcp-tool-shell-from-input")[0]).toMatchObject({ tool: "semgrep", codes: ["casper.mcp-tool-shell-from-input"] });
  expect(markersOnLine(".env.example", 1, "KEY=abc # gitleaks:allow")[0]!.tool).toBe("gitleaks");
  expect(markersOnLine("ci.yml", 1, "  - run: echo ${{ x }}  # zizmor: ignore[template-injection]")[0]).toMatchObject({ tool: "zizmor", codes: ["template-injection"] });
  expect(markersOnLine("site.yml", 1, "    - shell: curl x | sh  # noqa: risky-shell-pipe")[0]).toMatchObject({ tool: "ansible-lint", codes: ["risky-shell-pipe"] });
});

test("committed zizmor.yml and bandit skips count; a changed config file is not used", async () => {
  const root = await repo({
    "zizmor.yml": "rules:\n  unpinned-uses:\n    ignore:\n      - ci.yml:9\n",
    "pyproject.toml": "[project]\nname = \"x\"\n\n[tool.bandit]\nskips = [\"B324\"]\n",
  });
  const home = await temp("casper-security-home-");
  const findings: SecurityFinding[] = [
    { tool: "zizmor", file: ".github/workflows/ci.yml", line: 9, rule: "unpinned-uses", severity: "high", text: "unpinned" },
    { tool: "zizmor", file: ".github/workflows/ci.yml", line: 10, rule: "template-injection", severity: "high", text: "injection" },
    { tool: "ruff", file: "app.py", line: 3, rule: "S324", severity: "medium", text: "md5" },
  ];
  let ctx = await context(root, home);
  let files = await judgeIgnoreFiles(ctx);
  expect(files.map((file) => [file.file, file.status, file.used])).toEqual([["zizmor.yml", "committed", true], ["pyproject.toml", "committed", true]]);
  expect((await applyIgnores(findings, ctx, configIgnores(files))).visible.map((finding) => finding.rule)).toEqual(["template-injection"]);

  // A dependency edit in pyproject.toml does not matter; an edit to the bandit table does.
  await writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"x\"\ndependencies = [\"httpx\"]\n\n[tool.bandit]\nskips = [\"B324\"]\n");
  ctx = await context(root, home);
  expect((await judgeIgnoreFiles(ctx)).find((file) => file.file === "pyproject.toml")!.status).toBe("committed");
  await writeFile(path.join(root, "pyproject.toml"), "[project]\nname = \"x\"\n\n[tool.bandit]\nskips = [\"B324\", \"B608\"]\n");
  await writeFile(path.join(root, "zizmor.yml"), "rules:\n  template-injection:\n    disable: true\n");
  ctx = await context(root, home);
  files = await judgeIgnoreFiles(ctx);
  expect(files.map((file) => [file.file, file.status, file.used])).toEqual([["zizmor.yml", "changed", false], ["pyproject.toml", "changed", false]]);
  expect((await applyIgnores(findings, ctx, configIgnores(files))).visible).toHaveLength(3);
  // "1 Use my changed file" for this run.
  files = await judgeIgnoreFiles(ctx, { useChanged: ["zizmor.yml"] });
  expect(files.find((file) => file.file === "zizmor.yml")).toMatchObject({ status: "chosen", used: true });
});

test("a modified .gitleaks.toml is not given to gitleaks, and the report says so", async () => {
  const root = await repo({ ".gitleaks.toml": "[extend]\nuseDefault = true\n", "a.py": "print(1)\n" });
  const home = await temp("casper-security-home-");
  let tools = await fakeTools(home, { gitleaks: "clean", ruff: "clean" });
  let report = await new SecurityCheck({ root, homeDir: home, find: tools.find, only: ["gitleaks"] }).run();
  let args = (await tools.recorded("gitleaks"))!.args;
  // The tools run in the project's real folder.
  expect(args[args.indexOf("--config") + 1]).toBe(path.join(await realpath(root), ".gitleaks.toml"));
  expect(report.ignoreFiles).toEqual([{ file: ".gitleaks.toml", tool: "gitleaks", status: "committed", used: true }]);

  await writeFile(path.join(root, ".gitleaks.toml"), "[extend]\nuseDefault = true\n[[allowlists]]\npaths = ['''.*''']\n");
  tools = await fakeTools(home, { gitleaks: "clean" });
  report = await new SecurityCheck({ root, homeDir: home, find: tools.find, only: ["gitleaks"] }).run();
  args = (await tools.recorded("gitleaks"))!.args;
  expect(args[args.indexOf("--config") + 1]).not.toContain(root);
  expect(report.ignoreFiles).toEqual([{ file: ".gitleaks.toml", tool: "gitleaks", status: "changed", used: false }]);
  const { formatSecurityReport } = await import("../src/security/format");
  expect(formatSecurityReport(report)).toContain(".gitleaks.toml changed since your last commit, so Casper used the default rules.");
  // Nothing was written inside the repo.
  expect((await readdir(root)).sort()).toEqual([".git", ".gitleaks.toml", "a.py"]);
});

needsSymlinks("an approval made through a linked folder counts when the project is opened by its real path, and back", async () => {
  // macOS's temp folder is such a link (/var is /private/var), and so is a linked ~/code.
  const root = await repo({ "db.py": DB_PY });
  const home = await temp("casper-security-home-");
  const linked = path.join(await temp("casper-security-link-"), "project");
  await symlink(root, linked);
  const line = "    return db.execute(\"SELECT * FROM t WHERE n = '%s'\" % name).fetchall()  # nosec B608";
  await writeFile(path.join(root, "db.py"), DB_PY.replace(/^ {4}return db\.execute\("SELECT \* FROM t.*$/m, line));
  const before = await applyIgnores([s608(12)], await context(linked, home));
  await approveIgnore(linked, home, before.flagged[0]!, line);
  for (const opened of [await realpath(root), linked]) {
    expect((await loadApprovals(opened, home)).markers).toHaveLength(1);
  }
});
