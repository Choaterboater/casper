import { afterEach, beforeEach, expect, test } from "bun:test";
import { formatShortReceipt, receiptView, type TaskResult } from "../src/task/result";
import { buildNextRow } from "../src/tui/next-row";
import { activeThemeName, BUILT_IN_THEMES, useTheme } from "../src/tui/theme";
import { ansiCells, cellsFor, cellSnapshot, type Cell } from "./support/ansi-cells";
import { withEnv } from "./support/env";
import { interactiveTerminal } from "./support/tty";

/**
 * The user missed "1 Show diff · 2 Undo" on a receipt: plain text on its last line. Each key is now a key cap (bold,
 * reversed, in the theme's selection colour) with "· press a number" after the steps; with NO_COLOR, [1].
 */

const WIDTH = 100;
const task: TaskResult = { execution: "completed", changedPaths: ["notes.py"], verificationMode: "auto", autoSkipped: "docs-only" };
let previous = activeThemeName();
beforeEach(() => { previous = activeThemeName(); });
afterEach(() => { useTheme(previous); });

/** The receipt card and its Next row as the real terminal drew them: the rows holding `texts`, found in the writer's bytes. */
async function drawn(texts: readonly string[], { theme = "default", noColor = false, row = buildNextRow({ diff: { label: "Show diff", command: "/diff 1" }, undo: { label: "Undo", command: "/undo 1" } }) } = {}): Promise<Cell[][]> {
  let cells: Cell[][] = [];
  await withEnv({ TERM: "xterm-256color", NO_COLOR: noColor ? "1" : undefined }, async () => {
    useTheme(theme);
    const f = interactiveTerminal();
    f.screen.writer.columns = WIDTH; f.screen.writer.rows = 45;
    try {
      f.terminal.start();
      f.terminal.writeResult(formatShortReceipt(task, { surface: "interactive" }), receiptView(task, { surface: "interactive" }));
      f.terminal.offerNext(row);
      await f.screen.until(text => texts.every(want => text.includes(want)));
      const rendered = (f.terminal as unknown as { surface: { tui: { render(width: number): string[] } } }).surface.tui.render(WIDTH);
      const rows = rendered.filter(row => texts.some(want => Bun.stripANSI(row).includes(want)));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) expect(f.screen.output).toContain(row);
      cells = ansiCells(rows);
    } finally { f.close(); }
  });
  return cells;
}

test("the receipt's keys are key caps: each number bold and reversed, its words plain, then a grey 'press a number'", async () => {
  for (const theme of BUILT_IN_THEMES) {
    const cells = await drawn(["Show diff", "press a number"], { theme: theme.name });
    for (const key of [" 1 ", " 2 "]) {
      const before = key === " 1 " ? "Show diff" : "Undo";
      const row = cells.find(line => line.map(cell => cell.char).join("").includes(`${key} ${before}`))!;
      const text = row.map(cell => cell.char).join("");
      const cap = row.slice(text.indexOf(`${key} ${before}`), text.indexOf(`${key} ${before}`) + 3);
      expect([theme.name, cap.every(cell => cell.inverse && cell.bold)]).toEqual([theme.name, true]);
    }
    expect(cellsFor(cells, "Show diff").some(cell => cell.inverse || cell.bold)).toBe(false);
    expect(cellsFor(cells, "Undo").some(cell => cell.inverse || cell.bold)).toBe(false);
  }
  const plain = await drawn(["Show diff", "press a number"]);
  expect(cellsFor(plain, "· press a number").every(cell => cell.dim)).toBe(true);
  expect(cellSnapshot([cellsFor(plain, "Show diff   ")])).toBe('[plain]"Show diff   "');
});

test("NO_COLOR: the keys are [1] and [2], with no colour or style at all", async () => {
  const cells = await drawn(["[1] Show diff", "press a number"], { noColor: true });
  for (const cell of cells.flat()) expect(cell).toMatchObject({ foreground: "default", background: "default", dim: false, bold: false, inverse: false });
  expect(cellsFor(cells, "[1] Show diff   [2] Undo   · press a number").length).toBeGreaterThan(0);
});

test("a step's reason says Why, not a second number, and only the step's own key is a cap", async () => {
  const row = buildNextRow({ more: [{ label: "Add a test that proves this bug stays fixed", command: "/suggestion prove-fix", note: "uses tokens",
    why: "no test shows the fix works" }], hint: "A number picks one · type to ask something else · /suggestions off stops these" })!;
  expect(row.line).toBe("Next: 1 Add a test that proves this bug stays fixed (uses tokens)\n  Why: no test shows the fix works"
    + "\n  A number picks one · type to ask something else · /suggestions off stops these");
  const cells = await drawn(["Add a test that proves", "Why: no test shows the fix works"], { row });
  const lines = cells.map((line) => line.map((cell) => cell.char).join(""));
  // One cap on the step's row; none on the reason's.
  expect(cells.flat().filter((cell) => cell.inverse).map((cell) => cell.char).join("")).toBe(" 1 ");
  expect(lines.find((line) => line.includes("Why:"))).not.toMatch(/\b1:/);
  expect(cellsFor(cells, "Why: no test shows the fix works").some((cell) => cell.inverse || cell.bold)).toBe(false);
});
