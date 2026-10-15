import { afterEach, expect, spyOn, test } from "bun:test";
import { ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VerificationResult } from "../src/verify/evidence";
import { VerifierRegistry } from "../src/verify/registry";
import { failureSignature, verifyAndRepair } from "../src/verify/repair-loop";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "casper-repair-stall-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(path.join(root, "app.ts"), "export const x = 1;\n");
  return root;
}

const failed = (cwd: string, stdout: string): VerificationResult => ({ name: "test", status: "fail", cwd, exitCode: 1, signal: null,
  stdout, stderr: "", truncated: false, durationMs: 5 });

/** A test check that fails with `outputs[i]` on run i (then passes when the list runs out). */
function registry(cwd: string, outputs: string[]): VerifierRegistry {
  const checks = new VerifierRegistry();
  let run = 0;
  checks.register({ name: "test", run: async () => {
    const out = outputs[run++];
    return out === undefined ? { ...failed(cwd, "ok"), status: "pass", exitCode: 0 } : failed(cwd, out);
  } });
  return checks;
}

test("a failure differing only in durations, ports, temp paths, ids and times has one signature", () => {
  const a = failureSignature([failed("/", "FAIL app.test.ts > adds (12ms)\nError: expected 2 at http://localhost:4123 /tmp/casper-ab12/x.ts id 3f9a2c1b7e 2026-10-11T10:00:01Z")]);
  const b = failureSignature([failed("/", "FAIL app.test.ts > adds (873ms)\nError: expected 2 at http://localhost:5999 /tmp/casper-zz99/x.ts id 77aa0e1d2c 2026-10-11T11:42:09Z")]);
  expect(a).toBe(b);
  expect(failureSignature([failed("/", "FAIL app.test.ts > subtracts (12ms)")])).not.toBe(a);
});

test("a repair round that changes no files and leaves the same failure ends at once", async () => {
  const cwd = repo();
  const prompts: string[] = [];
  const report = await verifyAndRepair({ registry: registry(cwd, ["FAIL adds (3ms)", "FAIL adds (9ms)", "FAIL adds (4ms)", "FAIL adds (2ms)"]),
    checks: ["test"], cwd, request: "fix", maxAttempts: 3, repair: async (prompt) => { prompts.push(prompt); } });
  expect(report.status).toBe("fail");
  expect(report.reason).toBe("The last repair changed nothing and the failure is the same.");
  expect(prompts).toHaveLength(1);
});

test("a completed Git status with a missed child close event does not spend another repair", async () => {
  const cwd = repo();
  // Reproduce the first snapshot becoming unknown at the 2 s deadline even though
  // Git exited successfully and all its output arrived. execFile waits for close.
  const emit = ChildProcess.prototype.emit;
  let missed = 0;
  const events = spyOn(ChildProcess.prototype, "emit").mockImplementation(function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
    if (event === "close" && !missed) { missed++; return false; }
    return Reflect.apply(emit, this, [event, ...args]) as boolean;
  });
  const prompts: string[] = [];
  try {
    const report = await verifyAndRepair({ registry: registry(cwd, ["FAIL adds (3ms)", "FAIL adds (9ms)", "FAIL adds (4ms)", "FAIL adds (2ms)"]),
      checks: ["test"], cwd, request: "fix", maxAttempts: 3, repair: async (prompt) => { prompts.push(prompt); } });
    expect(missed).toBe(1);
    expect(report.status).toBe("fail");
    expect(report.reason).toBe("The last repair changed nothing and the failure is the same.");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("?? app.ts");
  } finally { events.mockRestore(); }
});

