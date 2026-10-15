import { afterAll, expect, spyOn, test } from "bun:test";
import { PassThrough } from "node:stream";
import { RuntimeEventView } from "../src/app/events";
import { foundNothing, plainSteps, type PlainStep } from "../src/app/plain-steps";
import type { RuntimeEvent } from "../src/runtime/types";
import { TerminalSurface, type WorkView } from "../src/tui/surface";
import type { InteractiveTerminal } from "../src/tui/terminal";

let clock = 1_000;
const spy = spyOn(performance, "now").mockImplementation(() => clock);
afterAll(() => spy.mockRestore());

/** The event view against a terminal that keeps the last work view (raw rows and plain lines). */
function view(commands: Record<string, string> = { test: "bun test" }) {
  let work: WorkView | undefined;
  const terminal = { rich: true, columns: 100, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {},
    setWork(next?: WorkView) { work = next; }, write() {}, writeFold() {} };
  const events = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write() {} }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
    projectRoot: () => "/work/app", projectCommands: () => commands });
  return { events, get plain() { return work?.plain; }, get rows() { return work?.rows; },
    handle: (...list: RuntimeEvent[]) => { for (const event of list) events.handle(event); } };
}
const start = (id: string, toolName: string, input: Record<string, string>): RuntimeEvent => ({ type: "tool_start", toolName, toolCallId: id, input });
const end = (id: string, toolName: string, input: Record<string, string>, output?: string, isError = false): RuntimeEvent =>
  ({ type: "tool_end", toolName, toolCallId: id, input, isError, ...(output ? { output: { text: output, truncated: false } } : {}) });

test("searches and reads share one line that counts them, updated in place, with what found nothing and the time", () => {
  clock = 1_000;
  const s = view();
  s.handle(start("1", "grep", { pattern: "foo" }));
  expect(s.plain).toEqual(["• Looking through the code: 1 search"]);
  s.handle(end("1", "grep", { pattern: "foo" }, "No matches found"), start("2", "read", { path: "/work/app/a.ts" }), end("2", "read", { path: "/work/app/a.ts" }));
  s.handle(start("3", "find", { pattern: "*.ts" }), end("3", "find", { pattern: "*.ts" }, "a.ts"));
  s.handle(start("4", "read", { path: "/work/app/b.ts" }));
  clock += 120_000;
  s.handle({ type: "tool_progress", toolName: "read", toolCallId: "4", text: "" });
  s.handle(end("4", "read", { path: "/work/app/b.ts" }));
  expect(s.plain).toEqual(["– grep · foo — nothing found", "✓ Looked through the code: 1 search, 2 files read (2m)"]);
  // The raw steps are still there for Ctrl+O and the steps pane.
  expect(s.rows).toHaveLength(4);
  expect(s.rows![0]).toStartWith("– grep");
  s.events.reset();
});

test("edits share one line and each command gets a short one: the project's test command reads Ran tests", () => {
  clock = 1_000;
  const s = view();
  s.handle(start("1", "edit", { path: "/work/app/site/roadmap.html" }), end("1", "edit", { path: "/work/app/site/roadmap.html" }));
  s.handle(start("2", "bash", { command: "bun test" }));
  expect(s.plain).toEqual(["✓ Edited site/roadmap.html", "• Running tests"]);
  s.handle(end("2", "bash", { command: "bun test" }), start("3", "write", { path: "/work/app/faq.html" }), end("3", "write", { path: "/work/app/faq.html" }));
  s.handle(start("4", "bash", { command: "git status" }), end("4", "bash", { command: "git status" }));
  s.handle(start("5", "bash", { command: "bun run lint" }), end("5", "bash", { command: "bun run lint" }, "1 error", true));
  expect(s.plain).toEqual(["✓ Edited site/roadmap.html, faq.html", "✓ Ran tests", "✓ Ran git status", "✗ Lint failed"]);
  s.events.reset();
});

test("a failed edit tried again at once is left out; one that stays failed says so; a refused step keeps its line", () => {
  const steps: PlainStep[] = [
    { toolName: "edit", kind: "edit", path: "a.py", startedAt: 0, endedAt: 1, failed: true, retried: true, line: "✗ edit · a.py — failed" },
    { toolName: "edit", kind: "edit", path: "a.py", startedAt: 1, endedAt: 2, line: "✓ edit · a.py" },
    { toolName: "edit", kind: "edit", path: "b.py", startedAt: 2, endedAt: 3, failed: true, line: "✗ edit · b.py — failed" },
    { toolName: "bash", kind: "command", input: { command: "cat ~/.ssh/config" }, startedAt: 3, endedAt: 3, notRun: true, line: "○ bash · cat ~/.ssh/config — not run" },
  ];
  expect(plainSteps(steps, 10)).toEqual(["✓ Edited a.py", "✗ Couldn't edit b.py", "○ bash · cat ~/.ssh/config — not run"]);
  expect(foundNothing("No files found matching pattern")).toBe(true);
  expect(foundNothing("(empty directory)")).toBe(true);
  expect(foundNothing("src/a.ts:1: foo")).toBe(false);
});

test("Ctrl+O shows the raw steps and back; Ctrl+T is untouched", async () => {
  const chunks: string[] = [];
  const input = new PassThrough();
  const surface = new TerminalSurface({ input, output: { write: (text: string) => { chunks.push(text); }, columns: 80, rows: 24 },
    color: false, onEOF: () => {} }, () => {}, () => {});
  let expanded = 0;
  try {
    surface.start();
    surface.setExpandLast(() => { expanded++; });
    surface.setWork({ rows: ["✓ grep · foo", "✓ read · a.ts"], plain: ["✓ Looked through the code: 1 search, 1 file read"], status: "Working" });
    await Bun.sleep(30);
    expect(Bun.stripANSI(chunks.join(""))).toContain("Looked through the code");
    expect(surface.rawStepsShown).toBe(false);
    chunks.length = 0;
    input.write("\x0f");
    await Bun.sleep(30);
    expect(surface.rawStepsShown).toBe(true);
    expect(Bun.stripANSI(chunks.join(""))).toContain("read · a.ts");
    input.write("\x0f");
    await Bun.sleep(20);
    expect(surface.rawStepsShown).toBe(false);
    input.write("\x14");
    await Bun.sleep(20);
    expect(expanded).toBe(1);
  } finally { surface.close(); }
});

test("Ctrl+X turns writes off even while a picker is open; with nothing on, the picker keeps its own Ctrl+X", async () => {
  const input = new PassThrough();
  const surface = new TerminalSurface({ input, output: { write: () => {}, columns: 80, rows: 24 }, color: false, onEOF: () => {} }, () => {}, () => {});
  try {
    surface.start();
    surface.setStatus("project/main │ idle", process.cwd());
    let on = true;
    let reverts = 0;
    surface.setWritesRevert(() => { reverts++; const was = on; on = false; return was; });
    const picker: string[] = [];
    const host = surface.exclusiveHost()!;
    const done = host.mount(async (view) => {
      const component = { render: () => ["picker"], invalidate() {}, handleInput(data: string) { picker.push(data); } };
      view.show(component);
      view.tui.setFocus(component);
      input.write("\x18");
      await Bun.sleep(30);
      expect(reverts).toBe(1);
      expect(surface.footerLine(80)).toContain("Writes are off now");
      expect(picker).toEqual([]);
      input.write("\x18");
      await Bun.sleep(30);
      expect(reverts).toBe(2);
      expect(picker).toEqual(["\x18"]);
    });
    await done;
  } finally { surface.close(); }
});
