import { expect, test } from "bun:test";
import { liveCheckLine } from "../src/task/result";
import type { VerificationResult } from "../src/verify/evidence";

const result = (overrides: Partial<VerificationResult>): VerificationResult => ({ name: "test", status: "pass", command: "npm test", cwd: "/r",
  exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 5_900, ...overrides });

test("each finished check gets one short live line", () => {
  expect(liveCheckLine(result({ name: "typecheck" }))).toBe("✓ typecheck · 5.9s");
  expect(liveCheckLine(result({ reused: true }))).toBe("✓ test · passed earlier, reused");
  expect(liveCheckLine(result({ status: "fail", exitCode: 1, durationMs: 2_300 }))).toBe("✗ test · exit 1 · 2.3s");
  expect(liveCheckLine(result({ status: "fail", exitCode: null, ended: "timeout", reason: "Timed out after 600000ms", durationMs: 600_010 }))).toBe("✗ test · timed out after 10m");
  expect(liveCheckLine(result({ name: "lint", status: "fail", exitCode: 127, ended: "no_start", durationMs: 12 }))).toBe("✗ lint · could not start (exit 127)");
  expect(liveCheckLine(result({ status: "skip", command: undefined, exitCode: null }))).toBe("– test · skipped, no command");
});
