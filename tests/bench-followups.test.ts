import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubagentManager, type DelegateBuilders } from "../src/agents/manager";
import { CasperApp } from "../src/app";
import { RuntimeEventMapper, receiptEvent, storedTaskResult, type CasperEvent } from "../src/app/json-events";
import { DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND } from "../src/app/prompt";
import { settingRows } from "../src/app/settings";
import { PartRecord } from "../src/crew/parts";
import { inspectProject } from "../src/project/inspect";
import { loadProjectContext } from "../src/project/context";
import { observationInput } from "../src/runtime/observation";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeReadOnlyStartOptions, RuntimeSession } from "../src/runtime/types";
import { TaskObservations } from "../src/task/observations";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const usage = { tokens: 100, estimatedCost: 0.01, input: 10, cacheRead: 70, cacheWrite: 5, output: 15 };
const patch = (n: number) => Buffer.from(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,${n} @@\n${"+code\n".repeat(n)}`);
function land(parts: PartRecord, n = 7): number {
  return parts.landed({ goal: "change x", files: ["x.ts"], stat: "x.ts", patch: patch(n) });
}
async function folder() {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-followups-"));
  cleanup.push(() => removeTempDir(root));
  const home = path.join(root, "home"), repo = path.join(root, "repo");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(path.join(repo, ".casper"), { recursive: true });
  return { home, repo };
}

class Reader implements AgentRuntime {
  constructor(private readonly finish: "stop" | "error" | "length" = "stop", private readonly seen: string[] = []) {}
  async start(): Promise<RuntimeSession> { throw new Error("not main"); }
  async startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
    return { prompt: async (text) => {
      this.seen.push(text);
      emit({ type: "assistant_response_start" });
      emit({ type: "assistant_text_delta", delta: "No findings." });
      emit({ type: "assistant_response_end", stopReason: this.finish, usage });
    }, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    abort: async () => {}, getState: () => ({ cwd: options.cwd, isStreaming: false }) };
  }
  async dispose() {}
}
function manager(parts: PartRecord, finish: "stop" | "error" | "length" = "stop", seen: string[] = []) {
  const m = new SubagentManager({ runtimeFactory: () => new Reader(finish, seen) });
  cleanup.push(() => m.close());
  const builders: DelegateBuilders = { parts, run: async () => { throw new Error("unused"); } };
  return m.createTool(() => ({ cwd: process.cwd(), projectContext: "fixture" }), undefined, builders);
}

async function builderContext(home: string, repo: string) {
  return loadProjectContext(await inspectProject(repo), { homeDir: home });
}

test("builders default off and settings offers the on switch", async () => {
  const { home, repo } = await folder();
  const context = await builderContext(home, repo);
  expect(context.delegate).toEqual({ build: false });
  const row = settingRows(context).find(row => row.label === "Helpers that build")!;
  expect(row.value).toBe("off");
  expect(row.choices).toEqual([{ label: "Turn them on", keys: ["delegate", "build"], value: true, shown: "on" }]);
});

for (const userOff of [false, true]) test(`a project delegate.build: true cannot enable builders${userOff ? " over a user off" : " by itself"}`, async () => {
  const { home, repo } = await folder();
  await writeFile(path.join(repo, ".casper", "project.yaml"), "delegate:\n  build: true\n");
  if (userOff) await writeFile(path.join(home, ".casper", "config.yaml"), "delegate:\n  build: false\n");
  expect((await builderContext(home, repo)).delegate).toEqual({ build: false });
});

test("user settings can turn builders on", async () => {
  const { home, repo } = await folder();
  await writeFile(path.join(home, ".casper", "config.yaml"), "delegate:\n  build: true\n");
  const context = await builderContext(home, repo);
  expect(context.delegate).toEqual({ build: true });
  expect(settingRows(context).find(row => row.label === "Helpers that build")!.choices[0]?.value).toBe(false);
});

test("a user-selected user profile can turn builders on", async () => {
  const { home, repo } = await folder();
  await mkdir(path.join(home, ".casper", "profiles", "helpers"), { recursive: true });
  await writeFile(path.join(home, ".casper", "profiles", "helpers", "config.yaml"), "delegate:\n  build: true\n");
  await writeFile(path.join(home, ".casper", "config.yaml"), "profile: helpers\n");
  expect((await builderContext(home, repo)).delegate).toEqual({ build: true });
});

test("a project-selected profile cannot turn builders on", async () => {
  const { home, repo } = await folder();
  await mkdir(path.join(home, ".casper", "profiles", "helpers"), { recursive: true });
  await writeFile(path.join(home, ".casper", "profiles", "helpers", "config.yaml"), "delegate:\n  build: true\n");
  await writeFile(path.join(repo, ".casper", "project.yaml"), "profile: helpers\n");
  expect((await builderContext(home, repo)).delegate).toEqual({ build: false });
});

for (const source of ["settings", "profile"] as const) test(`a project can turn builders off after user ${source} enabled them`, async () => {
  const { home, repo } = await folder();
  if (source === "settings") await writeFile(path.join(home, ".casper", "config.yaml"), "delegate:\n  build: true\n");
  else {
    await mkdir(path.join(home, ".casper", "profiles", "helpers"), { recursive: true });
    await writeFile(path.join(home, ".casper", "profiles", "helpers", "config.yaml"), "delegate:\n  build: true\n");
    await writeFile(path.join(home, ".casper", "config.yaml"), "profile: helpers\n");
  }
  expect((await builderContext(home, repo)).delegate).toEqual({ build: true });
  await writeFile(path.join(repo, ".casper", "project.yaml"), "delegate:\n  build: false\n");
  expect((await builderContext(home, repo)).delegate).toEqual({ build: false });
});

test("turning builders off leaves read-only helpers offered", async () => {
  const { repo } = await folder();
  const m = new SubagentManager({ runtimeFactory: () => new Reader() });
  cleanup.push(() => m.close());
  const tool = m.createTool(() => ({ cwd: repo, projectContext: "fixture" }), undefined, { off: "turned off", run: async () => { throw new Error("unused"); } });
  expect((tool.inputSchema as { properties: { role: { enum: string[] } } }).properties.role.enum).toEqual(["explorer", "reviewer"]);
  for (const role of ["explorer", "reviewer"]) expect((await tool.execute({ role, goal: "look" })).isError).toBeUndefined();
  expect((await tool.execute({ role: "builder", goal: "build" })).isError).toBe(true);
});

test("fallback reviews only substantial unattempted parts, once per version, outside the explorer budget", async () => {
  const parts = new PartRecord(), seen: string[] = [];
  const big = land(parts), tiny = land(parts, 6);
  const binary = parts.landed({ goal: "image", files: ["image.png"], stat: "binary", patch: Buffer.from("GIT binary patch\nliteral 1\nx\n") });
  const tool = manager(parts, "stop", seen);
  for (let i = 0; i < 4; i++) await tool.execute({ role: "explorer", goal: `find ${i}` });
  await tool.reviewPending();
  expect(parts.unreviewed()).toEqual([tiny]);
  expect(seen).toHaveLength(6);
  expect(seen[4]).toContain("+code");
  expect(seen[5]).toContain("binary file, not shown");
  await tool.reviewPending();
  expect(seen).toHaveLength(6);
  parts.refreshExcerpt(big, patch(1));
  await tool.reviewPending();
  expect(seen).toHaveLength(7);
  expect(parts.unreviewed()).not.toContain(big);
  expect(parts.unreviewed()).not.toContain(binary);
});

for (const finish of ["error", "length"] as const) test(`a ${finish} fallback review stays unreviewed and is not retried`, async () => {
  const parts = new PartRecord(), seen: string[] = [];
  land(parts);
  const tool = manager(parts, finish, seen);
  await tool.reviewPending(); await tool.reviewPending();
  expect(seen).toHaveLength(1);
  expect(parts.notReviewed()[0]?.why).toBe(finish === "error" ? "the reviewer failed" : "the reviewer was cut off");
});

test("an explicit review spends the fallback budget; aborted fallback starts nothing", async () => {
  const parts = new PartRecord(), seen: string[] = [];
  land(parts);
  const tool = manager(parts, "stop", seen);
  await tool.execute({ role: "reviewer", goal: "check", of: 1 });
  await tool.reviewPending();
  expect(seen).toHaveLength(1);
  land(parts);
  await tool.reviewPending(AbortSignal.abort());
  expect(seen).toHaveLength(1);
  expect(parts.pendingReviews()).toEqual([2]);
});

test("a helper's multiple turns sum the provider's split and each emits usage", async () => {
  const reported: RuntimeEvent[] = [];
  class TwoTurns extends Reader {
    override async startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
      const session = await super.startReadOnly(options);
      return { ...session, prompt: async text => { await session.prompt(text); await session.prompt(text); } };
    }
  }
  const m = new SubagentManager({ runtimeFactory: () => new TwoTurns(), onActivity: activity => {
    if (activity.kind === "usage" && activity.event) reported.push(activity.event);
  } });
  cleanup.push(() => m.close());
  const result = await m.run({ cwd: process.cwd(), projectContext: "fixture", role: "explorer", goal: "find" });
  expect(result.usage).toEqual({ tokens: 200, estimatedCost: 0.02, input: 20, cacheRead: 140, cacheWrite: 10, output: 30 });
  expect(reported).toHaveLength(2);
  for (const event of reported) expect(new RuntimeEventMapper().map(event)).toEqual([{ type: "usage", ...usage }]);
});

test("receipt usage sums main and each helper's cache fields, unknown stays null", () => {
  const observations = new TaskObservations();
  observations.observeUsage({ type: "assistant_response_end", stopReason: "toolUse", usage });
  for (const role of ["builder", "reviewer", "explorer"] as const) {
    observations.observeUsage({ type: "tool_start", toolName: "delegate" });
    observations.recordDelegatedUsage(usage, undefined, { role, goal: "look", ...(role !== "explorer" ? { part: 1 } : {}) });
  }
  const result = { execution: "completed" as const, ...observations.snapshot([]) };
  const expected = { turns: 1, tokens: 400, estimatedCost: 0.04, input: 40, cacheRead: 280, cacheWrite: 20, output: 60,
    helpers: (["builder", "reviewer", "explorer"] as const).map(role => ({ role, goal: "look", ...usage, ...(role !== "explorer" ? { part: 1 } : {}) })) };
  expect(result.usage).toEqual(expected);
  expect(receiptEvent(undefined, result, 0).usage).toEqual(expected);
  expect(storedTaskResult(result).usage).toEqual(expected);
  observations.recordDelegatedUsage(null, usage, { role: "reviewer", goal: "unknown" });
  expect(observations.snapshot([]).usage).toMatchObject({ input: null, cacheRead: null, cacheWrite: null, output: null });
  expect(observations.snapshot([]).usage.helpers?.at(-1)).toMatchObject({ tokens: null, input: null, cacheRead: null, cacheWrite: null, output: null });
});

test("JSON turns include cache usage, and delegate start/end retain bounded redacted identity and part", () => {
  const mapper = new RuntimeEventMapper();
  expect(mapper.map({ type: "assistant_response_end", stopReason: "toolUse", usage })).toEqual([{ type: "usage", ...usage }]);
  const input = observationInput({ role: "reviewer", goal: `token=example-secret ${"x".repeat(200)}`, of: 2, context: "private" });
  expect(input.goal).not.toContain("example-secret");
  expect(input.goal!.length).toBeLessThanOrEqual(120);
  expect(input).not.toHaveProperty("context");
  const start = mapper.map({ type: "tool_start", toolName: "delegate", toolCallId: "review", input })[0]!;
  expect(start).toMatchObject({ role: "reviewer", goal: input.goal, part: 2 });
  expect(mapper.map({ type: "tool_end", toolName: "delegate", toolCallId: "review", isError: false })[0]).toMatchObject({ role: "reviewer", goal: input.goal, part: 2 });
  mapper.map({ type: "tool_start", toolName: "delegate", toolCallId: "build", input: observationInput({ role: "builder", goal: "implement" }) });
  expect(mapper.map({ type: "tool_end", toolName: "delegate", toolCallId: "build", isError: false, output: { text: JSON.stringify({ data: { part: 3 } }), truncated: false } })[0]).toMatchObject({ role: "builder", goal: "implement", part: 3 });
});

for (const stop of ["none", "turn-limit", "spend", "cancel", "failure"] as const) test(`task finalization: ${stop}; review only a live task, before receipt with streamed helper usage`, async () => {
  const { repo, home } = await folder();
  const events: CasperEvent[] = [];
  let app: CasperApp;
  let offeredRoles: string[] = [];
  const capture = (tools: import("../src/runtime/types").RuntimeTool[]) => {
    offeredRoles = (tools.find(tool => tool.name === "delegate")!.inputSchema as { properties: { role: { enum: string[] } } }).properties.role.enum;
  };
  const main: AgentRuntime = { start: async options => {
    capture(options.tools ?? []);
    return { prompt: async () => {
      land(app.crewParts!);
      if (stop === "turn-limit") app.taskTurnLimit = 1;
      if (stop === "spend") app.taskSpendStop = { spent: 1, limit: 1 };
      if (stop === "cancel") app.taskRuntimeCancelled = true;
      if (stop === "failure") app.taskRuntimeFailed = true;
    },
      setTools: capture, abort: async () => {}, subscribe: () => () => {}, getState: () => ({ cwd: repo, isStreaming: false }),
    };
  }, dispose: async () => {} };
  app = new CasperApp({ runtimeFactory: () => main, subagentRuntimeFactory: () => new Reader(), sessionHomeDir: home,
    output: { write: () => {} }, onEvent: event => { events.push(event); },
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }), loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }) });
  cleanup.push(() => app.close());
  await app.runOnce("explain this project", repo);
  expect(offeredRoles).toEqual(["explorer", "reviewer"]);
  if (stop !== "none") {
    expect(app.getLastTaskResult()!.partsNotReviewed).toHaveLength(1);
    expect(events.filter(event => event.type === "usage")).toEqual([]);
    return;
  }
  expect(app.getLastTaskResult()!.partsNotReviewed).toBeUndefined();
  expect(app.getLastTaskResult()!.usage).toMatchObject({ ...usage, helpers: [{ role: "reviewer", part: 1, ...usage }] });
  expect(events.filter(event => event.type === "usage")).toEqual([{ type: "usage", ...usage, helper: 1 }]);
});

test("working rules, docs, site and help explain the new defaults without raising prompt budgets", async () => {
  for (const prompt of [DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND]) expect(prompt).toContain("Don't change behaviour the task didn't ask for; write code that works on every OS the project targets.");
  for (const file of ["docs/CONFIGURATION.md", "docs/CREWS.md", "site/tour.html", "src/tui/help.ts"]) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    expect(text).toContain("off by default");
    expect(text).toContain("Helpers that build");
  }
  const adr = await readFile(new URL("../docs/adr/0002/16-builders-opt-in.md", import.meta.url), "utf8");
  expect(adr).toContain("a project file may only turn builders off");
  expect(adr).toContain("A project cannot turn builders on, directly or through a profile it selects");
  expect(adr).toContain("`/crew` and background builds are unchanged");
});
