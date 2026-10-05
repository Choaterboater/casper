import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";

/** A project the model sets up in its own turn (package.json with a test script) is checked on that turn. */
async function run(files: Record<string, string>, options: { projectYaml?: string; checkFirst?: string } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-new-checks-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await Promise.all([mkdir(home), mkdir(project)]);
  await writeFile(path.join(project, "notes.txt"), "Only notes here before the task.\n");
  if (options.projectYaml) { await mkdir(path.join(project, ".casper")); await writeFile(path.join(project, ".casper/project.yaml"), options.projectYaml); }
  let tools: RuntimeTool[] = [];
  const checkRuns: string[] = [];
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const runtime: AgentRuntime = {
    async start(start) {
      tools = start.tools ?? [];
      return {
        setTools: (next: RuntimeTool[]) => { tools = next; },
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {},
        prompt: async () => {
          if (options.checkFirst) {
            const check = tools.find((tool) => tool.name === "casper_check");
            checkRuns.push((await check!.execute({ check: options.checkFirst })).text);
          }
          for (const [name, text] of Object.entries(files)) await writeFile(path.join(project, name), text);
          emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
          emit({ type: "assistant_text_delta", delta: "Set up the project.\n" });
          emit({ type: "assistant_response_end", stopReason: "stop" });
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
    await app.runOnce("set up a small package with a test script", project);
    return { output, result: app.getLastTaskResult(), checkRuns };
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("a package.json the model writes in this turn gets its test check on this turn", async () => {
  const { output, result } = await run({ "package.json": JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }) });
  expect(output).not.toContain("no checks configured");
  expect(output).toContain("✓ test passed");
  expect(result?.verification?.results.map((check) => check.name)).toEqual(["test"]);
  // The tests are new, so there is no "without the change" to prove against; the receipt says why, plainly.
  expect(output).toContain("the tests came with this change");
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
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
