import { afterEach, expect, test } from "bun:test";
import { RuntimeEventView } from "../src/app/events";
import { planFold } from "../src/app/fold";
import type { DisplayLevel } from "../src/tui/display";
import type { RuntimeEvent } from "../src/runtime/types";
import { GLYPHS, glyphSet } from "../src/tui/glyphs";
import type { WorkView } from "../src/tui/surface";
import { renderFold, styleLine, type FoldView, type InteractiveTerminal } from "../src/tui/terminal";
import { activeThemeName, useTheme } from "../src/tui/theme";
import { ansiCells, cellsFor } from "./support/ansi-cells";

/** A box's top-left corner as this terminal draws it: square on the old Windows console. */
const [CORNER] = GLYPHS.corners;

const open: RuntimeEventView[] = [];
afterEach(() => { for (const view of open.splice(0)) view.reset(); });
function screen(rich = true, level: DisplayLevel = "normal") {
  let work: WorkView | undefined;
  const folds: FoldView[] = [];
  const output: string[] = [];
  const terminal = { rich, columns: 120, questionsShown: 0, questionOpen: false, endAssistant() {}, assistant() {},
    setWork(next?: WorkView) { work = next; }, writeFold(fold: FoldView) { folds.push(fold); } };
  const view = new RuntimeEventView(terminal as unknown as InteractiveTerminal, { write(text) { output.push(text); } }, {
    updateFooter() {}, onToolEnd() {}, setTaskStop() {}, markRuntimeFailed() {}, turnLimitReached() {}, cancelled: () => false,
    display: () => level, homeDir: () => "/nonexistent-home", projectRoot: () => "/repo",
  });
  open.push(view);
  return { view, output, folds, get work() { return work; }, send: (...events: RuntimeEvent[]) => { for (const event of events) view.handle(event); },
    folded: () => folds.flatMap(fold => renderFold(fold, 120, true, false)).join("\n") };
}
const shell = (id: string, command: string, text = "", isError = false): RuntimeEvent[] => [
  { type: "tool_start", toolName: "bash", toolCallId: id, input: { command } },
  { type: "tool_end", toolName: "bash", toolCallId: id, input: { command }, isError, output: { text, truncated: false } },
];
const edit = (id: string, path: string, diff: string): RuntimeEvent[] => [
  { type: "tool_start", toolName: "edit", toolCallId: id, input: { path } },
  { type: "tool_end", toolName: "edit", toolCallId: id, input: { path }, isError: false, diff, lines: { added: 1, removed: 1 } },
];
const done: RuntimeEvent = { type: "message_end" };

test("a change on another machine shows right away and stays in view, never merged into 'ran …'", () => {
  const s = screen();
  s.send(...shell("1", "ssh build-server 'sudo cp app.service /etc/systemd/system/app.service'"), ...shell("2", "git status", "clean"));
  expect(s.work?.plain?.[0]).toStartWith("◆ Changed on build-server: installed a service");
  expect(s.work?.rows).toContainEqual(expect.stringMatching(/^◆ Changed on build-server: installed a service/));
  s.send(done);
  const folded = s.folded();
  expect(folded).toContain("└ ran git status");
  expect(folded).not.toMatch(/ran [^\n]*ssh/);
  expect(folded).toContain(`${CORNER}─ ◆ Changed on build-server: installed a service`);
  expect(folded).toContain("│ sudo cp app.service /etc/systemd/system/app.service");
});

test("setup on this computer gets named rows; a plain terminal prints them under the step", () => {
  const s = screen();
  s.send(...shell("1", "npm install left-pad", "added 1 package"), ...shell("2", "git commit -m 'fix port'", "[fix-port a1b2c3d] fix port\n 1 file changed"), done);
  expect(s.folded()).toContain("◆ installed left-pad");
  expect(s.folded()).toContain('◆ committed "fix port" (a1b2c3d)');
  expect(s.folded()).not.toContain("ran npm");
  const plain = screen(false);
  plain.send(...shell("1", "git switch -c fix-port", "Switched to a new branch 'fix-port'"), done);
  expect(plain.output.join("")).toContain("✓ bash · git switch …\n◆ switched to fix-port\n");
});

test("config files get their own box with up to about 40 diff rows; lockfiles one row; code edits keep the edit box", () => {
  const long = "@@ -1,30 +1,30 @@\n" + Array.from({ length: 30 }, (_, i) => `-  \"old${i}\": 1,\n+  \"new${i}\": 2,`).join("\n");
  const s = screen();
  s.send(...edit("1", "/repo/package.json", long), ...edit("2", "/repo/src/a.ts", "@@ -1 +1 @@\n-a\n+b"), ...edit("3", "/repo/bun.lock", "@@ -1 +1 @@\n-x\n+y"), done);
  const folded = s.folded();
  expect(folded).toContain(`${CORNER}─ ◆ Changed config`);
  expect(folded).toContain("new19");
  expect(folded).not.toContain("new20");
  expect(folded).toContain("more lines · Ctrl+T shows all");
  expect(folded).toContain(`${CORNER}─ Edited 1 file`);
  expect(folded).toContain("◆ lockfile updated (bun.lock)");
  // Never folded into "edited a, b".
  expect(folded).not.toMatch(/edited [^\n]*package\.json/);
});

test("secrets in a config diff stay hidden", () => {
  const s = screen();
  s.send(...edit("1", "/repo/.env", "@@ -1 +1 @@\n-API_TOKEN=old-value-123\n+API_TOKEN=sk-live-abcdef1234567890"), done);
  expect(s.folded()).toContain(`${CORNER}─ ◆ Changed config`);
  expect(s.folded()).not.toContain("sk-live-abcdef1234567890");
});

test("at /details quiet the change rows still show, without their boxes", () => {
  const s = screen(true, "quiet");
  s.send(...shell("1", "ssh admin@sw1 'configure; set system host-name lab1; commit'"), ...edit("2", "/repo/compose.yaml", "@@ -1 +1 @@\n-a: 1\n+a: 2"), done);
  const folded = s.folded();
  expect(folded).toContain("◆ Changed on sw1: sent 3 config lines");
  expect(folded).toContain("◆ Changed config: compose.yaml");
  expect(folded).not.toContain(`${CORNER}─`);
});

test("an MCP change Casper sends is a change row with what was sent, secrets hidden", () => {
  const s = screen();
  s.view.noteChange("Changed in mist: update_site_setting", ['{ "site_id": "site-1",', '  "psk": "••••••••" }']);
  s.send(done);
  expect(s.folded()).toContain(`${CORNER}─ ◆ Changed in mist: update_site_setting`);
  expect(s.folded()).toContain("site-1");
  const plain = screen(false);
  plain.view.noteChange("Changed in mist: update_site_setting");
  expect(plain.output.join("")).toContain("◆ Changed in mist: update_site_setting\n");
});

test("the change mark is accent and bold, one column, and ASCII on the old Windows console", () => {
  const previous = activeThemeName();
  useTheme("default");
  try {
    const cells = ansiCells([styleLine("◆ Changed on sw1: sent 3 config lines", true)]);
    expect(cellsFor(cells, "◆ Changed on sw1").every(cell => cell.bold && cell.foreground === "36")).toBe(true);
  } finally { useTheme(previous); }
  expect(glyphSet("win32", {}).text("◆ installed left-pad")).toBe("# installed left-pad");
  expect(glyphSet("darwin", {}).text("◆ x")).toBe("◆ x");
  expect(planFold([], "normal").changes ?? []).toEqual([]);
});
