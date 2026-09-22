#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatEvalReport, formatEvalResult } from "../evals/report";
import { resolveEvalModel, runEvalTask, summarizeEvalRuns, type EvalModel, type EvalRunResult, type EvalTaskSummary } from "../evals/runner";
import { EVAL_TASKS, findEvalTask } from "../evals/tasks";

const USAGE = `Usage: bun tools/eval.ts [options]

Runs Casper's evaluation tasks against fixture repositories and records measured
results (task success, verification success, model responses, files touched,
repair attempts, tokens, wall clock).

Options:
  --task <id>        Run one task (repeatable). Default: every task.
  --repeat <n>       Run each selected task n times (1..20) on fresh work directories
                     and temporary homes; report pass rate, median/min/max wall clock
                     and median tokens per task. Default: 1.
  --model <ref>      provider/model-id to use for this run's conversations only. Resolved
                     against Casper's model catalog before any task runs; the user's
                     saved default (~/.casper/settings.json) is never written.
  --json <path>      Write the raw results as JSON ({ ranAt, model, repeat, results[] },
                     each result carrying runs[] and the per-task aggregate).
  --timeout <sec>    Independent verification timeout per check. Default: 120.
  --keep             Keep each prepared work directory for inspection.
  --no-auto-verify   Do not exercise Casper's own verification/repair loop.
  --list             List task ids and exit.
  --help             Show this text.

The run uses Casper's configured provider through its own runtime, so model
credentials and any provider billing are the user's. Casper state (sessions,
memory, skills, MCP/LSP/reference configuration) is isolated to a temporary home
so runs are comparable and ambient configuration cannot join them.`;

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
}

function parseArguments(args: readonly string[]): EvalOptions {
  const options: EvalOptions = { help: false, list: false, selected: [], repeat: 1, timeoutSeconds: 120, keep: false, autoVerify: true };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return { ...options, help: true };
    if (argument === "--list") return { ...options, list: true };
    if (argument === "--keep") { options.keep = true; continue; }
    if (argument === "--no-auto-verify") { options.autoVerify = false; continue; }
    if (argument === "--task" || argument === "--json" || argument === "--timeout" || argument === "--repeat" || argument === "--model") {
      const value = args[++index];
      if (!value) throw new Error(`${argument} needs a value`);
      if (argument === "--task") options.selected.push(value);
      else if (argument === "--json") options.json = value;
      else if (argument === "--model") options.model = value;
      else if (argument === "--repeat") {
        const count = Number(value);
        if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("--repeat must be an integer between 1 and 20");
        options.repeat = count;
      } else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) throw new Error("--timeout must be between 1 and 3600 seconds");
        options.timeoutSeconds = seconds;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
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
    return;
  }
  const repoRoot = path.resolve(import.meta.dir, "..");
  const tasks = options.selected.length
    ? options.selected.map((id) => {
      const task = findEvalTask(id);
      if (!task) throw new Error(`Unknown task: ${id}`);
      return task;
    })
    : EVAL_TASKS;
  // Fail on an unknown model or missing credentials before a single fixture is prepared.
  const model = options.model ? await resolveEvalModel(options.model) : undefined;

  process.stdout.write(`${tasks.length} task(s)${options.repeat > 1 ? ` x ${options.repeat} runs` : ""}; model ${model ? `${model.provider}/${model.id} (--model, this run only)` : "Casper default"}; `
    + "Casper state isolated to a temporary home; provider billing applies to model calls.\n\n");
  const summaries: EvalTaskSummary[] = [];
  for (const task of tasks) {
    const runs: EvalRunResult[] = [];
    for (let run = 1; run <= options.repeat; run++) {
      const result = await runEvalTask(task, {
        repoRoot, model, keepWorkdir: options.keep, autoVerify: options.autoVerify, verifyTimeoutMs: options.timeoutSeconds * 1000,
      });
      runs.push(result);
      process.stdout.write(`${options.repeat > 1 ? `[${run}/${options.repeat}] ` : ""}${formatEvalResult(result)}\n`);
    }
    summaries.push(summarizeEvalRuns(task, runs));
  }
  process.stdout.write(`\n${formatEvalReport(summaries)}`);
  if (options.json) {
    await mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
    const report = { ranAt: new Date().toISOString(), model: observedModel(model, summaries), repeat: options.repeat, results: summaries };
    await writeFile(path.resolve(options.json), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Wrote ${options.json}\n`);
  }
  process.exitCode = summaries.every((summary) => summary.success) ? 0 : 1;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[eval] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
