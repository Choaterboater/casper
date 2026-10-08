import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { glyphOutput, glyphSet } from "../src/tui/glyphs";
import { renderPanel } from "../src/tui/presentation";

test("the old Windows console gets an ASCII spinner and square corners; Windows Terminal and others keep the braille ones", () => {
  const legacy = glyphSet("win32", {});
  expect(legacy.spinner).toEqual(["|", "/", "-", "\\"]);
  expect(legacy.corners).toEqual(["┌", "┐", "└", "┘"]);
  for (const modern of [glyphSet("win32", { WT_SESSION: "abc" }), glyphSet("win32", { TERM_PROGRAM: "vscode" }), glyphSet("darwin", {}), glyphSet("linux", {})]) {
    expect(modern.spinner[0]).toBe("⠋");
    expect(modern.corners).toEqual(["╭", "╮", "╰", "╯"]);
  }
});

test("the old console gets every mark in ASCII, one column each; other terminals and pipes keep the symbols", () => {
  const legacy = glyphSet("win32", {});
  // The live old-console screen that still wrote symbols (only the spinner fell back).
  const screen = "❯ run mkdir\n→ 1 No  the command does not run\n▌ ✓ changed hello.txt\n  ↳ sent to Casper\n• bash · ping 15 …\n○ bash · mkdir made — not run\n▌ – Not checked\n✗ test · exit 1\n◐ Casper";
  const ascii = legacy.text(screen);
  expect(ascii).toBe("> run mkdir\n> 1 No  the command does not run\n| + changed hello.txt\n  └ sent to Casper\n* bash · ping 15 ~\no bash · mkdir made — not run\n| - Not checked\nx test · exit 1\n* Casper");
  for (const [line, shown] of screen.split("\n").map((line, index) => [line, ascii.split("\n")[index]!])) expect(visibleWidth(shown!)).toBe(visibleWidth(line!));
  expect(glyphSet("win32", { WT_SESSION: "abc" }).text(screen)).toBe(screen);

  const written: string[] = [];
  const tty = { isTTY: true, columns: 80, write(text: string) { written.push(text); return true; } };
  glyphOutput(tty, legacy).write("✓ done");
  expect(written).toEqual(["+ done"]);
  expect(glyphOutput(tty, legacy).columns).toBe(80);
  // Piped output and a modern terminal are left alone.
  const pipe = { isTTY: false, write: (_text: string) => true };
  expect(glyphOutput(pipe, legacy)).toBe(pipe);
  expect(glyphOutput(tty, glyphSet("linux", {}))).toBe(tty);
});

test("a panel draws with the corners it is given", () => {
  const rows = renderPanel("output", ["x"], 20, false, "muted", ["┌", "┐", "└", "┘"]);
  expect(rows[0]!.startsWith("┌─ output")).toBe(true);
  expect(rows[0]!.endsWith("┐")).toBe(true);
  expect(rows.at(-1)).toBe(`└${"─".repeat(18)}┘`);
});
