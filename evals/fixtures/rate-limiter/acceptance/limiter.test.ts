import { expect, test } from "bun:test";
import { RateLimiter } from "../src/limiter";

function clock(start = 10_000) {
  let time = start;
  return { now: () => time, advance: (ms: number) => { time += ms; }, set: (ms: number) => { time = ms; } };
}

test("an empty bucket denies with the exact wait, and allows once the wait has passed", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: time.now });
  limiter.take("a"); limiter.take("a");
  expect(limiter.take("a")).toEqual({ allowed: false, remaining: 0, retryAfterMs: 1000 });
  time.advance(999);
  expect(limiter.take("a")).toEqual({ allowed: false, remaining: 0, retryAfterMs: 1 });
  time.advance(1);
  expect(limiter.take("a")).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
});

test("refill is continuous: fractions of a token accumulate across calls", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 3, now: time.now });
  limiter.take("a");
  for (let step = 0; step < 3; step++) { time.advance(111); expect(limiter.take("a").allowed).toBe(false); }
  // 333 ms at 3/s is 0.999 tokens: one more millisecond (0.003) is enough, and the wait says so.
  expect(limiter.take("a").retryAfterMs).toBe(1);
  time.advance(1);
  expect(limiter.take("a").allowed).toBe(true);
});

test("retryAfterMs rounds up to whole milliseconds and accounts for the cost", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 3, now: time.now });
  expect(limiter.take("a", 5)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  expect(limiter.take("a", 2)).toEqual({ allowed: false, remaining: 0, retryAfterMs: 667 });
  time.advance(500);
  expect(limiter.take("a", 2)).toEqual({ allowed: false, remaining: 1, retryAfterMs: 167 });
});

test("a denied request uses no tokens", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: time.now });
  limiter.take("a", 2);
  expect(limiter.take("a", 2)).toEqual({ allowed: false, remaining: 1, retryAfterMs: 1000 });
  expect(limiter.take("a", 2).allowed).toBe(false);
  expect(limiter.take("a", 1)).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
});

test("a bucket never holds more than capacity, however long it waited", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 10, now: time.now });
  limiter.take("a");
  time.advance(3_600_000);
  expect(limiter.take("a")).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
  expect(limiter.take("a")).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  expect(limiter.take("a").allowed).toBe(false);
});

test("each key has its own bucket", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: time.now });
  expect(limiter.take("alice").allowed).toBe(true);
  expect(limiter.take("alice").allowed).toBe(false);
  expect(limiter.take("bob")).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  time.advance(10_000);
  expect(limiter.take("carol")).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
});

test("a clock that goes backwards adds no tokens and loses none", () => {
  const time = clock(50_000);
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: time.now });
  limiter.take("a");
  time.set(40_000);
  expect(limiter.take("a")).toEqual({ allowed: true, remaining: 0, retryAfterMs: 0 });
  expect(limiter.take("a").allowed).toBe(false);
  time.set(50_999);
  expect(limiter.take("a").allowed).toBe(false);
  time.set(51_000);
  expect(limiter.take("a").allowed).toBe(true);
});

test("the clock is read from the injected now() on every call", () => {
  let reads = 0;
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => { reads++; return 0; } });
  limiter.take("a"); limiter.take("a");
  expect(reads).toBeGreaterThanOrEqual(2);
});

test("rejects options that are not positive integers and costs that are not positive integers or exceed capacity", () => {
  for (const options of [{ capacity: 0, refillPerSecond: 1 }, { capacity: 1.5, refillPerSecond: 1 }, { capacity: 1, refillPerSecond: 0 }, { capacity: 1, refillPerSecond: 0.5 }, { capacity: Number.NaN, refillPerSecond: 1 }]) {
    expect(() => new RateLimiter(options)).toThrow(RangeError);
  }
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: () => 0 });
  for (const cost of [0, -1, 1.5, 4]) expect(() => limiter.take("a", cost)).toThrow(RangeError);
  expect(limiter.take("a", 3).allowed).toBe(true);
});
