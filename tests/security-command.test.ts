import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { CANT_ASK_IGNORES, CANT_ASK_INSTALL, CANT_ASK_UPDATE, runSecurityReview, SECURITY_REVIEW_USAGE, type SecurityReviewHost } from "../src/app/security-review";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { approvalsPath } from "../src/security/suppressions";
import { COMMANDS } from "../src/tui/commands";
import { FULL_HELP_TEXT, HELP_TEXT } from "../src/tui/help";
import { fakeTools, fixtureRepo, gitIn } from "./fixtures/security-tools/setup";

// These drive a real app and the security tools: 2.5-5 s alone, past bun's 5 s default when the whole suite runs.
setDefaultTimeout(20_000);

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

interface Scripted { host: SecurityReviewHost; asked: string[]; output(): string; fetched: string[] }

/** A host that answers numbered questions from a script (labels), or cannot ask at all. */
function scripted(root: string, home: string, find: NonNullable<SecurityReviewHost["check"]>["find"], answers: string[] | "cannot-ask"): Scripted {
  let text = "";
  const asked: string[] = [];
  const fetched: string[] = [];
  const host: SecurityReviewHost = {
    root, homeDir: home,
    write: (chunk) => { text += chunk; },
    canAsk: () => answers !== "cannot-ask",
    pick: async (question, options) => {
      asked.push(`${question}\n${options.map((option, index) => `${index + 1} ${option.label}`).join(" · ")}`);
      if (answers === "cannot-ask") return undefined;
      const answer = answers.shift();
      // "<enter>" is what Enter does on both terminals: it picks choice 1.
      return answer === "<enter>" ? options[0]?.label : answer;
    },
    check: { find, timeouts: {} },
    install: { fetchBytes: async (url) => { fetched.push(url); throw new Error("no downloads in tests"); } },
  };
  return { host, asked, output: () => text, fetched };
}

test("a new ignore is approved only by a person's 3, and the approval is kept in ~/.casper, never in the repo", async () => {
  const root = await fixtureRepo("casper-sr-approve-"); temps.push(root);
  const home = await temp("casper-sr-home-");
  await writeFile(path.join(root, "app", "extra.py"), "import subprocess\nsubprocess.call('ls', shell=True)  # nosec B602\n");
  const tools = await fakeTools(home);
  const s = scripted(root, home, tools.find, ["Show the line", "Keep it (I approve)"]);
  const report = await runSecurityReview(s.host, []);
  expect(report).toBeDefined();
  expect(s.output()).toContain(`Security check: ${path.basename(root)}`);
  expect(s.output()).toContain("Result: ");
  expect(s.output()).not.toMatch(/\bsecure\b|\bsafe\b/i);
  expect(s.asked[0]).toBe("New ignore you didn't approve: app/extra.py:2  # nosec B602\n1 Leave it flagged · 2 Show the line · 3 Keep it (I approve)");
  expect(s.output()).toContain("app/extra.py:2  subprocess.call('ls', shell=True)  # nosec B602");
  expect(s.asked[1]).toBe("New ignore you didn't approve: app/extra.py:2  # nosec B602\n1 Leave it flagged · 2 Keep it (I approve)");
  expect(s.output()).toContain("Approved 1 ignore. Casper keeps them in ~/.casper, not in the repo; they count from the next run.");
  const store = JSON.parse(await readFile(approvalsPath(await realpath(root), home), "utf8"));
  expect(store.markers).toHaveLength(1);
  expect(store.markers[0]).toMatchObject({ file: "app/extra.py", marker: "# nosec B602" });
  expect(approvalsPath(root, home).startsWith(path.join(home, ".casper"))).toBe(true);
  expect(gitIn(root, "status", "--porcelain")).not.toContain(".casper");
});

test("leaving an ignore flagged approves nothing", async () => {
  const root = await fixtureRepo("casper-sr-leave-"); temps.push(root);
  const home = await temp("casper-sr-home-");
  await writeFile(path.join(root, "app", "extra.py"), "import subprocess\nsubprocess.call('ls', shell=True)  # nosec B602\n");
  const tools = await fakeTools(home);
  const s = scripted(root, home, tools.find, ["Leave it flagged"]);
  await runSecurityReview(s.host, []);
  expect(await stat(approvalsPath(await realpath(root), home)).then(() => true, () => false)).toBe(false);
});

