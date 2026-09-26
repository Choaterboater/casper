import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import {
  classifyClaim, formatBenchmarkReport, isInfrastructureRun, measureQuality, referenceBaseline, runBenchmark, summarizeBenchmark, type BenchmarkRun,
} from "../evals/benchmark";
import type { HarnessObservation } from "../evals/harness";
import { scoreQuality } from "../evals/quality";
import { gradePreparedEval, prepareEvalTask, type EvalTask } from "../evals/runner";
import { EVAL_TASKS, findEvalTask } from "../evals/tasks";

const repoRoot = path.resolve(import.meta.dir, "..");
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const benchmark = EVAL_TASKS.filter((task) => task.pack);
const DONE = "Implemented the change. All visible tests pass.";

/** Copy the reference solution's candidate paths into the workspace. */
async function solve(task: EvalTask, workdir: string): Promise<void> {
  for (const top of task.candidatePaths) {
    await rm(path.join(workdir, top), { recursive: true, force: true });
    await cp(path.join(repoRoot, "evals/fixtures", task.fixture, top), path.join(workdir, top), { recursive: true });
  }
}

/** Prepare, let `edit` act as the model, grade through the real grader and measure quality. */
async function measured(task: EvalTask, edit: (workdir: string) => Promise<void>, answer = DONE) {
  const { root, workdir } = await prepareEvalTask(task, repoRoot);
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await edit(workdir);
  const graded = await gradePreparedEval(root, { startedAt: new Date().toISOString(), wallClockMs: 1000, execution: "completed", modelCalls: 3, answer, interventions: [] });
  const run: HarnessObservation = { answer, termination: "completed", exitCode: 0, wallClockMs: 1000, turns: 3, tokens: 900, estimatedCost: 0.01, receiptOutcome: null, sessionId: null, errors: [] };
  const evidence = await measureQuality({ task, repoRoot, workdir, graded, run, reference: await referenceBaseline(task, repoRoot), timeoutMs: 60_000 });
  return { graded, evidence, score: scoreQuality(evidence) };
}

test("the claim is read from the final answer: an admitted gap is not-done, a work report is done, nothing is unclear", () => {
  expect(classifyClaim(DONE, "completed")).toEqual({ verdict: "done", evidence: "Implemented the change." });
  expect(classifyClaim("Added the parser.\n\nTwo hidden cases are still failing: CRLF continuations.", "completed"))
    .toEqual({ verdict: "not-done", evidence: "Two hidden cases are still failing: CRLF continuations." });
  expect(classifyClaim("I could not finish the TLS expiry part; the rest works.", "completed").verdict).toBe("not-done");
  expect(classifyClaim("The Junos parser is partially implemented.", "completed").verdict).toBe("not-done");
  expect(classifyClaim("Added both parsers, but the AOS-CX one is still incomplete.", "completed").verdict).toBe("not-done");
  // Describing behavior is not admitting a gap (a real Pi answer from the first runs).
  expect(classifyClaim("I implemented the parsers.\n- Handles pager truncation by dropping the incomplete last block.", "completed").verdict).toBe("done");
  // Caveats and negated failures are still a done claim.
  expect(classifyClaim("Updated src/probe.ts. Nothing failed in local tests, and no tests are failing.", "completed").verdict).toBe("done");
  expect(classifyClaim("Refactored the name handling. I could not run tsc here, so please check types.", "completed").verdict).toBe("done");
  // No final claim: the run stopped, or the answer says nothing either way.
  expect(classifyClaim(DONE, "timeout")).toEqual({ verdict: "unclear", evidence: "The run ended by timeout; no final claim." });
  expect(classifyClaim("   ", "completed")).toEqual({ verdict: "unclear", evidence: "No final answer." });
  expect(classifyClaim("Here is what I found about the log format.", "completed").verdict).toBe("unclear");
});

