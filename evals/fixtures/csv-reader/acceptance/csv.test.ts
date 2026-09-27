import { expect, test } from "bun:test";
import { readCsv } from "../src/csv";

test("01 rows end at \\n or \\r\\n", () => {
  expect(readCsv("a,b\nc,d\r\ne,f").rows).toEqual([["a", "b"], ["c", "d"], ["e", "f"]]);
});

test("02 [D] a lone \\r is ordinary data", () => {
  expect(readCsv("a\rb,c")).toEqual({ rows: [["a\rb", "c"]], problems: [] });
});

test("03 fields split on delimiter, default comma", () => {
  expect(readCsv("a,b,c").rows).toEqual([["a", "b", "c"]]);
  expect(readCsv("a;b;c", { delimiter: ";" }).rows).toEqual([["a", "b", "c"]]);
});

test("04 delimiter must be one character other than the quote, \\n or \\r", () => {
  for (const delimiter of [",,", "\"", "\n", "\r"]) {
    expect(() => readCsv("a", { delimiter })).toThrow("invalid delimiter");
  }
});

test("05 quote must be one character other than the delimiter, \\n or \\r", () => {
  for (const quote of ["\"\"", "\n", "\r"]) {
    expect(() => readCsv("a", { quote })).toThrow("invalid quote");
  }
});

test("06 a quoted field may contain the delimiter and newlines", () => {
  expect(readCsv('"a,b\nc",d')).toEqual({ rows: [["a,b\nc", "d"]], problems: [] });
});

test("07 a doubled quote inside a quoted field is one quote character", () => {
  expect(readCsv('"a""b",c')).toEqual({ rows: [['a"b', "c"]], problems: [] });
});

test("08 [D] backslash escapes the quote character and itself, literal elsewhere", () => {
  // Inside quotes: a \" b \\ c \d  ->  a " b \ c \ d
  expect(readCsv('"a\\"b\\\\c\\d"')).toEqual({ rows: [["a\"b\\c\\d"]], problems: [] });
  // Outside quotes, a backslash is always literal.
  expect(readCsv("a\\b,c")).toEqual({ rows: [["a\\b", "c"]], problems: [] });
});

test("09 [D] a quote character inside an unquoted field is literal", () => {
  expect(readCsv('ab"c,d')).toEqual({ rows: [['ab"c', "d"]], problems: [] });
});

test("10 text after a closing quote is a problem, the field keeps the quoted content", () => {
  expect(readCsv('"ab"cd,x')).toEqual({
    rows: [["ab", "x"]],
    problems: [{ line: 1, column: 5, message: "text after closing quote" }],
  });
});

test("11 a quote still open at the end of input is a problem, and that row is dropped", () => {
  expect(readCsv('x,y\na,"bc')).toEqual({
    rows: [["x", "y"]],
    problems: [{ line: 2, column: 3, message: "unterminated quote" }],
  });
});

test("12 empty input gives no rows and no problems", () => {
  expect(readCsv("")).toEqual({ rows: [], problems: [] });
});

test("13 a newline at the very end does not add a row", () => {
  expect(readCsv("a,b\n").rows).toEqual([["a", "b"]]);
  expect(readCsv("a,b\r\n").rows).toEqual([["a", "b"]]);
});

test("14 [D] lines that are empty or only spaces and tabs are skipped anywhere", () => {
  expect(readCsv("a,b\n\n   \t \nc,d")).toEqual({ rows: [["a", "b"], ["c", "d"]], problems: [] });
  // A line with just a delimiter is a row of empty fields, not a skipped blank line.
  expect(readCsv("a\n,\nb").rows).toEqual([["a"], ["", ""], ["b"]]);
});

test("15 a comment line is skipped, but spaces before the comment character make it a row", () => {
  expect(readCsv("#skip\n  #keep\na,b", { comment: "#" })).toEqual({
    rows: [["  #keep"], ["a", "b"]],
    problems: [],
  });
});

test("16 a comment character inside a quoted multi-line field is data", () => {
  expect(readCsv('"line1\n#not a comment\nline2",x', { comment: "#" })).toEqual({
    rows: [["line1\n#not a comment\nline2", "x"]],
    problems: [],
  });
});

test("17 trim removes spaces and tabs around unquoted fields; default is false", () => {
  expect(readCsv(" a , b ").rows).toEqual([[" a ", " b "]]);
  expect(readCsv(" a , b ", { trim: true }).rows).toEqual([["a", "b"]]);
});

test("18 with trim true, whitespace outside a quoted field is ignored, whitespace inside is kept", () => {
  expect(readCsv('  "  a  "  ,b', { trim: true }).rows).toEqual([["  a  ", "b"]]);
});

test("19 [D] with trim false, whitespace before an opening quote makes the field unquoted and literal", () => {
  expect(readCsv(' "a"')).toEqual({ rows: [[' "a"']], problems: [] });
});

test("20 a leading byte-order mark is ignored", () => {
  expect(readCsv("﻿a,b")).toEqual({ rows: [["a", "b"]], problems: [] });
});

