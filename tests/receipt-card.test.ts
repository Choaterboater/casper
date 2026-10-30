import { expect, test } from "bun:test";
import { receiptView, type TaskResult } from "../src/task/result";
import { cardNextRows, cardRows, receiptCard, receiptTone } from "../src/tui/receipt-card";
import type { VerificationReport, VerificationResult } from "../src/verify/evidence";

function check(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return { name: "test", status: "pass", command: "npm run test", cwd: "/repo", exitCode: 0, signal: null,
    stdout: "", stderr: "", truncated: false, durationMs: 1312, freshness: "unavailable", ...overrides };
}
function report(results: VerificationResult[], overrides: Partial<VerificationReport> = {}): VerificationReport {
  const status = results.some((result) => result.status === "fail") ? "fail" : "pass";
  return { status, repairAttempts: 0, rounds: [results], results, ...overrides };
}
const done = (task: Omit<TaskResult, "execution">): TaskResult => ({ execution: "completed", ...task });
const proven: TaskResult["proof"] = { status: "proven", check: "test", command: "npm run test", testsChanged: true, without: { exitCode: 1, ended: "fail" } };
const files = Array.from({ length: 13 }, (_, index) => `src/file-${index}.ts`);
const card = (task: TaskResult, width = 100) => cardRows(receiptCard(receiptView(task), false)!, width, false);
const failed = done({ changedPaths: [...files, ".casper/project.yaml", "package.json"], verificationMode: "auto",
  verification: report([check({ name: "lint", command: "npm run lint", durationMs: 2100 }), check({ status: "fail", exitCode: 1, durationMs: 4000 })], { repairAttempts: 2 }),
  remoteChanges: [{ host: "build-server", changes: ["installed a service (/etc/systemd/system/app.service)"] }] });

test("a failure is a card: the verdict once, then checks, changes, config, other machines and the command to run next", () => {
  expect(card(failed)).toEqual([
    "▌ ✗ Failed: test failed",
    "▌   Checks   ✓ lint 2.1s · ✗ test 4s (exit 1), after 2 repairs · Ctrl+T shows the log",
    "▌   Changed  15 files",
    "▌   Config   .casper/project.yaml, package.json",
    "▌   Devices  build-server: installed a service (/etc/systemd/system/app.service)",
    "▌            from the commands Casper saw, not checked there",
    "▌   Next     /verify repair test",
  ]);
});

test("values wrap under their column, and line 1 two columns in", () => {
  expect(card(failed, 60)).toEqual([
    "▌ ✗ Failed: test failed",
    "▌   Checks   ✓ lint 2.1s · ✗ test 4s (exit 1), after 2",
    "▌            repairs · Ctrl+T shows the log",
    "▌   Changed  15 files",
    "▌   Config   .casper/project.yaml, package.json",
    "▌   Devices  build-server: installed a service",
    "▌            (/etc/systemd/system/app.service)",
    "▌            from the commands Casper saw, not checked there",
    "▌   Next     /verify repair test",
  ]);
  const long = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]),
    proofSkipped: "a refactor should not change behavior, so no test is expected to fail without it" });
  expect(card(long, 60).slice(0, 3)).toEqual(["▌ ⚠ Checks passed · not proven: a refactor should not", "▌   change behavior, so no test is expected to fail without", "▌   it"]);
  for (const row of [...card(failed, 60), ...card(long, 60)]) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(60);
});

test("a clean pass stays one line; config files changed still get their row", () => {
  const verified = { changedPaths: files, verificationMode: "auto" as const, verification: report([check()]), proof: proven };
  expect(card(done(verified))).toEqual(["▌ ✓ Verified · test passed · 13 files changed"]);
  expect(card(done({ ...verified, changedPaths: ["package.json", "bun.lock", "src/a.ts"] }))).toEqual([
    "▌ ✓ Verified · test passed · changed package.json, bun.lock, src/a.ts",
    "▌   Config   package.json, bun.lock",
  ]);
});

