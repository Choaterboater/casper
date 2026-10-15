import { expect, spyOn, test, vi } from "bun:test";
import { PROGRESS_TAIL_CHARS, ProgressFeed, SLOW_FILE_MS } from "../src/verify/progress";

test("a quiet check reports the last announced file, across split/coloured headings, and stops its timers", () => {
  let now = 0;
  const heard: string[] = [];
  let ended = 0;
  const timers = new Set<{ fn: () => void; ms: number; unref(): void }>();
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
    const timer = { fn, ms, unref() {} };
    timers.add(timer);
    return timer;
  }) as never);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((timer: never) => { timers.delete(timer); }) as never);
  const tick = () => {
    for (const timer of [...timers].filter(timer => timer.ms === SLOW_FILE_MS)) {
      timers.delete(timer); timer.fn();
    }
  };
  try {
    const feed = new ProgressFeed(() => ({ update: tail => heard.push(tail), end: () => { ended++; } }), "test", () => now);
    feed.add(Buffer.from("\u001b[32mtests/spin.te"));
    feed.add(Buffer.from("st.ts:\u001b[0m\n(pass) previous test\n"));
    now = SLOW_FILE_MS;
    tick();
    expect(heard.at(-1)).toContain("Last announced test file: tests/spin.test.ts · no output for 10s");
    // A new file and fresh output replace the earlier file and silence counter.
    now += 100;
    feed.add(Buffer.from("RUNS tests/next.spec.ts\n"));
    now += SLOW_FILE_MS;
    tick();
    expect(heard.at(-1)).toContain("Last announced test file: tests/next.spec.ts · no output for 10s");
    expect(heard.at(-1)).not.toContain("Last announced test file: tests/spin.test.ts");
    now += SLOW_FILE_MS;
    tick();
    expect(heard.at(-1)).toContain("no output for 20s");
    expect(heard.every(text => text.length <= PROGRESS_TAIL_CHARS)).toBe(true);
    feed.end(); feed.end();
    expect(ended).toBe(1);
    expect(timers.size).toBe(0);
    const count = heard.length;
    feed.add(Buffer.from("tests/after.test.ts:\n"));
    tick();
    expect(heard.length).toBe(count);
  } finally { set.mockRestore(); clear.mockRestore(); }
});

test("output just before a quiet timer tick reports the file exactly ten seconds after that output", () => {
  vi.useFakeTimers();
  let now = 0;
  const heard: string[] = [];
  const advance = (ms: number) => { now += ms; vi.advanceTimersByTime(ms); };
  const feed = new ProgressFeed(() => ({ update: tail => heard.push(tail), end() {} }), "test", () => now);
  try {
    feed.add(Buffer.from("tests/spin.test.ts:\n"));
    advance(SLOW_FILE_MS - 100);
    feed.add(Buffer.from("still working\n"));
    advance(100); // The old timer's tick, just 100ms after the latest output.
    expect(heard.some(text => text.includes("Last announced test file:"))).toBe(false);
    advance(SLOW_FILE_MS - 101);
    expect(heard.some(text => text.includes("Last announced test file:"))).toBe(false);
    advance(1);
    expect(heard.at(-1)).toContain("Last announced test file: tests/spin.test.ts · no output for 10s");
    advance(SLOW_FILE_MS);
    expect(heard.at(-1)).toContain("no output for 20s");
    feed.end();
    const count = heard.length;
    advance(SLOW_FILE_MS);
    expect(heard.length).toBe(count);
  } finally { feed.end(); vi.useRealTimers(); }
});

test("stack traces and result lines do not invent a currently running file; no sink has no timers", () => {
  const set = spyOn(globalThis, "setTimeout");
  try {
    for (const sink of [undefined, () => ({ update() {}, end() {} })]) {
      const feed = new ProgressFeed(sink, "test");
      feed.add(Buffer.from("PASS tests/done.test.ts\n    at tests/fail.test.ts:12:3\n"));
      feed.end();
    }
    expect(set).not.toHaveBeenCalled();
  } finally { set.mockRestore(); }
});

test("slow-file progress stays bounded and display errors cannot stop it", () => {
  let now = 0;
  let tick: (() => void) | undefined;
  let calls = 0;
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void) => {
    tick = fn;
    return { unref() {} };
  }) as never);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation((() => {}) as never);
  try {
    const feed = new ProgressFeed(() => ({ update(text) {
      expect(text.length).toBeLessThanOrEqual(PROGRESS_TAIL_CHARS);
      calls++; throw new Error("display failure");
    }, end() { throw new Error("display failure"); } }), "test", () => now);
    feed.add(Buffer.from(`tests/spin.test.ts:\n${"x".repeat(10_000)}\n`));
    now = SLOW_FILE_MS;
    expect(() => tick?.()).not.toThrow();
    expect(calls).toBe(2);
    expect(() => feed.end()).not.toThrow();
  } finally { set.mockRestore(); clear.mockRestore(); }
});
