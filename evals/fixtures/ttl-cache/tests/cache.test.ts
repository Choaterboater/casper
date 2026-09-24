import { expect, test } from "bun:test";
import { TtlCache } from "../src/cache";

function clock(start = 1_000) {
  let time = start;
  return { now: () => time, advance: (ms: number) => { time += ms; } };
}

test("returns a value before it expires", () => {
  const time = clock();
  const cache = new TtlCache<string>({ ttlMs: 100, now: time.now });
  cache.set("a", "one");
  time.advance(99);
  expect(cache.get("a")).toBe("one");
});

test("an entry expires once its TTL has elapsed", () => {
  const time = clock();
  const cache = new TtlCache<string>({ ttlMs: 100, now: time.now });
  cache.set("a", "one");
  time.advance(100);
  expect(cache.get("a")).toBeUndefined();
  expect(cache.size).toBe(0);
});

test("setting again restarts the TTL", () => {
  const time = clock();
  const cache = new TtlCache<string>({ ttlMs: 100, now: time.now });
  cache.set("a", "one");
  time.advance(60);
  cache.set("a", "two");
  time.advance(60);
  expect(cache.get("a")).toBe("two");
});
