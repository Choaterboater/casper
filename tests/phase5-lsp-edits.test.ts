import { describe, expect, test } from "bun:test";
import { applyTextEdits, type TextEdit } from "../src/lsp/edits";

function edit(line: number, from: number, to: number, newText: string): TextEdit {
  return { range: { start: { line, character: from }, end: { line, character: to } }, newText };
}

describe("Phase 5 LSP edit preflight", () => {
  test("applies unordered rename edits against one snapshot without mutating input", () => {
    const edits = [edit(1, 0, 3, "renamed"), edit(0, 6, 9, "renamed")];
    const original = structuredClone(edits);
    expect(applyTextEdits("const old = 1;\nold();\n", edits)).toBe("const renamed = 1;\nrenamed();\n");
    expect(edits).toEqual(original);
  });

  test("preserves CRLF, CR, and UTF-16 positions", () => {
    expect(applyTextEdits("😀 old\r\nold\rold\n", [edit(0, 3, 6, "new"), edit(1, 0, 3, "new"), edit(2, 0, 3, "new")]))
      .toBe("😀 new\r\nnew\rnew\n");
    expect(() => applyTextEdits("😀 old", [edit(0, 1, 2, "x")])).toThrow("surrogate");
  });

  test("supports multiline replacement and insertion at EOF", () => {
    const replacement: TextEdit = { range: { start: { line: 0, character: 1 }, end: { line: 1, character: 2 } }, newText: "X\nY" };
    expect(applyTextEdits("abc\ndef\n", [replacement, edit(2, 0, 0, "end")])).toBe("aX\nYf\nend");
    expect(applyTextEdits("", [edit(0, 0, 0, "new")])).toBe("new");
    expect(applyTextEdits("unchanged", [])).toBe("unchanged");
  });

  test("retains same-position insertion order and permits touching ranges", () => {
    expect(applyTextEdits("abc", [edit(0, 0, 0, "1"), edit(0, 0, 0, "2"), edit(0, 0, 1, "A"), edit(0, 1, 2, "B")])).toBe("12ABc");
  });

  test("rejects overlapping, duplicate, and reversed ranges", () => {
    for (const edits of [
      [edit(0, 0, 2, "x"), edit(0, 1, 3, "y")],
      [edit(0, 0, 2, "x"), edit(0, 1, 1, "y")],
      [edit(0, 0, 2, "x"), edit(0, 0, 2, "x")],
      [edit(0, 0, 2, "x"), edit(0, 0, 0, "y")],
      [edit(0, 2, 1, "x")],
    ]) expect(() => applyTextEdits("abc", edits)).toThrow();
  });

  test("rejects out-of-bounds and malformed positions rather than clamping", () => {
    for (const invalid of [edit(-1, 0, 0, ""), edit(1, 0, 0, ""), edit(0, -1, 0, ""), edit(0, 0, 4, ""), edit(0, 0.5, 1, ""), edit(0, 0, NaN, ""), edit(Infinity, 0, 0, "")]) {
      expect(() => applyTextEdits("abc", [invalid])).toThrow();
    }
    expect(() => applyTextEdits("a\r\nb", [edit(0, 2, 2, "")])).toThrow();
  });
});
