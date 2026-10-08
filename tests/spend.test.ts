import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import type { AgentRuntime, RuntimeEvent, RuntimeEventListener, RuntimeStartOptions, RuntimeStatus } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { formatReceipt, taskExitCode } from "../src/task/result";
import { formatFooterSpend, formatTaskSpend, requestSpendLimit, SpendGuard } from "../src/task/spend";
import { formatCost, formatTokens } from "../src/tui/format";
import { fakeWriter } from "./support/tty";
import { removeTempDir } from "./support/temp-dir";

const ambientTerm = process.env.TERM;
process.env.TERM = "xterm-256color";
afterAll(() => { if (ambientTerm === undefined) delete process.env.TERM; else process.env.TERM = ambientTerm; });

test("the footer shows the task's tokens and cost; a free model shows tokens only", () => {
  expect(formatTaskSpend({ tokens: 48_213, cost: 0.314 }, true)).toBe("task 48.2k tok · $0.31");
  expect(formatTaskSpend({ tokens: 8_100_000, cost: 0 }, false)).toBe("task 8.1M tok");
  expect(formatTaskSpend({ tokens: 950, cost: 0 }, undefined)).toBe("task 950 tok");
  expect(formatTaskSpend({ tokens: 950, cost: 0.004 }, undefined)).toBe("task 950 tok · $0.004");
  expect([formatCost(5.0231), formatCost(123.4), formatTokens(312_400)]).toEqual(["$5.02", "$123", "312k"]);
});

test("a limit said in the request becomes the task's pause; other dollar amounts don't", () => {
  expect(["keep it under $2", "budget of $10 for this", "no more than $3.50 please", "max $5", "spend at most $1"].map(requestSpendLimit)).toEqual([2, 10, 3.5, 5, 1]);
  expect(["price the item at $20", "add a $5 fee field", "fix the checkout"].map(requestSpendLimit)).toEqual([undefined, undefined, undefined]);
});

test("by default the task only gets notes, at $1 and again at $5, and never pauses", () => {
  const guard = new SpendGuard({ noteAt: 1 });
  expect([guard.noteDue(0.5), guard.noteDue(1.02), guard.noteDue(3), guard.noteDue(5.1), guard.noteDue(40)]).toEqual([false, true, false, true, false]);
  expect([guard.pauseDue(5.1), guard.pauseDue(400)]).toEqual([undefined, undefined]);
  // One expensive response past both: one note.
  const jump = new SpendGuard({ noteAt: 1 });
  expect([jump.noteDue(6), jump.noteDue(7)]).toEqual([true, false]);
});

test("the spend note comes once at $1 and the pause at $5, then at each $5 more after Keep going", () => {
  const guard = new SpendGuard({ noteAt: 1, pauseAt: 5 });
  expect([guard.noteDue(0.5), guard.noteDue(1.02), guard.noteDue(2)]).toEqual([false, true, false]);
  // With a pause set, the pause says it at $5, not a second note.
  expect(guard.noteDue(5.02)).toBe(false);
  expect([guard.pauseDue(4.99), guard.pauseDue(5.02)]).toEqual([undefined, 5]);
  guard.keepGoing(5.02);
  expect([guard.pauseDue(9.9), guard.pauseDue(10.1)]).toEqual([undefined, 10]);
  const off = new SpendGuard({});
  expect([off.noteDue(50), off.pauseDue(50)]).toEqual([false, undefined]);
});

test("spend limits work with no setup; the user's config changes or turns them off; a project cannot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-spend-config-"));
  const homeDir = path.join(root, "home"); const projectRoot = path.join(root, "repo");
  await mkdir(path.join(homeDir, ".casper"), { recursive: true }); await mkdir(path.join(projectRoot, ".casper"), { recursive: true });
  const previous = process.env.CASPER_PROFILE;
  try {
    delete process.env.CASPER_PROFILE;
    expect((await loadConfiguration({ projectRoot, homeDir })).spend).toEqual({ noteAt: 1 });
    await writeFile(path.join(homeDir, ".casper/config.yaml"), "spend:\n  noteAt: false\n  pauseAt: 12.5\n");
    const loaded = await loadConfiguration({ projectRoot, homeDir });
    expect(loaded.spend).toEqual({ pauseAt: 12.5 });
    expect(loaded.warnings).toEqual([]);
    await writeFile(path.join(homeDir, ".casper/config.yaml"), "spend:\n  pauseAt: -1\n");
    await expect(loadConfiguration({ projectRoot, homeDir })).rejects.toThrow("spend.pauseAt must be a dollar amount above 0, or false to turn it off");
    await writeFile(path.join(homeDir, ".casper/config.yaml"), "");
    await writeFile(path.join(projectRoot, ".casper/project.yaml"), "spend:\n  pauseAt: 1000\n");
    await expect(loadConfiguration({ projectRoot, homeDir })).rejects.toThrow("spend is a user setting");
  } finally {
    if (previous === undefined) delete process.env.CASPER_PROFILE; else process.env.CASPER_PROFILE = previous;
    await removeTempDir(root);
  }
});

