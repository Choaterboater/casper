import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfiguration } from "../src/config/load";
import { loadProjectContext } from "../src/project/context";
import { runCommandCheck } from "../src/verify/command";
import { formatVerificationReport, formatVerificationResult } from "../src/verify/evidence";
import { VerifierRegistry } from "../src/verify/registry";
import { verifyAndRepair } from "../src/verify/repair-loop";
import { checkCommand } from "./support/check-command";

const dirs: string[] = [];
async function fixture(config = "") {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-verify-"));
  dirs.push(root);
  const homeDir = path.join(root, "home");
  await mkdir(path.join(root, ".casper"));
  await writeFile(path.join(root, ".casper/project.yaml"), config);
  const context = await loadProjectContext({ root, cwd: root, name: "fixture", gitBranch: null, isGit: false }, { homeDir });
  return { root, homeDir, context };
}

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("Phase 3 verification", () => {
  test("project verify commands override model commands, invalidate cache, and retain detected fallbacks", async () => {
    const { root, homeDir } = await fixture();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ packageManager: "bun@1.4.0", scripts: { test: "bun test", lint: "echo lint" } }));
    await writeFile(path.join(root, ".casper/project.yaml"), "commands:\n  test: echo model\nverify:\n  test: echo canonical\n");
    const info = { root, cwd: root, name: "fixture", gitBranch: null, isGit: false };
    const first = await loadProjectContext(info, { homeDir });
    expect(first.model.commands).toEqual({ test: "echo canonical", lint: "bun run lint" });
    await writeFile(path.join(root, ".casper/project.yaml"), "verify:\n  test: echo replacement\n");
    expect((await loadProjectContext(info, { homeDir })).model.commands.test).toBe("echo replacement");
  });

  test("declared check scope ignores only explicit outputs, not source edits or gitignored inputs", async () => {
    const { root, context } = await fixture(`verify:
  build: mkdir -p dist; printf built > dist/output.js
  test: printf after > source.ts
verification:
  scopes:
    build:
      inputs: ["."]
      exclude: [dist, home]
`);
    await writeFile(path.join(root, "source.ts"), "before");
    await writeFile(path.join(root, ".gitignore"), "source.ts\ndist/\n");
    const options = { registry: VerifierRegistry.forProject(context.model), checks: ["build"] as const, cwd: root, request: "Build" };
    const report = await verifyAndRepair(options);
    expect(report.results[0]).toMatchObject({ status: "pass", freshness: "fresh",
      scope: { inputs: ["."], exclude: ["dist", "home"] } });
    // A real later check changes an input, even though Git ignores it.
    const changed = await verifyAndRepair({ ...options, checks: ["build", "test"] });
    expect(changed.status).toBe("pass");
    expect(changed.results[0]?.freshness).toBe("stale");
  });

  test("merges bounded settings across global/profile/project and rejects invalid verification config", async () => {
    const { root, homeDir } = await fixture("repair:\n  maxAttempts: 0\n");
    const profile = path.join(homeDir, ".casper/profiles/default");
    await mkdir(profile, { recursive: true });
    await writeFile(path.join(homeDir, ".casper/config.yaml"), "repair:\n  maxAttempts: 1\nverification:\n  timeoutMs: 50\n");
    await writeFile(path.join(profile, "config.yaml"), "repair:\n  maxAttempts: 2\nverification:\n  timeoutMs: 200\n");
    const loaded = await loadConfiguration({ projectRoot: root, homeDir });
    expect(loaded.repair.maxAttempts).toBe(0);
    expect(loaded.verification.timeoutMs).toBe(200);
    for (const invalid of ["verify: []", "verify:\n  typo: echo test", "verify:\n  test: false", "verify:\n  test: ''", "repair:\n  maxAttempts: 11", "repair:\n  maxAttempts: -1", "repair:\n  maxAttempts: 1.5", "verification:\n  timeoutMs: 0"]) {
      await writeFile(path.join(root, ".casper/project.yaml"), invalid);
      await expect(loadConfiguration({ projectRoot: root, homeDir })).rejects.toThrow();
    }
  });

  test("scope declarations reject ambiguous paths and stay frozen with the check command", async () => {
    const { root, homeDir, context } = await fixture(`verify:
  test: ${JSON.stringify(checkCommand())}
verification:
  scopes:
    test:
      inputs: [source.ts]
`);
    await writeFile(path.join(root, "source.ts"), "before");
    const registry = VerifierRegistry.forProject(context.model);
    context.model.verificationScopes!.test!.inputs[0] = "unrelated";
    context.model.commands.test = checkCommand("exit:1");
    const report = await verifyAndRepair({ registry, checks: ["test"], cwd: root, request: "Check" });
    expect(report.results[0]).toMatchObject({ command: checkCommand(), scope: { inputs: ["source.ts"] }, freshness: "fresh" });
    for (const scopes of [[], { typo: { inputs: ["src"] } }, { test: { inputs: [] } },
      { test: { inputs: ["../outside"] } }, { test: { inputs: ["/outside"] } },
      { test: { inputs: ["src/**"] } }, { test: { inputs: ["src"], exclude: ["src"] } },
      { test: { inputs: ["."], exclude: ["."] } }, { test: { inputs: ["src"], extra: true } },
      { test: { inputs: Array(33).fill("src") } }]) {
      await writeFile(path.join(root, ".casper/project.yaml"), JSON.stringify({ verification: { scopes } }));
      await expect(loadConfiguration({ projectRoot: root, homeDir })).rejects.toThrow("verification.scopes");
    }
  });

  test("captures real command evidence and root cwd, bounds output, and never treats missing checks as pass", async () => {
    const failing = checkCommand("stderr:exact-error", "exit:7");
    const { root, context } = await fixture(`verify:\n  test: ${JSON.stringify(failing)}\n`);
    const registry = VerifierRegistry.forProject(context.model);
    const report = await verifyAndRepair({ registry, checks: ["test", "lint"], cwd: root, request: "test" });
    expect(report.status).toBe("fail");
    expect(report.results[0]).toMatchObject({ command: failing, cwd: root, status: "fail", exitCode: 7, stderr: "exact-error", truncated: false });
    expect(report.results[1].status).toBe("skip");
    expect(formatVerificationReport(report)).toContain("1 fail, 1 skip");
    const missing = await verifyAndRepair({ registry, checks: ["typecheck", "build"], cwd: root, request: "test" });
    expect(missing.status).toBe("incomplete");
    const pwd = await runCommandCheck({ name: "test", command: checkCommand("cwd"), cwd: root, timeoutMs: 1000 });
    expect(pwd.stdout.trim()).toBe(await realpath(root));
    const noisy = await runCommandCheck({ name: "test", command: checkCommand("stdout:HEAD", "pad:100000", "stdout:TAIL", "stderr:error-tail"), cwd: root, timeoutMs: 2000 });
    expect(noisy.status).toBe("pass");
    expect(noisy.truncated).toBe(true);
    expect(noisy.stdout.length).toBeLessThan(8300);
    expect(noisy.stdout.startsWith("HEAD")).toBe(true);
    expect(noisy.stdout).toContain("TAIL");
    expect(noisy.stderr).toContain("error-tail");
    expect(formatVerificationResult({ ...noisy, command: "echo\u001b[31m\nforged" })).not.toContain("\u001b");
  });

  test("preserves exact UTF-8 evidence below the truncation limit", async () => {
    const { root } = await fixture();
    const result = await runCommandCheck({ name: "test", command: checkCommand(`stdout:${"a".repeat(4095)}étail`), cwd: root, timeoutMs: 1000 });
    expect(result.truncated).toBe(false);
    expect(result.stdout).toBe("a".repeat(4095) + "étail");
  });

  test("reports unavailable tools and spawn errors as failures, not passes or hidden skips", async () => {
    const { root } = await fixture();
    const missing = await runCommandCheck({ name: "lint", command: "casper-nonexistent-tool-34562", cwd: root, timeoutMs: 1000 });
    expect(missing.status).toBe("fail");
    expect(missing.exitCode).not.toBe(0);
    const spawn = await runCommandCheck({ name: "test", command: checkCommand(), cwd: path.join(root, "absent"), timeoutMs: 1000 });
    expect(spawn.status).toBe("fail");
    expect(spawn.reason).toContain("Could not execute");
    const invalid = await runCommandCheck({ name: "test", command: "echo\u0000bad", cwd: root, timeoutMs: 1000 });
    expect(invalid.status).toBe("fail");
    expect(invalid.reason).toContain("Could not execute");
  });

  test("times out without leaving delayed work; cancellation also returns bounded evidence", async () => {
    const { root } = await fixture();
    const timed = await runCommandCheck({ name: "test", command: checkCommand("sleep:500", "touch:leaked"), cwd: root, timeoutMs: 40 });
    expect(timed.status).toBe("fail");
    expect(timed.reason).toContain("Timed out");
    // Real delay on purpose: the timeout and its kill are the platform clock's, so the
    // check has to be given time to be terminated before its delayed work can run.
    await Bun.sleep(650);
    expect(await Bun.file(path.join(root, "leaked")).exists()).toBe(false);
    const controller = new AbortController();
    const pending = runCommandCheck({ name: "test", command: checkCommand("sleep:10000"), cwd: root, timeoutMs: 2000, signal: controller.signal });
    controller.abort();
    expect((await pending).reason).toBe("Verification cancelled");
  });

  test("repairs a real failing test using exact evidence, then runs targeted and full gates", async () => {
    const { root, context } = await fixture(`verify:\n  test: bun test\n  build: ${JSON.stringify(checkCommand("stdout:build-ok"))}\n`);
    await writeFile(path.join(root, "sum.ts"), "export const sum = (a: number, b: number) => a - b;\n");
    await writeFile(path.join(root, "sum.test.ts"), 'import { expect, test } from "bun:test"; import { sum } from "./sum"; test("sum", () => expect(sum(2, 3)).toBe(5));\n');
    const prompts: string[] = [];
    const report = await verifyAndRepair({
      registry: VerifierRegistry.forProject(context.model), checks: ["test", "build"], cwd: root,
      request: "Fix addition without changing its API", constraints: "Do not remove tests.",
      repair: async (prompt) => { prompts.push(prompt); await writeFile(path.join(root, "sum.ts"), "export const sum = (a: number, b: number) => a + b;\n"); },
    });
    expect(report.status).toBe("pass");
    expect(report.repairAttempts).toBe(1);
    expect(report.rounds.map((round) => round.map((result) => `${result.name}:${result.status}`))).toEqual([["test:fail", "build:pass"], ["test:pass"], ["test:pass", "build:pass"]]);
    expect(prompts[0]).toContain('"command": "bun test"');
    expect(prompts[0]).toContain("Expected: 5");
    expect(prompts[0]).toContain("Fix addition without changing its API");
    expect(prompts[0]).toContain("Do not remove tests.");
    expect(prompts[0]).toContain("Git changed-file context unavailable");
  });

  test("detects a regression in a previously passing gate and preserves the original command contract", async () => {
    const contract = checkCommand("forbid:regressed");
    const { root, context } = await fixture(`verify:\n  test: ${JSON.stringify(checkCommand("require:fixed"))}\n  build: ${JSON.stringify(contract)}\n`);
    let attempts = 0;
    const registry = VerifierRegistry.forProject(context.model);
    const report = await verifyAndRepair({ registry, checks: ["test", "build"], cwd: root, request: "fix", repair: async () => {
      attempts++;
      if (attempts === 1) {
        await writeFile(path.join(root, "fixed"), "");
        await writeFile(path.join(root, "regressed"), "");
        context.model.commands.build = checkCommand();
      } else await rm(path.join(root, "regressed"));
    } });
    expect(report.status).toBe("pass");
    expect(report.repairAttempts).toBe(2);
    expect(report.rounds[2].find((result) => result.name === "build")?.status).toBe("fail");
    expect(report.results.find((result) => result.name === "build")?.command).toBe(contract);
  });

  test("stops at the default three attempts, honors zero, and does not repair skips or runtime errors", async () => {
    const { root, context } = await fixture(`verify:\n  test: ${JSON.stringify(checkCommand("exit:1"))}\n`);
    const options = { registry: VerifierRegistry.forProject(context.model), checks: ["test"] as const, cwd: root, request: "fix" };
    let calls = 0;
    const repair = async () => { calls++; };
    const exhausted = await verifyAndRepair({ ...options, repair });
    expect(exhausted.status).toBe("fail");
    expect(calls).toBe(3);
    expect(exhausted.rounds).toHaveLength(4);
    expect((await verifyAndRepair({ ...options, repair, maxAttempts: 0 })).repairAttempts).toBe(0);
    expect((await verifyAndRepair({ ...options, checks: ["lint"], repair })).status).toBe("incomplete");
    expect(calls).toBe(3);
    const blocked = await verifyAndRepair({ ...options, repair: async () => { throw new Error("Runtime unavailable"); } });
    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toContain("Runtime unavailable");
    expect(blocked.rounds).toHaveLength(1);
  });

  test("registry rejects duplicates and preserves explicit check order without double runs", async () => {
    const { context } = await fixture("verify:\n  test: echo test\n  lint: echo lint\n");
    const registry = VerifierRegistry.forProject(context.model);
    expect(() => registry.register({ name: "test", run: async () => { throw new Error("unused"); } })).toThrow("already registered");
    expect((await registry.run(["test", "lint", "test"])).map((result) => result.name)).toEqual(["test", "lint"]);
  });
});