test("Enter never approves: a new ignore stays flagged and a changed ignore file keeps the default", async () => {
  const root = await fixtureRepo("casper-sr-enter-"); temps.push(root);
  const home = await temp("casper-sr-home-");
  await writeFile(path.join(root, ".gitleaks.toml"), "[extend]\nuseDefault = true\n");
  gitIn(root, "add", "-A"); gitIn(root, "commit", "-qm", "ignores");
  await writeFile(path.join(root, ".gitleaks.toml"), "[extend]\nuseDefault = true\n[[allowlists]]\npaths = ['''app/''']\n");
  await writeFile(path.join(root, "app", "extra.py"), "import subprocess\nsubprocess.call('ls', shell=True)  # nosec B602\n");
  const tools = await fakeTools(home);
  const s = scripted(root, home, tools.find, ["<enter>", "<enter>"]);
  await runSecurityReview(s.host, []);
  expect(s.asked).toHaveLength(2);
  expect(s.output()).not.toContain("Approved");
  expect(await stat(approvalsPath(await realpath(root), home)).then(() => true, () => false)).toBe(false);
  expect((await tools.recorded("gitleaks"))?.args.join(" ")).not.toContain(path.join(await realpath(root), ".gitleaks.toml"));
});

test("missing tools get one numbered ask before any download; Enter (1 Stop) runs nothing and downloads nothing", async () => {
  const root = await fixtureRepo("casper-sr-missing-"); temps.push(root);
  const home = await temp("casper-sr-home-");
  const tools = await fakeTools(home, { gitleaks: "missing", zizmor: "missing" });
  const s = scripted(root, home, tools.find, ["<enter>"]);
  expect(await runSecurityReview(s.host, [])).toBeUndefined();
  expect(s.asked[0]).toMatch(/^Security checks need 2 tools that aren't installed: gitleaks, zizmor \(about \d+ MB from github\.com and pypi\.org\)\.\n1 Stop · 2 Run what's installed · 3 Install them$/);
  expect(s.output()).toContain("Stopped. Nothing was installed and no tool ran.");
  expect(s.fetched).toEqual([]);
  expect(await tools.recorded("ruff")).toBeUndefined();

  const again = scripted(root, home, tools.find, ["Run what's installed", "Leave it flagged"]);
  const report = await runSecurityReview(again.host, []);
  expect(again.fetched).toEqual([]);
  expect(report?.tools.find((tool) => tool.id === "gitleaks")).toMatchObject({ status: "not-run", text: "not installed" });
  expect(await tools.recorded("ruff")).toBeDefined();
});

test("a run that cannot ask installs nothing, approves nothing and says so", async () => {
  const root = await fixtureRepo("casper-sr-cannot-"); temps.push(root);
  const home = await temp("casper-sr-home-");
  await writeFile(path.join(root, "app", "extra.py"), "import os\nos.system('ls')  # nosec\n");
  const tools = await fakeTools(home, { gitleaks: "missing" });
  const s = scripted(root, home, tools.find, "cannot-ask");
  await runSecurityReview(s.host, []);
  expect(s.asked).toEqual([]);
  expect(s.fetched).toEqual([]);
  expect(s.output()).toContain(CANT_ASK_INSTALL);
  expect(s.output()).toContain(CANT_ASK_IGNORES);
  const update = scripted(root, home, tools.find, "cannot-ask");
  await runSecurityReview(update.host, ["update"]);
  expect(update.output()).toContain(CANT_ASK_UPDATE);
  expect(update.asked).toEqual([]);
});

