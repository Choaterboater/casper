import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CasperApp } from "../src/app";
import { AwayJob, type WalkAwaySeams } from "../src/app/away";
import { jobRowItems, jobState } from "../src/app/jobs";
import { jobsDirectory, readJob, writeJobSync, type JobRecord } from "../src/jobs/store";
import { resetHangUpForTests } from "../src/platform/hang-up";
import { loadProjectContext } from "../src/project/context";
import { clockTime, planLimitError } from "../src/runtime/plan-limits";
import type { AgentRuntime, RuntimeEventListener } from "../src/runtime/types";
import { SkillRegistry } from "../src/skills/registry";
import { PLAN_RESET_PROMPT, planReset, planWaitLine, RESET_GRACE_MS, sameFiles, waitUntil as waitForReset, type ResetClock } from "../src/task/plan-reset";
import { removeTempDir } from "./support/temp-dir";
import { waitUntil } from "./support/wait";

/**
 * A task stopped on a used-up Claude plan window, and nothing else could take it on. When the window resets within a
 * day, Casper waits for it and sends the AI on by itself, as one of keep going's rounds; a typed line, Esc, a change in
 * the folder or another model cancels it, and a weekly reset is only named.
 */
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => removeTempDir(root))); });

const HOUR = 3_600_000;

/** A clock the test moves by hand: a timer fires when the time passes its mark. */
function handClock(start = Date.now()) {
  let now = start;
  const timers = new Set<{ at: number; run: () => void; unref: () => void; unrefs: number }>();
  const clock: ResetClock & { advance(ms: number): void; armed(): number; unrefs(): number } = {
    now: () => now,
    setTimeout(run, ms) { const timer = { at: now + ms, run, unrefs: 0, unref() { timer.unrefs++; } }; timers.add(timer); return timer; },
    clearTimeout(handle) { timers.delete(handle as never); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.run();
      }
      now = until;
    },
    armed: () => timers.size,
    unrefs: () => [...timers].reduce((sum, timer) => sum + timer.unrefs, 0),
  };
  return clock;
}

/** A clock whose every timer fires at once (the time jumps to it): a wait of hours takes no real time. */
function jumpingClock(start = Date.now()): ResetClock {
  let now = start;
  return { now: () => now, setTimeout: (run, ms) => { queueMicrotask(() => { now += ms; run(); }); return undefined; }, clearTimeout: () => {} };
}

test("a reset within a day is waited for; one further away, or past, isn't", () => {
  const now = Date.UTC(2026, 10, 16, 12);
  const error = (at: number) => `Claude subscription request failed: You've hit your limit ${planLimitError({ window: "five_hour", resetsAt: at })}`;
  expect(planReset(error(now + 2 * HOUR), now)).toEqual({ window: "five_hour", resetsAt: now + 2 * HOUR, wait: true });
  expect(planReset(error(now + 3 * 24 * HOUR), now)?.wait).toBe(false);
  expect(planReset(error(now - 1), now)).toBeUndefined();
  expect(planReset("429 rate limit exceeded", now)).toBeUndefined();
  // The time in this computer's own zone, as clockTime writes it: a weekday only when the reset falls on another day there.
  expect(planWaitLine({ window: "five_hour", resetsAt: now + 2 * HOUR }, true, now))
    .toBe(`Claude's 5-hour limit resets at ${clockTime(now + 2 * HOUR, now)}; Casper goes on then. Type anything or press Esc to cancel.`);
  expect(planWaitLine({ window: "five_hour", resetsAt: now + 2 * HOUR }, false, now)).toEndWith("Type anything to cancel.");
});

test("the wait ends at the reset on the wall clock, never before, and a cancel or abort ends it at once", async () => {
  const clock = handClock();
  const at = clock.now() + 5 * HOUR;
  const wait = waitForReset(at, { clock });
  let done: boolean | undefined;
  void wait.done.then((value) => { done = value; });
  // It wakes at least every minute; its timer never keeps Casper running on its own.
  expect(clock.armed()).toBe(1);
  expect(clock.unrefs()).toBe(1);
  clock.advance(5 * HOUR - 1);
  await Bun.sleep(0);
  expect(done).toBeUndefined();
  clock.advance(1);
  expect(await wait.done).toBe(true);
  expect(clock.armed()).toBe(0);

  const cancelled = waitForReset(clock.now() + HOUR, { clock });
  cancelled.cancel();
  expect(await cancelled.done).toBe(false);
  expect(clock.armed()).toBe(0);
  const controller = new AbortController();
  const aborted = waitForReset(clock.now() + HOUR, { clock, signal: controller.signal });
  controller.abort();
  expect(await aborted.done).toBe(false);
  expect(clock.armed()).toBe(0);
});

