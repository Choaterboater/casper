import { expect, test } from "bun:test";
import { formatReceipt, type TaskResult } from "../src/task/result";
import type { VerificationReport, VerificationResult } from "../src/verify/evidence";

function check(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return { name: "test", status: "pass", command: "npm run test", cwd: "/repo", exitCode: 0, signal: null,
    stdout: "", stderr: "", truncated: false, durationMs: 312, freshness: "unavailable", ...overrides };
}
function report(results: VerificationResult[], overrides: Partial<VerificationReport> = {}): VerificationReport {
  const status = results.some((result) => result.status === "fail") ? "fail" : "pass";
  return { status, repairAttempts: 0, rounds: [results], results, ...overrides };
}
const done = (task: Omit<TaskResult, "execution">): TaskResult => ({ execution: "completed", ...task });

test("a Casper-run pass names the check, command and time", () => {
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]) })))
    .toBe("✓ Changed 1 file: sum.js\n✓ Verified by Casper: test passed (npm run test, 0.3s)");
});

test("a pass reused from earlier in the task says so, and that its time is the earlier run's", () => {
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check({ freshness: "fresh", reused: true })]) })))
    .toBe("✓ Changed 1 file: sum.js\n✓ Verified by Casper: test passed earlier in this task, reused (npm run test, 0.3s)");
});

test("a failure names the exit and the next command, per surface", () => {
  const task = done({ changedPaths: ["sum.js"], verificationMode: "auto",
    verification: report([check({ status: "fail", exitCode: 1, durationMs: 1500 })], { repairAttempts: 2, reason: "Repair limit reached." }) });
  expect(formatReceipt(task)).toBe([
    "✓ Changed 1 file: sum.js",
    "↻ Casper tried 2 repairs",
    "✗ Verified by Casper: test failed (exit 1) — log above; /verify repair test to fix",
  ].join("\n"));
  expect(formatReceipt(task, { surface: "one-shot" })).toEndWith("✗ Verified by Casper: test failed (exit 1) — log above; casper \"/verify repair test\" to fix");
});

test("a timeout or signal is described without internal terms", () => {
  const timedOut = formatReceipt(done({ changedPaths: ["a.ts"], verification: report([
    check({ status: "fail", exitCode: null, reason: "Timed out after 600000ms", durationMs: 600_010 }),
    check({ name: "build", command: "make", status: "fail", exitCode: null, signal: "SIGKILL" }),
  ]) }));
  expect(timedOut).toContain("✗ Verified by Casper: test failed (timed out after 10m) — log above; /verify repair test to fix");
  expect(timedOut).toContain("✗ Verified by Casper: build failed (stopped by SIGKILL) — log above; /verify repair build to fix");
});

test("bash-only test runs are reported but not counted as verification", () => {
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "offer",
    observedChecks: [{ name: "test", command: "npm test", toolStatus: "success", output: "", truncated: false }] }))).toBe([
    "✓ Changed 1 file: sum.js",
    "• Not verified — test ran via bash only (npm test: passed). Run /verify test to record a check.",
  ].join("\n"));
});

test("each reason Casper ran no checks is stated with a way forward", () => {
  expect(formatReceipt(done({ changedPaths: [], verificationMode: "auto", autoSkipped: "no-changes" })))
    .toBe("• No files changed, so Casper ran no checks");
  // Checks the model ran itself are still reported when nothing changed.
  expect(formatReceipt(done({ changedPaths: [], verificationMode: "auto", autoSkipped: "no-changes", verification: report([check()]) })))
    .toBe("• No files changed\n✓ Verified by Casper: test passed (npm run test, 0.3s)");
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "auto", autoSkipped: "no-checks" })))
    .toBe("✓ Changed 1 file: sum.js\n• Not verified — no checks configured. Add verify.test to .casper/project.yaml.");
  expect(formatReceipt(done({ changedPaths: ["README.md"], verificationMode: "auto", autoSkipped: "not-covered" })))
    .toBe("✓ Changed 1 file: README.md\n• Not verified — no configured check covers the changed files.");
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "offer" })))
    .toBe("✓ Changed 1 file: sum.js\n• Not verified — run /verify to check these changes.");
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "off" }), { surface: "one-shot" }))
    .toBe("✓ Changed 1 file: sum.js\n• Not verified — checks are off for this run. Run casper --verify to have Casper check.");
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verification: report([check({ status: "skip", command: undefined, exitCode: null })], { status: "incomplete" }) })))
    .toBe("✓ Changed 1 file: sum.js\n• Not verified — test has no command. Add verify.test to .casper/project.yaml.");
});

