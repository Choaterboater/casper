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
  /** Native edit/write paths the runtime reported; may lie outside the workspace root. */
  observedEdits?: string[];
  /** Workspace-relative paths whose content identity differed between the snapshots taken before
   * the model turn and right after it (added, modified or removed). Undefined when a snapshot
   * failed or was skipped. */
  changedPaths?: string[];
  /** Paths that changed after the model turn, while Casper's own checks and repair ran. Repair
   * edits are model work too, but they belong to the verification round, not the request. */
  changedDuringChecks?: string[];
  /** A mutation-capable tool ran but no workspace snapshot could confirm or refute writes. */
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

/** More paths than this are summarized; the full list stays in the result. */
const RECEIPT_PATH_LIMIT = 8;

export function formatTaskResult(task: TaskResult): string {
  const report = task.verification;
  const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  const edits = task.observedEdits?.length ? `; observed edits: ${task.observedEdits.map(safe).join(", ")}` : "";
  const changes = task.changedPaths ? `; ${formatChangedPaths(task.changedPaths, safe)}` : task.possibleMutations ? "; changes unknown (workspace snapshot failed)" : "";
  const during = task.changedDuringChecks?.length ? `; during checks/repair: ${formatChangedPaths(task.changedDuringChecks, safe)}` : "";
  const checks = task.observedChecks?.length ? `; shell check observations: ${task.observedChecks.map(({ name, toolStatus }) => `${name}:${toolStatus}`).join(", ")} (diagnostics only)` : "";
  const evidence = report ? formatVerificationReport(report) : "no Casper verification recorded.";
  const browser = task.browser ? ` Browser assertions ${task.browser.status}: ${task.browser.checks.map(check => `${safe(check.name)}:${check.status}, inputs ${check.freshness}, baseline ${check.baseline}`).join("; ")}. Declared local scope only; server build/external state and overall acceptance not certified.` : "";
  return `[task] Execution ${task.execution}${edits}${changes}${during}${checks}; ${evidence}${browser}`;
}

function formatChangedPaths(paths: string[], safe: (text: string) => string): string {
  if (!paths.length) return "no files changed";
  const shown = paths.slice(0, RECEIPT_PATH_LIMIT).map(safe).join(", ");
  const more = paths.length > RECEIPT_PATH_LIMIT ? ` … +${paths.length - RECEIPT_PATH_LIMIT} more` : "";
  return `${paths.length} file(s) changed: ${shown}${more}`;
}
