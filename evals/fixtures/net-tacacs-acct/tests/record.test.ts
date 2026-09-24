import { expect, test } from "bun:test";
import { isoTime, parseRecord } from "../src/record";

test("parses a command accounting record with spaces and = in values", () => {
  expect(parseRecord("Jan  5 10:00:01\t192.0.2.10\talice\ttty1\t198.51.100.5\tstop\ttask_id=11\tservice=shell\tpriv-lvl=15\tcmd=show logging | include a=b <cr>")).toEqual({
    timestamp: "Jan  5 10:00:01", nas: "192.0.2.10", user: "alice", port: "tty1", remote: "198.51.100.5", flag: "stop",
    attributes: { task_id: "11", service: "shell", "priv-lvl": "15", cmd: "show logging | include a=b <cr>" },
  });
});

test("rejects malformed lines with a reason", () => {
  expect(typeof parseRecord("garbage")).toBe("string");
  expect(typeof parseRecord("Jan 5 10:00:01\tnas\tu\tp\tr\tstart")).toBe("string");
  expect(typeof parseRecord("Jan  5 10:00:01\tnas\tu\tp\tr\tbegin")).toBe("string");
});

test("timestamps become ISO in the given year", () => {
  expect(isoTime("Jan  5 10:00:01", 2026)).toBe("2026-01-05T10:00:01Z");
  expect(isoTime("Feb 30 10:00:01", 2026)).toBeNull();
});
