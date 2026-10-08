import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { RuntimeEventView } from "../src/app/events";
import { RuntimeEventMapper } from "../src/app/json-events";
import type { RuntimeEvent } from "../src/runtime/types";
import { lastOutputLine, runningElapsed } from "../src/tui/format";
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
    setActivity(lines?: string[]) { boxes.push(lines); }, write(value: string) { written.push(value); } };
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
  expect(s.last()).toEqual(["• bash · python -m pytest", "↳ tests/b.py ... [45%]"]);
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
