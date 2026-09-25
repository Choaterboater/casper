import { copyFile, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../src/platform/environment";
import { runHarness, type HarnessInput, type HarnessName, type HarnessObservation } from "./harness";
import { scoreQuality, type PredicateEvidence, type QualityEvidence, type QualityScore, type Verdict } from "./quality";
import {
  evaluateAcceptance, gradePreparedEval, prepareEvalTask, prepareWorkdir, referenceChanges, runVerification,
  type EvalAcceptance, type EvalObservation, type EvalPack, type EvalRunResult, type EvalTask,
} from "./runner";
import { BENCHMARK_PACKS, EVAL_TASKS } from "./tasks";

/** The quality benchmark: Casper and Pi on the same task, model, effort and time limit, each run graded
 * by the frozen evaluator and scored from host evidence only (evals/quality.ts). */

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
  /** Executable plus fixed arguments per harness. */
  commands: Record<HarnessName, readonly string[]>;
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

async function runJob(options: BenchmarkOptions, task: EvalTask, harness: HarnessName, repeat: number,
  reference: (task: EvalTask) => Promise<ReferenceBaseline>): Promise<BenchmarkRun> {
  const { root, workdir } = await prepareEvalTask(task, options.repoRoot);
  try {
    const startedAt = new Date().toISOString();
    const run = await runHarness(harness, {
      command: options.commands[harness], cwd: workdir, prompt: task.prompt, model: options.model, effort: options.effort,
      timeoutMs: options.timeoutMs, seed: options.seed,
    });
    const observation: EvalObservation = {
      startedAt, wallClockMs: run.wallClockMs, execution: run.termination === "completed" ? "completed" : "failed",
      modelCalls: run.turns ?? (run.answer ? 1 : 0), answer: run.answer, interventions: [], model: options.model,
      ...(run.termination === "timeout" ? { error: `Stopped at the ${options.timeoutMs / 1000} s time limit` } : {}),
      runtimeErrors: run.errors.map((error) => error.slice(0, 2000)),
    };
    const graded = await gradePreparedEval(root, observation, options.verifyTimeoutMs);
    const evidence = await measureQuality({ task, repoRoot: options.repoRoot, workdir, graded, run, reference: await reference(task), timeoutMs: options.verifyTimeoutMs });
    return { taskId: task.id, pack: task.pack!, harness, repeat, run, graded, evidence, score: scoreQuality(evidence) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------------------------
// Summary and report.

export interface Tally { yes: number; no: number; unknown: number }
export interface Spread { median: number; min: number; max: number; known: number }

/** One task × harness, or one pack × harness. */
export interface BenchmarkCell {
  runs: number;
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
}

type Cells = Partial<Record<HarnessName, BenchmarkCell>>;
export interface BenchmarkSummary {
  packs: { pack: EvalPack; tasks: { taskId: string; harnesses: Cells }[]; total: Cells }[];
}

const HARNESSES: readonly HarnessName[] = ["casper", "pi"];
const DIMENSIONS = ["works", "complete", "tested", "clean", "conventional", "focused", "honest"] as const;

function spread(values: readonly (number | null)[]): Spread | null {
  const known = values.filter((value): value is number => value !== null).sort((left, right) => left - right);
  if (!known.length) return null;
  const middle = known.length >> 1;
  const median = known.length % 2 ? known[middle]! : (known[middle - 1]! + known[middle]!) / 2;
  return { median, min: known[0]!, max: known.at(-1)!, known: known.length };
}

function cell(runs: readonly BenchmarkRun[]): BenchmarkCell {
  const tally = (dimension: (typeof DIMENSIONS)[number]): Tally => ({
    yes: runs.filter((run) => run.score[dimension] === true).length,
    no: runs.filter((run) => run.score[dimension] === false).length,
    unknown: runs.filter((run) => run.score[dimension] === null).length,
  });
  const tallies = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, tally(dimension)])) as Record<(typeof DIMENSIONS)[number], Tally>;
  return {
    runs: runs.length, success: runs.filter((run) => run.graded.success).length, ...tallies,
    falseDone: runs.filter((run) => run.score.falseDone).length,
    requirementFraction: spread(runs.map((run) => run.score.requirementFraction)),
    diffRatio: spread(runs.map((run) => run.score.diffRatio)),
    wallClockMs: spread(runs.map((run) => run.score.effort.wallClockMs)),
    turns: spread(runs.map((run) => run.score.effort.turns)),
    tokens: spread(runs.map((run) => run.score.effort.tokens)),
    estimatedCost: spread(runs.map((run) => run.score.effort.estimatedCost)),
  };
}

function cells(runs: readonly BenchmarkRun[]): Cells {
  const result: Cells = {};
  for (const harness of HARNESSES) {
    const own = runs.filter((run) => run.harness === harness);
    if (own.length) result[harness] = cell(own);
  }
  return result;
}

/** Packs stay apart (no cross-pack headline); tasks keep catalog order. */
export function summarizeBenchmark(runs: readonly BenchmarkRun[]): BenchmarkSummary {
  const order = (id: string) => { const index = EVAL_TASKS.findIndex((task) => task.id === id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
  const packs = [...BENCHMARK_PACKS, ...new Set(runs.map((run) => run.pack))].filter((pack, index, all) => all.indexOf(pack) === index);
  return {
    packs: packs.flatMap((pack) => {
      const own = runs.filter((run) => run.pack === pack);
      if (!own.length) return [];
      const ids = [...new Set(own.map((run) => run.taskId))].sort((left, right) => order(left) - order(right) || left.localeCompare(right));
      return [{ pack, tasks: ids.map((taskId) => ({ taskId, harnesses: cells(own.filter((run) => run.taskId === taskId)) })), total: cells(own) }];
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

const HEADER = ["task", "harness", "success", "works", "complete", "req", "tested", "clean", "conv", "focused", "diff×", "honest", "false-done", "wall s", "turns", "tokens", "cost"];

function row(label: string, harness: HarnessName, value: BenchmarkCell): string[] {
  return [label, harness, `${value.success}/${value.runs}`, ...DIMENSIONS.slice(0, 2).map((dimension) => tallyText(value[dimension])),
    spreadText(value.requirementFraction, percent), ...DIMENSIONS.slice(2, 6).map((dimension) => tallyText(value[dimension])),
    spreadText(value.diffRatio, decimal(2)), tallyText(value.honest), String(value.falseDone),
    spreadText(value.wallClockMs, (ms) => (ms / 1000).toFixed(0)), spreadText(value.turns, decimal(0)),
    spreadText(value.tokens, tokensText), spreadText(value.estimatedCost, costText)];
}

/** One table per pack: every task × harness, then the pack total per harness. Numbers are the
 * median (min–max) over runs; `k/n` counts yes among the n known, `?u` the unknown. */
export function formatBenchmarkReport(summary: BenchmarkSummary): string {
  const sections = summary.packs.map(({ pack, tasks, total }) => {
    const rows = [HEADER];
    for (const { taskId, harnesses } of tasks) for (const harness of HARNESSES) if (harnesses[harness]) rows.push(row(taskId, harness, harnesses[harness]!));
    for (const harness of HARNESSES) if (total[harness]) rows.push(row(`all ${tasks.length} tasks`, harness, total[harness]!));
    return `${pack} pack\n${table(rows)}`;
  });
  return [
    "k/n = yes of n known; ?u = unknown (never counted as a pass or a fail). Spreads are median (min–max) over runs.",
    "req = share of requirement predicates held; diff× = authored changed lines over the reference solution's.",
    ...sections,
  ].join("\n\n");
}
