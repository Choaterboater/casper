import { expect, test } from "bun:test";
import { TtlCache } from "../src/cache";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("returns a value before it expires", async () => {
  const cache = new TtlCache<string>({ ttlMs: 30 });
  cache.set("a", "one");
  await sleep(25);
  expect(cache.get("a")).toBe("one");
});

test("an entry expires once its TTL has elapsed", async () => {
  const cache = new TtlCache<string>({ ttlMs: 30 });
  cache.set("a", "one");
  await sleep(30);
  expect(cache.get("a")).toBeUndefined();
  expect(cache.size).toBe(0);
});

test("setting again restarts the TTL", async () => {
  const cache = new TtlCache<string>({ ttlMs: 30 });
  cache.set("a", "one");
  await sleep(20);
  cache.set("a", "two");
  await sleep(20);
  expect(cache.get("a")).toBe("two");
});