test("the reference solution scores every host dimension (Tested only where it rewrites a test)", async () => {
  for (const task of benchmark) {
    const { score, evidence } = await measured(task, (workdir) => solve(task, workdir));
    expect({ task: task.id, ...score, effort: undefined, requirements: evidence.requirements.filter((item) => item.passed !== true) }).toEqual({
      task: task.id, works: true, complete: true, requirementFraction: 1, tested: task.id === "core-flaky-test",
      clean: true, conventional: true, focused: true, diffRatio: 1, honest: true, falseDone: false, effort: undefined, requirements: [],
    });
    expect(evidence.requirements.map((item) => item.id)).toContain("hidden acceptance");
  }
}, 300_000);

test("a new test counts as Tested only when it passes on the candidate and fails on the unsolved start", async () => {
  const task = findEvalTask("core-log-parser")!;
  // The hidden tests, adopted as the candidate's own: they pin the new behavior down.
  const adopted = await measured(task, async (workdir) => {
    await solve(task, workdir);
    await cp(path.join(repoRoot, "evals/fixtures", task.fixture, "acceptance/parse.test.ts"), path.join(workdir, "tests/adopted.test.ts"));
  });
  expect(adopted.evidence.tests).toEqual({ changed: true, candidatePasses: true, unsolvedFails: true });
  expect(adopted.score.tested).toBe(true);
  // A test the unsolved code also passes proves nothing about the change.
  const trivial = await measured(task, async (workdir) => {
    await solve(task, workdir);
    await writeFile(path.join(workdir, "tests/trivial.test.ts"), 'import { expect, test } from "bun:test";\ntest("one", () => expect(1).toBe(1));\n');
  });
  expect(trivial.evidence.tests).toEqual({ changed: true, candidatePasses: true, unsolvedFails: false });
  expect(trivial.score.tested).toBe(false);
  const failing = await measured(task, async (workdir) => {
    await solve(task, workdir);
    await writeFile(path.join(workdir, "tests/broken.test.ts"), 'import { expect, test } from "bun:test";\ntest("one", () => expect(1).toBe(2));\n');
  });
  expect(failing.evidence.tests?.candidatePasses).toBe(false);
  expect(failing.score.tested).toBe(false);
}, 120_000);

test("debug leftovers, focused tests and edits the reference never needed lower Clean and Focused", async () => {
  const task = findEvalTask("net-netbox-dry-run")!;
  const { score, evidence } = await measured(task, async (workdir) => {
    await solve(task, workdir);
    const plan = path.join(workdir, "src/plan.ts");
    await writeFile(plan, `${await readFile(plan, "utf8")}\nconsole.log("debug");\n`);
    await writeFile(path.join(workdir, "tests/extra.test.ts"), 'import { expect, test } from "bun:test";\ntest.only("one", () => expect(1).toBe(1));\n');
    const format = path.join(workdir, "src/format.ts");
    await writeFile(format, `// touched\n${await readFile(format, "utf8")}`);
  });
  expect(evidence.clean).toEqual([
    { id: "no-focused-or-skipped-tests", passed: false },
    { id: "no-debug-leftovers", passed: false },
  ]);
  expect(evidence.diff?.unrelatedPaths).toEqual(["src/format.ts"]);
  expect({ clean: score.clean, focused: score.focused, conventional: score.conventional }).toEqual({ clean: false, focused: false, conventional: false });
}, 60_000);

test("an untouched workspace is not Complete, and claiming done on it is a false done", async () => {
  const task = findEvalTask("core-log-parser")!;
  const { score, evidence } = await measured(task, async () => {});
  expect({ complete: score.complete, honest: score.honest, falseDone: score.falseDone, diff: evidence.diff?.changedLines })
    .toEqual({ complete: false, honest: false, falseDone: true, diff: 0 });
  expect(evidence.claim.verdict).toBe("done");
}, 60_000);

const baseRun = (overrides: Partial<ReturnType<typeof scoreQuality>> & { harness?: BenchmarkRun["harness"]; taskId?: string; pack?: BenchmarkRun["pack"]; wallClockMs?: number; turns?: number | null }): BenchmarkRun => {
  const { harness = "casper", taskId = "core-a", pack = "core", wallClockMs = 1000, turns = 10, ...score } = overrides;
  const full = { works: true, complete: true, requirementFraction: 1, tested: false, clean: true, conventional: true, focused: true, diffRatio: 1,
    honest: true, falseDone: false, effort: { wallClockMs, turns, tokens: null, estimatedCost: null, rescues: 0 }, ...score };
  return { taskId, pack, harness, repeat: 1, score: full, graded: { success: full.works === true && full.complete === true },
    run: { termination: "completed", exitCode: 0, errors: [] } } as unknown as BenchmarkRun;
};

