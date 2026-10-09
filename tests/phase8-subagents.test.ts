import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import { CasperApp, type CasperAppOptions } from "../src/app";
import { formatSubagentReport, SubagentManager, SUBAGENT_LIMITS } from "../src/agents/manager";
import { loadProjectContext } from "../src/project/context";
import { SkillRegistry } from "../src/skills/registry";
import { TaskObservations } from "../src/task/observations";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeReadOnlyStartOptions, RuntimeSession, RuntimeStartOptions, RuntimeTool, RuntimeUsage } from "../src/runtime/types";
import { removeTempDir } from "./support/temp-dir";

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
  /** What the child session's getUsage returns (its effort classifier's calls); unset, it has none. */
  usage?: RuntimeUsage;
  /** Each reason Casper gave the child's wrapUp (near its deadline). */
  wrapUps: string[] = [];
  onWrapUp = () => {};
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
      wrapUp: (reason) => { this.wrapUps.push(reason); this.onWrapUp(); },
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      getState: () => ({ cwd: options.cwd, isStreaming: false }),
      ...(this.usage ? { getUsage: () => this.usage! } : {}),
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
  cleanup.push(() => removeTempDir(root));
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

  test("a model that sends unused fields as null (of: null, context: null) still delegates", async () => {
    let created = 0;
    const tool = manager(() => { created++; return new ChildRuntime(); }).createTool(() => task);
    const result = await tool.execute({ role: "explorer", goal: "inspect", context: null, of: null });
    expect(result.text).not.toContain("whole number");
    expect(result.isError).toBeUndefined();
    expect(created).toBe(1);
  });

  test("a child's reported model usage is totalled for the parent; one unreported response makes it unknown", async () => {
    const end = (usage?: { tokens: number; estimatedCost: number }) => ({ type: "assistant_response_end" as const, stopReason: "toolUse", ...(usage ? { usage } : {}) });
    const reported = await manager(() => new ChildRuntime(async (emit) => {
      emit({ type: "assistant_response_start" }); emit(end({ tokens: 30, estimatedCost: 0.5 }));
      emit({ type: "assistant_response_start" }); emit({ type: "assistant_text_delta", delta: "Evidence: index.ts:1" });
      emit({ ...end({ tokens: 20, estimatedCost: 0.25 }), stopReason: "stop" });
      // The runtime's own limit notice ends no model response and carries no usage.
      emit({ type: "assistant_response_end", stopReason: "limit", errorMessage: "Subagent tool-call budget exhausted" });
    })).run(task);
    expect(reported.usage).toEqual({ tokens: 50, estimatedCost: 0.75 });
    const unreported = await manager(() => new ChildRuntime(async (emit) => {
      emit({ type: "assistant_response_start" }); emit(end({ tokens: 30, estimatedCost: 0.5 }));
      emit({ type: "assistant_response_start" }); emit({ type: "assistant_text_delta", delta: "Evidence: index.ts:1" }); emit(end());
    })).run(task);
    expect(unreported.usage).toBeNull();
    // A response still streaming when the run ended may be billed later: unknown, not zero.
    const cut = await manager(() => new ChildRuntime(async (emit) => {
      emit({ type: "assistant_response_start" }); emit({ type: "assistant_text_delta", delta: "Evidence: index.ts:1" });
    })).run(task);
    expect(cut.usage).toBeNull();
    // The model reads the report; the usage goes to the parent's totals, not into the tool result.
    const seen: unknown[] = [];
    const tool = manager(() => new ChildRuntime(async (emit) => {
      emit({ type: "assistant_response_start" }); emit({ type: "assistant_text_delta", delta: "Evidence: index.ts:1" });
      emit({ ...end({ tokens: 7, estimatedCost: 0.125 }), stopReason: "stop" });
    })).createTool(() => task, (usage) => seen.push(usage));
    expect((await tool.execute({ role: "explorer", goal: "inspect" })).text).not.toContain("estimatedCost");
    // A call rejected before any child ran made no model calls.
    expect((await tool.execute({ role: "writer", goal: "inspect" })).isError).toBe(true);
    expect(seen).toEqual([{ tokens: 7, estimatedCost: 0.125 }, { tokens: 0, estimatedCost: 0 }]);
  });

  test("a helper whose exact usage is unknown still adds what its reported responses cost to the task's spend", async () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const respond = (emit: (event: RuntimeEvent) => void) => {
      for (let n = 0; n < 4; n++) {
        emit({ type: "assistant_response_start" });
        emit({ type: "assistant_response_end", stopReason: "toolUse", usage: { tokens: 1000, estimatedCost: 0.5 } });
      }
      emit({ type: "assistant_response_start" }); emit({ type: "assistant_text_delta", delta: "Evidence: index.ts:1" });
    };
    // The effort classifier ran: the child's total is unknown, but its four reported responses cost $2.
    const classified = new ChildRuntime(async (emit) => {
      respond(emit); emit({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 10, estimatedCost: 0 } });
    });
    classified.usage = { tokens: zero, messages: 0, effortClassification: { requests: 1, tokens: zero, estimatedCost: 0.001 } };
    // A last response that reported nothing.
    const unreported = new ChildRuntime(async (emit) => { respond(emit); emit({ type: "assistant_response_end", stopReason: "stop" }); });
    // Stopped by its deadline while a response was still streaming.
    const cut = new ChildRuntime(async (emit) => { respond(emit); await new Promise<void>(() => {}); });
    for (const child of [classified, unreported, cut]) {
      const observations = new TaskObservations();
      observations.observeUsage({ type: "tool_start", toolName: "delegate" });
      const agents = manager(() => child, child === cut ? 200 : undefined);
      const tool = agents.createTool(() => task, (usage, known) => observations.recordDelegatedUsage(usage, known));
      await tool.execute({ role: "explorer", goal: "inspect" });
      expect(observations.spent().cost).toBe(2);
      expect(observations.spent().tokens).toBeGreaterThanOrEqual(4000);
      // A helper still cleaning up after its result came back is not counted a second time.
      expect(agents.runs()).toHaveLength(child === cut ? 1 : 0);
      expect(agents.runs().reduce((sum, run) => sum + (run.spent?.estimatedCost ?? 0), 0)).toBe(0);
      // The exact totals stay unknown rather than an undercount.
      expect(observations.snapshot([]).usage).toEqual({ turns: 0, tokens: null, estimatedCost: null });
    }
  });

  test("a parent task that delegated reports its own and its child's usage in the receipt", async () => {
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
    let tools: RuntimeTool[] = [];
    const parent: AgentRuntime = { start: async (options) => {
      tools = options.tools ?? [];
      return {
        setTools: (next) => { tools = next; }, abort: async () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }),
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        prompt: async () => {
          emit({ type: "assistant_response_start" });
          emit({ type: "assistant_response_end", stopReason: "toolUse", usage: { tokens: 100, estimatedCost: 0.5 } });
          emit({ type: "tool_start", toolName: "delegate", toolCallId: "d1" });
          const result = await tools.find((tool) => tool.name === "delegate")!.execute({ role: "explorer", goal: "Find the entry point" });
          emit({ type: "tool_end", toolName: "delegate", toolCallId: "d1", isError: Boolean(result.isError), output: { text: result.text, truncated: false } });
          emit({ type: "assistant_response_start" });
          emit({ type: "assistant_text_delta", delta: "The entry point is index.ts." });
          emit({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 50, estimatedCost: 0.25 } });
        },
      };
    }, dispose: async () => {} };
    const { app, project } = await appFixture({ runtimeFactory: () => parent, subagentRuntimeFactory: () => new ChildRuntime(async (emit) => {
      emit({ type: "assistant_response_start" }); emit({ type: "assistant_text_delta", delta: "Evidence: index.ts:1" });
      emit({ type: "assistant_response_end", stopReason: "stop", usage: { tokens: 30, estimatedCost: 0.125 } });
    }) });
    await app.runOnce("Where is the entry point?", project);
    expect(app.getLastTaskResult()?.usage).toEqual({ turns: 2, tokens: 180, estimatedCost: 0.875 });
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
    expect(child.options?.reportTurn).toBe(true);
    expect(child.options?.systemPromptAppend).toContain("Casper project context");
    expect(child.prompts[0]).toContain("Goal:\nFind the entry point");
    expect(child.prompts[0]).toContain("no edits, shell, tests");
    expect(child.prompts[0]).toContain("one tool-free turn to report");
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

  test("a delegate turned away as busy does not spend the task's budget", async () => {
    const hold = gate();
    let created = 0;
    const agents = manager(() => { created++; return new ChildRuntime(async (emit) => { await hold.promise; emit({ type: "assistant_text_delta", delta: "done" }); }); });
    const tool = agents.createTool(() => task);
    // Three in one parallel batch: two run, the third is turned away as busy.
    const running = [tool.execute({ role: "reviewer", goal: "a" }), tool.execute({ role: "reviewer", goal: "b" })];
    const busy = await tool.execute({ role: "reviewer", goal: "c" });
    expect(busy.text).toContain("concurrency limit");
    hold.release();
    for (const result of await Promise.all(running)) expect(result.isError).toBeUndefined();
    // The busy call was not spent: two more still fit the budget of four, then it is exhausted.
    for (const goal of ["c", "d"]) expect((await tool.execute({ role: "reviewer", goal })).isError).toBeUndefined();
    expect((await tool.execute({ role: "reviewer", goal: "e" })).text).toContain("budget exhausted");
    expect(created).toBe(4);
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

  test("a child stopped mid-investigation reports its last words instead of nothing", async () => {
    const child = new ChildRuntime(async (emit) => {
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_text_delta", delta: "Budget constants live in src/agents/manager.ts; checking callers" });
      emit({ type: "assistant_response_end", stopReason: "toolUse" });
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_response_end", stopReason: "limit", errorMessage: "Subagent turn/tool-call budget exhausted" });
    });
    const result = await manager(() => child).run(task);
    expect(result.status).toBe("limited");
    expect(result.reason).toContain("budget exhausted");
    expect(result.response).toBe("Budget constants live in src/agents/manager.ts; checking callers");
    expect(formatSubagentReport(result)).toContain("checking callers");
  });

  test("a helper stopped at a limit hands back its report, marked partial", async () => {
    const child = new ChildRuntime(async (emit) => {
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_response_end", stopReason: "toolUse" });
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_text_delta", delta: "Partial: the budget check is in src/agents/manager.ts:9; callers not read yet" });
      emit({ type: "assistant_response_end", stopReason: "stop" });
      emit({ type: "assistant_response_end", stopReason: "limit", errorMessage: "Stopped at its 12-turn limit" });
    });
    const tool = manager(() => child).createTool(() => task);
    const result = await tool.execute({ role: "explorer", goal: "Audit the budget code" });
    // Still flagged (it is not a whole answer), with the reason and the findings first in the result.
    expect(result.isError).toBe(true);
    expect(result.text).toContain('"status":"limited","reason":"partial: stopped at its 12-turn limit"');
    expect(result.text).toContain("manager.ts:9");
  });

  test("a helper that wrote nothing before its limit still says where it looked", async () => {
    const child = new ChildRuntime(async (emit) => {
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_response_end", stopReason: "toolUse" });
      emit({ type: "tool_start", toolName: "read", input: { path: "src/app.ts" } });
      emit({ type: "tool_end", toolName: "read", input: { path: "src/app.ts" }, isError: false });
      emit({ type: "tool_end", toolName: "grep", input: { pattern: "maxTurns" }, isError: false });
      emit({ type: "assistant_response_end", stopReason: "limit", errorMessage: "Stopped at its 48-tool-call limit" });
    });
    const result = await manager(() => child).run(task);
    expect(result.status).toBe("limited");
    expect(result.reason).toBe("partial: stopped at its 48-tool-call limit");
    expect(result.response).toBe("Partial: no report was written before the limit. It looked at: src/app.ts, maxTurns.");
  });

  test("near its deadline a helper is told to wrap up and reports instead of timing out", async () => {
    const wrapped = gate();
    const child = new ChildRuntime(async (emit) => {
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_response_end", stopReason: "toolUse" });
      await wrapped.promise;
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_text_delta", delta: "Partial: entry point is src/cli.ts:1" });
      emit({ type: "assistant_response_end", stopReason: "stop" });
      emit({ type: "assistant_response_end", stopReason: "limit", errorMessage: child.wrapUps[0] });
    });
    child.onWrapUp = wrapped.release;
    const result = await manager(() => child, 400).run(task);
    // The reserve is a quarter of a short deadline: the wrap-up comes at 300 ms, before the 400 ms stop.
    expect(child.wrapUps).toEqual(["Stopped near its 0.4-second time limit"]);
    expect(result.status).toBe("limited");
    expect(result.reason).toBe("partial: stopped near its 0.4-second time limit");
    expect(result.response).toBe("Partial: entry point is src/cli.ts:1");
    expect(child.aborts).toBe(0);
  });

  test("a helper is told the deadline its manager really enforces", async () => {
    const child = new ChildRuntime();
    await manager(() => child, 90_000).run(task);
    expect(child.prompts[0]).toContain("90 seconds, then one tool-free turn to report");
    expect(child.prompts[0]).not.toContain(`${SUBAGENT_LIMITS.timeoutMs / 60_000} minutes`);
  });

  test("a helper still on a step at its hard deadline hands back where it looked; learn's runs stay empty", async () => {
    for (const reportTurn of [true, false]) {
      const finish = gate();
      const child = new ChildRuntime(async (emit) => {
        emit({ type: "tool_end", toolName: "read", input: { path: "src/app.ts" }, isError: false });
        emit({ type: "tool_start", toolName: "grep", input: { pattern: "slow" } });
        await finish.promise;
      });
      child.onAbort = finish.release;
      const result = await manager(() => child, 30).run({ ...task, reportTurn });
      expect(result.status).toBe("timed_out");
      expect(result.response).toBe(reportTurn ? "Partial: no report was written before the limit. It looked at: src/app.ts." : "");
    }
  });

  test("every helper kind is told it gets a report turn and how long it has", async () => {
    const child = new ChildRuntime();
    await manager(() => child).run({ ...task, role: "reviewer" });
    expect(child.options?.reportTurn).toBe(true);
    expect(child.prompts[0]).toContain(`${SUBAGENT_LIMITS.timeoutMs / 60_000} minutes, then one tool-free turn to report`);
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

  test("a provider error the child's retry recovers from is not a failure, but one it gives up on is", async () => {
    const attempt = (emit: (event: RuntimeEvent) => void, stopReason: string, text?: string) => {
      emit({ type: "assistant_response_start" });
      if (text) emit({ type: "assistant_text_delta", delta: text });
      emit({ type: "assistant_response_end", stopReason, ...(stopReason === "error" ? { errorMessage: "429 Provider returned error" } : {}) });
    };
    const recovered = await manager(() => new ChildRuntime(async (emit) => {
      attempt(emit, "error"); attempt(emit, "stop", "Evidence: index.ts:1");
    })).run(task);
    expect({ status: recovered.status, reason: recovered.reason, response: recovered.response }).toEqual({ status: "completed", reason: undefined, response: "Evidence: index.ts:1" });
    const exhausted = await manager(() => new ChildRuntime(async (emit) => {
      attempt(emit, "toolUse", "Looking"); attempt(emit, "error"); attempt(emit, "error");
    })).run(task);
    expect({ status: exhausted.status, reason: exhausted.reason }).toEqual({ status: "failed", reason: "429 Provider returned error" });
  });

  test("a provider's own cut-off text stays marked as the provider's after it is called partial", async () => {
    for (const reportTurn of [true, false]) {
      const result = await manager(() => new ChildRuntime(async (emit) => {
        emit({ type: "assistant_response_start" });
        emit({ type: "assistant_response_end", stopReason: "length", errorMessage: "provider echoed source text" });
      })).run({ ...task, reportTurn });
      expect({ status: result.status, reason: result.reason, providerReason: result.providerReason })
        .toEqual({ status: "limited", reason: "partial: provider echoed source text", providerReason: true });
    }
  });

  test("a child's tool errors carry Pi's message, which the child also saw, not just the tool name", async () => {
    const result = await manager(() => new ChildRuntime(async (emit) => {
      emit({ type: "tool_end", toolName: "read", toolCallId: "1", isError: true, output: { text: "EISDIR: illegal operation on a directory, read", truncated: false } });
      emit({ type: "tool_end", toolName: "read", toolCallId: "2", isError: true, output: { text: `ENOENT: no such file\n${"x".repeat(2000)}`, truncated: false } });
      emit({ type: "tool_end", toolName: "read", toolCallId: "3", isError: true });
      emit({ type: "assistant_text_delta", delta: "done" });
    })).run(task);
    expect(result.toolErrors).toEqual(["read: EISDIR: illegal operation on a directory, read", "read: ENOENT: no such file", "read: tool failed"]);
  });

  test("a tool call cut off by the output limit, which the child re-issues, is not a limited run", async () => {
    const result = await manager(() => new ChildRuntime(async (emit) => {
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_response_end", stopReason: "length" });
      // Pi fails every call in a length-stopped response, tells the child why, and keeps the loop going.
      emit({ type: "tool_end", toolName: "read", toolCallId: "1", isError: true, output: { text: 'Tool call "read" was not executed: the response hit the output token limit', truncated: false } });
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_text_delta", delta: "FINDINGS: big.ts:1276" });
      emit({ type: "assistant_response_end", stopReason: "stop" });
    })).run(task);
    expect({ status: result.status, reason: result.reason, response: result.response }).toEqual({ status: "completed", reason: undefined, response: "FINDINGS: big.ts:1276" });
    expect(result.toolErrors).toEqual(['read: Tool call "read" was not executed: the response hit the output token limit']);
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

  test("review regression: a workspace transition reserves admission against commands and captured delegate tools", async () => {
    const input = new PassThrough(); const reached = gate(); const hold = gate();
    // /branch asks nothing (you typed it): the transition is held at the runtime's fork instead.
    const parent = new class extends ParentRuntime {
      override async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
        const session = await super.start(options);
        const info = { cwd: options.cwd, sessionId: "parent", sessionFile: path.join(options.cwd, "parent.jsonl") };
        return { ...session, getSessionInfo: () => ({ ...info }), switchSession: async () => ({ ...info }),
          forkSession: async () => { reached.release(); await hold.promise; throw new Error("fork stopped by the test"); } };
      }
    }();
    let children = 0; let questions = 0;
    const { app, project } = await appFixture({ input, runtimeFactory: () => parent,
      subagentRuntimeFactory: () => { children++; return new ChildRuntime(); },
      output: { write(text) {
        if (text === "> ") queueMicrotask(() => input.write(questions++ === 0 ? "/branch experiment\n" : "/exit\n"));
      } },
    });
    await app.runOnce("inspect", project);
    const capturedTool = parent.tools.find((tool) => tool.name === "delegate")!;
    const interactive = app.runInteractive(); await reached.promise;
    await expect(app.runOnce("/delegate explorer inspect")).rejects.toThrow("workspace transition");
    const result = await capturedTool.execute({ role: "explorer", goal: "inspect" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Workspace transition");
    expect(children).toBe(0);
    hold.release(); await interactive;
  });

  test("parent tasks expose delegation, invalid commands stay local, and command failures reject", async () => {
    const parent = new ParentRuntime();
    const { app, project } = await appFixture({ runtimeFactory: () => parent, subagentRuntimeFactory: () => new ChildRuntime(async () => {}) });
    await expect(app.runOnce("/delegate writer edit", project)).rejects.toThrow("Usage:");
    await expect(app.runOnce("/delegate reviewer")).rejects.toThrow("Usage:");
    expect(parent.starts).toBe(0);
    await app.runOnce("Find the entry point");
    expect(parent.tools.map((tool) => tool.name)).toEqual(["delegate", "ask", "casper_session", "web_search", "web_fetch", "casper_read_untrusted", "casper_page"]);
    const result = await parent.tools[0]!.execute({ role: "reviewer", goal: "inspect" });
    expect(result.isError).toBe(true);
    await expect(app.runOnce("/delegate reviewer inspect")).rejects.toThrow("Delegation failed");
  });
});

test("review: a helper gets the project's denyRead as private paths, like the main AI", async () => {
  const child = new ChildRuntime();
  const agents = new SubagentManager({ runtimeFactory: () => child, cleanupGraceMs: 20, privatePaths: () => ["/data/greencli-logs"] });
  cleanup.push(() => agents.close());
  await agents.run(task);
  expect(child.options?.privatePaths).toEqual(["/data/greencli-logs"]);
});
