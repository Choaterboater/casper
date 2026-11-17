import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CasperApp } from "../src/app";
import { watchSessionSlowMoments } from "../src/app/command-loop";
import { RuntimeEventView } from "../src/app/events";
import { LifecycleRegistry } from "../src/app/lifecycle";
import { checkSlowMoments, type DoctorContext } from "../src/doctor/checks";
import {
  ASLEEP_MS, noteSlowMoment, readSlowMoments, recentSlowMoments, slowLogPath, TICK_MS, watchSlowMoments, type SlowMoment,
} from "../src/platform/slow-moments";
import type { InteractiveTerminal } from "../src/tui/terminal";
import { removeTempDir } from "./support/temp-dir";

const temps: string[] = [];
afterEach(async () => { for (const dir of temps.splice(0)) await removeTempDir(dir); });

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-slow-"));
  temps.push(dir);
  return dir;
}

/** A watch driven by hand: `late(ms)` moves the clock one tick plus `ms` and fires the timer. */
function driven(dir: string, extra: { enabled?: () => boolean; activity?: () => string | undefined } = {}) {
  let now = 0;
  let tick: (() => void) | undefined;
  let stopped = false;
  const watch = watchSlowMoments({
    home: dir, monotonic: () => now, clock: () => Date.UTC(2026, 10, 17, 12, 0, 0) + now, rss: () => 123_456_789,
    every: (ms, fn) => { expect(ms).toBe(TICK_MS); tick = fn; return { stop: () => { stopped = true; } }; },
    ...extra,
  });
  return {
    watch, stopped: () => stopped,
    late: async (ms: number) => { now += TICK_MS + ms; tick!(); await watch.settled(); },
  };
}

test("a 250 ms timer 2 s or more late is one line in ~/.casper/run/slow.log, 0600 in a 0700 folder; a timer on time notes nothing", async () => {
  const dir = await home();
  let activity: string | undefined;
  const run = driven(dir, { activity: () => activity });
  await run.late(5);
  await run.late(1_999);
  expect(await readFile(slowLogPath(dir), "utf8").catch(() => "none")).toBe("none");
  activity = "running   a command\n";
  await run.late(6_080.4);
  activity = undefined;
  await run.late(2_000);
  const lines = (await readFile(slowLogPath(dir), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SlowMoment);
  expect(lines).toEqual([
    { time: "2026-11-17T12:00:08.834Z", ms: 6080, rss: 123_456_789, activity: "running a command" },
    { time: "2026-11-17T12:00:11.084Z", ms: 2000, rss: 123_456_789 },
  ]);
  if (process.platform !== "win32") {
    expect((await stat(slowLogPath(dir))).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(slowLogPath(dir)))).mode & 0o777).toBe(0o700);
  }
  await run.watch.stop();
  expect(run.stopped()).toBe(true);
});

test("off in /settings notes nothing from that moment; a computer that slept is not a slow moment; a stopped watch notes nothing", async () => {
  const dir = await home();
  let on = false;
  const run = driven(dir, { enabled: () => on });
  await run.late(5_000);
  await run.late(ASLEEP_MS);
  on = true;
  await run.late(ASLEEP_MS + 1);
  expect(await readSlowMoments(dir)).toEqual([]);
  await run.late(3_000);
  expect((await readSlowMoments(dir)).map((moment) => moment.ms)).toEqual([3000]);
  await run.watch.stop();
  await run.late(9_000);
  expect((await readSlowMoments(dir)).map((moment) => moment.ms)).toEqual([3000]);
});

test("past its size the log drops its older half and keeps whole lines, the newest last", async () => {
  const dir = await home();
  const max = 2_000;
  for (let index = 0; index < 60; index++) {
    await noteSlowMoment(dir, { time: new Date(Date.UTC(2026, 10, 17, 0, index)).toISOString(), ms: 2_000 + index, rss: 1, activity: "running checks" }, max);
  }
  const text = await readFile(slowLogPath(dir), "utf8");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(max);
  expect(Buffer.byteLength(text)).toBeGreaterThan(max / 4);
  const moments = await readSlowMoments(dir);
  expect(text.split("\n").filter(Boolean).length).toBe(moments.length);
  expect(moments.at(-1)!.ms).toBe(2_059);
  expect(moments[0]!.ms).toBeGreaterThan(2_000);
  if (process.platform !== "win32") expect((await stat(slowLogPath(dir))).mode & 0o777).toBe(0o600);
});

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

