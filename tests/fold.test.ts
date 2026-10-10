import { expect, test } from "bun:test";
import { EDIT_BOX_LINES, planFold, type FinishedStep } from "../src/app/fold";
import { GLYPHS } from "../src/tui/glyphs";
import { renderEditBox, renderFailureBox } from "../src/tui/step-view";

const step = (toolName: string, extra: Partial<FinishedStep> = {}): FinishedStep => ({
  toolName, kind: toolName === "edit" || toolName === "write" ? "edit" : toolName === "bash" ? "command" : "read",
  printed: `✓ ${toolName}`, title: `✓ ${toolName}`, ...extra,
});
const patch = (lines: number) => `@@ -1,${lines} +1,${lines} @@\n${Array.from({ length: lines }, (_, index) => `-old ${index}\n+new ${index}`).join("\n")}\n`;
const fit = { root: "/work/app", home: "/home/someone" };
// A box's corners as this terminal draws them: square on the old Windows console.
const [TOP_LEFT, TOP_RIGHT] = GLYPHS.corners;

test("normal: one row for what went well, one box for the edits, a box per failure; a not-run step keeps its line", () => {
  const fold = planFold([
    step("read", { input: { path: "/work/app/a.ts" } }),
    step("edit", { path: "/work/app/a.ts", lines: { added: 1, removed: 1 }, diff: patch(1) }),
    step("bash", { input: { command: "git push" }, failed: true, title: "✗ bash · git push — failed", output: "fatal: no login" }),
    step("bash", { input: { command: "cat ~/.ssh/config" }, notRun: true, printed: "○ bash · cat ~/.ssh/config — not run\n  It is private." }),
    step("edit", { path: "/work/app/b.ts", failed: true, retried: true, title: "✗ edit · b.ts — failed", output: "old text not found" }),
  ], "normal", fit);
  expect(fold.parts.map(part => [part.verb, part.names])).toEqual([["read", ["a.ts"]]]);
  expect(fold.edits).toEqual([{ path: "a.ts", added: 1, removed: 1, diff: patch(1) }]);
  expect(fold.editLines).toBe(EDIT_BOX_LINES);
  // A failed edit the model tried again at once is shown nowhere.
  expect(fold.failures).toEqual([{ title: "✗ bash · git push — failed", output: "fatal: no login", home: "/home/someone" }]);
  expect(fold.lines).toEqual(["○ bash · cat ~/.ssh/config — not run\n  It is private."]);
});

test("quiet keeps only failures and steps that never ran; detailed shows every step and every edit's whole diff", () => {
  const steps = [
    step("read", { input: { path: "/work/app/a.ts" }, printed: "✓ read · a.ts" }),
    step("edit", { path: "/work/app/a.ts", diff: patch(20) }),
    step("bash", { failed: true, title: "✗ bash · x — failed", output: "boom" }),
  ];
  const quiet = planFold(steps, "quiet", fit);
  expect([quiet.parts, quiet.edits, quiet.failures.length]).toEqual([[], [], 1]);
  const detailed = planFold(steps, "detailed", fit);
  expect(detailed.lines).toEqual(["✓ read · a.ts"]);
  expect(detailed.editLines).toBe(Infinity);
  expect(renderEditBox(detailed.edits, 60, { color: false, maxLines: detailed.editLines }).join("\n")).not.toContain("more lines");
});

test("edits with no diff to show are named in the row; the box holds ten rows and says what it left out", () => {
  const written = planFold([step("write", { path: "/work/app/new.ts" })], "normal", fit);
  expect([written.edits, written.parts.map(part => `${part.verb} ${part.names.join(", ")}`)]).toEqual([[], ["edited new.ts"]]);
  const box = renderEditBox([{ path: "a.ts", added: 20, removed: 20, diff: patch(20) }, { path: "b.ts" }], 50, { color: false, maxLines: 10 });
  expect(box[0]).toBe(`${TOP_LEFT}─ Edited 2 files ${"─".repeat(31)}${TOP_RIGHT}`);
  const body = box.slice(1, -1).map(row => row.slice(2, -2).trimEnd());
  expect(body[0]).toBe("a.ts  +20 -20");
  expect(body).toContain("b.ts");
  expect(body.filter(row => /^ {2}[+-] /.test(row))).toHaveLength(8);
  expect(body.at(-1)).toBe("… 32 more lines · Ctrl+T shows all");
});

test("a failure box shows the last lines as they were, redacted, with home as ~, and says more came before", () => {
  const output = [...Array.from({ length: 9 }, (_, index) => `line ${index}`), "token=sk-or-v1-abcdef0123456789abcdef0123456789",
    "open /home/someone/.config/gh/config.yml: operation not permitted"].join("\n");
  const box = renderFailureBox({ title: "✗ bash · git push — failed", output, home: "/home/someone" }, 70, false);
  const text = box.join("\n");
  expect(box[0]).toStartWith(`${TOP_LEFT}─ ✗ bash · git push — failed ─`);
  expect(text).toContain("… 5 earlier lines · Ctrl+T shows all");
  expect(text).toContain("open ~/.config/gh/config.yml: operation not permitted");
  expect(text).not.toContain("abcdef0123456789abcdef");
  expect(text).not.toContain("/home/someone");
  expect(text).toMatch(/│ line 8 +│/);
});
