import { expect, test } from "bun:test";
import { formatShortReceipt, receiptView, type ReceiptItem, type TaskResult } from "../src/task/result";
import { BRANCH_MOVED_LINE } from "../src/task/git-movement";
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
const many = Array.from({ length: 15 }, (_, index) => `src/file-${index}.ts`);
/** What each item is, without its text. */
const parts = (items: ReceiptItem[]) => items.map(({ line: _, ...rest }) => rest);
/** The lines shown under line 1, with their sections. */
const shown = (items: ReceiptItem[]) => items.filter((item) => item.fold === undefined).map((item) => [item.section, item.line]);

test("a clean pass: the verdict word, and every line folded into the one line in its own words", () => {
  const task = done({ changedPaths: many, verificationMode: "auto", verification: report([check(), check({ name: "lint", command: "npm run lint" })]), proof: proven });
  const view = receiptView(task);
  expect(view.short).toBe("✓ Verified");
  expect(view.verdict).toEqual({ line: "✓ Verified — the checks pass, and the tests fail without the change", section: "verdict", kind: "verdict",
    status: "Verified", detail: "the checks pass, and the tests fail without the change" });
  expect(view.items.map((item) => [item.section, item.fold])).toEqual([["checks", "test passed"], ["checks", "lint passed"], ["why", ""], ["changed", "15 files changed"]]);
  expect(formatShortReceipt(task)).toBe("✓ Verified · test passed · lint passed · 15 files changed");
});

test("a failure: the verdict, what went well, the repairs and the failing check, each in parts", () => {
  const task = done({ changedPaths: many, verificationMode: "auto", verification: report([
    check({ name: "lint", command: "npm run lint", durationMs: 2100 }), check({ status: "fail", exitCode: 1, durationMs: 4000 })], { repairAttempts: 2 }) });
  const view = receiptView(task);
  const changed = `✓ Changed 15 files: ${many.slice(0, 8).join(", ")} … +7 more`;
  expect(view.verdict).toEqual({ line: "✗ Failed — test failed", section: "verdict", kind: "verdict", status: "Failed", detail: "test failed" });
  expect(view.short).toBeUndefined();
  expect(view.items).toEqual([
    { line: "✓ lint passed (npm run lint, 2.1s)", section: "checks", kind: "check", name: "lint", status: "passed", detail: "npm run lint", time: "2.1s", fold: "lint passed" },
    { line: changed, section: "changed", kind: "changed", status: "Changed", detail: changed.slice("✓ Changed ".length), fold: "15 files changed" },
    { line: "↻ Casper tried 2 repairs", section: "checks", kind: "repairs", status: "tried", detail: "2 repairs" },
    { line: "✗ test failed (exit 1) — log above; /verify repair test to fix", section: "checks", kind: "check", name: "test", status: "failed", detail: "exit 1",
      time: "4s", actions: ["/verify repair test"] },
  ]);
});

test("one-shot commands are casper invocations, and undo and diff are the next commands", () => {
  const task = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check({ status: "fail", exitCode: 1 })]), receipt: 3, undo: { available: true } });
  const view = receiptView(task, { surface: "one-shot" });
  expect(view.items.find((item) => item.name === "test")?.actions).toEqual(['casper "/verify repair test"']);
  expect(view.items.at(-1)).toEqual({ line: "Undo: casper /undo 3 · Diff: casper /diff 3", section: "next", kind: "undo", actions: ["casper /undo 3", "casper /diff 3"] });
});

