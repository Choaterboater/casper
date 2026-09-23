import { expect, test } from "bun:test";
import { LifecycleRegistry, type OwnedClose } from "../src/app/lifecycle";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void } {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("a subsystem closed and re-registered is closed again by closeAll", async () => {
  const registry = new LifecycleRegistry();
  const first = deferred();
  let firstCloses = 0;
  let secondCloses = 0;
  const firstEntry: OwnedClose = { name: "browser", close: () => { firstCloses++; return first.promise; } };
  registry.add(firstEntry);
  const closing = registry.close("browser");
  first.resolve();
  await closing;
  // Cancel → new session re-registers under the same name; the old close is settled.
  registry.add({ name: "browser", close: () => { secondCloses++; return Promise.resolve(); } });
  await Promise.all(registry.closeAll());
  expect(firstCloses).toBe(1);
  expect(secondCloses).toBe(1);
});

test("a close in flight is joined, and re-registration during it closes the replacement", async () => {
  const registry = new LifecycleRegistry();
  const first = deferred();
  let firstCloses = 0;
  let secondCloses = 0;
  registry.add({ name: "debug", close: () => { firstCloses++; return first.promise; } });
  const closing = registry.close("debug");
  expect(registry.close("debug")).toBe(closing);
  // Replacement registered while the old close is still running.
  registry.add({ name: "debug", close: () => { secondCloses++; return Promise.resolve(); } });
  first.resolve();
  await closing;
  await Promise.all(registry.closeAll());
  expect(firstCloses).toBe(1);
  expect(secondCloses).toBe(1);
});

test("drain propagates the first failure and a second closeAll does not re-close", async () => {
  const registry = new LifecycleRegistry();
  let closes = 0;
  registry.add({ name: "mcp", close: () => { closes++; return Promise.reject(new Error("cleanup failed")); } });
  const works = registry.closeAll();
  await expect(registry.drain()).rejects.toThrow("cleanup failed");
  await expect(works[0]!).rejects.toThrow("cleanup failed");
  await Promise.all(registry.closeAll().map(work => work.catch(() => {})));
  expect(closes).toBe(1);
});
