import { expect, test } from "bun:test";
import { answerClaimsBrowserPass, checksPassed, formatReceipt, formatShortReceipt, formatTaskResult, liveCheckLine, taskOutcome, undoPathsShown, type TaskResult } from "../src/task/result";
import type { VerificationReport, VerificationResult } from "../src/verify/evidence";
import { COMMIT_CHECK_LABEL, DRY_RUN_LABEL } from "../src/network/checks";

function check(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return { name: "test", status: "pass", command: "npm run test", cwd: "/repo", exitCode: 0, signal: null,
    stdout: "", stderr: "", truncated: false, durationMs: 1312, freshness: "unavailable", ...overrides };
}
function report(results: VerificationResult[], overrides: Partial<VerificationReport> = {}): VerificationReport {
  const status = results.some((result) => result.status === "fail") ? "fail" : "pass";
  return { status, repairAttempts: 0, rounds: [results], results, ...overrides };
}
const done = (task: Omit<TaskResult, "execution">): TaskResult => ({ execution: "completed", ...task });

test("a Casper-run pass names the check, command and time", () => {
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]) })))
    .toBe("• Checks passed — not proven: Casper did not compare the tests with and without the change\n✓ Changed 1 file: sum.js\n✓ test passed (npm run test, 1.3s)");
});

test("the outcome is verified only when line 1 is Verified; the Checks passed lines stay the same", () => {
  const proven = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]),
    proof: { status: "proven", check: "test", command: "npm run test", testsChanged: true, without: { exitCode: 1, ended: "fail" } } });
  expect(taskOutcome(undefined, proven)).toBe("verified");
  expect(formatReceipt(proven).split("\n")[0]).toBe("✓ Verified — the checks pass, and the tests fail without the change");
  const skipped = done({ changedPaths: ["README.md"], verificationMode: "auto", verification: report([check()]), proofSkipped: "only docs changed" });
  expect(taskOutcome(undefined, skipped)).toBe("not_verified");
  expect(checksPassed(undefined, skipped)).toBe(true);
  expect(formatReceipt(skipped).split("\n")[0]).toBe("• Checks passed — not proven: only docs changed");
  const nothing = done({ changedPaths: [], verificationMode: "auto", verification: report([check()]) });
  expect(taskOutcome(undefined, nothing)).toBe("unchanged");
  expect(formatReceipt(nothing).split("\n")[0]).toBe("✓ Checks passed — no files changed");
});

test("a pass reused from earlier in the task says so, and that its time is the earlier run's", () => {
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check({ freshness: "fresh", reused: true })]) })))
    .toBe("• Checks passed — not proven: Casper did not compare the tests with and without the change\n✓ Changed 1 file: sum.js\n✓ test passed earlier in this task, reused (npm run test, 1.3s)");
});

test("a failure names the exit and the next command, per surface", () => {
  const task = done({ changedPaths: ["sum.js"], verificationMode: "auto",
    verification: report([check({ status: "fail", exitCode: 1, durationMs: 1500 })], { repairAttempts: 2, reason: "Repair limit reached." }) });
  expect(formatReceipt(task)).toBe([
    "✗ Failed — test failed",
    "✓ Changed 1 file: sum.js",
    "↻ Casper tried 2 repairs",
    "✗ test failed (exit 1) — log above; /verify repair test to fix",
  ].join("\n"));
  expect(formatReceipt(task, { surface: "one-shot" })).toEndWith("✗ test failed (exit 1) — log above; casper \"/verify repair test\" to fix");
});

test("a timeout or signal is described without internal terms", () => {
  const timedOut = formatReceipt(done({ changedPaths: ["a.ts"], verification: report([
    check({ status: "fail", exitCode: null, reason: "Timed out after 600000ms", durationMs: 600_010 }),
    check({ name: "build", command: "make", status: "fail", exitCode: null, signal: "SIGKILL" }),
  ]) }));
  expect(timedOut).toContain("✗ test failed (timed out after 10m) — log above; /verify repair test to fix");
  expect(timedOut).toContain("✗ build failed (stopped by SIGKILL) — log above; /verify repair build to fix");
});

