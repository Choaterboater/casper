import type { EvalRunResult } from "./runner";

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function failures(result: EvalRunResult): string {
  const reasons = [...result.acceptance.failures];
  if (result.modelCalls === 0) reasons.unshift("no model response was recorded");
  if (result.runtimeErrors.length) reasons.unshift(`runtime error: ${result.runtimeErrors.join(" | ")}`);
  if (result.verification.status !== "pass") reasons.unshift(`verification ${result.verification.name} failed (exit ${result.verification.exitCode})`);
  if (result.execution !== "completed") reasons.unshift(`execution ${result.execution}${result.error ? `: ${result.error}` : ""}`);
  return reasons.join("; ") || "none";
}

/** One line per task; every number comes from the run, never from a self-report. */
export function formatEvalResult(result: EvalRunResult): string {
  const touched = result.filesAdded.length + result.filesModified.length + result.filesRemoved.length;
  const tokens = result.tokens ? `${result.tokens.total}` : "n/a";
  return `${result.success ? "PASS" : "FAIL"} ${pad(result.taskId, 28)} ${pad(`${(result.wallClockMs / 1000).toFixed(1)}s`, 7)}`
    + ` calls ${pad(String(result.modelCalls), 3)} tokens ${pad(tokens, 7)} files ${pad(String(touched), 3)}`
    + ` repairs ${pad(String(result.repairAttempts ?? 0), 2)} self ${pad(result.selfVerification ?? "none", 10)}`
    + ` verify ${pad(result.verification.status, 4)} :: ${failures(result)}`;
}

export function formatEvalReport(results: readonly EvalRunResult[]): string {
  if (!results.length) return "No evaluation tasks ran.\n";
  const passed = results.filter((result) => result.success).length;
  const lines = results.map(formatEvalResult);
  const calls = results.reduce((sum, result) => sum + result.modelCalls, 0);
  const seconds = results.reduce((sum, result) => sum + result.wallClockMs, 0) / 1000;
  return `${lines.join("\n")}\n\n${passed}/${results.length} tasks succeeded; ${calls} model responses; ${seconds.toFixed(1)}s wall clock.\n`
    + "Task success requires the independent verification command and every declared acceptance predicate; "
    + "self-reported verification is recorded separately and is not acceptance.\n";
}
