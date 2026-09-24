import { expect, test } from "bun:test";
import { taskExitCode, taskOutcome, type TaskOutcome, type TaskResult } from "../src/task/result";
import type { VerificationReport, VerificationResult } from "../src/verify/evidence";

function check(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return { name: "test", status: "pass", command: "npm run test", cwd: "/repo", exitCode: 0, signal: null,
    stdout: "", stderr: "", truncated: false, durationMs: 312, freshness: "fresh", ...overrides };
}
function report(status: VerificationReport["status"], results: VerificationResult[] = [check()]): VerificationReport {
  return { status, repairAttempts: 0, rounds: [results], results };
}
const done = (task: Omit<TaskResult, "execution">): TaskResult => ({ execution: "completed", verificationMode: "auto", ...task });

/** [case, task, outcome, exit without --require-verification, exit with it] */
const table: Array<[string, TaskResult | undefined, TaskOutcome, number, number]> = [
  ["a local command (no task)", undefined, "unchanged", 0, 0],
  ["a question that changed nothing", done({ changedPaths: [] }), "unchanged", 0, 0],
  ["no changes, so no checks", done({ changedPaths: [], autoSkipped: "no-changes" }), "unchanged", 0, 0],
  ["changes verified by a fresh pass", done({ changedPaths: ["a.ts"], verification: report("pass") }), "verified", 0, 0],
  ["a check failed", done({ changedPaths: ["a.ts"], verification: report("fail", [check({ status: "fail", exitCode: 1 })]) }), "failed", 1, 1],
  ["checks were blocked", done({ changedPaths: ["a.ts"], verification: report("blocked") }), "failed", 1, 1],
  ["checks incomplete", done({ changedPaths: ["a.ts"], verification: report("incomplete") }), "incomplete", 2, 2],
  ["changes with no checks configured", done({ changedPaths: ["a.ts"], autoSkipped: "no-checks" }), "not_verified", 2, 3],
  ["changes no check covers", done({ changedPaths: ["a.ts"], autoSkipped: "not-covered" }), "not_verified", 0, 3],
  ["changes with checks off", done({ changedPaths: ["a.ts"], verificationMode: "off" }), "not_verified", 0, 3],
  ["changes tested only via bash", done({ changedPaths: ["a.ts"], observedChecks: [{ name: "test", command: "npm test", toolStatus: "success", output: "", truncated: false }] }), "not_verified", 0, 3],
  ["a pass that went stale", done({ changedPaths: ["a.ts"], verification: report("pass", [check({ freshness: "stale" })]) }), "not_verified", 0, 3],
  ["unknown changes", done({ possibleMutations: true }), "not_verified", 0, 3],
  ["browser checks failed", done({ changedPaths: ["a.ts"], verification: report("pass"), browser: { status: "fail", checks: [], guidance: "" } }), "failed", 1, 1],
  ["browser checks incomplete", done({ changedPaths: ["a.ts"], verification: report("pass"), browser: { status: "incomplete", checks: [], guidance: "" } }), "incomplete", 2, 2],
  ["the model run failed", { execution: "failed", changedPaths: ["a.ts"] }, "failed", 1, 1],
  ["cancelled", { execution: "cancelled", changedPaths: ["a.ts"], verification: report("pass") }, "cancelled", 130, 130],
];

test("the exit code table: 0 done, 1 failed, 2 incomplete, 3 not verified (only when required), 130 cancelled", () => {
  for (const [name, task, outcome, plain, required] of table) {
    expect({ name, outcome: taskOutcome(undefined, task), plain: taskExitCode(undefined, task), required: taskExitCode(undefined, task, { requireVerification: true }) })
      .toEqual({ name, outcome, plain, required });
  }
});

test("a standalone /verify report decides the exit without a task", () => {
  expect(taskExitCode(report("pass"))).toBe(0);
  expect(taskExitCode(report("fail"), undefined, { requireVerification: true })).toBe(1);
  expect(taskOutcome(report("incomplete"))).toBe("incomplete");
});
