import { expect, test } from "bun:test";
import { SHELL_COMMAND_CHOICES } from "../src/app/safe-choices";
import { shellQuestion } from "../src/app/sandbox";
import { GLYPHS } from "../src/tui/glyphs";
import { activeThemeName, BUILT_IN_THEMES, useTheme } from "../src/tui/theme";
import { interactiveTerminal } from "./support/tty";

/** Capture bytes actually written by the rich terminal, not just tint() or stripped snapshots. */
async function approval(assert: (raw: string, rows: string[]) => void, { theme = "default", noColor = false, width = 202, long = false } = {}) {
  const before = { theme: activeThemeName(), term: process.env.TERM, noColor: process.env.NO_COLOR };
  process.env.TERM = "xterm-256color";
  if (noColor) process.env.NO_COLOR = "1"; else delete process.env.NO_COLOR;
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
    assert(f.screen.output, rows);
  } finally {
    f.terminal.interrupt(); await answer; f.close();
    useTheme(before.theme);
    if (before.term === undefined) delete process.env.TERM; else process.env.TERM = before.term;
    if (before.noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = before.noColor;
  }
}

// All themes, especially high-contrast's default-colour muted role: faint is an explicit layout style here.
test("approval choice descriptions 'the command does not run' and 'only this time' render dim", async () => {
  for (const theme of BUILT_IN_THEMES) await approval(raw => {
    expect(raw).toContain("\x1b[2mthe command does not run\x1b[0m");
    expect(raw).toContain("\x1b[2monly this time\x1b[0m");
  }, { theme: theme.name });
});

test("the approval Command frame renders dim", async () => {
  for (const theme of BUILT_IN_THEMES) await approval((raw, rows) => {
    expect(raw).toContain(`\x1b[2m${GLYPHS.corners[0]}─ Command `);
    const frame = rows.filter(row => row.includes("Command ") || row.includes("│ custom-tool") || row.includes(GLYPHS.corners[2]));
    expect(frame).toHaveLength(3);
    for (const row of frame) expect(row).toMatch(/^ {2}\x1b\[2m[^\x1b]+\x1b\[0m$/);
  }, { theme: theme.name });
});

test("the approval 'Enter to choose · Esc to skip' hint renders dim", async () => {
  for (const theme of BUILT_IN_THEMES) await approval(raw => {
    expect(raw).toContain("\x1b[2mEnter to choose · Esc to skip\x1b[0m");
  }, { theme: theme.name });
});

test("NO_COLOR keeps the rendered approval box plain", async () => {
  for (const theme of BUILT_IN_THEMES) await approval((raw, rows) => {
    // Pi terminates screen rows with neutral SGR resets even with NO_COLOR; no style may be enabled.
    expect([...raw.matchAll(/\x1b\[([\d;]*)m/g)].map(match => match[1]).filter(code => code !== "0" && code !== "")).toEqual([]);
    expect(rows.join("\n")).not.toContain("\x1b");
    for (const text of ["the command does not run", "only this time", "Command", "Enter to choose · Esc to skip"]) expect(raw).toContain(text);
  }, { theme: theme.name, noColor: true });
});

test("raw ANSI from a rendered approval preserves dim after selected-label resets and on capped command rows", async () => {
  for (const width of [80, 160, 202]) await approval((raw, rows) => {
    const selected = rows.find(row => row.includes("the command does not run"))!;
    expect(selected).toMatch(/\x1b\[[\d;]+mNo\x1b\[0m +\x1b\[2mthe command does not run\x1b\[0m/);
    expect(raw).toMatch(/\x1b\[[\d;]+mNo\x1b\[0m +\x1b\[2mthe command does not run\x1b\[0m/);
    expect(raw).toMatch(/\x1b\[2m│[^\x1b\r\n]+more lines[^\x1b\r\n]+│\x1b\[0m/);
    expect(raw).toContain("\x1b[2mEnter to choose · Esc to skip\x1b[0m");
    const omitted = rows.find(row => row.includes("more lines"))!;
    expect(omitted).toMatch(/^ {2}\x1b\[2m│[^\x1b]+more lines[^\x1b]+│\x1b\[0m$/);
  }, { width, theme: "high-contrast", long: true });
});
