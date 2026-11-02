import { afterAll, expect, spyOn, test } from "bun:test";
import { RuntimeEventView } from "../src/app/events";
import { expandLastStep } from "../src/app/footer";
import type { RuntimeEvent } from "../src/runtime/types";
import type { InteractiveTerminal } from "../src/tui/terminal";

/** From a live session: each Ctrl+T printed the same finished step's whole output again ("── bash · curl
 * http://192.0.2.31:8000/ … ──", three times in a row) while the step running then, a curl for 36 s, showed nothing.
 * Ctrl+T shows the running step's output so far and each finished step not shown yet, and never a block again. */

let clock = 1_000;
const spy = spyOn(performance, "now").mockImplementation(() => clock);
afterAll(() => spy.mockRestore());

function session() {
  const panels: Array<{ title: string; body: string }> = [];
  const notes: string[] = [];
  const lines: string[] = [];
  const terminal = { rich: true, columns: 120, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {}, setWork() {}, writeFold() {},
    flashNote(text: string) { notes.push(text); }, write(text: string) { lines.push(text); },
    writePanel(title: string, body: string) { panels.push({ title, body }); } };
  const events = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write(text) { lines.push(text); } }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
    projectRoot: () => "/work/app", homeDir: () => "/nonexistent-home" });
  const press = () => { const before = panels.length; notes.length = 0; expandLastStep({ events, terminal } as never); return panels.slice(before); };
  const handle = (...list: RuntimeEvent[]) => { for (const event of list) { events.handle(event); clock += 100; } };
  return { events, panels, notes, lines, press, handle };
}

const PAGE = "curl -s http://192.0.2.31:8000/";
const PHOTO = "curl -s http://192.0.2.31:8000/photos/sample_0.webp";
const start = (id: string, command: string): RuntimeEvent => ({ type: "tool_start", toolName: "bash", toolCallId: id, input: { command } });
const end = (id: string, command: string, text: string, isError = false): RuntimeEvent =>
  ({ type: "tool_end", toolName: "bash", toolCallId: id, input: { command }, isError, output: { text, truncated: false } });
const progress = (id: string, text: string): RuntimeEvent => ({ type: "tool_progress", toolName: "bash", toolCallId: id, text });

test("Ctrl+T during a running command shows its output so far, after the finished step not shown yet", () => {
  const s = session();
  try {
    s.handle(start("1", PAGE), end("1", PAGE, "page 200"), start("2", PHOTO), progress("2", "photo 1 of 3\nphoto 2 of 3\n"));
    clock += 36_000;
    const shown = s.press();
    expect(shown.map(panel => panel.body)).toEqual(["page 200", "photo 1 of 3\nphoto 2 of 3"]);
    expect(shown[1]!.title).toContain("photos/sample_0.webp");
    expect(shown[1]!.title).toContain("running");
  } finally { s.events.reset(); }
});

test("Ctrl+T again with nothing new prints no block again, only a short note; new output shows alone", () => {
  const s = session();
  try {
    s.handle(start("1", PAGE), end("1", PAGE, "page 200"), start("2", PHOTO));
    expect(s.press().map(panel => panel.body)).toEqual(["page 200"]);
    // The running step has printed nothing yet: no block, and the note says so.
    for (let i = 0; i < 3; i++) {
      expect(s.press()).toEqual([]);
      expect(s.notes).toHaveLength(1);
      expect(s.notes[0]).toMatch(/no output yet|Nothing new/);
    }
    s.handle(progress("2", "photo 1 of 3\n"));
    expect(s.press().map(panel => panel.body)).toEqual(["photo 1 of 3"]);
    expect(s.press()).toEqual([]);
    expect(s.notes).toEqual(["Nothing new since the last Ctrl+T"]);
    s.handle(progress("2", "photo 1 of 3\nphoto 2 of 3\n"));
    expect(s.press().map(panel => panel.body)).toEqual(["photo 2 of 3"]);
    // It ends: only what it printed after the last Ctrl+T.
    s.handle(end("2", PHOTO, "photo 1 of 3\nphoto 2 of 3\nphoto 3 of 3\n\n\nCommand timed out after 60 seconds", true));
    const rest = s.press();
    expect(rest.map(panel => panel.body)).toEqual(["photo 3 of 3\n\n\nCommand timed out after 60 seconds"]);
    expect(s.press()).toEqual([]);
    expect(s.notes).toEqual(["Nothing new since the last Ctrl+T"]);
    // Casper's notes never go to the transcript as amber or red lines.
    expect(s.lines.join("")).not.toMatch(/[✗!]/);
  } finally { s.events.reset(); }
});

test("finished steps not shown yet are shown once each, oldest first; the last one stays the step Ctrl+T knows", () => {
  const s = session();
  try {
    s.handle(start("1", "ls"), end("1", "ls", "a.txt"), start("2", "cat a.txt"), end("2", "cat a.txt", "hello"), start("3", "false"), end("3", "false", "boom", true));
    expect(s.press().map(panel => panel.body)).toEqual(["a.txt", "hello", "boom"]);
    expect(s.press()).toEqual([]);
    expect(s.events.lastStep()?.body).toBe("boom");
    s.handle(start("4", "echo done"), end("4", "echo done", "done"));
    expect(s.press().map(panel => panel.body)).toEqual(["done"]);
  } finally { s.events.reset(); }
});

test("when the screen says what Ctrl+T shows (a check's log, a plan's details), Ctrl+T shows that, not older steps first", () => {
  const s = session();
  try {
    s.handle(start("1", "ls"), end("1", "ls", "a.txt"));
    s.events.showOnExpand({ title: "test: output", body: "1 fail", diff: false });
    expect(s.press().map(panel => panel.body)).toEqual(["1 fail"]);
    s.events.showOnExpand({ title: "test: output", body: "1 fail", diff: false });
    expect(s.press()).toEqual([]);
    expect(s.notes).toEqual(["Nothing new since the last Ctrl+T"]);
  } finally { s.events.reset(); }
});
