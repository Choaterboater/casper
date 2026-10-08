import { expect, test } from "bun:test";
import { CallClock, CallClockTimeout, type ClockTimers } from "../src/mcp/clock";

/** Manual timers: time only moves when the test says so. */
function manualTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  const timers: ClockTimers = {
    now: () => now,
    setTimeout: (callback, ms) => { const id = next++; pending.set(id, { at: now + ms, callback }); return id; },
    clearTimeout: (handle) => { pending.delete(handle as number); },
  };
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      pending.delete(due[0]);
      due[1].callback();
    }
    now = end;
  }
  return { timers, advance, pending };
}

test("idle limit stops the call when the server says nothing", () => {
  const { timers, advance } = manualTimers();
  const clock = new CallClock(500, 10_000, timers);
  advance(499);
  expect(clock.signal.aborted).toBe(false);
  advance(1);
  expect(clock.signal.aborted).toBe(true);
  expect(clock.reason()).toBe("idle");
  expect(clock.signal.reason).toBeInstanceOf(CallClockTimeout);
  expect((clock.signal.reason as CallClockTimeout).reason).toBe("idle");
});

test("progress restarts the idle limit and keeps the last message", () => {
  const { timers, advance } = manualTimers();
  const clock = new CallClock(500, 10_000, timers);
  for (let i = 0; i < 6; i++) { advance(400); clock.progress(`step ${i}`); }
  expect(clock.signal.aborted).toBe(false);
  expect(clock.lastProgress).toBe("step 5");
  advance(500);
  expect(clock.reason()).toBe("idle");
});

test("hard cap stops the call even while progress keeps coming", () => {
  const { timers, advance } = manualTimers();
  const clock = new CallClock(300, 1000, timers);
  for (let i = 0; i < 9; i++) { advance(100); clock.reset(); }
  expect(clock.signal.aborted).toBe(false);
  advance(100);
  expect(clock.signal.aborted).toBe(true);
  expect(clock.reason()).toBe("hard");
  expect((clock.signal.reason as CallClockTimeout).limitMs).toBe(1000);
});

test("pause stops both the idle and the hard-cap timers", () => {
  const { timers, advance, pending } = manualTimers();
  const clock = new CallClock(300, 1000, timers);
  advance(200);
  clock.pause();
  expect(pending.size).toBe(0);
  advance(60_000); // The user reads a prompt for a minute.
  expect(clock.signal.aborted).toBe(false);
  expect(clock.reason()).toBeUndefined();
  clock.reset(); // Progress while paused does not start a timer.
  expect(pending.size).toBe(0);
  clock.resume();
  // Fresh idle period; 800 ms of the hard cap were left.
  advance(299);
  expect(clock.signal.aborted).toBe(false);
  clock.reset();
  advance(299);
  clock.reset();
  advance(201);
  expect(clock.signal.aborted).toBe(false);
  advance(1);
  expect(clock.reason()).toBe("hard");
});

test("pauses nest: the clock runs again only after the last resume", () => {
  const { timers, advance } = manualTimers();
  const clock = new CallClock(300, 10_000, timers);
  clock.pause();
  clock.pause();
  clock.resume();
  advance(5_000);
  expect(clock.signal.aborted).toBe(false);
  clock.resume();
  clock.resume(); // Extra resume is ignored.
  advance(300);
  expect(clock.reason()).toBe("idle");
});

test("dispose stops everything and later calls do nothing", () => {
  const { timers, advance, pending } = manualTimers();
  const clock = new CallClock(300, 1000, timers);
  clock.dispose();
  expect(pending.size).toBe(0);
  clock.reset(); clock.pause(); clock.resume(); clock.progress("late");
  advance(5_000);
  expect(clock.signal.aborted).toBe(false);
  expect(pending.size).toBe(0);
  expect(clock.lastProgress).toBeUndefined();
});

test("real timers: the signal aborts with the idle reason", async () => {
  const clock = new CallClock(30, 5_000);
  const reason = await new Promise((resolve) => clock.signal.addEventListener("abort", () => resolve(clock.reason())));
  expect(reason).toBe("idle");
  clock.dispose();
});

test("limits must be positive", () => {
  expect(() => new CallClock(0, 100)).toThrow();
  expect(() => new CallClock(100, Number.NaN)).toThrow();
});
