import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CasperApp } from "../src/app";
import { crewSweepStart, finishCrewChecks, rememberCrewSweep } from "../src/app/crew-checks";
import { storedTaskResult, receiptEvent } from "../src/app/json-events";
import { PartRecord } from "../src/crew/parts";
import { formatReceipt, taskOutcome } from "../src/task/result";
import type { VerificationReport, VerificationResult } from "../src/verify/evidence";
import { VerifierRegistry } from "../src/verify/registry";
import { VerificationTask } from "../src/verify/task";
import { removeTempDir } from "./support/temp-dir";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(result: Partial<VerificationResult> = {}, scoped = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "casper-crew-checks-"));
  cleanup.push(() => removeTempDir(root));
  await writeFile(path.join(root, "src.txt"), "source\n");
  const registry = new VerifierRegistry();
  let runs = 0;
  registry.register({ name: "test", ...(scoped ? { scope: { inputs: ["src.txt"] } } : {}), run: async () => {
    runs++;
    return { name: "test", cwd: root, status: "pass", exitCode: 0, signal: null, stdout: "", stderr: "", truncated: false, durationMs: 1, ...result };
  } });
  const task = new VerificationTask(registry, root);
  cleanup.push(() => task.close());
  const parts = new PartRecord();
  parts.landed({ goal: "change", files: ["src.txt"], stat: "", patch: Buffer.from("+source\n") });
  const model = { commands: { test: "test-command" } };
  let tree = new Map([["src.txt", "initial"]]);
  const app = { crewParts: parts, checkTask: task, projectContext: { model, verification: {} },
    taskEdits: { turnEnded: true }, snapshotWorkspace: async () => new Map(tree), activeWorkspaceRoot: () => root,
    events: { ensureLineBreak() {} }, output: { write() {} }, steps: { update() {}, text() {} }, terminal: { setSteps() {} },
  } as unknown as CasperApp;
  return { app, task, parts, registry, model, runs: () => runs, tree: (value: string) => { tree = new Map([["src.txt", value]]); } };
}
const report = (task: VerificationTask, results: VerificationResult[]): VerificationReport => ({ status: "pass", repairAttempts: 0, results, rounds: task.rounds });

test("a final crew sweep executes even a fresh per-part pass; ordinary check reuse stays unchanged", async () => {
  const f = await fixture();
  await f.task.run(["test"]);
  expect((await f.task.run(["test"]))[0]!.reused).toBe(true);
  const final = await finishCrewChecks(f.app, "auto");
  expect(f.runs()).toBe(2);
  expect(final.verification!.results[0]!.reused).not.toBe(true);
  expect((await f.task.run(["test"]))[0]!.reused).toBe(true);
});

test("a whole combined sweep already run on the same final tree counts once", async () => {
  const f = await fixture();
  const before = await crewSweepStart(f.app);
  const results = await f.task.run(["test"]);
  await rememberCrewSweep(f.app, f.task.rounds, before);
  expect((await finishCrewChecks(f.app, "auto", report(f.task, results))).crewChecks?.status).toBe("pass");
  expect(f.runs()).toBe(1);
});

test("a late lead edit requires the full sweep on the new combined tree", async () => {
  const f = await fixture();
  const before = await crewSweepStart(f.app);
  const results = await f.task.run(["test"]);
  await rememberCrewSweep(f.app, f.task.rounds, before);
  f.tree("late-edit");
  await finishCrewChecks(f.app, "auto", report(f.task, results));
  expect(f.runs()).toBe(2);
});

test("a later reviewer completion requires checks after that reviewer, even with the same files", async () => {
  const f = await fixture();
  const before = await crewSweepStart(f.app);
  const results = await f.task.run(["test"]);
  await rememberCrewSweep(f.app, f.task.rounds, before);
  f.parts.markReviewed(1, "fine", 0);
  await finishCrewChecks(f.app, "auto", report(f.task, results));
  expect(f.runs()).toBe(2);
});

for (const scoped of [true, false]) test(`a later check that generates source invalidates the whole batch (${scoped ? "scoped" : "unscoped"})`, async () => {
  const f = await fixture({}, scoped);
  let buildRuns = 0;
  f.app.projectContext!.model.commands.build = "build-command";
  f.registry.register({ name: "build", run: async () => {
    if (++buildRuns === 1) {
      await writeFile(path.join(f.app.activeWorkspaceRoot(), "src.txt"), "generated\n");
      f.tree("generated");
    }
    return { name: "build", cwd: f.app.activeWorkspaceRoot(), status: "pass", exitCode: 0, signal: null,
      stdout: "", stderr: "", truncated: false, durationMs: 1 };
  } });
  const before = await crewSweepStart(f.app);
  await f.task.run(["test", "build"]);
  await rememberCrewSweep(f.app, f.task.rounds, before);
  expect(f.app.crewSweep).toBeUndefined();
  const final = await finishCrewChecks(f.app, "auto", report(f.task, await f.task.refresh()));
  expect(final.crewChecks!.status).toBe("pass");
  expect(f.runs()).toBe(2);
  expect(buildRuns).toBe(2);
});

for (const mode of ["offer", "off"] as const) test(`crew verification ${mode} stays off the automatic path and is explained in the receipt`, async () => {
  const f = await fixture();
  const final = await finishCrewChecks(f.app, mode);
  expect(f.runs()).toBe(0);
  expect(final.crewChecks).toMatchObject({ status: "not-run", reason: `verification is ${mode}` });
  expect(formatReceipt({ execution: "completed", ...final })).toContain(`verification is ${mode}`);
});

