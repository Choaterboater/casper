#!/usr/bin/env bun

import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatEvalReport, formatEvalResult } from "../evals/report";
import { gradePreparedEval, prepareEvalTask, resolveEvalModel, runEvalTask, summarizeEvalRuns } from "../evals/runner";
import type { EvalModel, EvalRunResult, EvalTaskSummary } from "../evals/runner";
import { EVAL_TASKS, findEvalTask } from "../evals/tasks";
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
}

function parseArguments(args: readonly string[]): EvalOptions {
  const options: EvalOptions = {
    help: false, list: false, selected: [], repeat: 1, timeoutSeconds: 120, keep: false, autoVerify: true, prepare: false,
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    if (argument === "--list") { options.list = true; continue; }
    if (argument === "--keep") { options.keep = true; continue; }
    if (argument === "--prepare") { options.prepare = true; continue; }
    if (argument === "--no-auto-verify") { options.autoVerify = false; continue; }
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
  if (options.scenario && (!options.prepare || options.selected.length)) throw new Error("--scenario requires --prepare and cannot use --task");
  if (Boolean(options.grade) !== Boolean(options.observation)) throw new Error("--grade and --observation must be used together");
  if (options.grade && (options.prepare || options.selected.length || options.scenario)) throw new Error("--grade cannot select or prepare tasks");
  if ((options.prepare || options.grade) && (options.keep || !options.autoVerify || options.repeat > 1 || options.model)) {
    throw new Error("--keep, --no-auto-verify, --repeat and --model apply only to one-shot runs");
  }
  return options;
}

/** The requested model, or the one every run agreed on; null when runs disagree or reported none. */
function observedModel(requested: EvalModel | undefined, summaries: readonly EvalTaskSummary[]): string | null {
  if (requested) return `${requested.provider}/${requested.id}`;
  const models = new Set(summaries.flatMap((summary) => summary.runs.map((run) => run.model)));
  return models.size === 1 ? [...models][0]! : null;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { process.stdout.write(`${USAGE}\n`); return; }
  if (options.list) {
    for (const task of EVAL_TASKS) process.stdout.write(`${task.id}  (${task.fixture}${task.setup ? ` + ${task.setup}` : ""})\n`);
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
    await mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
    await writeFile(path.resolve(options.json), `${JSON.stringify(document, null, 2)}\n`, { flag: "wx" });
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
