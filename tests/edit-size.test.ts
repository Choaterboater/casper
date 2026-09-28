import { expect, test } from "bun:test";
import { patchLineCounts, writeLineCounts } from "../src/runtime/observation";
import { formatToolActivity } from "../src/tui/format";

const patch = [
  "Index: src/x.py", "===================================================================", "--- src/x.py", "+++ src/x.py",
  "@@ -1,4 +1,5 @@", " keep", "-old one", "-old two", "+new one", "+new two", "+new three", " keep",
  "@@ -10,2 +11,2 @@", "---flag", "+++flag", "\\ No newline at end of file",
].join("\n");

test("an edit's size comes from Pi's patch, counting only hunk lines", () => {
  expect(patchLineCounts({ content: [], details: { patch } })).toEqual({ added: 4, removed: 3 });
  expect(patchLineCounts({ content: [], details: { diff: "x" } })).toBeUndefined();
  expect(patchLineCounts(undefined)).toBeUndefined();
});

test("the edit line shows its size", () => {
  expect(formatToolActivity({ type: "tool_end", toolName: "edit", input: { path: "src/x.py" }, isError: false, lines: { added: 18, removed: 4 } }, 40))
    .toBe("✓ edit · src/x.py · +18 -4 — completed · 0.0s");
  expect(formatToolActivity({ type: "tool_end", toolName: "write", input: { path: "a.txt" }, isError: false }, 40))
    .toBe("✓ write · a.txt — completed · 0.0s");
});

test("a write's size compares the old and new text: a new file is all added, a rewrite counts changed lines", () => {
  expect(writeLineCounts(undefined, "a\nb\nc\n")).toEqual({ added: 3, removed: 0 });
  expect(writeLineCounts("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1 });
  expect(writeLineCounts("same\r\n", "same\n")).toEqual({ added: 0, removed: 0 });
  expect(writeLineCounts("x\n", "")).toEqual({ added: 0, removed: 1 });
});
