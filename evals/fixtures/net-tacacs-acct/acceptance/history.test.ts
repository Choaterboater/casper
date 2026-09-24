import { expect, test } from "bun:test";
import { commandHistory } from "../src/history";

const row = (...fields: string[]) => fields.join("\t");
const log = [
  row("Mar  3 09:00:00", "192.0.2.10", "alice", "tty1", "198.51.100.5", "start", "task_id=1", "service=shell"),
  row("Mar  3 09:00:05", "192.0.2.10", "alice", "tty1", "198.51.100.5", "start", "task_id=2", "service=shell", "priv-lvl=15", "cmd=show running-config <cr>"),
  row("Mar  3 09:00:07", "192.0.2.10", "alice", "tty1", "198.51.100.5", "stop", "task_id=2", "service=shell", "priv-lvl=15", "cmd=show running-config <cr>", "elapsed_time=2"),
  row("Mar  3 09:00:06", "192.0.2.11", "bob", "tty2", "198.51.100.6", "stop", "task_id=2", "service=shell", "priv-lvl=1", "cmd=show version <cr>", "elapsed_time=0"),
  "",
  row("Mar  3 09:01:00", "192.0.2.10", "alice", "tty1", "198.51.100.5", "start", "task_id=3", "priv-lvl=15", "cmd=configure terminal <cr>"),
  row("Mar  3 09:01:30", "192.0.2.10", "alice", "tty1", "198.51.100.5", "update", "task_id=3", "cmd=configure terminal <cr>"),
  "not\ta\tvalid line",
  row("Mar  3 09:02:00", "192.0.2.10", "alice", "tty1", "198.51.100.5", "start", "task_id=3", "priv-lvl=15", "cmd=interface 1/1/1 <cr>"),
  row("Mar  3 09:02:01", "192.0.2.10", "alice", "tty1", "198.51.100.5", "stop", "task_id=3", "priv-lvl=15", "cmd=interface 1/1/1 <cr>", "elapsed_time=1"),
  row("Mar  2 23:59:59", "192.0.2.11", "bob", "tty2", "198.51.100.6", "start", "task_id=9", "priv-lvl=15", "cmd=reload <cr>"),
  row("Feb 30 00:00:00", "192.0.2.11", "bob", "tty2", "198.51.100.6", "stop", "task_id=9", "cmd=reload <cr>"),
  row("Mar  3 09:03:00", "192.0.2.12", "carol", "ssh", "203.0.113.7", "stop", "task_id=4", "cmd=show ip route vrf a=b <cr>", "elapsed_time=x"),
  row("Mar  3 09:00:10", "192.0.2.10", "alice", "tty1", "198.51.100.5", "stop", "task_id=1", "service=shell", "elapsed_time=10"),
].join("\r\n");

test("pairs start/stop by NAS and task id and builds per-user history in time order", () => {
  const history = commandHistory(log, { year: 2026 });
  expect(history.users.alice).toEqual([
    { time: "2026-03-03T09:00:05Z", nas: "192.0.2.10", port: "tty1", remote: "198.51.100.5", command: "show running-config", privLevel: 15, elapsedSeconds: 2, status: "completed" },
    { time: "2026-03-03T09:01:00Z", nas: "192.0.2.10", port: "tty1", remote: "198.51.100.5", command: "configure terminal", privLevel: 15, elapsedSeconds: null, status: "no-stop" },
    { time: "2026-03-03T09:02:00Z", nas: "192.0.2.10", port: "tty1", remote: "198.51.100.5", command: "interface 1/1/1", privLevel: 15, elapsedSeconds: 1, status: "completed" },
  ]);
});

test("same task id on a different NAS is a different command; stop-only and never-stopped commands keep their status", () => {
  const history = commandHistory(log, { year: 2026 });
  expect(history.users.bob).toEqual([
    { time: "2026-03-02T23:59:59Z", nas: "192.0.2.11", port: "tty2", remote: "198.51.100.6", command: "reload", privLevel: 15, elapsedSeconds: null, status: "no-stop" },
    { time: "2026-03-03T09:00:06Z", nas: "192.0.2.11", port: "tty2", remote: "198.51.100.6", command: "show version", privLevel: 1, elapsedSeconds: 0, status: "stop-only" },
  ]);
  expect(history.users.carol).toEqual([
    { time: "2026-03-03T09:03:00Z", nas: "192.0.2.12", port: "ssh", remote: "203.0.113.7", command: "show ip route vrf a=b", privLevel: null, elapsedSeconds: null, status: "stop-only" },
  ]);
});

test("session records without cmd are not commands and not problems", () => {
  const history = commandHistory(log, { year: 2026 });
  expect(Object.keys(history.users).sort()).toEqual(["alice", "bob", "carol"]);
  expect(history.users.alice!.some((entry) => entry.command === "")).toBe(false);
});

test("invalid lines and impossible dates are problems with 1-based line numbers; CRLF is handled", () => {
  const history = commandHistory(log, { year: 2026 });
  expect(history.problems.map((problem) => problem.line)).toEqual([8, 12]);
  for (const problem of history.problems) expect(problem.reason.length).toBeGreaterThan(0);
});

test("ties in time keep log order", () => {
  const text = [
    row("Apr  1 00:00:00", "n", "dave", "p", "r", "stop", "task_id=1", "cmd=first <cr>"),
    row("Apr  1 00:00:00", "n", "dave", "p", "r", "stop", "task_id=2", "cmd=second <cr>"),
  ].join("\n");
  expect(commandHistory(text, { year: 2026 }).users.dave!.map((entry) => entry.command)).toEqual(["first", "second"]);
});

test("the year option drives the timestamps (leap day)", () => {
  const text = row("Feb 29 12:00:00", "n", "erin", "p", "r", "stop", "task_id=1", "cmd=show clock <cr>");
  expect(commandHistory(text, { year: 2028 }).users.erin![0]!.time).toBe("2028-02-29T12:00:00Z");
  expect(commandHistory(text, { year: 2026 }).problems).toHaveLength(1);
});

test("empty input", () => {
  expect(commandHistory("", { year: 2026 })).toEqual({ users: {}, problems: [] });
});
