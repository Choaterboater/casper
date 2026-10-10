import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { RuntimeEventView } from "../src/app/events";
import { RuntimeEventMapper } from "../src/app/json-events";
import type { RuntimeEvent } from "../src/runtime/types";
import { formatCost, formatDuration, formatElapsed, formatTokens, lastOutputLine, runningElapsed } from "../src/tui/format";
import { formatTokenSplit } from "../src/tui/usage";
import { formatTaskSpend } from "../src/task/spend";
import type { WorkView } from "../src/tui/surface";
import type { InteractiveTerminal } from "../src/tui/terminal";
import type { DisplayLevel } from "../src/tui/display";

let clock = 1000;
const spy = spyOn(performance, "now").mockImplementation(() => clock);
const open: RuntimeEventView[] = [];
afterAll(() => spy.mockRestore());
afterEach(() => { clock = 1000; for (const events of open.splice(0)) events.reset(); });

function box(rich = true, level: DisplayLevel = "normal") {
  const boxes: Array<string[] | undefined> = [];
  const written: string[] = [];
  const terminal = { rich, columns: 100, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {},
    // The live rows, then the status row's words, as one list.
    setWork(view?: WorkView) { boxes.push(view ? [...view.rows, ...(view.status ? [view.status] : [])] : undefined); },
    write(value: string) { written.push(value); }, writeFold() {} };
  const events = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write: value => terminal.write(value) }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
    projectRoot: () => "/work/app", display: () => level });
  open.push(events);
  return { boxes, written, last: () => boxes.at(-1), handle: (...list: RuntimeEvent[]) => { for (const event of list) events.handle(event); } };
}
const start: RuntimeEvent = { type: "tool_start", toolName: "bash", toolCallId: "1", input: { command: "python -m pytest" } };

test("elapsed time shows only after 10 seconds", () => {
  expect(runningElapsed(9_999)).toBe("");
  expect(runningElapsed(10_000)).toBe(" · 10s");
  expect(runningElapsed(59_900)).toBe(" · 59s");
  expect(runningElapsed(252_000)).toBe(" · 4m12s");
  expect(runningElapsed(Number.NaN)).toBe("");
});

test("one way to say a time, a token count and a cost, everywhere", () => {
  // Live, the same screen said '2.0s', '16.5s', '14s', '1m', '1m 5s', '90 s' and '10 min'.
  expect([400, 2_000, 5_940, 9_960, 14_300, 16_500, 59_900, 60_000, 65_000, 90_000, 600_000, 3_720_000, 7_200_000].map(formatDuration))
    .toEqual(["0.4s", "2s", "5.9s", "10s", "14s", "16s", "59s", "1m", "1m05s", "1m30s", "10m", "1h02m", "2h"]);
  // A ticking clock shows whole seconds.
  expect([0, 3_400, 9_999, 95_000].map(formatElapsed)).toEqual(["0s", "3s", "9s", "1m35s"]);
  // The footer said '2.6k tok' while /status said '2k new' for the same count.
  expect([950, 2_600, 48_213, 312_400, 4_856_497].map(formatTokens)).toEqual(["950", "2.6k", "48.2k", "312k", "4.9M"]);
  expect(formatTokenSplit({ input: 2_600, output: 112, cacheRead: 0, cacheWrite: 0, total: 2_712 })).toBe("112 out · 2.6k new");
  expect(formatTaskSpend({ tokens: 2_600, cost: 0 }, false)).toBe("task 2.6k tok");
  expect([0.004, 0.314, 5.0231, 123.4].map(formatCost)).toEqual(["$0.004", "$0.31", "$5.02", "$123"]);
});

test("the running line gains its elapsed time on a later redraw, and becomes the finished line when it ends", () => {
  const s = box();
  s.handle(start);
  expect(s.last()![0]).toBe("• bash · python -m pytest");
  clock += 252_000;
  s.handle({ type: "tool_progress", toolName: "bash", toolCallId: "1", text: "collecting" });
  expect(s.last()![0]).toBe("• bash · python -m pytest · 4m12s");
  s.handle({ type: "tool_end", toolName: "bash", toolCallId: "1", input: { command: "python -m pytest" }, isError: false });
  expect(s.last()![0]).toStartWith("✓ bash");
});

test("last output line: control characters, secrets, truncation and empty output", () => {
  expect(lastOutputLine("", 40)).toBe("");
  expect(lastOutputLine("\n  \n\n", 40)).toBe("");
  expect(lastOutputLine("a\nb\n\n", 40)).toBe("b");
  expect(lastOutputLine("old\r50%\r75%", 40)).toBe("75%");
  expect(lastOutputLine("ok \u001b[31mred\u001b[0m\u0007", 40)).not.toMatch(/[\u001b\u0007]/);
  expect(lastOutputLine("curl -H 'Authorization: Bearer abc123xyz' https://u:pw@example.com", 200)).not.toContain("abc123xyz");
  const cut = lastOutputLine("x".repeat(100), 20);
  expect(cut.length).toBe(20);
  expect(cut.endsWith("…")).toBe(true);
});

test("a running bash step shows one dim line with its latest output", () => {
  const s = box();
  s.handle(start, { type: "tool_progress", toolName: "bash", toolCallId: "1", text: "tests/a.py ..\ntests/b.py ... [45%]\n" });
  expect(s.last()).toEqual(["• bash · python -m pytest", "↳ tests/b.py ... [45%]", "Running python -m pytest · 0s"]);
});

test("quiet, plain terminals and other tools show no output line", () => {
  const quiet = box(true, "quiet");
  quiet.handle(start, { type: "tool_progress", toolName: "bash", toolCallId: "1", text: "hello" });
  expect(quiet.last()!.some(line => line.startsWith("↳"))).toBe(false);
  const plain = box(false);
  plain.handle(start, { type: "tool_progress", toolName: "bash", toolCallId: "1", text: "hello" });
  expect(plain.boxes).toEqual([]);
  expect(plain.written).toEqual([]);
  const other = box();
  other.handle({ type: "tool_start", toolName: "grep", toolCallId: "2", input: { pattern: "x" } },
    { type: "tool_progress", toolName: "grep", toolCallId: "2", text: "hello" });
  expect(other.last()!.some(line => line.startsWith("↳"))).toBe(false);
});

test("the last output line is cut by characters, never in the middle of an emoji", () => {
  const cut = lastOutputLine("ab" + "\u{1F600}".repeat(10), 5);
  expect(cut).toBe("ab\u{1F600}\u{1F600}…");
});

test("--json ignores tool progress", () => {
  expect(new RuntimeEventMapper().map({ type: "tool_progress", toolName: "bash", toolCallId: "1", text: "secret-ish" })).toEqual([]);
});