test("each verdict says what it is and why, in plain words, with what to type next", () => {
  expect(card(done({ changedPaths: ["a.ts"], verificationMode: "auto",
    verification: report([check({ status: "fail", exitCode: null, ended: "timeout", reason: "Timed out after 600000ms" })]) }))).toEqual([
    "▌ ⚠ Not checked: test timed out after 10m, so the change was not tested",
    "▌   Changed  a.ts",
    "▌   Next     /verify test",
  ]);
  expect(card(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]),
    proof: { status: "unproven", check: "test", command: "npm run test", testsChanged: false, without: { exitCode: 0, ended: "pass" } } }))).toEqual([
    "▌ ⚠ Not verified: the tests pass without the change too",
    "▌   Checks   ✓ test 1.3s",
    "▌   Changed  sum.js",
    "▌   Proof    ⚠ not proven: test passes without this change too, and no test was added or changed",
  ]);
  expect(card(done({ changedPaths: ["sum.js"], autoSkipped: "no-checks", undo: { available: true, left: [{ path: ".env", why: "git ignores it" }] } }))).toEqual([
    "▌ ⚠ Not checked: no tests yet",
    "▌   Changed  sum.js",
    "▌   Undo     can't put back: .env (git ignores it)",
    '▌   Next     "add tests"',
  ]);
  expect(card(done({ changedPaths: ["sum.js"], verificationMode: "offer", observedChecks: [
    { name: "test", command: "npm test", toolStatus: "success", output: "", truncated: false },
    { name: "lint", command: "npm run lint", toolStatus: "error", output: "", truncated: false }] }))).toEqual([
    "▌ ⚠ Not verified: test ran via bash only (npm test: passed)",
    "▌   Checks   lint ran via bash only (npm run lint: failed)",
    "▌   Changed  sum.js",
    "▌   Next     /verify test · /verify lint",
  ]);
  expect(card({ execution: "cancelled", possibleMutations: true })).toEqual([
    "▌ ⚠ Stopped: cancelled; changes already made are kept",
    "▌   Changed  Changes unknown — Casper could not compare the workspace",
  ]);
  expect(card({ execution: "failed", changedPaths: [], modelError: "rate" })).toEqual([
    "▌ ✗ Failed: the model run failed before changing any files",
    "▌   Changed  No files changed",
    "▌   Next     wait a minute, then ask again",
  ]);
});

test("rows keep their order: what needs you first, a warning first; notes are three at most", () => {
  const task = done({ changedPaths: ["a.ts", "junos/sw1.set"], verificationMode: "auto", verification: report([check()]), proof: proven,
    secretInFiles: ["a.ts"], secretInCommand: true, remoteNotRun: [{ host: "192.0.2.8", commands: 2 }],
    riskyLines: [{ file: "junos/sw1.set", line: 3, text: "request system reboot", reason: "restarts the switch" }],
    pagesShown: 2, partsNotReviewed: [{ part: 1, files: ["a.ts"], why: "the reviewer timed out" }], branchMoved: true, outsideAllowed: ["~/cache"] });
  expect(card(task, 120)).toEqual([
    "▌ ⚠ Incomplete: commands to 192.0.2.8 did not run",
    "▌   Open     ⚠ A secret appeared in a command; change it after this task.",
    "▌            A secret was written into a.ts (not shown). Keep secrets in an env file or a secrets store.",
    "▌   Checks   ✓ test 1.3s",
    "▌   Changed  a.ts, junos/sw1.set",
    "▌   Config   junos/sw1.set",
    "▌            ⚠ risky line: junos/sw1.set:3 request system reboot — restarts the switch",
    "▌   Devices  192.0.2.8: 2 commands Casper stopped before they reached it",
    "▌   Notes    The branch moved during this task: changes git brought in are not counted, and undo leaves them alone",
    "▌            The AI looked at 2 screenshots of the pages (advice, not a check)",
    "▌            Not reviewed: part 1 (a.ts; the reviewer timed out)",
    "▌            +1 more · /receipt",
  ]);
});

test("green only for Verified or Checks passed, red only for a failed result, amber between", () => {
  const tone = (task: TaskResult) => receiptTone(receiptView(task));
  expect(tone(done({ changedPaths: ["a.ts"], verificationMode: "auto", verification: report([check()]), proof: proven }))).toBe("success");
  expect(tone(done({ changedPaths: [], verificationMode: "auto", verification: report([check()]) }))).toBe("success");
  expect(tone(failed)).toBe("error");
  expect(tone({ execution: "failed", changedPaths: [] })).toBe("error");
  for (const task of [
    done({ changedPaths: ["a.ts"], verificationMode: "auto", verification: report([check({ status: "fail", exitCode: null, ended: "timeout", reason: "Timed out after 1000ms" })]) }),
    done({ changedPaths: ["a.ts"], verificationMode: "auto", verification: report([check()]) }),
    done({ changedPaths: ["a.ts"], autoSkipped: "no-checks" }),
    done({ changedPaths: ["a.ts"], turnLimit: 3 }),
    { execution: "cancelled" as const, changedPaths: ["a.ts"] },
    done({ changedPaths: ["sum.js"], verificationMode: "auto", checklist: ["one"],
      verification: { ...report([check({ status: "fail", exitCode: 1 })]), failingBefore: ["test"] } }),
  ]) expect(tone(task)).toBe("warning");
});

test("the next-step keys join the card: on its Next row, or under the card's own commands", () => {
  const row = "Next: 1 Show diff · 2 Undo · 3 Add a test (uses tokens)\n  Why 3: the tests pass without the fix too";
  // With colour off each key is [1], the same width as the cap it stands for.
  expect(cardNextRows(row, "error", false, 90, false)).toEqual(["▌            [1] Show diff   [2] Undo   [3] Add a test (uses tokens)   · press a number", "▌            Why 3: the tests pass without the fix too"]);
  expect(cardNextRows("Next: 1 Show diff · 2 Undo", "warning", true, 80, false)).toEqual(["▌   Next     [1] Show diff   [2] Undo   · press a number"]);
});
