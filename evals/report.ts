import type { EvalRunResult, EvalTaskSummary } from "./runner";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function failures(result: EvalRunResult): string {
  const reasons = [...result.acceptance.failures];
  if (result.modelCalls === 0) reasons.unshift("no model response was recorded");
  if (result.runtimeErrors.length) reasons.unshift(`runtime error: ${result.runtimeErrors.join(" | ")}`);
  const { verification } = result;
  if (verification.status === "unavailable") reasons.unshift(verification.unavailable ?? "verification unavailable");
  else if (verification.status !== verification.expected) {
    reasons.unshift(verification.expected === "fail"
      ? "verification passed, but this task expects it to stay failing (a rule was broken to make it pass)"
      : `verification ${verification.checks.filter((check) => check.status === "fail").map((check) => `${check.name} (exit ${check.exitCode})`).join(", ")} failed`);
  }
  if (result.execution !== "completed") reasons.unshift(`execution ${result.execution}${result.error ? `: ${result.error}` : ""}`);
  return reasons.join("; ") || "none";
}

/** One line per attempt; every number comes from the run, never from a self-report, and host
 * observations are labelled separately from runtime metrics. */
export function formatEvalResult(result: EvalRunResult): string {
  const touched = result.filesAdded.length + result.filesModified.length + result.filesRemoved.length;
  const tokens = result.tokens ? `${result.tokens.total}` : "n/a";
  const required = result.interventions.filter(entry => entry.kind === "required").length;
  const rescue = result.interventions.filter(entry => entry.kind === "rescue").length;
  const verify = result.verification.expected === "fail" ? `${result.verification.status}*` : result.verification.status;
  return `${result.outcome} ${pad(result.taskId, 28)} ${pad(seconds(result.wallClockMs), 7)}`
    + ` calls ${pad(String(result.modelCalls), 3)} tokens ${pad(tokens, 7)} files ${pad(String(touched), 3)}`
    + ` repairs ${pad(String(result.repairAttempts ?? "n/a"), 3)} self ${pad(result.selfVerification ?? "none", 10)}`
    + ` required ${required} rescue ${rescue} source ${result.evidenceSource}`
    + ` verify ${pad(verify, 5)} attempt ${result.attemptId} :: ${failures(result)}`;
}

/** One line per task over its repeated runs: pass rate, wall-clock spread, median tokens. */
export function formatEvalSummary(summary: EvalTaskSummary): string {
  const { wallClockMs: wall } = summary;
  const reasons = [...new Set(summary.runs.filter((run) => !run.success).map(failures))];
  return `${summary.success ? "PASS" : "FAIL"} ${pad(`${summary.passed}/${summary.total}`, 5)} ${pad(summary.taskId, 28)}`
    + ` wall ${pad(`${seconds(wall.median)} (${seconds(wall.min)}–${seconds(wall.max)})`, 22)}`
    + ` tokens ${pad(summary.tokensMedian === null ? "n/a" : String(summary.tokensMedian), 7)} :: ${reasons.join(" | ") || "none"}`;
}

export function formatEvalReport(summaries: readonly EvalTaskSummary[]): string {
  if (!summaries.length) return "No evaluation tasks ran.\n";
  const repeated = summaries.some((summary) => summary.total > 1);
  const lines = summaries.map((summary) => repeated ? formatEvalSummary(summary) : formatEvalResult(summary.runs[0]!));
  const runs = summaries.flatMap((summary) => summary.runs);
  const passedTasks = summaries.filter((summary) => summary.success).length;
  const passedRuns = runs.filter((run) => run.success).length;
  const unassisted = runs.filter((run) => run.outcome === "accepted-without-rescue").length;
  const rescued = runs.filter((run) => run.outcome === "accepted-with-rescue").length;
  const calls = runs.reduce((sum, run) => sum + run.modelCalls, 0);
  const wall = runs.reduce((sum, run) => sum + run.wallClockMs, 0);
  const expectedFail = runs.some((run) => run.verification.expected === "fail");
  return `${lines.join("\n")}\n\n${passedTasks}/${summaries.length} tasks succeeded`
    + `${repeated ? ` (${passedRuns}/${runs.length} runs; a task succeeds only when every run does)` : ""}`
    + `; ${passedRuns} attempts accepted (${unassisted} without rescue, ${rescued} with rescue); ${calls} model responses; ${seconds(wall)} task wall clock.\n`
    + "Task success requires the independent verification command and every declared acceptance predicate; "
    + "self-reported verification is recorded separately and is not acceptance.\n"
    + (expectedFail ? "verify fail*: the task expects its check to stay red; a green check there means a rule was broken.\n" : "");
}
