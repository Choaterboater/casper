import { expect, test } from "bun:test";
import { JobQueue } from "../src/queue";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const noSleep = async () => {};

test("never runs more than `concurrency` jobs at once and starts them in the order added", async () => {
  const queue = new JobQueue({ concurrency: 2 });
  const gates = [0, 1, 2, 3, 4].map(() => deferred());
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  gates.forEach((gate, index) => queue.add(async () => {
    started.push(index);
    active++; peak = Math.max(peak, active);
    await gate.promise;
    active--;
  }));
  await tick();
  expect(started).toEqual([0, 1]);
  gates[1]!.resolve();
  await tick();
  expect(started).toEqual([0, 1, 2]);
  for (const gate of gates) gate.resolve();
  await queue.onIdle();
  expect(started).toEqual([0, 1, 2, 3, 4]);
  expect(peak).toBe(2);
});

test("onIdle reports results in the order the jobs were added, not the order they finished", async () => {
  const queue = new JobQueue({ concurrency: 3 });
  const gates = [deferred(), deferred(), deferred()];
  gates.forEach((gate, index) => queue.add(async () => { await gate.promise; return index; }));
  gates[2]!.resolve(); await tick();
  gates[0]!.resolve(); await tick();
  gates[1]!.resolve();
  expect(await queue.onIdle()).toEqual([0, 1, 2].map((value) => ({ status: "fulfilled", value })));
});

test("onIdle on an empty queue resolves with no results", async () => {
  expect(await new JobQueue({ concurrency: 1 }).onIdle()).toEqual([]);
});

test("a failed attempt is retried with delays of 10, 20, 40 ms through the injected sleep", async () => {
  const delays: number[] = [];
  const queue = new JobQueue({ concurrency: 1, retries: 3, sleep: async (ms) => { delays.push(ms); } });
  let attempts = 0;
  const handle = queue.add(async () => {
    attempts++;
    if (attempts < 4) throw new Error(`fail ${attempts}`);
    return "ok";
  });
  expect(await handle.result).toEqual({ status: "fulfilled", value: "ok" });
  expect({ attempts, delays }).toEqual({ attempts: 4, delays: [10, 20, 40] });
});

test("when every attempt fails, the result is rejected with the last error", async () => {
  const delays: number[] = [];
  const queue = new JobQueue({ concurrency: 1, retries: 2, sleep: async (ms) => { delays.push(ms); } });
  let attempts = 0;
  const handle = queue.add(async () => { attempts++; throw new Error(`fail ${attempts}`); });
  const result = await handle.result;
  expect(result.status).toBe("rejected");
  expect((result as { error: Error }).error.message).toBe("fail 3");
  expect(delays).toEqual([10, 20]);
});

test("retries default to 0, and a job that throws synchronously is a failed attempt", async () => {
  let slept = false;
  const queue = new JobQueue({ concurrency: 1, sleep: async () => { slept = true; } });
  const handle = queue.add(() => { throw new Error("sync"); });
  const result = await handle.result;
  expect(result.status).toBe("rejected");
  expect((result as { error: Error }).error.message).toBe("sync");
  expect(slept).toBe(false);
});

test("a job waiting to retry keeps its slot", async () => {
  const wait = deferred();
  const queue = new JobQueue({ concurrency: 1, retries: 1, sleep: () => wait.promise });
  let attempts = 0;
  queue.add(async () => { attempts++; if (attempts === 1) throw new Error("once"); return "a"; });
  let secondStarted = false;
  queue.add(async () => { secondStarted = true; return "b"; });
  await tick(); await tick();
  expect(secondStarted).toBe(false);
  wait.resolve();
  expect(await queue.onIdle()).toEqual([{ status: "fulfilled", value: "a" }, { status: "fulfilled", value: "b" }]);
});

test("cancelling a queued job means it never runs and its result is cancelled", async () => {
  const gate = deferred();
  const queue = new JobQueue({ concurrency: 1 });
  queue.add(async () => { await gate.promise; return "first"; });
  let ran = false;
  const second = queue.add(async () => { ran = true; return "second"; });
  const third = queue.add(async () => "third");
  second.cancel();
  expect(await second.result).toEqual({ status: "cancelled" });
  gate.resolve();
  expect(await queue.onIdle()).toEqual([
    { status: "fulfilled", value: "first" }, { status: "cancelled" }, { status: "fulfilled", value: "third" },
  ]);
  expect(ran).toBe(false);
  expect(await third.result).toEqual({ status: "fulfilled", value: "third" });
});

test("cancelling a running job aborts its signal, reports cancelled, and holds the slot until the job settles", async () => {
  const gate = deferred<string>();
  const queue = new JobQueue({ concurrency: 1 });
  let signal: AbortSignal | undefined;
  const first = queue.add(async (received) => { signal = received; return gate.promise; });
  let secondStarted = false;
  queue.add(async () => { secondStarted = true; return "b"; });
  await tick();
  first.cancel();
  expect(signal?.aborted).toBe(true);
  expect(await first.result).toEqual({ status: "cancelled" });
  await tick();
  expect(secondStarted).toBe(false);
  gate.resolve("late value");
  expect(await queue.onIdle()).toEqual([{ status: "cancelled" }, { status: "fulfilled", value: "b" }]);
});

test("cancelling during a retry wait stops further attempts and passes the signal to sleep", async () => {
  let sleepSignal: AbortSignal | undefined;
  const wait = deferred();
  const queue = new JobQueue({ concurrency: 1, retries: 5, sleep: (_ms, signal) => { sleepSignal = signal; return wait.promise; } });
  let attempts = 0;
  const handle = queue.add(async () => { attempts++; throw new Error("no"); });
  await tick(); await tick();
  handle.cancel();
  expect(sleepSignal?.aborted).toBe(true);
  wait.resolve();
  expect(await handle.result).toEqual({ status: "cancelled" });
  await queue.onIdle();
  expect(attempts).toBe(1);
});

test("cancel after a job settled changes nothing", async () => {
  const queue = new JobQueue({ concurrency: 1, sleep: noSleep });
  const handle = queue.add(async () => 1);
  await handle.result;
  handle.cancel();
  expect(await handle.result).toEqual({ status: "fulfilled", value: 1 });
  expect(await queue.onIdle()).toEqual([{ status: "fulfilled", value: 1 }]);
});

test("rejects a concurrency that is not a positive integer and negative or fractional retries", () => {
  for (const concurrency of [0, -1, 1.5, Number.NaN]) expect(() => new JobQueue({ concurrency })).toThrow(RangeError);
  for (const retries of [-1, 0.5]) expect(() => new JobQueue({ concurrency: 1, retries })).toThrow(RangeError);
});
