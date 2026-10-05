import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VerifierRegistry } from "../src/verify/registry";
import { verifyAndRepair } from "../src/verify/repair-loop";

// A git that ignores SIGTERM (a stuck child, or one whose end Bun never sees): the repair prompt's changed-file list
// must still give up after its 2 s limit. execFile's `timeout` only sends SIGTERM and then waits for the child.
test.skipIf(process.platform === "win32")("the repair prompt's git status gives up after its limit even when git ignores SIGTERM", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "casper-git-bound-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "git"), "#!/bin/sh\ntrap '' TERM\nsleep 6\n");
  chmodSync(path.join(bin, "git"), 0o755);
  const registry = new VerifierRegistry();
  let runs = 0;
  registry.register({ name: "test", run: async () => ({ name: "test", status: runs++ ? "pass" : "fail", cwd: root, exitCode: runs > 1 ? 0 : 1,
    signal: null, stdout: "", stderr: "", truncated: false, durationMs: 1 }) });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  const started = performance.now();
  let prompt = "";
  try {
    const report = await verifyAndRepair({ registry, checks: ["test"], cwd: root, request: "fix", maxAttempts: 1, repair: async (text) => { prompt = text; } });
    expect(report.status).toBe("pass");
  } finally { process.env.PATH = saved; rmSync(root, { recursive: true, force: true }); }
  expect(prompt).toContain("Git changed-file context unavailable");
  expect(performance.now() - started).toBeLessThan(4_500);
}, 30_000);
