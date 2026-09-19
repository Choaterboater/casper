import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import { CasperApp, type CasperAppOptions } from "../src/app";
import { formatSubagentReport, SubagentManager, SUBAGENT_LIMITS } from "../src/agents/manager";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeReadOnlyStartOptions, RuntimeSession, RuntimeStartOptions, RuntimeTool } from "../src/runtime/types";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const task = { role: "explorer" as const, goal: "Find the entry point", cwd: "/tmp", projectContext: "Test project rules" };
class ChildRuntime implements AgentRuntime {
  options?: RuntimeReadOnlyStartOptions;
  prompts: string[] = [];
  disposals = 0;
  aborts = 0;
  onAbort = () => {};
  beforeStart = async () => {};
  constructor(private readonly respond: (emit: (event: RuntimeEvent) => void) => Promise<void> = async (emit) => {
    emit({ type: "assistant_text_delta", delta: "Evidence: index.ts:1" });
  }) {}
  async start(): Promise<RuntimeSession> { throw new Error("Must not use unrestricted startup"); }
  async startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    this.options = options;
    await this.beforeStart();
    const listeners = new Set<RuntimeEventListener>();
    return {
      prompt: async (text) => { this.prompts.push(text); await this.respond((event) => { for (const listener of listeners) listener(event); }); },
      abort: async () => { this.aborts++; this.onAbort(); },
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() { this.disposals++; }
}
class ParentRuntime implements AgentRuntime {
  tools: RuntimeTool[] = [];
  starts = 0;
  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    this.starts++;
    this.tools = options.tools ?? [];
    return {
      setTools: (tools) => { this.tools = tools; }, prompt: async () => {}, abort: async () => {},
      subscribe: () => () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
    };
  }
  async dispose() {}
}
function manager(factory: () => AgentRuntime | Promise<AgentRuntime>, timeoutMs?: number) {
  const instance = new SubagentManager({ runtimeFactory: factory, timeoutMs, cleanupGraceMs: 20 });
  cleanup.push(() => instance.close());
  return instance;
}
async function appFixture(options: CasperAppOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-phase8-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const homeDir = path.join(root, "home");
  await mkdir(project); await mkdir(homeDir);
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "phase8" }));
  const app = new CasperApp({
    loadProjectContext: (info) => loadProjectContext(info, { homeDir }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    output: { write: () => {} }, ...options,
  });
  cleanup.push(() => app.close());
  return { app, project };
}