type AttemptSpec = { success: boolean; termination?: "completed" | "failed" | "timeout"; wallClockMs: number; tokens: number | null; estimatedCost: number | null };
const reworkRun = (specs: AttemptSpec[], harness: BenchmarkRun["harness"] = "casper"): BenchmarkRun => {
  const attempts = specs.map((spec, index) => ({ attempt: index, termination: "completed" as const, turns: 1, sessionId: "s", receiptOutcome: null,
    failedChecks: [], acceptanceFailures: [], answer: "", ...spec }));
  const first = attempts[0]!;
  const sum = (values: (number | null)[]) => values.includes(null) ? null : values.reduce<number>((total, value) => total + value!, 0);
  const run = baseRun({ harness, wallClockMs: first.wallClockMs, works: first.success, complete: first.success });
  return { ...run, rework: { followUps: attempts.length - 1, firstTimeRight: first.success, fixed: attempts.length > 1 && attempts.at(-1)!.success,
    resumed: attempts.length > 1 ? true : null, totalWallClockMs: sum(attempts.map((attempt) => attempt.wallClockMs))!, totalTurns: attempts.length,
    totalTokens: sum(attempts.map((attempt) => attempt.tokens)), totalCost: sum(attempts.map((attempt) => attempt.estimatedCost)), attempts } } as BenchmarkRun;
};
const ok = (wallClockMs: number, tokens: number | null = 1000, estimatedCost: number | null = 0.01): AttemptSpec => ({ success: true, wallClockMs, tokens, estimatedCost });
const bad = (wallClockMs: number, tokens: number | null = 1000, estimatedCost: number | null = 0.01): AttemptSpec => ({ success: false, wallClockMs, tokens, estimatedCost });

test("time to correct: first-time right, follow-up rounds, and every attempt's cost per correct result, unfixed runs included", () => {
  const summary = summarizeBenchmark([
    reworkRun([ok(100_000)]),
    // Fixed by the second follow-up.
    reworkRun([bad(100_000), bad(50_000), ok(50_000)]),
    // Never fixed: its cost still counts toward the correct results.
    reworkRun([bad(100_000), bad(100_000), bad(100_000)]),
    // Timed out: never continued, and unfixed.
    reworkRun([{ ...bad(250_000), termination: "timeout" }]),
  ], { personMs: 60_000 });
  const rework = summary.packs[0]!.total.casper!.rework!;
  expect(rework).toMatchObject({
    runs: 4, firstTimeRight: 1, fixed: 1, fixedAfter: [0, 1], unfixed: 2, stopped: 1, accepted: 2, rounds: 4,
    sum: { wallClockMs: 850_000, tokens: 8000 },
    perCorrect: { wallClockMs: 425_000, tokens: 4000, withPersonMs: 545_000 },
  });
  expect(rework.sum.estimatedCost).toBeCloseTo(0.08);
  expect(rework.perCorrect!.estimatedCost).toBeCloseTo(0.04);
  const report = formatBenchmarkReport(summary);
  expect(report).toContain("core pack, time to correct");
  expect(report).toMatch(/all 1 tasks\s+casper\s+1\/4\s+1\/3 \(0\+1\)\s+2 \(1 stopped\)\s+4\s+2\/2\s+850\s+8k\s+\$0\.0800\s+425\s+545\s+4k\s+\$0\.0400/);
  // Nothing accepted: there is no cost per correct result.
  expect(summarizeBenchmark([reworkRun([bad(1000), bad(1000)])]).packs[0]!.total.casper!.rework!.perCorrect).toBeNull();
});

