import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import type { VerificationResult } from "../src/verify/evidence";
import { taskExitCode } from "../src/task/result";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const command = "printf x >> test-runs; grep -qx good src/value";
async function fixture(config: unknown = {
  verify: { test: command, build: "printf x >> build-runs" },
  verification: { scopes: { test: { inputs: ["src"] } } },
  repair: { maxAttempts: 1 },
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-managed-check-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".casper"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, ".casper/project.yaml"), JSON.stringify(config));
  await writeFile(path.join(root, "src/value"), "bad\n");
  return root;
}
function createApp(root: string, respond: (prompt: string, tools: RuntimeTool[], options: RuntimeStartOptions, emit: RuntimeEventListener) => Promise<void>, autoVerify = true) {
  let tools: RuntimeTool[] = [];
  let listener: RuntimeEventListener | undefined;
  let inPrompt = false;
  let output = "";
  const prompts: string[] = [];
  const runtime: AgentRuntime = {
    async start(options) {
      tools = options.tools ?? [];
      return {
        setTools(next) { tools = next; },
        async prompt(prompt) {
          if (inPrompt) throw new Error("Nested repair prompt inside tool execution");
          inPrompt = true;
          prompts.push(prompt);
          try { await respond(prompt, tools, options, (event) => listener?.(event)); }
          finally { inPrompt = false; }
        },
        async abort() {},
        subscribe(next) { listener = next; return () => { listener = undefined; }; },
        getState: () => ({ cwd: root, isStreaming: inPrompt }),
      };
    },
    async dispose() {},
  };
  const homeDir = path.join(root, "home");
  const app = new CasperApp({
    autoVerify, runtimeFactory: () => runtime, sessionHomeDir: path.join(homeDir, ".casper"),
    loadProjectContext: (project) => loadProjectContext(project, { homeDir }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir }),
    output: { write(text) { output += text; } },
  });
  cleanup.push(() => app.close());
  return { app, prompts, output: () => output };
}
function checkTool(tools: RuntimeTool[]): RuntimeTool {
  const tool = tools.find((candidate) => candidate.name === "casper_check");
  if (!tool) throw new Error("casper_check was not offered to the model");
  return tool;
}
async function check(tool: RuntimeTool, name = "test", signal?: AbortSignal): Promise<VerificationResult> {
  return JSON.parse((await tool.execute({ check: name }, signal)).text);
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 200 && !await Bun.file(file).exists(); attempt++) await Bun.sleep(10);
  expect(await Bun.file(file).exists()).toBe(true);
}

test("closing drains an active model-selected command and retains cancellation evidence without repair", async () => {
  const root = await fixture({ verify: { test: "touch started; sleep 10" }, verification: { timeoutMs: 2000 } });
  const { app, prompts } = createApp(root, async (_prompt, tools) => {
    expect(await check(checkTool(tools))).toMatchObject({ status: "fail", reason: "Verification cancelled" });
  });
  const pending = app.runOnce("Continue", root);
  await waitForFile(path.join(root, "started"));
  await app.close();
  const report = await pending;
  expect(report?.status).toBe("blocked");
  expect(report?.results[0]?.exitCode).toBeNull();
  expect(app.getLastTaskResult()?.execution).toBe("cancelled");
  expect(prompts).toHaveLength(1);
});