function doctor(homeDir: string): DoctorContext {
  return { homeDir, env: {}, platform: process.platform, currentVersion: "0.0.0", install: { kind: "binary", executable: path.join(homeDir, "casper") },
    agentDir: path.join(homeDir, ".casper", "agent"), now: () => NOW };
}

test("/doctor: none in the last day; else how many, the longest and what ran; older ones and torn lines don't count", async () => {
  const dir = await home();
  expect(await checkSlowMoments(doctor(dir), undefined)).toEqual([{ status: "ok", text: "Slow moments: none in the last day" }]);
  expect(await checkSlowMoments(doctor(dir), { slowMoments: false })).toEqual([{ status: "ok", text: "Slow moments: not noted (off in /settings)" }]);
  await mkdir(path.dirname(slowLogPath(dir)), { recursive: true });
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
  await writeFile(slowLogPath(dir), [
    JSON.stringify({ time: at(30), ms: 60_000, rss: 1, activity: "the model replied" }),
    JSON.stringify({ time: at(5), ms: 2_400, rss: 1 }),
    "{\"time\": \"torn",
    JSON.stringify({ time: at(2), ms: 6_080, rss: 1, activity: "running a command" }),
    JSON.stringify({ time: at(1), ms: 3_000, rss: 1 }),
    "",
  ].join("\n"));
  expect(await recentSlowMoments(dir, NOW)).toMatchObject({ count: 3, longest: { ms: 6_080 } });
  expect(await checkSlowMoments(doctor(dir), undefined)).toEqual([{ status: "note", text: "Slow moments: 3 in the last day (longest 6.1 s, while running a command)",
    next: "Log: ~/.casper/run/slow.log" }]);
});

test("what ran, in a few words: the kind of step and its tool, never its input; nothing when idle", () => {
  const terminal = { rich: true, columns: 100, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {}, setWork() {}, write() {}, writeFold() {} };
  const events = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write() {} }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
    projectRoot: () => "/work/app", display: () => "normal" });
  try {
    expect(events.slowActivity()).toBeUndefined();
    events.handle({ type: "tool_start", toolName: "bash", toolCallId: "1", input: { command: "curl -H 'token: secret' example.test" } });
    expect(events.slowActivity()).toBe("running a command");
    events.handle({ type: "tool_start", toolName: "grep", toolCallId: "2", input: { pattern: "x" } });
    expect(events.slowActivity()).toBe("reading files (grep)");
    const run = events.watchCheck("tests");
    events.handle({ type: "tool_end", toolName: "grep", toolCallId: "2", isError: false });
    events.handle({ type: "tool_end", toolName: "bash", toolCallId: "1", isError: false });
    expect(events.slowActivity()).toBe("running checks");
    run?.end();
  } finally { events.reset(); }
});

test("the session's watch: what ran comes from the work view, off notes nothing, it writes under the session's home, and closing Casper stops it", async () => {
  const dir = await home();
  let now = 0, tick: (() => void) | undefined, stopped = false;
  let activity: string | undefined;
  const app = { sessionHomeDir: dir, projectContext: { slowMoments: true }, commandActive: false,
    events: { slowActivity: () => activity }, lifecycle: new LifecycleRegistry() };
  watchSessionSlowMoments(app as unknown as CasperApp, {
    monotonic: () => now, clock: () => NOW + now, rss: () => 1,
    every: (ms, fn) => { expect(ms).toBe(TICK_MS); tick = fn; return { stop: () => { stopped = true; } }; },
  });
  const late = (ms: number) => { now += TICK_MS + ms; tick!(); };
  late(2_100);
  app.commandActive = true;
  late(2_200);
  activity = "running a command";
  late(2_300);
  app.projectContext.slowMoments = false;
  late(2_400);
  app.projectContext.slowMoments = true;
  await app.lifecycle.close("slow-moments");
  expect(stopped).toBe(true);
  late(2_500);
  expect((await readSlowMoments(dir)).map(({ ms, activity }) => [ms, activity])).toEqual([
    [2_100, undefined], [2_200, "a task ran"], [2_300, "running a command"],
  ]);
});
