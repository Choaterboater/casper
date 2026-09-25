import { formatVerificationReport, type VerificationReport, type VerificationResult } from "../verify/evidence";
import type { ProjectCommand } from "../project/model";
import type { BrowserReport } from "../browser/scenario";
import type { AutoCheckSkip, VerificationMode } from "../verify/mode";
import type { ChangeProof } from "../verify/proof";
import type { RequirementsReview } from "./review";

/** Tool-reported diagnostics, not process exit evidence or a reusable check pass. */
export interface ObservedCheck {
  name: ProjectCommand;
  command: string;
  toolStatus: "success" | "error";
  output: string;
  truncated: boolean;
}

/** Model use by the main conversation during one task, repair prompts included. */
export interface TaskUsage {
  /** Model responses (turns). */
  turns: number;
  /** Totals of what the provider reported per response. Null when a response had no report or the
   * task also made model calls Casper does not total (a delegated subagent, automatic effort's
   * classifier): unknown, never an undercount. The cost is a catalog estimate, never an invoice. */
  tokens: number | null;
  estimatedCost: number | null;
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
  /** The verification mode this task ran under. */
  verificationMode?: VerificationMode;
  /** Why auto mode ran no check after the model turn. */
  autoSkipped?: AutoCheckSkip;
  /** `--max-turns` stopped the model after this many turns, before it finished. */
  turnLimit?: number;
  usage?: TaskUsage;
  /** Whether the tests fail without the change and pass with it (code changes in auto
   * mode). An unproven change is not verified: the passing checks do not exercise it. */
  proof?: ChangeProof;
  /** The model's requirements checklist (its own claim). Admitted open items make the change not verified. */
  review?: RequirementsReview;
}

/** What a run proved, in the words scripts match on. */
export type TaskOutcome = "verified" | "failed" | "incomplete" | "not_verified" | "unchanged" | "cancelled";

/** Failure dominates incompleteness; a pass counts only while its inputs are unchanged. */
export function taskOutcome(report?: VerificationReport, task?: TaskResult): TaskOutcome {
  if (task?.execution === "cancelled") return "cancelled";
  if (task?.execution === "failed") return "failed";
  // Cut short by --max-turns: whatever was checked covers unfinished work.
  if (task?.turnLimit !== undefined) return "incomplete";
  const verification = task?.verification ?? report;
  const status = verification?.status;
  if (status === "fail" || status === "blocked" || task?.browser?.status === "fail") return "failed";
  if (status === "incomplete" || task?.browser?.status === "incomplete") return "incomplete";
  if (status === "pass") {
    const stale = verification!.results.some((result) => result.status === "pass" && result.freshness === "stale");
    const admittedGaps = Boolean(task?.review && "open" in task.review && task.review.open.length);
    return stale || task?.proof?.status === "unproven" || admittedGaps ? "not_verified" : "verified";
  }
  const changed = Boolean(task?.changedPaths?.length || task?.changedDuringChecks?.length || (!task?.changedPaths && task?.possibleMutations));
  return changed || task?.autoSkipped === "no-checks" ? "not_verified" : "unchanged";
}

export interface ExitOptions {
  /** `--require-verification`: changes Casper did not verify exit 3 instead of 0. */
  requireVerification?: boolean;
}

/** 0 done, 1 failed, 2 incomplete, 3 not verified (only when required), 130 cancelled.
 * Without --require-verification, exit 0 describes completion, not fresh inputs or behavioral
 * acceptance: stale or missing evidence stays in the receipt. */
