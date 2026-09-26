#!/usr/bin/env bun

import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isolatedEnvironment } from "../src/platform/environment";
import { useCasperAgentStore } from "../src/runtime/agent-store";
import { formatBenchmarkReport, runBenchmark, summarizeBenchmark, type BenchmarkFailure, type BenchmarkRun } from "../evals/benchmark";
import { HARNESS_NAMES, type HarnessInput, type HarnessName } from "../evals/harness";
import { formatEvalReport, formatEvalResult, writeEvalReport } from "../evals/report";
import { gradePreparedEval, prepareEvalTask, resolveEvalModel, runEvalTask, summarizeEvalRuns } from "../evals/runner";
import type { EvalModel, EvalPack, EvalRunResult, EvalTask, EvalTaskSummary } from "../evals/runner";
import { BENCHMARK_PACKS, EVAL_TASKS, findEvalTask, packTasks } from "../evals/tasks";
import { EVAL_SCENARIOS, prepareScenario } from "../evals/scenarios";

const USAGE = `Usage: bun tools/eval.ts [options]

Default mode runs Casper through its configured provider; model billing applies.
Only Casper-owned state is redirected automatically. Isolate HOME/XDG/Pi resources
and transcript paths explicitly before a live run; ambient Pi extensions can load.
--prepare and --grade are credential-free and never start a model runtime.

Options:
  --task <id>           Select a task (repeatable). Default: every catalog task.
  --repeat <n>          One-shot mode: run each selected task n times (1..20) on fresh
                        work directories and temporary homes; report pass rate,
                        median/min/max wall clock and median tokens per task. Default: 1.
  --model <ref>         One-shot mode: provider/model-id for this run's conversations
                        only. Resolved against Casper's model catalog before any task
                        runs; the user's saved default (~/.casper/settings.json) is
                        never written.
  --prepare             Freeze candidate, evaluator, prompt and manifest for later use.
  --scenario <id>       Prepare a human-driven workflow; requires --prepare, no --task.
  --grade <root>        Grade a previously prepared candidate; requires --observation.
  --observation <path>  Host-recorded attempt JSON outside the candidate workspace.
  --json <path>         Save output to a NEW JSON file; existing reports are never replaced.
                        One-shot runs write { ranAt, model, repeat, results[] }, each
                        result carrying runs[] and the per-task aggregate.
  --timeout <sec>       Independent verification timeout per check. Default: 120.
  --keep                Keep one-shot work directories for inspection.
  --no-auto-verify      Skip Casper's own verification/repair loop in one-shot mode.
  --list                List catalog tasks and human-driven scenarios.
  --help                Show this text.

Quality benchmark (Casper vs Pi, optionally OMP, through their real CLIs; --pack or --harness selects it):
  --pack <core|network> Benchmark a pack (repeatable). Default with --harness: every pack,
                        or only the --task selection.
  --harness <name>      casper, pi, omp (oh-my-pi), or casper-no-review (Casper with its
                        requirements review round off, to measure what the round adds)
                        (repeatable). Default: casper and pi.
  --model <ref>         Required: every harness runs this provider/model-id. Only that
                        provider's entry of ~/.casper/agent/auth.json is copied into each
                        run's temporary home (for OMP, into its agent.db).
  --effort <level>      Reasoning effort for every harness (Pi and OMP: --thinking). Default: medium.
  --repeat <n>          Runs per task per harness (1..20). Default: 1.
  --concurrency <n>     Runs at once (1..16). Default: 2; more hits provider rate limits.
  --time-limit <sec>    Wall clock per run, the only run limit and the same for all. Default: 300.
  --follow-ups <n>      Continue failed runs with the grader's failure report (1..2 follow-ups). Default: 0.
  --route <hosts>       OpenRouter only, and required for an openrouter/* model: pin every harness
                        to these hosts, comma-separated in preference order, with no fallbacks
                        (e.g. Together,Novita). OpenRouter keeps a conversation on one host and
                        hosts differ tenfold in speed. --route any runs unpinned on purpose; the
                        results document records route "unpinned".
  --person-cost <sec>   A person's time charged per follow-up in the time-to-correct table
                        (0..3600). Default: 120.
  --report <path>       Reprint a saved benchmark results document with this checkout's
                        summary (no model calls); --person-cost applies.
  --casper <path>       Casper executable. Default: this checkout (bun src/cli.ts).
  --pi <path>           Pi executable. Default: pi on PATH.
  --omp <path>          OMP executable. Default: omp on PATH.
  --json <path>         Results document. Default: a new evals/results/<date>-<commit>.json.
  Prints a rubric table per pack (docs/EVALUATION.md). Exits 1 only when a run could not
  be run or graded; failed tasks are results, not errors.

Prepared roots contain candidate/, evaluator/, home/, prompt.txt and manifest.json.
Workflow preparations also contain instructions.txt. Keep host artifacts outside
candidate/. Authorize provider/account, model/effort and allowance before execution.
Use docs/EVALUATION.md for the observation schema and isolation limits.
Every --grade saves results/<attempt-id>.json, including failed attempts. Unknown
usage remains unavailable. Reported usage and cost estimates are not billing.`;