test("bash-only test runs are reported but not counted as verification", () => {
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "offer",
    observedChecks: [{ name: "test", command: "npm test", toolStatus: "success", output: "", truncated: false }] }))).toBe([
    "• Not verified — test ran via bash only (npm test: passed). Run /verify test to record a check.",
    "✓ Changed 1 file: sum.js",
  ].join("\n"));
});

test("each reason Casper ran no checks is stated with a way forward", () => {
  expect(formatReceipt(done({ changedPaths: [], verificationMode: "auto", autoSkipped: "no-changes" })))
    .toBe("• No files changed, so Casper ran no checks");
  // Checks the model ran itself are still reported when nothing changed.
  expect(formatReceipt(done({ changedPaths: [], verificationMode: "auto", autoSkipped: "no-changes", verification: report([check()]) })))
    .toBe("✓ Checks passed — no files changed\n• No files changed\n✓ test passed (npm run test, 1.3s)");
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "auto", autoSkipped: "no-checks" })))
    .toBe('• Not checked — no tests yet. Say "add tests".\n✓ Changed 1 file: sum.js');
  expect(formatReceipt(done({ changedPaths: ["README.md"], verificationMode: "auto", autoSkipped: "not-covered" })))
    .toBe("• Not verified — no configured check covers the changed files.\n✓ Changed 1 file: README.md");
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "offer" })))
    .toBe("• Not verified — run /verify to check these changes.\n✓ Changed 1 file: sum.js");
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "off" }), { surface: "one-shot" }))
    .toBe("• Not verified — checks are off for this run. Run casper --verify to have Casper check.\n✓ Changed 1 file: sum.js");
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verification: report([check({ status: "skip", command: undefined, exitCode: null })], { status: "incomplete" }) })))
    .toBe("• Incomplete — not every check ran\n✓ Changed 1 file: sum.js\n• Not verified — test has no command here. Say \"add tests\".");
});

test("later receipts in a session say the no-checks line short and leave out files undo already named", () => {
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "auto", autoSkipped: "no-checks" }), { checksHintShown: true }))
    .toBe("• Not verified — no checks set up\n✓ Changed 1 file: sum.js");
  const task = done({ changedPaths: ["a.local.json", "b.local.json"], verificationMode: "off",
    undo: { available: true, left: [{ path: "a.local.json", why: "ignored" }, { path: "b.local.json", why: "ignored" }] } });
  expect(formatReceipt(task)).toContain("• Undo can't put back: a.local.json (ignored), b.local.json (ignored)");
  expect(formatReceipt(task, { undoNamed: new Set(["a.local.json"]) })).toContain("• Undo can't put back: b.local.json (ignored)");
  expect(formatReceipt(task, { undoNamed: new Set(["a.local.json", "b.local.json"]) })).not.toContain("Undo can't put back");
  // Files past the receipt's limit are not counted as named, so a later receipt names them.
  const many = Array.from({ length: 10 }, (_, i) => `f${i}.local.json`);
  const big = done({ changedPaths: many, verificationMode: "off", undo: { available: true, left: many.map((path) => ({ path, why: "ignored" })) } });
  const first = undoPathsShown(big);
  expect(first).toEqual(many.slice(0, 8));
  expect(formatReceipt(big, { undoNamed: new Set(first) })).toContain("• Undo can't put back: f8.local.json (ignored), f9.local.json (ignored)");
});

test("a pass whose inputs changed afterwards is stale, not verified", () => {
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verification: report([check({ freshness: "stale" })]) })))
    .toBe("• Not verified — stale: files changed after the last passing test. Run /verify test.\n✓ Changed 1 file: sum.js");
});

