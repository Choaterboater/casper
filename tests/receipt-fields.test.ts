import { expect, test } from "bun:test";
import { receiptEvent, storedTaskResult } from "../src/app/json-events";
import type { PageReport } from "../src/services/page-report";
import { checksPassed, formatReceipt, formatTaskResult, taskOutcome, type TaskResult } from "../src/task/result";
import type { VerificationReport, VerificationResult } from "../src/verify/evidence";

const check = (fields: Partial<VerificationResult> = {}): VerificationResult => ({ name: "test", status: "pass", command: "bun test", cwd: "/", exitCode: 0,
  signal: null, stdout: "", stderr: "", truncated: false, durationMs: 1200, freshness: "fresh", ...fields });
const report = (fields: Partial<VerificationReport> = {}): VerificationReport => ({ status: "pass", repairAttempts: 0, rounds: [], results: [check()], ...fields });
const pages = (status: PageReport["status"]): PageReport => ({
  status, skipped: [], server: { name: "web", label: "vite", command: "bun run dev --token=abc123secret", origin: "http://127.0.0.1:5173" },
  pages: [{ path: "/dashboard", status, httpStatus: 200, consoleChecked: true,
    consoleErrors: status === "fail" ? ["Error: api_key=abc123secret rejected", "TypeError: x"] : [], failedRequests: [] }],
});

test("the repair line names the big model the last try used", () => {
  const task: TaskResult = { execution: "completed", changedPaths: ["a.py"], verification: report({ repairAttempts: 3 }), bigModel: { model: "anthropic/big", attempts: 1 } };
  expect(formatReceipt(task)).toContain("↻ Casper tried 3 repairs (the last on your big model anthropic/big)");
  expect(formatTaskResult(task)).toContain("anthropic/big for 1 repair");
  expect(formatReceipt({ ...task, bigModel: undefined })).toContain("↻ Casper tried 3 repairs\n");
});

test("page checks get a line each, and a failing page is the receipt's verdict", () => {
  const failed: TaskResult = { execution: "completed", changedPaths: ["src/App.tsx"], verification: report({ status: "fail", pages: pages("fail") }) };
  const text = formatReceipt(failed);
  expect(text.split("\n")[0]).toBe("✗ Failed — /dashboard has 2 console errors");
  expect(text).toContain("✗ /dashboard · 2 console errors: Error: api_key=abc123secret rejected");
  expect(taskOutcome(undefined, failed)).toBe("failed");
  const skipped: TaskResult = { execution: "completed", changedPaths: ["a"], verification: report({ status: "fail", results: [check({ status: "fail", exitCode: 1 })], pagesSkipped: "command checks failed" }) };
  expect(formatReceipt(skipped)).toContain("• Pages not checked: command checks failed");
});

test("security tools show as counts only", () => {
  const task: TaskResult = { execution: "completed", changedPaths: [], verification: report(),
    security: { problems: 2, notes: 0, notRun: 1, tools: [{ id: "gitleaks", status: "problems" }, { id: "semgrep", status: "not-run" }] } };
  expect(formatReceipt(task)).toContain("• Security tools: 2 problems, 1 check not run (what the tools found; not proof the code has no problems)");
  expect(receiptEvent(undefined, task, 0).security).toEqual(task.security!);
});

test("checksPassed is today's pass test, apart from the outcome", () => {
  const passed: TaskResult = { execution: "completed", changedPaths: ["a.ts"], verification: report() };
  expect(checksPassed(undefined, passed)).toBe(true);
  expect(taskOutcome(undefined, passed)).toBe("verified");
  const stale: TaskResult = { ...passed, verification: report({ results: [check({ freshness: "stale" })] }) };
  expect(checksPassed(undefined, stale)).toBe(false);
  expect(checksPassed(undefined, { ...passed, execution: "cancelled" })).toBe(false);
  expect(checksPassed(undefined, { ...passed, verification: report({ status: "fail" }) })).toBe(false);
  // Pages alone that load are a pass of the checks (not a proof).
  expect(checksPassed(undefined, { ...passed, verification: report({ results: [], pages: pages("pass") }) })).toBe(true);
});

test("the JSON receipt adds the new fields without changing the old ones", () => {
  const task: TaskResult = { execution: "completed", changedPaths: ["a.ts"], verification: report({ pages: pages("fail"), status: "fail", repairModels: ["small", "big"] }),
    receipt: 7, undo: { available: false, reason: "not a git folder and no copy was kept" } };
  const event = receiptEvent(undefined, task, 1);
  expect(event).toMatchObject({ outcome: "failed", exitCode: 1, checksPassed: false, repairModels: ["small", "big"], task: 7,
    undo: { available: false, reason: "not a git folder and no copy was kept" }, bigModel: null, security: null });
  expect(JSON.stringify(event.pages)).not.toContain("abc123secret");
  const plain = receiptEvent(undefined, { execution: "completed", changedPaths: [], verification: report() }, 0);
  expect(plain).toMatchObject({ pages: null, task: null, undo: null, repairModels: null, checksPassed: true });
});

test("a stored task keeps no check output and hides secrets in page text", () => {
  const task: TaskResult = { execution: "completed", changedPaths: ["a.ts"],
    verification: report({ status: "fail", results: [check({ status: "fail", stdout: "token=abc123secret", stderr: "boom" })], rounds: [[check()]], pages: pages("fail") }),
    observedChecks: [{ name: "test", command: "bun test", toolStatus: "error", output: "secret output", truncated: false }] };
  task.browser = { status: "fail", guidance: "g", checks: [{ id: "b1", name: "login", scenarioSha256: "0", url: "http://127.0.0.1:3000/?token=abc123secret",
    viewport: { width: 800, height: 600 }, status: "fail", baseline: "pass", freshness: "fresh",
    assertions: [{ kind: "text", status: "fail", actual: "Welcome, api_key=abc123secret" }] }] };
  const stored = storedTaskResult(task);
  expect(stored.verification!.results[0]).toMatchObject({ stdout: "", stderr: "" });
  expect(stored.verification!.rounds).toEqual([]);
  expect(stored.observedChecks![0]!.output).toBe("");
  expect(JSON.stringify(stored)).not.toContain("abc123secret");
  // The original evidence is untouched.
  expect(task.verification!.results[0]!.stdout).toBe("token=abc123secret");
});
