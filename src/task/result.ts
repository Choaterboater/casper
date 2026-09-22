import { formatVerificationReport, type VerificationReport } from "../verify/evidence";
import type { ProjectCommand } from "../project/model";
import type { BrowserReport } from "../browser/scenario";

/** Tool-reported diagnostics, not process exit evidence or a reusable check pass. */
export interface ObservedCheck {
  name: ProjectCommand;
  command: string;
  toolStatus: "success" | "error";
  output: string;
  truncated: boolean;
}

/** Execution completion is not behavioral acceptance or proof of correctness. */
export interface TaskResult {
  execution: "completed" | "failed" | "cancelled";
  verification?: VerificationReport;
  browser?: BrowserReport;
  /** Bounded observations from the runtime; shell commands may only be known as possible changes. */
  observedEdits?: string[];
  possibleMutations?: boolean;
  observedChecks?: ObservedCheck[];
}

/** Exit 0 describes command execution (or unverified task completion), not fresh
 * inputs or behavioral acceptance. Stale/unknown evidence stays in the receipt. */
export function taskExitCode(report?: VerificationReport, task?: TaskResult): number {
  if (task?.execution === "cancelled") return 130;
  if (task?.execution === "failed") return 1;
  const status = (task?.verification ?? report)?.status;
  if (status && status !== "pass") return status === "incomplete" ? 2 : 1;
  if (task?.browser?.status === "fail") return 1;
  if (task?.browser?.status === "incomplete") return 2;
  return 0;
}

export function formatTaskResult(task: TaskResult): string {
  const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  const lines = [
    `Execution ${task.execution}`,
    "Completion describes execution, not correctness or acceptance.",
    "",
    "Observed edits",
    ...(task.observedEdits?.length ? task.observedEdits.map(path => `- ${safe(path)}`) : ["No file edits were observed; this is not proof of an unchanged workspace."]),
    ...(task.possibleMutations ? ["Tools may also have written files; that scope is unknown."] : []),
    "",
    "Checks",
    task.verification ? formatVerificationReport(task.verification) : "No Casper verification recorded.",
    ...(!task.verification ? ["", "Freshness and scope", "No scoped command-check evidence recorded."] : []),
  ];
  if (task.observedChecks?.length) lines.push(
    "",
    "Shell observations (diagnostics only)",
    ...task.observedChecks.map(check => [
      `${check.name}: tool ${check.toolStatus === "success" ? "completed" : "failed"}; not a verified check outcome`,
      `Command: ${safe(check.command)}`,
      ...(check.truncated ? ["Diagnostic output was truncated at capture."] : []),
    ].join("\n")),
  );
  if (task.browser) lines.push(
    "",
    `Browser assertions: ${task.browser.status}`,
    ...task.browser.checks.map(check => [
      `${safe(check.name)}: ${check.status}; baseline ${check.baseline}`,
      `Inputs: ${check.freshness}`,
      `Scope: ${check.scope ? safe(JSON.stringify(check.scope)) : "undeclared"}`,
      ...(check.reason ? [`Reason: ${safe(check.reason)}`] : []),
    ].join("\n")),
    "Declared local scope only; server build/external state and overall acceptance are not certified.",
    ...(task.browser.guidance ? [safe(task.browser.guidance)] : []),
  );
  if (!task.verification) lines.push("", "Remaining uncertainty", "Current file correctness and requested behavior are not independently certified. Human acceptance is not inferred.");
  return lines.join("\n");
}