test("stopped tasks, unknown changes, long path lists and browser checks read plainly", () => {
  expect(formatReceipt({ execution: "cancelled", possibleMutations: true })).toBe([
    "✗ Stopped — cancelled; changes already made are kept",
    "• Changes unknown — Casper could not compare the workspace",
  ].join("\n"));
  const paths = Array.from({ length: 10 }, (_, index) => `f${index}.ts`);
  expect(formatReceipt(done({ changedPaths: paths, changedDuringChecks: ["dist/out.js"] }))).toBe([
    "• Not verified — Casper ran no checks",
    "✓ Changed 10 files: f0.ts, f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, f6.ts, f7.ts … +2 more",
    "• Changed while checking: dist/out.js",
  ].join("\n"));
  expect(formatReceipt(done({ changedPaths: [], browser: { status: "fail", checks: [
    { name: "home", status: "fail", freshness: "fresh", baseline: "new" }] } as unknown as TaskResult["browser"] })))
    .toBe("✗ Failed — browser checks failed\n• No files changed\n✗ Browser checks failed: home");
});

test("the default receipt never uses internal terms and escapes terminal controls", () => {
  const text = formatReceipt(done({ changedPaths: ["a\n\u001b[31mforged"], verification: report([check(), check({ name: "build", freshness: "fresh", scope: { inputs: ["src"] }, reused: true })]) }));
  // "reused" is plain language here (the build passed earlier in the task); "reuse disabled" is not.
  expect(text).not.toMatch(/scope|reuse disabled|declared-input|freshness|fingerprint|undeclared|certified|\u001b/);
  expect(text.split("\n")).toHaveLength(4);
});

test("a request stopped by --max-turns says so and how to go on, per surface", () => {
  const task = done({ changedPaths: ["a.ts"], turnLimit: 3, verificationMode: "auto" });
  expect(formatReceipt(task, { surface: "one-shot" })).toBe([
    "• Incomplete — stopped after 3 turns (--max-turns); changes so far are kept; casper --continue to go on",
    "✓ Changed 1 file: a.ts",
  ].join("\n"));
  expect(formatReceipt({ ...task, turnLimit: 1 })).toStartWith("• Incomplete — stopped after 1 turn (--max-turns); changes so far are kept; send another request to go on");
});

