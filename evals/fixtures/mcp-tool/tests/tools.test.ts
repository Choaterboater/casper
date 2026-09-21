import { expect, test } from "bun:test";
import { findTool, tools } from "../src/tools";

test("the catalog exposes both tools in order", () => {
  expect(tools.map((tool) => tool.name)).toEqual(["count_words", "reverse_text"]);
});

test("count_words requires a text argument and counts words", () => {
  const tool = findTool("count_words")!;
  expect(tool.inputSchema).toMatchObject({ type: "object", required: ["text"], additionalProperties: false });
  expect(tool.execute({ text: "one two   three" })).toBe("3");
  expect(() => tool.execute({})).toThrow("Missing required string argument: text");
});

test("reverse_text reverses by character", () => {
  expect(findTool("reverse_text")!.execute({ text: "abc" })).toBe("cba");
});
