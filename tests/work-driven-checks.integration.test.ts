import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CasperApp } from "../src/app";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEventListener, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import type { VerificationResult } from "../src/verify/evidence";
import { taskExitCode } from "../src/task/result";
import { checkCommand } from "./support/check-command";
import { needsSymlinks, posixOnly } from "./support/platform";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const command = checkCommand("append:test-runs", "require-line:src/value=good");
const filesystemAliases = await (async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-missing-alias-probe-"));
  try {
    await writeFile(path.join(root, "case"), "");
    await writeFile(path.join(root, "caf\u00e9"), "");
    await writeFile(path.join(root, "\u00df"), "");
    return {
      caseInsensitive: await realpath(path.join(root, "CASE")).then(() => true, () => false),
      unicodeEquivalent: await realpath(path.join(root, "cafe\u0301")).then(() => true, () => false),
      unicodeCaseEquivalent: await realpath(path.join(root, "\u1e9e")).then(() => true, () => false),
    };
  } finally { await rm(root, { recursive: true, force: true }); }
})();
async function fixture(config: unknown = {
  verify: { test: command, build: checkCommand("append:build-runs") },
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
  const root = await fixture({ verify: { test: checkCommand("touch:started", "sleep:10000") }, verification: { timeoutMs: 2000 } });
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
  const overlap = checkCommand("fail:7", "append:test-runs", "require-line:src/value=good", "touch:started", "wait:release");
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
  const noisy = checkCommand("stdout:HEAD", "pad:20000", "stdout:TAIL", "stderr:exact failure", "exit:7");
  const root = await fixture({ verify: { test: noisy }, verification: { scopes: { test: { inputs: ["src"] } } }, repair: { maxAttempts: 0 } });
  const { app } = createApp(root, async (_prompt, tools) => {
    await writeFile(path.join(root, ".casper/project.yaml"), JSON.stringify({ verify: { test: checkCommand() }, verification: { scopes: { test: { inputs: ["unrelated"] } } } }));
    const result = await check(checkTool(tools));
    expect(result).toMatchObject({ command: noisy, status: "fail", exitCode: 7, truncated: true, scope: { inputs: ["src"] }, freshness: "fresh", stderr: "exact failure" });
    expect(result.stdout).toStartWith("HEAD");
    expect(result.stdout).toEndWith("TAIL");
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(8300);
  });
  expect((await app.runOnce("Continue", root))?.results[0]?.command).toBe(noisy);
});

