import { afterEach, beforeEach, expect, test } from "bun:test";
import { activeThemeName, useTheme } from "../src/tui/theme";
import { GLYPHS } from "../src/tui/glyphs";
import type { FoldView } from "../src/tui/terminal";
import { ansiCells, cellsFor, type Cell } from "./support/ansi-cells";
import { withEnv } from "./support/env";
import { interactiveTerminal } from "./support/tty";

type Fixture = ReturnType<typeof interactiveTerminal>;
const WIDTH = 100;
const fold = (failures: FoldView["failures"], edits: FoldView["edits"] = []): FoldView => ({ parts: [], lines: [], edits, editLines: 10, failures });
/** The default theme's warning, error and success colours (yellow, red, green), whatever theme an earlier test left on. */
const AMBER = "33", RED = "31", GREEN = "32";
/** The failure box's top line: square-cornered on the old Windows console. */
const BOX_TOP = `${GLYPHS.corners[0]}─ ✗ bash · npm test — failed`;
let previous = activeThemeName();
beforeEach(() => { previous = activeThemeName(); useTheme("default"); });
afterEach(() => { useTheme(previous); });

/** What the real terminal drew after `show`: the rows holding `texts`, each found as it is in the writer's actual bytes. */
async function drawn(show: (f: Fixture) => void, texts: readonly string[], noColor = false): Promise<Cell[][]> {
  let cells: Cell[][] = [];
  await withEnv({ TERM: "xterm-256color", NO_COLOR: noColor ? "1" : undefined }, async () => {
    const f = interactiveTerminal();
    f.screen.writer.columns = WIDTH; f.screen.writer.rows = 45;
    try {
      f.terminal.start();
      show(f);
      await f.screen.until(text => texts.every(want => text.includes(want)));
      const rendered = (f.terminal as unknown as { surface: { tui: { render(width: number): string[] } } }).surface.tui.render(WIDTH);
      const rows = rendered.filter(row => texts.some(want => Bun.stripANSI(row).includes(want)));
      expect(rows.length).toBeGreaterThanOrEqual(texts.length);
      for (const row of rows) expect(f.screen.output).toContain(row);
      cells = ansiCells(rows);
    } finally { f.close(); }
  });
  return cells;
}

const tone = (cells: Cell[][], text: string) => [...new Set(cellsFor(cells, text).map(cell => cell.foreground))];

test("a failed step is amber while the AI works: its live row, its folded box, a bare failure and Casper's check line", async () => {
  const live = await drawn(f => f.terminal.setWork({ rows: ["✓ read · a.ts", "✗ bash · npm run lint — failed"], status: "Working" }),
    ["npm run lint — failed"]);
  expect(tone(live, "✗")).toEqual([AMBER]);
  const folded = await drawn(f => {
    f.terminal.writeFold(fold([{ title: "✗ bash · npm test — failed", output: "Error: boom" }, { title: "✗ bash · make — failed" }]));
    f.terminal.write("✗ test · exit 1 · 2.3s\n");
  }, ["npm test — failed", "Error: boom", "make — failed", "test · exit 1"]);
  // The box's frame and title, the line of a failure that printed nothing, and the check line.
  expect(tone(folded, BOX_TOP)).toEqual([AMBER]);
  expect(tone(folded, "✗ bash · make — failed")).toEqual([AMBER]);
  expect(tone(folded, "✗ test · exit 1 · 2.3s")).toEqual([AMBER]);
  // What the step printed keeps the terminal's own colour.
  expect(tone(folded, "Error: boom")).toEqual(["default"]);
});

test("a failed result stays red: the receipt's edge and lines, its --verbose and /receipt form, an [error] line, a removed diff line", async () => {
  const cells = await drawn(f => {
    f.terminal.writeFold(fold([], [{ path: "src/sum.js", added: 1, removed: 1, diff: "@@ -1 +1 @@\n-return a - b;\n+return a + b;" }]));
    f.terminal.write("[error] Can't reach the provider.\n");
    f.terminal.writeReceipt("✗ Not checked — lint could not start\n");
    f.terminal.writeResult("✗ Failed — test failed\n✓ changed src/sum.js\n✗ test failed (exit 1) — log above\n");
  }, ["return a - b;", "[error] Can't reach", "Not checked — lint", "Failed — test failed", "changed src/sum.js", "test failed (exit 1)"]);
  expect(tone(cells, "- return a - b;")).toEqual([RED]);
  expect(tone(cells, "[error] Can't reach the provider.")).toEqual([RED]);
  expect(tone(cells, "✗ Not checked — lint could not start")).toEqual([RED]);
  expect(tone(cells, "▌")).toEqual([RED]);
  expect(tone(cells, "✗ Failed — test failed")).toEqual([RED]);
  expect(tone(cells, "✗ test failed (exit 1) — log above")).toEqual([RED]);
  expect(tone(cells, "✓ changed src/sum.js")).toEqual([GREEN]);
});

test("a note, a provider retry and a running line are dim grey, neither amber nor red; a step that did not run is amber", async () => {
  const cells = await drawn(f => {
    f.terminal.write("– bash · rg TODO — nothing found\n");
    f.terminal.write("– Can't reach openrouter · trying again in 4s (1 of 3) · Esc stops\n");
    f.terminal.write("• Casper checking: test\n");
    f.terminal.write("○ bash · cat ~/.ssh/config — not run\n");
  }, ["nothing found", "trying again in 4s", "Casper checking: test", "— not run"]);
  for (const text of ["– bash · rg TODO — nothing found", "– Can't reach openrouter", "• Casper checking: test"]) {
    expect(cellsFor(cells, text).every(cell => cell.dim && cell.foreground === "default")).toBe(true);
  }
  expect(tone(cells, "○ bash · cat ~/.ssh/config — not run")).toEqual([AMBER]);
});

test("NO_COLOR draws the same failures with no colour or style at all", async () => {
  const cells = await drawn(f => {
    f.terminal.setWork({ rows: ["✗ bash · npm run lint — failed"], status: "Working" });
    f.terminal.writeFold(fold([{ title: "✗ bash · npm test — failed", output: "Error: boom" }]));
    f.terminal.writeResult("✗ Failed — test failed\n");
  }, ["npm run lint — failed", "npm test — failed", "Failed — test failed"], true);
  for (const cell of cells.flat()) expect(cell).toMatchObject({ foreground: "default", background: "default", dim: false, bold: false, inverse: false });
  for (const text of ["✗ bash · npm run lint — failed", BOX_TOP, "▌ ✗ Failed — test failed"]) expect(cellsFor(cells, text).length).toBeGreaterThan(0);
});
