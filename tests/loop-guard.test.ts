import { expect, test } from "bun:test";
import { LoopGuard, REFUSED_NOTE, REPEAT_NOTE } from "../src/runtime/loop-guard";

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

test("a refused shell command gets a note at its 3rd try and is skipped from the 5th, even with other calls between; a run or a new request clears it", () => {
  const refused = "Not run: shell commands need your OK here, and this run can't ask.";
  const guard = new LoopGuard();
  const start = (id: string, text = refused) => run(guard, id, "bash", { command: "bun src/server.ts", timeout: Number(id.length) }, text);
  expect(start("1")).toEqual({});
  run(guard, "w", "write", { path: "src/server.ts", content: "x" });
  expect(start("2")).toEqual({});
  expect(start("3")).toEqual({ note: REFUSED_NOTE });
  expect(start("4")).toEqual({ note: REFUSED_NOTE });
  const fifth = start("5");
  expect(fifth.skipped).toContain("refused 4 times");
  expect(fifth.skipped).toContain(refused);
  // Other commands, and the same words that ran, count apart.
  expect(run(guard, "t", "bash", { command: "bun test" }, refused)).toEqual({});
  guard.reset();
  expect(start("6")).toEqual({});
  for (const id of ["7", "8"]) start(id);
  start("9", "listening on http://127.0.0.1:3000");
  expect(start("10")).toEqual({});
});
