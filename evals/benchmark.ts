import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { HARNESS_NAMES, harnessProtocol, runHarness, type HarnessInput, type HarnessName, type HarnessObservation } from "./harness";
import { scoreQuality, type PredicateEvidence, type QualityEvidence, type QualityScore, type Verdict } from "./quality";
import {
  evaluateAcceptance, gradePreparedEval, prepareEvalTask, prepareWorkdir, referenceChanges, runVerification,
  type EvalAcceptance, type EvalObservation, type EvalPack, type EvalRunResult, type EvalTask,
} from "./runner";
import { BENCHMARK_PACKS, EVAL_TASKS } from "./tasks";

/** The quality benchmark: Casper and Pi (optionally OMP) on the same task, model, effort and time limit, each run graded
 * by the frozen evaluator and scored from host evidence only (evals/quality.ts). */

/** One attempt of a run with follow-ups: attempt 0 is the task itself, then each follow-up. */
export interface ReworkAttempt {
  attempt: number;
  termination: HarnessObservation["termination"];
  wallClockMs: number;
  turns: number | null;
  tokens: number | null;
  estimatedCost: number | null;
  /** The conversation the CLI reported; a follow-up in another one did not really continue. */
  sessionId: string | null;
  receiptOutcome: string | null;
  /** Accepted by the frozen grader after this attempt. */
  success: boolean;
  failedChecks: string[];
  acceptanceFailures: string[];
  phases?: HarnessObservation["phases"];
  smoke?: HarnessObservation["smoke"];
  /** The final answer, bounded. */
  answer: string;
}

/** The rework experiment (`followUps`): a failed run gets the grader's failure report in the same
 * conversation, as a person reporting the failure would, up to the cap. The rubric still scores the
 * first attempt; this is what it took to get from there to an accepted result. */
export interface ReworkResult {
  /** Follow-ups sent. */
  followUps: number;
  firstTimeRight: boolean;
  /** Accepted after a follow-up. */
  fixed: boolean;
  /** Every follow-up ran in the first attempt's conversation; null when a CLI reported no id or no
   * follow-up was sent. */
  resumed: boolean | null;
  totalWallClockMs: number;
  totalTurns: number | null;
  totalTokens: number | null;
  totalCost: number | null;
  attempts: ReworkAttempt[];
}

export interface BenchmarkRun {
  taskId: string;
  pack: EvalPack;
  harness: HarnessName;
  /** 1-based repeat index. */
  repeat: number;
  run: HarnessObservation;
  graded: EvalRunResult;
  evidence: QualityEvidence;
  score: QualityScore;
  /** Only with follow-ups. `run`, `graded`, `evidence` and `score` are always the first attempt. */
  rework?: ReworkResult;
  /** The run ended on provider errors alone even after its one rerun (`isInfrastructureRun`): not
   * quality evidence. The summary re-derives it from `run`, so older documents are counted too. */
  infra?: true;
  /** The attempt this run replaced: it ended on provider errors alone, so the job ran once more,
   * fresh. Kept as evidence; never scored. */
  infraAttempt?: HarnessObservation;
}

// ---------------------------------------------------------------------------------------------
// Infrastructure failures. A rate-limited or unreachable host says nothing about either harness:
// the pinned GLM benchmark lost one Casper run to four Together 429s in 16 s, scored as a miss.

/** The errors the CLI itself reported, without the stderr tail runHarness appends to a failed run.
 * Documents saved before `stderr` was recorded: Casper always prints its banner to stderr, so a
 * failed Casper run's last entry is that tail. */
function reportedErrors(harness: HarnessName, run: HarnessObservation): string[] {
  const tail = run.stderr !== undefined ? run.errors.at(-1) === run.stderr
    : harnessProtocol(harness) === "casper" && run.exitCode !== 0 && run.errors.length > 0;
  return tail ? run.errors.slice(0, -1) : run.errors;
}

/** Pi's own retry classification (pi-ai `isRetryableAssistantError`): rate limits, 5xx, overload and
 * transport failures, but not quota or billing exhaustion. */
const retryable = (error: string) => isRetryableAssistantError({ stopReason: "error", errorMessage: error } as AssistantMessage);

/** The run failed (not the time limit) before any tool call, and every error the CLI reported is a
 * retryable provider error: the host failed, not the harness. A timeout is not infrastructure: a
 * model silent for the whole limit is the model's own behavior. */
export function isInfrastructureRun({ harness, run }: Pick<BenchmarkRun, "harness" | "run">): boolean {
  if (run.termination !== "failed" || run.tools?.length) return false;
  const errors = reportedErrors(harness, run);
  return errors.length > 0 && errors.every(retryable);
}

/** A job that could not run or be graded at all; the other jobs still finish. */
export interface BenchmarkFailure { taskId: string; harness: HarnessName; repeat: number; error: string }

// ---------------------------------------------------------------------------------------------
// The final claim. A host heuristic over the final answer, never an LLM judge: the quote is kept
// so a reviewer can audit every verdict. A caveat ("I could not run tsc") is still a done claim.

