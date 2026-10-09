import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import os from "node:os";
import { BUILDER_LIMITS, SubagentManager, SUBAGENT_LIMITS } from "../src/agents/manager";
import type { AgentRuntime, RuntimeBuilderStartOptions, RuntimeEvent, RuntimeEventListener, RuntimeSession, RuntimeShell } from "../src/runtime/types";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const copy = path.join(os.tmpdir(), "casper-crew-copy");
class BuilderRuntime implements AgentRuntime {
  options?: RuntimeBuilderStartOptions;
  prompts: string[] = [];
  disposals = 0;
  constructor(private readonly respond: (emit: (event: RuntimeEvent) => void, signal: AbortSignal) => Promise<void> = async (emit) => {
    emit({ type: "assistant_response_start" });
    emit({ type: "assistant_text_delta", delta: "Changed a.ts; bun test passed." });
    emit({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 50, estimatedCost: 0.01 } });
  }) {}
  async start(): Promise<RuntimeSession> { throw new Error("Must not use the main session's start"); }
  async startReadOnly(): Promise<RuntimeSession> { throw new Error("A builder is not read-only"); }
  async startBuilder(options: RuntimeBuilderStartOptions): Promise<RuntimeSession> {
    this.options = options;
    const listeners = new Set<RuntimeEventListener>();
    return {
      prompt: async (text) => { this.prompts.push(text); await this.respond((event) => { for (const listener of listeners) listener(event); }, options.signal); },
      abort: async () => {},
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() { this.disposals++; }
}
function manager(factory: () => AgentRuntime, builderTimeoutMs?: number) {
  const instance = new SubagentManager({ runtimeFactory: factory, cleanupGraceMs: 20, ...(builderTimeoutMs ? { builderTimeoutMs } : {}) });
  cleanup.push(() => instance.close());
  return instance;
}
const job = { cwd: copy, goal: "Add a --quiet flag", projectContext: "Project rules" };

test("a builder starts in its copy with the builder limits, the given shell, and a gate that keeps edits in the copy", async () => {
  const runtime = new BuilderRuntime();
  const shell: RuntimeShell = { wrap: async (command) => ({ command }) };
  const result = await manager(() => runtime).runBuilder({ ...job, shell });
  expect(result).toMatchObject({ role: "builder", status: "completed", response: "Changed a.ts; bun test passed.", usage: { tokens: 50, estimatedCost: 0.01 } });
  const options = runtime.options!;
  expect(options).toMatchObject({ cwd: copy, maxTurns: BUILDER_LIMITS.maxTurns, maxToolCalls: BUILDER_LIMITS.maxToolCalls, shell });
  expect(options.systemPromptAppend).toContain("Project rules");
  const gate = options.beforeToolGate!;
  expect(gate("edit", { path: "src/a.ts" })).toBeUndefined();
  expect(gate("write", { path: path.join(copy, "b.ts") })).toBeUndefined();
  expect(gate("write", { path: "../main/a.ts" })).toContain("outside");
  expect(gate("edit", { path: path.join(os.tmpdir(), "elsewhere.ts") })).toContain("outside");
  expect(gate("bash", { command: "ls" })).toBeUndefined();
  const prompt = runtime.prompts[0]!;
  expect(prompt).toContain("Add a --quiet flag");
  expect(prompt).toContain(copy);
  expect(prompt).toMatch(/install/i);
  expect(prompt).toMatch(/commit/i);
  expect(runtime.disposals).toBe(1);
});

test("a builder is told the deadline it really has, and the default is in minutes", async () => {
  const runtime = new BuilderRuntime();
  await manager(() => runtime).runBuilder(job);
  expect(runtime.prompts[0]).toContain(`${BUILDER_LIMITS.timeoutMs / 60_000} minutes, then one tool-free turn to report`);
  const shorter = new BuilderRuntime();
  await manager(() => shorter, 90_000).runBuilder(job);
  expect(shorter.prompts[0]).toContain("90 seconds, then one tool-free turn to report");
});

test("your private paths stay private in the copy too", async () => {
  const runtime = new BuilderRuntime();
  const main = path.join(os.tmpdir(), "casper-crew-main");
  const subagents = new SubagentManager({ runtimeFactory: () => runtime, cleanupGraceMs: 20, privatePaths: () => [path.join(main, "secrets"), path.join(os.homedir(), ".netrc")] });
  cleanup.push(() => subagents.close());
  await subagents.runBuilder({ ...job, main });
  expect(runtime.options!.privatePaths).toEqual([path.join(main, "secrets"), path.join(os.homedir(), ".netrc"), path.join(copy, "secrets")]);
});

test("three builders run at once beside the helpers; a fourth waits its turn", async () => {
  const release: Array<() => void> = [];
  const held = () => new BuilderRuntime(async (emit) => {
    await new Promise<void>((resolve) => release.push(resolve));
    emit({ type: "assistant_text_delta", delta: "done" });
  });
  const subagents = manager(held);
  const running = Array.from({ length: BUILDER_LIMITS.maxConcurrent }, (_, index) => subagents.runBuilder({ ...job, goal: `part ${index + 1}` }));
  await Bun.sleep(10);
  await expect(subagents.runBuilder(job)).rejects.toThrow(/builders/i);
  expect(subagents.runs().map((run) => run.role)).toEqual(["builder", "builder", "builder"]);
  release.splice(0).forEach((done) => done());
  expect((await Promise.all(running)).map((result) => result.status)).toEqual(["completed", "completed", "completed"]);
  expect(SUBAGENT_LIMITS.maxConcurrent).toBe(2);
});

test("a builder that runs too long or is stopped ends and frees its slot", async () => {
  const forever = () => new BuilderRuntime((_emit, signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })));
  const timed = manager(forever, 30);
  expect(await timed.runBuilder(job)).toMatchObject({ status: "timed_out" });
  expect(timed.isBusy).toBe(false);
  const stopped = manager(forever);
  const controller = new AbortController();
  const run = stopped.runBuilder({ ...job, signal: controller.signal });
  await Bun.sleep(10);
  expect(stopped.cancelRun(stopped.runs()[0]!.id)).toBe(true);
  expect(await run).toMatchObject({ status: "cancelled" });
  expect(stopped.isBusy).toBe(false);
});

test("a runtime that can't start a builder fails it plainly; deadlines can only be tightened", async () => {
  const plain: AgentRuntime = { start: async () => { throw new Error("no"); }, dispose: async () => {} };
  expect(await manager(() => plain).runBuilder(job)).toMatchObject({ status: "failed", reason: expect.stringMatching(/builder/i) });
  expect(() => new SubagentManager({ runtimeFactory: () => plain, builderTimeoutMs: BUILDER_LIMITS.timeoutMs + 1 })).toThrow();
});
