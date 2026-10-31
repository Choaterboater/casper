import { expect, test } from "bun:test";
import { SHELL_COMMAND_CHOICES } from "../src/app/safe-choices";
import { shellQuestion } from "../src/app/sandbox";
import { activeThemeName, BUILT_IN_THEMES, useTheme } from "../src/tui/theme";
import { ansiCells, cellsFor, type Cell } from "./support/ansi-cells";
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
      await f.screen.until(text => text.includes("4. Yes to everything this session"));
      const rows = (f.terminal as unknown as { surface: { tui: { render(width: number): string[] } } }).surface.tui.render(width);
      // Cursor redraws wrap the rows, but their SGR bytes come from the real terminal, not substitute tints.
      for (const row of rows.filter(row => row.trim())) expect(f.screen.output).toContain(row);
      assert(ansiCells(rows), rows);
    } finally {
      f.terminal.interrupt(); await answer; f.close(); useTheme(previous);
    }
  });
}

test("approval rows are plain labels: no dim explanations beside them, and No (selected) is not dim", async () => {
  for (const theme of BUILT_IN_THEMES) await approval((cells, rows) => {
    for (const gone of ["the command does not run", "only this time", "until you quit"]) expect(rows.join("\n")).not.toContain(gone);
    const selected = rows.findIndex(row => Bun.stripANSI(row).includes("1. No"));
    expect(cellsFor([cells[selected]!], "No").every(cell => !cell.dim && cell.foreground !== "default")).toBe(true);
  }, { theme: theme.name });
});

test("the approval Command frame renders dim", async () => {
  for (const theme of BUILT_IN_THEMES) await approval((cells, rows) => {
    // An open box: the title rule, the command at the left edge with nothing beside it, the closing rule.
    const top = rows.findIndex(row => row.includes("Command "));
    const end = rows.findIndex((row, index) => index > top && /^─+$/.test(Bun.stripANSI(row).trim()));
    expect(Bun.stripANSI(rows[top + 1]!)).toStartWith("custom-tool");
    expect(end).toBeGreaterThan(top + 1);
    const frame = rows.slice(top, end + 1).map((_row, index) => cells[top + index]!);
    for (const row of frame) expect(row.slice(2).every(cell => cell.dim)).toBe(true);
  }, { theme: theme.name });
});

test("the approval list has no 'Enter to choose · Esc to skip' hint under its rows", async () => {
  for (const theme of BUILT_IN_THEMES) await approval((_cells, rows) => {
    expect(rows.join("\n")).not.toContain("Enter to choose");
    expect(rows.join("\n")).not.toContain("tell the AI what to do instead");
  }, { theme: theme.name });
});

test("NO_COLOR keeps the rendered approval box plain", async () => {
  for (const theme of BUILT_IN_THEMES) await approval(cells => {
    for (const cell of cells.flat()) expect(cell).toMatchObject({ foreground: "default", background: "default", dim: false, bold: false, inverse: false });
    for (const text of ["Yes, this once", "Yes, for this session", "Command"]) expect(cellsFor(cells, text).length).toBeGreaterThan(0);
  }, { theme: theme.name, noColor: true });
});

test("raw ANSI from a rendered approval preserves dim after selected-label resets and on capped command rows", async () => {
  for (const width of [80, 160, 202]) await approval((cells, rows) => {
    const selected = rows.findIndex(row => Bun.stripANSI(row).includes("1. No"));
    expect(cellsFor([cells[selected]!], "No").every(cell => !cell.dim && cell.foreground !== "default")).toBe(true);
    const omitted = rows.findIndex(row => row.includes("more lines"));
    expect(omitted).toBeGreaterThanOrEqual(0);
    expect(cells[omitted]!.slice(2).every(cell => cell.dim)).toBe(true);
  }, { width, theme: "high-contrast", long: true });
});