test("21 header true: the first row after skipped lines names the columns, later rows are objects", () => {
  expect(readCsv("\n\na,b\nx,y\nz,w", { header: true })).toEqual({
    rows: [{ a: "x", b: "y" }, { a: "z", b: "w" }],
    problems: [],
  });
});

test("22 header names are always trimmed, even with trim false", () => {
  expect(readCsv(" a , b \n x , y ", { header: true })).toEqual({
    rows: [{ a: " x ", b: " y " }],
    problems: [],
  });
});

test("23 [D] a repeated header name gets _2, _3, ... in order", () => {
  expect(readCsv("a,a,a\n1,2,3", { header: true })).toEqual({
    rows: [{ a: "1", a_2: "2", a_3: "3" }],
    problems: [],
  });
});

test("24 an empty header name becomes column<N>, N its 1-based position", () => {
  expect(readCsv("a,,c\n1,2,3", { header: true })).toEqual({
    rows: [{ a: "1", column2: "2", c: "3" }],
    problems: [],
  });
});

test("25 [D] with a header, a row with fewer fields sets the missing columns to null, no problem", () => {
  expect(readCsv("a,b,c\nx", { header: true })).toEqual({
    rows: [{ a: "x", b: null, c: null }],
    problems: [],
  });
});

test("26 with a header, a row with more fields is a problem at the first extra field's column, extras dropped", () => {
  expect(readCsv("a,b\nx,y,z,w", { header: true })).toEqual({
    rows: [{ a: "x", b: "y" }],
    problems: [{ line: 2, column: 5, message: "too many fields" }],
  });
});

test("27 without a header, rows may differ in length with no problem", () => {
  expect(readCsv("a,b,c\nx\ny,z")).toEqual({
    rows: [["a", "b", "c"], ["x"], ["y", "z"]],
    problems: [],
  });
});

test("28 line counts newlines inside quoted fields, column is the position within that physical line", () => {
  expect(readCsv('"a\nb\nc"XY,d')).toEqual({
    rows: [["a\nb\nc", "d"]],
    problems: [{ line: 3, column: 3, message: "text after closing quote" }],
  });
});

test("29 columns requires header true, and an unknown columns key is a problem at the header's line, column 1", () => {
  expect(() => readCsv("a,b", { columns: { a: "number" } })).toThrow("columns requires header");
  expect(readCsv("a,b\n1,2", { header: true, columns: { c: "number" } })).toEqual({
    rows: [{ a: "1", b: "2" }],
    problems: [{ line: 1, column: 1, message: "unknown column c" }],
  });
});

test("30 [D] number: underscores may separate digit groups; e-notation, hex, and bare dots are problems", () => {
  expect(readCsv("n\n1_000\n1e3\n0x10\n.5\n5.", { header: true, columns: { n: "number" } })).toEqual({
    rows: [{ n: 1000 }, { n: "1e3" }, { n: "0x10" }, { n: ".5" }, { n: "5." }],
    problems: [
      { line: 3, column: 1, message: "not a number in column n" },
      { line: 4, column: 1, message: "not a number in column n" },
      { line: 5, column: 1, message: "not a number in column n" },
      { line: 6, column: 1, message: "not a number in column n" },
    ],
  });
});

test("31 boolean: true/false/yes/no/1/0 case-insensitively, else a problem", () => {
  expect(readCsv("b\ntrue\nFALSE\nYes\nno\n1\n0\nmaybe", { header: true, columns: { b: "boolean" } })).toEqual({
    rows: [{ b: true }, { b: false }, { b: true }, { b: false }, { b: true }, { b: false }, { b: "maybe" }],
    problems: [{ line: 8, column: 1, message: "not a boolean in column b" }],
  });
});

test("32 date: a real calendar date stays the same string, an impossible date is a problem", () => {
  expect(readCsv("d\n2024-01-15\n2023-02-29", { header: true, columns: { d: "date" } })).toEqual({
    rows: [{ d: "2024-01-15" }, { d: "2023-02-29" }],
    problems: [{ line: 3, column: 1, message: "not a date in column d" }],
  });
});

test("33 [D] a typed column's empty value is null; a failed conversion keeps the original string", () => {
  expect(readCsv("n,b,d\n,,\nabc,maybe,nope", { header: true, columns: { n: "number", b: "boolean", d: "date" } })).toEqual({
    rows: [{ n: null, b: null, d: null }, { n: "abc", b: "maybe", d: "nope" }],
    problems: [
      { line: 3, column: 1, message: "not a number in column n" },
      { line: 3, column: 5, message: "not a boolean in column b" },
      { line: 3, column: 11, message: "not a date in column d" },
    ],
  });
});

test("34 problems are ordered by line, then column", () => {
  expect(readCsv("a,b\nbad1,bad2", { header: true, columns: { b: "number", a: "number" } })).toEqual({
    rows: [{ a: "bad1", b: "bad2" }],
    problems: [
      { line: 2, column: 1, message: "not a number in column a" },
      { line: 2, column: 6, message: "not a number in column b" },
    ],
  });
});
