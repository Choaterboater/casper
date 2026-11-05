import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { removeTempDir } from "./support/temp-dir";

/** A project the model sets up in its own turn (package.json with a test script) is checked on that turn. */
async function run(files: Record<string, string> | ((turn: number) => Record<string, string>), options: { projectYaml?: string; checkFirst?: string; before?: Record<string, string>; viaWriteTool?: readonly string[]; request?: string;
  /** The turn (0 is the request's) that ends at the round's turn budget. */ turnLimitOn?: number; /** Files read back after the task. */ read?: readonly string[] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-new-checks-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(path.join(project, "notes.txt"), "Only notes here before the task.\n");
  for (const [name, text] of Object.entries(options.before ?? {})) await writeFile(path.join(project, name), text);
  if (options.projectYaml) { await mkdir(path.join(project, ".casper")); await writeFile(path.join(project, ".casper/project.yaml"), options.projectYaml); }
  let tools: RuntimeTool[] = [];
  let afterFileEdit: ((file: string, signal?: AbortSignal) => Promise<unknown>) | undefined;
  const checkRuns: string[] = [];
  let turn = 0;
  const prompts: string[] = [];
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const runtime: AgentRuntime = {
    async start(start) {
      tools = start.tools ?? [];
      afterFileEdit = start.afterFileEdit;
      return {
        setTools: (next: RuntimeTool[]) => { tools = next; },
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {},
        prompt: async (text: string) => {
          prompts.push(text);
          if (options.checkFirst) {
            const check = tools.find((tool) => tool.name === "casper_check");
            checkRuns.push((await check!.execute({ check: options.checkFirst })).text);
          }
          const now = turn++;
          const written = typeof files === "function" ? files(now) : files;
          for (const [name, text] of Object.entries(written)) {
            // The AI's own write tool, as a model writes; otherwise a program writing the file.
            await mkdir(path.dirname(path.join(project, name)), { recursive: true }); await writeFile(path.join(project, name), text);
            // Written with the AI's own write tool, which reports each file it writes; otherwise a program wrote it.
            if (options.viaWriteTool?.includes(name)) await afterFileEdit?.(path.join(project, name));
          }
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          emit({ type: "assistant_text_delta", delta: "Set up the project.\n" });
          emit({ type: "assistant_response_end", stopReason: "stop" });
          if (now === options.turnLimitOn) emit({ type: "turn_limit", turns: 12 });
        },
      };
    },
    async dispose() {},
  };
  let output = "";
  const app = new CasperApp({
    input: new PassThrough(), output: { write: (text: string) => { output += text; } },
    runtimeFactory: () => runtime, sessionHomeDir: home, noSandbox: true,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  } as ConstructorParameters<typeof CasperApp>[0]);
  try {
    await app.runOnce(options.request ?? "set up a small package with a test script", project);
    const read: Record<string, string | undefined> = {};
    for (const name of options.read ?? []) read[name] = await readFile(path.join(project, name), "utf8").catch(() => undefined);
    return { output, result: app.getLastTaskResult(), checkRuns, prompts, read };
  } finally {
    await app.close();
    await removeTempDir(root);
  }
}

test("a package.json the model writes in this turn gets its test check on this turn", async () => {
  const { output, result } = await run({ "package.json": JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }) });
  expect(output).not.toContain("no checks configured");
  expect(output).toContain("✓ Checks passed · test passed");
  expect(result?.verification?.results.map((check) => check.name)).toEqual(["test"]);
  // Only package.json changed: no app code, so nothing to prove.
  expect(result?.proofSkipped).toContain("no app code");
}, 60_000);

test("a project whose only check is a check script is checked with it after the change", async () => {
  const { output, result } = await run({ "package.json": JSON.stringify({ name: "demo", scripts: { check: "bun -e \"process.exit(0)\"" } }) });
  expect(output).not.toContain("no tests yet");
  expect(output).toContain("✓ Checks passed · test passed");
  expect(result?.verification?.results.map((check) => [check.name, check.command])).toEqual([["test", "bun run check"]]);
}, 60_000);

test("tests Casper has no command for are named on the receipt, not called missing", async () => {
  const { output, result } = await run({ "package.json": "{}", "add.js": "module.exports = (a, b) => a + b;\n", "add.test.js": "test('adds', () => {});\n" });
  expect(output).not.toContain("no tests yet");
  expect(output).toContain("Casper found tests but no command that runs them");
  expect(result).toMatchObject({ autoSkipped: "no-checks", testsWithoutCommand: true });
});

