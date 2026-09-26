import { expect, test } from "bun:test";
import { JobQueue } from "../src/queue";

test("runs a job and reports its value", async () => {
  const queue = new JobQueue({ concurrency: 2 });
  const handle = queue.add(async () => 42);
  expect(handle.id).toBe(1);
  expect(await handle.result).toEqual({ status: "fulfilled", value: 42 });
});

test("numbers jobs in the order they were added", async () => {
  const queue = new JobQueue({ concurrency: 1 });
  const first = queue.add(async () => "a");
  const second = queue.add(async () => "b");
  expect([first.id, second.id]).toEqual([1, 2]);
  expect(await second.result).toEqual({ status: "fulfilled", value: "b" });
});
