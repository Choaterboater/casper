import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { PLAIN_CHECK_EVERY_MS, RuntimeEventView } from "../src/app/events";
import { runCommandCheck } from "../src/verify/command";
import { PROGRESS_TAIL_CHARS, ProgressFeed, type CheckProgressRun } from "../src/verify/progress";
import type { RuntimeEvent } from "../src/runtime/types";
import type { WorkView } from "../src/tui/surface";
import { InteractiveTerminal } from "../src/tui/terminal";
import { tint } from "../src/tui/format";
import { PassThrough } from "node:stream";
import type { DisplayLevel } from "../src/tui/display";

let clock = 1000;
const nowSpy = spyOn(performance, "now").mockImplementation(() => clock);
type Tick = { fn: () => void; every: number; live: boolean };
let ticks: Tick[] = [];
const realSet = globalThis.setInterval;
const realClear = globalThis.clearInterval;
const open: RuntimeEventView[] = [];

beforeEach(() => {
  ticks = [];
  globalThis.setInterval = ((fn: () => void, every: number) => {
    const tick = { fn, every, live: true };
    ticks.push(tick);
    return Object.assign(tick, { unref() { return tick; } });
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((handle: Tick) => { if (handle) handle.live = false; }) as unknown as typeof clearInterval;
});
afterEach(() => {
  for (const events of open.splice(0)) events.reset();
  globalThis.setInterval = realSet; globalThis.clearInterval = realClear; clock = 1000;
});
afterAll(() => nowSpy.mockRestore());

function view(options: { rich?: boolean; level?: DisplayLevel; announce?: boolean } = {}) {
  const rich = options.rich ?? true;
  const boxes: Array<string[] | undefined> = [];
  const written: string[] = [];
  const terminal = { rich, columns: 100, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {},
    // The live rows, then the status row's words, as one list.
    setWork(view?: WorkView) { boxes.push(view ? [...view.rows, ...(view.status ? [view.status] : [])] : undefined); },
    write(value: string) { written.push(value); }, writeFold() {} };
  const events = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write: value => terminal.write(value) }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
    projectRoot: () => "/work/app", display: () => options.level ?? "normal",
    ...(options.announce === undefined ? {} : { announceLongChecks: () => options.announce! }) });
  open.push(events);
  return { events, boxes, written, last: () => boxes.at(-1), handle: (...list: RuntimeEvent[]) => { for (const event of list) events.handle(event); },
    tick: () => { for (const t of ticks.filter(x => x.live && x.every === 1000)) t.fn(); } };
}

test("a running check gets its row after 10 seconds, not before, with its last output line under it; the status row names it at once", () => {
  const s = view();
  const run = s.events.watchCheck("test")!;
  run.update("collecting\ntests/a.test.ts ok\n");
  expect(s.last()).toEqual(["Checking test · 0s"]);
  clock += 9_999;
  s.tick();
  expect(s.last()).toEqual(["Checking test · 9s"]);
  clock += 1;
  s.tick();
  expect(s.last()).toEqual(["• test · 10s", "↳ tests/a.test.ts ok", "Checking test · 10s"]);
  clock += 3 * 60_000;
  run.update("still going \u001b[31mred\u001b[0m\u0007 token=sk-or-v1-abcdef0123456789abcdef0123456789\n\n");
  const lines = s.last()!;
  expect(lines[0]).toBe("• test · 3m10s");
  expect(lines[1]).toStartWith("↳ still going red");
  expect(lines[1]).not.toMatch(/[\u001b\u0007]|abcdef0123456789abcdef/);
});

test("the line is removed when the check ends, and the tick timer stops", () => {
  const s = view();
  const run = s.events.watchCheck("lint")!;
  clock += 20_000;
  s.tick();
  expect(s.last()![0]).toBe("• lint · 20s");
  expect(ticks.some(t => t.live)).toBe(true);
  run.end();
  expect(s.last()).toBeUndefined();
  expect(ticks.every(t => !t.live)).toBe(true);
});

test("extra verification runs take the label they are given", () => {
  const s = view();
  s.events.labelChecks("tests fail without the change");
  s.events.watchCheck("test");
  clock += 12_000;
  s.tick();
  expect(s.last()![0]).toBe("• tests fail without the change · 12s");
});

test("at /details quiet a check shows nothing", () => {
  const s = view({ level: "quiet" });
  expect(s.events.watchCheck("test")).toBeUndefined();
  clock += 60_000;
  s.tick();
  expect(s.boxes.filter(Boolean)).toEqual([]);
});

test("a plain terminal prints one line a minute for a long check; --json prints nothing", () => {
  const s = view({ rich: false });
  const run = s.events.watchCheck("test")!;
  const minute = ticks.find(t => t.every === PLAIN_CHECK_EVERY_MS)!;
  expect(s.written).toEqual([]);
  minute.fn(); minute.fn(); minute.fn();
  expect(s.written.join("")).toBe("[checks] test still running · 1m\n[checks] test still running · 2m\n[checks] test still running · 3m\n");
  run.end();
  expect(minute.live).toBe(false);
  expect(s.boxes).toEqual([]);
  const json = view({ rich: false, announce: false });
  expect(json.events.watchCheck("test")).toBeUndefined();
  expect(ticks.filter(t => t.every === PLAIN_CHECK_EVERY_MS && t.live)).toEqual([]);
});

test("the plain-terminal minute line waits while a numbered question is open", () => {
  const s = view({ rich: false });
  s.events.watchCheck("test");
  const minute = ticks.find(t => t.every === PLAIN_CHECK_EVERY_MS)!;
  const terminal = (s.events as unknown as { terminal: { questionOpen: boolean } }).terminal;
  terminal.questionOpen = true;
  minute.fn();
  expect(s.written).toEqual([]);
  terminal.questionOpen = false;
  minute.fn();
  expect(s.written.join("")).toContain("[checks] test still running");
});