test("the receipt says whether the tests prove the change, and never calls an unproven change verified alone", () => {
  const passed = (proof: TaskResult["proof"]) => formatReceipt(done({ changedPaths: ["src/sum.js"], verificationMode: "auto", verification: report([check()]), proof }))
    .split("\n").slice(3).join("\n");
  const proven = (without: Extract<NonNullable<TaskResult["proof"]>, { status: "proven" }>["without"]) =>
    passed({ status: "proven", check: "test", command: "npm run test", testsChanged: true, without });
  expect(proven({ exitCode: 1, ended: "fail", output: "expected 3, got 2" }))
    .toBe("✓ Proven: test fails without this change (exit 1) and passes with it");
  // Tests that could not load without the change (the import it adds) are weaker than a failing assertion.
  expect(proven({ exitCode: 2, ended: "fail", output: "E   ImportError: cannot import name 'mul' from 'calc'" }))
    .toBe("✓ Proven, weakly: without this change test could not load (exit 2, ImportError), and it passes with the change");
  expect(formatReceipt(done({ changedPaths: ["calc.py"], verificationMode: "auto", verification: report([check()]),
    proof: { status: "proven", check: "test", command: "pytest", testsChanged: true, without: { exitCode: 2, ended: "fail", output: "ModuleNotFoundError: x" } } })).split("\n")[0])
    .toBe("✓ Verified — the checks pass; without the change the tests could not even load");
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

test("line 1 is the verdict: verified only when the tests fail without the change, and otherwise why not", () => {
  const changed = { changedPaths: ["src/sum.js"], verificationMode: "auto" as const, verification: report([check()]) };
  const first = (task: TaskResult, options = {}) => formatReceipt(task, options).split("\n")[0];
  expect(first(done({ ...changed, proof: { status: "proven", check: "test", command: "npm run test", testsChanged: true, without: { exitCode: 1, ended: "fail" } } })))
    .toBe("✓ Verified — the checks pass, and the tests fail without the change");
  expect(first(done({ ...changed, proofSkipped: "a refactor should not change behavior, so no test is expected to fail without it" })))
    .toBe("• Checks passed — not proven: a refactor should not change behavior, so no test is expected to fail without it");
  expect(first(done({ ...changed, proof: { status: "unavailable", check: "test", reason: "the workspace has more than 20000 files." } })))
    .toBe("• Checks passed — not proven: the workspace has more than 20000 files");
  expect(first(done({ ...changed, proof: { status: "unproven", check: "test", command: "npm run test", testsChanged: false, without: { exitCode: 0, ended: "pass" } } })))
    .toBe("• Not verified — the tests pass without the change too");
  expect(first(done({ ...changed, review: { done: [], open: ["handle empty input"] } }))).toBe("• Not verified — the model's review lists unfinished items");
  expect(first({ execution: "failed", changedPaths: [] })).toBe("✗ Failed — the model run failed before changing any files");
  expect(first(done({ changedPaths: ["a.js"], verification: report([], { status: "blocked", reason: "Task cancelled; no further checks." }) })))
    .toBe("✗ Failed — checks stopped: task cancelled; no further checks");
  // /verify with no task change: nothing to prove.
  expect(first({ execution: "completed", verification: report([check()]) })).toBe("✓ Checks passed");
  // Nothing to report stays empty.
  expect(formatReceipt(done({}))).toBe("");
});

test("a failed lab check's receipt line says the model was not asked only when no repair ran", () => {
  const lab = check({ name: "junos-commit", status: "fail", exitCode: 2, kind: "lab", command: undefined });
  const stopped = formatReceipt(done({ verification: report([lab], { status: "fail" }) }));
  expect(stopped).toContain("✗ junos-commit failed on the lab (exit 2) — log above; Casper did not ask the model to fix it. /verify junos-commit runs it again (asks first)");
  // You chose "Ask the model to fix it": the repair line says so, and the check line does not deny it.
  const repaired = formatReceipt(done({ verification: report([lab], { status: "fail", repairAttempts: 1 }) }));
  expect(repaired).toContain("↻ Casper tried 1 repair");
  expect(repaired).toContain("✗ junos-commit failed on the lab (exit 2) — log above; /verify junos-commit runs it again (asks first)");
  expect(repaired).not.toContain("did not ask the model");
});

test("a lab dry run that passed is shown, but it is never grounds for Checks passed or Verified", () => {
  const dry = check({ name: "aoscx-check", kind: "lab", label: "dry run not guaranteed", command: undefined });
  const only = done({ verification: report([dry]) });
  expect(taskOutcome(undefined, only)).toBe("not_verified");
  const text = formatReceipt(only);
  expect(text).toContain("• Not verified — a dry run is not guaranteed, so its pass is not proof");
  expect(text).toContain("✓ aoscx-check passed (dry run not guaranteed, 1.3s)");
  expect(text).not.toContain("Checks passed");
  // Beside a real check the pass of that check still counts.
  expect(checksPassed(undefined, done({ verification: report([check(), dry]) }))).toBe(true);
});

test.skipIf(process.platform === "win32")("the one-shot undo command quotes a folder so a shell runs it as printed (~ still expands, $ does not)", () => {
  const task = done({ changedPaths: ["sum.js"], verificationMode: "off", receipt: 4, undo: { available: true } });
  const last = (folder: string) => formatReceipt(task, { surface: "one-shot", folder }).split("\n").at(-1);
  expect(last("~/code/app")).toBe("Undo: casper --cd ~/code/app /undo 4 · Diff: casper --cd ~/code/app /diff 4");
  expect(last("~/My Lab")).toBe("Undo: casper --cd ~/'My Lab' /undo 4 · Diff: casper --cd ~/'My Lab' /diff 4");
  expect(last("/srv/a $HOME's")).toBe("Undo: casper --cd '/srv/a $HOME'\\''s' /undo 4 · Diff: casper --cd '/srv/a $HOME'\\''s' /diff 4");
});

test.if(process.platform === "win32")("Windows: the one-shot undo command shows the folder as typed, in double quotes only when it has a space", () => {
  const task = done({ changedPaths: ["sum.js"], verificationMode: "off", receipt: 4, undo: { available: true } });
  const last = (folder: string) => formatReceipt(task, { surface: "one-shot", folder }).split("\n").at(-1);
  expect(last("C:\\code\\app")).toBe("Undo: casper --cd C:\\code\\app /undo 4 · Diff: casper --cd C:\\code\\app /diff 4");
  expect(last("C:\\My Lab")).toBe("Undo: casper --cd \"C:\\My Lab\" /undo 4 · Diff: casper --cd \"C:\\My Lab\" /diff 4");
});

// The short receipt the terminal shows after a task. The full form above stays for --json and saved receipts.
const proven: TaskResult["proof"] = { status: "proven", check: "test", command: "npm run test", testsChanged: true, without: { exitCode: 1, ended: "fail" } };
const many = Array.from({ length: 15 }, (_, index) => `src/file-${index}.ts`);

test("short receipt: all well is one line", () => {
  expect(formatShortReceipt(done({ changedPaths: many, verificationMode: "auto", verification: report([check(), check({ name: "lint", command: "npm run lint" })]), proof: proven })))
    .toBe("✓ Verified · test passed · lint passed · 15 files changed");
  // A few files are named; repairs come last; the model's own "all covered" claim is left out.
  expect(formatShortReceipt(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()], { repairAttempts: 1 }), proof: proven,
    review: { done: ["sums"], open: [] } })))
    .toBe("✓ Verified · test passed · changed sum.js · after 1 repair");
  expect(formatShortReceipt(done({ changedPaths: [], verificationMode: "auto", verification: report([check()]) }))).toBe("✓ Checks passed · test passed · no files changed");
  // The full form keeps every line.
  expect(formatReceipt(done({ changedPaths: many, verificationMode: "auto", verification: report([check()]), proof: proven })).split("\n")).toHaveLength(4);
});

