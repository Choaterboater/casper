import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allowedCommand } from "../src/app/allowed";
import { loadConfiguration } from "../src/config/load";
import { ShellSandbox, useSandbox } from "../src/sandbox/manager";
import type { SandboxUserSettings } from "../src/sandbox/policy";
import { SandboxStore } from "../src/sandbox/store";
import { formatReceipt, type TaskResult } from "../src/task/result";
import { runCommandCheck, sandboxDenialInOutput } from "../src/verify/command";
import { repairClass, type VerificationResult } from "../src/verify/evidence";
import { planAutoChecks } from "../src/verify/mode";
import { verifyAndRepair } from "../src/verify/repair-loop";
import { VerifierRegistry } from "../src/verify/registry";
import { posixOnly } from "./support/platform";
import { fakeEngine, type FakeEngine } from "./support/sandbox-fakes";
import { removeTempDir } from "./support/temp-dir";

/**
 * The project's own checks run in the sandbox by default. A failure the sandbox caused (EPERM on a socket, a spawn,
 * a loopback address) is "could not check", never a bug to repair; only the user can let checks run outside it.
 */

const roots: string[] = [];
afterEach(async () => {
  useSandbox(undefined);
  await Promise.all(roots.splice(0).map((root) => removeTempDir(root)));
});

async function session(options: { user?: SandboxUserSettings; store?: SandboxStore; root?: string } = {}): Promise<{ root: string; home: string; engine: FakeEngine; sandbox: ShellSandbox }> {
  const root = options.root ?? await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-checks-outside-")));
  if (!options.root) roots.push(root);
  const home = path.join(root, "home");
  const engine = fakeEngine();
  const store = options.store ?? new SandboxStore(path.join(root, "state"));
  const sandbox = new ShellSandbox({ root: () => root, home, engine, problem: () => undefined, platform: "linux", store, settings: { user: options.user ?? {} } });
  useSandbox(sandbox);
  return { root, home, engine, sandbox };
}

const EPERM = "echo 'connect EPERM 127.0.0.2:3000' >&2; exit 1";

posixOnly("a check that prints EPERM inside the sandbox is blocked, not failed, and never repaired", async () => {
  const { root } = await session();
  const result = await runCommandCheck({ name: "test", command: EPERM, cwd: root, timeoutMs: 10_000 });
  expect(result.status).toBe("fail");
  expect(result.ended).toBe("blocked");
  expect(result.reason).toContain("blocked by the sandbox");
  expect(repairClass(result)).toBe("never");
  expect(formatReceipt({ execution: "completed", changedPaths: ["a.ts"], verification: { status: "fail", results: [result], repairAttempts: 0 } as never } as TaskResult))
    .toContain("✗ test — blocked by the sandbox");
});

posixOnly("the same output with no sandbox holding it is an ordinary failure", async () => {
  const { root } = await session({ user: { off: true } });
  const result = await runCommandCheck({ name: "test", command: EPERM, cwd: root, timeoutMs: 10_000 });
  expect(result.ended).toBeUndefined();
  expect(repairClass(result)).toBe("repairable");
});

test("what counts as the sandbox's own refusal", () => {
  expect(sandboxDenialInOutput("Error: listen EPERM: operation not permitted 0.0.0.0:80")).toContain("blocked by the sandbox");
  expect(sandboxDenialInOutput("spawn git EPERM")).toContain("EPERM");
  expect(sandboxDenialInOutput("open /dev/fd/3: Operation not permitted")).toContain("Operation not permitted");
  expect(sandboxDenialInOutput("expected 3 but got 4")).toBeUndefined();
  expect(sandboxDenialInOutput("EPERMISSIVE mode on")).toBeUndefined();
});

posixOnly("sandbox.checks: outside in your own config runs checks unwrapped and says so; inside never does", async () => {
  const outside = await session({ user: { checks: "outside" } });
  const result = await runCommandCheck({ name: "test", command: EPERM, cwd: outside.root, timeoutMs: 10_000 });
  expect(outside.engine.wrapped).toEqual([]);
  expect(result.label).toBe("outside the sandbox");
  expect(result.ended).toBeUndefined();
  const inside = await session({ user: { checks: "inside" } });
  await runCommandCheck({ name: "test", command: "true", cwd: inside.root, timeoutMs: 10_000 });
  expect(inside.engine.wrapped.length).toBe(1);
  expect(inside.sandbox.mayAskChecksOutside).toBe(false);
});

posixOnly("'Yes, this once' covers only the rerun; the next check is back in the sandbox", async () => {
  const { root, engine, sandbox } = await session();
  await sandbox.withChecksOutsideOnce(() => runCommandCheck({ name: "test", command: "true", cwd: root, timeoutMs: 10_000 }));
  expect(engine.wrapped.length).toBe(0);
  await runCommandCheck({ name: "test", command: "true", cwd: root, timeoutMs: 10_000 });
  expect(engine.wrapped.length).toBe(1);
});

