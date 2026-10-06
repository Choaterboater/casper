import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { receiptEvent } from "../src/app/json-events";
import { loadProjectContext } from "../src/project/context";
import type { SmokeReport } from "../src/services/smoke";
import { formatReceipt } from "../src/task/result";
import type { VerificationReport } from "../src/verify/evidence";
import { VerifierRegistry } from "../src/verify/registry";
import { verifyAndRepair } from "../src/verify/repair-loop";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir))); });

/** A project whose `test` passes once the file `fixed` exists, and a smoke run that counts its calls. */
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-smoke-loop-")));
  dirs.push(root);
  await mkdir(path.join(root, ".casper"));
  await writeFile(path.join(root, ".casper/project.yaml"), `verify:\n  test: '"${process.execPath}" -e "process.exit(require(\\"fs\\").existsSync(\\"fixed\\") ? 0 : 1)"'\n`);
  const context = await loadProjectContext({ root, cwd: root, name: "fixture", gitBranch: null, isGit: false }, { homeDir: path.join(root, "home") });
  const smokeRuns: number[] = [];
  const report: SmokeReport = { status: "pass", checks: [{ id: "list", name: "list notes", service: "api", source: "config",
    request: { method: "GET", path: "/notes" }, status: "pass", evidence: true, actual: { status: 200, body: "[]" } }] };
  const prompts: string[] = [];
  const options = { registry: VerifierRegistry.forProject(context.model), checks: ["test"] as const, cwd: root, request: "Fix it",
    smoke: async () => { smokeRuns.push(prompts.length); return structuredClone(report); } };
  return { root, options, prompts, smokeRuns };
}

test("a command failure skips the smoke run; the repair that fixes the commands then runs smoke", async () => {
  const f = await fixture();
  const report = await verifyAndRepair({ ...f.options, repair: async (prompt) => { f.prompts.push(prompt); await writeFile(path.join(f.root, "fixed"), ""); } });
  expect(f.prompts).toHaveLength(1);
  expect(f.prompts[0]).toContain("Failure evidence");
  expect(f.prompts[0]).not.toContain("Smoke failure evidence");
  // Smoke ran once, after the repair.
  expect(f.smokeRuns).toEqual([1]);
  expect(report).toMatchObject({ status: "pass", repairAttempts: 1, smoke: { status: "pass" } });
  expect(report.smokeSkipped).toBeUndefined();
}, 30_000);

test("when the command checks use up the repair budget, the report and receipt say smoke was not run", async () => {
  const f = await fixture();
  const report = await verifyAndRepair({ ...f.options, maxAttempts: 1, repair: async (prompt) => { f.prompts.push(prompt); } });
  expect(f.smokeRuns).toEqual([]);
  expect(report).toMatchObject({ status: "fail", repairAttempts: 1, smokeSkipped: "command checks failed" });
  expect(report.smoke).toBeUndefined();
  expect(formatReceipt({ execution: "completed", verification: report })).toContain("• Smoke not run: command checks failed");
  // Without smoke checks there is nothing to skip.
  const plain = await verifyAndRepair({ ...f.options, smoke: undefined, maxAttempts: 0 });
  expect(plain.smokeSkipped).toBeUndefined();
}, 30_000);

test("the JSON receipt redacts secrets a service echoed into smoke bodies, reasons and crash tails", () => {
  const report: VerificationReport = { status: "fail", repairAttempts: 0, rounds: [], results: [], smoke: { status: "fail",
    checks: [{ id: "env", name: "env", service: "api", source: "config", request: { method: "GET", path: "/env" }, status: "fail", evidence: false,
      actual: { status: 200, body: '{"API_KEY":"abc123secret","ok":false}' }, reason: "header x-debug is \"Bearer tok-999\", expected it to contain \"ok\"" }],
    crashes: [{ service: "api", tail: "boot with token=sk-abcdefghijkl\n" }] } };
  const smoke = receiptEvent(report, undefined, 1).smoke!;
  const text = JSON.stringify(smoke);
  for (const secret of ["abc123secret", "tok-999", "sk-abcdefghijkl"]) expect(text).not.toContain(secret);
  expect(smoke.checks[0]!.actual!.body).toContain('"ok":false');
  // The report Casper keeps is not changed.
  expect(report.smoke!.checks[0]!.actual!.body).toContain("abc123secret");
});
