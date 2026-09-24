import { expect, test } from "bun:test";
import { parseLog } from "../src/parse";

test("parses a simple record", () => {
  expect(parseLog('2026-01-05T10:00:00Z INFO msg="user login" user=alice latency_ms=12\n')).toEqual({
    records: [{ line: 1, time: "2026-01-05T10:00:00Z", level: "INFO", message: "user login", latencyMs: 12, fields: { user: "alice" } }],
    problems: [],
  });
});