test("the break-even says how long a person's follow-up must take for the slower, more often right harness to cost less per correct result", () => {
  // Casper: 2 correct, 0 follow-ups, 400 s. Pi: 2 correct after 2 follow-ups, 200 s. Equal at 100 s per follow-up.
  const summary = summarizeBenchmark([
    reworkRun([ok(200_000)]), reworkRun([ok(200_000)]),
    reworkRun([bad(50_000), ok(50_000)], "pi"), reworkRun([bad(50_000), ok(50_000)], "pi"),
  ], { personMs: 120_000 });
  const report = formatBenchmarkReport(summary);
  expect(report).toContain("casper costs less time per correct result than pi when a follow-up takes a person more than 100 s");
  expect(summary.packs[0]!.total.pi!.rework!.perCorrect!.withPersonMs).toBe(220_000);
  // A harness that is faster and needs fewer follow-ups wins at any person time.
  const always = formatBenchmarkReport(summarizeBenchmark([reworkRun([ok(10_000)]), reworkRun([bad(50_000), ok(50_000)], "pi")]));
  expect(always).toContain("casper costs less time per correct result than pi at any person time");
});

test("the summary keeps packs apart and reports median, range, unknowns and false dones per task and harness", () => {
  const summary = summarizeBenchmark([
    baseRun({ wallClockMs: 1000, turns: 10 }),
    baseRun({ wallClockMs: 3000, turns: null, complete: false, honest: false, falseDone: true }),
    baseRun({ wallClockMs: 2000, turns: 20, honest: null, diffRatio: 2 }),
    baseRun({ harness: "pi", wallClockMs: 500, turns: 5 }),
    baseRun({ taskId: "net-a", pack: "network", harness: "pi", complete: false }),
  ]);
  expect(summary.packs.map((pack) => pack.pack)).toEqual(["core", "network"]);
  const casper = summary.packs[0]!.tasks[0]!.harnesses.casper!;
  expect(casper).toMatchObject({
    runs: 3, success: 2, falseDone: 1,
    complete: { yes: 2, no: 1, unknown: 0 }, honest: { yes: 1, no: 1, unknown: 1 },
    wallClockMs: { median: 2000, min: 1000, max: 3000, known: 3 },
    turns: { median: 15, min: 10, max: 20, known: 2 },
    diffRatio: { median: 1, min: 1, max: 2, known: 3 },
    tokens: null,
  });
  // Pack totals per harness; network has no Casper runs at all.
  expect(summary.packs[0]!.total.pi).toMatchObject({ runs: 1, success: 1 });
  expect(summary.packs[1]!.total.casper).toBeUndefined();
  const report = formatBenchmarkReport(summary);
  expect(report).toContain("core pack");
  expect(report).toContain("network pack");
  expect(report).toMatch(/core-a\s+casper\s+2\/3/);
  // An unknown is shown as unknown, never folded into a pass or a fail.
  expect(report).toContain("1/2 ?1");
});

// Casper on core-log-parser #2 of the pinned GLM benchmark (.scratch/phase-4/pinned-glm.json), verbatim:
// four Together 429s retried and lost in 16 s, no tool call, and its stderr tail as the last error.
const rateLimited: HarnessObservation = JSON.parse(await readFile(path.join(import.meta.dir, "fixtures/eval-infra-429-run.json"), "utf8"));

test("a run that failed on retryable provider errors alone, before any tool call, is infrastructure", () => {
  const casper = (run: HarnessObservation, harness: BenchmarkRun["harness"] = "casper") => isInfrastructureRun({ harness, run });
  // Saved before the harness recorded `stderr`: Casper always prints its banner there, so the last entry is that tail.
  expect(casper(rateLimited)).toBe(true);
  const tail = rateLimited.errors.at(-1)!;
  expect(casper({ ...rateLimited, stderr: tail })).toBe(true);
  for (const error of ["503 Service Unavailable", "Network connection lost.", "fetch failed"]) {
    expect(casper({ ...rateLimited, errors: [error, tail], stderr: tail })).toBe(true);
    expect(isInfrastructureRun({ harness: "pi", run: { ...rateLimited, errors: [error] } })).toBe(true);
  }
  // Any work, a finished run, the time limit, a non-provider error or no error at all is the harness's own result.
  expect(casper({ ...rateLimited, tools: [{ tool: "read", calls: 1, ms: 3 }] })).toBe(false);
  expect(casper({ ...rateLimited, termination: "completed" })).toBe(false);
  expect(casper({ ...rateLimited, termination: "timeout" })).toBe(false);
  expect(casper({ ...rateLimited, errors: [rateLimited.errors[0]!, "401 Unauthorized: invalid API key", tail], stderr: tail })).toBe(false);
  expect(casper({ ...rateLimited, errors: [rateLimited.errors[0]!, "Harness output limit exceeded", tail], stderr: tail })).toBe(false);
  expect(casper({ ...rateLimited, errors: ["429: quota exceeded for this billing period", tail], stderr: tail })).toBe(false);
  // The stderr tail echoes the prompt, which may say "timeout" or "500": it is never read as a provider error.
  const echo = "CASPER banner\n> Retry on 500 and on timeout\n✗ Stopped";
  expect(casper({ ...rateLimited, errors: [echo], stderr: echo })).toBe(false);
});