test("short receipt: a failed check keeps its own line under the verdict", () => {
  const task = done({ changedPaths: many, verificationMode: "auto",
    verification: report([check({ name: "lint", command: "npm run lint" }), check({ status: "fail", exitCode: 1 })], { repairAttempts: 2 }) });
  expect(formatShortReceipt(task)).toBe([
    "✗ Failed — test failed",
    "✓ lint passed · 15 files changed",
    "↻ Casper tried 2 repairs",
    "✗ test failed (exit 1) — log above; /verify repair test to fix",
  ].join("\n"));
});

test("short receipt: not verified says why on its own line, and never claims Verified", () => {
  const unproven = formatShortReceipt(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]), proofSkipped: "only docs changed" }));
  expect(unproven).toBe("• Checks passed — not proven: only docs changed\n✓ test passed · changed sum.js");
  const none = formatShortReceipt(done({ changedPaths: ["sum.js"], autoSkipped: "no-checks" }));
  expect(none).toBe('• Not checked — no tests yet. Say "add tests".\n✓ changed sum.js');
  for (const text of [unproven, none]) expect(text).not.toContain("Verified");
  const incomplete = formatShortReceipt(done({ changedPaths: ["sum.js"], verification: report([check()], { status: "incomplete" }) }));
  expect(incomplete.split("\n")[0]).toBe("• Incomplete — not every check ran");
});

test("short receipt: what undo can't put back is its own line", () => {
  const task = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]), proof: proven, receipt: 3,
    undo: { available: true, left: [{ path: ".env", why: "git ignores it" }] } });
  expect(formatShortReceipt(task)).toBe("✓ Verified · test passed · changed sum.js\n• Undo can't put back: .env (git ignores it)");
  expect(formatShortReceipt(task, { surface: "one-shot" })).toEndWith("\nUndo: casper /undo 3 · Diff: casper /diff 3");
});

