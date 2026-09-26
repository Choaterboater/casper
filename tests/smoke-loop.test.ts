import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProjectContext } from "../src/project/context";
import type { SmokeReport } from "../src/services/smoke";
import { VerifierRegistry } from "../src/verify/registry";
import { verifyAndRepair } from "../src/verify/repair-loop";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

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
}, 30_000);