const NOT_DONE = /\b(?:not (?:yet )?(?:done|finished|complete|completed|implemented|working|passing)|(?:is|are|remains?|still|left) (?:still )?(?:incomplete|unfinished)|partially (?:implemented|done|complete|completed|working)|(?:still|remains?|remaining) fail(?:s|ing|ures?)?|(?:tests?|checks?|cases?) (?:are |is )?(?:still )?failing|fail(?:s|ed)? to (?:pass|compile|build)|(?:could(?:n't| not)|unable to|was not able to|wasn't able to) (?:finish|complete|fix|get|implement|make)|ran out of (?:time|turns))\b/gi;
const NEGATED = /\b(?:no|none of the|zero|nothing)\s+(?:\w+\s+)?$/i;
const DONE = /\b(?:done|implemented|fixed|completed?|finished|added|refactored|replaced|updated|rewrote|rewritten|created|extended)\b|\btests? (?:now )?pass/i;

export function classifyClaim(answer: string, termination: HarnessObservation["termination"]): QualityEvidence["claim"] {
  if (termination !== "completed") return { verdict: "unclear", evidence: `The run ended by ${termination === "timeout" ? "timeout" : "failure"}; no final claim.` };
  if (!answer.trim()) return { verdict: "unclear", evidence: "No final answer." };
  const sentences = answer.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
  const quote = (sentence: string) => sentence.length > 300 ? `${sentence.slice(0, 299)}…` : sentence;
  for (const sentence of sentences) {
    for (const match of sentence.matchAll(NOT_DONE)) {
      if (!NEGATED.test(sentence.slice(0, match.index))) return { verdict: "not-done", evidence: quote(sentence) };
    }
  }
  const done = sentences.find((sentence) => DONE.test(sentence));
  return done ? { verdict: "done", evidence: quote(done) } : { verdict: "unclear", evidence: "The final answer neither reports the work done nor admits a gap." };
}

// ---------------------------------------------------------------------------------------------
// Evidence from the graded tree.

const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const FOCUSED_OR_SKIPPED = /\b(?:test|it|describe)\.(?:only|skip|todo|skipIf|todoIf)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/;
const DEBUG_LEFTOVER = /\bconsole\.(?:log|debug|trace)\s*\(|^\s*debugger\s*;?\s*$/m;
const MAX_SCAN_BYTES = 1024 * 1024;

const isTestFile = (relative: string) => TEST_FILE.test(relative);
const installed = (relative: string) => relative === "node_modules" || relative.startsWith("node_modules/");
/** Authored, non-test content: what the diff-size ratio compares. Install output is not authored. */
const authored = (paths: readonly string[]) => paths.filter((relative) => !installed(relative) && !isTestFile(relative));

/** What the reference solution changes relative to the unsolved start (hidden tests excluded). */
export interface ReferenceBaseline {
  /** Authored lines added plus removed; null when they could not be counted. */
  changedLines: number | null;
  /** Pre-existing paths the reference modifies or removes: editing any other one is unrelated. */
  edited: readonly string[];
}

export async function referenceBaseline(task: EvalTask, repoRoot: string): Promise<ReferenceBaseline> {
  const changes = await referenceChanges(task, repoRoot);
  const start = await prepareWorkdir({ ...task, tools: undefined }, repoRoot);
  try {
    const solved = await prepareWorkdir({ ...task, setup: undefined, tools: undefined }, repoRoot);
    try {
      const changedLines = await countChangedLines(start, solved, authored([...changes.added, ...changes.modified, ...changes.removed]));
      return { changedLines, edited: [...changes.modified, ...changes.removed] };
    } finally { await rm(solved, { recursive: true, force: true }); }
  } finally { await rm(start, { recursive: true, force: true }); }
}

/** Lines added plus removed across `paths`, by `git diff --no-index` with no user configuration. */
async function countChangedLines(beforeRoot: string, afterRoot: string, paths: readonly string[]): Promise<number | null> {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-bench-git-"));
  try {
    let total = 0;
    for (const relative of paths) {
      const side = async (root: string) => (await lstat(path.join(root, relative)).then((stats) => stats.isFile(), () => false))
        ? path.join(root, relative) : "/dev/null";
      const child = Bun.spawn(["git", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--numstat", "--", await side(beforeRoot), await side(afterRoot)], {
        env: isolatedEnvironment(home, { GIT_CONFIG_NOSYSTEM: "1" }), stdin: "ignore", stdout: "pipe", stderr: "ignore",
      });
      const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (exitCode === 0) continue;
      // Binary content has no line count (`-\t-`): the size is unknown, not zero.
      const counts = exitCode === 1 ? /^(\d+)\t(\d+)\t/.exec(output) : null;
      if (!counts) return null;
      total += Number(counts[1]) + Number(counts[2]);
    }
    return total;
  } catch { return null; }
  finally { await rm(home, { recursive: true, force: true }); }
}

/** True when any file matches, null when one could not be read (absence is not established). */
async function anyMatch(root: string, files: readonly string[], pattern: RegExp): Promise<Verdict> {
  for (const relative of files) {
    const target = path.join(root, relative);
    const stats = await lstat(target).catch(() => undefined);
    if (!stats?.isFile() || stats.size > MAX_SCAN_BYTES) return null;
    const text = await readFile(target, "utf8").catch(() => undefined);
    if (text === undefined) return null;
    if (pattern.test(text)) return true;
  }
  return false;
}

const not = (verdict: Verdict): Verdict => verdict === null ? null : !verdict;

function every(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes(false)) return false;
  return !verdicts.length || verdicts.includes(null) ? null : true;
}

/** One predicate per declared rule, so Complete can show which rule broke. */
function acceptanceRules(acceptance: EvalAcceptance): { id: string; check: EvalAcceptance }[] {
  return [
    ...(acceptance.changed ?? []).map((prefix) => ({ id: `changed ${prefix}`, check: { changed: [prefix] } })),
    ...(acceptance.unchanged ?? []).map((prefix) => ({ id: `unchanged ${prefix}`, check: { unchanged: [prefix] } })),
    ...(acceptance.allowedChanges ? [{ id: "changes in scope", check: { allowedChanges: acceptance.allowedChanges } }] : []),
    ...(acceptance.contains ?? []).map((rule) => ({ id: `${rule.path} contains ${JSON.stringify(rule.text)}`, check: { contains: [rule] } })),
    ...(acceptance.noMatch ?? []).map((rule) => ({ id: `no ${JSON.stringify(rule.text)} under ${rule.under}`, check: { noMatch: [rule] } })),
    ...(acceptance.noEdits ? [{ id: "no edits", check: { noEdits: true } }] : []),
    ...(acceptance.answerContains ?? []).map((keyword) => ({ id: `answer mentions ${JSON.stringify(keyword)}`, check: { answerContains: [keyword] } })),
  ];
}

export interface MeasureInput {
  task: EvalTask;
  repoRoot: string;
  /** The graded candidate workspace, after the harness stopped. */
  workdir: string;
  graded: EvalRunResult;
  run: HarnessObservation;
  reference: ReferenceBaseline;
  /** Per test command of the mutation check. */
  timeoutMs: number;
}

/** Host evidence for every rubric dimension. Unmeasurable evidence stays null, never a pass or zero. */
export async function measureQuality(input: MeasureInput): Promise<QualityEvidence> {
  const { task, graded, run, workdir } = input;
  const touched = [...graded.filesAdded, ...graded.filesModified, ...graded.filesRemoved];
  const written = [...graded.filesAdded, ...graded.filesModified];
  const checks = (rubric: "works" | "complete" | "clean"): PredicateEvidence[] => task.verify
    .filter((check) => (check.rubric ?? "works") === rubric)
    .map((check) => {
      const result = graded.verification.checks.find((entry) => entry.name === check.name);
      return { id: check.name, passed: graded.verification.status === "unavailable" || !result ? null : result.status === "pass" };
    });
  const holds = async (check: EvalAcceptance) => (await evaluateAcceptance(check, { workdir, touched, answer: run.answer })).passed;

  const requirements = [...checks("complete")];
  for (const rule of acceptanceRules(task.acceptance)) requirements.push({ id: rule.id, passed: await holds(rule.check) });
  const conventions: PredicateEvidence[] = [];
  for (const convention of task.conventions ?? []) conventions.push({ id: convention.id, passed: await holds(convention.check) });
  const testFiles = written.filter(isTestFile);
  const sourceFiles = written.filter((relative) => !installed(relative) && !isTestFile(relative) && CODE_FILE.test(relative));
  const clean: PredicateEvidence[] = [
    ...checks("clean"),
    { id: "no-focused-or-skipped-tests", passed: not(await anyMatch(workdir, testFiles, FOCUSED_OR_SKIPPED)) },
    { id: "no-debug-leftovers", passed: not(await anyMatch(workdir, sourceFiles, DEBUG_LEFTOVER)) },
  ];

  const start = await prepareWorkdir(task, input.repoRoot);
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-bench-tests-"));
  try {
    const changedLines = await countChangedLines(start, workdir, authored(touched));
    const unrelatedPaths = [...graded.filesModified, ...graded.filesRemoved].filter((relative) => !input.reference.edited.includes(relative)).sort();
    const diff = changedLines === null || input.reference.changedLines === null ? null
      : { changedLines, referenceLines: input.reference.changedLines, unrelatedPaths };
    // Mutation check: the candidate's new or changed tests must pass on its code and fail on the
    // unsolved start, with the test support it wrote under tests/ copied along.
    let tests: QualityEvidence["tests"] = { changed: false, candidatePasses: null, unsolvedFails: null };
    if (testFiles.length) {
      const command = [{ name: "candidate tests", argv: [process.execPath, "test", ...testFiles.map((relative) => `./${relative}`)] }];
      const options = { repoRoot: input.repoRoot, homeDir: home, timeoutMs: input.timeoutMs };
      const candidate = await runVerification(command, { ...options, workdir });
      for (const relative of written.filter((entry) => isTestFile(entry) || entry.startsWith("tests/"))) {
        await mkdir(path.dirname(path.join(start, relative)), { recursive: true });
        await copyFile(path.join(workdir, relative), path.join(start, relative));
      }
      const unsolved = await runVerification(command, { ...options, workdir: start });
      tests = { changed: true, candidatePasses: candidate.status === "pass", unsolvedFails: unsolved.status === "fail" };
    }
    return {
      works: every(checks("works").map((check) => check.passed)),
      requirements, tests, clean, conventions, diff,
      claim: classifyClaim(run.answer, run.termination),
      effort: { wallClockMs: run.wallClockMs, turns: run.turns, tokens: run.tokens, estimatedCost: run.estimatedCost,
        rescues: graded.interventions.filter((entry) => entry.kind === "rescue").length },
    };
  } finally {
    await rm(start, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Running.

export interface BenchmarkOptions {
  repoRoot: string;
  tasks: readonly EvalTask[];
  harnesses: readonly HarnessName[];
  /** Executable plus fixed arguments per harness; the Casper variants (`casper-no-review`, `casper-review`) run Casper's unless given their own. */
  commands: Partial<Record<HarnessName, readonly string[]>>;
  model: string;
  effort: HarnessInput["effort"];
  repeat: number;
  /** Jobs at once. Providers rate-limit: 16 at once spoiled half a batch; 2 did not. */
  concurrency: number;
  /** Wall clock per run: the only run limit, identical for both harnesses. */
  timeoutMs: number;
  /** Per independent check and per mutation-check command. */
  verifyTimeoutMs: number;
  seed?: HarnessInput["seed"];
  /** Follow-ups a failed run gets (0–2, default 0): the grader's failure report, sent into the same
   * conversation. Each attempt has the full time limit. */
  followUps?: number;
  /** OpenRouter hosts both harnesses are pinned to (HarnessInput.route). */
  route?: readonly string[];
  /** casper-acceptance-cross's acceptance-test model (HarnessInput.acceptanceModel). */
  acceptanceModel?: HarnessInput["acceptanceModel"];
  onRun?(run: BenchmarkRun): void;
  onFailure?(failure: BenchmarkFailure): void;
}

/** Every repeat of every task on every harness. Both harnesses of one task run next to each other,
 * so they meet the same provider conditions. Results come back in job order. */
export async function runBenchmark(options: BenchmarkOptions): Promise<{ runs: BenchmarkRun[]; failures: BenchmarkFailure[] }> {
  if (options.tasks.some((task) => !task.pack)) throw new Error("Benchmark tasks must belong to a pack");
  if (!Number.isSafeInteger(options.repeat) || options.repeat < 1 || !Number.isSafeInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error("Repeat and concurrency must be positive integers");
  }
  const jobs = Array.from({ length: options.repeat }, (_, index) => index + 1)
    .flatMap((repeat) => options.tasks.flatMap((task) => options.harnesses.map((harness) => ({ task, harness, repeat }))));
  const references = new Map<string, Promise<ReferenceBaseline>>();
  const reference = (task: EvalTask) => {
    let baseline = references.get(task.id);
    if (!baseline) references.set(task.id, baseline = referenceBaseline(task, options.repoRoot));
    return baseline;
  };
  const runs: Array<BenchmarkRun | undefined> = [];
  const failures: Array<BenchmarkFailure | undefined> = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(options.concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const index = next++;
      const { task, harness, repeat } = jobs[index]!;
      try {
        const run = await runJob(options, task, harness, repeat, reference);
        runs[index] = run;
        options.onRun?.(run);
      } catch (error) {
        const failure = { taskId: task.id, harness, repeat, error: error instanceof Error ? error.message : String(error) };
        failures[index] = failure;
        options.onFailure?.(failure);
      }
    }
  }));
  return { runs: runs.filter((run) => run !== undefined), failures: failures.filter((failure) => failure !== undefined) };
}

const MAX_FAILURE_REPORT = 6000;

/** What a person would send back after seeing the failure: the failing checks' output tails (the
 * grader's, which a person running the tests would see) or the broken acceptance rules. */
export function followUpPrompt(graded: EvalRunResult): string {
  const checks = graded.verification.checks.filter((check) => check.status === "fail")
    .map((check) => `${check.name} (exit ${check.exitCode ?? "none"}):\n${check.output.slice(-2500).trim()}`);
  const report = [...checks, ...graded.acceptance.failures].join("\n\n").slice(-MAX_FAILURE_REPORT)
    || `The independent verification is ${graded.verification.status}${graded.verification.unavailable ? `: ${graded.verification.unavailable}` : ""}.`;
  return ["Continue the task. It is not done: the checks below still fail. Fix the implementation, not the checks, and run the relevant tests before you finish.",
    "", "Failure report:", report].join("\n");
}

/** One job, rerun once from a fresh workspace and home when it ended on provider errors alone. */
async function runJob(options: BenchmarkOptions, task: EvalTask, harness: HarnessName, repeat: number,
  reference: (task: EvalTask) => Promise<ReferenceBaseline>): Promise<BenchmarkRun> {
  const first = await runAttempt(options, task, harness, repeat, reference);
  if (!isInfrastructureRun(first)) return first;
  const rerun = await runAttempt(options, task, harness, repeat, reference);
  return { ...rerun, ...(isInfrastructureRun(rerun) ? { infra: true as const } : {}), infraAttempt: first.run };
}

async function runAttempt(options: BenchmarkOptions, task: EvalTask, harness: HarnessName, repeat: number,
  reference: (task: EvalTask) => Promise<ReferenceBaseline>): Promise<BenchmarkRun> {
  const { root, workdir } = await prepareEvalTask(task, options.repoRoot);
  const limit = options.followUps ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 2) throw new Error("Follow-ups must be 0, 1 or 2");
  // A conversation that outlives one attempt needs a home that does too; otherwise runHarness owns it.
  const home = limit ? await mkdtemp(path.join(os.tmpdir(), "casper-bench-session-")) : undefined;
  try {
    const session = (resume: boolean) => home ? { home, id: `casper-bench-${task.id}-${repeat}`, resume } : undefined;
    const attempt = async (prompt: string, resume: boolean) => {
      const startedAt = new Date().toISOString();
      const run = await runHarness(harness, {
        command: options.commands[harness] ?? (harnessProtocol(harness) === "casper" ? options.commands.casper : undefined) ?? [],
        cwd: workdir, prompt, model: options.model, effort: options.effort,
        timeoutMs: options.timeoutMs, seed: options.seed, session: session(resume), ...(options.route?.length ? { route: options.route } : {}),
        ...(options.acceptanceModel ? { acceptanceModel: options.acceptanceModel } : {}),
      });
      const observation: EvalObservation = {
        startedAt, wallClockMs: run.wallClockMs, execution: run.termination === "completed" ? "completed" : "failed",
        modelCalls: run.turns ?? (run.answer ? 1 : 0), answer: run.answer, interventions: [], model: options.model,
        ...(run.termination === "timeout" ? { error: `Stopped at the ${options.timeoutMs / 1000} s time limit` } : {}),
        runtimeErrors: run.errors.map((error) => error.slice(0, 2000)),
      };
      return { run, graded: await gradePreparedEval(root, observation, options.verifyTimeoutMs) };
    };
    const record = (index: number, { run, graded }: Awaited<ReturnType<typeof attempt>>): ReworkAttempt => ({
      attempt: index, termination: run.termination, wallClockMs: run.wallClockMs, turns: run.turns, tokens: run.tokens,
      estimatedCost: run.estimatedCost, sessionId: run.sessionId, receiptOutcome: run.receiptOutcome, success: graded.success,
      failedChecks: graded.verification.checks.filter((check) => check.status === "fail").map((check) => check.name),
      acceptanceFailures: [...graded.acceptance.failures], ...(run.phases ? { phases: run.phases } : {}),
      ...(run.smoke ? { smoke: run.smoke } : {}), answer: run.answer.slice(0, 4000),
    });

    const first = await attempt(task.prompt, false);
    // The rubric reads the tree the first attempt left, before any follow-up changes it.
    const evidence = await measureQuality({ task, repoRoot: options.repoRoot, workdir, graded: first.graded, run: first.run,
      reference: await reference(task), timeoutMs: options.verifyTimeoutMs });
    const result: BenchmarkRun = { taskId: task.id, pack: task.pack!, harness, repeat, run: first.run, graded: first.graded, evidence, score: scoreQuality(evidence) };
    if (!limit) return result;

    const attempts = [record(0, first)];
    let last = first;
    // A timed-out or crashed CLI has no finished conversation to continue.
    while (!last.graded.success && last.run.termination === "completed" && attempts.length <= limit) {
      last = await attempt(followUpPrompt(last.graded), true);
      attempts.push(record(attempts.length, last));
    }
    const sum = (values: readonly (number | null)[]) => values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + value!, 0);
    const followUps = attempts.slice(1);
    const ids = attempts.map((entry) => entry.sessionId);
    return { ...result, rework: {
      followUps: followUps.length, firstTimeRight: first.graded.success, fixed: followUps.length > 0 && last.graded.success,
      resumed: !followUps.length || ids.includes(null) ? null : ids.every((id) => id === ids[0]),
      totalWallClockMs: attempts.reduce((total, entry) => total + entry.wallClockMs, 0),
      totalTurns: sum(attempts.map((entry) => entry.turns)), totalTokens: sum(attempts.map((entry) => entry.tokens)),
      totalCost: sum(attempts.map((entry) => entry.estimatedCost)), attempts,
    } };
  } finally {
    if (home) await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Summary and report.

export interface Tally { yes: number; no: number; unknown: number }
export interface Spread { median: number; min: number; max: number; known: number }

/** One task × harness, or one pack × harness. */
export interface BenchmarkCell {
  /** Runs scored: every run but the infrastructure ones, the denominator of every other field. */
  runs: number;
  /** Runs that ended on provider errors alone even after a rerun (`isInfrastructureRun`). */
  infra: number;
  /** Accepted by the grader: finished, verified by the frozen evaluator, every rule held. */
  success: number;
  works: Tally; complete: Tally; tested: Tally; clean: Tally; conventional: Tally; focused: Tally; honest: Tally;
  falseDone: number;
  requirementFraction: Spread | null;
  diffRatio: Spread | null;
  wallClockMs: Spread | null;
  turns: Spread | null;
  tokens: Spread | null;
  estimatedCost: Spread | null;
  /** Runs with follow-ups only; null when none had them. */
  rework: ReworkCell | null;
  /** Casper's smoke runs (its self-report, not acceptance); null for harnesses that have none. */
  smoke: SmokeCell | null;
}

export interface SmokeCell {
  /** Runs whose receipt carried a smoke report. */
  ran: number;
  /** Of those, the ones whose smoke report passed. */
  passed: number;
  /** Runs with a model-recorded check Casper counted as evidence: it failed before the change and passes after it. */
  proved: number;
  /** Time in the smoke phase per run that had one. */
  ms: Spread | null;
}

export interface ReworkCell {
  runs: number;
  firstTimeRight: number;
  /** Accepted after a follow-up. */
  fixed: number;
  /** Fixed after 1, 2, … follow-ups. */
  fixedAfter: number[];
  /** Still not accepted after the last follow-up (or not continuable). */
  unfixed: number;
  /** Unfixed because an attempt timed out or crashed, so it could not be continued. */
  stopped: number;
  /** First-time right plus fixed: the correct results. */
  accepted: number;
  /** Follow-ups sent: each is a person reading the failure and sending it back. */
  rounds: number;
  resumed: Tally;
  /** Medians over runs of each run's total over its attempts. */
  totalWallClockMs: Spread | null;
  totalTokens: Spread | null;
  totalCost: Spread | null;
  /** Every attempt of every run, the unfixed ones included; null when any is unknown. */
  sum: { wallClockMs: number; tokens: number | null; estimatedCost: number | null };
  /** `sum` over the correct results, plus the person's time (`personMs` per follow-up); null when none. */
  perCorrect: { wallClockMs: number; tokens: number | null; estimatedCost: number | null; withPersonMs: number } | null;
}

/** How the summary prices a follow-up in a person's time. */
export interface SummaryOptions { personMs?: number }
export const DEFAULT_PERSON_MS = 120_000;

type Cells = Partial<Record<HarnessName, BenchmarkCell>>;
export interface BenchmarkSummary {
  /** The person's time charged per follow-up. */
  personMs: number;
  packs: { pack: EvalPack; tasks: { taskId: string; harnesses: Cells }[]; total: Cells; receipts: ReceiptCell[] }[];
}

/** How far one Casper harness's receipt can be trusted in one pack: the hard-task decision metric
 * (docs/EVALUATION.md, "Receipt honesty"). Infrastructure runs are left out entirely; timed-out runs and
 * runs that ended without a receipt are counted but left out of caught, flagged and verified. */
export interface ReceiptCell {
  harness: HarnessName;
  runs: number;
  timeouts: number;
  noReceipt: number;
  /** Not accepted by the grader, and of those the ones whose receipt was not `verified`. */
  wrong: number;
  caught: number;
  /** Wilson 95% interval of caught / wrong; null without wrong runs. */
  catchInterval: [number, number] | null;
  /** Accepted, and of those the ones whose receipt was not `verified`. */
  right: number;
  flagged: number;
  verified: number;
  verifiedWrong: number;
  /** Median wall time and tokens over Pi's in the same pack, timed-out runs included; null without Pi. */
  wallRatio: number | null;
  tokenRatio: number | null;
  rule: { verdict: "met" | "not met" | "inconclusive"; reasons: string[] } | null;
}

/** The agreed decision rule: most wrong outcomes caught, few right ones flagged, at Pi-like cost. */
const RULE = { caught: 0.7, flagged: 0.2, cost: 1.25, timeouts: 0.1 };

function wilson(successes: number, total: number): [number, number] | null {
  if (total === 0) return null;
  const z = 1.96;
  const share = successes / total;
  const scale = 1 + (z * z) / total;
  const center = (share + (z * z) / (2 * total)) / scale;
  const half = (z * Math.sqrt((share * (1 - share)) / total + (z * z) / (4 * total * total))) / scale;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** `piRuns` are Pi's runs in the same pack; the cost ratios compare only the tasks both harnesses ran. */
function receiptCell(harness: HarnessName, all: readonly BenchmarkRun[], piRuns: readonly BenchmarkRun[]): ReceiptCell {
  const runs = all.filter((run) => !isInfrastructureRun(run));
  const timeouts = runs.filter((run) => run.run.termination === "timeout").length;
  const scored = runs.filter((run) => run.run.termination !== "timeout" && run.run.receiptOutcome !== null);
  const wrong = scored.filter((run) => !run.graded.success);
  const right = scored.filter((run) => run.graded.success);
  const caught = wrong.filter((run) => run.run.receiptOutcome !== "verified").length;
  const flagged = right.filter((run) => run.run.receiptOutcome !== "verified").length;
  const verified = scored.filter((run) => run.run.receiptOutcome === "verified");
  const shared = (runs: readonly BenchmarkRun[], other: readonly BenchmarkRun[]) => runs.filter((run) => other.some((peer) => peer.taskId === run.taskId));
  const own = cell(shared(all, piRuns), DEFAULT_PERSON_MS);
  const pi = piRuns.length ? cell(shared(piRuns, all), DEFAULT_PERSON_MS) : undefined;
  const ratio = (mine: Spread | null, theirs: Spread | null | undefined) => mine && theirs?.median ? mine.median / theirs.median : null;
  const wallRatio = ratio(own.wallClockMs, pi?.wallClockMs);
  const tokenRatio = ratio(own.tokens, pi?.tokens);
  const share = (count: number, total: number) => `${count}/${total}`;
  let rule: ReceiptCell["rule"] = null;
  if (pi) {
    const reasons: string[] = [];
    if (!wrong.length) reasons.push("no wrong runs");
    else if (caught / wrong.length < RULE.caught) reasons.push(`caught ${share(caught, wrong.length)} < ${RULE.caught * 100}%`);
    if (right.length && flagged / right.length > RULE.flagged) reasons.push(`flagged ${share(flagged, right.length)} > ${RULE.flagged * 100}%`);
    for (const [name, value] of [["wall", wallRatio], ["tokens", tokenRatio]] as const) {
      if (value === null) reasons.push(`${name} unknown`);
      else if (value > RULE.cost) reasons.push(`${name} ${value.toFixed(2)}× Pi > ${RULE.cost}×`);
    }
    const tooManyTimeouts = runs.length > 0 && timeouts / runs.length > RULE.timeouts;
    rule = tooManyTimeouts || !wrong.length || reasons.some((reason) => reason.endsWith("unknown"))
      ? { verdict: "inconclusive", reasons: tooManyTimeouts ? [`timeouts ${share(timeouts, runs.length)} > ${RULE.timeouts * 100}%`, ...reasons] : reasons }
      : { verdict: reasons.length ? "not met" : "met", reasons };
  }
  return {
    harness, runs: runs.length, timeouts, noReceipt: runs.length - timeouts - scored.length, wrong: wrong.length, caught,
    catchInterval: wilson(caught, wrong.length), right: right.length, flagged, verified: verified.length,
    verifiedWrong: verified.filter((run) => !run.graded.success).length, wallRatio, tokenRatio, rule,
  };
}

/** Why the rule can no longer be met with `remaining` more scored runs, even if every one of them goes the
 * receipt's way; empty when it still can. Cost ratios over the bar count as final: each run pays the same
 * extra work, so more runs do not bring a median ratio back under it. */
export function futility(cell: ReceiptCell, remaining: number): string[] {
  const reasons: string[] = [];
  if (cell.flagged > RULE.flagged * (cell.right + remaining)) reasons.push(`flagged ${cell.flagged} of at most ${cell.right + remaining} right runs > ${RULE.flagged * 100}%`);
  if (cell.wrong && cell.caught + remaining < RULE.caught * (cell.wrong + remaining)) reasons.push(`caught ${cell.caught}/${cell.wrong} cannot reach ${RULE.caught * 100}%`);
  for (const [name, value] of [["wall", cell.wallRatio], ["tokens", cell.tokenRatio]] as const) {
    if (value !== null && value > RULE.cost) reasons.push(`${name} ${value.toFixed(2)}× Pi > ${RULE.cost}×`);
  }
  return reasons;
}

const HARNESSES = HARNESS_NAMES;
const DIMENSIONS = ["works", "complete", "tested", "clean", "conventional", "focused", "honest"] as const;

function spread(values: readonly (number | null)[]): Spread | null {
  const known = values.filter((value): value is number => value !== null).sort((left, right) => left - right);
  if (!known.length) return null;
  const middle = known.length >> 1;
  const median = known.length % 2 ? known[middle]! : (known[middle - 1]! + known[middle]!) / 2;
  return { median, min: known[0]!, max: known.at(-1)!, known: known.length };
}

function cell(all: readonly BenchmarkRun[], personMs: number): BenchmarkCell {
  const runs = all.filter((run) => !isInfrastructureRun(run));
  const tally = (dimension: (typeof DIMENSIONS)[number]): Tally => ({
    yes: runs.filter((run) => run.score[dimension] === true).length,
    no: runs.filter((run) => run.score[dimension] === false).length,
    unknown: runs.filter((run) => run.score[dimension] === null).length,
  });
  const tallies = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, tally(dimension)])) as Record<(typeof DIMENSIONS)[number], Tally>;
  return {
    runs: runs.length, infra: all.length - runs.length, success: runs.filter((run) => run.graded.success).length, ...tallies,
    falseDone: runs.filter((run) => run.score.falseDone).length,
    requirementFraction: spread(runs.map((run) => run.score.requirementFraction)),
    diffRatio: spread(runs.map((run) => run.score.diffRatio)),
    wallClockMs: spread(runs.map((run) => run.score.effort.wallClockMs)),
    turns: spread(runs.map((run) => run.score.effort.turns)),
    tokens: spread(runs.map((run) => run.score.effort.tokens)),
    estimatedCost: spread(runs.map((run) => run.score.effort.estimatedCost)),
    rework: reworkCell(runs.flatMap((run) => run.rework ? [run.rework] : []), personMs),
    smoke: all[0] && harnessProtocol(all[0].harness) === "casper" ? smokeCell(runs) : null,
  };
}