test("a stopped-at-the-limit receipt says so, is incomplete (exit 2) and never says the checks passed", () => {
  const task = { execution: "completed" as const, changedPaths: ["a.ts"], spendLimit: { spent: 5.02, limit: 5 } };
  expect(formatReceipt(task, { surface: "one-shot" })).toStartWith("– Incomplete — stopped at $5.02, the $5 limit for one task (spend.pauseAt); changes so far are kept; casper --continue to go on");
  expect(taskExitCode(undefined, task)).toBe(2);
});

/** A scripted model: each prompt reports `costs` (one response each), then asks before one tool call. */
async function fixture(status: Partial<RuntimeStatus> = {}, costs = [1.2, 3.82]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-spend-"));
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await Promise.all([mkdir(home), mkdir(project)]); await writeFile(path.join(project, "notes.txt"), "not empty\n");
  // The pause is off by default; these tests turn it on at $5, the way a user would in their own config.
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await writeFile(path.join(home, ".casper/config.yaml"), "spend:\n  pauseAt: 5\n");
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
  let start!: RuntimeStartOptions;
  const state = { costs, toolRan: 0, reasons: [] as Array<string | undefined> };
  const runtime: AgentRuntime = {
    async start(options) {
      start = options;
      return {
        getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured", priced: true, ...status }),
        getState: () => ({ cwd: project, isStreaming: false }),
        setTools: () => {},
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {},
        prompt: async () => {
          for (const cost of state.costs) {
            emit({ type: "assistant_response_start", provider: "fixture", model: "demo" });
            if (cost === state.costs[0]) emit({ type: "assistant_text_delta", delta: "Looking around." });
            emit({ type: "assistant_response_end", stopReason: "toolUse", usage: { tokens: 1200, estimatedCost: cost } });
          }
          const reason = await start.beforeToolWait?.("bash");
          state.reasons.push(reason);
          if (!reason) {
            state.toolRan++;
            emit({ type: "tool_start", toolName: "bash", toolCallId: "1", input: { command: "ls" } });
            emit({ type: "tool_end", toolName: "bash", toolCallId: "1", input: { command: "ls" }, isError: false });
          }
          emit({ type: "message_end" });
        },
      };
    },
    async dispose() {},
  };
  const make = (input: PassThrough, output: { write(text: string): void }) => new CasperApp({
    input, output, runtimeFactory: () => runtime, sessionHomeDir: home,
    loadProjectContext: info => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: context => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  return { root, project, state, make, cleanup: () => removeTempDir(root) };
}

test("at about $5 the task pauses on a numbered question, Stop here first; Enter stops and keeps the work", async () => {
  const f = await fixture();
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const app = f.make(input, screen.writer);
  const interactive = app.runInteractive(f.project);
  try {
    await screen.until(output => output.includes("idle"));
    input.write("tidy the notes\r");
    await screen.until(output => output.includes("This task has used $5.02."));
    const shown = Bun.stripANSI(screen.output);
    // The quiet note came first, at about $1, and the footer shows the task's tokens and cost.
    expect(shown).toContain("– This task has used $1.20 so far (1.2k tok).");
    // The note comes after the model's words it followed, not above them.
    expect(shown.indexOf("Looking around.")).toBeGreaterThanOrEqual(0);
    expect(shown.lastIndexOf("Looking around.")).toBeLessThan(shown.lastIndexOf("– This task has used $1.20"));
    expect(shown).toContain("task 2.4k tok · $5.02");
    expect(shown).toMatch(/→ 1 Stop here[^\n]*the work so far is kept/);
    expect(shown).toMatch(/2 Keep going[^\n]*asks again at \$10/);
    input.write("\r");
    await screen.until(output => output.includes("stopped at $5.02"));
    expect(f.state.toolRan).toBe(0);
    expect(f.state.reasons[0]).toMatch(/spend limit/);
    expect(app.getLastTaskResult()?.spendLimit).toEqual({ spent: 5.02, limit: 5 });
    expect(Bun.stripANSI(screen.output).replace(/\s+/g, " ")).toContain("– Incomplete — stopped at $5.02, the $5 limit for one task (spend.pauseAt)");
    // Idle again after the receipt, so the next request is not kept as a draft.
    await screen.until(output => output.lastIndexOf("│ idle") > output.lastIndexOf("stopped at $5.02"));

    // Keep going: the tool runs, and nothing is stopped.
    const before = Bun.stripANSI(screen.output).length;
    input.write("tidy them again\r");
    await screen.until(output => output.slice(before).includes("2 Keep going"));
    input.write("2");
    await screen.until(() => f.state.reasons.length === 2);
    expect(f.state.reasons[1]).toBeUndefined();
    expect(f.state.toolRan).toBe(1);
    // Idle again before /exit, so it is read as a command and not typed into a running task.
    await screen.until(output => output.lastIndexOf("│ idle") > output.lastIndexOf("Keep going"));
  } finally {
    input.write("/exit\r");
    await interactive;
    await app.close();
    await f.cleanup();
  }
});

test("one-shot and --json never wait at the limit: they stop there and the receipt says so", async () => {
  const f = await fixture();
  let output = "";
  const app = f.make(new PassThrough(), { write: (text: string) => { output += text; } });
  try {
    await app.runOnce("tidy the notes", f.project);
    expect(f.state.toolRan).toBe(0);
    expect(output).toContain("[spend] This task has used $5.02. Casper stops here, at the $5 limit for one task; the work so far is kept.");
    expect(output).toContain("– Incomplete — stopped at $5.02, the $5 limit for one task (spend.pauseAt); changes so far are kept; casper --continue to go on");
    expect(app.getLastTaskResult()?.spendLimit).toEqual({ spent: 5.02, limit: 5 });
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("a free model's footer shows the task's tokens and no cost, and never pauses", async () => {
  const f = await fixture({ priced: false }, [0, 0]);
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const app = f.make(input, screen.writer);
  const interactive = app.runInteractive(f.project);
  try {
    await screen.until(output => output.includes("idle"));
    input.write("tidy the notes\r");
    await screen.until(output => output.includes("task 2.4k tok │ idle"));
    expect(f.state.toolRan).toBe(1);
    expect(Bun.stripANSI(screen.output)).not.toContain("This task has used");
    expect(Bun.stripANSI(screen.output)).not.toMatch(/task 2\.4k tok · \$/);
  } finally {
    input.write("/exit\r");
    await interactive;
    await app.close();
    await f.cleanup();
  }
});

test("a subscription is not charged per token: the footer says sub ≈$, and there is no note, no pause and no stop", async () => {
  const f = await fixture({ priced: true, billing: "subscription" });
  let output = "";
  const app = f.make(new PassThrough(), { write: (text: string) => { output += text; } });
  try {
    await app.runOnce("tidy the notes", f.project);
    expect(f.state.toolRan).toBe(1);
    expect(f.state.reasons).toEqual([undefined]);
    expect(output).not.toContain("This task has used");
    expect(output).not.toContain("[spend]");
    expect(app.getLastTaskResult()?.spendLimit).toBeUndefined();
  } finally {
    await app.close();
    await f.cleanup();
  }
});

test("the footer keeps the session total, so a new task never looks like a reset", () => {
  // First task: only the task.
  expect(formatFooterSpend({ tokens: 48_213, cost: 0.314 }, { tokens: 48_213, cost: 0.314 }, true, true)).toBe("task 48.2k tok · $0.31");
  // A later task while it works: this task's tokens, then the session's tokens and cost.
  expect(formatFooterSpend({ tokens: 40_000, cost: 0.01 }, { tokens: 1_100_000, cost: 0.04 }, true, true)).toBe("task 40k tok · session 1.1M tok · $0.04");
  // Idle: the session only.
  expect(formatFooterSpend({ tokens: 40_000, cost: 0.01 }, { tokens: 1_100_000, cost: 0.04 }, false, true)).toBe("session 1.1M tok · $0.04");
  // A free model: tokens only; a subscription: what they would cost.
  expect(formatFooterSpend({ tokens: 40_000, cost: 0 }, { tokens: 90_000, cost: 0 }, false, false)).toBe("session 90k tok");
  expect(formatFooterSpend({ tokens: 40_000, cost: 0.01 }, { tokens: 90_000, cost: 0.31 }, false, true, "subscription")).toBe("session 90k tok · sub ≈$0.31");
  // Nothing spent yet: nothing to show.
  expect(formatFooterSpend({ tokens: 0, cost: 0 }, { tokens: 0, cost: 0 }, false, true)).toBe("");
});
