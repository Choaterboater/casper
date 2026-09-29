import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpCheck } from "../src/mcp/check/index";
import { findRepoCommands, repoFinding } from "../src/mcp/check/repo";
import type { McpCheckCommand } from "../src/cli-args";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-mcp-check-repo-"));
  temps.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

const command = (repoPath: string, extra: Partial<McpCheckCommand> = {}): McpCheckCommand =>
  ({ repo: repoPath, live: false, quick: false, strict: false, json: false, env: {}, ...extra });

test("a Makefile test target with no pytest gives make test, and unittest runs the safety files", async () => {
  const root = await repo({
    "Makefile": "test:\n\tuv run python -m unittest discover -s tests -v\n",
    "pyproject.toml": "[project]\nname = \"junos\"\ndependencies = [\"junos-eznc\"]\n",
    "uv.lock": "",
    "tests/test_blocklist_guardrails.py": "",
    "tests/test_write_gate_defaults.py": "",
    "tests/test_device_data.py": "",
  });
  const found = await findRepoCommands(root);
  expect(found.tests?.command).toBe("make test");
  expect(found.safetyTests?.command).toBe("uv run python -m unittest tests.test_blocklist_guardrails tests.test_write_gate_defaults");
  expect(found.safetyTests?.summary).toBe("2 files");
  expect(found.safetyTests?.command).not.toContain("test_device_data");
  expect(found.testFiles).toEqual(["tests/test_blocklist_guardrails.py", "tests/test_device_data.py", "tests/test_write_gate_defaults.py"]);
});

test("a [project.scripts] doctor with uv.lock runs as uv run, and pytest runs the safety files by name", async () => {
  const root = await repo({
    "pyproject.toml": "[project]\nname = \"hpe\"\n\n[project.scripts]\nhpe-networking-mcp = \"hpe.server:main\"\nhpe-mcp-doctor = \"hpe.cli.doctor:main\"\n\n[dependency-groups]\ndev = [\"pytest>=8\"]\n",
    "uv.lock": "",
    "tests/unit/test_write_gate_defaults.py": "",
    "tests/unit/test_router_readonly_and_rate.py": "",
    "tests/unit/test_device_data.py": "",
  });
  const found = await findRepoCommands(root);
  expect(found.doctor?.command).toBe("uv run hpe-mcp-doctor");
  expect(found.tests?.command).toBe("uv run pytest");
  expect(found.safetyTests?.command).toBe("uv run pytest tests/unit/test_router_readonly_and_rate.py tests/unit/test_write_gate_defaults.py");
});

test("a declared pytest safety marker runs -m safety instead of guessing by name", async () => {
  const root = await repo({
    "pyproject.toml": "[project]\nname = \"x\"\ndependencies = [\"pytest\"]\n\n[tool.pytest.ini_options]\nmarkers = [\n  \"slow: slow tests\",\n  \"safety: write gates and guards\",\n]\n",
    "tests/test_write_gate.py": "",
  });
  const found = await findRepoCommands(root);
  expect(found.safetyTests).toMatchObject({ command: "python3 -m pytest -m safety", summary: "-m safety" });
});

test("a slow marker alone is not a safety marker", async () => {
  const root = await repo({ "pyproject.toml": "[project]\ndependencies = [\"pytest\"]\n[tool.pytest.ini_options]\nmarkers = [\"slow: slow\"]\n" });
  expect((await findRepoCommands(root)).safetyTests).toBeUndefined();
});

test("package.json doctor and test scripts, and scripts/doctor.py", async () => {
  const node = await repo({ "package.json": JSON.stringify({ scripts: { doctor: "node doctor.js", test: "bun test" } }), "bun.lock": "" });
  expect(await findRepoCommands(node)).toMatchObject({ doctor: { command: "bun run doctor" }, tests: { command: "bun run test" } });
  const script = await repo({ "scripts/doctor.py": "print('ok')", "Makefile": "doctor:\n\ttrue\n" });
  expect((await findRepoCommands(script)).doctor?.command).toBe("python3 scripts/doctor.py");
  const make = await repo({ "Makefile": "doctor:\n\ttrue\n" });
  expect((await findRepoCommands(make)).doctor?.command).toBe("make doctor");
});

