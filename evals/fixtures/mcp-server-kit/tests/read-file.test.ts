import { expect, test } from "bun:test";
import { findTool } from "../src/catalog";
import { MAX_OUTPUT_CHARS } from "../src/result";

const workspace = new Map([["README.md", "hello"], ["big.txt", "x".repeat(10_000)]]);
const readFile = findTool("read_file")!;

test("reads a file", () => {
  expect(readFile.call({ path: "README.md" }, workspace)).toEqual({ content: [{ type: "text", text: "hello" }] });
});

test("bad input and missing files are tool errors, not exceptions", () => {
  expect(readFile.call({}, workspace).isError).toBe(true);
  expect(readFile.call({ path: "README.md", extra: 1 }, workspace).isError).toBe(true);
  expect(readFile.call({ path: "nope" }, workspace)).toEqual({ content: [{ type: "text", text: "No such file: nope" }], isError: true });
});

test("large files are truncated with a marker", () => {
  const text = readFile.call({ path: "big.txt" }, workspace).content[0]!.text;
  expect(text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
  expect(text).toContain("truncated");
});
