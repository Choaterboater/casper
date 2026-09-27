import { expect, test } from "bun:test";
import { wrap } from "../src/wrap";

test("wraps a sentence at width 20", () => {
  expect(wrap("The quick brown fox jumps", 20)).toBe("The quick brown fox\njumps");
});

test("a single word shorter than the width is returned unchanged", () => {
  expect(wrap("hello", 20)).toBe("hello");
});
