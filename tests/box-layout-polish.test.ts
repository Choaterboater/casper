import { expect, spyOn, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { PassThrough } from "node:stream";
import { renderPanel } from "../src/tui/presentation";
import { TerminalSurface } from "../src/tui/surface";
import { InteractiveTerminal, renderFold, styleLine, type FoldView } from "../src/tui/terminal";
import { tint } from "../src/tui/format";
import { Transcript } from "../src/tui/transcript";
import { GLYPHS } from "../src/tui/glyphs";
import { SHELL_COMMAND_CHOICES } from "../src/app/safe-choices";

const fold: FoldView = { parts: [{ verb: "read", names: ["src/a.ts"], noun: ["file", "files"], paths: true }],
  lines: [], edits: [{ path: "src/a.ts", diff: "+ added" }], editLines: 12,
  failures: [{ title: "✗ tests · 1 of 2 failed", output: "(fail) expected true" }] };

for (const width of [80, 160, 202]) test(`one left edge and one gap between model, steps, edits, crew, and boxes at ${width}`, () => {
  const t = new Transcript();
  t.commit({ render: () => ["● Building."], invalidate() {} }, "narration");
  t.commitAttachable(attached => ({ render: w => renderFold(fold, w, attached, false), invalidate() {} }));
  t.append("  [crew] Builder 1 applied its change\n", "group");
  t.commit({ render: w => renderPanel("Approval", ["Enter to choose · Esc to skip"], w - 2, false).map(row => `  ${row}`), invalidate() {} }, "group");
  const rows = t.render(width);
  expect(rows[1]).toBe("");
  expect(rows.filter(row => row.startsWith(`  ${GLYPHS.corners[0]}`)).length).toBe(3);
  expect(rows.find(row => row.includes("└ read"))).toStartWith("  └");
  expect(rows.find(row => row.includes("[crew]"))).toStartWith("  [crew]");
  expect(rows.join("\n")).not.toContain("\n\n\n");
  for (let i = 1; i < rows.length; i++) if (rows[i]!.startsWith(`  ${GLYPHS.corners[0]}`) || rows[i]!.startsWith("  [crew]")) expect(rows[i - 1]).toBe("");
  expect(Math.max(...rows.map(visibleWidth))).toBeLessThanOrEqual(Math.min(width, 122));
  expect(renderFold(fold, width, false, false)[0]).toStartWith("  ●");
});

test("a height-filling picker reserves a visible activity row above the box", async () => {
  const input = new PassThrough();
  const surface = new TerminalSurface({ input, output: { write() {}, columns: 80, rows: 24 }, color: false, onEOF() {} }, () => {}, () => {});
  try {
    surface.start();
    surface.assistant("Checking the selected change."); surface.endAssistant();
    surface.setWork({ rows: ["✓ read · example.ts"], status: "Working" });
    surface.updateCrew({ kind: "start", run: { id: 1, role: "builder", goal: "Fixture", startedAt: Date.now() } });
    const answer = surface.ask("Choose one", Array.from({ length: 20 }, (_, i) => ({ label: `Option ${i + 1}`, description: "Long description ".repeat(8) })), false);
    const frame = (surface as unknown as { tui: { render(width: number): string[] } }).tui.render(80).slice(-24);
    expect(frame.join("\n")).toContain("✓ read · example.ts");
    expect(frame.join("\n")).toContain("── Choose");
    expect(frame.join("\n")).toContain("Enter to choose · Esc to skip");
    surface.interrupt(); await answer;
  } finally { surface.close(); input.destroy(); }
});

test("wait durations use a monotonic clock even if the system clock changes", async () => {
  let mono = 1000, wall = 100000;
  const clock = spyOn(performance, "now").mockImplementation(() => mono);
  const date = spyOn(Date, "now").mockImplementation(() => wall);
  const input = new PassThrough();
  const terminal = new InteractiveTerminal(input, { write() {} }, () => {}, () => {});
  const richInput = new PassThrough();
  const surface = new TerminalSurface({ input: richInput, output: { write() {}, columns: 80, rows: 24 }, color: false, onEOF() {} }, () => {}, () => {});
  try {
    terminal.start(); surface.start(); surface.setWork({ rows: ["• command"] });
    const richAnswer = surface.ask("Choose", [{ label: "No" }, { label: "Yes" }], false);
    const picked = terminal.pick("Choose", [{ label: "No" }, { label: "Yes" }]);
    mono += 2000; wall += 3600000;
    expect(terminal.waitedMs).toBe(2000); expect(surface.waitedMs).toBe(2000);
    input.write("\n"); await picked; surface.interrupt(); await richAnswer;
    mono += 500; wall -= 7200000;
    expect(terminal.waitedMs).toBe(2000); expect(surface.waitedMs).toBe(2000);
    const line = terminal.askLine("What should change?", "Type a change");
    mono += 1000; wall += 3600000;
    expect(terminal.waitedMs).toBe(3000);
    input.write("quieter\n"); expect(await line).toBe("quieter");
    expect(terminal.waitedMs).toBe(3000);
  } finally { terminal.close(); surface.close(); input.destroy(); richInput.destroy(); clock.mockRestore(); date.mockRestore(); }
});

test("shell descriptions explain the same safe order briefly", () => {
  expect(SHELL_COMMAND_CHOICES.map(row => row.description)).toEqual(["the command does not run", "only this time", "until you quit", "always in this project", "every command and question; /permissions ask undoes it"]);
});

test("a builder's inline command uses the same frame and routes typed words as a No with direction", async () => {
  const input = new PassThrough();
  const surface = new TerminalSurface({ input, output: { write() {}, columns: 80, rows: 30 }, color: false, onEOF() {} }, () => {}, () => {});
  const directions: string[] = [];
  surface.setBusySubmit(text => { directions.push(text); return true; });
  try {
    surface.start();
    const answer = surface.ask("Builder 1 wants to run: custom-tool --check", [...SHELL_COMMAND_CHOICES], false, undefined, "casper", false);
    input.write("use the fixture instead");
    const rows = (surface as unknown as { tui: { render(width: number): string[] } }).tui.render(80);
    expect(rows.join("\n")).toContain("Builder 1 wants to run:");
    expect(rows.join("\n")).toContain(`${GLYPHS.corners[0]}─ Command`);
    expect(rows.join("\n")).toContain("❯ 1. No — use the fixture instead");
    input.write("\r");
    expect(await answer).toEqual(["No"]);
    expect(directions).toEqual(["use the fixture instead"]);
  } finally { surface.close(); input.destroy(); }
});

test("neutral notes are dim, not warning or failure colours", () => {
  expect(styleLine("– read · guessed.ts — path not found", true)).toBe(tint("– read · guessed.ts — path not found", "muted", true));
});

for (const color of [true, false]) test(`activity stays above an open box; no empty question input row (color=${color})`, async () => {
  const input = new PassThrough();
  const surface = new TerminalSurface({ input, output: { write() {}, columns: 160, rows: 45 }, color, onEOF() {} }, () => {}, () => {});
  try {
    surface.start();
    surface.assistant("Preparing the next step."); surface.endAssistant();
    surface.setWork({ rows: ["✓ read · src/a.ts", "– read · guessed.ts — path not found"], status: "Working" });
    const answer = surface.ask("Run this command?\nThe model says: First context. Check the result.\nprintf first\nprintf second", [
      { label: "No", description: "nothing runs" }, { label: "Yes, this once", description: "only this time" },
    ], false, undefined, "approval");
    const rows = (surface as unknown as { tui: { render(width: number): string[] } }).tui.render(160);
    const text = rows.map(Bun.stripANSI).join("\n");
    expect(text.indexOf("✓ read")).toBeLessThan(text.indexOf("── Approval"));
    expect(text).toContain("The model says: Check the result.");
    expect(text).toContain(`${GLYPHS.corners[0]}─ Command`);
    expect(text).toContain("│ printf first"); expect(text).toContain("│ printf second");
    expect(text).toContain("❯ 1. No");
    expect(text).not.toMatch(/^\s*\?\s*$/m);
    expect(text).not.toContain("\n\n\n");
    const rule = rows.find(row => Bun.stripANSI(row).includes("── Approval"))!;
    expect(visibleWidth(rule)).toBe(122);
    if (color) expect(rows.find(row => row.includes("guessed.ts"))).toBe(tint("  – read · guessed.ts — path not found", "muted", true));
    surface.interrupt(); await answer;
  } finally { surface.close(); input.destroy(); }
});