test("two listings of the folder are the same only with the same files", () => {
  expect(sameFiles(new Map([["a", "1"]]), new Map([["a", "1"]]))).toBe(true);
  expect(sameFiles(new Map([["a", "1"]]), new Map([["a", "2"]]))).toBe(false);
  expect(sameFiles(new Map([["a", "1"]]), new Map([["a", "1"], ["b", "1"]]))).toBe(false);
  expect(sameFiles(new Map([["a", "1"]]), undefined)).toBe(false);
});

interface Reply { files?: Record<string, string>; text?: string; error?: string; hold?: Promise<void> }

async function session(replies: Reply[], options: { config?: string; provider?: string; clock?: ResetClock; walkAway?: WalkAwaySeams } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-plan-reset-")); roots.push(root);
  const home = path.join(root, "home"), project = path.join(root, "project");
  await mkdir(path.join(home, ".casper"), { recursive: true }); await mkdir(project, { recursive: true });
  if (options.config) await writeFile(path.join(home, ".casper", "config.yaml"), options.config);
  await writeFile(path.join(project, "notes.py"), "print('one')\n");
  const prompts: string[] = [];
  const listeners = new Set<RuntimeEventListener>();
  const emit = (event: Parameters<RuntimeEventListener>[0]) => { for (const listener of listeners) listener(event); };
  const provider = options.provider ?? "claude-subscription";
  const runtime: AgentRuntime = {
    async start() {
      return {
        getStatus: () => ({ provider, model: "claude-sonnet-5", auth: "configured" }),
        getState: () => ({ cwd: project, isStreaming: false }),
        subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => listeners.delete(listener); },
        abort: async () => {}, setTools: () => {},
        prompt: async (text: string) => {
          prompts.push(text);
          const reply = replies.shift() ?? { text: "No reply was scripted for this prompt." };
          await reply.hold;
          emit({ type: "assistant_response_start", provider, model: "claude-sonnet-5" });
          if (reply.files) {
            const toolCallId = `edit-${prompts.length}`;
            emit({ type: "tool_start", toolName: "fixture_edit", toolCallId });
            for (const [file, body] of Object.entries(reply.files)) await writeFile(path.join(project, file), body);
            emit({ type: "tool_end", toolName: "fixture_edit", toolCallId, isError: false });
          }
          if (reply.error) { emit({ type: "error", message: reply.error }); return; }
          emit({ type: "assistant_text_delta", delta: reply.text ?? "" });
          emit({ type: "assistant_response_end", stopReason: "stop" });
        },
      };
    },
    async dispose() {},
  };
  // A person at a terminal: lines typed during the task reach Casper as they come.
  const input = Object.assign(new PassThrough(), { isTTY: true });
  let output = "";
  const app = new CasperApp({
    input, output: { write: (text: string) => { output += text; } }, runtimeFactory: () => runtime, sessionHomeDir: home,
    ...(options.clock ? { planResetClock: options.clock } : {}), ...(options.walkAway ? { walkAway: options.walkAway } : {}),
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const running = app.runInteractive(project);
  const idle = async (from: number) => { expect(await waitUntil(() => /\n> $/.test(output.slice(from)), 25_000)).toBe(true); return output.slice(from); };
  const send = async (line: string) => { const from = output.length; input.write(`${line}\n`); return idle(from); };
  return { app, project, prompts, input, idle, output: () => output, send, close: async () => { input.end(); await running; await app.close(); } };
}

const limitError = (at: number) => `Claude subscription request failed: You've hit your limit · resets 3:40pm ${planLimitError({ window: "five_hour", resetsAt: at })}`;

test("a task stopped on the 5-hour limit waits for its reset, then the AI carries on as keep going's first round", async () => {
  const clock = jumpingClock();
  const s = await session([
    { files: { "notes.py": "print('two')\n" }, error: limitError(clock.now() + 2 * HOUR) },
    { files: { "README.md": "Prints two.\n" }, text: "Updated the README too." },
  ], { clock });
  try {
    const out = await s.send("change the greeting in notes.py and say so in the README");
    expect(s.prompts).toHaveLength(2);
    expect(s.prompts[1]).toBe(PLAN_RESET_PROMPT);
    expect(out).toMatch(/Claude's 5-hour limit resets at [^;]+; Casper goes on then\. Type anything to cancel\./);
    expect(out).toContain("↻ keep going 1/2: Claude's 5-hour limit reset, so the AI carries on (Esc stops it)");
    expect(out).toContain("Show diff");
  } finally { await s.close(); }
}, 60_000);

test("it goes on once a task: a second stop on the limit after the resumed turn ends the task", async () => {
  const clock = jumpingClock();
  const s = await session([
    { error: limitError(clock.now() + HOUR) },
    { error: limitError(clock.now() + 3 * HOUR) },
  ], { clock });
  try {
    const out = await s.send("change the greeting in notes.py");
    expect(s.prompts).toHaveLength(2);
    expect(out.match(/Casper goes on then/g)).toHaveLength(1);
  } finally { await s.close(); }
}, 60_000);

test("keep_going off, another model, or a weekly reset: nothing waits", async () => {
  const off = await session([{ error: limitError(Date.now() + HOUR) }], { config: "keep_going: off\n", clock: jumpingClock() });
  try {
    const out = await off.send("change the greeting in notes.py");
    expect(off.prompts).toHaveLength(1);
    expect(out).not.toContain("Casper goes on then");
  } finally { await off.close(); }
  // A failover model the task switched to never gets the resumed turn.
  const other = await session([{ error: limitError(Date.now() + HOUR) }], { provider: "openrouter", clock: jumpingClock() });
  try {
    const out = await other.send("change the greeting in notes.py");
    expect(other.prompts).toHaveLength(1);
    expect(out).not.toContain("Casper goes on then");
  } finally { await other.close(); }
  const weekly = await session([{ error: limitError(Date.now() + 3 * 24 * HOUR).replace("five_hour", "seven_day") }], { clock: jumpingClock() });
  try {
    const out = await weekly.send("change the greeting in notes.py");
    expect(weekly.prompts).toHaveLength(1);
    expect(out).toContain("Claude's weekly limit resets at");
    expect(out).toContain("more than a day away, so Casper doesn't wait for it.");
    expect(out).not.toContain("Casper goes on then");
  } finally { await weekly.close(); }
}, 60_000);

test("a line typed while it waits cancels the wait, and runs as the next request", async () => {
  const clock = handClock();
  const s = await session([{ error: limitError(clock.now() + 2 * HOUR) }, { text: "Looked at it." }], { clock });
  try {
    const from = s.output().length;
    s.input.write("change the greeting in notes.py\n");
    expect(await waitUntil(() => s.output().includes("Casper goes on then"), 25_000)).toBe(true);
    expect(s.app.planWait?.why).toMatch(/^the Claude plan's 5-hour limit resets at /);
    s.input.write("what does notes.py print\n");
    expect(await waitUntil(() => s.prompts.length === 2, 25_000)).toBe(true);
    const out = await s.idle(from);
    expect(out).toContain("Cancelled: Casper doesn't go on by itself.");
    expect(s.prompts[1]).toContain("what does notes.py print");
    expect(s.prompts).not.toContain(PLAN_RESET_PROMPT);
    expect(s.app.planWait).toBeUndefined();
    expect(clock.armed()).toBe(0);
  } finally { await s.close(); }
}, 60_000);

test("a line typed after the stop, before the wait is said, cancels it too, and runs as the next request", async () => {
  const clock = handClock();
  const s = await session([{ error: limitError(clock.now() + 2 * HOUR) }, { text: "Reverted." }], { clock });
  try {
    // Hold the listing of the folder Casper takes at the stop, so the line is typed before the wait is said.
    let held: (() => void) | undefined;
    const snapshot = s.app.snapshotWorkspace.bind(s.app);
    s.app.snapshotWorkspace = async (...args: Parameters<typeof snapshot>) => {
      if (s.app.taskRuntimeFailed && !held) await new Promise<void>((resume) => { held = resume; });
      return snapshot(...args);
    };
    const from = s.output().length;
    s.input.write("change the greeting in notes.py\n");
    expect(await waitUntil(() => held !== undefined, 25_000)).toBe(true);
    s.input.write("never mind, revert that\n");
    expect(await waitUntil(() => s.output().includes("queued"), 25_000)).toBe(true);
    held!();
    expect(await waitUntil(() => s.prompts.length === 2, 25_000)).toBe(true);
    const out = await s.idle(from);
    expect(out).not.toContain("Casper goes on then");
    expect(s.prompts[1]).toContain("never mind, revert that");
    expect(s.prompts).not.toContain(PLAN_RESET_PROMPT);
    expect(s.app.planWait).toBeUndefined();
    expect(clock.armed()).toBe(0);
  } finally { await s.close(); }
}, 60_000);

test("a file changed while it waits: the AI doesn't go on by itself", async () => {
  const clock = handClock();
  const s = await session([{ error: limitError(clock.now() + 2 * HOUR) }], { clock });
  try {
    const from = s.output().length;
    s.input.write("change the greeting in notes.py\n");
    expect(await waitUntil(() => s.output().includes("Casper goes on then"), 25_000)).toBe(true);
    await writeFile(path.join(s.project, "notes.py"), "print('edited by hand')\n");
    clock.advance(2 * HOUR + RESET_GRACE_MS);
    const out = await s.idle(from);
    expect(out).toContain("Files in this folder changed while Casper waited, so it doesn't go on by itself.");
    expect(s.prompts).toHaveLength(1);
  } finally { await s.close(); }
}, 60_000);

function record(over: Partial<JobRecord> = {}): JobRecord {
  return { version: 1, id: "a1b2c3d4e5f6", pid: process.pid, root: "/work/app", folder: "app", request: "fix the VLAN script",
    leftAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", status: "running", ...over };
}

test("in a walk-away job the wait is recorded as waiting, with why, and nothing to answer; then it works again", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-plan-reset-job-")); roots.push(home);
  const state = path.join(home, ".casper", "projects", "app-0123456789abcdef");
  const dir = jobsDirectory(state);
  writeJobSync(dir, record());
  const lines: string[] = [];
  const app = { output: { write: (text: string) => { lines.push(text); } }, projectContext: { notifications: false, stateDirectory: state }, closing: false,
    getLastTaskResult: () => undefined, lastAnswer: "", homeDir: () => home } as unknown as CasperApp;
  const job = new AwayJob(app, dir, record(), () => {}, { notify: async () => true });
  job.start();
  await job.waitFor("the Claude plan's 5-hour limit resets at 3:40 PM");
  const waiting = await readJob(dir, record().id);
  expect(waiting).toMatchObject({ status: "waiting", why: "the Claude plan's 5-hour limit resets at 3:40 PM" });
  expect(waiting?.question).toBeUndefined();
  expect(jobState(waiting!)).toBe("waiting till the Claude plan's 5-hour limit resets at 3:40 PM");
  // Nothing for you to answer: the start's row says it is working here.
  expect((await jobRowItems(app)).map((item) => item.label)).toEqual(["Job working here"]);
  await job.waitOver();
  const working = await readJob(dir, record().id);
  expect(working?.status).toBe("running");
  expect(working?.why).toBeUndefined();
  await job.finish();
  expect((await readJob(dir, record().id))).toMatchObject({ status: "done" });
  expect((await readJob(dir, record().id))?.why).toBeUndefined();
});

test("a terminal that closes during the wait leaves a job that waits, works again at the reset, and goes on", async () => {
  const clock = handClock();
  // Closing the terminal quiets the process's own streams: the listeners it adds are taken off again after.
  const streams = [process.stdout, process.stderr, process.stdin];
  const listeners = streams.map((stream) => stream.listeners("error"));
  const { promise: hold, resolve: release } = Promise.withResolvers<void>();
  const s = await session([{ error: limitError(clock.now() + 2 * HOUR) }, { text: "Carried on.", hold }],
    { clock, walkAway: { platform: "linux", notify: async () => true } });
  try {
    s.input.write("change the greeting in notes.py\n");
    expect(await waitUntil(() => s.output().includes("Casper goes on then"), 25_000)).toBe(true);
    expect(s.app.hangUp()).toBe(true);
    const dir = jobsDirectory(s.app.projectContext!.stateDirectory);
    const job = async () => {
      const id = (await readdir(dir).catch(() => [] as string[])).map((name) => /^([0-9a-f]{12})\.json$/.exec(name)?.[1]).find(Boolean);
      return id ? readJob(dir, id) : undefined;
    };
    expect(await waitUntil(async () => (await job())?.status === "waiting", 25_000)).toBe(true);
    expect((await job())?.why).toMatch(/^the Claude plan's 5-hour limit resets at /);
    expect((await job())?.question).toBeUndefined();
    clock.advance(2 * HOUR + RESET_GRACE_MS);
    expect(await waitUntil(() => s.prompts.length === 2, 25_000)).toBe(true);
    expect(s.prompts[1]).toBe(PLAN_RESET_PROMPT);
    // Back at work while the resumed turn runs, then done once it ends.
    expect(await job()).toMatchObject({ status: "running" });
    expect((await job())?.why).toBeUndefined();
    release();
    expect(await waitUntil(async () => (await job())?.status === "done", 25_000)).toBe(true);
    expect((await job())?.why).toBeUndefined();
  } finally {
    release();
    await s.close();
    resetHangUpForTests();
    streams.forEach((stream, index) => { for (const listener of stream.listeners("error")) if (!listeners[index]!.includes(listener)) stream.off("error", listener as never); });
  }
}, 60_000);