test("an external edit overlapping a real check leaves its exit success stale and prevents reuse", async () => {
  const overlap = "printf x >> test-runs; grep -qx good src/value || exit 7; touch started; while test ! -f release; do sleep 0.01; done";
  const root = await fixture({ verify: { test: overlap }, verification: { timeoutMs: 2000, scopes: { test: { inputs: ["src"] } } }, repair: { maxAttempts: 0 } });
  await writeFile(path.join(root, "src/value"), "good\n");
  const { app } = createApp(root, async (_prompt, tools) => {
    const tool = checkTool(tools);
    const pending = check(tool);
    await waitForFile(path.join(root, "started"));
    await writeFile(path.join(root, "src/value"), "partial\n");
    await writeFile(path.join(root, "release"), "");
    expect(await pending).toMatchObject({ status: "pass", exitCode: 0, freshness: "stale" });
    const next = await check(tool);
    expect(next).toMatchObject({ status: "fail", exitCode: 7 });
    expect(next.reused).not.toBe(true);
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("fail");
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
});

test("the tool returns bounded real output and keeps startup commands/scopes frozen despite config edits", async () => {
  const noisy = `bun -e 'process.stdout.write("HEAD" + "x".repeat(20000) + "TAIL"); process.stderr.write("exact failure"); process.exit(7)'`;
  const root = await fixture({ verify: { test: noisy }, verification: { scopes: { test: { inputs: ["src"] } } }, repair: { maxAttempts: 0 } });
  const { app } = createApp(root, async (_prompt, tools) => {
    await writeFile(path.join(root, ".casper/project.yaml"), JSON.stringify({ verify: { test: "true" }, verification: { scopes: { test: { inputs: ["unrelated"] } } } }));
    const result = await check(checkTool(tools));
    expect(result).toMatchObject({ command: noisy, status: "fail", exitCode: 7, truncated: true, scope: { inputs: ["src"] }, freshness: "fresh", stderr: "exact failure" });
    expect(result.stdout).toStartWith("HEAD");
    expect(result.stdout).toEndWith("TAIL");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(8300);
  });
  expect((await app.runOnce("Continue", root))?.results[0]?.command).toBe(noisy);
});

test("signal termination is a real failed check, never an inferred exit zero", async () => {
  const root = await fixture({ verify: { test: "printf before-signal; kill -TERM $$" }, repair: { maxAttempts: 0 } });
  const { app, prompts } = createApp(root, async (_prompt, tools) => {
    const result = await checkTool(tools).execute({ check: "test" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ status: "fail", exitCode: null, signal: "SIGTERM", stdout: "before-signal" });
  });
  const report = await app.runOnce("Continue", root);
  expect(report).toMatchObject({ status: "fail", repairAttempts: 0 });
  expect(report?.rounds).toHaveLength(1);
  expect(taskExitCode(report, app.getLastTaskResult())).toBe(1);
  expect(prompts).toHaveLength(1);
});

test("tool arguments cannot change command authority and missing checks remain skips", async () => {
  const root = await fixture();
  const { app, prompts } = createApp(root, async (_prompt, tools) => {
    const tool = checkTool(tools);
    for (const args of [{}, { check: "typo" }, { check: ["test"] }, { check: "test", command: "touch injected" },
      { check: "test", cwd: "/tmp" }, { check: "test", scope: { inputs: ["."] } }]) {
      expect((await tool.execute(args)).isError).toBe(true);
    }
    expect(await check(tool, "lint")).toMatchObject({ name: "lint", status: "skip", exitCode: null });
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("incomplete");
  expect(prompts).toHaveLength(1);
  expect(await Bun.file(path.join(root, "test-runs")).exists()).toBe(false);
  expect(await Bun.file(path.join(root, "injected")).exists()).toBe(false);
});

test("managed checks stay opt-in even for an explicit coding request", async () => {
  const root = await fixture();
  const { app } = createApp(root, async (_prompt, tools) => {
    expect(tools.map((tool) => tool.name)).not.toContain("casper_check");
    await writeFile(path.join(root, "src/value"), "good\n");
  }, false);
  expect(await app.runOnce("Fix addition and test it", root)).toBeUndefined();
  expect(await Bun.file(path.join(root, "test-runs")).exists()).toBe(false);
});

test("check evidence and tool authority end with each task; explicit verification also starts fresh", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "src/value"), "good\n");
  const oldTools: RuntimeTool[] = [];
  const { app } = createApp(root, async (_prompt, tools) => {
    for (const old of oldTools) expect((await old.execute({ check: "test" })).isError).toBe(true);
    const tool = checkTool(tools);
    const result = await check(tool);
    expect(result).toMatchObject({ status: "pass", freshness: "fresh" });
    expect(result.reused).not.toBe(true);
    oldTools.push(tool);
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("pass");
  expect((await oldTools[0]!.execute({ check: "test" })).isError).toBe(true);
  expect((await app.runOnce("Continue"))?.status).toBe("pass");
  expect((await app.runOnce("/verify test"))?.results[0]?.reused).not.toBe(true);
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xxx");
  expect(app.getLastTaskResult()).toBeUndefined();
});

test("undeclared scope never supports reuse; excluded generated outputs do not invalidate declared inputs", async () => {
  for (const scoped of [false, true]) {
    const root = await fixture({ verify: { test: "printf x >> test-runs; mkdir -p src/coverage; printf generated > src/coverage/report" },
      verification: scoped ? { scopes: { test: { inputs: ["src"], exclude: ["src/coverage"] } } } : {} });
    const { app } = createApp(root, async (_prompt, tools) => {
      const tool = checkTool(tools);
      const first = await check(tool);
      expect(first).toMatchObject({ status: "pass", exitCode: 0, freshness: scoped ? "fresh" : "unavailable" });
      const second = await check(tool);
      expect(Boolean(second.reused)).toBe(scoped);
      if (!scoped) expect(second.freshnessReason).toContain("No input scope declared");
    });
    const report = await app.runOnce("Continue", root);
    expect(report?.status).toBe("pass");
    expect(report?.repairAttempts).toBe(0);
    expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe(scoped ? "x" : "xxx");
  }
});

test("another managed check invalidates scoped evidence even if an input directory is later restored", async () => {
  const root = await fixture({ verify: { test: command, build: "touch src/transient" }, verification: { scopes: { test: { inputs: ["src"] } } } });
  await writeFile(path.join(root, "src/value"), "good\n");
  const { app } = createApp(root, async (_prompt, tools) => {
    const tool = checkTool(tools);
    expect((await check(tool)).status).toBe("pass");
    await check(tool, "build");
    await rm(path.join(root, "src/transient"));
    const after = await check(tool);
    expect(after.status).toBe("pass");
    expect(after.reused).not.toBe(true);
    expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
  });
  await app.runOnce("Continue", root);
});

test("tool cancellation kills real commands and queued checks without starting repair", async () => {
  const root = await fixture({ verify: { test: "touch started; (sleep 0.5; touch leaked) & wait", build: "touch queued-ran" }, verification: { timeoutMs: 2000 } });
  const controller = new AbortController();
  const { app, prompts } = createApp(root, async (_prompt, tools) => {
    const tool = checkTool(tools);
    const running = check(tool, "test", controller.signal);
    await waitForFile(path.join(root, "started"));
    const queued = tool.execute({ check: "build" });
    controller.abort();
    expect(await running).toMatchObject({ status: "fail", exitCode: null, reason: "Verification cancelled" });
    expect((await queued).isError).toBe(true);
  });
  const report = await app.runOnce("Continue", root);
  expect(report?.status).toBe("blocked");
  expect(report?.results[0]?.reason).toBe("Verification cancelled");
  expect(app.getLastTaskResult()?.execution).toBe("cancelled");
  expect(taskExitCode(report, app.getLastTaskResult())).toBe(130);
  expect(prompts).toHaveLength(1);
  await Bun.sleep(600);
  expect(await Bun.file(path.join(root, "leaked")).exists()).toBe(false);
  expect(await Bun.file(path.join(root, "queued-ran")).exists()).toBe(false);
});

test("concurrent requests for the same scoped check execute once and return one reused pass", async () => {
  const root = await fixture({ verify: { test: `sleep 0.1; ${command}` }, verification: { scopes: { test: { inputs: ["src"] } } } });
  await writeFile(path.join(root, "src/value"), "good\n");
  const { app } = createApp(root, async (_prompt, tools) => {
    const tool = checkTool(tools);
    const results = await Promise.all([check(tool), check(tool)]);
    expect(results.map((result) => result.status)).toEqual(["pass", "pass"]);
    expect(results.filter((result) => result.reused)).toHaveLength(1);
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("pass");
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("x");
});

test("check guidance lists available commands regardless of request words; docs-only and no-change work select none", async () => {
  const root = await fixture();
  const { app, prompts, output } = createApp(root, async (prompt, tools) => {
    checkTool(tools);
    expect(prompt).toContain(`test=${command}`);
    expect(prompt).toContain("build=printf x >> build-runs");
    expect(prompt).toContain("actual work");
    if (prompt.includes("README typo")) await writeFile(path.join(root, "README.md"), "corrected spelling\n");
  });
  for (const request of ["Continue", "Fix README typo", "Fix addition"]) {
    expect(await app.runOnce(request, root)).toBeUndefined();
    expect(app.getLastTaskResult()).toMatchObject({ execution: "completed", verification: undefined });
  }
  expect(prompts).toHaveLength(3);
  expect(await Bun.file(path.join(root, "test-runs")).exists()).toBe(false);
  expect(await Bun.file(path.join(root, "build-runs")).exists()).toBe(false);
  expect(output()).toContain("no Casper verification recorded");
});

test("a selected pass is rechecked after a later partial edit, before any repair decision", async () => {
  const root = await fixture({ verify: { test: command }, verification: { scopes: { test: { inputs: ["src"] } } }, repair: { maxAttempts: 0 } });
  const { app } = createApp(root, async (_prompt, tools, _options, emit) => {
    await writeFile(path.join(root, "src/value"), "good\n");
    expect(await check(checkTool(tools))).toMatchObject({ status: "pass", freshness: "fresh" });
    await writeFile(path.join(root, "src/value"), "partial\n");
    emit({ type: "tool_end", toolName: "write", isError: true, input: { path: "src/value" } });
  });
  const report = await app.runOnce("Make the login button work", root);
  expect(report).toMatchObject({ status: "fail", repairAttempts: 0 });
  expect(report?.results[0]).toMatchObject({ status: "fail", exitCode: 1, freshness: "fresh" });
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
  expect(app.getLastTaskResult()?.possibleMutations).toBe(true);
});

test("a vague request follows edit → selected check → scoped reuse → invalidation → failure → one repair owner", async () => {
  const root = await fixture();
  const { app, prompts } = createApp(root, async (prompt, tools, options) => {
    const tool = checkTool(tools);
    if (prompt.startsWith("Casper verification repair")) {
      expect(prompt).toContain("Original request:\nContinue");
      expect(prompt).toContain(`\"command\": \"${command}\"`);
      expect(prompt).toContain('"exitCode": 1');
      await writeFile(path.join(root, "src/value"), "good\n");
      expect(await check(tool)).toMatchObject({ status: "pass", exitCode: 0, freshness: "fresh" });
      return;
    }
    await writeFile(path.join(root, "src/value"), "good\n");
    await options.afterFileEdit?.("src/value");
    expect(await check(tool)).toMatchObject({ status: "pass", exitCode: 0, command, freshness: "fresh" });
    expect(await check(tool)).toMatchObject({ status: "pass", reused: true });
    expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("x");
    await writeFile(path.join(root, "src/value"), "bad\n");
    await options.afterFileEdit?.("src/value");
    const failed = await tool.execute({ check: "test" });
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.text)).toMatchObject({ status: "fail", exitCode: 1 });
    expect(prompts).toHaveLength(1); // The tool returns evidence, never starts repair itself.
  });
  const report = await app.runOnce("Continue", root);
  expect(report).toMatchObject({ status: "pass", repairAttempts: 1 });
  expect(report?.results).toHaveLength(1);
  expect(report?.results[0]).toMatchObject({ name: "test", status: "pass", freshness: "fresh" });
  expect(report?.rounds.flat().filter((result) => !result.reused).map((result) => result.status)).toEqual(["pass", "fail", "pass"]);
  expect(prompts).toHaveLength(2);
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xxx");
  expect(await Bun.file(path.join(root, "build-runs")).exists()).toBe(false);
  expect(app.getLastTaskResult()?.observedEdits).toEqual(["src/value"]);
});
