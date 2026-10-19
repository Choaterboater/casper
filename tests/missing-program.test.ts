import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatReceipt } from "../src/task/result";
import type { VerificationResult } from "../src/verify/evidence";
import { missingProgram } from "../src/verify/missing-program";
import { VerifierRegistry } from "../src/verify/registry";
import { verifyAndRepair } from "../src/verify/repair-loop";
import { removeTempDir } from "./support/temp-dir";

/**
 * On a NAS whose Go app runs in Docker, `go test` and `go build` could not start (`go: command not found`): Casper
 * asked "Fix it anyway?", the model said Go is missing, and Casper asked the same again. A check whose own program
 * isn't on this computer is now said plainly, with no Retry or repair offered.
 */

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

const noStart = (name: "test" | "build", command: string, stderr: string, cwd = "/r"): VerificationResult =>
  ({ name, command, cwd, status: "fail", exitCode: 127, signal: null, stdout: "", stderr, truncated: false, durationMs: 5, ended: "no_start" });

test("the check's own program not found is named; a tool deeper in the check (dependencies not installed) is not", () => {
  expect(missingProgram(noStart("test", "go test ./...", "/bin/sh: line 1: go: command not found\n"))).toBe("go");
  expect(missingProgram(noStart("test", "go test ./...", "sh: 1: go: not found\n"))).toBe("go");
  expect(missingProgram(noStart("build", "go build ./...", "'go' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n"))).toBe("go");
  expect(missingProgram(noStart("test", "CGO_ENABLED=0 /usr/local/go/bin/go test ./...", "sh: 1: /usr/local/go/bin/go: not found\n"))).toBe("go");
  // npm is there; jest isn't installed yet: the model can fix that, so the usual choices stay.
  expect(missingProgram(noStart("test", "npm test", "sh: 1: jest: not found\n"))).toBeUndefined();
  // A check that started and failed, or one that timed out, is not a missing program.
  expect(missingProgram({ ...noStart("test", "go test ./...", "go: command not found"), ended: undefined })).toBeUndefined();
  expect(missingProgram(noStart("test", "go test ./...", ""))).toBeUndefined();
});

test("a missing program gets no Retry or Fix-it-anyway question, and the run says what to install", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "casper-missing-program-"));
  cleanup.push(() => removeTempDir(cwd));
  const registry = new VerifierRegistry();
  for (const name of ["test", "build"] as const) {
    registry.register({ name, run: async () => noStart(name, `go ${name} ./...`, "/bin/sh: line 1: go: command not found\n", cwd) });
  }
  const asked: string[][] = [];
  const repairs: string[] = [];
  const report = await verifyAndRepair({ registry, checks: ["test", "build"], cwd, request: "fix", repair: async (prompt) => { repairs.push(prompt); },
    onUnfinished: async (checks) => { asked.push(checks.map((check) => check.name)); return "repair"; } });
  expect(asked).toEqual([]);
  expect(repairs).toEqual([]);
  expect(report.status).toBe("incomplete");
  expect(report.reason).toBe("test, build could not start: go isn't installed on this computer, so Casper did not repair it. Install go, then /verify runs it again.");
  const receipt = formatReceipt({ execution: "completed", changedPaths: ["main.go"], verification: report }, { surface: "interactive" });
  expect(receipt).toContain("✗ test could not start — go isn't installed on this computer; install it, then /verify test");
  expect(receipt).not.toContain("project.yaml");
});