test("short receipt: the checklist is said only when a case is not met or can't be checked", () => {
  const cases = Array.from({ length: 26 }, (_, index) => `case ${index}`);
  const passing = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]), proof: proven, checklist: cases });
  expect(formatShortReceipt(passing)).toBe("✓ Verified · test passed · changed sum.js");
  // The model's review admits a gap: the checklist line names it, instead of a second line about the review.
  const gap = done({ ...passing, review: { done: [], open: ["negative numbers — not implemented"] } });
  expect(formatShortReceipt(gap)).toBe([
    "• Not verified — the model's review lists unfinished items",
    "✓ test passed · changed sum.js",
    "⚠ 1 requirement not met, the model says: negative numbers — not implemented",
  ].join("\n"));
  const failed = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check({ status: "fail", exitCode: 1 })]), checklist: cases });
  // The failure comes right after the verdict; the checklist's line follows it.
  expect(formatShortReceipt(failed)).toBe([
    "✗ Failed — test failed",
    "✓ changed sum.js",
    "✗ test failed (exit 1) — log above; /verify repair test to fix",
    "• 26 cases from your request not confirmed: the checks did not pass (/receipt lists them)",
  ].join("\n"));
  const unchecked = done({ changedPaths: ["sum.js"], autoSkipped: "no-checks", checklist: ["one case"] });
  expect(formatShortReceipt(unchecked)).toContain("\n• 1 case from your request not confirmed: no checks ran (/receipt lists them)");
  // Stopped at the spend pause: no checks ran because the task did not finish.
  const paused = done({ changedPaths: ["sum.js"], spendLimit: { spent: 5.1, limit: 5 }, checklist: ["one case"] });
  expect(formatShortReceipt(paused)).toContain("\n• 1 case from your request not confirmed: the task did not finish (/receipt lists them)");
  // Nothing changed: nothing to confirm.
  expect(formatShortReceipt(done({ changedPaths: [], autoSkipped: "no-changes", checklist: cases }))).not.toContain("cases");
  // Without a checklist the review gap keeps its own line.
  expect(formatShortReceipt(done({ ...gap, checklist: undefined }))).toContain("⚠ The model's review says not done: negative numbers — not implemented");
  // The full receipt (--json text) is unchanged by the checklist.
  expect(formatReceipt(failed)).toBe(formatReceipt({ ...failed, checklist: undefined }));
});

test("/receipt lists every checklist case", () => {
  const text = formatTaskResult(done({ changedPaths: ["sum.js"], checklist: ["limit(0) throws", "the 6th call is rejected"] }));
  expect(text).toContain("       checklist    2 cases from your request (handed to the model to test; not evidence)\n                    - limit(0) throws\n                    - the 6th call is rejected");
});

test("short receipt: a lab pass keeps its caveat, beside a proven test too", () => {
  for (const label of [DRY_RUN_LABEL, COMMIT_CHECK_LABEL]) {
    const lab = check({ name: "lab-apply", kind: "lab", label, command: "ansible-playbook --check site.yml" });
    const task = done({ changedPaths: ["site.yml"], verificationMode: "auto", verification: report([check(), lab]), proof: proven });
    expect(formatShortReceipt(task)).toBe(`✓ Verified · test passed · lab-apply passed (${label} · ansible-playbook --check site.yml) · changed site.yml`);
  }
});

test("short receipt: the model's review counting fewer than all requirements keeps its line", () => {
  const base = { changedPaths: ["a.ts"], verificationMode: "auto" as const, verification: report([check()]), proof: proven };
  const short = formatShortReceipt(done({ ...base, review: { fixed: [], open: [], covered: 3, total: 5 } }));
  expect(short).toContain("\n• The model's review: 3 of 5 requirements covered (");
  // Only the all-covered claim is left out.
  expect(formatShortReceipt(done({ ...base, review: { fixed: [], open: [], covered: 5, total: 5 } }))).toBe("✓ Verified · test passed · changed a.ts");
});