const begin: RuntimeEvent = { type: "assistant_response_start", provider: "openrouter", model: "kimi-k2" };

test("silence of 10 seconds says what Casper waits for; text clears it and the timer stops", () => {
  const s = view();
  s.handle(begin);
  clock += 9_000;
  s.tick();
  expect(s.last()).toEqual(["Waiting for openrouter/kimi-k2 · 9s"]);
  clock += 5_000;
  s.tick();
  expect(s.last()).toEqual(["Waiting for openrouter/kimi-k2 · 14s"]);
  s.handle({ type: "assistant_text_delta", delta: "Hi" });
  expect(s.last()).toBeUndefined();
  expect(ticks.every(t => !t.live)).toBe(true);
});

test("a reasoning box that goes quiet turns into the waiting line, counted from the last word", () => {
  const s = view();
  s.handle(begin, { type: "assistant_progress", kind: "thinking", chars: 0 } as RuntimeEvent);
  clock += 4_000;
  s.tick();
  expect(s.last()![0]).toStartWith("Reasoning · 4s");
  clock += 11_000;
  s.tick();
  expect(s.last()).toEqual(["Waiting for openrouter/kimi-k2 · 15s"]);
});

test("a provider retry is said once, by its line; the box doesn't repeat it", () => {
  const s = view();
  s.handle(begin, { type: "retry", provider: "openrouter", attempt: 2, maxAttempts: 3, delayMs: 2000 } as RuntimeEvent);
  expect(s.last()).toBeUndefined();
  expect(s.written.join("")).toContain("– Can't reach openrouter · trying again in 2s (2 of 3)");
});

test("the box says what Casper waits for as soon as the request goes out, before the provider answers at all", () => {
  const s = view();
  // A provider that holds the request: no response has started yet (live: 13 s with no box at all).
  s.handle({ type: "assistant_request_start", provider: "openrouter", model: "kimi-k2" });
  expect(s.last()).toEqual(["Waiting for openrouter/kimi-k2 · 0s"]);
  clock += 13_000;
  s.tick();
  expect(s.last()).toEqual(["Waiting for openrouter/kimi-k2 · 13s"]);
  // The answer starts: the same wait goes on, so the time keeps counting from the request.
  s.handle(begin);
  clock += 1_000;
  s.tick();
  expect(s.last()).toEqual(["Waiting for openrouter/kimi-k2 · 14s"]);
});

test("the retry line is drawn in the warning colour, not dim like a running line", () => {
  const ambient = { term: process.env.TERM, noColor: process.env.NO_COLOR };
  process.env.TERM = "xterm-256color"; delete process.env.NO_COLOR;
  let screen = "";
  try {
    // Input that is not a TTY: the plain terminal, still coloured because the output is one.
    const terminal = new InteractiveTerminal(new PassThrough(), { isTTY: true, columns: 80, write: (text: string) => { screen += text; return true; } } as never, () => {}, () => {});
    terminal.write("– Can't reach openrouter · trying again in 2s (2 of 3)\n");
    terminal.write("• bash · bun test\n");
    expect(screen).toContain(tint("– Can't reach openrouter · trying again in 2s (2 of 3)", "warning", true));
    expect(screen).toContain(tint("• bash · bun test", "muted", true));
  } finally {
    if (ambient.term === undefined) delete process.env.TERM; else process.env.TERM = ambient.term;
    if (ambient.noColor !== undefined) process.env.NO_COLOR = ambient.noColor;
  }
});

const script = "process.stdout.write('one\\ntwo\\n'); process.stderr.write('warn\\n'); process.stdout.write('x'.repeat(20000) + '\\n'); setTimeout(() => { process.stdout.write('last line\\n'); process.exit(3); }, 700)";
const argv = [process.execPath, "-e", script];
const same = (r: Awaited<ReturnType<typeof runCommandCheck>>) => ({ ...r, durationMs: 0 });

test("a progress callback never changes the check's result or collected output", async () => {
  const base = { name: "test" as const, argv, cwd: process.cwd(), timeoutMs: 30_000, sandbox: false as const };
  const plain = await runCommandCheck(base);
  const seen: string[] = []; let ended = 0; let started = 0;
  const watched = await runCommandCheck({ ...base, progress: () => { started++; return { update: tail => seen.push(tail), end: () => { ended++; } }; } });
  const broken = await runCommandCheck({ ...base, progress: () => ({ update() { throw new Error("boom"); }, end() { throw new Error("boom"); } }) });
  expect(same(watched)).toEqual(same(plain));
  expect(same(broken)).toEqual(same(plain));
  expect(plain.exitCode).toBe(3);
  expect(plain.truncated).toBe(true);
  expect([started, ended]).toEqual([1, 1]);
  expect(seen.at(-1)!.length).toBeLessThanOrEqual(PROGRESS_TAIL_CHARS);
  expect(seen.at(-1)).toContain("last line");
});

test("the feed keeps a bounded tail and tells a sink at most twice a second", () => {
  let now = 0;
  const heard: string[] = [];
  const run: CheckProgressRun = { update: tail => heard.push(tail), end() {} };
  const feed = new ProgressFeed(() => run, "test", () => now);
  feed.add(Buffer.from("a\n"));
  now = 100; feed.add(Buffer.from("b\n"));
  now = 200; feed.add(Buffer.from("c\n"));
  expect(heard).toEqual(["a\n"]);
  now = 600; feed.add(Buffer.from("d".repeat(5000)));
  expect(heard.length).toBe(2);
  expect(heard[1]!.length).toBe(PROGRESS_TAIL_CHARS);
  feed.end();
});