test("infrastructure runs are counted apart and left out of every quality denominator", () => {
  const infra = { ...reworkRun([{ ...bad(16_916), termination: "failed" }]), run: rateLimited };
  const summary = summarizeBenchmark([reworkRun([ok(100_000)]), reworkRun([bad(200_000)]), infra, baseRun({ harness: "pi" })]);
  const casper = summary.packs[0]!.total.casper!;
  expect(casper).toMatchObject({ runs: 2, infra: 1, success: 1, works: { yes: 1, no: 1, unknown: 0 }, wallClockMs: { median: 150_000, known: 2 } });
  expect(casper.rework).toMatchObject({ runs: 2, firstTimeRight: 1, unfixed: 1 });
  expect(summary.packs[0]!.total.pi).toMatchObject({ runs: 1, infra: 0 });
  const report = formatBenchmarkReport(summary);
  expect(report).toMatch(/infra = /);
  expect(report).toMatch(/all 1 tasks\s+casper\s+1\/2\s+1\s/);
  expect(report).toMatch(/all 1 tasks\s+casper\s+1\/2\s+0\/1/);
});

test("the benchmark reruns an infrastructure failure once, fresh, and records it as infra only if the rerun fails too", async () => {
  const task = findEvalTask("core-log-parser")!;
  const scratch = await mkdtemp(path.join(os.tmpdir(), "casper-bench-infra-"));
  cleanup.push(() => rm(scratch, { recursive: true, force: true }));
  const cli = (failures: number, counter: string) => [process.execPath, path.join(import.meta.dir, "fixtures/eval-infra-cli.ts"),
    path.join(repoRoot, "evals/fixtures", task.fixture, "src"), path.join(scratch, counter), String(failures)];
  const options = { repoRoot, tasks: [task], harnesses: ["casper" as const], model: "test/model", effort: "medium" as const, repeat: 1, concurrency: 1,
    timeoutMs: 30_000, verifyTimeoutMs: 60_000 };
  const recovered = await runBenchmark({ ...options, commands: { casper: cli(1, "once") } });
  expect(recovered.failures).toEqual([]);
  const [rerun] = recovered.runs;
  expect({ success: rerun!.graded.success, infra: rerun!.infra, first: rerun!.infraAttempt?.termination, errors: rerun!.infraAttempt?.errors.length })
    .toEqual({ success: true, infra: undefined, first: "failed", errors: 5 });
  // The harness keeps the stderr tail apart, so it is never mistaken for a provider error.
  expect(rerun!.infraAttempt!.stderr).toContain("CASPER banner");
  expect(rerun!.infraAttempt!.errors.at(-1)).toBe(rerun!.infraAttempt!.stderr!);
  expect(await readFile(path.join(scratch, "once"), "utf8")).toBe("2");

  const limited = await runBenchmark({ ...options, commands: { casper: cli(9, "always") } });
  const [stuck] = limited.runs;
  expect({ success: stuck!.graded.success, infra: stuck!.infra, first: Boolean(stuck!.infraAttempt) }).toEqual({ success: false, infra: true, first: true });
  // One rerun, not a loop.
  expect(await readFile(path.join(scratch, "always"), "utf8")).toBe("2");
  expect(summarizeBenchmark(limited.runs).packs[0]!.total.casper).toMatchObject({ runs: 0, infra: 1, success: 0 });
}, 180_000);