for (const field of ["taskRuntimeFailed", "taskRuntimeCancelled", "closing", "taskTurnLimit", "taskSpendStop"] as const) {
  test(`no final crew check starts after ${field}`, async () => {
    const f = await fixture();
    Object.assign(f.app, { [field]: field === "taskTurnLimit" ? 1 : field === "taskSpendStop" ? { spent: 1, limit: 1 } : true });
    expect((await finishCrewChecks(f.app, "auto")).crewChecks).toMatchObject({ status: "not-run", reason: "the task stopped" });
    expect(f.runs()).toBe(0);
  });
}

test("an aborted check task starts no crew sweep", async () => {
  const f = await fixture();
  f.task.abort();
  expect((await finishCrewChecks(f.app, "auto")).crewChecks?.status).toBe("not-run");
  expect(f.runs()).toBe(0);
});

test("no landed crew leaves normal verification and the receipt unchanged", async () => {
  const f = await fixture();
  f.app.crewParts = new PartRecord();
  const previous = report(f.task, []);
  expect(await finishCrewChecks(f.app, "auto", previous)).toEqual({ verification: previous });
  expect(f.runs()).toBe(0);
});

test("a crew with no checks is incomplete rather than a fabricated pass", async () => {
  const f = await fixture();
  f.app.projectContext!.model.commands = {};
  const final = await finishCrewChecks(f.app, "auto");
  expect(final.crewChecks).toEqual({ status: "incomplete", checks: [], reason: "no automatic project checks configured" });
  expect(final.verification!.status).toBe("incomplete");
});

for (const ended of ["timeout", "no_start", "blocked"] as const) test(`a final check ending ${ended} is incomplete, not failing code`, async () => {
  const f = await fixture({ status: "fail", exitCode: null, ended });
  const final = await finishCrewChecks(f.app, "auto");
  expect(final.crewChecks!.status).toBe("incomplete");
  expect(taskOutcome(undefined, { execution: "completed", ...final })).toBe("incomplete");
  expect(f.runs()).toBe(1);
});

test("a skipped full check leaves the crew incomplete", async () => {
  const f = await fixture({ status: "skip", exitCode: null, reason: "missing tool" });
  expect((await finishCrewChecks(f.app, "auto")).crewChecks!.status).toBe("incomplete");
});

test("the full sweep respects selected checks and never auto-starts device or manual-only checks", async () => {
  const f = await fixture();
  const forbidden = async (): Promise<VerificationResult> => { throw new Error("must not run"); };
  f.registry.register({ name: "manual", run: forbidden });
  f.registry.register({ name: "lab", kind: "lab", run: forbidden });
  f.app.projectContext!.model.namedChecks = { manual: { kind: "offline", run: "manual", after: "ask" }, lab: { kind: "lab", run: "device-command" } };
  expect((await finishCrewChecks(f.app, "auto")).crewChecks!.checks).toEqual(["test"]);
  f.app.projectContext!.verification.checks = ["lab"];
  const final = await finishCrewChecks(f.app, "auto");
  expect(final.crewChecks!.status).toBe("incomplete");
  expect(f.runs()).toBe(1);
  f.app.projectContext!.verification.checks = [];
  expect((await finishCrewChecks(f.app, "auto")).crewChecks!.checks).toEqual([]);
  expect(f.runs()).toBe(1);
});

test("checks that change the final combined files leave the crew incomplete, even without scopes", async () => {
  const f = await fixture({}, false);
  f.app.projectContext!.model.commands.build = "build-command";
  f.registry.register({ name: "build", run: async () => {
    f.tree("changed-by-check");
    return { name: "build", cwd: f.app.activeWorkspaceRoot(), status: "pass", exitCode: 0, signal: null,
      stdout: "", stderr: "", truncated: false, durationMs: 1 };
  } });
  const final = await finishCrewChecks(f.app, "auto");
  expect(final.crewChecks!.status).toBe("incomplete");
  expect(final.crewChecks!.reason).toContain("changed during the sweep");
  expect(final.verification!.status).toBe("incomplete");
});

test("the roadmap marks combined full checks built while crew-wide request limits remain planned", async () => {
  const html = await readFile(new URL("../site/roadmap.html", import.meta.url), "utf8");
  const crew = html.slice(html.indexOf('<article class="card" id="v030"'), html.indexOf('<section id="later"'));
  expect(crew).toContain("Full checks on the combined result");
  expect(crew).toContain("built, next release");
  expect(crew).toContain("receipt shows the run and its status");
  expect(crew).toContain("Your limits apply to the crew.");
  expect(html).toContain("crew-wide request limits have not been started");
});

test("crew and verification docs describe the final batch and its receipt without claiming a release", async () => {
  const crew = await readFile(new URL("../docs/CREWS.md", import.meta.url), "utf8");
  const verification = await readFile(new URL("../docs/VERIFICATION.md", import.meta.url), "utf8");
  const release = await readFile(new URL("../docs/RELEASE.md", import.meta.url), "utf8");
  expect(crew).toContain("built for the next release");
  expect(crew).toContain("Earlier per-part passes do not replace this run");
  expect(verification).toContain("Crew full checks on the combined result");
  expect(release).toContain("The crew-wide request budget remains planned");
});

test("saved receipts and JSON receipt text retain the combined full-check result", async () => {
  const f = await fixture();
  const final = await finishCrewChecks(f.app, "auto");
  const saved = storedTaskResult({ execution: "completed", ...final });
  expect(saved.crewChecks).toEqual({ status: "pass", checks: ["test"] });
  expect(formatReceipt(saved)).toContain("Crew full checks on the combined result: pass (test)");
  expect(receiptEvent(final.verification, saved, 0).text).toContain("Crew full checks on the combined result: pass (test)");
});