test("short receipt: with a problem, no files changed is not shown with a check mark", () => {
  const task = done({ changedPaths: [], verificationMode: "auto", verification: report([check({ status: "fail", exitCode: 1 })]) });
  const text = formatShortReceipt(task);
  expect(text).toContain("• No files changed");
  expect(text).not.toContain("✓");
});

test("a check that took under a second shows no time: the receipt and the live line never say 0.0s", () => {
  const quick = check({ durationMs: 40 });
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([quick]) }))).toContain("✓ test passed (npm run test)\n".trimEnd());
  expect(formatReceipt(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([quick]) }))).not.toMatch(/0\.\ds/);
  expect(liveCheckLine(quick)).toBe("✓ test");
  expect(liveCheckLine(check({ durationMs: 40, label: "checks from sample-tools" }))).toBe("✓ test · checks from sample-tools");
  expect(liveCheckLine(check({ durationMs: 40, status: "fail", exitCode: 1 }))).toBe("✗ test · exit 1");
  expect(formatReceipt(done({ changedPaths: [], verificationMode: "auto", verification: report([check({ durationMs: 40, command: undefined })]) }))).toContain("✓ test passed\n".trimEnd());
  // A second or more still shows.
  expect(liveCheckLine(check({ durationMs: 2500 }))).toBe("✓ test · 2.5s");
});

test("an answer that says the browser checks passed, against Casper's record, is corrected in one line", () => {
  expect(answerClaimsBrowserPass("**Verification:** bun test passed all 8 tests. Browser checks also passed for the sample calculation and a mobile /31 case.")).toBe(true);
  expect(answerClaimsBrowserPass("I exercised the served page in a browser; it works at phone width.")).toBe(true);
  expect(answerClaimsBrowserPass("The browser check did not pass: the table overflows.")).toBe(false);
  expect(answerClaimsBrowserPass("I couldn't run the browser checks.")).toBe(false);
  expect(answerClaimsBrowserPass("bun test passed all 8 tests.")).toBe(false);
  // "browser" as a plain word in a sentence about something else is not a claim about the browser checks.
  expect(answerClaimsBrowserPass("Checks: bun test passed all 18 tests, including a test that bun run dev serves the page and browser assets.")).toBe(false);
  expect(answerClaimsBrowserPass("The browser bundle builds and the tests pass.")).toBe(false);
  expect(answerClaimsBrowserPass("Verified the layout in a headless browser at 390px.")).toBe(true);
  expect(answerClaimsBrowserPass("The browser scenario for the /31 case passes.")).toBe(true);
  const incomplete = { status: "incomplete", checks: [{ name: "phone", status: "incomplete" }] } as unknown as TaskResult["browser"];
  expect(formatReceipt(done({ changedPaths: [], browser: incomplete, browserClaimed: true })))
    .toContain("• Browser checks did not finish — the answer above says they passed; Casper saw no passing browser check");
  expect(formatReceipt(done({ changedPaths: [], browser: incomplete }))).toContain("• Browser checks incomplete");
  // Some passed: the receipt counts them and names what did not finish; the answer was mostly right, so no correction.
  const mixed = { status: "incomplete", checks: [{ name: "Calculate a subnet", status: "incomplete" }, { name: "Split", status: "pass" },
    { name: "Mobile", status: "pass" }] } as unknown as TaskResult["browser"];
  const mixedReceipt = formatReceipt(done({ changedPaths: [], browser: mixed, browserClaimed: true }));
  expect(mixedReceipt).toContain("• Browser checks: 2 of 3 passed; not finished: Calculate a subnet");
  expect(mixedReceipt).not.toContain("the answer above");
  const failed = { status: "fail", checks: [{ name: "phone", status: "fail" }] } as unknown as TaskResult["browser"];
  expect(formatReceipt(done({ changedPaths: [], browser: failed, browserClaimed: true })))
    .toContain("✗ Browser checks failed: phone — the answer above says they passed");
});
