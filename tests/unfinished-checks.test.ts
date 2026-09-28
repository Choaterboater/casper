import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VerificationResult } from "../src/verify/evidence";
import { VerifierRegistry } from "../src/verify/registry";
import { verifyAndRepair } from "../src/verify/repair-loop";
import { recordCheckTimings, measuredCheckTime } from "../src/verify/timings";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function dir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-unfinished-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

type Outcome = "pass" | "fail" | "timeout" | "no_start";
function result(name: "test" | "lint", outcome: Outcome, cwd: string, timeoutMs = 1000): VerificationResult {
  const base = { name, command: `${name}-cmd`, cwd, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 5 };
  if (outcome === "pass") return { ...base, status: "pass", exitCode: 0 };
  if (outcome === "fail") return { ...base, status: "fail", exitCode: 1 };
  if (outcome === "timeout") return { ...base, status: "fail", exitCode: null, reason: `Timed out after ${timeoutMs}ms`, ended: "timeout", durationMs: timeoutMs };
  return { ...base, status: "fail", exitCode: 127, ended: "no_start" };
}

/** A registry whose checks follow a script of outcomes, one per run; it records the timeout each run got. */
function scripted(cwd: string, scripts: Partial<Record<"test" | "lint", Outcome[]>>) {
  const registry = new VerifierRegistry();
  const timeouts: number[] = [];
  for (const name of ["test", "lint"] as const) {
    const script = scripts[name];
    if (!script) continue;
    registry.register({ name, run: async (_signal, options) => {
      const timeoutMs = 1000 * 2 ** (options?.moreTime ?? 0);
      timeouts.push(timeoutMs);
      return result(name, script.length > 1 ? script.shift()! : script[0]!, cwd, timeoutMs);
    } });
  }
  return { registry, timeouts };
}

test("a check that timed out is never handed to a paid repair; without a way to ask, the run just reports it", async () => {
  const cwd = await dir();
  const { registry } = scripted(cwd, { test: ["timeout"] });
  const repairs: string[] = [];
  const report = await verifyAndRepair({ registry, checks: ["test"], cwd, request: "fix", repair: async (prompt) => { repairs.push(prompt); } });
  expect(repairs).toEqual([]);
  expect(report).toMatchObject({ status: "fail", repairAttempts: 0 });
  expect(report.reason).toContain("did not finish");
});

test("real failures are still repaired, without the unfinished check in the repair prompt", async () => {
  const cwd = await dir();
  const { registry } = scripted(cwd, { test: ["fail", "pass"], lint: ["no_start"] });
  const repairs: string[] = [];
  const report = await verifyAndRepair({ registry, checks: ["test", "lint"], cwd, request: "fix", repair: async (prompt) => { repairs.push(prompt); } });
  expect(repairs).toHaveLength(1);
  expect(repairs[0]).toContain('"name": "test"');
  expect(repairs[0]).not.toContain('"name": "lint"');
  expect(report.results.find((entry) => entry.name === "test")?.status).toBe("pass");
  expect(report.status).toBe("fail");
});

test("the user's choice decides: retry runs it again, more time doubles its limit, fix it anyway repairs it", async () => {
  const cwd = await dir();
  const asked: string[][] = [];
  const retry = scripted(cwd, { test: ["timeout", "pass"] });
  expect((await verifyAndRepair({ registry: retry.registry, checks: ["test"], cwd, request: "fix", repair: async () => {},
    onUnfinished: async (checks) => { asked.push(checks.map((check) => check.name)); return "retry"; } })).status).toBe("pass");
  expect(asked).toEqual([["test"]]);

  const longer = scripted(cwd, { test: ["timeout", "pass"] });
  expect((await verifyAndRepair({ registry: longer.registry, checks: ["test"], cwd, request: "fix", repair: async () => {},
    onUnfinished: async () => "more-time" })).status).toBe("pass");
  expect(longer.timeouts).toEqual([1000, 2000]);

  // More time again doubles again; a retry after that keeps the longer limit.
  const choices: Array<"more-time" | "retry"> = ["more-time", "more-time", "retry"];
  const again = scripted(cwd, { test: ["timeout", "timeout", "timeout", "pass"] });
  expect((await verifyAndRepair({ registry: again.registry, checks: ["test"], cwd, request: "fix", repair: async () => {},
    onUnfinished: async () => choices.shift()! })).status).toBe("pass");
  expect(again.timeouts).toEqual([1000, 2000, 4000, 4000]);

  const anyway = scripted(cwd, { test: ["timeout", "pass"] });
  const repairs: string[] = [];
  const fixed = await verifyAndRepair({ registry: anyway.registry, checks: ["test"], cwd, request: "fix",
    repair: async (prompt) => { repairs.push(prompt); }, onUnfinished: async () => "repair" });
  expect(repairs).toHaveLength(1);
  expect(fixed).toMatchObject({ status: "pass", repairAttempts: 1 });

  // Esc (no choice) stops without a repair.
  const skipped = scripted(cwd, { test: ["timeout"] });
  const none: string[] = [];
  expect((await verifyAndRepair({ registry: skipped.registry, checks: ["test"], cwd, request: "fix",
    repair: async (prompt) => { none.push(prompt); }, onUnfinished: async () => undefined })).status).toBe("fail");
  expect(none).toEqual([]);
});