test("a pass whose inputs changed afterwards is stale, not verified", () => {
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verification: report([check({ freshness: "stale" })]) })))
    .toBe("✓ Changed 1 file: sum.js\n• Not verified — stale: files changed after the last passing test. Run /verify test.");
});

test("stopped tasks, unknown changes, long path lists and browser checks read plainly", () => {
  expect(formatReceipt({ execution: "cancelled", possibleMutations: true })).toBe([
    "✗ Stopped: cancelled — changes already made are kept",
    "• Changes unknown — Casper could not compare the workspace",
  ].join("\n"));
  const paths = Array.from({ length: 10 }, (_, index) => `f${index}.ts`);
  expect(formatReceipt(done({ changedPaths: paths, changedDuringChecks: ["dist/out.js"] }))).toBe([
    "✓ Changed 10 files: f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts … +2 more",
    "• Changed while checking: dist/out.js",
  ].join("\n"));
  expect(formatReceipt(done({ changedPaths: [], browser: { status: "fail", checks: [
    { name: "home", status: "fail", freshness: "fresh", baseline: "new" }] } as unknown as TaskResult["browser"] })))
    .toBe("• No files changed\n✗ Browser checks failed: home");
});

test("the default receipt never uses internal terms and escapes terminal controls", () => {
  const text = formatReceipt(done({ changedPaths: ["a\n\u001b[31mforged"], verification: report([check(), check({ name: "build", freshness: "fresh", scope: { inputs: ["src"] }, reused: true })]) }));
  // "reused" is plain language here (the build passed earlier in the task); "reuse disabled" is not.
  expect(text).not.toMatch(/scope|reuse disabled|declared-input|freshness|fingerprint|undeclared|certified|\u001b/);
  expect(text.split("\n")).toHaveLength(3);
});

test("a request stopped by --max-turns says so and how to go on, per surface", () => {
  const task = done({ changedPaths: ["a.ts"], turnLimit: 3, verificationMode: "auto" });
  expect(formatReceipt(task, { surface: "one-shot" })).toBe([
    "✗ Stopped after 3 turns (--max-turns) — changes so far are kept; casper --continue to go on",
    "✓ Changed 1 file: a.ts",
  ].join("\n"));
  expect(formatReceipt({ ...task, turnLimit: 1 })).toStartWith("✗ Stopped after 1 turn (--max-turns) — changes so far are kept; send another request to go on");
});

test("the receipt says whether the tests prove the change, and never calls an unproven change verified alone", () => {
  const passed = (proof: TaskResult["proof"]) => formatReceipt(done({ changedPaths: ["src/sum.js"], verificationMode: "auto", verification: report([check()]), proof }))
    .split("\n").slice(2).join("\n");
  const proven = (without: Extract<NonNullable<TaskResult["proof"]>, { status: "proven" }>["without"]) =>
    passed({ status: "proven", check: "test", command: "npm run test", testsChanged: true, without });
  expect(proven({ exitCode: 1, ended: "fail", output: "expected 3, got 2" }))
    .toBe("✓ Proven: test fails without this change (exit 1) and passes with it");
  // A run that did not fail as a test fails is weaker evidence, and says so.
  expect(proven({ exitCode: 143, ended: "timeout", reason: "Timed out after 20000ms" }))
    .toBe("✓ Proven, weakly: test passes with this change; without it test timed out after 20.0s instead of failing");
  expect(proven({ exitCode: 139, ended: "crash" }))
    .toBe("✓ Proven, weakly: test passes with this change; without it test crashed or was killed (exit 139) instead of failing");
  expect(proven({ exitCode: 127, ended: "no_start" }))
    .toBe("✓ Proven, weakly: test passes with this change; without it test could not start (exit 127) instead of failing");
  const unproven = { exitCode: 0, ended: "pass" } as const;
  expect(passed({ status: "unproven", check: "test", command: "npm run test", testsChanged: false, without: unproven }))
    .toBe("⚠ Not proven: test passes without this change too, and no test was added or changed");
  expect(passed({ status: "unproven", check: "test", command: "npm run test", testsChanged: true, without: unproven }))
    .toBe("⚠ Not proven: test passes without this change too; the changed tests do not check it");
  expect(passed({ status: "unavailable", check: "test", reason: "the workspace has more than 20000 files" }))
    .toBe("• Not proven — the workspace has more than 20000 files");
});
