import { expect, test } from "bun:test";
import { noChecksNote } from "../src/app/commands";
import type { ProjectModel } from "../src/project/model";
import { formatReceipt, formatShortReceipt, NO_TEST_COMMAND, receiptView, TESTS_WITHOUT_COMMAND_LINE, taskExitCode, taskOutcome, type TaskResult } from "../src/task/result";
import { RECEIPT_HELP } from "../src/tui/help";
import { cardRows, receiptCard } from "../src/tui/receipt-card";
import { describeChecksPlan } from "../src/verify/mode";
import { proofSkipReason } from "../src/app/task-run";

const done = (task: Omit<TaskResult, "execution">): TaskResult => ({ execution: "completed", ...task });
const model = (extra: Partial<ProjectModel> = {}): ProjectModel => ({ schemaVersion: 1, project: { name: "demo", root: "/repo", git: false },
  languages: [], frameworks: [], packageManager: "npm", commands: {}, architecture: {}, conventions: [], detectedAt: "", ...extra });

// A project with tests Casper has no command for was told "no tests yet. Say "add tests"" (a benchmark: 11 of 24 projects).
test("a receipt over tests Casper can't run says so, not no tests; the outcome and exit code stay not verified", () => {
  const task = done({ changedPaths: ["sum.js"], verificationMode: "auto", autoSkipped: "no-checks", testsWithoutCommand: true });
  expect(TESTS_WITHOUT_COMMAND_LINE).toBe('– Not checked — Casper found tests but no command that runs them. Say "set up the test command".');
  expect(formatReceipt(task)).toBe(`${TESTS_WITHOUT_COMMAND_LINE}\n✓ Changed 1 file: sum.js`);
  expect(formatShortReceipt(task)).toBe(`${TESTS_WITHOUT_COMMAND_LINE}\n✓ changed sum.js`);
  expect(receiptView(task).verdict).toEqual({ line: TESTS_WITHOUT_COMMAND_LINE, section: "verdict", kind: "verdict", status: "Not checked",
    detail: "Casper found tests but no command that runs them", actions: ['"set up the test command"'] });
  const before = done({ changedPaths: ["sum.js"], verificationMode: "auto", autoSkipped: "no-checks" });
  expect([taskOutcome(undefined, task), taskExitCode(undefined, task)]).toEqual([taskOutcome(undefined, before), taskExitCode(undefined, before)]);
  expect(taskOutcome(undefined, task)).toBe("not_verified");
  // Later in a session the short form stays as it was.
  expect(formatReceipt(task, { checksHintShown: true }).split("\n")[0]).toBe("– Not verified — no checks set up");
  // Without tests, the words are as before.
  expect(formatReceipt(before).split("\n")[0]).toBe('– Not checked — no tests yet. Say "add tests".');
  // The card says it in its own rows, with what to say next; /help receipt explains it.
  expect(cardRows(receiptCard(receiptView(task), false)!, 100, false)).toEqual([
    "▌ ⚠ Not checked: Casper found tests but no command that runs them",
    "▌   Changed  sum.js",
    '▌   Next     "set up the test command"',
  ]);
  expect(RECEIPT_HELP.split("\n").find((line) => line.trimStart().startsWith("⚠ Not checked "))).toContain('say "set up the test command"');
});

test("/verify, /status and the proof line say the same: tests found, no command", async () => {
  const found = model({ testsWithoutCommand: true });
  expect(await noChecksNote(found, "/repo", "/home")).toBe('[verify] Casper found tests in repo but no command that runs them. Say "set up the test command".\n');
  expect(formatReceipt(done({ verification: { status: "incomplete", repairAttempts: 0, rounds: [], results: [], reason: NO_TEST_COMMAND } })).split("\n")[0])
    .toBe(TESTS_WITHOUT_COMMAND_LINE);
  expect(describeChecksPlan({ mode: "auto", checks: [], testsWithoutCommand: true }))
    .toBe('none: Casper found tests but no command that runs them; say "set up the test command"');
  expect(proofSkipReason({ intent: "fix", snapshot: true, changedCode: true, testsWithoutCommand: true }))
    .toBe('Casper found tests but no command that runs them; say "set up the test command"');
  // Tests the model wrote in this task still say that.
  expect(proofSkipReason({ intent: "fix", snapshot: true, changedCode: true, testsAddedNow: true, testsWithoutCommand: true }))
    .toBe("the tests came with this change, so there is no version without it to compare with");
  // No tests: as before.
  expect(describeChecksPlan({ mode: "auto", checks: [] })).toBe('none yet; say "add tests" and Casper writes some');
  expect(proofSkipReason({ intent: "fix", snapshot: true, changedCode: true })).toBe('there are no tests yet to compare with; say "add tests"');
});
