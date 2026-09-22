import { expect, test } from "bun:test";
import { formatDuration } from "../src/duration";

test("zero and sub-second values", () => {
  expect(formatDuration(0)).toBe("0ms");
  expect(formatDuration(6)).toBe("6ms");
  expect(formatDuration(1_500)).toBe("1s500ms");
});

test("larger values use the largest units first and omit empty ones", () => {
  expect(formatDuration(5_400_000)).toBe("1h30m");
  expect(formatDuration(93_600_000)).toBe("1d2h");
  expect(formatDuration(183_845_006)).toBe("2d3h4m5s6ms");
});

test("negative and non-finite input is rejected", () => {
  expect(() => formatDuration(-1)).toThrow();
  expect(() => formatDuration(Number.NaN)).toThrow();
});