posixOnly("signal termination is a real failed check, never an inferred exit zero", async () => {
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
    const root = await fixture({ verify: { test: checkCommand("append:test-runs", "mkdir:src/coverage", "write:src/coverage/report=generated") },
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

test("observed native edits invalidate scoped passes even when later work restores directory membership", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "src/value"), "good\n");
  const { app } = createApp(root, async (_prompt, tools, options) => {
    const tool = checkTool(tools);
    expect(await check(tool)).toMatchObject({ status: "pass", freshness: "fresh" });
    await writeFile(path.join(root, "src/transient"), "intermediate source\n");
    await options.afterFileEdit?.("src/transient");
    await rm(path.join(root, "src/transient"));
    const next = await check(tool);
    expect(next.reused).not.toBe(true);
    expect(next).toMatchObject({ status: "pass", freshness: "fresh" });
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("pass");
  expect(app.getLastTaskResult()?.observedEdits).toEqual(["src/transient"]);
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
});

test("native edit invalidation is independent of the receipt's bounded edit list", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "src/value"), "good\n");
  const { app } = createApp(root, async (_prompt, tools, options) => {
    for (let index = 0; index < 32; index++) {
      const file = `note-${index}`;
      await writeFile(path.join(root, file), "note\n");
      await options.afterFileEdit?.(file);
    }
    const tool = checkTool(tools);
    expect((await check(tool)).status).toBe("pass");
    await writeFile(path.join(root, "src/transient"), "intermediate source\n");
    await options.afterFileEdit?.("src/transient");
    await rm(path.join(root, "src/transient"));
    expect((await check(tool)).reused).not.toBe(true);
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("pass");
  expect(app.getLastTaskResult()?.observedEdits).toHaveLength(32);
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
});

test("an observed native edit during a check stays stale even when membership is restored before command completion", async () => {
  const root = await fixture({ verify: { test: checkCommand("append:test-runs", "touch:started", "wait:release") },
    verification: { timeoutMs: 2000, scopes: { test: { inputs: ["src"] } } } });
  const { app } = createApp(root, async (_prompt, tools, options) => {
    const tool = checkTool(tools);
    const pending = check(tool);
    await waitForFile(path.join(root, "started"));
    await writeFile(path.join(root, "src/transient"), "intermediate source\n");
    await options.afterFileEdit?.("src/transient");
    await rm(path.join(root, "src/transient"));
    await writeFile(path.join(root, "release"), "");
    expect(await pending).toMatchObject({ status: "pass", exitCode: 0, freshness: "stale" });
    const next = await check(tool);
    expect(next.reused).not.toBe(true);
    expect(next).toMatchObject({ status: "pass", freshness: "fresh" });
    expect(await check(tool)).toMatchObject({ status: "pass", reused: true });
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("pass");
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
});

test.skipIf(!filesystemAliases.caseInsensitive)("a missing named alias observed during a check stays stale after partial-write removal", async () => {
  const root = await fixture({ verify: { test: checkCommand("append:test-runs", "touch:started", "wait:release") },
    verification: { timeoutMs: 2000, scopes: { test: { inputs: ["SRC/MISSING"] } } } });
  const { app } = createApp(root, async (_prompt, tools, _options, emit) => {
    const tool = checkTool(tools);
    const pending = check(tool);
    await waitForFile(path.join(root, "started"));
    await writeFile(path.join(root, "src/missing"), "partial");
    await rm(path.join(root, "src/missing"));
    emit({ type: "tool_end", toolName: "write", isError: true, input: { path: "src/missing" } });
    await writeFile(path.join(root, "release"), "");
    expect(await pending).toMatchObject({ status: "pass", exitCode: 0, freshness: "stale" });
    expect((await check(tool)).reused).not.toBe(true);
    expect((await check(tool)).reused).toBe(true);
  });
  expect(await app.runOnce("Continue", root)).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(app.getLastTaskResult()).toMatchObject({ observedEdits: [], possibleMutations: false, changedPaths: expect.arrayContaining(["test-runs"]) });
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
});

test("a failed native write with possible partial edits invalidates matching evidence without claiming a completed edit", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "src/value"), "good\n");
  const { app } = createApp(root, async (_prompt, tools, _options, emit) => {
    const tool = checkTool(tools);
    expect((await check(tool)).status).toBe("pass");
    await writeFile(path.join(root, "src/transient"), "partial source\n");
    emit({ type: "tool_end", toolName: "write", isError: true, input: { path: "./src/transient" } });
    await rm(path.join(root, "src/transient"));
    expect((await check(tool)).reused).not.toBe(true);
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("pass");
  expect(app.getLastTaskResult()).toMatchObject({ possibleMutations: false, changedPaths: ["test-runs"], observedEdits: [] });
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
});

needsSymlinks("a failed partial native write remains invalidating after its aliased target and parent are removed", async () => {
  const root = await fixture();
  const alias = path.join(root, "alias");
  await symlink(await realpath(root), alias, "dir");
  await writeFile(path.join(root, "src/value"), "good\n");
  const { app } = createApp(root, async (_prompt, tools, _options, emit) => {
    const tool = checkTool(tools);
    expect((await check(tool)).status).toBe("pass");
    await mkdir(path.join(root, "src/transient"));
    await writeFile(path.join(root, "src/transient/partial"), "partial source\n");
    await rm(path.join(root, "src/transient"), { recursive: true });
    emit({ type: "tool_end", toolName: "write", isError: true, input: { path: path.join(alias, "src/transient/partial") } });
    expect((await check(tool)).reused).not.toBe(true);
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("pass");
  expect(app.getLastTaskResult()).toMatchObject({ possibleMutations: false, changedPaths: ["test-runs"], observedEdits: [] });
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
});

for (const form of ["case", "unicode", "unicode-case", "missing-parent"]) test.skipIf(form === "unicode" ? !filesystemAliases.unicodeEquivalent
  : form === "unicode-case" ? !filesystemAliases.unicodeCaseEquivalent : !filesystemAliases.caseInsensitive)(`a removed partial write still invalidates a missing named input (${form})`, async () => {
  const declared = form === "unicode" ? "src/caf\u00e9" : form === "unicode-case" ? "src/\u1e9e" : "SRC/MISSING";
  const observed = form === "unicode" ? "src/cafe\u0301" : form === "unicode-case" ? "src/\u00df" : "src/missing";
  const input = form === "missing-parent" ? `${declared}/named` : declared;
  const file = form === "missing-parent" ? `${observed}/other` : observed;
  const root = await fixture({ verify: { test: checkCommand("append:test-runs"), build: checkCommand("append:build-runs") },
    verification: { scopes: { test: { inputs: [input] }, build: { inputs: ["docs"] } } } });
  await mkdir(path.join(root, "docs"));
  const { app } = createApp(root, async (_prompt, tools, _options, emit) => {
    const tool = checkTool(tools);
    expect(await check(tool)).toMatchObject({ status: "pass", freshness: "fresh" });
    expect((await check(tool, "build")).freshness).toBe("fresh");
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "partial");
    expect(await realpath(path.join(root, declared))).toBe(await realpath(path.join(root, observed)));
    await rm(path.join(root, observed), { recursive: true });
    emit({ type: "tool_end", toolName: "write", isError: true, input: { path: file } });
    expect((await check(tool)).reused).not.toBe(true);
    expect((await check(tool)).reused).toBe(true);
    expect((await check(tool, "build")).reused).toBe(true);
  });
  expect(await app.runOnce("Continue", root)).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(app.getLastTaskResult()).toMatchObject({ observedEdits: [], possibleMutations: false, changedPaths: ["build-runs", "test-runs"] });
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
  expect(await readFile(path.join(root, "build-runs"), "utf8")).toBe("x");
});

test.skipIf(!filesystemAliases.caseInsensitive)("a removed case-aliased parent cannot supply an exclusion spelling for a partial write", async () => {
  const root = await fixture({ verify: { test: checkCommand("append:test-runs"), build: checkCommand("append:build-runs") },
    verification: { scopes: { test: { inputs: ["src"], exclude: ["src/generated"] }, build: { inputs: ["docs"] } } } });
  await mkdir(path.join(root, "docs"));
  const { app } = createApp(root, async (_prompt, tools, _options, emit) => {
    const tool = checkTool(tools);
    expect((await check(tool)).freshness).toBe("fresh");
    expect((await check(tool, "build")).freshness).toBe("fresh");
    await mkdir(path.join(root, "src/GENERATED"));
    await writeFile(path.join(root, "src/generated/transient"), "partial");
    expect(await realpath(path.join(root, "src/generated/transient"))).toBe(path.join(await realpath(root), "src/GENERATED/transient"));
    await rm(path.join(root, "src/GENERATED"), { recursive: true });
    emit({ type: "tool_end", toolName: "write", isError: true, input: { path: "src/generated/transient" } });
    expect((await check(tool)).reused).not.toBe(true);
    expect((await check(tool)).reused).toBe(true);
    expect((await check(tool, "build")).reused).toBe(true);
  });
  expect(await app.runOnce("Continue", root)).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(app.getLastTaskResult()).toMatchObject({ observedEdits: [], possibleMutations: false, changedPaths: ["build-runs", "test-runs"] });
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
  expect(await readFile(path.join(root, "build-runs"), "utf8")).toBe("x");
});

test("distinct missing entries do not invalidate a missing named input or select other checks", async () => {
  const root = await fixture({ verify: { test: checkCommand("append:test-runs"), build: checkCommand("touch:unselected") },
    verification: { scopes: { test: { inputs: ["src/missing/named"] } } } });
  const { app } = createApp(root, async (_prompt, tools, _options, emit) => {
    const tool = checkTool(tools);
    expect((await check(tool)).freshness).toBe("fresh");
    for (const file of ["src/missing-other", "src/other/named", "docs/missing", "src/value"]) {
      emit({ type: "tool_end", toolName: "edit", isError: true, input: { path: file } });
      expect((await check(tool)).reused).toBe(true);
    }
  });
  expect(await app.runOnce("Continue", root)).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("x");
  expect(await Bun.file(path.join(root, "unselected")).exists()).toBe(false);
});

test("a resolved excluded parent still excludes missing descendants", async () => {
  const root = await fixture({ verify: { test: checkCommand("append:test-runs") },
    verification: { scopes: { test: { inputs: ["src"], exclude: ["src/generated"] } } } });
  await mkdir(path.join(root, "src/generated"));
  const { app } = createApp(root, async (_prompt, tools, _options, emit) => {
    const tool = checkTool(tools);
    expect((await check(tool)).freshness).toBe("fresh");
    emit({ type: "tool_end", toolName: "write", isError: true, input: { path: "src/generated/missing/nested" } });
    expect((await check(tool)).reused).toBe(true);
  });
  expect(await app.runOnce("Continue", root)).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("x");
});

needsSymlinks("an unresolvable observed native path invalidates selected scoped evidence rather than claiming it is unrelated", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "src/value"), "good\n");
  await symlink("cycle", path.join(root, "cycle"));
  const { app } = createApp(root, async (_prompt, tools, _options, emit) => {
    const tool = checkTool(tools);
    expect((await check(tool)).status).toBe("pass");
    emit({ type: "tool_end", toolName: "write", isError: true, input: { path: "cycle/partial" } });
    expect((await check(tool)).reused).not.toBe(true);
  });
  expect(await app.runOnce("Continue", root)).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
  expect(await Bun.file(path.join(root, "build-runs")).exists()).toBe(false);
});

for (const form of ["literal", "alias"]) needsSymlinks(`native edit invalidation respects excluded paths, scope boundaries and unrelated checks (${form})`, async () => {
  const root = await fixture({ verify: { test: command, build: checkCommand("append:build-runs") },
    verification: { scopes: { test: { inputs: ["src"], exclude: ["src/generated"] }, build: { inputs: ["docs"] } } } });
  await writeFile(path.join(root, "src/value"), "good\n");
  await mkdir(path.join(root, "docs"));
  const alias = path.join(root, "alias");
  await symlink(await realpath(root), alias, "dir");
  const { app } = createApp(root, async (_prompt, tools, options) => {
    const tool = checkTool(tools);
    expect((await check(tool)).status).toBe("pass");
    expect((await check(tool, "build")).status).toBe("pass");
    for (const file of ["src/generated/report", "src-other/value"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "unrelated output\n");
      await options.afterFileEdit?.(form === "alias" ? path.join(alias, file) : file);
    }
    expect((await check(tool)).reused).toBe(true);
    expect((await check(tool, "build")).reused).toBe(true);
    const transient = path.join(root, "src/transient");
    await writeFile(transient, "intermediate source\n");
    await options.afterFileEdit?.(form === "alias" ? path.join(alias, "src/transient") : transient);
    await rm(transient);
    expect((await check(tool)).reused).not.toBe(true);
    expect((await check(tool, "build")).reused).toBe(true);
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("pass");
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
  expect(await readFile(path.join(root, "build-runs"), "utf8")).toBe("x");
});

for (const destination of ["excluded", "outside"]) for (const outcome of ["success", "partial-failure"]) needsSymlinks(`an included symlink retains native invalidation after removal (${destination}, ${outcome})`, async () => {
  const root = await fixture({ verify: { test: checkCommand("append:test-runs"), build: checkCommand("append:build-runs") },
    verification: { scopes: { test: { inputs: ["src"], exclude: ["src/generated"] }, build: { inputs: ["docs"] } } } });
  await mkdir(path.join(root, "src/generated"));
  await mkdir(path.join(root, "outside"));
  await mkdir(path.join(root, "docs"));
  const { app } = createApp(root, async (_prompt, tools, options, emit) => {
    const tool = checkTool(tools);
    expect(await check(tool)).toMatchObject({ status: "pass", freshness: "fresh" });
    expect((await check(tool, "build")).freshness).toBe("fresh");
    await symlink(destination === "excluded" ? "generated" : "../outside", path.join(root, "src/link"), "dir");
    await writeFile(path.join(root, "src/link/transient"), "temporary output\n");
    if (outcome === "success") await options.afterFileEdit?.("src/link/transient");
    await rm(path.join(root, "src/link/transient"));
    // Partial-write observations can arrive after the target is already absent.
    if (outcome === "partial-failure") emit({ type: "tool_end", toolName: "write", isError: true, input: { path: "src/link/transient" } });
    await rm(path.join(root, "src/link"));
    expect((await check(tool)).reused).not.toBe(true);
    expect(await check(tool)).toMatchObject({ status: "pass", freshness: "fresh", reused: true });
    expect((await check(tool, "build")).reused).toBe(true);
  });
  expect(await app.runOnce("Continue", root)).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(app.getLastTaskResult()?.observedEdits).toEqual(outcome === "success" ? ["src/link/transient"] : []);
  expect(app.getLastTaskResult()).toMatchObject({ possibleMutations: false, changedPaths: ["build-runs", "test-runs"] });
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
  expect(await readFile(path.join(root, "build-runs"), "utf8")).toBe("x");
});

needsSymlinks("an included symlink observed during a check stays invalidating after removal", async () => {
  const root = await fixture({ verify: { test: checkCommand("append:test-runs", "touch:started", "wait:release") },
    verification: { timeoutMs: 2000, scopes: { test: { inputs: ["src"], exclude: ["src/generated"] } } } });
  await mkdir(path.join(root, "src/generated"));
  const { app } = createApp(root, async (_prompt, tools, options) => {
    const tool = checkTool(tools);
    const pending = check(tool);
    await waitForFile(path.join(root, "started"));
    await symlink("generated", path.join(root, "src/link"), "dir");
    await writeFile(path.join(root, "src/link/transient"), "temporary output\n");
    await options.afterFileEdit?.("src/link/transient");
    await rm(path.join(root, "src/link/transient"));
    await rm(path.join(root, "src/link"));
    await writeFile(path.join(root, "release"), "");
    expect(await pending).toMatchObject({ status: "pass", exitCode: 0, freshness: "stale" });
    expect((await check(tool)).reused).not.toBe(true);
    expect(await check(tool)).toMatchObject({ status: "pass", freshness: "fresh", reused: true });
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("pass");
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
});

needsSymlinks("an invalid symlink traversal stays unknown rather than being classified as unrelated", async () => {
  const root = await fixture({ verify: { test: checkCommand("append:test-runs"), build: checkCommand("touch:unselected") },
    verification: { scopes: { test: { inputs: ["src"] } } } });
  await writeFile(path.join(root, "regular"), "not a directory");
  await mkdir(path.join(root, "outside"));
  await symlink("regular/../outside", path.join(root, "alias"), "dir");
  const { app } = createApp(root, async (_prompt, tools, _options, emit) => {
    const tool = checkTool(tools);
    expect(await check(tool)).toMatchObject({ status: "pass", freshness: "fresh" });
    await expect(writeFile(path.join(root, "alias/transient"), "cannot write")).rejects.toHaveProperty("code", "ENOTDIR");
    emit({ type: "tool_end", toolName: "write", isError: true, input: { path: "alias/transient" } });
    expect((await check(tool)).reused).not.toBe(true);
  });
  expect(await app.runOnce("Continue", root)).toMatchObject({ status: "pass", repairAttempts: 0 });
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
  expect(await Bun.file(path.join(root, "unselected")).exists()).toBe(false);
});

needsSymlinks("an excluded symlink to unrelated output does not invalidate scoped evidence", async () => {
  const root = await fixture({ verify: { test: checkCommand("append:test-runs") },
    verification: { scopes: { test: { inputs: ["src"], exclude: ["src/generated"] } } } });
  await mkdir(path.join(root, "outside"));
  await symlink("../outside", path.join(root, "src/generated"), "dir");
  const { app } = createApp(root, async (_prompt, tools, options, emit) => {
    const tool = checkTool(tools);
    expect(await check(tool)).toMatchObject({ status: "pass", freshness: "fresh" });
    await writeFile(path.join(root, "src/generated/transient"), "excluded output\n");
    await options.afterFileEdit?.("src/generated/transient");
    await rm(path.join(root, "src/generated/transient"));
    emit({ type: "tool_end", toolName: "write", isError: true, input: { path: "src/generated/missing" } });
    expect((await check(tool)).reused).toBe(true);
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("pass");
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("x");
});

needsSymlinks("an excluded symlink does not hide a native write to an included input", async () => {
  const root = await fixture({ verify: { test: command },
    verification: { scopes: { test: { inputs: ["src"], exclude: ["src/generated"] } } } });
  await writeFile(path.join(root, "src/value"), "good\n");
  await symlink(".", path.join(root, "src/generated"), "dir");
  const { app } = createApp(root, async (_prompt, tools, options) => {
    const tool = checkTool(tools);
    expect(await check(tool)).toMatchObject({ status: "pass", freshness: "fresh" });
    await writeFile(path.join(root, "src/generated/transient"), "included source\n");
    await options.afterFileEdit?.("src/generated/transient");
    await rm(path.join(root, "src/transient"));
    expect((await check(tool)).reused).not.toBe(true);
  });
  expect((await app.runOnce("Continue", root))?.status).toBe("pass");
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
});

test("explicit repair retains native edit invalidation without exposing the opt-in check tool", async () => {
  const root = await fixture({ verify: { test: command, build: checkCommand("append:build-runs", "require:fixed") },
    verification: { scopes: { test: { inputs: ["src"] }, build: { inputs: ["fixed"] } } } });
  await writeFile(path.join(root, "src/value"), "good\n");
  const { app, prompts } = createApp(root, async (_prompt, tools, options) => {
    expect(tools.map((tool) => tool.name)).not.toContain("casper_check");
    await writeFile(path.join(root, "src/transient"), "intermediate source\n");
    await options.afterFileEdit?.("src/transient");
    await rm(path.join(root, "src/transient"));
    await writeFile(path.join(root, "fixed"), "");
    await options.afterFileEdit?.("fixed");
  }, false);
  expect(await app.runOnce("/verify repair test build", root)).toMatchObject({ status: "pass", repairAttempts: 1 });
  expect(prompts).toHaveLength(1);
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
  expect(await readFile(path.join(root, "build-runs"), "utf8")).toBe("xx");
});

needsSymlinks("explicit repair retains included symlink invalidation with one owner and no managed tool", async () => {
  const root = await fixture({ verify: { test: checkCommand("append:test-runs"), build: checkCommand("append:build-runs", "require:fixed") },
    verification: { scopes: { test: { inputs: ["src"], exclude: ["src/generated"] }, build: { inputs: ["fixed"] } } } });
  await mkdir(path.join(root, "src/generated"));
  const { app, prompts } = createApp(root, async (_prompt, tools, options) => {
    expect(tools.map((tool) => tool.name)).not.toContain("casper_check");
    await symlink("generated", path.join(root, "src/link"), "dir");
    await writeFile(path.join(root, "src/link/transient"), "temporary output\n");
    await options.afterFileEdit?.("src/link/transient");
    await rm(path.join(root, "src/link/transient"));
    await rm(path.join(root, "src/link"));
    await writeFile(path.join(root, "fixed"), "");
    await options.afterFileEdit?.("fixed");
  }, false);
  expect(await app.runOnce("/verify repair test build", root)).toMatchObject({ status: "pass", repairAttempts: 1 });
  expect(prompts).toHaveLength(1);
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
  expect(await readFile(path.join(root, "build-runs"), "utf8")).toBe("xx");
});

test.skipIf(!filesystemAliases.caseInsensitive)("explicit repair retains a removed missing-name alias with one owner and no managed tool", async () => {
  const root = await fixture({ verify: { test: checkCommand("append:test-runs"), build: checkCommand("append:build-runs", "require:fixed") },
    verification: { scopes: { test: { inputs: ["SRC/MISSING"] }, build: { inputs: ["fixed"] } } }, repair: { maxAttempts: 1 } });
  const { app, prompts } = createApp(root, async (_prompt, tools, options, emit) => {
    expect(tools.map((tool) => tool.name)).not.toContain("casper_check");
    await writeFile(path.join(root, "src/missing"), "partial");
    await rm(path.join(root, "src/missing"));
    emit({ type: "tool_end", toolName: "write", isError: true, input: { path: "src/missing" } });
    await writeFile(path.join(root, "fixed"), "");
    await options.afterFileEdit?.("fixed");
  }, false);
  expect(await app.runOnce("/verify repair test build", root)).toMatchObject({ status: "pass", repairAttempts: 1 });
  expect(prompts).toHaveLength(1);
  expect(await readFile(path.join(root, "test-runs"), "utf8")).toBe("xx");
  expect(await readFile(path.join(root, "build-runs"), "utf8")).toBe("xx");
});

test("another managed check invalidates scoped evidence even if an input directory is later restored", async () => {
  const root = await fixture({ verify: { test: command, build: checkCommand("touch:src/transient") }, verification: { scopes: { test: { inputs: ["src"] } } } });
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

posixOnly("tool cancellation kills real commands and queued checks without starting repair", async () => {
  // Keep the shell and its children alive through TERM so the existing KILL
  // escalation deterministically supplies the asserted signal exit. Bare `wait`
  // can return 0 as children terminate; cancellation must retain that real exit
  // code rather than fabricating null to satisfy this fixture.
  const root = await fixture({ verify: { test: "trap '' TERM; touch started; (sleep 0.5 && touch leaked) & wait", build: checkCommand("touch:queued-ran") }, verification: { timeoutMs: 2000 } });
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
  const root = await fixture({ verify: { test: checkCommand("sleep:100", "append:test-runs", "require-line:src/value=good") }, verification: { scopes: { test: { inputs: ["src"] } } } });
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
  const { app, prompts, output } = createApp(root, async (prompt, tools, options) => {
    checkTool(tools);
    expect(prompt).toContain(`test=${command}`);
    expect(prompt).toContain(`build=${checkCommand("append:build-runs")}`);
    expect(prompt).toContain("actual work");
    if (prompt.includes("README typo")) await writeFile(path.join(root, "README.md"), "corrected spelling\n");
    if (prompt.includes("Fix addition")) {
      await writeFile(path.join(root, "src/value"), "good\n");
      await options.afterFileEdit?.("src/value"); // Invalidation must not select an unchosen check.
    }
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
  expect(app.getLastTaskResult()).toMatchObject({ possibleMutations: false, changedPaths: ["src/value", "test-runs"] });
});

test("a vague request follows edit → selected check → scoped reuse → invalidation → failure → one repair owner", async () => {
  const root = await fixture();
  const { app, prompts } = createApp(root, async (prompt, tools, options) => {
    const tool = checkTool(tools);
    if (prompt.startsWith("Casper verification repair")) {
      expect(prompt).toContain("Original request:\nContinue");
      expect(prompt).toContain(`"command": ${JSON.stringify(command)}`);
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
  // The model turn left src/value at its starting content and only ran checks; the repair
  // round's edit and rerun are reported separately, never as the request's own changes.
  expect(app.getLastTaskResult()).toMatchObject({ changedPaths: ["test-runs"], changedDuringChecks: ["src/value", "test-runs"] });
});
