import { expect, test } from "bun:test";
import { SHELL_COMMAND_CHOICES } from "../src/app/safe-choices";
import { shellQuestion } from "../src/app/sandbox";
import { GLYPHS } from "../src/tui/glyphs";
import { activeThemeName, BUILT_IN_THEMES, useTheme } from "../src/tui/theme";
import { ansiCells, cellsFor, cellSnapshot, type Cell } from "./support/ansi-cells";
import { withEnv } from "./support/env";
import { interactiveTerminal } from "./support/tty";

/** Rendered rows must occur in the actual writer's bytes before they become colour evidence. */
async function approval(assert: (cells: Cell[][], rows: string[]) => void, { theme = "default", noColor = false, width = 202, long = false } = {}) {
  await withEnv({ TERM: "xterm-256color", NO_COLOR: noColor ? "1" : undefined }, async () => {
    const previous = activeThemeName();
    useTheme(theme);
    const f = interactiveTerminal();
    f.screen.writer.columns = width; f.screen.writer.rows = 45;
    let answer: Promise<string | undefined> | undefined;
    try {
      f.terminal.start();
      const command = long ? Array.from({ length: 30 }, (_, i) => `printf line-${i}`).join("\n") : "custom-tool --check\nprintf first";
      answer = f.terminal.pick(shellQuestion(command), [...SHELL_COMMAND_CHOICES]);
      await f.screen.until(text => text.includes("Enter to choose · Esc to skip"));
      const rows = (f.terminal as unknown as { surface: { tui: { render(width: number): string[] } } }).surface.tui.render(width);
      // Cursor redraws wrap the rows, but their SGR bytes come from the real terminal, not substitute tints.
      for (const row of rows.filter(row => row.trim())) expect(f.screen.output).toContain(row);
      assert(ansiCells(rows), rows);
    } finally {
      f.terminal.interrupt(); await answer; f.close(); useTheme(previous);
    }
  });
}

const dim = (cells: Cell[][], text: string) => expect(cellsFor(cells, text).every(cell => cell.dim)).toBe(true);

test("approval choice descriptions 'the command does not run' and 'only this time' render dim", async () => {
  for (const theme of BUILT_IN_THEMES) await approval(cells => {
    dim(cells, "the command does not run"); dim(cells, "only this time");
  }, { theme: theme.name });
});

test("the approval Command frame renders dim", async () => {
  for (const theme of BUILT_IN_THEMES) await approval((cells, rows) => {
    const frame = rows.flatMap((row, index) => row.includes("Command ") || row.includes("│ custom-tool") || row.includes(GLYPHS.corners[2]) ? [cells[index]!] : []);
    expect(frame).toHaveLength(3);
    for (const row of frame) expect(row.slice(2).every(cell => cell.dim)).toBe(true);
  }, { theme: theme.name });
});

test("the approval 'Enter to choose · Esc to skip' hint renders dim", async () => {
  for (const theme of BUILT_IN_THEMES) await approval(cells => {
    const hint = cellsFor(cells, "Enter to choose · Esc to skip");
    expect(hint.every(cell => cell.dim)).toBe(true);
    expect(cellSnapshot([hint])).toBe('[dim]"Enter to choose · Esc to skip"');
  }, { theme: theme.name });
});

test("NO_COLOR keeps the rendered approval box plain", async () => {
  for (const theme of BUILT_IN_THEMES) await approval(cells => {
    for (const cell of cells.flat()) expect(cell).toMatchObject({ foreground: "default", background: "default", dim: false, bold: false, inverse: false });
    for (const text of ["the command does not run", "only this time", "Command", "Enter to choose · Esc to skip"]) expect(cellsFor(cells, text).length).toBeGreaterThan(0);
  }, { theme: theme.name, noColor: true });
});

test("raw ANSI from a rendered approval preserves dim after selected-label resets and on capped command rows", async () => {
  for (const width of [80, 160, 202]) await approval((cells, rows) => {
    const selected = rows.findIndex(row => row.includes("the command does not run"));
    dim(cells, "the command does not run");
    expect(cellsFor([cells[selected]!], "No").every(cell => !cell.dim && cell.foreground !== "default")).toBe(true);
    const omitted = rows.findIndex(row => row.includes("more lines"));
    expect(omitted).toBeGreaterThanOrEqual(0);
    expect(cells[omitted]!.slice(2).every(cell => cell.dim)).toBe(true);
    dim(cells, "Enter to choose · Esc to skip");
  }, { width, theme: "high-contrast", long: true });
});
