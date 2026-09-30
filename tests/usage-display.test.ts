import { expect, test } from "bun:test";
import { formatTaskSpend } from "../src/task/spend";
import { compactCount, formatCacheHitRate, formatCostLong, formatCostShort, formatTokenSplit } from "../src/tui/usage";

// One real session: the old status bar showed "5031442 tok │ $1.251 est", ~97% of it cache reads.
const real = { input: 183, output: 43_741, cacheRead: 4_856_497, cacheWrite: 131_021, total: 5_031_442 };

test("token split shows out, new, and cached instead of one total", () => {
  expect(formatTokenSplit(real)).toBe("44k out · 131k new · 4.9M cached");
});

test("token split leaves out zero parts except out", () => {
  expect(formatTokenSplit({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })).toBe("0 out");
  expect(formatTokenSplit({ input: 812, output: 40, cacheRead: 0, cacheWrite: 0, total: 852 })).toBe("40 out · 812 new");
});

test("cache line gives the share of input read from cache, rounded down, or a dash before any input", () => {
  expect(formatCacheHitRate(real)).toBe("97% of input read from cache this session");
  expect(formatCacheHitRate({ input: 1, output: 0, cacheRead: 999, cacheWrite: 0, total: 1000 })).toBe("99% of input read from cache this session");
  expect(formatCacheHitRate({ input: 812, output: 40, cacheRead: 0, cacheWrite: 0, total: 852 })).toBe("0% of input read from cache this session");
  expect(formatCacheHitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })).toBe("—");
});

test("compact counts round k and give M one decimal", () => {
  expect(compactCount(999)).toBe("999");
  expect(compactCount(1_499)).toBe("1k");
  expect(compactCount(999_499)).toBe("999k");
  expect(compactCount(999_500)).toBe("1.0M");
  expect(compactCount(12_345_678)).toBe("12.3M");
});

test("subscription sign-ins name the plan and label the catalog price as pay-per-token", () => {
  const usage = { estimatedCost: 1.2511 };
  expect(formatCostShort(usage, { provider: "github-copilot", billing: "subscription" })).toBe("Copilot subscription (≈$1.25 pay-per-token)");
  expect(formatCostShort(usage, { provider: "openai-codex", billing: "subscription" })).toBe("ChatGPT subscription (≈$1.25 pay-per-token)");
  expect(formatCostShort(usage, { provider: "xai", billing: "subscription" })).toBe("subscription (≈$1.25 pay-per-token)");
  expect(formatCostShort({}, { provider: "github-copilot", billing: "subscription" })).toBe("Copilot subscription");
  expect(formatCostLong(usage, { provider: "github-copilot", billing: "subscription" }))
    .toBe("Copilot subscription; pay-per-token these tokens would be ≈ $1.2511 (SDK/catalog estimate)");
});

test("pay-per-token providers keep the dollar estimate", () => {
  const usage = { estimatedCost: 1.2511 };
  expect(formatCostShort(usage, { provider: "openrouter", billing: "per-token" })).toBe("$1.251 est");
  expect(formatCostShort(usage)).toBe("$1.251 est");
  expect(formatCostShort({}, { provider: "openrouter", billing: "per-token" })).toBeUndefined();
  expect(formatCostLong(usage, { provider: "anthropic", billing: "per-token" })).toBe("$1.2511 SDK/catalog estimate");
  expect(formatCostLong({})).toBe("unavailable");
});

test("the footer's task segment uses the short subscription form", () => {
  expect(formatTaskSpend({ tokens: 48_213, cost: 0.314 }, true, "subscription")).toBe("task 48.2k tok · sub ≈$0.31");
  expect(formatTaskSpend({ tokens: 48_213, cost: 0.314 }, true, "per-token")).toBe("task 48.2k tok · $0.31");
  expect(formatTaskSpend({ tokens: 950, cost: 0 }, false, "subscription")).toBe("task 950 tok");
});