test("the model's first bun test in a test folder is checked on the same turn", async () => {
  const { output, result } = await run({ "src/add.ts": "export const add = (a: number, b: number) => a + b;\n",
    "tests/add.test.ts": "import { expect, test } from 'bun:test';\nimport { add } from '../src/add';\ntest('adds', () => expect(add(1, 2)).toBe(3));\n" },
  { before: { "package.json": JSON.stringify({ name: "demo" }) } });
  expect(output).not.toContain("no tests yet");
  expect(output).toContain("✓ test passed");
  expect(result?.verification?.results.map((check) => [check.name, check.command])).toEqual([["test", "bun test"]]);
}, 60_000);

test("a change that adds no check leaves the receipt as it was", async () => {
  const { output } = await run({ "README.md": "# demo\n" });
  expect(output).toContain("no tests yet");
});

test("a check the model ran before setting up the project stays on the task and the receipt", async () => {
  const { result, checkRuns } = await run({ "package.json": JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }) },
    { projectYaml: "verify:\n  checks:\n    docs: echo docs\nverification:\n  checks: [test]\n", checkFirst: "docs" });
  expect(checkRuns[0]).toContain('"status":"pass"');
  const names = result?.verification?.results.map((check) => check.name) ?? [];
  expect(names).toContain("test");
  expect(names).toContain("docs");
});

test("a recorded result stays fresh when the new project keeps its command, and goes stale when the command changes", async () => {
  const { VerifierRegistry } = await import("../src/verify/registry");
  const { VerificationTask } = await import("../src/verify/task");
  const cwd = await mkdtemp(path.join(os.tmpdir(), "casper-new-registry-"));
  await mkdir(path.join(cwd, "src")); await writeFile(path.join(cwd, "src/a.py"), "x = 1\n");
  try {
    const registry = (commands: Record<string, string>) => {
      const next = new VerifierRegistry();
      for (const [name, command] of Object.entries(commands)) next.register({ name, command, scope: { inputs: ["src"] },
        run: async () => ({ name, command, cwd, status: "pass", exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 1 }) });
      return next;
    };
    const task = new VerificationTask(registry({ docs: "echo docs", test: "python3 -m unittest discover" }), cwd);
    await task.run(["docs", "test"]);
    task.useRegistry(registry({ docs: "echo docs", test: "uv run pytest", lint: "uv run ruff check ." }));
    const results = await task.refresh();
    expect(Object.fromEntries(results.map((result) => [result.name, result.freshness]))).toEqual({ docs: "fresh", test: "stale" });
    // A check the new registry doesn't have is dropped.
    task.useRegistry(registry({ test: "uv run pytest" }));
    expect(task.checks).toEqual(["test"]);
    await task.close();
  } finally { await removeTempDir(cwd); }
});

const PACKAGE = JSON.stringify({ name: "demo", scripts: { test: "bun test" } });
const ADD = "export const add = (a: number, b: number) => a + b;\n";
const ADD_TEST = "import { expect, test } from 'bun:test';\nimport { add } from '../src/add';\ntest('adds', () => expect(add(1, 2)).toBe(3));\n";

test("a new project's tests are proven against the folder from before the task, with its own setup and none of its code", async () => {
  const { output, result } = await run({ "package.json": PACKAGE, "src/add.ts": ADD, "tests/add.test.ts": ADD_TEST });
  expect(output).toContain("• Casper checking that the tests fail without the change");
  expect(result?.proof).toMatchObject({ status: "proven", check: "test", command: "bun run test" });
  expect(output).not.toContain("the tests came with this change");
}, 60_000);

test("a new project's test that never uses its code is unproven, and gets the round that adds one that does", async () => {
  const vacuous = "import { expect, test } from 'bun:test';\ntest('adds', () => expect(1 + 2).toBe(3));\n";
  const { output, result } = await run({ "package.json": PACKAGE, "src/add.ts": ADD, "tests/add.test.ts": vacuous });
  expect(output).toContain("add a test that fails without the change");
  expect(result?.proof?.status).toBe("unproven");
}, 60_000);

test("a new project's failing check is repaired: the empty folder from before is never read as the check failing before too", async () => {
  const failing = "import { expect, test } from 'bun:test';\nimport { add } from '../src/add';\ntest('adds', () => expect(add(1, 2)).toBe(4));\n";
  const { output, result } = await run((turn) => ({ "package.json": PACKAGE, "src/add.ts": ADD, "tests/add.test.ts": turn ? ADD_TEST : failing }));
  expect(output).not.toContain("failed before this change too");
  expect(output).toContain("✓ test passed");
  expect(result?.verification?.repairAttempts).toBe(1);
  expect(result?.proof?.status).toBe("proven");
}, 60_000);

const REPORT = "export const total = (rows: number[]) => rows.reduce((sum, row) => sum + row, 0);\n";
const REPORT_TEST = (from: string) => `import { expect, test } from 'bun:test';\nimport { total } from '../${from}';\ntest('totals', () => expect(total([1, 2])).toBe(3));\n`;

