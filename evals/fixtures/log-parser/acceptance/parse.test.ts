import { expect, test } from "bun:test";
import { parseLog } from "../src/parse";

const one = (line: string) => {
  const result = parseLog(line);
  expect(result.problems).toEqual([]);
  expect(result.records).toHaveLength(1);
  return result.records[0]!;
};

test("records without msg or latency get nulls, and fractional seconds are kept", () => {
  expect(one("2026-02-01T00:00:00.250Z DEBUG worker=3")).toEqual({
    line: 1, time: "2026-02-01T00:00:00.250Z", level: "DEBUG", message: null, latencyMs: null, fields: { worker: "3" },
  });
  expect(one("2026-02-01T00:00:00Z WARN")).toMatchObject({ level: "WARN", fields: {}, message: null });
});

test("quoted values keep spaces, = signs and escaped quotes and backslashes", () => {
  const record = one('2026-02-01T00:00:00Z ERROR msg="said \\"hi\\" a=b" path="C:\\\\tmp\\\\x" empty=""');
  expect(record.message).toBe('said "hi" a=b');
  expect(record.fields).toEqual({ path: "C:\\tmp\\x", empty: "" });
});

test("bare values stay strings, latency_ms becomes a number only when valid", () => {
  expect(one("2026-02-01T00:00:00Z INFO code=007 latency_ms=3.5").latencyMs).toBe(3.5);
  expect(one("2026-02-01T00:00:00Z INFO code=007 latency_ms=3.5").fields).toEqual({ code: "007" });
  expect(one("2026-02-01T00:00:00Z INFO latency_ms=fast").latencyMs).toBeNull();
  expect(one("2026-02-01T00:00:00Z INFO latency_ms=-1").latencyMs).toBeNull();
});

test("later duplicate keys win", () => {
  expect(one("2026-02-01T00:00:00Z INFO user=a user=b").fields).toEqual({ user: "b" });
});

test("indented continuation lines extend the previous record's message", () => {
  const result = parseLog([
    '2026-02-01T00:00:00Z ERROR msg="stack follows" req=9',
    "    at handler (app.ts:10)",
    "\tat main (app.ts:2)",
    "2026-02-01T00:00:01Z INFO msg=next",
  ].join("\n"));
  expect(result.problems).toEqual([]);
  expect(result.records.map((record) => [record.line, record.message])).toEqual([
    [1, "stack follows\nat handler (app.ts:10)\nat main (app.ts:2)"], [4, "next"],
  ]);
});

test("a continuation for a record without msg becomes the message", () => {
  const result = parseLog("2026-02-01T00:00:00Z ERROR req=9\n  detail\n  more");
  expect(result.records[0]!.message).toBe("detail\nmore");
});

test("CRLF endings, blank lines and a trailing newline are handled; line numbers stay 1-based", () => {
  const result = parseLog("\r\n2026-02-01T00:00:00Z INFO a=1\r\n\r\n2026-02-01T00:00:02Z INFO a=2\r\n");
  expect(result.problems).toEqual([]);
  expect(result.records.map((record) => [record.line, record.fields.a])).toEqual([[2, "1"], [4, "2"]]);
});

test("bad lines become problems with their line number and do not stop parsing", () => {
  const result = parseLog([
    "not a log line",
    "2026-13-01T00:00:00Z INFO a=1",
    "2026-02-30T00:00:00Z INFO a=1",
    "2026-02-01T00:00:00Z TRACE a=1",
    '2026-02-01T00:00:00Z INFO msg="unterminated',
    "2026-02-01T00:00:00Z INFO novalue",
    "2026-02-01T00:00:00+01:00 INFO a=1",
    "2026-02-01T00:00:00Z INFO ok=yes",
  ].join("\n"));
  expect(result.problems.map((problem) => problem.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  for (const problem of result.problems) expect(problem.reason.length).toBeGreaterThan(0);
  expect(result.records.map((record) => [record.line, record.fields.ok])).toEqual([[8, "yes"]]);
});

test("a continuation after a bad line is a problem, not attached to an earlier record", () => {
  const result = parseLog("2026-02-01T00:00:00Z INFO msg=first\ngarbage\n  orphan");
  expect(result.records.map((record) => record.message)).toEqual(["first"]);
  expect(result.problems.map((problem) => problem.line)).toEqual([2, 3]);
});

test("a leading continuation line is a problem", () => {
  expect(parseLog("  orphan").problems).toEqual([{ line: 1, reason: expect.any(String) }]);
});

test("empty input has no records and no problems", () => {
  expect(parseLog("")).toEqual({ records: [], problems: [] });
});
