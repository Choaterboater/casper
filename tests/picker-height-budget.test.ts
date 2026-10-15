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

test("a long typed refusal has a bounded preview but submits the entire comment as No", async () => {
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
      expect(Bun.stripANSI(lines.join("\n"))).toContain("❯ 1. No");
      expect(lines.join("\n")).not.toContain("final-comment-marker");
    }
    session.input.write("\r");
    expect(await answer).toBe("No");
    // The closed approval's record keeps the unabridged refusal, not its inline preview.
    const transcript = (session.surface as unknown as { transcript: { render(width: number): string[] } }).transcript;
    expect(Bun.stripANSI(transcript.render(200).join("\n"))).toContain("final-comment-marker");
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
    for (const height of [10, 14, 18, 27]) {
      const lines = Bun.stripANSI(session.render(80, height).join("\n")).split("\n");
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines[2]).toStartWith(`${GLYPHS.corners[0]}─ Command `);
      const preview = lines.filter(line => line.startsWith("│ ")).map(line => line.slice(2, -2).trimEnd());
      const shown = preview.filter(line => /^custom-step-\d+$/.test(line));
      expect(shown).toEqual(Array.from({ length: shown.length }, (_, index) => `custom-step-${index + 1}`));
      const footers = preview.filter(line => /^… \d+ more lines$/.test(line));
      expect(footers).toEqual([`… ${20 - shown.length} more lines`]);
    }
    session.input.write("\r"); expect(await answer).toBe("No");
  } finally { session.close(); }
});
