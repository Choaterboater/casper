#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatEvalReport, formatEvalResult } from "../evals/report";
import { runEvalTask, type EvalRunResult } from "../evals/runner";
import { EVAL_TASKS, findEvalTask } from "../evals/tasks";

const USAGE = `Usage: bun tools/eval.ts [options]

Runs Casper's evaluation tasks against fixture repositories and records measured
results (task success, verification success, model responses, files touched,
repair attempts, tokens, wall clock).

Options:
  --task <id>        Run one task (repeatable). Default: every task.
  --json <path>      Write the raw results as JSON.
  --timeout <sec>    Independent verification timeout per task. Default: 120.
  --keep             Keep each prepared work directory for inspection.
  --no-auto-verify   Do not exercise Casper's own verification/repair loop.
  --list             List task ids and exit.
  --help             Show this text.

The run uses Casper's configured provider through its own runtime, so model
credentials and any provider billing are the user's. Casper state (sessions,
memory, skills, MCP/LSP/reference configuration) is isolated to a temporary home
so runs are comparable and ambient configuration cannot join them.`;

function parseArguments(args: readonly string[]) {
  const selected: string[] = [];
  let json: string | undefined;
  let timeoutSeconds = 120;
  let keep = false;
  let autoVerify = true;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return { help: true, selected, json, timeoutSeconds, keep, autoVerify, list: false };
    if (argument === "--list") return { list: true, help: false, selected, json, timeoutSeconds, keep, autoVerify };
    if (argument === "--keep") { keep = true; continue; }
    if (argument === "--no-auto-verify") { autoVerify = false; continue; }
    if (argument === "--task" || argument === "--json" || argument === "--timeout") {
      const value = args[++index];
      if (!value) throw new Error(`${argument} needs a value`);
      if (argument === "--task") selected.push(value);
      else if (argument === "--json") json = value;
      else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) throw new Error("--timeout must be between 1 and 3600 seconds");
        timeoutSeconds = seconds;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { help: false, list: false, selected, json, timeoutSeconds, keep, autoVerify };
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

  process.stdout.write(`${tasks.length} task(s); Casper state isolated to a temporary home; provider billing applies to model calls.\n\n`);
  const results: EvalRunResult[] = [];
  for (const task of tasks) {
    const result = await runEvalTask(task, {
      repoRoot, keepWorkdir: options.keep, autoVerify: options.autoVerify, verifyTimeoutMs: options.timeoutSeconds * 1000,
    });
    results.push(result);
    process.stdout.write(`${formatEvalResult(result)}\n`);
  }
  process.stdout.write(`\n${formatEvalReport(results)}`);
  if (options.json) {
    await mkdir(path.dirname(path.resolve(options.json)), { recursive: true });
    await writeFile(path.resolve(options.json), `${JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2)}\n`);
    process.stdout.write(`Wrote ${options.json}\n`);
  }
  process.exitCode = results.every((result) => result.success) ? 0 : 1;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`[eval] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
