import { expect, test } from "bun:test";
import { ansiCells, cellsFor, cellSnapshot } from "./support/ansi-cells";

test("colour cells retain effective attributes across nested resets and line boundaries", () => {
  const rows = ansiCells(["\x1b[96m╭─ \x1b[0mtext\x1b[96m ─╮", "\x1b[2mfile\x1b[22m│\x1b[39m plain"]);
  expect(cellsFor(rows, "╭─ ").every(cell => cell.foreground === "96")).toBe(true);
  expect(cellsFor(rows, "text").every(cell => cell.foreground === "default")).toBe(true);
  expect(cellsFor(rows, "file").every(cell => cell.foreground === "96" && cell.dim)).toBe(true);
  expect(cellsFor(rows, "│")[0]).toMatchObject({ foreground: "96", dim: false });
  expect(cellSnapshot(rows)).toMatchInlineSnapshot(`
    "[fg=96]\"╭─ \" [plain]\"text\" [fg=96]\" ─╮\"
    [fg=96 dim]\"file\" [fg=96]\"│\" [plain]\" plain\""
  `);
});

test("indexed and truecolour foregrounds and backgrounds, intensity and default resets", () => {
  const rows = ansiCells(["\x1b[1;2;3;4;7;38;5;244;48;2;1;2;3mA\x1b[22;23;24;27;39;49mB\x1b[38;2;4;5;6mC\x1b[mD"]);
  expect(cellsFor(rows, "A")[0]).toEqual({ char: "A", foreground: "index:244", background: "rgb:1,2,3", dim: true, bold: true, italic: true, underline: true, inverse: true });
  expect(cellsFor(rows, "B")[0]).toEqual(cellsFor(ansiCells(["B"]), "B")[0]!);
  expect(cellsFor(rows, "C")[0]!.foreground).toBe("rgb:4,5,6");
  expect(cellsFor(rows, "D")[0]!.foreground).toBe("default");
});

test("wide and combining graphemes keep terminal columns; links draw only their labels", () => {
  const rows = ansiCells(["界é👩‍💻", "\x1b]8;;https://example.com\x1b\\label\x1b]8;;\x07"]);
  expect(rows[0]!.length).toBe(5);
  expect(rows[0]!.map(cell => cell.char)).toEqual(["界", "", "é", "👩‍💻", ""]);
  expect(cellsFor(rows, "界").map(cell => cell.char)).toEqual(["界", ""]);
  expect(cellsFor(rows, "👩‍💻").map(cell => cell.char)).toEqual(["👩‍💻", ""]);
  expect(cellSnapshot(rows.slice(1))).toBe('[plain]"label"');
});

test("erasing a line preserves its cursor column and paints blank cells with the active attributes", () => {
  expect(cellSnapshot(ansiCells(["abc\x1b[2KX"]))).toBe('[plain]"   X"');
  expect(cellSnapshot(ansiCells(["\x1b[41mabc\r\x1b[KX"]))).toBe('[bg=41]"X  "');
  expect(cellSnapshot(ansiCells(["abc\b\x1b[1KX"]))).toBe('[plain]"  X"');
});

test("overwriting or erasing a wide glyph clears both halves and combining marks attach to its base", () => {
  const rows = ansiCells(["界\rA", "界\bA", "界\b\x1b[K", "界\r\x1b[1K", "界\x1b[31m\u0301"]);
  expect(rows.map(row => row.map(cell => cell.char))).toEqual([["A", " "], [" ", "A"], [" ", " "], [" ", " "], ["界́", ""]]);
  expect(cellsFor(rows.slice(4), "界́").every(cell => cell.foreground === "default")).toBe(true);
});

test("carriage returns overwrite cells and unsupported controls or missing spans fail loudly", () => {
  expect(cellSnapshot(ansiCells(["old\r\x1b[31mnew"]))).toBe('[fg=31]"new"');
  expect(() => ansiCells(["\x1b[2J"])).toThrow("Unsupported row escape");
  expect(() => ansiCells(["\x1b[38;6m"])).toThrow("Unsupported SGR");
  expect(() => ansiCells(["x\t"])).toThrow("Non-printing control");
  expect(() => cellsFor(ansiCells(["abc"]), "absent")).toThrow("Missing snapshot text");
});