export function taskExitCode(report?: VerificationReport, task?: TaskResult, options: ExitOptions = {}): number {
  switch (taskOutcome(report, task)) {
    case "cancelled": return 130;
    case "failed": return 1;
    case "incomplete": return 2;
    case "not_verified":
      if (options.requireVerification) return 3;
      // Casper was asked to verify changed files and had nothing to run: not a pass.
      return task?.autoSkipped === "no-checks" ? 2 : 0;
    default: return 0;
  }
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
  if (task.proof) lines.push(receiptLine("proof", proofLine(task.proof, safe)));
  if (task.review) lines.push(receiptLine("review", reviewLine(task.review, safe)));
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

export interface ReceiptOptions {
  /** Where the next command is typed: a slash command in a session, or a casper invocation. */
  surface?: "interactive" | "one-shot";
}

/** The default, plain-language receipt: what changed, what Casper proved, and what to do next.
 * The evidence-level form stays in formatTaskResult (/receipt, --verbose). */
export function formatReceipt(task: TaskResult, options: ReceiptOptions = {}): string {
  const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  const slash = (command: string) => options.surface === "one-shot" ? `casper "${command}"` : command;
  const lines: string[] = [];
  if (task.execution !== "completed") {
    lines.push(`✗ Stopped: ${task.execution === "cancelled" ? "cancelled" : "the model run failed"} — changes already made are kept`);
  } else if (task.turnLimit !== undefined) {
    lines.push(`✗ Stopped after ${task.turnLimit} ${task.turnLimit === 1 ? "turn" : "turns"} (--max-turns) — changes so far are kept; ${options.surface === "one-shot" ? "casper --continue" : "send another request"} to go on`);
  }

  if (task.changedPaths?.length) lines.push(`✓ Changed ${pathList(task.changedPaths, safe)}`);
  else if (task.changedPaths && task.autoSkipped === "no-changes" && !task.verification) lines.push("• No files changed, so Casper ran no checks");
  else if (task.changedPaths) lines.push("• No files changed");
  else if (task.possibleMutations) lines.push("• Changes unknown — Casper could not compare the workspace");

  const report = task.verification;
  if (report?.repairAttempts) lines.push(`↻ Casper tried ${report.repairAttempts} ${report.repairAttempts === 1 ? "repair" : "repairs"}`);
  for (const result of report?.results ?? []) lines.push(checkLine(result, safe, slash));
  if (report?.status === "blocked" && report.reason) lines.push(`✗ Checks stopped — ${safe(report.reason).replace(/\.$/, "")}`);

  const recorded = new Set(report?.results.map((result) => result.name));
  for (const observed of task.observedChecks ?? []) {
    if (recorded.has(observed.name)) continue;
    lines.push(`• Not verified — ${observed.name} ran via bash only (${safe(observed.command)}: ${observed.toolStatus === "success" ? "passed" : "failed"}). Run ${slash(`/verify ${observed.name}`)} to record a check.`);
  }

  if (task.proof) lines.push(proofLine(task.proof, safe));
  if (task.review) lines.push(reviewLine(task.review, safe));
  if (task.changedDuringChecks?.length) lines.push(`• Changed while checking: ${pathList(task.changedDuringChecks, safe, false)}`);

  const changed = Boolean(task.changedPaths?.length || (!task.changedPaths && task.possibleMutations));
  if (!report && !task.observedChecks?.length && task.execution === "completed") {
    if (task.autoSkipped === "no-checks") lines.push("• Not verified — no checks configured. Add verify.test to .casper/project.yaml.");
    else if (task.autoSkipped === "not-covered") lines.push("• Not verified — no configured check covers the changed files.");
    else if (changed && task.verificationMode === "off") {
      lines.push(`• Not verified — checks are off for this run. ${options.surface === "one-shot" ? "Run casper --verify to have Casper check." : "Run /verify to check these changes."}`);
    } else if (changed && task.verificationMode === "offer") lines.push(`• Not verified — run ${slash("/verify")} to check these changes.`);
  }

  if (task.browser) {
    const failed = task.browser.checks.filter((check) => check.status === "fail").map((check) => safe(check.name));
    lines.push(task.browser.status === "pass" ? `✓ Browser checks passed (${task.browser.checks.length})`
      : task.browser.status === "fail" ? `✗ Browser checks failed: ${failed.join(", ")}` : "• Browser checks incomplete");
  }
  return lines.join("\n");
}

function reviewLine(review: RequirementsReview, safe: (text: string) => string): string {
  if ("missing" in review) return "• The model's review returned no checklist";
  if (review.open.length) return `⚠ The model's review says not done: ${review.open.map(safe).join("; ")}`;
  return `• The model's review: all ${review.done.length} requirements covered (its own claim, not checked by Casper)`;
}

function proofLine(proof: ChangeProof, safe: (text: string) => string): string {
  if (proof.status === "proven") return `✓ Proven: ${proof.check} fails without this change and passes with it`;
  if (proof.status === "unproven") {
    return `⚠ Not proven: ${proof.check} passes without this change too${proof.testsChanged ? "; the changed tests do not check it" : ", and no test was added or changed"}`;
  }
  return `• Not proven — ${safe(proof.reason).replace(/\.$/, "")}`;
}

function checkLine(result: VerificationResult, safe: (text: string) => string, slash: (command: string) => string): string {
  const name = result.name;
  if (result.status === "skip") {
    return result.command ? `• Not verified — ${name} was skipped.` : `• Not verified — ${name} has no command. Add verify.${name} to .casper/project.yaml.`;
  }
  if (result.status === "pass") {
    if (result.freshness === "stale") return `• Not verified — stale: files changed after the last passing ${name}. Run ${slash(`/verify ${name}`)}.`;
    return `✓ Verified by Casper: ${name} passed (${result.command ? `${safe(result.command)}, ` : ""}${duration(result.durationMs)})`;
  }
  const timeout = /^Timed out after (\d+)ms$/.exec(result.reason ?? "");
  const why = typeof result.exitCode === "number" ? `exit ${result.exitCode}`
    : timeout ? `timed out after ${duration(Number(timeout[1]))}`
    : result.reason ? safe(result.reason).replace(/\.$/, "").toLowerCase()
    : result.signal ? `stopped by ${safe(result.signal)}` : "no exit status";
  return `✗ Verified by Casper: ${name} failed (${why}) — log above; ${slash(`/verify repair ${name}`)} to fix`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function pathList(paths: string[], safe: (text: string) => string, count = true): string {
  const shown = paths.slice(0, RECEIPT_PATH_LIMIT).map(safe).join(", ");
  const more = paths.length > RECEIPT_PATH_LIMIT ? ` … +${paths.length - RECEIPT_PATH_LIMIT} more` : "";
  return `${count ? `${paths.length} ${paths.length === 1 ? "file" : "files"}: ` : ""}${shown}${more}`;
}