posixOnly("'for this session' is not saved; 'always for this project' is kept privately and /allowed lists and forgets it", async () => {
  const first = await session();
  first.sandbox.allowChecksOutsideForSession();
  expect(await first.sandbox.checksOutside()).toBe(true);
  const stateDirectory = path.join(first.root, "state");
  const second = await session({ store: new SandboxStore(stateDirectory), root: first.root });
  expect(await second.sandbox.checksOutside()).toBe(false);
  await second.sandbox.rememberChecksOutside(true);
  const third = await session({ store: new SandboxStore(stateDirectory), root: first.root });
  expect(await third.sandbox.checksOutside()).toBe(true);
  const said: string[] = [];
  await allowedCommand("/allowed", third.sandbox.store!, (text) => said.push(text));
  expect(said.join("")).toContain("run this project's checks outside the sandbox");
  await allowedCommand("/allowed forget 1", third.sandbox.store!, (text) => said.push(text));
  expect(await new SandboxStore(stateDirectory).checksOutside()).toBe(false);
});

test("a project file cannot send its checks outside the sandbox; your own file can", async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-checks-config-")));
  roots.push(base);
  const home = path.join(base, "home"), project = path.join(base, "p");
  await mkdir(path.join(home, ".casper"), { recursive: true });
  await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper", "project.yaml"), "sandbox:\n  checks: outside\n");
  const fromProject = await loadConfiguration({ projectRoot: project, homeDir: home });
  expect(fromProject.sandbox.user.checks).toBeUndefined();
  expect(fromProject.warnings.join("\n")).toContain("sandbox.checks is ignored");
  await writeFile(path.join(home, ".casper", "config.yaml"), "sandbox:\n  checks: outside\n");
  expect((await loadConfiguration({ projectRoot: project, homeDir: home })).sandbox.user.checks).toBe("outside");
});

function blockedRegistry(passAfter: () => boolean): { registry: VerifierRegistry; runs: number[] } {
  const runs: number[] = [];
  const registry = new VerifierRegistry();
  const base = { cwd: "/p", exitCode: null, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 1 } as const;
  registry.register({ name: "test", command: "bun test", run: async () => {
    runs.push(1);
    return passAfter() ? { ...base, name: "test", status: "pass", exitCode: 0 }
      : { ...base, name: "test", status: "fail", exitCode: 1, ended: "blocked", reason: "blocked by the sandbox (the check printed EPERM; not a bug in your code)" } satisfies VerificationResult;
  } });
  return { registry, runs };
}

test("a blocked check starts no repair and the report says the check could not be checked", async () => {
  const { registry, runs } = blockedRegistry(() => false);
  let repairs = 0;
  const report = await verifyAndRepair({ registry, checks: ["test"], cwd: "/p", request: "x", repair: async () => { repairs++; } });
  expect(repairs).toBe(0);
  expect(runs.length).toBe(1);
  expect(report.status).toBe("fail");
  expect(report.reason).toContain("could not be checked");
  expect(report.reason).toContain("sandbox blocked something, not because of a bug in your code");
  expect(report.reason).toContain("!<command>");
});

test("answering 'once' runs the blocked check again outside; 'no' leaves it; still no repair", async () => {
  let outside = false;
  const yes = blockedRegistry(() => outside);
  let repairs = 0;
  const passed = await verifyAndRepair({ registry: yes.registry, checks: ["test"], cwd: "/p", request: "x", repair: async () => { repairs++; },
    onBlocked: async () => "once", outsideOnce: async (work) => { outside = true; try { return await work(); } finally { outside = false; } } });
  expect(passed.status).toBe("pass");
  expect(yes.runs.length).toBe(2);
  const no = blockedRegistry(() => false);
  const left = await verifyAndRepair({ registry: no.registry, checks: ["test"], cwd: "/p", request: "x", repair: async () => { repairs++; }, onBlocked: async () => undefined });
  expect(left.status).toBe("fail");
  expect(no.runs.length).toBe(1);
  expect(repairs).toBe(0);
});

test("a change to only docs runs no unscoped check; code, or a declared scope that covers the doc, still runs", () => {
  const commands = { test: "bun test", typecheck: "tsc", lint: "oxlint" };
  const docs = planAutoChecks({ commands, changedPaths: ["docs/PACKS.md", "NOTES.txt"] });
  expect(docs).toEqual({ run: [], skipped: "docs-only" });
  expect(planAutoChecks({ commands, changedPaths: ["docs/PACKS.md", "src/a.ts"] }).run).toEqual(["typecheck", "lint", "test"]);
  expect(planAutoChecks({ commands, scopes: { test: { inputs: ["docs"] } }, changedPaths: ["docs/PACKS.md"] }).run).toEqual(["test"]);
  expect(planAutoChecks({ commands, changedPaths: ["themes/dark.yaml"] }).run.length).toBe(3);
  const receipt = formatReceipt({ execution: "completed", changedPaths: ["docs/PACKS.md"], autoSkipped: "docs-only", verificationMode: "auto" } as TaskResult);
  expect(receipt).toContain("Checks skipped — only documentation changed");
});
