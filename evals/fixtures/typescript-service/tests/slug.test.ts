import { expect, test } from "bun:test";
import { slugify } from "../src/slug";

test("plain words are lowercased and dash-joined", () => {
  expect(slugify("Hello World")).toBe("hello-world");
});

test("accents fold to their ASCII base", () => {
  expect(slugify("Ünïcode")).toBe("unicode");
});

test("runs of separators collapse and edges are trimmed", () => {
  expect(slugify("  a -- b  ")).toBe("a-b");
  expect(slugify("--edge--")).toBe("edge");
});