test("config files are listed apart (lockfiles as one entry), with risky config lines; other machines are devices", () => {
  const task = done({ changedPaths: ["src/a.ts", ".casper/project.yaml", "package.json", "bun.lock"], changedDuringChecks: ["tsconfig.json", "package.json"],
    verificationMode: "off", remoteChanges: [{ host: "build-server", changes: ["installed a service (/etc/systemd/system/app.service)"] }, { host: "192.0.2.7", changes: [] }],
    remoteNotRun: [{ host: "192.0.2.8", commands: 2 }], riskyLines: [{ file: "junos/sw1.set", line: 3, text: "request system reboot", reason: "restarts the switch" }] });
  const view = receiptView(task);
  expect(view.config).toEqual({ files: [".casper/project.yaml", "package.json", "tsconfig.json"], lockfiles: ["bun.lock"] });
  expect(parts(view.items.filter((item) => item.section === "devices"))).toEqual([
    { section: "devices", name: "build-server", detail: "installed a service (/etc/systemd/system/app.service)" },
    { section: "devices", name: "192.0.2.7", detail: "ran commands over ssh; Casper can't tell from the command text whether they changed anything there" },
    { section: "devices", name: "192.0.2.8", detail: "2 commands Casper stopped before they reached it" },
  ]);
  expect(view.items.filter((item) => item.section === "config").map((item) => item.line))
    .toEqual(["– Risky config lines (not a check): junos/sw1.set:3 request system reboot — restarts the switch"]);
  expect(view.items.filter((item) => item.section === "changed").map((item) => item.line)).toEqual(["✓ Changed 4 files: src/a.ts, .casper/project.yaml, package.json, bun.lock",
    "– Changed while checking: tsconfig.json, package.json"]);
  expect(receiptView(done({ changedPaths: ["src/a.ts"] })).config).toEqual({ files: [], lockfiles: [] });
});

test("what needs you is open, a warning first; the rest are notes", () => {
  const task = done({ changedPaths: ["a.ts"], verificationMode: "auto", verification: report([check()]), proof: proven, secretInCommand: true, secretInFiles: ["a.ts"],
    sandbox: { held: false, reason: "--no-sandbox" }, cleanup: [{ state: "left-running", processes: [{ pid: 41, group: 41, command: "node server.js" }] }] });
  const view = receiptView(task);
  expect(view.verdict).toMatchObject({ status: "Incomplete", detail: "owned process cleanup is unconfirmed" });
  expect(shown(view.items)).toEqual([
    ["open", "⚠ Owned processes left running by your choice; cleanup unconfirmed"],
    ["open", "⚠ A secret appeared in a command; change it after this task."],
    ["open", "– PID 41 · node server.js"],
    ["open", "– A secret was written into a.ts (not shown). Keep secrets in an env file or a secrets store."],
    ["notes", "– Shell commands and checks were not sandboxed (--no-sandbox)"],
  ]);
  expect(parts(view.items.filter((item) => item.kind === "proof")))
    .toEqual([{ section: "why", kind: "proof", status: "Proven", detail: "test fails without this change (exit 1) and passes with it", fold: "" }]);
});

test("why the change is not verified: the proof and the checks Casper did not run or count, with their commands", () => {
  const unproven = receiptView(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]),
    proof: { status: "unproven", check: "test", command: "npm run test", testsChanged: false, without: { exitCode: 0, ended: "pass" } } }));
  expect(unproven.verdict).toEqual({ line: "– Not verified — the tests pass without the change too", section: "verdict", kind: "verdict",
    status: "Not verified", detail: "the tests pass without the change too" });
  expect(parts(unproven.items.filter((item) => item.kind === "proof")))
    .toEqual([{ section: "why", kind: "proof", status: "Not proven", detail: "test passes without this change too, and no test was added or changed" }]);
  expect(receiptView(done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]), proofSkipped: "only docs changed." })).verdict)
    .toMatchObject({ line: "– Checks passed — not proven: only docs changed", status: "Checks passed · not proven", detail: "only docs changed" });

  const shell = receiptView(done({ changedPaths: ["sum.js"], verificationMode: "offer", observedChecks: [
    { name: "test", command: "npm test", toolStatus: "success", output: "", truncated: false },
    { name: "lint", command: "npm run lint", toolStatus: "error", output: "", truncated: false }] }));
  expect(shell.verdict).toEqual({ line: "– Not verified — test ran via bash only (npm test: passed). Run /verify test to record a check.", section: "verdict",
    kind: "verdict", status: "Not verified", detail: "test ran via bash only (npm test: passed)", actions: ["/verify test"] });
  expect(parts(shell.items.filter((item) => item.section === "why")))
    .toEqual([{ section: "why", kind: "not-verified", name: "lint", status: "Not verified", detail: "lint ran via bash only (npm run lint: failed)", actions: ["/verify lint"] }]);

  expect(receiptView(done({ changedPaths: ["sum.js"], autoSkipped: "no-checks" })).verdict).toEqual({ line: '– Not checked — no tests yet. Say "add tests".',
    section: "verdict", kind: "verdict", status: "Not checked", detail: "no tests yet", actions: ['"add tests"'] });
  expect(receiptView(done({ changedPaths: ["sum.js"], verification: report([check({ freshness: "stale" })]) })).verdict).toEqual({
    line: "– Not verified — stale: files changed after the last passing test. Run /verify test.", section: "verdict", kind: "verdict",
    status: "Not verified", detail: "stale: files changed after the last passing test", actions: ["/verify test"] });
  const timedOut = receiptView(done({ changedPaths: ["a.ts"], verificationMode: "auto",
    verification: report([check({ status: "fail", exitCode: null, ended: "timeout", reason: "Timed out after 600000ms" })]) }), { surface: "one-shot" });
  expect(timedOut.verdict).toEqual({ line: '✗ Not checked — test timed out after 10m, so the change was not tested; casper "/verify test" runs it again',
    section: "verdict", kind: "verdict", status: "Not checked", detail: "test timed out after 10m, so the change was not tested", actions: ['casper "/verify test"'] });
});