describe("Phase 8 bounded subagents", () => {
  test("pre-cancelled delegation never creates a runtime", async () => {
    let created = 0;
    const agents = manager(() => { created++; return new ChildRuntime(); });
    const result = await agents.run({ ...task, signal: AbortSignal.abort() });
    expect(result.status).toBe("cancelled");
    expect(created).toBe(0);
  });

  test("unknown delegate arguments cannot silently grant write access", async () => {
    let created = 0;
    const tool = manager(() => { created++; return new ChildRuntime(); }).createTool(() => task);
    for (const args of [
      { role: "explorer", goal: "inspect", readOnly: false },
      { role: "writer", goal: "inspect" }, { role: "reviewer", goal: " " },
      { role: "explorer", goal: "😀".repeat(1100) },
      { role: "reviewer", goal: "inspect", context: "x".repeat(8193) },
    ]) expect((await tool.execute(args)).isError).toBe(true);
    expect(created).toBe(0);
  });

  test("unsupported runtimes fail closed instead of ignoring a read-only hint", async () => {
    const parent = new ParentRuntime();
    const result = await manager(() => parent).run(task);
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("enforced read-only");
    expect(parent.starts).toBe(0);
  });

  test("/delegate uses a fresh read-only child without starting the parent", async () => {
    const child = new ChildRuntime(async (emit) => {
      emit({ type: "tool_start", toolName: "find" });
      emit({ type: "tool_end", toolName: "find", isError: false });
      emit({ type: "assistant_text_delta", delta: "Relevant files: index.ts:1" });
    });
    let output = "";
    const { app, project } = await appFixture({
      runtimeFactory: () => { throw new Error("Parent must remain lazy"); },
      subagentRuntimeFactory: () => child, output: { write: (text) => { output += text; } },
    });
    await app.runOnce("/delegate explorer Find the entry point", project);
    expect(child.options?.maxToolCalls).toBe(48);
    expect(child.options?.maxTurns).toBe(12);
    expect(child.options?.systemPromptAppend).toContain("Casper project context");
    expect(child.prompts[0]).toContain("Goal:\nFind the entry point");
    expect(child.prompts[0]).toContain("no edits, shell, tests");
    expect(output).toContain("explorer · completed");
    expect(output).toContain("tools: find");
    expect(output).toContain("index.ts:1");
    expect(child.disposals).toBe(1);
  });

  test("delegation budget spans concurrent calls and resets only for a new parent tool", async () => {
    let created = 0;
    const agents = manager(() => { created++; return new ChildRuntime(); });
    const tool = agents.createTool(() => task);
    for (let i = 0; i < 4; i++) expect((await tool.execute({ role: "reviewer", goal: "inspect", context: "" })).isError).toBeUndefined();
    const denied = await tool.execute({ role: "reviewer", goal: "inspect" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("budget exhausted");
    expect(created).toBe(4);
    expect((await agents.createTool(() => task).execute({ role: "explorer", goal: "new task" })).isError).toBeUndefined();
    expect(created).toBe(5);
  });

  test("concurrency is reserved during lazy startup and late factories cannot prompt after cancellation", async () => {
    const load = gate();
    const children: ChildRuntime[] = [];
    const agents = manager(async () => { await load.promise; const child = new ChildRuntime(); children.push(child); return child; });
    const controller = new AbortController();
    const first = agents.run({ ...task, signal: controller.signal });
    const second = agents.run({ ...task, signal: controller.signal });
    await expect(agents.run(task)).rejects.toThrow("concurrency limit");
    controller.abort();
    expect((await first).status).toBe("cancelled");
    expect((await second).status).toBe("cancelled");
    expect(agents.isBusy).toBe(true); // slots are not reusable until actual cleanup
    load.release();
    await agents.close();
    expect(children.map((child) => child.disposals)).toEqual([1, 1]);
    expect(children.every((child) => child.options === undefined && child.prompts.length === 0)).toBe(true);
    expect(agents.isBusy).toBe(false);
  });

  test("cancellation during startup prevents a late prompt and disposes exactly once", async () => {
    const entered = gate(); const start = gate();
    const child = new ChildRuntime();
    child.beforeStart = async () => { entered.release(); await start.promise; };
    const agents = manager(() => child);
    const controller = new AbortController();
    const run = agents.run({ ...task, signal: controller.signal });
    await entered.promise; controller.abort(); start.release();
    expect((await run).status).toBe("cancelled");
    expect(child.prompts).toHaveLength(0);
    expect(child.disposals).toBe(1);
  });

  test("wall deadline aborts an active child and returns honest incomplete status", async () => {
    const finish = gate();
    const child = new ChildRuntime(async (emit) => {
      emit({ type: "assistant_text_delta", delta: "partial report" });
      await finish.promise;
    });
    child.onAbort = finish.release;
    const result = await manager(() => child, 30).run(task);
    expect(result.status).toBe("timed_out");
    expect(result.reason).toContain("30 ms");
    expect(result.response).toBe("partial report");
    expect(child.aborts).toBe(1);
    expect(child.disposals).toBe(1);
  });

  test("close is shared, aborts active commands, and prevents workspace changes and post-close output", async () => {
    const entered = gate(); const finish = gate();
    const child = new ChildRuntime(async (emit) => {
      entered.release(); await finish.promise;
      emit({ type: "assistant_text_delta", delta: "LATE_REPORT" });
    });
    child.onAbort = finish.release;
    let output = "";
    const { app, project } = await appFixture({ subagentRuntimeFactory: () => child, output: { write: (text) => { output += text; } } });
    const run = app.runOnce("/delegate explorer inspect", project).catch((error: Error) => error.message);
    await entered.promise;
    await expect(app.runOnce("/switch main")).rejects.toThrow("active subagents");
    await expect(app.runOnce("/branch other")).rejects.toThrow("active subagents");
    const close = app.close(); expect(app.close()).toBe(close); await close;
    expect(await run).toContain("cancelled");
    expect(output).not.toContain("LATE_REPORT");
    expect(child.aborts).toBe(1);
    expect(child.disposals).toBe(1);
  });

  test("only the final response is returned; streamed Unicode and terminal controls are bounded", async () => {
    const child = new ChildRuntime(async (emit) => {
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_text_delta", delta: "narration, not a finding" });
      emit({ type: "assistant_response_end", stopReason: "toolUse" });
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_text_delta", delta: "\x1b[2J\r\u202e" + "😀".repeat(8000) });
      emit({ type: "assistant_response_end", stopReason: "stop" });
    });
    const agents = manager(() => child);
    const result = await agents.run(task);
    expect(result.response).not.toContain("narration");
    expect(result.response).not.toContain("�");
    expect(Buffer.byteLength(result.response)).toBeLessThanOrEqual(12_288);
    expect(result.truncated).toBe(true);
    expect(formatSubagentReport(result)).not.toMatch(/[\x1b\r\u202e]/);
    expect(formatSubagentReport(result)).toContain("Report truncated");
    const reply = { text: JSON.stringify(result) };
    expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(16_384);
    expect(JSON.parse(reply.text).status).toBe("completed");
  });

  test("surrogate-split deltas survive and truncation retains a prefix, not disjoint fragments", async () => {
    const agents = manager(() => new ChildRuntime(async (emit) => {
      emit({ type: "assistant_text_delta", delta: "\ud83d" });
      emit({ type: "assistant_text_delta", delta: "\ude00" });
      emit({ type: "assistant_text_delta", delta: "x".repeat(12_283) });
      emit({ type: "assistant_text_delta", delta: "😀" });
      emit({ type: "assistant_text_delta", delta: "y" });
    }));
    const result = await agents.run(task);
    expect(result.response).toBe("😀" + "x".repeat(12_283));
    expect(result.truncated).toBe(true);
  });

  test("a shared child runtime is refused without disposing the active owner", async () => {
    const entered = gate(); const finish = gate();
    const child = new ChildRuntime(async (emit) => { entered.release(); await finish.promise; emit({ type: "assistant_text_delta", delta: "done" }); });
    const agents = manager(() => child);
    const first = agents.run(task); await entered.promise;
    const second = await agents.run(task);
    expect(second.status).toBe("failed");
    expect(second.reason).toContain("fresh instance");
    expect(child.disposals).toBe(0);
    finish.release(); expect((await first).status).toBe("completed");
    expect(child.disposals).toBe(1);
  });

  test("excess streaming text aborts before an unbounded event log can grow", async () => {
    const child = new ChildRuntime(async (emit) => {
      for (let i = 0; i < 500; i++) emit({ type: "assistant_text_delta", delta: "x".repeat(4096) });
    });
    const result = await manager(() => child).run(task);
    expect(result.status).toBe("limited");
    expect(result.reason).toContain("text budget");
    expect(Buffer.byteLength(result.response)).toBeLessThanOrEqual(SUBAGENT_LIMITS.responseBytes);
    expect(child.aborts).toBe(1);
  });

  test("model failures, cut-off replies, empty reports, and disposal failures are not success", async () => {
    for (const stopReason of ["error", "aborted", "length", "limit"]) {
      const child = new ChildRuntime(async (emit) => {
        emit({ type: "assistant_text_delta", delta: "partial" });
        emit({ type: "assistant_response_end", stopReason, errorMessage: "incomplete" });
      });
      const tool = manager(() => child).createTool(() => task);
      const reply = await tool.execute({ role: "reviewer", goal: "inspect" });
      expect(reply.isError).toBe(true);
      expect(JSON.parse(reply.text).isError).toBe(true);
    }
    expect((await manager(() => new ChildRuntime(async () => {})).run(task)).status).toBe("failed");
    const child = new ChildRuntime();
    child.dispose = async () => { throw new Error("Cleanup failed"); };
    expect((await manager(() => child).run(task)).reason).toBe("Cleanup failed");
  });

  test("tool envelopes stay below 16 KiB even when report/goal escaping expands the JSON", async () => {
    const tool = manager(() => new ChildRuntime(async (emit) => {
      emit({ type: "assistant_text_delta", delta: '"\\\\'.repeat(20_000) });
    })).createTool(() => task);
    const result = await tool.execute({ role: "reviewer", goal: '"'.repeat(4096) });
    const envelope = JSON.parse(result.text);
    expect(result.isError).toBeUndefined();
    expect(envelope.isError).toBe(false);
    expect(envelope.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(16_384);
    expect(envelope.preview).toContain("completed");
  });

  test("app refuses to reuse its primary runtime and retains fail-closed tool replacement", async () => {
    const parent = new ParentRuntime();
    let disposals = 0;
    parent.dispose = async () => { disposals++; };
    const { app, project } = await appFixture({ runtimeFactory: () => parent, subagentRuntimeFactory: () => parent });
    await app.runOnce("inspect", project);
    await expect(app.runOnce("/delegate explorer inspect")).rejects.toThrow("Delegation failed");
    expect(disposals).toBe(0);
    expect(parent.starts).toBe(1);
    await app.close(); expect(disposals).toBe(1);

    const staticRuntime: AgentRuntime = { start: async (options) => {
      const { setTools, ...session } = await new ParentRuntime().start(options);
      return session;
    }, dispose: async () => {} };
    const other = await appFixture({ runtimeFactory: () => staticRuntime });
    await other.app.runOnce("inspect", other.project);
    await expect(other.app.runOnce("inspect again")).rejects.toThrow("does not support custom capabilities");
  });

  test("review regression: workspace approval reserves admission against commands and captured delegate tools", async () => {
    const input = new PassThrough(); const approval = gate();
    const parent = new ParentRuntime(); let children = 0; let questions = 0;
    const { app, project } = await appFixture({ input, runtimeFactory: () => parent,
      subagentRuntimeFactory: () => { children++; return new ChildRuntime(); },
      output: { write(text) {
        if (text === "> ") queueMicrotask(() => input.write(questions++ === 0 ? "/branch experiment\n" : "/exit\n"));
        if (text.includes("Type yes:")) approval.release();
      } },
    });
    await app.runOnce("inspect", project);
    const capturedTool = parent.tools.find((tool) => tool.name === "delegate")!;
    const interactive = app.runInteractive(); await approval.promise;
    await expect(app.runOnce("/delegate explorer inspect")).rejects.toThrow("workspace transition");
    const result = await capturedTool.execute({ role: "explorer", goal: "inspect" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Workspace transition");
    expect(children).toBe(0);
    input.write("no\n"); await interactive;
  });

  test("parent tasks expose delegation, invalid commands stay local, and command failures reject", async () => {
    const parent = new ParentRuntime();
    const { app, project } = await appFixture({ runtimeFactory: () => parent, subagentRuntimeFactory: () => new ChildRuntime(async () => {}) });
    await expect(app.runOnce("/delegate writer edit", project)).rejects.toThrow("Usage:");
    await expect(app.runOnce("/delegate reviewer")).rejects.toThrow("Usage:");
    expect(parent.starts).toBe(0);
    await app.runOnce("Find the entry point");
    expect(parent.tools.map((tool) => tool.name)).toEqual(["delegate"]);
    const result = await parent.tools[0]!.execute({ role: "reviewer", goal: "inspect" });
    expect(result.isError).toBe(true);
    await expect(app.runOnce("/delegate reviewer inspect")).rejects.toThrow("Delegation failed");
  });
});
