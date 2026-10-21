import { afterEach, expect, test } from "bun:test";
import { RuntimeEventView } from "../src/app/events";
import { plainSteps } from "../src/app/plain-steps";
import { observationInput, stepTitle } from "../src/runtime/observation";
import type { RuntimeEvent } from "../src/runtime/types";
import { formatToolActivity } from "../src/tui/format";
import { describeSteps, pastTense, stepRows } from "../src/tui/step-view";
import type { WorkView } from "../src/tui/surface";
import { renderFold, type FoldView, type InteractiveTerminal } from "../src/tui/terminal";

const open: RuntimeEventView[] = [];
afterEach(() => { for (const view of open.splice(0)) view.reset(); });
function screen(rich = true) {
  let work: WorkView | undefined;
  const folds: FoldView[] = [];
  const output: string[] = [];
  const terminal = { rich, columns: 120, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {},
    setWork(next?: WorkView) { work = next; }, writeFold(fold: FoldView) { folds.push(fold); } };
  const view = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write(text) { output.push(text); } }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
  });
  open.push(view);
  return { view, get work() { return work; }, output, folds, send: (...events: RuntimeEvent[]) => { for (const event of events) view.handle(event); },
    folded: () => folds.flatMap(fold => renderFold(fold, 120, true, false)).join("\n") };
}
const titled = (id: string, command: string, description: string, text = "ok", isError = false): RuntimeEvent[] => [
  { type: "tool_start", toolName: "bash", toolCallId: id, input: { command }, description },
  { type: "tool_end", toolName: "bash", toolCallId: id, input: { command }, description, isError, output: { text, truncated: false } },
];

test("a shell step's title is one plain line from the AI: secrets hidden, controls neutral, at most 80 characters, shell tools only", () => {
  expect(stepTitle("bash", { command: "bun test", description: "  Run the unit tests " })).toBe("Run the unit tests");
  expect(stepTitle("powershell", { command: "Get-Date", description: "Show the date" })).toBe("Show the date");
  expect(stepTitle("bash", { command: "x", description: "Log in with password=hunter2" })).toBe("Log in with password=<redacted>");
  expect(stepTitle("bash", { command: "x", description: "Clear\u001b[2J the\nscreen" })).toBe("Clear the screen");
  expect(Array.from(stepTitle("bash", { command: "x", description: "word ".repeat(30) })!)).toHaveLength(80);
  for (const args of [{ command: "x" }, { command: "x", description: 3 }, { command: "x", description: "   " }, null]) expect(stepTitle("bash", args)).toBeUndefined();
  expect(stepTitle("read", { path: "a.ts", description: "Read a" })).toBeUndefined();
  // Never evidence: the observed input (receipts, /output, --json targets) has no title.
  expect(observationInput({ command: "bun test", description: "Run the unit tests" })).toEqual({ command: "bun test" });
});

test("rows show the title with the real program; no title keeps today's label", () => {
  const start = { type: "tool_start" as const, toolName: "bash", input: { command: "bun test" }, description: "Run the unit tests" };
  expect(formatToolActivity(start)).toBe("• Run the unit tests · bun test");
  expect(formatToolActivity({ ...start, type: "tool_end", isError: false })).toBe("✓ Run the unit tests · bun test");
  expect(formatToolActivity({ ...start, type: "tool_end", input: { command: "make" }, isError: true })).toBe("✗ Run the unit tests · make — failed");
  expect(formatToolActivity({ type: "tool_end", toolName: "bash", input: { command: "rg -n TODO" }, description: "Look for TODOs", isError: true,
    output: { text: "(no output)\n\nCommand exited with code 1", truncated: false } })).toBe("– Look for TODOs · rg TODO — nothing found");
  expect(formatToolActivity({ type: "tool_end", toolName: "bash", input: { command: "bun test" }, isError: false })).toBe("✓ bash · bun test");
});

test("the fold row lists the titles in the past tense, with a slow step's time; untitled commands keep 'ran …'", () => {
  const parts = describeSteps([
    { toolName: "bash", input: { command: "grep -n port config.yaml" }, description: "Check the port config" },
    { toolName: "bash", input: { command: "bun test" }, description: "Run the unit tests", elapsedMs: 12_000 },
    { toolName: "bash", input: { command: "git status" } },
  ]);
  expect(stepRows(parts, 120, "└", false)).toEqual(["└ Checked the port config · Ran the unit tests (12s) · ran git status"]);
  // A narrow row still names each titled step rather than only counting them.
  expect(stepRows(parts, 30, "└", false)).toEqual(["└ Checked the port config", "  Ran the unit tests (12s)", "  ran git status"]);
});

test("past tense for common verbs only: an unknown first word stays as the AI wrote it", () => {
  for (const [title, past] of [["Run the unit tests", "Ran the unit tests"], ["Check the port", "Checked the port"], ["install deps", "installed deps"],
    ["Build the app", "Built the app"], ["Stop the server", "Stopped the server"], ["Verify the fix", "Verified the fix"], ["Find old files", "Found old files"],
    ["Make a backup", "Made a backup"], ["Commit the fix", "Committed the fix"], ["Grok the logs", "Grok the logs"], ["Checked it", "Checked it"],
    ["Port check", "Port check"]]) expect(pastTense(title)).toBe(past);
});

test("live rows, plain rows, the fold and a failure box carry the title with the command; Ctrl+T keeps the full output", () => {
  const s = screen();
  s.send({ type: "tool_start", toolName: "bash", toolCallId: "1", input: { command: "bun test" }, description: "Run the unit tests" });
  expect(s.work?.rows).toContain("• Run the unit tests · bun test");
  expect(s.work?.plain).toContain("• Run the unit tests · bun test");
  s.send({ type: "tool_end", toolName: "bash", toolCallId: "1", input: { command: "bun test" }, description: "Run the unit tests", isError: false, output: { text: "1 pass", truncated: false } });
  expect(s.work?.plain).toContain("✓ Run the unit tests · bun test");
  s.send(...titled("2", "make", "Build the app", "make: *** [all] Error 2\n\nCommand exited with code 2", true), { type: "message_end" });
  expect(s.folded()).toContain("└ Ran the unit tests");
  expect(s.folded()).toContain("╭─ ✗ Build the app · make — failed");
  expect(s.view.lastStep()?.body).toContain("Error 2");
  const plain = screen(false);
  plain.send(...titled("1", "bun test", "Run the unit tests", "1 pass"), { type: "message_end" });
  expect(plain.output.join("")).toContain("✓ Run the unit tests · bun test");
});

test("plain steps: a titled command shows its title and real program, running, done and failed", () => {
  const base = { toolName: "bash", kind: "command" as const, input: { command: "bun test tests/a.test.ts" }, description: "Run the new test", startedAt: 0, line: "raw" };
  expect(plainSteps([base], 1_000)).toEqual(["• Run the new test · bun test"]);
  expect(plainSteps([{ ...base, endedAt: 1_000 }], 1_000)).toEqual(["✓ Run the new test · bun test"]);
  expect(plainSteps([{ ...base, endedAt: 1_000, failed: true, output: "(fail) a\n0 pass\n1 fail" }], 1_000)).toEqual(["✗ Run the new test · 1 of 1 tests failed"]);
});