test("repo command results become plain lines", () => {
  const base = { name: "test" as const, command: "x", cwd: "/", stdout: "", stderr: "", truncated: false, durationMs: 12_300, signal: null };
  expect(repoFinding("doctor", { command: "uv run hpe-mcp-doctor" }, { ...base, status: "pass", exitCode: 0, stdout: "checks...\nSummary: 0 fail, 3 warn, 41 ok\n" }).text)
    .toBe("uv run hpe-mcp-doctor (12 s) · Summary: 0 fail, 3 warn, 41 ok");
  expect(repoFinding("tests", { command: "make test" }, { ...base, status: "fail", exitCode: 2, stdout: "== 2 failed, 40 passed in 3s ==" }))
    .toMatchObject({ status: "fail", text: "make test: 2 failed (see output above)" });
  expect(repoFinding("tests", { command: "make test" }, { ...base, status: "fail", exitCode: 1, stderr: "FAILED (failures=1, errors=2)" }).text)
    .toBe("make test: 3 failed (see output above)");
  expect(repoFinding("tests", { command: "uv run pytest", uv: true }, { ...base, status: "fail", exitCode: 1, stderr: "ModuleNotFoundError: No module named 'junos'" }).text)
    .toBe("Not set up: uv run pytest needs packages that are not installed. Run `uv sync` in the repo, then check again.");
});

test("the check runs doctor, safety tests and tests in the repo; --quick skips the full tests", async () => {
  const root = await repo({
    ".casper/mcp-check.json": JSON.stringify({ doctor: "echo 'Summary: 0 fail, 1 warn, 5 ok'", safetyTests: "echo safe > safety-ran.txt", tests: "echo boom >&2; exit 3" }),
  });
  const written: string[] = [];
  const report = await new McpCheck(command(root), { write: (text) => { written.push(text); } }).run();
  const repoLines = report.findings.filter((finding) => finding.section === "repo");
  expect(repoLines.map((finding) => [finding.status, finding.label])).toEqual([["ok", "doctor"], ["ok", "safety tests"], ["fail", "tests"]]);
  expect(repoLines[0]!.text).toContain("Summary: 0 fail, 1 warn, 5 ok");
  expect(repoLines[2]!.text).toBe("echo boom >&2; exit 3: exit code 3 (see output above)");
  expect(await readFile(path.join(root, "safety-ran.txt"), "utf8")).toBe("safe\n");
  // The failing command's output is shown above the report.
  expect(written.join("")).toContain("tests output (secrets hidden):\n  | boom");
  expect(report.exitCode).toBe(1);

  const quick = await new McpCheck(command(root, { quick: true })).run();
  expect(quick.findings.find((finding) => finding.label === "tests")).toMatchObject({ status: "skip", text: "--quick" });
});

test("a repo with nothing to run says so, and with no start source names the -- form", async () => {
  const root = await repo({ "README.md": "Run it with `uv run server`." });
  const report = await new McpCheck(command(root)).run();
  const lines = report.findings.map((finding) => `${finding.status} ${finding.label}: ${finding.text}`);
  expect(lines).toContain("none doctor: No doctor found. Add a doctor script, or set it in .casper/mcp-check.json.");
  expect(lines).toContain("warn safety tests: No safety tests found (names with write, gate, readonly, guard, block, redact, confirm, dry_run, annotation).");
  expect(lines.join("\n")).toContain("casper mcp check . -- <command>");
});

test("a broken .casper/mcp-check.json is reported, and the other checks still run", async () => {
  const root = await repo({ ".casper/mcp-check.json": "{ nope", "Makefile": "test:\n\ttrue\n" });
  const report = await new McpCheck(command(root)).run();
  expect(report.findings[0]).toMatchObject({ status: "fail", label: "settings" });
  const tests = report.findings.find((finding) => finding.label === "tests")!;
  expect(tests.status).toBe("ok");
  expect(tests.text).toMatch(/^make test \(\d+\.\d s\)$/);
});