test("a project's own reports/ package keeps its proof: only builds/, runs/ and results/ are a program's output", async () => {
  const { result } = await run({ "reports/total.ts": REPORT, "tests/total.test.ts": REPORT_TEST("reports/total") }, { before: { "package.json": PACKAGE } });
  expect(result?.proof?.status).toBe("proven");
}, 60_000);

test("code the AI's own write tool put in runs/ keeps its proof; what a program wrote there doesn't need one", async () => {
  const files = { "runs/total.ts": REPORT, "tests/total.test.ts": REPORT_TEST("runs/total") };
  const written = await run(files, { before: { "package.json": PACKAGE }, viaWriteTool: ["runs/total.ts"] });
  expect(written.result?.proof?.status).toBe("proven");
  const made = await run(files, { before: { "package.json": PACKAGE } });
  expect(made.result?.proof).toBeUndefined();
}, 60_000);

const BUILD = "Build a small adder package: add(a, b) returns their sum, with tests.";

test("a build whose checks pass gets the requirements review, then one self-review turn, and its checks again after edits", async () => {
  const { output, prompts } = await run((turn) => ({ "package.json": PACKAGE, "src/add.ts": ADD, "tests/add.test.ts": ADD_TEST, ...(turn === 2 ? { "src/sum.ts": ADD } : {}) }),
    { request: BUILD });
  expect(output).toContain("↻ review: checking the work against every requirement");
  expect(output).toContain("↻ self-review: re-reading the request and the code once more");
  expect(prompts[1]).toStartWith("Casper requirements review.");
  expect(prompts[2]).toStartWith("Casper self-review.");
  for (const line of ["writes that belong together are in one transaction", "answers 400, not 500", "breaks ties with a unique key", "every claim matches the code"]) {
    expect(prompts[2]).toContain(line);
  }
  // The self-review changed a file: the checks ran again.
  expect(output.split("• Casper checking").length).toBeGreaterThan(2);
}, 60_000);

// A homepage build (v0.4.13): the requirements review installed "a permanent test weather widget" through the
// running app, which wrote it into config/widgets.yaml and config/secrets.yaml; the round hit its turn budget and the build
// shipped a broken card. What a review round's runs write into the app's settings is put back as the AI left them.
const WIDGETS = "- id: clock-1\n  type: clock\n";
const TEST_WIDGET = `${WIDGETS}- id: weather-1\n  type: weather\n  options:\n    url: http://weather-mock.invalid\n`;
const homepage = (turn: number) => ({ "package.json": PACKAGE, "src/add.ts": ADD, "tests/add.test.ts": ADD_TEST,
  ...turn === 0 ? { "config/widgets.yaml": WIDGETS } : {},
  // The review round: the app it started writes the test widget and its key.
  ...turn === 1 ? { "config/widgets.yaml": TEST_WIDGET, "config/secrets.yaml": "weather-1:\n  apiKey: test-key\n" } : {} });

for (const cutOff of [false, true]) {
  test(`settings a build's review round wrote for testing are put back as the AI left them${cutOff ? ", also when the round stops at its turn budget" : ""}`, async () => {
    const { output, result, prompts, read } = await run(homepage,
      { request: BUILD, read: ["config/widgets.yaml", "config/secrets.yaml"], ...cutOff ? { turnLimitOn: 1 } : {} });
    expect(prompts[1]).toStartWith("Casper requirements review.");
    if (cutOff) expect(output).toContain("↻ review: stopped at its 12-turn budget");
    expect(read["config/widgets.yaml"]).toBe(WIDGETS);
    expect(read["config/secrets.yaml"]).toBeUndefined();
    expect(output).toContain("↻ put back as the AI left them: config/secrets.yaml, config/widgets.yaml");
    expect(result?.changedDuringChecks ?? []).not.toContain("config/widgets.yaml");
    expect(result?.changedPaths).toContain("config/widgets.yaml");
  }, 60_000);
}

test("a settings file the AI's own write tool changed in a review round keeps the AI's change", async () => {
  const { output, read } = await run(homepage, { request: BUILD, read: ["config/widgets.yaml"], viaWriteTool: ["config/widgets.yaml"] });
  expect(read["config/widgets.yaml"]).toBe(TEST_WIDGET);
  expect(output).toContain("↻ put back as the AI left them: config/secrets.yaml (");
}, 60_000);

test("review: false turns a build's review rounds off; a request that isn't a build gets none", async () => {
  const off = await run({ "package.json": PACKAGE, "src/add.ts": ADD, "tests/add.test.ts": ADD_TEST },
    { request: BUILD, projectYaml: "verification:\n  review: false\n" });
  expect(off.output).not.toContain("↻ review");
  expect(off.output).not.toContain("↻ self-review");
  const fix = await run({ "package.json": PACKAGE, "src/add.ts": ADD, "tests/add.test.ts": ADD_TEST }, { request: "Fix the failing add test." });
  expect(fix.output).not.toContain("↻ self-review");
}, 60_000);
