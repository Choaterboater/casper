import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectModel } from "../src/project/model";
import type { VerificationResult } from "../src/verify/evidence";
import { VerifierRegistry } from "../src/verify/registry";
import { verifyAndRepair } from "../src/verify/repair-loop";
import { VerificationTask } from "../src/verify/task";

// A product token the repo's checks may see (provider keys are removed; tokens like this one stay).
const TOKEN = "mist-token-5b2f9c41d7e8";
const saved = process.env.MIST_API_TOKEN;
const dirs: string[] = [];
afterEach(async () => {
  if (saved === undefined) delete process.env.MIST_API_TOKEN; else process.env.MIST_API_TOKEN = saved;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-check-secrets-"));
  dirs.push(dir);
  // The test prints the token as a bare value and a password as a secret-named KEY=VALUE line.
  await writeFile(path.join(dir, "leak.sh"), `printf 'using %s\\n' "$MIST_API_TOKEN"\necho DB_PASSWORD=hunter2hunter2\nexit 1\n`);
  return dir;
}

function model(dir: string, commands: ProjectModel["commands"]): ProjectModel {
  return { schemaVersion: 1, project: { name: "p", root: dir, git: false }, languages: [], frameworks: [], packageManager: null,
    commands, architecture: {}, conventions: [], detectedAt: "" };
}

const LEAKY_TEST = "sh leak.sh";

test("casper_check hides secrets in a built-in check's output before the AI reads it", async () => {
  process.env.MIST_API_TOKEN = TOKEN;
  const dir = await root();
  const tool = new VerificationTask(VerifierRegistry.forProject(model(dir, { test: LEAKY_TEST }), 10_000), dir).tool()!;
  const ran = await tool.execute({ check: "test" });
  expect(ran.isError).toBe(true);
  expect(ran.text).toContain("using ");
  expect(ran.text).not.toContain(TOKEN);
  expect(ran.text).not.toContain("hunter2hunter2");
});

test("a repair prompt hides secrets in a built-in check's output and in smoke replies", async () => {
  process.env.MIST_API_TOKEN = TOKEN;
  const dir = await root();
  const registry = VerifierRegistry.forProject(model(dir, { test: LEAKY_TEST }), 10_000);
  const prompts: string[] = [];
  await verifyAndRepair({ registry, checks: ["test"], cwd: dir, request: "fix", maxAttempts: 1, repair: async (prompt) => { prompts.push(prompt); } });
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("using ");
  expect(prompts[0]).not.toContain(TOKEN);
  expect(prompts[0]).not.toContain("hunter2hunter2");

  // Smoke replies are the service's own text, which can echo the same token.
  const passing = new VerifierRegistry();
  passing.register({ name: "test", run: async (): Promise<VerificationResult> => ({ name: "test", status: "pass", cwd: dir, exitCode: 0, signal: null,
    stdout: "", stderr: "", truncated: false, durationMs: 1 }) });
  const smokePrompts: string[] = [];
  let smokeRuns = 0;
  await verifyAndRepair({ registry: passing, checks: ["test"], cwd: dir, request: "fix", maxAttempts: 1,
    repair: async (prompt) => { smokePrompts.push(prompt); },
    smoke: async () => ({ status: smokeRuns++ ? "pass" : "fail", checks: [{ name: "health", service: "api", status: smokeRuns > 1 ? "pass" : "fail",
      actual: { status: 500, body: `token ${TOKEN} rejected` } }] }) as never });
  expect(smokePrompts).toHaveLength(1);
  expect(smokePrompts[0]).toContain("rejected");
  expect(smokePrompts[0]).not.toContain(TOKEN);
});