test("a repair round that changes files but not the failure is told so in the next prompt's first line", async () => {
  const cwd = repo();
  const prompts: string[] = [];
  const report = await verifyAndRepair({ registry: registry(cwd, ["FAIL adds (3ms)", "FAIL adds (9ms)"]),
    checks: ["test"], cwd, request: "fix", maxAttempts: 3, repair: async (prompt) => {
      prompts.push(prompt);
      writeFileSync(path.join(cwd, "app.ts"), `export const x = ${prompts.length + 1};\n`);
    } });
  expect(report.status).toBe("pass");
  expect(prompts).toHaveLength(2);
  expect(prompts[0]!.split("\n")[0]).toBe("Casper verification repair 1/3.");
  expect(prompts[1]!.split("\n")[0]).toBe("Same failure as the last round: your change did not affect it; try a different approach.");
});

test("a repair round that changes the failure carries on as before", async () => {
  const cwd = repo();
  const prompts: string[] = [];
  const report = await verifyAndRepair({ registry: registry(cwd, ["FAIL adds", "FAIL subtracts"]),
    checks: ["test"], cwd, request: "fix", maxAttempts: 3, repair: async (prompt) => { prompts.push(prompt); } });
  expect(report.status).toBe("pass");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]!.split("\n")[0]).toBe("Casper verification repair 2/3.");
});

test("an edit to a committed file that is listed first counts as a change", async () => {
  const cwd = repo();
  execFileSync("git", ["add", "app.ts"], { cwd });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "base"], { cwd });
  writeFileSync(path.join(cwd, "app.ts"), "export const x = 2;\n");
  const prompts: string[] = [];
  const report = await verifyAndRepair({ registry: registry(cwd, ["FAIL adds (3ms)", "FAIL adds (9ms)"]),
    checks: ["test"], cwd, request: "fix", maxAttempts: 3, repair: async (prompt) => {
      prompts.push(prompt);
      writeFileSync(path.join(cwd, "app.ts"), `export const x = ${prompts.length + 2};\n`);
    } });
  expect(report.status).toBe("pass");
  expect(prompts).toHaveLength(2);
  expect(prompts[1]!.split("\n")[0]).toBe("Same failure as the last round: your change did not affect it; try a different approach.");
});

test("an edit to a file whose name Git escapes counts as a change", async () => {
  const cwd = repo();
  writeFileSync(path.join(cwd, "caf\u00e9.ts"), "export const x = 0;\n");
  const prompts: string[] = [];
  const report = await verifyAndRepair({ registry: registry(cwd, ["FAIL adds", "FAIL adds"]),
    checks: ["test"], cwd, request: "fix", maxAttempts: 3, repair: async (prompt) => {
      prompts.push(prompt);
      writeFileSync(path.join(cwd, "café.ts"), `export const x = ${prompts.length};\n`);
    } });
  expect(report.status).toBe("pass");
  expect(prompts).toHaveLength(2);
});

test("a round that changed nothing goes straight to the last try when it runs on another model", async () => {
  const cwd = repo();
  const tries: Array<{ attempt: number; maxAttempts: number; last: boolean }> = [];
  const report = await verifyAndRepair({ registry: registry(cwd, ["FAIL adds", "FAIL adds", "FAIL adds"]),
    checks: ["test"], cwd, request: "fix", maxAttempts: 4, lastTryDiffers: true, repair: async (_prompt, info) => { tries.push(info); } });
  expect(report.status).toBe("fail");
  expect(report.reason).toBe("The last repair changed nothing and the failure is the same.");
  expect(tries).toEqual([{ attempt: 1, maxAttempts: 4, last: false }, { attempt: 2, maxAttempts: 2, last: true }]);
});

test("a round that changed nothing goes to the offer at the limit when there is one", async () => {
  const cwd = repo();
  const prompts: string[] = [];
  let offers = 0;
  const report = await verifyAndRepair({ registry: registry(cwd, ["FAIL adds", "FAIL adds", "FAIL adds"]),
    checks: ["test"], cwd, request: "fix", maxAttempts: 3, onRepairLimit: async () => { offers++; return 1; },
    repair: async (prompt) => { prompts.push(prompt); } });
  expect(offers).toBe(1);
  expect(prompts).toHaveLength(2);
  expect(report.reason).toBe("The last repair changed nothing and the failure is the same.");
});