test("the checklist, undo and a failed model run's next step", () => {
  const failed = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check({ status: "fail", exitCode: 1 })]), checklist: ["one", "two"],
    undo: { available: true, left: [{ path: ".env", why: "git ignores it" }] } });
  expect(parts(receiptView(failed).items.slice(-2))).toEqual([
    { section: "why", kind: "checklist", status: "2 cases from your request not confirmed", detail: "the checks did not pass", actions: ["/receipt"] },
    { section: "undo", kind: "undo", status: "Undo can't put back", detail: ".env (git ignores it)" },
  ]);
  const gap = done({ changedPaths: ["sum.js"], verificationMode: "auto", verification: report([check()]), proof: proven, checklist: ["one"],
    review: { done: [], open: ["negative numbers"] } });
  expect(parts(receiptView(gap).items.filter((item) => item.kind === "checklist")))
    .toEqual([{ section: "open", kind: "checklist", status: "1 requirement not met", detail: "the model says: negative numbers" }]);
  expect(parts(receiptView(done({ changedPaths: ["sum.js"], undo: { available: false, reason: "the folder is not a git repository." } })).items.filter((item) => item.kind === "undo")))
    .toEqual([{ section: "undo", kind: "undo", status: "Undo not available", detail: "the folder is not a git repository" }]);
  const model = receiptView({ execution: "failed", changedPaths: [], modelError: "rate" });
  expect(model.verdict).toMatchObject({ status: "Failed", detail: "the model run failed before changing any files" });
  expect(model.items.at(-1)).toEqual({ line: "– Next: wait a minute, then ask again", section: "next", detail: "wait a minute, then ask again" });
});

test("a review cut off with a gap is two items: a note, and the gap that needs you", () => {
  const view = receiptView(done({ changedPaths: ["a.ts"], verificationMode: "auto", verification: report([check()]), proof: proven,
    review: { done: [], open: ["edge case"], incomplete: true } }));
  expect(shown(view.items)).toEqual([
    ["notes", "– The model's review stopped at its 12-turn budget (its own claim so far, not checked by Casper)"],
    ["open", "⚠ The model's review says not done: edge case"],
  ]);
});

test("every other line has a section: what changed, the checks, notes, and notes said before", () => {
  const task = done({ changedPaths: ["a.ts"], changedNotByModel: ["notes.txt"], branchMoved: true, verificationMode: "auto", verification: report([check()]), proof: proven,
    security: { problems: 1, notes: 0, notRun: 0, tools: [] }, outsideWrites: ["~/lab"], outsideAllowed: ["~/cache"], pagesShown: 2,
    pageNotes: ["– /devices/[id] not opened: needs an id"], sandbox: { held: false, reason: "--no-sandbox" } });
  expect(shown(receiptView(task, { seenNotes: new Set(["sandbox:--no-sandbox"]) }).items)).toEqual([
    ["changed", "– Changed meanwhile by another program, not the AI (not checked): notes.txt"],
    ["notes", BRANCH_MOVED_LINE],
    ["notes", "– /devices/[id] not opened: needs an id"],
    ["notes", "– The AI looked at 2 screenshots of the pages (advice, not a check)"],
    ["checks", "– Security tools: 1 problem (what the tools found; not proof the code has no problems)"],
    ["changed", "– Wrote outside the project: ~/lab (you allowed it; no undo copy)"],
    ["notes", "– Allowed writes outside the project: ~/cache (no undo copy)"],
    ["notes", "– Same as before: not sandboxed (/receipt)"],
  ]);
});
