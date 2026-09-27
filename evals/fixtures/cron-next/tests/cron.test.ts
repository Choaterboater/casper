import { expect, test } from "bun:test";
import { nextRun } from "../src/cron";

test("* * * * * gives the next minute", () => {
  expect(nextRun("* * * * *", new Date("2027-01-01T00:00:30Z"))).toEqual(new Date("2027-01-01T00:01:00Z"));
});

test("0 12 * * * gives the next noon", () => {
  expect(nextRun("0 12 * * *", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-01T12:00:00Z"));
});
