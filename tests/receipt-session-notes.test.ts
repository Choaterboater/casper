import { expect, test } from "bun:test";
import { formatShortReceipt, formatTaskResult, rememberSessionNotes, type TaskResult } from "../src/task/result";

const task = (extra: Partial<TaskResult> = {}): TaskResult => ({
  execution: "completed", autoSkipped: "no-checks", possibleMutations: true,
  snapshotFailure: { reason: "not a project folder (over 20,000 files)", edited: [] },
  sandbox: { held: false, reason: "/sandbox off for this session; /sandbox on puts it back" }, ...extra,
});

test("session notes are said in full on the first receipt, then in one short line; a task's own warning always in full, first", () => {
  const seen = new Set<string>();
  const first = formatShortReceipt(task(), { seenNotes: seen });
  expect(first).toContain("– Changes unknown: not a project folder (over 20,000 files)");
  expect(first).toContain("– Shell commands and checks were not sandboxed (/sandbox off for this session; /sandbox on puts it back)");
  expect(first).not.toContain("Same as before");
  rememberSessionNotes(seen, task());
  const second = formatShortReceipt(task({ secretInCommand: true }), { seenNotes: seen });
  const lines = second.split("\n");
  expect(lines[1]).toBe("⚠ A secret appeared in a command; change it after this task.");
  expect(second).not.toContain("Shell commands and checks were not sandboxed");
  expect(second).not.toContain("– Changes unknown:");
  expect(lines).toContain("– Same as before: changes unknown (not a project folder) · not sandboxed (/receipt)");
  // /receipt still says every note in full.
  expect(formatTaskResult(task())).toContain("not sandboxed (/sandbox off for this session; /sandbox on puts it back)");
});

test("a note whose state ended is forgotten, so when it comes back it is said in full again", () => {
  const seen = new Set<string>();
  rememberSessionNotes(seen, task());
  rememberSessionNotes(seen, task({ sandbox: { held: true } }));
  expect([...seen]).toEqual(["changes:not a project folder (over 20,000 files)"]);
  expect(formatShortReceipt(task(), { seenNotes: seen })).toContain("– Shell commands and checks were not sandboxed");
  // A different reason is a different note.
  rememberSessionNotes(seen, task());
  expect(formatShortReceipt(task({ sandbox: { held: false, reason: "--no-sandbox" } }), { seenNotes: seen }))
    .toContain("– Shell commands and checks were not sandboxed (--no-sandbox)");
});
