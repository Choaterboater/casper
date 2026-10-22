import { expect, test } from "bun:test";
import { contextText } from "../src/app/footer";
import { readableFooter } from "../src/tui/footer-layout";
import { activeThemeName, roleCode, useTheme } from "../src/tui/theme";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ansiCells, cellsFor } from "./support/ansi-cells";
import { withEnv } from "./support/env";

/** The footer's context group: a ten-cell bar, the tokens in the window out of its size, and the share. */

test("the context group is a bar, the tokens out of the window, and the share", () => {
  expect(contextText({ tokens: 20_600, contextWindow: 32_768, percent: 62.9 })).toBe("ctx ━━━━━━──── 20.6k / 32k · 63%~");
  expect(contextText({ tokens: 90_050, contextWindow: 131_072, percent: 68.7 })).toBe("ctx ━━━━━━━─── 90k / 128k · 69%~");
  expect(contextText({ tokens: 4_000, contextWindow: 1_000_000, percent: 0.4 })).toBe("ctx ────────── 4k / 1M · 0%~");
  expect(contextText({ tokens: 1_300, contextWindow: 128_000, percent: 1 })).toBe("ctx ────────── 1.3k / 128k · 1%~");
  expect(contextText({ tokens: 1_300, contextWindow: 40_960, percent: 3.2 })).toBe("ctx ────────── 1.3k / 40k · 3%~");
  expect(contextText({ tokens: 230_000, contextWindow: 200_000, percent: 115 })).toBe("ctx ━━━━━━━━━━ 230k / 200k · 115%~");
  // Not known until the next answer (after a compaction): the window alone; no model: a dash.
  expect(contextText({ tokens: null, contextWindow: 32_768, percent: null })).toBe("ctx — / 32k");
  expect(contextText(undefined)).toBe("ctx —");
});

const details = "casper/main │ ollama/qwen3:8b · high │ ctx ━━━━━━──── 20.6k / 32k · 63%~ │ task 41.2k tok";

test("a narrow window drops the bar before any group, then groups as before", () => {
  const whole = readableFooter("idle", details, 100, false);
  expect(whole).toContain("ctx ━━━━━━──── 20.6k / 32k · 63%~ │ task 41.2k tok");
  const narrow = readableFooter("idle", details, 90, false);
  expect(visibleWidth(narrow)).toBeLessThanOrEqual(90);
  expect(narrow).toContain("ctx 20.6k / 32k · 63%~ │ task 41.2k tok");
  expect(narrow).not.toContain("━");
  expect(readableFooter("idle", details, 70, false)).not.toContain("task");
});

for (const noColor of [false, true]) test(`the bar's filled cells are the accent colour, the warning colour from 80% (NO_COLOR=${noColor})`, async () => {
  await withEnv({ TERM: "xterm-256color", NO_COLOR: noColor ? "1" : undefined }, async () => {
    const previous = activeThemeName();
    try {
      useTheme("default");
      const color = !noColor;
      for (const [percent, role] of [[63, "accent"], [85, "warning"]] as const) {
        const line = readableFooter("idle", details.replace("63%~", `${percent}%~`), 120, color);
        const cells = ansiCells([line]);
        const filled = cellsFor(cells, "━━━━━━");
        const rest = cellsFor(cells, "────");
        expect(filled.every((cell) => cell.foreground === (noColor ? "default" : roleCode(role)))).toBe(true);
        expect(rest.every((cell) => cell.foreground === "default" && cell.dim === !noColor)).toBe(true);
        expect(cellsFor(cells, "20.6k").every((cell) => cell.dim === !noColor)).toBe(true);
      }
    } finally { useTheme(previous); }
  });
});
