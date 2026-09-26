import { expect, test } from "bun:test";
import { RateLimiter } from "../src/limiter";

test("a new key starts full and each take uses one token", () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: () => 0 });
  expect(limiter.take("a")).toEqual({ allowed: true, remaining: 2, retryAfterMs: 0 });
  expect(limiter.take("a")).toEqual({ allowed: true, remaining: 1, retryAfterMs: 0 });
});
