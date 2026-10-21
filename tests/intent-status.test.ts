import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND } from "../src/app/prompt";
import { intentLine, RuntimeEventView } from "../src/app/events";
import type { RuntimeEvent } from "../src/runtime/types";
import { statusWords, TerminalSurface, type WorkView } from "../src/tui/surface";
import type { InteractiveTerminal } from "../src/tui/terminal";
import { waitUntil } from "./support/wait";

const open: Array<{ reset(): void }> = [];
afterEach(() => { for (const view of open.splice(0)) view.reset(); });
function screen(rich = true) {
  let work: WorkView | undefined;
  const output: string[] = [];
  const terminal = { rich, columns: 120, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {},
    setWork(next?: WorkView) { work = next; }, writeFold() {} };
  const view = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write(text) { output.push(text); } }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
  });
  open.push(view);
  return { get work() { return work; }, output, send: (...events: RuntimeEvent[]) => { for (const event of events) view.handle(event); } };
}
const words = (delta: string): RuntimeEvent => ({ type: "assistant_text_delta", delta });
const start = (id: string, command: string): RuntimeEvent => ({ type: "tool_start", toolName: "bash", toolCallId: id, input: { command } });
const end = (id: string, command: string): RuntimeEvent => ({ type: "tool_end", toolName: "bash", toolCallId: id, input: { command }, isError: false, output: { text: "ok", truncated: false } });

test("full and lean guidance ask for one line before each group of tool calls and one line after a change; the no-recap rule is the final answer's", () => {
  expect(DEFAULT_SYSTEM_PROMPT_APPEND).toContain("Before each group of tool calls, write one short line: what you'll do and why.");
  expect(DEFAULT_SYSTEM_PROMPT_APPEND).toContain("In the final answer, lead with answer, result or next action; no unasked checklist or recap.");
  expect(DEFAULT_SYSTEM_PROMPT_APPEND).toContain("After that or any change to config, a device or another machine, say in one line what changed.");
  expect(LEAN_SYSTEM_PROMPT_APPEND).toContain("Before tools: one line, what/why.");
  expect(LEAN_SYSTEM_PROMPT_APPEND).toContain("Final answer: Lead with answer/result/action, no unasked recap/checklist.");
  expect(LEAN_SYSTEM_PROMPT_APPEND).toContain("Enable/switch as asked; report config/device/remote changes.");
  // No line still asks for no recap without saying it is about the final answer.
  for (const prompt of [DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND]) {
    for (const line of prompt.split("\n").filter(line => /unasked (?:checklist|recap)/.test(line))) expect(line).toMatch(/final answer/i);
  }
});

test("the AI's last line before a group of tool calls leads the status row until its next words fold the group", () => {
  const s = screen();
  // A group with no words before it has no intent.
  s.send(start("0", "git status"));
  expect(s.work?.intent).toBeUndefined();
  s.send(end("0", "git status"), words("I read the test file.\n**Fixing the port test:**"), start("1", "bun test tests/port.test.ts"));
  expect(s.work?.intent).toBe("Fixing the port test");
  expect(s.work?.status).toStartWith("Running tests (1 file)");
  // A second call in the same group keeps it.
  s.send(start("2", "git status"));
  expect(s.work?.intent).toBe("Fixing the port test");
  // The next words fold the group: the wait after them has no intent of the old group.
  s.send(end("1", "bun test tests/port.test.ts"), end("2", "git status"), words("Then the lint.\n"), { type: "assistant_request_start" });
  expect(s.work?.status).toStartWith("Waiting for");
  expect(s.work?.intent).toBeUndefined();
  s.send(start("3", "bunx oxlint"));
  expect(s.work?.intent).toBe("Then the lint");
});

test("an intent line is one plain line: its last sentence, markdown marks off, secrets hidden, controls neutral", () => {
  expect(intentLine("Checked the config. Restarting the service with password=hunter2.")).toBe("Restarting the service with password=<redacted>");
  expect(intentLine("Plan:\n- **Run** the `unit` tests…\n\n")).toBe("Run the unit tests");
  expect(intentLine("## Next step\u001b[2J")).toBe("Next step");
  expect(intentLine("   \n  ")).toBeUndefined();
  expect(intentLine("Ok.")).toBeUndefined();
  expect(intentLine(`Now ${"very ".repeat(40)}long.`)!.length).toBeLessThanOrEqual(101);
});

test("the plain terminal has no status row: an intent changes nothing it prints", () => {
  const s = screen(false);
  s.send(words("Fixing the port test.\n"), start("1", "bun test"));
  expect(s.work).toBeUndefined();
  expect(s.output.join("")).not.toContain("Fixing the port test");
});

test("the status row's words: the intent first, dropped first when narrow; the activity is cut only when alone it does not fit", () => {
  const words = (status: string, intent: string | undefined, room: number) => Bun.stripANSI(statusWords(status, intent, room));
  expect(words("Running bun test · 4s", "Fixing the port test", 60)).toBe("Fixing the port test · Running bun test · 4s");
  // Too little room for a useful intent: the activity alone.
  expect(words("Running bun test · 4s", "Fixing the port test", 30)).toBe("Running bun test · 4s");
  expect(words("Running bun test · 4s", "Fixing the port test", 12)).toBe("Running bun…");
  expect(words("Running bun test · 4s", "Fixing the flaky port test in the server", 40)).toBe("Fixing the flak… · Running bun test · 4s");
  expect(words("Running bun test · 4s", undefined, 60)).toBe("Running bun test · 4s");
});

/** The status row a real surface draws at this width, polled until it shows `expected`. */
async function statusRow(columns: number, view: WorkView, expected: RegExp): Promise<string> {
  const chunks: string[] = [];
  const surface = new TerminalSurface({ input: new PassThrough(), output: { write: (text: string) => { chunks.push(text); }, columns, rows: 20 },
    color: false, onEOF: () => {} }, () => {}, () => {});
  try {
    surface.start();
    surface.setWork(view);
    expect(await waitUntil(() => expected.test(Bun.stripANSI(chunks.join(""))), 5_000)).toBe(true);
    expect(surface.workView).toEqual(view);
    return Bun.stripANSI(chunks.join(""));
  } finally { surface.close(); }
}

test("on screen the status row reads intent · activity · Esc stops, and a narrow window drops the intent, never Esc stops", async () => {
  const view = { rows: [], status: "Running bun test · 4s", intent: "Fixing the port test" };
  await statusRow(70, view, /\S Fixing the port test · Running bun test · 4s · Esc stops/);
  const narrow = await statusRow(40, view, /\S Running bun test · 4s · Esc stops/);
  expect(narrow).not.toContain("Fixing the port test");
});
