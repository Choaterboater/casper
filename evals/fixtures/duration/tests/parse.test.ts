import { expect, test } from "bun:test";
import { formatDuration, parseDuration } from "../src/duration";

test("single units", () => {
  expect(parseDuration("500ms")).toBe(500);
  expect(parseDuration("2s")).toBe(2000);
  expect(parseDuration("3m")).toBe(180_000);
  expect(parseDuration("1h")).toBe(3_600_000);
  expect(parseDuration("1d")).toBe(86_400_000);
});

test("descending unit lists add up, with or without spaces", () => {
  expect(parseDuration("1h30m")).toBe(5_400_000);
  expect(parseDuration("1d 2h")).toBe(93_600_000);
  expect(parseDuration(" 1m 30s 500ms ")).toBe(90_500);
});

test("fractions are allowed", () => {
  expect(parseDuration("1.5h")).toBe(5_400_000);
  expect(parseDuration("0.5s")).toBe(500);
});

test("missing units, unknown units, repeats, ascending order and negatives are rejected", () => {
  expect(() => parseDuration("")).toThrow("Empty duration");
  expect(() => parseDuration("10")).toThrow();
  expect(() => parseDuration("1x")).toThrow();
  expect(() => parseDuration("1m1m")).toThrow();
  expect(() => parseDuration("30m1h")).toThrow();
  expect(() => parseDuration("-1s")).toThrow();
});

test("parsing what formatting produced returns the same value", () => {
  for (const ms of [0, 6, 1_500, 5_400_000, 93_600_000, 183_845_006]) {
    expect(parseDuration(formatDuration(ms))).toBe(ms);
  }
});