function smokeCell(runs: readonly BenchmarkRun[]): SmokeCell {
  const reports = runs.flatMap((run) => run.run.smoke ? [run.run.smoke] : []);
  const phaseMs = runs.map((run) => run.run.phases?.filter((phase) => phase.phase === "smoke"))
    .map((phases) => phases?.length ? phases.reduce((ms, phase) => ms + phase.durationMs, 0) : null);
  return {
    ran: reports.length, passed: reports.filter((report) => report.status === "pass").length,
    proved: reports.filter((report) => report.checks.some((check) => check.source === "model" && check.status === "pass" && check.evidence === true)).length,
    ms: spread(phaseMs),
  };
}

const total = (values: readonly (number | null)[]) => values.includes(null) ? null : values.reduce<number>((sum, value) => sum + value!, 0);

function reworkCell(reworks: readonly ReworkResult[], personMs: number): ReworkCell | null {
  if (!reworks.length) return null;
  const sent = reworks.filter((rework) => rework.followUps > 0);
  const fixed = reworks.filter((rework) => rework.fixed);
  const unfixed = reworks.filter((rework) => !rework.firstTimeRight && !rework.fixed);
  const attempts = reworks.flatMap((rework) => rework.attempts);
  const accepted = reworks.length - unfixed.length;
  const rounds = sent.reduce((count, rework) => count + rework.followUps, 0);
  const sum = { wallClockMs: attempts.reduce((ms, attempt) => ms + attempt.wallClockMs, 0),
    tokens: total(attempts.map((attempt) => attempt.tokens)), estimatedCost: total(attempts.map((attempt) => attempt.estimatedCost)) };
  const per = (value: number | null) => value === null ? null : value / accepted;
  return {
    runs: reworks.length,
    firstTimeRight: reworks.filter((rework) => rework.firstTimeRight).length,
    fixed: fixed.length,
    fixedAfter: Array.from({ length: Math.max(0, ...reworks.map((rework) => rework.followUps)) }, (_, index) => fixed.filter((rework) => rework.followUps === index + 1).length),
    unfixed: unfixed.length,
    stopped: unfixed.filter((rework) => rework.attempts.at(-1)?.termination !== "completed").length,
    accepted, rounds,
    resumed: { yes: sent.filter((rework) => rework.resumed === true).length, no: sent.filter((rework) => rework.resumed === false).length,
      unknown: sent.filter((rework) => rework.resumed === null).length },
    totalWallClockMs: spread(reworks.map((rework) => rework.totalWallClockMs)),
    totalTokens: spread(reworks.map((rework) => rework.totalTokens)),
    totalCost: spread(reworks.map((rework) => rework.totalCost)),
    sum,
    perCorrect: accepted ? { wallClockMs: sum.wallClockMs / accepted, tokens: per(sum.tokens), estimatedCost: per(sum.estimatedCost),
      withPersonMs: (sum.wallClockMs + rounds * personMs) / accepted } : null,
  };
}

