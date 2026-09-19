import { formatVerificationReport, type VerificationReport } from "../verify/evidence";
import type { ProjectCommand } from "../project/model";

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
  return status === "incomplete" ? 2 : status && status !== "pass" ? 1 : 0;
}

export function formatTaskResult(task: TaskResult): string {
  const report = task.verification;
  const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  const edits = task.observedEdits?.length ? `; observed edits: ${task.observedEdits.map(safe).join(", ")}` : "";
  const possible = task.possibleMutations ? "; possible tool writes (scope unknown)" : "";
  const checks = task.observedChecks?.length ? `; shell check observations: ${task.observedChecks.map(({ name, toolStatus }) => `${name}:${toolStatus}`).join(", ")} (diagnostics only)` : "";
  const evidence = report ? formatVerificationReport(report) : "no Casper verification recorded.";
  return `[task] Execution ${task.execution}${edits}${possible}${checks}; ${evidence}`;
}
