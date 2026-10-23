import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { visibleWidth } from "@earendil-works/pi-tui";
import { shellQuestion } from "../src/app/sandbox";
import { SHELL_COMMAND_CHOICES } from "../src/app/safe-choices";
import { GLYPHS } from "../src/tui/glyphs";
import { SettingsScreen, type ScreenSetting } from "../src/tui/settings-screen";
import { TerminalSurface } from "../src/tui/surface";

function box(color = false) {
  const input = new PassThrough();
  const surface = new TerminalSurface({ input, output: { columns: 80, rows: 30, write() {} }, color, onEOF() {} }, () => {}, () => {});
  surface.start();
  // Measure the live box's rendered rows independently of the transcript and terminal redraw protocol.
  const render = (width: number, height: number) => (surface as unknown as { renderAsk(w: number, h: number): string[] }).renderAsk(width, height);
  return { input, surface, render, close() { surface.close(); input.destroy(); } };
}

test.each([24, 40, 80])("wrapped settings options respect the row budget and retain the selected theme at %i columns", width => {
  const theme: ScreenSetting = { label: "Theme", value: "default", keep: "Keep default", question: "Choose the screen colours.",
    choices: Array.from({ length: 15 }, (_, index) => ({ value: index, label: `Colour ${index} ${"long theme name ".repeat(10)}`,
      description: "A detailed explanation of these colours. ".repeat(10) })) };
  const screen = new SettingsScreen([theme], false, async () => ({ rows: [theme], note: "" }), () => {}, () => {}, () => 18);
  screen.render(width); screen.handleInput("Theme"); screen.handleInput("\r");
  for (let selected = 0; selected < 16; selected++) {
    const lines = screen.render(width);
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(lines[1]).toBe("Settings · saved for you");
    expect(lines.join("\n")).toContain(selected ? `❯ ${String(selected + 1).padStart(2)}. Colour ${selected - 1}` : "❯  1. Keep default");
    expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).not.toContain("\x1b");
    screen.handleInput("\x1b[B");
  }
});

test("a long typed refusal stays in its box with its end in view, where the letters go, and submits the entire comment as No", async () => {
  const session = box();
  const comment = "Please do not run this command ".repeat(200) + "final-comment-marker";
  try {
    const answer = session.surface.approve("", shellQuestion("custom-tool --check", "Check the output."), [...SHELL_COMMAND_CHOICES]);
    session.input.write(comment);
    for (const width of [20, 40, 80]) for (const height of [6, 10, 18]) {
      const lines = session.render(width, height);
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
      expect(Bun.stripANSI(lines.join("\n"))).toContain("Run this command?");
      // The start gives way to "…"; the end, where typing goes on, shows (a word wider than the row breaks in two).
      expect(Bun.stripANSI(lines.join("\n"))).toContain("❯ 1. No —");
      expect(Bun.stripANSI(lines.join("")).replace(/\s+/g, "")).toMatch(/No—….*marker/);
    }
    session.input.write("\r");
    expect(await answer).toBe("No");
    // The closed approval's record keeps the unabridged refusal, not its inline preview.
    const transcript = (session.surface as unknown as { transcript: { render(width: number): string[] } }).transcript;
    expect(Bun.stripANSI(transcript.render(200).join("\n"))).toContain("final-comment-marker");
  } finally { session.close(); }
});

test("a long answer typed on the Other row fits every budget, its end in view, and is sent whole", async () => {
  const session = box();
  const typed = "Please keep the parser change small ".repeat(60) + "final-answer-marker";
  try {
    const answer = session.surface.ask("How far should I take this now?", [{ label: "Just the fix", description: "the smallest change" }, { label: "Stop here" }],
      false, undefined, "ai");
    session.input.write(typed);
    for (const width of [20, 30, 40, 80]) for (const height of [1, 2, 3, 6, 10, 18]) {
      const lines = session.render(width, height);
      const text = Bun.stripANSI(lines.join("\n"));
      expect({ width, height, rows: lines.length <= height, wide: lines.every(line => visibleWidth(line) <= width) })
        .toEqual({ width, height, rows: true, wide: true });
      // A word wider than the row breaks in two, so the end is looked for across rows.
      const end = Bun.stripANSI(lines.join("")).replace(/\s+/g, "").includes("…") && text.replace(/\s+/g, "").includes("marker");
      expect({ width, height, row: text.includes("❯ 3. Other"), end }).toEqual({ width, height, row: true, end: true });
    }
    // One row, too narrow for words after the whole label: the label keeps its first word.
    expect(Bun.stripANSI(session.render(40, 1).join("\n"))).toBe("❯ 3. Other — …small final-answer-marker");
    session.input.write("\r");
    expect(await answer).toEqual([typed]);
  } finally { session.close(); }
});

test("even the selected option's wrapped label and description fit a tiny remaining budget", async () => {
  const session = box();
  try {
    const label = "Selected option with lots of text ".repeat(100);
    const answer = session.surface.ask("Keep this context visible?", [{ label, description: "Long description ".repeat(100) }, { label: "Other option" }], false);
    for (const height of [1, 2, 3, 6, 10]) {
      const lines = session.render(30, height);
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(Bun.stripANSI(lines.join("\n"))).toContain("❯ 1.");
      expect(Bun.stripANSI(lines.join("\n"))).toContain("…");
    }
    session.input.write("\r"); expect(await answer).toEqual([label]);
  } finally { session.close(); }
});

test("shrinking a command preview adds newly omitted logical lines to its original footer", async () => {
  const session = box();
  try {
    const command = Array.from({ length: 20 }, (_, index) => `custom-step-${index + 1}`).join("\n");
    const answer = session.surface.approve("", shellQuestion(command, "Check the steps."), [...SHELL_COMMAND_CHOICES]);
    // The shell box has five choices: from 11 rows its command frame stays (one more choice, one more row).
    for (const height of [11, 14, 18, 27]) {
      const lines = Bun.stripANSI(session.render(80, height).join("\n")).split("\n");
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines[2]).toStartWith(`${GLYPHS.corners[0]}─ Command `);
      const preview = lines.filter(line => line.startsWith("│ ")).map(line => line.slice(2, -2).trimEnd());
      const shown = preview.filter(line => /^custom-step-\d+$/.test(line));
      expect(shown.slice(-3)).toEqual(["custom-step-18", "custom-step-19", "custom-step-20"]);
      expect(shown.slice(0, -3)).toEqual(Array.from({ length: shown.length - 3 }, (_, index) => `custom-step-${index + 1}`));
      const footers = preview.filter(line => /^… \d+ more lines$/.test(line));
      expect(footers).toEqual([`… ${20 - shown.length} more lines`]);
    }
    session.input.write("\r"); expect(await answer).toBe("No");
  } finally { session.close(); }
});
