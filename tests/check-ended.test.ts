import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkEvent } from "../src/app/json-events";
import { formatReceipt } from "../src/task/result";
import { runCommandCheck } from "../src/verify/command";
import type { VerificationResult } from "../src/verify/evidence";
import { checkCommand } from "./support/check-command";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function root(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-ended-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a check that timed out or could not start is marked as unfinished, not as a test failure", async () => {
  const cwd = await root();
  const timed = await runCommandCheck({ name: "test", command: checkCommand("sleep:2000"), cwd, timeoutMs: 40 });
  expect(timed).toMatchObject({ status: "fail", ended: "timeout" });
  const missing = await runCommandCheck({ name: "lint", command: "casper-nonexistent-tool-34562", cwd, timeoutMs: 5000 });
  expect(missing).toMatchObject({ status: "fail", ended: "no_start" });
  const badFolder = await runCommandCheck({ name: "test", command: checkCommand(), cwd: path.join(cwd, "absent"), timeoutMs: 5000 });
  expect(badFolder).toMatchObject({ status: "fail", ended: "no_start" });
  const failing = await runCommandCheck({ name: "test", command: checkCommand("exit:1"), cwd, timeoutMs: 5000 });
  expect(failing.status).toBe("fail");
  expect(failing.ended).toBeUndefined();
});

test("the JSON check event carries ended only when set, and the receipt does not offer a repair for it", () => {
  const base: VerificationResult = { name: "test", status: "fail", command: "npm test", cwd: "/r", exitCode: null, signal: null,
    stdout: "", stderr: "", truncated: false, durationMs: 600_010, reason: "Timed out after 600000ms", ended: "timeout" };
  expect(checkEvent(base, "casper")).toMatchObject({ ended: "timeout" });
  expect("ended" in checkEvent({ ...base, ended: undefined, reason: undefined, exitCode: 1 }, "casper")).toBe(false);
  const report = (result: VerificationResult) => ({ status: "fail" as const, repairAttempts: 0, rounds: [[result]], results: [result] });
  const timedOut = formatReceipt({ execution: "completed", changedPaths: ["a.js"], verification: report(base) });
  expect(timedOut).toContain("✗ test timed out after 10m — it did not finish, so it was not checked; /verify test to run it again");
  expect(timedOut).not.toContain("repair");
  const noStart = formatReceipt({ execution: "completed", changedPaths: ["a.js"],
    verification: report({ ...base, exitCode: 127, reason: undefined, ended: "no_start", stderr: "sh: 1: jest: not found" }) });
  expect(noStart).toContain("✗ test could not start (exit 127) — check verify.test in .casper/project.yaml");
});

test("the verdict names how each failing check ended", () => {
  const result = (overrides: Partial<VerificationResult>): VerificationResult => ({ name: "test", status: "fail", command: "x", cwd: "/r", exitCode: 1, signal: null,
    stdout: "", stderr: "", truncated: false, durationMs: 1, ...overrides });
  const results = [result({ ended: "timeout", exitCode: null, reason: "Timed out after 1000ms" }), result({ name: "lint", ended: "no_start", exitCode: 127 }), result({ name: "build" })];
  const text = formatReceipt({ execution: "completed", changedPaths: ["a.js"], verification: { status: "fail", repairAttempts: 0, rounds: [results], results } });
  expect(text.split("\n")[0]).toBe("✗ Failed — test timed out, lint could not start, build failed");
});

test("a receipt whose only failures are unfinished checks says the change was not checked, not that it failed", () => {
  const base = { command: "npm test", cwd: "/p", signal: null, stdout: "", stderr: "", truncated: false, durationMs: 5000 };
  const timedOut: VerificationResult = { ...base, name: "test", status: "fail", exitCode: null, reason: "Timed out after 5000ms", ended: "timeout" };
  const failed: VerificationResult = { ...base, name: "lint", status: "fail", exitCode: 1 };
  const receipt = (results: VerificationResult[]) => formatReceipt({ execution: "completed", changedPaths: ["a.py"],
    verification: { status: "fail", results, repairAttempts: 0 } } as never, { surface: "interactive" });
  const unfinished = receipt([timedOut]);
  expect(unfinished.split("\n")[0]).toBe("✗ Not checked — test timed out, so the change was not tested");
  expect(unfinished).toContain("or raise verification.timeoutMs in .casper/project.yaml");
  expect(receipt([timedOut, failed]).split("\n")[0]).toBe("✗ Failed — test timed out, lint failed");
});