test("a scripted CLI runs through prepare, harness, grader and scoring for both harnesses", async () => {
  const task = findEvalTask("core-log-parser")!;
  const command = [process.execPath, path.join(import.meta.dir, "fixtures/eval-benchmark-cli.ts"), path.join(repoRoot, "evals/fixtures", task.fixture, "src")];
  const seen: string[] = [];
  const result = await runBenchmark({
    repoRoot, tasks: [task], harnesses: ["casper", "pi"], commands: { casper: command, pi: command },
    model: "test/model", effort: "medium", repeat: 2, concurrency: 2, timeoutMs: 30_000, verifyTimeoutMs: 60_000,
    onRun: (run) => seen.push(`${run.harness}#${run.repeat}`),
  });
  expect(result.failures).toEqual([]);
  expect(seen.sort()).toEqual(["casper#1", "casper#2", "pi#1", "pi#2"]);
  for (const run of result.runs) {
    expect({ harness: run.harness, success: run.graded.success, works: run.score.works, complete: run.score.complete, honest: run.score.honest, turns: run.score.effort.turns })
      .toEqual({ harness: run.harness, success: true, works: true, complete: true, honest: true, turns: 2 });
  }
}, 120_000);

test("follow-ups continue a failed run in the same conversation; the first attempt stays the headline", async () => {
  const task = findEvalTask("core-log-parser")!;
  const cli = (mode: "resumes" | "forgets") => [process.execPath, path.join(import.meta.dir, "fixtures/eval-rework-cli.ts"), path.join(repoRoot, "evals/fixtures", task.fixture, "src"), mode];
  const result = await runBenchmark({
    repoRoot, tasks: [task], harnesses: ["casper", "pi"], commands: { casper: cli("resumes"), pi: cli("resumes") },
    model: "test/model", effort: "medium", repeat: 1, concurrency: 2, timeoutMs: 30_000, verifyTimeoutMs: 60_000, followUps: 2,
  });
  expect(result.failures).toEqual([]);
  for (const run of result.runs) {
    // The rubric scores the first attempt: it changed nothing and claimed done.
    expect({ harness: run.harness, success: run.graded.success, falseDone: run.score.falseDone, turns: run.score.effort.turns })
      .toEqual({ harness: run.harness, success: false, falseDone: true, turns: 2 });
    const { attempts, ...rework } = run.rework!;
    // One follow-up fixed it, so the second was never sent; both ran in one conversation.
    expect(rework).toEqual({ followUps: 1, firstTimeRight: false, fixed: true, resumed: true,
      totalWallClockMs: attempts[0]!.wallClockMs + attempts[1]!.wallClockMs, totalTurns: 4,
      totalTokens: 600, totalCost: run.harness === "casper" ? 0.004 : 0.004 });
    expect(attempts.map((attempt) => [attempt.attempt, attempt.success, attempt.answer, attempt.sessionId === attempts[0]!.sessionId]))
      .toEqual([[0, false, "Implemented the change.", true], [1, true, "Fixed the failing checks.", true]]);
    expect(attempts[0]!.failedChecks.length).toBeGreaterThan(0);
  }
  const report = formatBenchmarkReport(summarizeBenchmark(result.runs));
  expect(report).toContain("time to correct");
  expect(report).toMatch(/core-log-parser\s+casper\s+0\/1\s+1\/1 \(1\)\s+0\s+1\s+1\/1/);

  // A CLI that starts a new conversation for the follow-up did not resume, whatever it fixed.
  const forgetful = await runBenchmark({
    repoRoot, tasks: [task], harnesses: ["casper"], commands: { casper: cli("forgets"), pi: [] },
    model: "test/model", effort: "medium", repeat: 1, concurrency: 1, timeoutMs: 30_000, verifyTimeoutMs: 60_000, followUps: 1,
  });
  expect(forgetful.runs[0]!.rework).toMatchObject({ followUps: 1, fixed: true, resumed: false });
}, 180_000);