function cells(runs: readonly BenchmarkRun[], personMs: number): Cells {
  const result: Cells = {};
  for (const harness of HARNESSES) {
    const own = runs.filter((run) => run.harness === harness);
    if (own.length) result[harness] = cell(own, personMs);
  }
  return result;
}

/** Packs stay apart (no cross-pack headline); tasks keep catalog order. */
export function summarizeBenchmark(runs: readonly BenchmarkRun[], options: SummaryOptions = {}): BenchmarkSummary {
  const personMs = options.personMs ?? DEFAULT_PERSON_MS;
  const order = (id: string) => { const index = EVAL_TASKS.findIndex((task) => task.id === id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  const packs = [...BENCHMARK_PACKS, ...new Set(runs.map((run) => run.pack))].filter((pack, index, all) => all.indexOf(pack) === index);
  return {
    personMs,
    packs: packs.flatMap((pack) => {
      const own = runs.filter((run) => run.pack === pack);
      if (!own.length) return [];
      const ids = [...new Set(own.map((run) => run.taskId))].sort((left, right) => order(left) - order(right) || left.localeCompare(right));
      const total = cells(own, personMs);
      const receipts = HARNESSES.filter((harness) => harnessProtocol(harness) === "casper" && total[harness])
        .map((harness) => receiptCell(harness, own.filter((run) => run.harness === harness), own.filter((run) => run.harness === "pi")));
      return [{ pack, tasks: ids.map((taskId) => ({ taskId, harnesses: cells(own.filter((run) => run.taskId === taskId), personMs) })), total, receipts }];
    }),
  };
}

const tallyText = (tally: Tally) => `${tally.yes}/${tally.yes + tally.no}${tally.unknown ? ` ?${tally.unknown}` : ""}`;
function spreadText(value: Spread | null, format: (number: number) => string): string {
  if (!value) return "–";
  return value.min === value.max ? format(value.median) : `${format(value.median)} (${format(value.min)}–${format(value.max)})`;
}
const decimal = (digits: number) => (value: number) => value.toFixed(digits);
const tokensText = (value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value));
const costText = (value: number) => `$${value < 0.1 ? value.toFixed(4) : value.toFixed(2)}`;
const percent = (value: number) => `${Math.round(value * 100)}%`;

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((value, column) => column === row.length - 1 ? value : value.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n");
}

const HEADER = ["task", "harness", "success", "infra", "works", "complete", "req", "tested", "clean", "conv", "focused", "diff×", "honest", "false-done", "wall s", "turns", "tokens", "cost", "smoke"];

function row(label: string, harness: HarnessName, value: BenchmarkCell): string[] {
  return [label, harness, `${value.success}/${value.runs}`, String(value.infra), ...DIMENSIONS.slice(0, 2).map((dimension) => tallyText(value[dimension])),
    spreadText(value.requirementFraction, percent), ...DIMENSIONS.slice(2, 6).map((dimension) => tallyText(value[dimension])),
    spreadText(value.diffRatio, decimal(2)), tallyText(value.honest), String(value.falseDone),
    spreadText(value.wallClockMs, (ms) => (ms / 1000).toFixed(0)), spreadText(value.turns, decimal(0)),
    spreadText(value.tokens, tokensText), spreadText(value.estimatedCost, costText), smokeText(value.smoke)];
}

function smokeText(smoke: SmokeCell | null): string {
  if (!smoke) return "–";
  if (!smoke.ran) return "none";
  return `${smoke.passed}/${smoke.ran}${smoke.proved ? `, ${smoke.proved} proved` : ""}${smoke.ms ? `, ${spreadText(smoke.ms, (ms) => `${(ms / 1000).toFixed(1)}s`)}` : ""}`;
}

const REWORK_HEADER = ["task", "harness", "first-time", "fixed (1+2)", "unfixed", "rounds", "resumed", "sum s", "sum tokens", "sum cost",
  "s/correct", "+person s", "tokens/correct", "cost/correct"];

function reworkRow(label: string, harness: HarnessName, value: ReworkCell): string[] {
  const known = <T,>(number: T | null | undefined, format: (value: T) => string) => number === null || number === undefined ? "–" : format(number);
  const seconds = (ms: number) => (ms / 1000).toFixed(0);
  return [label, harness, `${value.firstTimeRight}/${value.runs}`,
    `${value.fixed}/${value.runs - value.firstTimeRight}${value.fixedAfter.length ? ` (${value.fixedAfter.join("+")})` : ""}`,
    `${value.unfixed}${value.stopped ? ` (${value.stopped} stopped)` : ""}`, String(value.rounds), tallyText(value.resumed),
    seconds(value.sum.wallClockMs), known(value.sum.tokens, tokensText), known(value.sum.estimatedCost, costText),
    known(value.perCorrect?.wallClockMs, seconds), known(value.perCorrect?.withPersonMs, seconds),
    known(value.perCorrect?.tokens, tokensText), known(value.perCorrect?.estimatedCost, costText)];
}

/** The person's time per follow-up at which `a` and `b` cost the same time per correct result. */
function breakEven(names: [HarnessName, HarnessName], a: ReworkCell, b: ReworkCell): string | undefined {
  if (!a.accepted || !b.accepted) return undefined;
  // perCorrect(a) − perCorrect(b) = intercept + slope × personMs; negative means a costs less.
  // Frame it for the harness needing fewer follow-ups per correct result (slope ≤ 0).
  let intercept = a.sum.wallClockMs / a.accepted - b.sum.wallClockMs / b.accepted;
  let slope = a.rounds / a.accepted - b.rounds / b.accepted;
  if (slope > 0) { names = [names[1], names[0]]; intercept = -intercept; slope = -slope; }
  if (slope === 0 && intercept === 0) return `${names[0]} and ${names[1]} cost the same time per correct result`;
  if (slope === 0 && intercept > 0) return `${names[1]} costs less time per correct result than ${names[0]} at any person time`;
  const lead = `${names[0]} costs less time per correct result than ${names[1]}`;
  const even = slope === 0 ? 0 : -intercept / slope;
  return even <= 0 ? `${lead} at any person time` : `${lead} when a follow-up takes a person more than ${(even / 1000).toFixed(0)} s`;
}

const RECEIPT_HEADER = ["harness", "runs", "timeouts", "no receipt", "caught", "flagged", "false-verified", "wall×Pi", "tokens×Pi", "rule"];

function receiptRow(value: ReceiptCell): string[] {
  const share = (count: number, total: number) => total ? `${count}/${total} ${percent(count / total)}` : "–";
  const interval = value.catchInterval ? ` (${Math.round(value.catchInterval[0] * 100)}–${percent(value.catchInterval[1])})` : "";
  const ratio = (number: number | null) => number === null ? "–" : number.toFixed(2);
  const rule = value.rule ? `${value.rule.verdict}${value.rule.reasons.length ? `: ${value.rule.reasons.join(", ")}` : ""}` : "–";
  return [value.harness, String(value.runs), String(value.timeouts), String(value.noReceipt), `${share(value.caught, value.wrong)}${interval}`,
    share(value.flagged, value.right), share(value.verifiedWrong, value.verified), ratio(value.wallRatio), ratio(value.tokenRatio), rule];
}

/** One table per pack: every task × harness, then the pack total per harness. Numbers are the
 * median (min–max) over runs; `k/n` counts yes among the n known, `?u` the unknown. */
export function formatBenchmarkReport(summary: BenchmarkSummary): string {
  const sections = summary.packs.map(({ pack, tasks, total, receipts }) => {
    const rows = [HEADER];
    for (const { taskId, harnesses } of tasks) for (const harness of HARNESSES) if (harnesses[harness]) rows.push(row(taskId, harness, harnesses[harness]!));
    for (const harness of HARNESSES) if (total[harness]) rows.push(row(`all ${tasks.length} tasks`, harness, total[harness]!));
    const rework = [REWORK_HEADER];
    for (const { taskId, harnesses } of tasks) for (const harness of HARNESSES) if (harnesses[harness]?.rework) rework.push(reworkRow(taskId, harness, harnesses[harness]!.rework!));
    for (const harness of HARNESSES) if (total[harness]?.rework) rework.push(reworkRow(`all ${tasks.length} tasks`, harness, total[harness]!.rework!));
    const withRework = HARNESSES.filter((harness) => total[harness]?.rework);
    const evens = withRework.slice(1).flatMap((other) => breakEven([withRework[0]!, other], total[withRework[0]!]!.rework!, total[other]!.rework!) ?? []);
    const honesty = [RECEIPT_HEADER, ...receipts.map(receiptRow)];
    return `${pack} pack\n${table(rows)}${rework.length > 1 ? `\n\n${pack} pack, time to correct (every attempt of every run, unfixed ones included; `
      + `+person charges ${(summary.personMs / 1000).toFixed(0)} s of a person's time per follow-up)\n${table(rework)}${evens.map((line) => `\n${line}`).join("")}` : ""}`
      + `${receipts.length ? `\n\n${pack} pack, receipt honesty (Casper's receipt against the grader)\n${table(honesty)}` : ""}`;
  });
  return [
    "k/n = yes of n known; ?u = unknown (never counted as a pass or a fail). Spreads are median (min–max) over runs.",
    "req = share of requirement predicates held; diff× = authored changed lines over the reference solution's.",
    "smoke = Casper's runs whose smoke checks passed, of those that ran any (Casper's own report, not acceptance); proved = runs with a model-recorded"
      + " check that failed before the change and passes after it; then the time in the smoke phase. – = a harness without smoke checks.",
    "infra = runs that failed on retryable provider errors alone (rate limit, 5xx, lost connection) before any tool call; the benchmark reruns"
      + " such a run once, fresh, and counts it here only if the rerun failed the same way. They are not quality evidence: every other column,"
      + " success and first-time right included, leaves them out of its n.",
    "receipt honesty: caught = wrong runs (not accepted) whose receipt was not verified, with a Wilson 95% interval; flagged = right runs whose"
      + " receipt was not verified; false-verified = verified runs that were wrong. Timed-out runs and runs without a receipt are left out of all"
      + " three. ×Pi = median wall time and tokens over Pi's in the pack, timed-out runs included. rule: caught ≥ 70%, flagged ≤ 20%, both"
      + " ratios ≤ 1.25; inconclusive with more than 10% timeouts, no wrong runs or an unknown ratio; – without Pi runs.",
    ...sections,
  ].join("\n\n");
}