test("asking stops after eight rounds, so a check that always times out cannot loop", async () => {
  const cwd = await dir();
  const { registry } = scripted(cwd, { test: ["timeout"] });
  let asks = 0;
  const report = await verifyAndRepair({ registry, checks: ["test"], cwd, request: "fix", repair: async () => {},
    onUnfinished: async () => { asks++; return "retry"; } });
  expect(asks).toBe(8);
  expect(report.status).toBe("fail");
});

test("a check that could not start is not recorded as a timing", async () => {
  const state = await dir();
  await recordCheckTimings(state, [result("test", "no_start", state)]);
  expect(await measuredCheckTime(state, ["test"], { test: "test-cmd" })).toBeUndefined();
});

test("in the terminal, a timed-out check asks what to do instead of starting a paid repair", async () => {
  const { PassThrough } = await import("node:stream");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { CasperApp } = await import("../src/app");
  const { loadProjectContext } = await import("../src/project/context");
  const { SkillRegistry } = await import("../src/skills/registry");
  const { fakeWriter } = await import("./support/tty");
  const { checkCommand } = await import("./support/check-command");
  process.env.TERM = "xterm-256color";
  const root = await dir();
  const home = path.join(root, "home"); const project = path.join(root, "project");
  await mkdir(home, { recursive: true }); await mkdir(path.join(project, ".casper"), { recursive: true });
  await writeFile(path.join(project, ".casper/project.yaml"), `verify:\n  test: ${JSON.stringify(checkCommand("sleep:5000"))}\nverification:\n  mode: auto\n  timeoutMs: 300\n`);
  let prompts = 0;
  const runtime = {
    start: async () => ({
      getStatus: () => ({ provider: "fixture", model: "demo", auth: "configured" as const }),
      getState: () => ({ cwd: project, isStreaming: false }),
      setTools: () => {}, subscribe: () => () => {}, abort: async () => {},
      prompt: async () => { prompts++; await writeFile(path.join(project, "notes.txt"), `edit ${prompts}\n`); },
    }),
    dispose: async () => {},
  };
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const screen = fakeWriter();
  const app = new CasperApp({
    input, output: screen.writer, runtimeFactory: () => runtime as never, sessionHomeDir: home,
    loadProjectContext: (info) => loadProjectContext(info, { homeDir: home }),
    loadSkillRegistry: (context) => SkillRegistry.discover({ projectRoot: context.info.root, homeDir: home }),
    loadMCPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadLSPConfiguration: async () => ({ servers: [], diagnostics: [] }),
    loadReferenceConfiguration: async () => ({ sources: [], diagnostics: [] }),
  });
  const interactive = app.runInteractive(project);
  try {
    await screen.until((output) => output.includes("idle"));
    input.write("hello there\r");
    await screen.until((output) => output.includes("Casper did not try to fix it. What now?"));
    const visible = Bun.stripANSI(screen.output);
    expect(visible).toContain("test timed out after 0.3s");
    expect(visible).toContain("1 Retry");
    expect(visible).toContain("2 Fix it anyway");
    expect(visible).toContain("3 Allow more time");
    // While the question waits, the footer says so instead of spinning with a running timer.
    await screen.until((output) => { const text = Bun.stripANSI(output); return text.slice(text.lastIndexOf("What now?")).includes("? waiting for you"); });
    // More time: the second run has double the limit, and the question says so without offering more again.
    input.write("3");
    // More time again is offered at double that, with the setting that keeps a longer limit.
    const second = (output: string) => { const text = Bun.stripANSI(output); return text.slice(text.lastIndexOf("test timed out after 0.6s")); };
    await screen.until((output) => Bun.stripANSI(output).includes("test timed out after 0.6s") && second(output).includes("verification.timeoutMs"));
    expect(second(screen.output)).toContain("run it with 1.2s");
    input.write("\x1b");
    // Wait for idle after the receipt: /exit typed while the task is still finishing is kept as a draft.
    await screen.until((output) => { const text = Bun.stripANSI(output); const receipt = text.lastIndexOf("✗ Not checked — test timed out, so the change was not tested");
      return receipt >= 0 && text.lastIndexOf("idle") > receipt; });
    expect(prompts).toBe(1);
    expect(app.getLastTaskResult()?.verification?.repairAttempts).toBe(0);
  } finally {
    input.write("/exit\r");
    await interactive;
    await app.close();
    input.destroy();
  }
}, 30_000);
