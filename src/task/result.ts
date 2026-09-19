import type { VerificationReport } from "../verify/evidence";
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
  const evidence = !report ? "no Casper verification recorded"
    : report.status === "pass" ? `selected checks passed: ${report.results.map(({ name }) => name).join(", ")}; requested behavior is not independently certified`
    : `verification ${report.status}; see check results above`;
  const freshness = report?.results.some((result) => result.freshness === "unavailable") ? "; filesystem freshness unavailable" : "";
  return `[task] Execution ${task.execution}${edits}${possible}${checks}; ${evidence}${freshness}.`;
}
