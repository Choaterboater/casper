import { expect, test } from "bun:test";
import { elisionTexts, newElisions } from "../src/runtime/elision";

test("each placeholder written where code was is flagged", () => {
  for (const line of [
    "// ... existing code ...",
    "  // ... rest of the file unchanged",
    "/* ... unchanged */",
    "<!-- ... omitted -->",
    "# ... rest unchanged",
    "-- rest of the function stays the same",
    "{/* ... existing JSX ... */}",
    "// unchanged …",
  ]) expect(newElisions("", `const a = 1;\n${line}\nconst b = 2;\n`)).toEqual([line.trim()]);
});

test("a placeholder the old file already had is not flagged, a second copy is", () => {
  const before = "a();\n// ... existing code ...\nb();\n";
  expect(newElisions(before, before + "c();\n")).toEqual([]);
  expect(newElisions(before, before + "// ... existing code ...\n")).toEqual(["// ... existing code ..."]);
});

test("spread syntax and a plain unchanged are not flagged", () => {
  const code = [
    "const { a, ...rest } = props;",
    "call(...args);",
    "return [...items, next];",
    "// keep this unchanged for old clients",
    "# the rest is handled below",
    "const note = '... existing code ...';",
  ].join("\n");
  expect(newElisions("", code)).toEqual([]);
});

test("an edit compares its new text with the text it replaces", () => {
  const edit = { path: "a.ts", edits: [{ oldText: "a();\nb();\nc();", newText: "a();\n// ... existing code ...\nc();" }] };
  const texts = elisionTexts("edit", edit, undefined)!;
  expect(newElisions(texts.before, texts.after)).toEqual(["// ... existing code ..."]);
  const write = elisionTexts("write", { path: "a.ts", content: "x();\n" }, "// ... omitted ...\n")!;
  expect(newElisions(write.before, write.after)).toEqual([]);
  expect(elisionTexts("read", { path: "a.ts" }, undefined)).toBeUndefined();
});
