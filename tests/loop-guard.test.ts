import { expect, test } from "bun:test";
import { LoopGuard, REPEAT_NOTE } from "../src/runtime/loop-guard";

function run(guard: LoopGuard, id: string, toolName: string, input: unknown, text = "file text"): { skipped?: string; note?: string } {
  const skipped = guard.before(id, toolName, input);
  const note = guard.after(id, toolName, input, [skipped ?? text]);
  return { ...(skipped ? { skipped } : {}), ...(note ? { note } : {}) };
}

test("the 3rd identical read gets the note and the 5th is skipped with the earlier result", () => {
  const guard = new LoopGuard();
  expect(run(guard, "1", "read", { path: "a.ts" })).toEqual({});
  expect(run(guard, "2", "read", { path: "a.ts" })).toEqual({});
  expect(run(guard, "3", "read", { path: "a.ts" })).toEqual({ note: REPEAT_NOTE });
  expect(run(guard, "4", "read", { path: "a.ts" })).toEqual({ note: REPEAT_NOTE });
  const fifth = run(guard, "5", "read", { path: "a.ts" });
  expect(fifth.note).toBeUndefined();
  expect(fifth.skipped).toContain("Skipped as a repeat");
  expect(fifth.skipped).toContain("file text");
  expect(run(guard, "6", "read", { path: "a.ts" }).skipped).toContain("file text");
});

test("arguments are compared as normalised JSON and different calls count apart", () => {
  const guard = new LoopGuard();
  run(guard, "1", "grep", { pattern: "x", path: "src" });
  run(guard, "2", "grep", { path: "src", pattern: "x" });
  run(guard, "3", "read", { path: "b.ts" });
  expect(run(guard, "4", "grep", { path: "src", pattern: "x" })).toEqual({ note: REPEAT_NOTE });
  expect(run(guard, "5", "grep", { path: "src", pattern: "y" })).toEqual({});
});

test("an edit, write or shell command resets the counts", () => {
  for (const tool of ["edit", "write", "bash", "powershell"]) {
    const guard = new LoopGuard();
    for (const id of ["1", "2", "3", "4"]) run(guard, id, "read", { path: "a.ts" });
    expect(run(guard, "c", tool, { path: "a.ts", command: "true" })).toEqual({});
    expect(run(guard, "5", "read", { path: "a.ts" })).toEqual({});
  }
});

test("tools whose answers change on their own, like the browser, are never counted", () => {
  const guard = new LoopGuard();
  for (const id of ["1", "2", "3", "4", "5", "6"]) expect(run(guard, id, "browser", { action: "wait", text: "Saved" })).toEqual({});
});

test("a new request starts the counts again", () => {
  const guard = new LoopGuard();
  for (const id of ["1", "2", "3", "4"]) run(guard, id, "ls", { path: "." });
  guard.reset();
  expect(run(guard, "5", "ls", { path: "." })).toEqual({});
});
