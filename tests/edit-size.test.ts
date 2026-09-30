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
    .toBe("✓ edit · src/x.py · +18 -4");
  expect(formatToolActivity({ type: "tool_end", toolName: "write", input: { path: "a.txt" }, isError: false }, 40))
    .toBe("✓ write · a.txt");
});

test("a write's size compares the old and new text: a new file is all added, a rewrite counts changed lines", () => {
  expect(writeLineCounts(undefined, "a\nb\nc\n")).toEqual({ added: 3, removed: 0 });
  expect(writeLineCounts("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({ added: 2, removed: 1 });
  expect(writeLineCounts("same\r\n", "same\n")).toEqual({ added: 0, removed: 0 });
  expect(writeLineCounts("x\n", "")).toEqual({ added: 0, removed: 1 });
});

test("tool lines print paths relative to the project and fit one row of a narrow terminal", () => {
  const edit = { type: "tool_end", toolName: "edit", input: { path: "/work/app/tests/test_calc.py" }, isError: false, lines: { added: 9, removed: 1 } } as const;
  expect(formatToolActivity(edit, 12, { root: "/work/app", width: 100 })).toBe("✓ edit · tests/test_calc.py · +9 -1");
  // Narrow: the words go first, then the path is shortened from the front, keeping its file name.
  const deep = { ...edit, input: { path: "/work/app/tests/unit/test_calc.py" } };
  const narrow = formatToolActivity(deep, 2500, { root: "/work/app", width: 36 });
  expect(narrow).toBe("✓ edit · …st_calc.py · +9 -1 · 2.5s");
  expect([...narrow].length).toBeLessThan(36);
  // A command shows as a short label and keeps its start.
  const bash = { type: "tool_start", toolName: "bash", input: { command: "python3 -m pytest -q tests/test_calc.py --maxfail=1 -x" } } as const;
  expect(formatToolActivity(bash, undefined, { width: 100 })).toBe("• bash · python3 -m pytest …");
  expect(formatToolActivity(bash, undefined, { width: 24 })).toBe("• bash · python3 -m py…");
});