test("a changed ignore file counts only after a person says so", async () => {
  const root = await fixtureRepo("casper-sr-file-"); temps.push(root);
  const home = await temp("casper-sr-home-");
  await writeFile(path.join(root, ".gitleaks.toml"), "[extend]\nuseDefault = true\n");
  gitIn(root, "add", "-A"); gitIn(root, "commit", "-qm", "ignores");
  await writeFile(path.join(root, ".gitleaks.toml"), "[extend]\nuseDefault = true\n[[allowlists]]\npaths = ['''app/''']\n");
  const tools = await fakeTools(home);
  const s = scripted(root, home, tools.find, ["Use my changed file", "Leave it flagged"]);
  await runSecurityReview(s.host, []);
  expect(s.asked[0]).toBe(".gitleaks.toml changed since your last commit, so Casper used the default rules.\n1 Keep the default · 2 Use my changed file");
  const store = JSON.parse(await readFile(approvalsPath(await realpath(root), home), "utf8"));
  expect(store.files.map((item: { file: string }) => item.file)).toEqual([".gitleaks.toml"]);
  const recorded = await tools.recorded("gitleaks");
  expect(recorded?.args.join(" ")).toContain(path.join(await realpath(root), ".gitleaks.toml"));

  // You can take that choice back: /security-review ignores offers to remove it, and then the default rules count again.
  const list = scripted(root, home, tools.find, ["Remove .gitleaks.toml  whole file"]);
  await runSecurityReview(list.host, ["ignores"]);
  expect(list.asked.at(-1)).toContain("1 Keep them all · 2 Remove .gitleaks.toml  whole file");
  expect(list.output()).toContain("Removed the approval for .gitleaks.toml (whole file).");
  expect(JSON.parse(await readFile(approvalsPath(await realpath(root), home), "utf8")).files).toEqual([]);
  const again = scripted(root, home, tools.find, ["Keep the default", "Leave it flagged"]);
  await runSecurityReview(again.host, []);
  expect(again.asked[0]).toBe(s.asked[0]!);
  expect((await tools.recorded("gitleaks"))?.args.join(" ")).not.toContain(path.join(await realpath(root), ".gitleaks.toml"));
});

test("/security-review ignores lists approvals and can remove one; bad words are a usage mistake", async () => {
  const root = await fixtureRepo("casper-sr-list-"); temps.push(root);
  const home = await temp("casper-sr-home-");
  await writeFile(path.join(root, "app", "extra.py"), "import os\nos.system('ls')  # nosec\n");
  const tools = await fakeTools(home);
  const first = scripted(root, home, tools.find, ["Keep it (I approve)"]);
  await runSecurityReview(first.host, ["ignores"]);
  expect(first.output()).toContain("New ignores you didn't approve: 1");
  const second = scripted(root, home, tools.find, ["Remove app/extra.py  # nosec"]);
  await runSecurityReview(second.host, ["ignores"]);
  expect(second.output()).toContain("Ignores you approved (kept in ~/.casper, not in the repo): 1");
  expect(second.output()).toContain("Removed the approval for app/extra.py  # nosec.");
  const store = JSON.parse(await readFile(approvalsPath(await realpath(root), home), "utf8"));
  expect(store.markers).toEqual([]);
  await expect(runSecurityReview(first.host, ["model"])).rejects.toThrow(SECURITY_REVIEW_USAGE);
});

test("/security-review in a one-shot run goes through the app, starts no model and cannot ask", async () => {
  const root = await fixtureRepo("casper-sr-app-"); temps.push(root);
  const home = await temp("casper-sr-home-");
  const tools = await fakeTools(home, { gitleaks: "missing" });
  let output = "";
  let started = false;
  const app = new CasperApp({
    runtimeFactory: () => { started = true; throw new Error("no model in this test"); }, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    securitySeams: { check: { find: tools.find } },
    output: { write(text: string) { output += text; } },
  });
  try {
    await app.runOnce("/security-review", root);
  } finally { await app.close(); }
  expect(started).toBe(false);
  // The second line says what holds the tools in this session (see securityNetworkLine).
  expect(output).toContain("Casper runs these tools in the shell sandbox: no network, no passwords or tokens");
  expect(output).toContain(CANT_ASK_INSTALL);
  expect(output).toMatch(/Result: \d+ problems/);
});

test("/security-review is in the help and the command list", () => {
  expect(COMMANDS.some((command) => command.name === "security-review")).toBe(true);
  expect(HELP_TEXT).toContain("/security-review       Run the pinned security tools here, then offer an AI review (asks first)");
  expect(FULL_HELP_TEXT).toContain("/security-review ai               The same; where Casper can't ask (one-shot, --json), runs the AI review");
  expect(FULL_HELP_TEXT).toContain("/security-review ignores");
  expect(FULL_HELP_TEXT).toContain("Exit 0 no problems, 1 problems, 64 usage mistake");
});
