import { expect, test } from "bun:test";
import { activeThemeName, BUILT_IN_THEMES, roleCode, useTheme } from "../src/tui/theme";
import { ansiCells, cellsFor, cellSnapshot } from "./support/ansi-cells";
import { withEnv } from "./support/env";
import { interactiveTerminal } from "./support/tty";

for (const noColor of [false, true]) test(`footer cells preserve idle, working and status colours (NO_COLOR=${noColor})`, async () => {
  await withEnv({ TERM: "xterm-256color", NO_COLOR: noColor ? "1" : undefined }, async () => {
    const previous = activeThemeName();
    try {
      for (const theme of BUILT_IN_THEMES) {
        useTheme(theme.name);
        const f = interactiveTerminal();
        try {
          f.terminal.setStatus("sample │ provider/model │ task $1"); f.terminal.start();
          const command = f.terminal.readCommand();
          await f.screen.until(text => text.includes("idle"));
          const idle = f.terminal.footerLine(100)!;
          await f.screen.until(() => f.screen.output.includes(idle));
          const idleCells = cellsFor(ansiCells([idle]), "idle");
          expect(cellSnapshot([idleCells])).toBe(!noColor && theme.name !== "high-contrast" ? '[dim]"idle"' : '[plain]"idle"');
          f.input.write("work\r"); expect(await command).toBe("work");
          await f.screen.until(text => text.includes("working"));
          const working = f.terminal.footerLine(100)!;
          await f.screen.until(() => f.screen.output.includes(working));
          const cells = ansiCells([working]);
          expect(cellsFor(cells, "working").every(cell => cell.foreground === (noColor ? "default" : roleCode("accent")) && !cell.dim)).toBe(true);
          expect(cellsFor(cells, "sample").every(cell => cell.dim === (!noColor && theme.name !== "high-contrast"))).toBe(true);
        } finally { f.close(); }
      }
    } finally { useTheme(previous); }
  });
});
