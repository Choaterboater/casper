import { expect, test } from "bun:test";
import { wrap } from "../src/wrap";

test("01 width must be a positive integer, otherwise RangeError", () => {
  expect(() => wrap("hi", 0)).toThrow("width must be a positive integer");
  expect(() => wrap("hi", -5)).toThrow("width must be a positive integer");
  expect(() => wrap("hi", 2.5)).toThrow("width must be a positive integer");
});

test("02 each line takes as many whole words as fit, joined by one space", () => {
  expect(wrap("aa bb cc dd", 6)).toBe("aa bb\ncc dd");
});

test("03 a line exactly width wide fits", () => {
  expect(wrap("aaaa bbbb", 9)).toBe("aaaa bbbb");
});

test("04 [D] runs of spaces between words collapse to one", () => {
  expect(wrap("aa    bb", 20)).toBe("aa bb");
});

test("05 no output line has trailing whitespace", () => {
  expect(wrap("aa bb   ", 20)).toBe("aa bb");
});

test("06 \\n is a hard line break, \\r\\n counts as \\n, output uses \\n", () => {
  expect(wrap("aa\r\nbb", 20)).toBe("aa\nbb");
});

test("07 a blank line (paragraph break) is kept", () => {
  expect(wrap("aa\n\nbb", 20)).toBe("aa\n\nbb");
});

test("08 [D] several blank lines in a row become one", () => {
  expect(wrap("aa\n\n\n\nbb", 20)).toBe("aa\n\nbb");
});

test("09 an empty string returns an empty string", () => {
  expect(wrap("", 20)).toBe("");
});

test("10 a final newline in the input is kept once, otherwise the output has none", () => {
  expect(wrap("aa bb", 20)).toBe("aa bb");
  expect(wrap("aa bb\n", 20)).toBe("aa bb\n");
  expect(wrap("aa bb\n\n\n", 20)).toBe("aa bb\n");
  // a trailing blank line (spaces/tabs only, per this same "blank" definition) is absorbed too, not just
  // a bare run of newlines.
  expect(wrap("aa\n  \n", 20)).toBe("aa\n");
});

test("11 a paragraph's leading spaces are kept on its first line", () => {
  expect(wrap("  aa bb", 20)).toBe("  aa bb");
});

test("12 continuation lines get the same leading spaces as its first line", () => {
  const lines = wrap("  aa bb cc", 8).split("\n");
  expect(lines[1]).toBe("  cc");
});

test("13 hangingIndent (default 0) adds that many more spaces to continuation lines only", () => {
  expect(wrap("aa bb cc", 6, { hangingIndent: 3 })).toBe("aa bb\n   cc");
});

test("14 a tab in the leading indentation advances to the next multiple of tabWidth (default 4)", () => {
  expect(wrap("  \taa bb", 20)).toBe("    aa bb");
});

test("15 [D] a tab anywhere else counts as one space between words", () => {
  expect(wrap("aa\tbb", 20)).toBe("aa bb");
});

test("16 a word with a hyphen may break right after a hyphen when the whole word does not fit", () => {
  expect(wrap("well-known", 7)).toBe("well-\nknown");
  // a hyphenated word that fits whole on a fresh line is not broken, even though it doesn't share
  // the current line with the word before it.
  expect(wrap("aa well-known", 10)).toBe("aa\nwell-known");
  // more than one hyphen: breaks after the last one whose piece still fits, not the first.
  expect(wrap("state-of-art", 9)).toBe("state-of-\nart");
});

test("17 [D] a word longer than the line is cut into width-1 pieces with -, the last piece without one", () => {
  expect(wrap("abcdefghij", 4)).toBe("abc-\ndef-\nghij");
  expect(wrap("ab", 1)).toBe("a\nb");
});

test("18 [D] a word starting with http:// or https:// is never hyphenated, cut at exactly width characters", () => {
  expect(wrap("http://a-bcdefghijk", 10)).toBe("http://a-b\ncdefghijk");
});

test("19 a soft hyphen is a break opportunity, shown as - where the line breaks there, removed everywhere else", () => {
  expect(wrap("de­sign", 20)).toBe("design");
  expect(wrap("extra­ordinary", 8)).toBe("extra-\nordinary");
});