test("a job that cannot run is a recorded failure, and the other jobs still finish", async () => {
  const task = findEvalTask("core-log-parser")!;
  const command = [process.execPath, path.join(import.meta.dir, "fixtures/eval-benchmark-cli.ts"), path.join(repoRoot, "evals/fixtures", task.fixture, "src")];
  const result = await runBenchmark({
    repoRoot, tasks: [task], harnesses: ["casper", "pi"], commands: { casper: command, pi: [] },
    model: "test/model", effort: "medium", repeat: 1, concurrency: 1, timeoutMs: 30_000, verifyTimeoutMs: 60_000,
  });
  expect(result.runs.map((run) => run.harness)).toEqual(["casper"]);
  expect(result.failures).toEqual([{ taskId: task.id, harness: "pi", repeat: 1, error: "Invalid harness input" }]);
}, 120_000);

test("tools/eval.ts --harness runs the benchmark, prints the rubric table and saves one new results document", async () => {
  const task = findEvalTask("core-log-parser")!;
  const host = await mkdtemp(path.join(os.tmpdir(), "casper-bench-cli-"));
  cleanup.push(() => rm(host, { recursive: true, force: true }));
  // An isolated Casper store with one scripted provider: the model resolves, and only its entry is seeded.
  const agent = path.join(host, ".casper/agent");
  await mkdir(agent, { recursive: true });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "m" }] } } }));
  await writeFile(path.join(agent, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "synthetic" } }));
  const harness = path.join(host, "scripted-harness");
  const cli = path.join(import.meta.dir, "fixtures/eval-benchmark-cli.ts");
  await writeFile(harness, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "${path.join(repoRoot, "evals/fixtures", task.fixture, "src")}" "$@"\n`, { mode: 0o755 });
  const results = path.join(host, "results.json");
  const run = async (extra: string[]) => {
    const child = Bun.spawn([process.execPath, "--no-install", path.join(repoRoot, "tools/eval.ts"), "--task", task.id, "--harness", "casper", "--harness", "pi", "--harness", "omp",
      "--model", "fixture/m", "--casper", harness, "--pi", harness, "--omp", harness, "--json", results, ...extra], { env: isolatedEnvironment(host), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  };
  const done = await run([]);
  expect({ exitCode: done.exitCode, stderr: done.stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(done.stdout).toContain("1 task(s) x 1 run(s) x 3 harness(es) = 3 runs; model fixture/m, effort medium, 300 s time limit, 2 at a time");
  expect(done.stdout).toMatch(/core-log-parser\s+casper\s+1\/1/);
  expect(done.stdout).toMatch(/core-log-parser\s+pi\s+1\/1/);
  expect(done.stdout).toMatch(/core-log-parser\s+omp\s+1\/1/);
  const document = JSON.parse(await readFile(results, "utf8"));
  expect(document).toMatchObject({ kind: "quality-benchmark", version: 1, model: "fixture/m", effort: "medium", repeat: 1, timeLimitSeconds: 300, tasks: [task.id], failures: [] });
  expect(document.runs.map((entry: BenchmarkRun) => [entry.harness, entry.graded.success])).toEqual([["casper", true], ["pi", true], ["omp", true]]);
  // Temporary paths are redacted in saved evidence.
  expect(document.harnesses.omp).toEqual({ command: ["<tmp>/scripted-harness"], version: "scripted-harness 1.0.0" });
  expect(document.summary.packs[0].pack).toBe("core");
  // Evidence is never replaced; a benchmark needs an explicit model.
  expect((await run([])).stderr).toContain("Refusing to replace existing evidence");
  const noModel = Bun.spawnSync([process.execPath, "--no-install", path.join(repoRoot, "tools/eval.ts"), "--harness", "pi"], { env: isolatedEnvironment(host) });
  expect({ exit: noModel.exitCode, stderr: noModel.stderr.toString() }).toEqual({ exit: 1, stderr: "[eval] A benchmark needs --model provider/id: both harnesses run the same model\n" });
  // --omp is a benchmark option; without a benchmark it is refused like --pi.
  const stray = Bun.spawnSync([process.execPath, "--no-install", path.join(repoRoot, "tools/eval.ts"), "--omp", harness], { env: isolatedEnvironment(host) });
  expect(stray.stderr.toString()).toContain("--casper, --pi and --omp apply only to a benchmark");
}, 120_000);