interface EvalOptions {
  help: boolean;
  list: boolean;
  selected: string[];
  json?: string;
  model?: string;
  repeat: number;
  timeoutSeconds: number;
  keep: boolean;
  autoVerify: boolean;
  prepare: boolean;
  scenario?: string;
  grade?: string;
  observation?: string;
  packs: EvalPack[];
  harnesses: HarnessName[];
  effort?: HarnessInput["effort"];
  concurrency?: number;
  timeLimitSeconds?: number;
  followUps: number;
  personCostSeconds?: number;
  route?: string[];
  /** `--route any`: an OpenRouter benchmark deliberately left unpinned. */
  unpinned?: boolean;
  report?: string;
  casper?: string;
  pi?: string;
  omp?: string;
}

const EFFORTS: readonly HarnessInput["effort"][] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function wholeNumber(flag: string, value: string, max: number): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > max) throw new Error(`${flag} must be an integer between 1 and ${max}`);
  return count;
}

export function parseArguments(args: readonly string[]): EvalOptions {
  const options: EvalOptions = {
    help: false, list: false, selected: [], repeat: 1, timeoutSeconds: 120, keep: false, autoVerify: true, prepare: false, packs: [], harnesses: [], followUps: 0,
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    if (argument === "--list") { options.list = true; continue; }
    if (argument === "--keep") { options.keep = true; continue; }
    if (argument === "--prepare") { options.prepare = true; continue; }
    if (argument === "--no-auto-verify") { options.autoVerify = false; continue; }
    if (["--pack", "--harness", "--effort", "--concurrency", "--time-limit", "--follow-ups", "--person-cost", "--report", "--route", "--casper", "--pi", "--omp"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      if (argument === "--pack") {
        if (!BENCHMARK_PACKS.includes(value as EvalPack)) throw new Error(`--pack must be one of ${BENCHMARK_PACKS.join(", ")}`);
        if (!options.packs.includes(value as EvalPack)) options.packs.push(value as EvalPack);
      } else if (argument === "--harness") {
        if (!HARNESS_NAMES.includes(value as HarnessName)) throw new Error(`--harness must be one of ${HARNESS_NAMES.join(", ")}`);
        if (!options.harnesses.includes(value as HarnessName)) options.harnesses.push(value as HarnessName);
      } else if (argument === "--effort") {
        if (!EFFORTS.includes(value as HarnessInput["effort"])) throw new Error(`--effort must be one of ${EFFORTS.join(", ")}`);
        options.effort = value as HarnessInput["effort"];
      } else if (argument === "--concurrency") options.concurrency = wholeNumber(argument, value, 16);
      else if (argument === "--time-limit") options.timeLimitSeconds = wholeNumber(argument, value, 3600);
      else if (argument === "--follow-ups") options.followUps = wholeNumber(argument, value, 2);
      else if (argument === "--person-cost") {
        const seconds = Number(value);
        if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) throw new Error("--person-cost must be an integer between 0 and 3600");
        options.personCostSeconds = seconds;
      } else if (argument === "--report") options.report = value;
      else if (argument === "--route") {
        const hosts = value.split(",").map((host) => host.trim()).filter(Boolean);
        if (!hosts.length || hosts.some((host) => host.length > 64)) throw new Error("--route needs comma-separated OpenRouter host names");
        if (hosts.length === 1 && hosts[0] === "any") options.unpinned = true;
        else if (hosts.includes("any")) throw new Error("--route any stands alone: it leaves every host open");
        else options.route = hosts;
      }
      else if (argument === "--casper") options.casper = value;
      else if (argument === "--pi") options.pi = value;
      else options.omp = value;
      continue;
    }
    if (["--task", "--json", "--timeout", "--repeat", "--model", "--scenario", "--grade", "--observation"].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      if (argument === "--task") options.selected.push(value);
      else if (argument === "--json") options.json = value;
      else if (argument === "--model") options.model = value;
      else if (argument === "--scenario") options.scenario = value;
      else if (argument === "--grade") options.grade = value;
      else if (argument === "--observation") options.observation = value;
      else if (argument === "--repeat") {
        const count = Number(value);
        if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("--repeat must be an integer between 1 and 20");
        options.repeat = count;
      } else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout must be a positive number of seconds");
        options.timeoutSeconds = seconds;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help || options.list) return options;
  if (options.report) {
    if (args.some((flag) => flag.startsWith("--") && !["--report", "--person-cost"].includes(flag))) throw new Error("--report takes only --person-cost");
    return options;
  }
  const benchmarkOnly = options.effort || options.concurrency || options.timeLimitSeconds || options.followUps || options.personCostSeconds !== undefined || options.route || options.unpinned || options.casper || options.pi || options.omp;
  if (isBenchmark(options)) {
    if (options.prepare || options.grade || options.scenario || options.keep || !options.autoVerify) {
      throw new Error("--prepare, --grade, --scenario, --keep and --no-auto-verify do not apply to a benchmark");
    }
    if (!options.model) throw new Error("A benchmark needs --model provider/id: both harnesses run the same model");
    const openRouter = options.model.startsWith("openrouter/");
    if ((options.route || options.unpinned) && !openRouter) throw new Error("--route applies only to openrouter models");
    if (openRouter && !options.route && !options.unpinned) {
      throw new Error("OpenRouter benchmarks need --route <hosts> (e.g. --route Together): OpenRouter keeps a conversation on one host and its hosts "
        + "differ tenfold in speed, so an unpinned comparison measures which host each harness drew. Pass --route any to run unpinned anyway.");
    }
    return options;
  }
  if (benchmarkOnly) throw new Error("--effort, --concurrency, --time-limit, --follow-ups, --person-cost, --route, --casper, --pi and --omp apply only to a benchmark (--pack or --harness)");
  if (options.scenario && (!options.prepare || options.selected.length)) throw new Error("--scenario requires --prepare and cannot use --task");
  if (Boolean(options.grade) !== Boolean(options.observation)) throw new Error("--grade and --observation must be used together");
  if (options.grade && (options.prepare || options.selected.length || options.scenario)) throw new Error("--grade cannot select or prepare tasks");
  if ((options.prepare || options.grade) && (options.keep || !options.autoVerify || options.repeat > 1 || options.model)) {
    throw new Error("--keep, --no-auto-verify, --repeat and --model apply only to one-shot runs");
  }
  return options;
}

/** The results document's `route`: the pinned hosts, "unpinned" for an OpenRouter run left open
 * on purpose (`--route any`), or null for a provider with no host choice. */
export function recordedRoute(options: Pick<EvalOptions, "route" | "unpinned">): string[] | "unpinned" | null {
  return options.route ?? (options.unpinned ? "unpinned" : null);
}

/** The requested model, or the one every run agreed on; null when runs disagree or reported none. */
function observedModel(requested: EvalModel | undefined, summaries: readonly EvalTaskSummary[]): string | null {
  if (requested) return `${requested.provider}/${requested.id}`;
  const models = new Set(summaries.flatMap((summary) => summary.runs.map((run) => run.model)));
  return models.size === 1 ? [...models][0]! : null;
}

function isBenchmark(options: EvalOptions): boolean {
  return options.packs.length > 0 || options.harnesses.length > 0;
}

/** The chosen packs plus any --task selection; with neither, every benchmark task. */
function benchmarkTasks(options: EvalOptions): EvalTask[] {
  const selected = options.selected.map((id) => {
    const task = findEvalTask(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    if (!task.pack) throw new Error(`${id} is not a benchmark task; --list shows each task's pack`);
    return task;
  });
  const tasks = options.packs.flatMap((pack) => packTasks(pack));
  for (const task of selected) if (!tasks.includes(task)) tasks.push(task);
  return tasks.length ? tasks : EVAL_TASKS.filter((task) => task.pack);
}

function git(repoRoot: string, args: string[]): string | null {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

/** A harness's `--version` line, probed in an empty directory with an isolated home. */
async function harnessVersion(command: readonly string[]): Promise<string | null> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "casper-bench-version-"));
  try {
    const child = Bun.spawn([...command, "--version"], { cwd: scratch, env: isolatedEnvironment(scratch), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);
    return exitCode === 0 ? (`${stdout}${stderr}`.trim().split("\n")[0] ?? null) : null;
  } catch { return null; }
  finally { await rm(scratch, { recursive: true, force: true }); }
}

async function executable(file: string, flag: string): Promise<string> {
  const resolved = path.resolve(file);
  const stats = await lstat(resolved).catch(() => undefined);
  if (!stats || stats.isDirectory()) throw new Error(`${flag} ${file}: no such executable`);
  return resolved;
}

async function benchmark(options: EvalOptions, repoRoot: string): Promise<number> {
  const tasks = benchmarkTasks(options);
  const harnesses: HarnessName[] = options.harnesses.length ? options.harnesses : ["casper", "pi"];
  const effort = options.effort ?? "medium";
  const concurrency = options.concurrency ?? 2;
  const timeLimitSeconds = options.timeLimitSeconds ?? 300;
  // Every harness gets the same model; fail on an unknown model or a missing sign-in before any run.
  const model = await resolveEvalModel(options.model!);
  const reference = `${model.provider}/${model.id}`;
  const authPath = path.join(getAgentDir(), "auth.json");
  const auth: unknown = JSON.parse(await readFile(authPath, "utf8").catch(() => "{}"));
  if (!auth || typeof auth !== "object" || !Object.hasOwn(auth, model.provider)) {
    throw new Error(`No ${model.provider} sign-in in ${authPath}: each run's temporary home gets only that entry (casper /login ${model.provider})`);
  }
  const modelsStorePath = path.join(getAgentDir(), "models-store.json");
  const seed = { authPath, ...(await lstat(modelsStorePath).then(() => ({ modelsStorePath }), () => ({}))) };
  const pi = options.pi ? await executable(options.pi, "--pi") : Bun.which("pi");
  if (harnesses.includes("pi") && !pi) throw new Error("Pi is not on PATH; pass --pi <path>");
  const omp = options.omp ? await executable(options.omp, "--omp") : Bun.which("omp");
  if (harnesses.includes("omp") && !omp) throw new Error("OMP is not on PATH; pass --omp <path>");
  const casper = options.casper ? [await executable(options.casper, "--casper")] : [process.execPath, path.join(repoRoot, "src/cli.ts")];
  const commands: Record<HarnessName, string[]> = { casper, "casper-no-review": casper, pi: pi ? [pi] : [], omp: omp ? [omp] : [] };

  const ranAt = new Date().toISOString();
  const commit = git(repoRoot, ["rev-parse", "--short=12", "HEAD"]);
  const status = git(repoRoot, ["status", "--porcelain"]);
  const dirty = status === null ? null : status.length > 0;
  let destination = options.json ? path.resolve(options.json) : undefined;
  for (let attempt = 1; !destination; attempt++) {
    const candidate = path.join(repoRoot, "evals/results", `${ranAt.slice(0, 10)}-${commit ?? "unknown"}${dirty ? "-dirty" : ""}${attempt > 1 ? `-${attempt}` : ""}.json`);
    if (!await lstat(candidate).then(() => true, () => false)) destination = candidate;
  }
  const total = tasks.length * options.repeat * harnesses.length;
  process.stdout.write(`${tasks.length} task(s) x ${options.repeat} run(s) x ${harnesses.length} harness(es) = ${total} runs; model ${reference}, effort ${effort}, `
    + `${timeLimitSeconds} s time limit, ${concurrency} at a time${options.route ? `, OpenRouter hosts ${options.route.join(", ")} only` : options.unpinned ? ", OpenRouter hosts UNPINNED (--route any): each run may draw a different host" : ""}.\nProvider billing applies to every model call. Results: ${path.relative(process.cwd(), destination) || destination}\n\n`);
  const versions = Object.fromEntries(await Promise.all(harnesses.map(async (name) => [name, { command: commands[name], version: await harnessVersion(commands[name]) }])));

  let finished = 0;
  const { runs, failures } = await runBenchmark({
    repoRoot, tasks, harnesses, commands, model: reference, effort, repeat: options.repeat, concurrency,
    timeoutMs: timeLimitSeconds * 1000, verifyTimeoutMs: options.timeoutSeconds * 1000, seed, followUps: options.followUps, ...(options.route ? { route: options.route } : {}),
    onRun: (run: BenchmarkRun) => {
      const { score } = run;
      process.stdout.write(`[${++finished}/${total}] ${run.taskId} ${run.harness} #${run.repeat}: ${run.graded.success ? "accepted" : "not accepted"}`
        + `${run.infra ? " (infra: provider errors only, twice; not scored)" : run.infraAttempt ? " (rerun after provider errors)" : ""}; `
        + `claim ${run.evidence.claim.verdict}${score.falseDone ? " (false done)" : ""}; ${Math.round(score.effort.wallClockMs / 1000)} s, ${score.effort.turns ?? "?"} turns`
        + (run.rework?.followUps ? `; ${run.rework.followUps} follow-up(s): ${run.rework.fixed ? "fixed" : "still not accepted"}${run.rework.resumed === false ? " (did not resume the conversation)" : ""}, ${Math.round(run.rework.totalWallClockMs / 1000)} s total` : "") + "\n");
    },
    onFailure: (failure: BenchmarkFailure) => {
      process.stdout.write(`[${++finished}/${total}] ${failure.taskId} ${failure.harness} #${failure.repeat}: could not run: ${failure.error}\n`);
    },
  });
  const summary = summarizeBenchmark(runs, personCost(options));
  process.stdout.write(`\n${formatBenchmarkReport(summary)}\n`);
  if (failures.length) process.stdout.write(`\n${failures.length} run(s) could not run or be graded; see failures in the results.\n`);
  await writeEvalReport(destination, {
    kind: "quality-benchmark", version: 1, ranAt, commit, dirty, model: reference, effort, repeat: options.repeat, concurrency,
    timeLimitSeconds, verifyTimeoutSeconds: options.timeoutSeconds, route: recordedRoute(options), harnesses: versions, tasks: tasks.map((task) => task.id),
    summary, failures, runs,
  });
  process.stdout.write(`Wrote ${path.relative(process.cwd(), destination) || destination}\n`);
  return failures.length ? 1 : 0;
}

const personCost = (options: EvalOptions) => options.personCostSeconds === undefined ? {} : { personMs: options.personCostSeconds * 1000 };

/** Reprint a saved results document: the runs are evidence, the summary is recomputed. */
async function reprint(options: EvalOptions): Promise<void> {
  const document = JSON.parse(await readFile(options.report!, "utf8")) as { kind?: unknown; runs?: unknown };
  if (document.kind !== "quality-benchmark" || !Array.isArray(document.runs)) throw new Error(`${options.report} is not a benchmark results document`);
  process.stdout.write(`${formatBenchmarkReport(summarizeBenchmark(document.runs as BenchmarkRun[], personCost(options)))}\n`);
}

async function main(): Promise<void> {
  useCasperAgentStore(); // Eval runs keep the user's real credentials (Casper's own store).
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${USAGE}\n`); return; }
  if (options.report) { await reprint(options); return; }
  if (options.list) {
    for (const task of EVAL_TASKS) process.stdout.write(`${task.id}  (${task.fixture}${task.setup ? ` + ${task.setup}` : ""})${task.pack ? ` [${task.pack} pack]` : ""}\n`);
    for (const id of EVAL_SCENARIOS) process.stdout.write(`${id}  (human-driven; --prepare --scenario ${id})\n`);
    return;
  }
  if (options.json) {
    const existing = await lstat(options.json).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) throw new Error(`Refusing to replace existing evidence: ${options.json}`);
  }
  const repoRoot = path.resolve(import.meta.dir, "..");
  if (isBenchmark(options)) { process.exitCode = await benchmark(options, repoRoot); return; }
  const results: EvalRunResult[] = [];
  let document: unknown;
  if (options.grade) {
    const observationPath = await realpath(options.observation!);
    const candidatePath = await realpath(path.join(options.grade, "candidate"));
    const relative = path.relative(candidatePath, observationPath);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error("Host observations must live outside candidate/");
    }
    const observation: unknown = JSON.parse(await readFile(observationPath, "utf8"));
    const result = await gradePreparedEval(path.resolve(options.grade), observation, options.timeoutSeconds * 1000);
    results.push(result);
    process.stdout.write(`${formatEvalResult(result)}\n`);
    document = { results };
  } else {
    const scenario = options.scenario ? prepareScenario(options.scenario) : undefined;
    const tasks = scenario ? [scenario.task] : options.selected.length ? options.selected.map(id => {
      const task = findEvalTask(id);
      if (!task) throw new Error(`Unknown task: ${id}`);
      return task;
    }) : EVAL_TASKS;
    if (options.prepare) {
      const prepared = [];
      for (const task of tasks) {
        const paths = await prepareEvalTask(task, repoRoot);
        if (scenario) await writeFile(path.join(paths.root, "instructions.txt"), `${scenario.instructions}\n`, { flag: "wx" });
        prepared.push({ taskId: task.id, ...paths });
        process.stdout.write(`Prepared ${task.id}\n  root: ${paths.root}\n  candidate: ${paths.workdir}\n`);
      }
      process.stdout.write("Preparation only; no model runtime or acceptance run. Retain the roots for execution; remove them after retaining needed evidence.\n");
      document = { prepared };
    } else {
      // Fail on an unknown model or missing credentials before a single fixture is prepared.
      const model = options.model ? await resolveEvalModel(options.model) : undefined;
      process.stdout.write(`${tasks.length} task(s)${options.repeat > 1 ? ` x ${options.repeat} runs` : ""}; model ${model ? `${model.provider}/${model.id} (--model, this run only)` : "Casper default"}; `
        + "Casper-owned state redirected to a temporary home; Pi resources and transcripts require explicit launch isolation; provider billing applies to model calls.\n\n");
      const summaries: EvalTaskSummary[] = [];
      for (const task of tasks) {
        const runs: EvalRunResult[] = [];
        for (let run = 1; run <= options.repeat; run++) {
          const result = await runEvalTask(task, {
            repoRoot, model, keepWorkdir: options.keep, autoVerify: options.autoVerify, verifyTimeoutMs: options.timeoutSeconds * 1000,
          });
          runs.push(result);
          results.push(result);
          process.stdout.write(`${options.repeat > 1 ? `[${run}/${options.repeat}] ` : ""}${formatEvalResult(result)}\n`);
        }
        summaries.push(summarizeEvalRuns(task, runs));
      }
      // Single runs were already streamed line by line above; repeat the totals only. Repeated
      // runs get the per-task summary lines (pass rate, spread), which are new information.
      const report = formatEvalReport(summaries);
      process.stdout.write(`\n${options.repeat > 1 ? report : report.slice(report.indexOf("\n\n") + 2)}`);
      document = { ranAt: new Date().toISOString(), model: observedModel(model, summaries), repeat: options.repeat, results: summaries };
    }
  }
  if (options.json) {
    if (options.prepare) {
      // Preparation is an operational manifest: its paths must remain usable for --grade.
      await mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
      await writeFile(path.resolve(options.json), `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
    } else await writeEvalReport(path.resolve(options.json), document);
    process.stdout.write(`Wrote ${options.json}\n`);
  }
  process.exitCode = results.every(result => result.success) ? 0 : 1;
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`[eval] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