test("20 a no-break space never breaks and counts as width 1", () => {
  const result = wrap("10 km walk", 6);
  expect(result).toBe("10 km\nwalk");
});

test("21 wide East Asian characters count as width 2", () => {
  expect(wrap("가각 ab", 5)).toBe("가각\nab");
});

test("22 emoji count as width 2", () => {
  expect(wrap("\u{1F920}\u{1F920} ab", 5)).toBe("\u{1F920}\u{1F920}\nab");
});

test("23 combining marks count as width 0 and stay with their base character", () => {
  // width 0: "e" plus a combining acute is width 1, so the pair alone fits a width-1 line unsplit.
  expect(wrap("e\u0301", 1)).toBe("e\u0301");
  // stays with its base: forcing "b" plus a combining acute to split somewhere never separates them --
  // the pair survives intact, and no output line is ever left starting with a bare combining mark.
  const result = wrap("ab\u0301cdef", 3);
  expect(result).toContain("b\u0301");
  for (const line of result.split("\n")) expect(line.startsWith("\u0301")).toBe(false);
});

test("24 text of wide characters without spaces may break between any two of them", () => {
  const word = "\u{1F300}中\u{1F301}文\u{1F302}";
  expect(wrap(word, 4)).toBe("\u{1F300}中\n\u{1F301}文\n\u{1F302}");
});

test("25 ANSI escape sequences count as width 0 and are never split", () => {
  // width 0: this word plus its two ANSI codes fits the line unchanged, proving the codes add no width.
  expect(wrap("\x1b[1mabcd\x1b[0m", 4)).toBe("\x1b[1mabcd\x1b[0m");
  // never split: forcing a break must still keep each escape sequence intact on one line, never
  // straddling two -- every ESC on a line is part of a complete `ESC [ ... m` match on that same line.
  const result = wrap("\x1b[1mabcdef\x1b[0m", 4);
  expect(result).toContain("\x1b[1m");
  expect(result).toContain("\x1b[0m");
  for (const line of result.split("\n")) {
    const escCount = (line.match(/\x1b/g) ?? []).length;
    const completeCount = (line.match(/\x1b\[[0-9;]*m/g) ?? []).length;
    expect(completeCount).toBe(escCount);
  }
});

test("26 maxLines keeps at most that many lines", () => {
  const result = wrap("aaaa bbbb cccc dddd", 4, { maxLines: 3 });
  const lines = result.split("\n");
  expect(lines.length).toBe(3);
  expect(lines[0]).toBe("aaaa");
  expect(lines[1]).toBe("bbbb");
});

test("27 [D] when maxLines cuts text, the last kept line drops whole words until it plus … fits", () => {
  expect(wrap("aaaa bbbb cccc dddd eeee", 9, { maxLines: 2 })).toBe("aaaa bbbb\ncccc…");
});

test("28 maxLines must be a positive integer when given, otherwise RangeError", () => {
  expect(() => wrap("hi", 10, { maxLines: 0 })).toThrow(RangeError);
  expect(() => wrap("hi", 10, { maxLines: -1 })).toThrow(RangeError);
  expect(() => wrap("hi", 10, { maxLines: 2.5 })).toThrow(RangeError);
});

test("29 tabWidth and hangingIndent must be non-negative integers (tabWidth positive), otherwise RangeError", () => {
  expect(() => wrap("hi", 10, { tabWidth: 0 })).toThrow(RangeError);
  expect(() => wrap("hi", 10, { tabWidth: -2 })).toThrow(RangeError);
  expect(() => wrap("hi", 10, { tabWidth: 2.5 })).toThrow(RangeError);
  expect(() => wrap("hi", 10, { hangingIndent: -1 })).toThrow(RangeError);
  expect(() => wrap("hi", 10, { hangingIndent: 1.5 })).toThrow(RangeError);
  expect(() => wrap("hi", 10, { hangingIndent: 0 })).not.toThrow();
});

test("30 an indentation (plus hangingIndent) that leaves no room for text throws RangeError indent leaves no room", () => {
  expect(() => wrap("   ab", 3)).toThrow("indent leaves no room");
  expect(() => wrap("   ab", 5, { hangingIndent: 2 })).toThrow("indent leaves no room");
});
