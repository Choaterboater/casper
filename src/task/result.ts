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
  const lines = [`[task] Execution ${task.execution}`];

  if (task.observedEdits?.length) lines.push(receiptLine("tool edits", task.observedEdits.map(safe).join(", ")));
  if (task.changedPaths) lines.push(receiptLine("changes", formatChangedPaths(task.changedPaths, safe)));
  else if (task.possibleMutations) lines.push(receiptLine("changes", "unknown (workspace snapshot failed)"));
  if (task.changedDuringChecks?.length) lines.push(receiptLine("check edits", formatChangedPaths(task.changedDuringChecks, safe)));
  if (task.observedChecks?.length) {
    lines.push(receiptLine("shell", `${task.observedChecks.map(({ name, toolStatus }) => `${name}:${toolStatus}`).join(", ")} (diagnostics only)`));
  }

  lines.push(receiptLine("verification", report ? formatVerificationReport(report, { compact: true }) : "no Casper verification recorded."));
  if (task.browser) {
    lines.push(receiptLine("browser", `assertions ${task.browser.status}: ${task.browser.checks.map(check => `${safe(check.name)}:${check.status}, inputs ${check.freshness}, baseline ${check.baseline}`).join("; ")}. Declared local scope only; server build/external state and overall acceptance not certified.`));
  }
  return lines.join("\n");
}

function receiptLine(label: string, value: string): string {
  return `       ${label.padEnd(12)} ${value}`;
}

function formatChangedPaths(paths: string[], safe: (text: string) => string): string {
  if (!paths.length) return "no files changed";
  const shown = paths.slice(0, RECEIPT_PATH_LIMIT).map(safe).join(", ");
  const more = paths.length > RECEIPT_PATH_LIMIT ? ` … +${paths.length - RECEIPT_PATH_LIMIT} more` : "";
  return `${paths.length} ${paths.length === 1 ? "file" : "files"} changed: ${shown}${more}`;
}
