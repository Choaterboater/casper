import { expect, test } from "bun:test";
import { CronError, nextRun, nextRuns } from "../src/cron";

test("01 fields split on runs of spaces or tabs, ends trimmed", () => {
  const expr = "\t\t*  *\t*    *\t *  \t";
  expect(nextRun(expr, new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-01T00:01:00Z"));
});

test("02 five fields: minute, hour, day, month, weekday, and 7 also means Sunday", () => {
  expect(nextRun("30 14 15 6 *", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-06-15T14:30:00Z"));
  expect(nextRun("0 0 * * 7", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-03T00:00:00Z"));
});

test("03 [D] an optional sixth field is the year", () => {
  expect(nextRun("0 0 1 1 * 2030", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2030-01-01T00:00:00Z"));
});

test("04 any other field count is an error naming the count", () => {
  expect(() => nextRun("* * * *", new Date("2027-01-01T00:00:00Z"))).toThrow("expected 5 or 6 fields, got 4");
  expect(() => nextRun("* * * * * * *", new Date("2027-01-01T00:00:00Z"))).toThrow("expected 5 or 6 fields, got 7");
});

test("05 * matches every value", () => {
  expect(nextRun("0 * * * *", new Date("2027-01-01T05:30:00Z"))).toEqual(new Date("2027-01-01T06:00:00Z"));
});

test("06 a list of values, repeats allowed", () => {
  expect(nextRun("1,5,10 * * * *", new Date("2027-01-01T00:02:00Z"))).toEqual(new Date("2027-01-01T00:05:00Z"));
  expect(nextRun("0,0,30 * * * *", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-01T00:30:00Z"));
});

test("07 a range of values", () => {
  expect(nextRun("10-12 * * * *", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-01T00:10:00Z"));
});

test("08 [D] a range whose start is above its end wraps around", () => {
  expect(nextRun("0 22-2 * * *", new Date("2027-01-01T23:30:00Z"))).toEqual(new Date("2027-01-02T00:00:00Z"));
  expect(nextRun("0 0 * * FRI-MON", new Date("2027-01-02T00:00:00Z"))).toEqual(new Date("2027-01-03T00:00:00Z"));
});

test("09 a step on a wildcard or an explicit range", () => {
  expect(nextRun("*/15 * * * *", new Date("2027-01-01T00:05:00Z"))).toEqual(new Date("2027-01-01T00:15:00Z"));
  expect(nextRun("10-50/20 * * * *", new Date("2027-01-01T00:11:00Z"))).toEqual(new Date("2027-01-01T00:30:00Z"));
});

test("10 [D] a single value with a step runs to the field's maximum", () => {
  expect(nextRun("5/15 * * * *", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-01T00:05:00Z"));
  expect(nextRun("5/15 * * * *", new Date("2027-01-01T00:06:00Z"))).toEqual(new Date("2027-01-01T00:20:00Z"));
});

test("11 a step of 0 or a non-number step is invalid", () => {
  expect(() => nextRun("*/0 * * * *", new Date("2027-01-01T00:00:00Z"))).toThrow("minute: invalid step");
  expect(() => nextRun("*/x * * * *", new Date("2027-01-01T00:00:00Z"))).toThrow("minute: invalid step");
});

test("12 month and weekday names, any case, in lists and ranges", () => {
  expect(nextRun("0 0 1 JAN,jul *", new Date("2027-02-01T00:00:00Z"))).toEqual(new Date("2027-07-01T00:00:00Z"));
  expect(nextRun("0 0 * * MON-WED", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-04T00:00:00Z"));
});

test("13 a value outside the field's range is an error", () => {
  expect(() => nextRun("60 * * * *", new Date("2027-01-01T00:00:00Z"))).toThrow("minute: 60 out of range 0-59");
});

test("14 any other token is invalid, and the leftmost invalid field wins", () => {
  expect(() => nextRun("abc * * * *", new Date("2027-01-01T00:00:00Z"))).toThrow('minute: invalid token "abc"');
  expect(() => nextRun("abc def 1 1 *", new Date("2027-01-01T00:00:00Z"))).toThrow('minute: invalid token "abc"');
});

test("15 ? means * only in day-of-month and weekday", () => {
  expect(nextRun("0 0 ? * ?", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-02T00:00:00Z"));
  expect(() => nextRun("? * * * *", new Date("2027-01-01T00:00:00Z"))).toThrow('minute: invalid token "?"');
});

test("16 [D] when both day-of-month and weekday are restricted, a day must match both", () => {
  expect(nextRun("0 0 1-10 * 1-5", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-04T00:00:00Z"));
});

test("17 when only one of day-of-month and weekday is restricted, only that one applies", () => {
  expect(nextRun("0 0 15 * *", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-15T00:00:00Z"));
  expect(nextRun("0 0 * * 3", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-06T00:00:00Z"));
});

test("18 L in day-of-month is the month's last day, and combines with nothing else", () => {
  expect(nextRun("0 0 L * *", new Date("2027-02-10T00:00:00Z"))).toEqual(new Date("2027-02-28T00:00:00Z"));
  expect(() => nextRun("0 0 L,15 * *", new Date("2027-01-01T00:00:00Z"))).toThrow('day: invalid token "L,15"');
});

test("19 [D] <weekday>L is the month's last such weekday", () => {
  expect(nextRun("0 0 * * 5L", new Date("2027-01-01T00:00:00Z"))).toEqual(new Date("2027-01-29T00:00:00Z"));
});

test("20 L anywhere else is an invalid token", () => {
  expect(() => nextRun("L * * * *", new Date("2027-01-01T00:00:00Z"))).toThrow('minute: invalid token "L"');
  expect(() => nextRun("* * * L *", new Date("2027-01-01T00:00:00Z"))).toThrow('month: invalid token "L"');
});

test("21 the result is strictly after `after`", () => {
  expect(nextRun("30 10 * * *", new Date("2027-01-01T10:30:00Z"))).toEqual(new Date("2027-01-02T10:30:00Z"));
});

test("22 seconds and milliseconds of `after` are ignored, result has none", () => {
  expect(nextRun("* * * * *", new Date("2027-01-01T10:00:30.500Z"))).toEqual(new Date("2027-01-01T10:01:00Z"));
});

test("23 everything is computed in UTC", () => {
  expect(nextRun("0 0 15 6 *", new Date(Date.UTC(2027, 5, 14, 23, 0)))).toEqual(new Date(Date.UTC(2027, 5, 15, 0, 0)));
});

test("24 the search crosses month and year ends", () => {
  expect(nextRun("0 0 1 * *", new Date("2027-12-15T00:00:00Z"))).toEqual(new Date("2028-01-01T00:00:00Z"));
});

test("25 0 0 29 2 * finds the next 29 February, even four years ahead", () => {
  expect(nextRun("0 0 29 2 *", new Date("2028-03-01T00:00:00Z"))).toEqual(new Date("2032-02-29T00:00:00Z"));
});

test("26 [D] nothing matches within 8 years, or the year field is already behind", () => {
  expect(() => nextRun("0 0 30 2 *", new Date("2027-01-01T00:00:00Z"))).toThrow("never runs");
  expect(() => nextRun("0 0 1 1 * 2020", new Date("2027-01-01T00:00:00Z"))).toThrow("never runs");
});

test("27 an invalid `after` throws RangeError", () => {
  expect(() => nextRun("* * * * *", new Date("not a date"))).toThrow(RangeError);
  expect(() => nextRuns("!!! not a cron !!!", new Date("not a date"), 5)).toThrow(RangeError);
});

test("28 nextRuns returns count successive runs; count must be 1-1000", () => {
  expect(nextRuns("* * * * *", new Date("2027-01-01T00:00:00Z"), 3)).toEqual([
    new Date("2027-01-01T00:01:00Z"),
    new Date("2027-01-01T00:02:00Z"),
    new Date("2027-01-01T00:03:00Z"),
  ]);
  expect(() => nextRuns("* * * * *", new Date("2027-01-01T00:00:00Z"), 0)).toThrow(RangeError);
  expect(() => nextRuns("* * * * *", new Date("2027-01-01T00:00:00Z"), 1.5)).toThrow(RangeError);
  expect(() => nextRuns("* * * * *", new Date("2027-01-01T00:00:00Z"), 1001)).toThrow(RangeError);
  expect(() => nextRuns("!!! not a cron !!!", new Date("2027-01-01T00:00:00Z"), 0)).toThrow(RangeError);
});

test("29 macros expand to their equivalent expressions", () => {
  const after = new Date("2027-01-15T05:20:00Z");
  expect(nextRun("@hourly", after)).toEqual(new Date("2027-01-15T06:00:00Z"));
  expect(nextRun("@daily", after)).toEqual(new Date("2027-01-16T00:00:00Z"));
  expect(nextRun("@weekly", after)).toEqual(new Date("2027-01-17T00:00:00Z"));
  expect(nextRun("@monthly", after)).toEqual(new Date("2027-02-01T00:00:00Z"));
  expect(nextRun("@yearly", after)).toEqual(new Date("2028-01-01T00:00:00Z"));
  expect(nextRun("@annually", after)).toEqual(new Date("2028-01-01T00:00:00Z"));
});

test("30 an unknown macro is an error naming the whole expression", () => {
  const after = new Date("2027-01-01T00:00:00Z");
  expect(() => nextRun("@HOURLY", after)).toThrow("unknown macro @HOURLY");
  expect(() => nextRun("@fortnightly", after)).toThrow("unknown macro @fortnightly");
  expect(() => nextRun("@hourly x", after)).toThrow("unknown macro @hourly x");
});

test("31 field names the field responsible for a field error", () => {
  const after = new Date("2027-01-01T00:00:00Z");
  const fieldOf = (expression: string): string | null => {
    try {
      nextRun(expression, after);
      throw new Error("expected a CronError");
    } catch (error) {
      expect(error).toBeInstanceOf(CronError);
      return (error as CronError).field;
    }
  };
  expect(fieldOf("60 * * * *")).toBe("minute");
  expect(fieldOf("* */0 * * *")).toBe("hour");
  expect(fieldOf("* * abc * *")).toBe("day");
  expect(fieldOf("* * * 13 *")).toBe("month");
  expect(fieldOf("* * * * xyz")).toBe("weekday");
  expect(fieldOf("* * * * * 1969")).toBe("year");
});
