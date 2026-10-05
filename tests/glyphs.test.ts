import { expect, test } from "bun:test";
import { glyphSet } from "../src/tui/glyphs";
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

test("a panel draws with the corners it is given", () => {
  const rows = renderPanel("output", ["x"], 20, false, "muted", ["┌", "┐", "└", "┘"]);
  expect(rows[0]!.startsWith("┌─ output")).toBe(true);
  expect(rows[0]!.endsWith("┐")).toBe(true);
  expect(rows.at(-1)).toBe(`└${"─".repeat(18)}┘`);
});
