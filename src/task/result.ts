import { formatDuration, formatVerificationReport, reportText, type VerificationReport, type VerificationResult } from "../verify/evidence";
import { isBuiltinCheck } from "../verify/named";
import { DRY_RUN_LABEL } from "../network/checks";
import type { ProjectCommand } from "../project/model";
import type { BrowserReport } from "../browser/scenario";
import type { ServiceState } from "../services/manager";
import type { SmokeReport } from "../services/smoke";
import { formatPageReport, pageFailureSummary } from "../services/page-report";
import type { AutoCheckSkip, VerificationMode } from "../verify/mode";
import type { ChangeProof } from "../verify/proof";
import type { AcceptanceResult } from "../verify/acceptance";
import { ROUND_MAX_TURNS, type RequirementsReview } from "./review";
import { formatCost, formatLimit } from "./spend";

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
  /** The model's answer says the browser checks passed; only said when Casper's record disagrees. */
  browserClaimed?: boolean;
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
  /** Why Casper could not compare the folder ("this folder has over 20,000 files; open a project folder"), and
   * the files Casper's own edit and write tools changed meanwhile, relative to the folder when inside it. */
  snapshotFailure?: { reason: string; edited: string[] };
  observedChecks?: ObservedCheck[];
  /** The verification mode this task ran under. */
  verificationMode?: VerificationMode;
  /** Checking came from Casper's default, not a --verify flag or `verification.mode`. */
  verificationDefaulted?: true;
  /** Why auto mode ran no check after the model turn. */
  autoSkipped?: AutoCheckSkip;
  /** `--max-turns` stopped the model after this many turns, before it finished. */
  turnLimit?: number;
  /** The spend pause stopped the model (Stop here, or a run that can't ask): what the task had used, and the limit. */
  spendLimit?: { spent: number; limit: number };
  usage?: TaskUsage;
  /** Whether the tests fail without the change and pass with it (code changes in auto
   * mode). An unproven change is not verified: the passing checks do not exercise it. */
  proof?: ChangeProof;
  /** Why Casper did not compare with and without the change, when checks passed on changed files
   * without a proof (a refactor request, no test command, only non-code files changed...). */
  proofSkipped?: string;
  /** The model's requirements checklist (its own claim). Admitted open items make the change not verified. */
  review?: RequirementsReview;
  /** Tests written from the request alone and run against the change (verification.acceptance). In
   * `verdict` mode (`true`) a failure makes the change not verified; in `warn` mode it only names what
   * is unconfirmed. The check never repairs and its test file is never kept. */
  acceptance?: Omit<AcceptanceResult, "usage"> & { mode: "verdict" | "warn" };
  /** The cases the request states, listed by a separate model call before the model's turn
   * (verification.checklist) and handed to the model to test one by one. Not evidence. */
  checklist?: string[];
  /** The session's managed services at the end of the task (the origin while starting or ready). */
  services?: Array<{ name: string; origin?: string; state: ServiceState }>;
  /** A known test-runner command the model ran without error while the project had no test command: only ever
   * offered as a suggestion to remember, never check evidence. */
  testRunner?: string;
  /** Files that changed during a plan turn anyway (Casper blocks the changes it can see; this names the rest). */
  changedWhilePlanning?: string[];
  /** Repairs that ran on the user's big model: the extra try the user chose, or repair.bigModelLastTry. */
  bigModel?: { model: string; attempts: number; /** Picked for this task only, not saved as the big model. */ oneOff?: true };
  /** Casper's security tools ran for this task: counts only, never finding text. */
  security?: SecuritySummary;
  /** This task's saved receipt number (/receipt <n>), when receipts are kept. */
  receipt?: number;
  /** Why the task's changed pages were not opened, as plain receipt lines: the dev server can't start (a missing
   * install), or every changed page needs a value ("• /devices/[id] not opened: …"). Never a failure. */
  pageNotes?: string[];
  /** Whether /undo can put this task's files back, and why not. `left` names changed files Casper keeps no copy of. */
  undo?: { available: true; left?: Array<{ path: string; why: string }> } | { available: false; reason: string };
  /** Changes on other machines, read from the text of the AI's ssh and scp commands (never guessed beyond it). */
  remoteChanges?: Array<{ host: string; changes: string[] }>;
  /** Commands to other machines Casper stopped before they ran (your No, a run that can't ask, the sandbox). */
  remoteNotRun?: Array<{ host: string; commands: number }>;
  /** A secret appeared in a command the AI sent: hidden on screen, in records and here, but the AI has it. */
  secretInCommand?: true;
  /** Whether the shell sandbox held this task's shell commands and checks, and why not ("--no-sandbox"). */
  sandbox?: { held: true } | { held: false; reason: string };
  /** Folders outside the project this task wrote to after you allowed them (~/ form). Casper keeps no undo copy. */
  outsideWrites?: string[];
  /** Folders outside the project you allowed a shell command to write (~/ form): allowed, not known written. */
  outsideAllowed?: string[];
}

/** A security tools run in a receipt: how many problems, notes and checks not run, and each tool's state. */
export interface SecuritySummary {
  problems: number;
  notes: number;
  notRun: number;
  tools: Array<{ id: string; status: "ok" | "problems" | "not-run" | "not-needed" | "off" }>;
}

/** What a run proved, in the words scripts match on. */
export type TaskOutcome = "verified" | "failed" | "incomplete" | "not_verified" | "unchanged" | "cancelled";

/** Whether the checks passed on the final files. The outcome asks for more (a changed tree with a proven change), so
 * receipts and scripts that mean "the checks passed" read this (JSON `checksPassed`), not the outcome. */
export function checksPassed(report?: VerificationReport, task?: TaskResult): boolean {
  if (task?.execution === "cancelled" || task?.execution === "failed" || task?.turnLimit !== undefined || task?.spendLimit !== undefined) return false;
  if (task?.browser?.status === "fail" || task?.browser?.status === "incomplete") return false;
  const verification = task?.verification ?? report;
  if (verification?.status !== "pass") return false;
  const stale = verification.results.some((result) => result.status === "pass" && result.freshness === "stale");
  const admittedGaps = Boolean(task?.review && "open" in task.review && task.review.open.length);
  // Smoke alone verifies only with evidence: a model check that passed before the change is an observation.
  const observationsOnly = !verification.results.length && !verification.smoke?.checks.some((check) => check.evidence) && verification.pages?.status !== "pass";
  const rejected = task?.acceptance?.status === "fail" && task.acceptance.mode === "verdict";
  return !(stale || task?.proof?.status === "unproven" || admittedGaps || observationsOnly || rejected || dryRunOnly(verification));
}

/** Every pass is a lab dry run ("dry run not guaranteed"): some modules still change devices in check mode,
 * so such a pass is shown but is never grounds for Verified or Checks passed. */
function dryRunOnly(report: VerificationReport): boolean {
  const counted = report.results.filter((result) => result.kind !== "report");
  return counted.length > 0 && counted.every((result) => result.status === "pass" && result.label === DRY_RUN_LABEL);
}

/** Failure dominates incompleteness; a pass counts only while its inputs are unchanged. */
export function taskOutcome(report?: VerificationReport, task?: TaskResult): TaskOutcome {
  if (task?.execution === "cancelled") return "cancelled";
  if (task?.execution === "failed") return "failed";
  // Cut short by --max-turns: whatever was checked covers unfinished work.
  if (task?.turnLimit !== undefined || task?.spendLimit !== undefined) return "incomplete";
  const verification = task?.verification ?? report;
  const status = verification?.status;
  if (status === "fail" || status === "blocked" || task?.browser?.status === "fail") return "failed";
  if (status === "incomplete" || task?.browser?.status === "incomplete") return "incomplete";
  // Commands to another machine that Casper stopped: whatever the AI said about that machine did not happen.
  if (task?.remoteNotRun?.length) return "incomplete";
  const changed = Boolean(task?.changedPaths?.length || task?.changedDuringChecks?.length || (!task?.changedPaths && task?.possibleMutations));
  // "verified" is what the verdict line calls Verified (ADR 0001): the checks pass on changed files and a test fails
  // without the change. Checks that passed without that proof are not_verified; checksPassed still says they passed.
  if (status === "pass") {
    if (!checksPassed(report, task)) return "not_verified";
    if (!changed) return "unchanged";
    return task?.proof?.status === "proven" ? "verified" : "not_verified";
  }
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
      // Casper was asked (flag or configuration) to verify changed files and had nothing to run: not a
      // pass. Checking only by default in a project with no checks is not a failure of the run.
      return task?.autoSkipped === "no-checks" && !task.verificationDefaulted ? 2 : 0;
    default: return 0;
  }
}

/** The reason on `/verify`'s report when the folder has nothing to run: exit 2 like any unfinished check, other words. */
export const NO_CHECKS_FOUND = "no checks found";

/** "3 commands Casper stopped before they reached it": nothing the AI says about that machine happened through them. */
export const remoteNotRunText = (commands: number) => `${commands} ${commands === 1 ? "command" : "commands"} Casper stopped before ${commands === 1 ? "it" : "they"} reached it`;
/** The incomplete verdict's words when Casper stopped commands to other machines ("commands to build-server did not run");
 * the receipt's "• Not run on …" lines below it give each machine's count. */
function remoteNotRunVerdict(remotes: NonNullable<TaskResult["remoteNotRun"]>, safe: (text: string) => string): string {
  const count = remotes.reduce((sum, remote) => sum + remote.commands, 0);
  return `${count === 1 ? "a command" : "commands"} to ${remotes.map((remote) => safe(remote.host)).join(", ")} did not run`;
}

/** An ssh command whose text shows no change Casper knows: it ran there all the same. */
export const REMOTE_UNKNOWN = "Casper can't tell from the command text whether they changed anything there";

/** The receipt's line when the AI typed a secret into a command. */
export const SECRET_IN_COMMAND = "A secret appeared in a command; change it after this task.";

/** More paths than this are summarized; the full list stays in the result. */
const RECEIPT_PATH_LIMIT = 8;

export function formatTaskResult(task: TaskResult): string {
  const report = task.verification;
  const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  const lines = [`[task] Execution ${task.execution}`];
  if (task.spendLimit) lines.push(receiptLine("spend", `stopped at ${formatCost(task.spendLimit.spent)}, the ${formatLimit(task.spendLimit.limit)} limit for one task (spend.pauseAt)`));

  if (task.observedEdits?.length) lines.push(receiptLine("tool edits", task.observedEdits.map(safe).join(", ")));
  if (task.changedPaths) lines.push(receiptLine("changes", formatChangedPaths(task.changedPaths, safe)));
  else if (task.possibleMutations) lines.push(receiptLine("changes", `unknown (${task.snapshotFailure ? safe(task.snapshotFailure.reason) : "workspace snapshot failed"})`));
  if (task.changedDuringChecks?.length) lines.push(receiptLine("check edits", formatChangedPaths(task.changedDuringChecks, safe)));
  if (task.observedChecks?.length) {
    lines.push(receiptLine("shell", `${task.observedChecks.map(({ name, toolStatus }) => `${name}:${toolStatus}`).join(", ")} (diagnostics only)`));
  }

  lines.push(receiptLine("verification", report ? formatVerificationReport(report, { compact: true }) : "no Casper verification recorded."));
  if (task.proof) lines.push(receiptLine("proof", proofLine(task.proof, safe)));
  if (task.acceptance) lines.push(receiptLine("acceptance", acceptanceLine(task.acceptance, safe)));
  if (task.review) lines.push(receiptLine("review", reviewLine(task.review, safe).replace(/\n/g, "; ")));
  // The cases the task was handed; the short receipt names them only when one is not met.
  if (task.checklist?.length) {
    lines.push(receiptLine("checklist", `${task.checklist.length} ${task.checklist.length === 1 ? "case" : "cases"} from your request (handed to the model to test; not evidence)`));
    for (const item of task.checklist) lines.push(`${" ".repeat(20)}- ${safe(item)}`);
  }
  if (report?.smoke) {
    if (task.services?.length) lines.push(receiptLine("services", task.services.map((service) => `${safe(service.name)} ${service.state}${service.origin ? ` ${service.origin}` : ""}`).join("; ")));
    lines.push(receiptLine("smoke", `${report.smoke.status}: ${report.smoke.checks.map((check) => `${safe(check.name)} [${check.source}] ${safe(check.service)} ${check.request.method} ${safe(check.request.path)}: ${check.status}`
      + `${check.actual ? ` (${check.actual.status})` : ""}${check.baseline ? `, baseline ${check.baseline}${check.baselineAfterEdits ? " (after edits)" : ""}` : ""}${check.status === "pass" && !check.evidence ? ", observation only" : ""}`
      + `${check.status !== "pass" && check.reason ? ` — ${safe(check.reason)}` : ""}`).join("; ")}.${report.smoke.reason ? ` ${safe(report.smoke.reason)}` : ""}${crashNotes(report.smoke, safe).map((note) => ` ${note}.`).join("")} Model checks are the model's expectations, run by Casper.`));
  }
  if (report?.pages) lines.push(receiptLine("pages", `${report.pages.status}: ${report.pages.pages.map((page) => `${safe(page.path)} ${page.status}${page.httpStatus !== null ? ` (${page.httpStatus})` : ""}`).join("; ") || "none opened"}${report.pages.reason ? `. ${safe(report.pages.reason)}` : ""}`));
  else if (task.pageNotes?.length) lines.push(receiptLine("pages", task.pageNotes.map((note) => safe(note.replace(/^• /, ""))).join("; ")));
  if (task.bigModel) lines.push(receiptLine("big model", `${safe(task.bigModel.model)} for ${task.bigModel.attempts} ${task.bigModel.attempts === 1 ? "repair" : "repairs"}`));
  if (task.security) lines.push(receiptLine("security", securityText(task.security)));
  for (const remote of task.remoteChanges ?? []) lines.push(receiptLine(`on ${safe(remote.host)}`.slice(0, 12), remote.changes.length
    ? `${remote.changes.map(safe).join("; ")} (from the commands Casper saw)` : REMOTE_UNKNOWN));
  for (const remote of task.remoteNotRun ?? []) lines.push(receiptLine(`not on ${safe(remote.host)}`.slice(0, 12), remoteNotRunText(remote.commands)));
  if (task.secretInCommand) lines.push(receiptLine("secret", SECRET_IN_COMMAND));
  if (task.sandbox) lines.push(receiptLine("sandbox", task.sandbox.held
    ? `shell commands and checks held${labRan(report) ? `; ${LAB_OUTSIDE}` : ""}` : `not sandboxed (${safe(task.sandbox.reason)})`));
  const outside = [
    ...(task.outsideWrites?.length ? [`wrote ${task.outsideWrites.map(safe).join(", ")} (you allowed it; no undo copy)`] : []),
    ...(task.outsideAllowed?.length ? [`allowed shell writes to ${task.outsideAllowed.map(safe).join(", ")} (no undo copy)`] : []),
  ];
  if (outside.length) lines.push(receiptLine("outside", outside.join("; ")));
  if (task.undo && !(!task.undo.available && task.undo.reason === UNDO_NOTHING_CHANGED)) {
    lines.push(receiptLine("undo", task.undo.available ? `available${task.receipt ? ` (/undo ${task.receipt})` : ""}${task.undo.left?.length ? `; no copy of ${task.undo.left.map((entry) => safe(entry.path)).join(", ")}` : ""}` : `not available: ${safe(task.undo.reason)}`));
  }
  if (task.browser) {
    lines.push(receiptLine("browser", `assertions ${task.browser.status}: ${task.browser.checks.map(check => `${safe(check.name)}:${check.status}, inputs ${check.freshness}, baseline ${check.baseline}`).join("; ")}. Declared local scope only; server build/external state and overall acceptance not certified.`));
  }
  return lines.join("\n");
}

function securityText(security: SecuritySummary): string {
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return [count(security.problems, "problem"), ...(security.notes ? [count(security.notes, "note")] : []),
    ...(security.notRun ? [`${count(security.notRun, "check")} not run`] : [])].join(", ");
}

/** Lab checks log in to your devices with your own SSH keys, so they run outside the shell sandbox. */
const LAB_OUTSIDE_WHY = "they log in to your lab devices with your own keys";
const LAB_OUTSIDE = `lab checks ran outside it (${LAB_OUTSIDE_WHY})`;
function labRan(report: TaskResult["verification"]): boolean {
  return (report?.results ?? []).some((result) => result.kind === "lab" && (result.status === "pass" || result.status === "fail"));
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
  /** One-shot: the folder the task ran in, when it is not where casper was started (`--cd`), so the printed undo
   * command acts on this task's folder and never on another project's task of the same number. */
  folder?: string;
  /** This session already showed the full no-checks line: say it short, without the how-to. */
  checksHintShown?: true;
  /** Files this session already named as ones undo can't put back: not named again. /undo still names them. */
  undoNamed?: ReadonlySet<string>;
}

/** The default, plain-language receipt: what changed, what Casper proved, and what to do next.
 * The evidence-level form stays in formatTaskResult (/receipt, --verbose). */
/** The answer says a browser check passed: a sentence about checking in the browser (not "browser assets") and a pass, with no "not" or failure in it. */
export function answerClaimsBrowserPass(answer: string): boolean {
  const aboutChecking = /\bbrowser[- ](?:checks?|tests?|scenarios?|assertions?|verification|run)\b|\bin (?:a|the|an?\s\w+|headless|real) browser\b|\bbrowser (?:also )?(?:pass(?:ed|es)?|verified|confirmed|works?|worked)\b/i;
  return answer.split(/(?<=[.!?])\s+|\n+/).some((sentence) => aboutChecking.test(sentence)
    && /\b(?:pass(?:ed|es)?|succeeded|verified|confirmed|works?|worked)\b/i.test(sentence)
    && !/\b(?:not|no|never|fail(?:ed|s)?|incomplete|couldn't|can't|cannot|didn't|unable)\b|n't\b/i.test(sentence));
}

export function formatReceipt(task: TaskResult, options: ReceiptOptions = {}): string {
  const { lines, undo } = receiptParts(task, options);
  return [...lines, ...undo].join("\n");
}

/** The receipt as the terminal shows it after a task: one line when all is well ("✓ Verified · test passed ·
 * 3 files changed"), and each problem on its own short line under it. The full form stays in formatReceipt
 * (--json `text`, saved receipt summaries) and formatTaskResult (/receipt). */
export function formatShortReceipt(task: TaskResult, options: ReceiptOptions = {}): string {
  const { lines, undo, folds, short } = receiptParts(task, options);
  if (!lines.length) return undo.join("\n");
  const [verdict, ...body] = lines;
  // Repairs and "no files changed" are news only beside a pass; with a problem they keep their own line.
  const folded = (line: string) => folds.has(line) && (short !== undefined || !(line.startsWith("↻ ") || line === "• No files changed"));
  // Checks first, then the files, then repairs: "✓ Verified · test passed · 3 files changed · after 1 repair".
  const rank = (line: string) => line.startsWith("↻ ") ? 2 : line.startsWith("✓ Changed ") || line === "• No files changed" ? 1 : 0;
  const parts = body.filter(folded).sort((a, b) => rank(a) - rank(b)).map((line) => folds.get(line)!).filter(Boolean);
  // All well: one line. Otherwise the verdict says what is wrong, and what went well shares one line under it.
  // Check names stay as typed: "✓ test passed", never "Test".
  const head = short !== undefined ? [[short, ...parts].join(" · ")] : [verdict!, ...(parts.length ? [`✓ ${parts.join(" · ")}`] : [])];
  const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  // The problems come right after the verdict; the checklist's line follows them.
  return [...head, ...body.filter((line) => !folded(line)), ...checklistLines(task, safe), ...undo].join("\n");
}

/** The request's checklist on the short receipt: said only when the model's own review lists something not done
 * or the checks did not pass, so the cases are not confirmed. /receipt lists every case. The model's open items
 * come from its answer (the request and project docs), not the checklist, so they are not counted against it. */
function checklistLines(task: TaskResult, safe: (text: string) => string): string[] {
  const cases = task.checklist?.length ?? 0;
  if (!cases) return [];
  const review = task.review;
  const open = review && "open" in review ? review.open : [];
  if (open.length && !review?.incomplete) {
    return [`⚠ ${open.length} ${open.length === 1 ? "requirement" : "requirements"} not met, the model says: ${open.map(safe).join("; ")}`];
  }
  const changed = Boolean(task.changedPaths?.length || task.changedDuringChecks?.length || (!task.changedPaths && task.possibleMutations));
  if (!changed || checksPassed(task.verification, task)) return [];
  const why = task.execution !== "completed" || task.turnLimit !== undefined || task.spendLimit !== undefined ? "the task did not finish" : !task.verification ? "no checks ran"
    : task.verification.status === "pass" ? "the checks do not prove the change" : "the checks did not pass";
  return [`• ${cases} ${cases === 1 ? "case" : "cases"} from your request not confirmed: ${why} (/receipt lists them)`];
}

/** The receipt's lines (verdict first), its undo lines, and the short form's pieces: `folds` maps a line that
 * says all is well to the few words it becomes on the one-line receipt ("" drops it); `short` is the verdict
 * word when nothing is wrong. */
function receiptParts(task: TaskResult, options: ReceiptOptions): { lines: string[]; undo: string[]; folds: Map<string, string>; short?: string } {
  const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  const slash = (command: string) => options.surface === "one-shot" ? `casper "${command}"` : command;
  const lines: string[] = [];
  const folds = new Map<string, string>();
  const fold = (line: string, short: string) => { lines.push(line); folds.set(line, short); };
  if (task.changedPaths?.length) fold(`✓ Changed ${pathList(task.changedPaths, safe)}`, changedShort(task.changedPaths, safe));
  else if (task.changedPaths && task.autoSkipped === "no-changes" && !task.verification) lines.push("• No files changed, so Casper ran no checks");
  else if (task.changedPaths) fold("• No files changed", "no files changed");
  else if (task.possibleMutations) lines.push(task.snapshotFailure ? `• Changes unknown: ${safe(task.snapshotFailure.reason)}` : "• Changes unknown — Casper could not compare the workspace");
  if (!task.changedPaths && task.snapshotFailure?.edited.length) lines.push(`• Changed (seen by Casper's edit and write tools): ${pathList(task.snapshotFailure.edited, safe, false)}`);

  const report = task.verification;
  if (report?.repairAttempts) {
    const repairs = `${report.repairAttempts} ${report.repairAttempts === 1 ? "repair" : "repairs"}${task.bigModel ? ` (the last on ${task.bigModel.oneOff ? "" : "your big model "}${safe(task.bigModel.model)})` : ""}`;
    fold(`↻ Casper tried ${repairs}`, `after ${repairs}`);
  }
  for (const result of report?.results ?? []) {
    const line = checkLine(result, safe, slash, !!report?.repairAttempts);
    if (result.status === "pass" && result.freshness !== "stale" && result.kind !== "report") fold(line, `${result.name} passed${result.reused ? " earlier" : ""}${result.label ? ` (${safe(result.label)}${result.command ? ` · ${safe(result.command)}` : ""})` : ""}`);
    else lines.push(line);
  }
  if (report?.status === "blocked" && report.reason) lines.push(`✗ Checks stopped — ${safe(report.reason).replace(/\.$/, "")}`);

  const recorded = new Set(report?.results.map((result) => result.name));
  for (const observed of task.observedChecks ?? []) {
    if (recorded.has(observed.name)) continue;
    lines.push(`• Not verified — ${observed.name} ran via bash only (${safe(observed.command)}: ${observed.toolStatus === "success" ? "passed" : "failed"}). Run ${slash(`/verify ${observed.name}`)} to record a check.`);
  }

  // A strong proof is what "Verified" says; a weak one keeps its line.
  if (task.proof) {
    const line = proofLine(task.proof, safe);
    if (line.startsWith("✓ Proven:")) fold(line, ""); else lines.push(line);
  }
  if (task.acceptance) {
    const line = acceptanceLine(task.acceptance, safe);
    if (task.acceptance.status === "pass") fold(line, "tests written from the request pass"); else lines.push(line);
  }
  // The model's own "all covered" claim is not evidence: the short receipt leaves it out. A count short of its
  // total ("3 of 5") and its gaps keep their line; with a checklist the gaps become the checklist's line.
  if (task.review) {
    const line = reviewLine(task.review, safe);
    const asCases = Boolean(task.checklist?.length && !task.review.incomplete && "open" in task.review && task.review.open.length);
    if (line.startsWith("• The model's review: all ") || asCases) fold(line, ""); else lines.push(line);
  }
  if (task.changedDuringChecks?.length) lines.push(`• Changed while checking: ${pathList(task.changedDuringChecks, safe, false)}`);
  if (task.changedWhilePlanning?.length) lines.push(`• Changed while planning: ${pathList(task.changedWhilePlanning, safe, false)}`);

  const changed = Boolean(task.changedPaths?.length || (!task.changedPaths && task.possibleMutations));
  if (!report && !task.observedChecks?.length && task.execution === "completed") {
    if (task.autoSkipped === "no-checks") lines.push(options.checksHintShown ? "• Not verified — no checks set up" : NO_CHECKS_LINE);
    else if (task.autoSkipped === "not-covered") lines.push("• Not verified — no configured check covers the changed files.");
    else if (changed && task.verificationMode === "off") {
      lines.push(`• Not verified — checks are off for this run. ${options.surface === "one-shot" ? "Run casper --verify to have Casper check." : "Run /verify to check these changes."}`);
    } else if (changed && task.verificationMode === "offer") lines.push(`• Not verified — run ${slash("/verify")} to check these changes.`);
  }

  if (report?.smoke) lines.push(smokeLine(report.smoke, task.services, safe));
  else if (report?.smokeSkipped) lines.push(`• Smoke not run: ${report.smokeSkipped}`);
  // Page text is already scrubbed and cut short by the page check.
  if (report?.pages) lines.push(...formatPageReport(report.pages).flatMap((line) => line.split("\n")).map(safe));
  else if (report?.pagesSkipped) lines.push(`• Pages not checked: ${report.pagesSkipped}`);
  for (const note of task.pageNotes ?? []) lines.push(safe(note));
  if (task.security) lines.push(`• Security tools: ${securityText(task.security)} (what the tools found; not proof the code has no problems)`);
  for (const remote of task.remoteChanges ?? []) lines.push(remote.changes.length
    ? `• Changed on ${safe(remote.host)} (from the commands Casper saw): ${remote.changes.map(safe).join("; ")}`
    : `• Ran commands on ${safe(remote.host)} over ssh; ${REMOTE_UNKNOWN}`);
  for (const remote of task.remoteNotRun ?? []) lines.push(`• Not run on ${safe(remote.host)}: ${remoteNotRunText(remote.commands)}`);
  if (task.secretInCommand) lines.push(`• ${SECRET_IN_COMMAND}`);
  // Only the exception is said: a task whose shell commands and checks ran with your own permissions.
  if (task.sandbox && !task.sandbox.held) lines.push(`• Shell commands and checks were not sandboxed (${safe(task.sandbox.reason)})`);
  else if (task.sandbox && labRan(report)) lines.push(`• Lab checks ran outside the sandbox (${LAB_OUTSIDE_WHY})`);
  for (const folder of task.outsideWrites ?? []) lines.push(`• Wrote outside the project: ${safe(folder)} (you allowed it; no undo copy)`);
  for (const folder of task.outsideAllowed ?? []) lines.push(`• Allowed writes outside the project: ${safe(folder)} (no undo copy)`);
  if (task.browser) {
    const failed = task.browser.checks.filter((check) => check.status === "fail").map((check) => safe(check.name));
    // The answer may say the checks passed; the receipt is Casper's record, so it says where they differ.
    const claimed = task.browserClaimed ? " — the answer above says they passed" : "";
    if (task.browser.status === "pass") fold(`✓ Browser checks passed (${task.browser.checks.length})`, `browser checks passed (${task.browser.checks.length})`);
    else if (task.browser.status === "fail") lines.push(`✗ Browser checks failed: ${failed.join(", ")}${claimed}`);
    else {
      // Incomplete: count what passed, and name what did not finish (a check that went stale or never ran).
      const passed = task.browser.checks.filter((check) => check.status === "pass").length;
      const open = task.browser.checks.filter((check) => check.status !== "pass").map((check) => safe(check.name));
      if (passed) lines.push(`• Browser checks: ${passed} of ${task.browser.checks.length} passed; not finished: ${open.join(", ")}`);
      else lines.push(claimed ? `• Browser checks did not finish${claimed}; Casper saw no passing browser check` : "• Browser checks incomplete");
    }
  }
  const verdict = withVerdict(task, lines, options);
  return { lines: verdict.lines, undo: undoLines(task, options, safe), folds, ...(verdict.short ? { short: verdict.short } : {}) };
}

/** "changed a.ts, b.ts" for a few files, "12 files changed" past three. */
function changedShort(paths: string[], safe: (text: string) => string): string {
  return paths.length <= 3 ? `changed ${paths.map(safe).join(", ")}` : `${paths.length} files changed`;
}

/** The full no-checks line, shown once per session; later receipts say it short. */
export const NO_CHECKS_LINE = "• Not verified — no checks configured. Add verify.test to .casper/project.yaml.";

/** The undo reason when a task changed nothing: nothing to say on the receipt. */
export const UNDO_NOTHING_CHANGED = "no files changed";

/** The files undo can't put back that a receipt names: ones not named before, up to the limit. */
export function undoPathsShown(task: Pick<TaskResult, "undo">, undoNamed?: ReadonlySet<string>): string[] {
  if (!task.undo?.available) return [];
  return (task.undo.left ?? []).filter((entry) => !undoNamed?.has(entry.path)).slice(0, RECEIPT_PATH_LIMIT).map((entry) => entry.path);
}

/** The receipt's last lines about undo: what it can't put back, why it is not available, and (one-shot) the commands.
 * The interactive receipt's "Next: 1 Undo · 2 Show diff" row is printed by the app. */
function undoLines(task: TaskResult, options: ReceiptOptions, safe: (text: string) => string): string[] {
  const undo = task.undo;
  if (!undo) return [];
  if (!undo.available) return undo.reason === UNDO_NOTHING_CHANGED ? [] : [`• Undo not available: ${safe(undo.reason).replace(/\.$/, "")}`];
  const lines: string[] = [];
  const left = undo.left?.filter((entry) => !options.undoNamed?.has(entry.path)) ?? [];
  if (left.length) lines.push(`• Undo can't put back: ${left.slice(0, RECEIPT_PATH_LIMIT).map((entry) => `${safe(entry.path)} (${safe(entry.why)})`).join(", ")}${left.length > RECEIPT_PATH_LIMIT ? ` … +${left.length - RECEIPT_PATH_LIMIT} more` : ""}`);
  if (options.surface === "one-shot") {
    const cd = options.folder ? `--cd ${shellFolder(safe(options.folder))} ` : "";
    const n = task.receipt ? ` ${task.receipt}` : "";
    lines.push(`Undo: casper ${cd}/undo${n} · Diff: casper ${cd}/diff${n}`);
  }
  return lines;
}

/** Line 1 of every receipt: what the run proved, in one line. "Verified" means the checks passed on the
 * final files and a test fails without the change (ADR 0001); anything less says why. The JSON outcome
 * "verified" means exactly this line. A reason already on its own line moves up instead of repeating. */
export function receiptVerdict(task: TaskResult, options: ReceiptOptions = {}): string | undefined {
  return formatReceipt(task, options).split("\n")[0] || undefined;
}

function withVerdict(task: TaskResult, body: string[], options: ReceiptOptions): { lines: string[]; short?: string } {
  const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  const promote = (prefix: string, fallback: string): string[] => {
    const index = body.findIndex((line) => line.startsWith(prefix));
    return index < 0 ? [fallback, ...body] : [body[index]!, ...body.slice(0, index), ...body.slice(index + 1)];
  };
  const report = task.verification;
  // The verdict lines for checks that passed are the same whatever the outcome calls them: "✓ Verified" only with
  // proof, "✓ Checks passed" with nothing changed, "• Checks passed — not proven" otherwise.
  const outcome = report?.status === "pass" && checksPassed(report, task) && !["cancelled", "failed", "incomplete"].includes(taskOutcome(report, task))
    ? "passed" : taskOutcome(report, task);
  const changed = Boolean(task.changedPaths?.length || task.changedDuringChecks?.length || (!task.changedPaths && task.possibleMutations));
  const failedChecks = (report?.results ?? []).filter((result) => result.status === "fail" && result.kind !== "report")
    .map((result) => `${result.name} ${result.ended === "timeout" ? "timed out" : result.ended === "no_start" ? "could not start" : result.ended === "blocked" ? "was blocked by the sandbox" : "failed"}`);
  let lines: string[];
  let short: string | undefined;
  switch (outcome) {
    case "cancelled":
      lines = ["✗ Stopped — cancelled; changes already made are kept", ...body]; break;
    case "failed":
      if (task.execution === "failed") {
        // Casper checked the edits the model left: say how they fared, then what to do next.
        const checked = !report?.results.length ? "" : failedChecks.length ? `; on those changes ${failedChecks.join(", ")}` : "; the checks pass on those changes";
        const next = `• Next: ${options.surface === "one-shot" ? "casper --model <provider/id> \"…\" to try another model" : "/model to try another model, then ask again"}`;
        const verdict = task.changedPaths?.length === 0 && !task.possibleMutations
          ? "✗ Failed — the model run failed before changing any files" : `✗ Failed — the model run failed; changes already made are kept${checked}`;
        lines = [verdict, ...body, next];
      }
      // Only unfinished checks: the change was not tested, which is not the same as the code being wrong.
      else if (failedChecks.length && report!.results.every((result) => result.status !== "fail" || result.kind === "report" || result.ended)) {
        lines = [`✗ Not checked — ${failedChecks.join(", ")}, so the change was not tested`, ...body];
      } else if (failedChecks.length) lines = [`✗ Failed — ${failedChecks.join(", ")}`, ...body];
      else if (report?.pages?.status === "fail") lines = [`✗ Failed — ${safe(pageFailureSummary(report.pages) ?? "a page failed")}`, ...body];
      else if (report?.status === "blocked") lines = [`✗ Failed — checks stopped${report.reason ? `: ${safe(report.reason).replace(/\.$/, "").toLowerCase()}` : ""}`, ...body];
      else lines = ["✗ Failed — browser checks failed", ...body];
      break;
    case "incomplete":
      lines = [task.spendLimit !== undefined
        ? `• Incomplete — stopped at ${formatCost(task.spendLimit.spent)}, the ${formatLimit(task.spendLimit.limit)} limit for one task (spend.pauseAt); changes so far are kept; ${options.surface === "one-shot" ? "casper --continue" : "send another request"} to go on`
        : task.turnLimit !== undefined
        ? `• Incomplete — stopped after ${task.turnLimit} ${task.turnLimit === 1 ? "turn" : "turns"} (--max-turns); changes so far are kept; ${options.surface === "one-shot" ? "casper --continue" : "send another request"} to go on`
        : task.remoteNotRun?.length ? `• Incomplete — ${remoteNotRunVerdict(task.remoteNotRun, safe)}`
        : report?.reason === NO_CHECKS_FOUND && !report.results.length ? "• Not checked — no checks found in this folder"
        : "• Incomplete — not every check ran", ...body];
      break;
    case "verified":
    case "passed": {
      const proof = task.proof;
      if (proof?.status === "proven") {
        const weak = loadFailure(proof);
        lines = [weak ? "✓ Verified — the checks pass; without the change the tests could not even load"
          : "✓ Verified — the checks pass, and the tests fail without the change", ...body];
        if (!weak) short = "✓ Verified";
      } else if (!changed) { lines = [task.changedPaths ? "✓ Checks passed — no files changed" : "✓ Checks passed", ...body]; short = "✓ Checks passed"; }
      else {
        const why = proof?.status === "unavailable" ? proof.reason : task.proofSkipped ?? "Casper did not compare the tests with and without the change";
        lines = [`• Checks passed — not proven: ${safe(why).replace(/\.$/, "")}`, ...body];
      }
      break;
    }
    case "not_verified":
      lines = promote("• Not verified", `• Not verified — ${notVerifiedReason(task)}`); break;
    case "unchanged":
      lines = body.length ? promote("• No files changed", "• No files changed") : body; break;
  }
  return { lines, ...(short ? { short } : {}) };
}

function notVerifiedReason(task: TaskResult): string {
  const report = task.verification;
  if (report?.results.some((result) => result.status === "pass" && result.freshness === "stale")) return "files changed after the checks passed";
  if (task.proof?.status === "unproven") return "the tests pass without the change too";
  if (task.review && "open" in task.review && task.review.open.length) return "the model's review lists unfinished items";
  if (task.acceptance?.status === "fail" && task.acceptance.mode === "verdict") return "tests written from the request fail";
  if (report && dryRunOnly(report)) return "a dry run is not guaranteed, so its pass is not proof";
  if (report && !report.results.length) return "only observations ran, no checks";
  if (!task.changedPaths && task.possibleMutations) return "Casper could not compare the workspace";
  return "Casper ran no checks";
}

/** One line: each checked service's address, the smoke tally, what failed, and the model-declared checks with their baselines. */
/** "api restarted after crash (exit 1)" for each crash the smoke run reported. */
function crashNotes(smoke: SmokeReport, safe: (text: string) => string): string[] {
  return (smoke.crashes ?? []).map(({ service, exit }) => `${safe(service)} restarted after crash${exit
    ? ` (${exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`})` : ""}`);
}

function smokeLine(smoke: SmokeReport, services: TaskResult["services"], safe: (text: string) => string): string {
  const names = [...new Set(smoke.checks.map((check) => check.service))];
  const where = names.map((name) => {
    const service = services?.find((entry) => entry.name === name);
    return `${safe(name)} ${service?.origin ? `at ${service.origin.replace(/^http:\/\//, "")}` : `(${service?.state ?? "not started"})`}`;
  }).join(", ");
  const passed = smoke.checks.filter((check) => check.status === "pass").length;
  const listed = (status: "fail" | "incomplete") => smoke.checks.filter((check) => check.status === status)
    .map((check) => `${safe(check.name)}${check.reason ? ` (${safe(check.reason)})` : ""}`).join(", ");
  const failed = listed("fail"), incomplete = listed("incomplete");
  const verb = (check: SmokeReport["checks"][number]) => check.baseline === "fail" ? "failed" : check.baseline === "pass" ? "passed" : "could not run";
  const model = smoke.checks.filter((check) => check.source === "model").map((check) => check.baselineAfterEdits
    ? `${safe(check.name)} ${verb(check)} when recorded, after edits — an observation, not proof`
    : check.baseline === "pass" ? `${safe(check.name)} passed before the change too — an observation, not proof`
    : `${safe(check.name)} ${verb(check)} before the change`);
  const mark = smoke.status === "fail" ? "✗" : smoke.status === "pass" && smoke.checks.some((check) => check.evidence) ? "✓" : "•";
  return `${mark} ${names.length === 1 ? "Service" : "Services"} ${where}; smoke ${passed}/${smoke.checks.length} passed`
    + `${failed ? `; failed: ${failed}` : ""}${incomplete ? `; incomplete: ${incomplete}` : ""}${smoke.reason ? `; ${safe(smoke.reason).replace(/\.$/, "")}` : ""}${crashNotes(smoke, safe).map((note) => `; ${note}`).join("")}${model.length ? ` (model-declared, run by Casper: ${model.join("; ")})` : ""}`;
}

function reviewLine(review: RequirementsReview, safe: (text: string) => string): string {
  const open = "open" in review && review.open.length ? `⚠ The model's review says not done: ${review.open.map(safe).join("; ")}` : "";
  // A review cut off by its own budget claims nothing complete; admitted gaps still stand.
  if (review.incomplete) {
    return [`• The model's review stopped at its ${ROUND_MAX_TURNS}-turn budget (its own claim so far, not checked by Casper)`, open].filter(Boolean).join("\n");
  }
  if ("missing" in review) return "• The model's review returned no checklist";
  if (open) return open;
  // The delta answer: fixed holds only the gaps the review added tests or fixes for. A count short of
  // its total is not "all covered", even with no open line listed (the open lines still decide the outcome).
  if ("fixed" in review) {
    const fixed = review.fixed.length ? `${review.fixed.length} ${review.fixed.length === 1 ? "gap" : "gaps"} fixed` : "no gaps found";
    const count = review.total === undefined ? "all requirements" : review.covered !== undefined && review.covered < review.total
      ? `${review.covered} of ${review.total} requirements` : `all ${review.total} requirements`;
    return `• The model's review: ${count} covered (${fixed}; its own claim, not checked by Casper)`;
  }
  return `• The model's review: all ${review.done.length} requirements covered (its own claim, not checked by Casper)`;
}

function acceptanceLine(acceptance: NonNullable<TaskResult["acceptance"]>, safe: (text: string) => string): string {
  if (acceptance.status === "pass") return "✓ Independent acceptance: tests written from the request alone pass";
  const names = acceptance.unconfirmed?.map(safe).join("; ");
  if (acceptance.status === "fail" && acceptance.mode === "warn") {
    return names ? `⚠ Not confirmed by tests written from the request: ${names}` : "⚠ Independent acceptance: tests written from the request alone fail";
  }
  if (acceptance.status === "fail") return `✗ Independent acceptance: tests written from the request alone fail${names ? `: ${names}` : ""}`;
  return `• Independent acceptance not run: ${safe(acceptance.reason ?? "unknown reason")}`;
}

/** The error that kept the tests from loading without the change (an import of what the change adds). */
function loadFailure(proof: ChangeProof): RegExpExecArray | null {
  if (proof.status !== "proven" || proof.without.ended !== "fail") return null;
  return /ImportError|ModuleNotFoundError|errors? (?:during|while) collect|error collecting|Cannot find module|is not exported|SyntaxError|NameError|has no exported member/i
    .exec(proof.without.output ?? "");
}

function proofLine(proof: ChangeProof, safe: (text: string) => string): string {
  if (proof.status === "proven") {
    const { exitCode, ended, reason } = proof.without;
    // Tests that could not even load without the change (a missing function to import) are weaker evidence
    // than a failing assertion: say which it was.
    const load = loadFailure(proof);
    if (ended === "fail" && load) return `✓ Proven, weakly: without this change ${proof.check} could not load (exit ${exitCode}, ${load[0]}), and it passes with the change`;
    if (ended === "fail") return `✓ Proven: ${proof.check} fails without this change (exit ${exitCode}) and passes with it`;
    // A timeout, crash or missing command shows the old code did not pass, not that a test caught it.
    const timeout = /^Timed out after (\d+)ms$/.exec(reason ?? "");
    const how = ended === "timeout" ? `timed out${timeout ? ` after ${duration(Number(timeout[1]))}` : ""}`
      : ended === "crash" ? `crashed or was killed (exit ${exitCode})` : `could not start (exit ${exitCode})`;
    return `✓ Proven, weakly: ${proof.check} passes with this change; without it ${proof.check} ${how} instead of failing`;
  }
  if (proof.status === "unproven") {
    return `⚠ Not proven: ${proof.check} passes without this change too${proof.testsChanged ? "; the changed tests do not check it" : ", and no test was added or changed"}`;
  }
  return `• Not proven — ${safe(proof.reason).replace(/\.$/, "")}`;
}

function checkLine(result: VerificationResult, safe: (text: string) => string, slash: (command: string) => string, repaired = false): string {
  const name = result.name;
  // A report is shown for reading: never a pass, a fail or a reason the change is not verified.
  if (result.kind === "report") return `• ${name}  ${reportText(result)} (a diff, not a pass/fail check)`;
  // A named check that could not run (a missing tool, a lab check) says why in its own words.
  if (result.status === "skip" && !isBuiltinCheck(name)) return `• Not verified — ${name} not run: ${safe(result.reason ?? "skipped").replace(/\.$/, "")}`;
  if (result.status === "skip") {
    return result.command ? `• Not verified — ${name} was skipped.` : `• Not verified — ${name} has no command. Add verify.${name} to .casper/project.yaml.`;
  }
  if (result.status === "pass") {
    if (result.freshness === "stale") return `• Not verified — stale: files changed after the last passing ${name}. Run ${slash(`/verify ${name}`)}.`;
    // A reused pass did not run again: the time shown is the earlier run's, so the receipt says so.
    const how = [result.label ? safe(result.label) : "", result.command ? safe(result.command) : ""].filter(Boolean).join(" · ");
    const took = elapsed(result.durationMs);
    const inside = how && took ? `${how}, ${took}` : how || took;
    return `✓ ${name} passed${result.reused ? " earlier in this task, reused" : ""}${inside ? ` (${inside})` : ""}`;
  }
  const timeout = /^Timed out after (\d+)ms$/.exec(result.reason ?? "");
  // Unfinished checks are not the code failing: Casper does not repair them, so it does not offer to.
  if (result.ended === "timeout") {
    return `✗ ${name} timed out${timeout ? ` after ${duration(Number(timeout[1]))}` : ""} — it did not finish, so it was not checked; ${slash(`/verify ${name}`)} to run it again, or raise verification.timeoutMs in .casper/project.yaml`;
  }
  // The sandbox refused something the check tried: the same words the AI sees, so it does not retry it.
  if (result.ended === "blocked") return `✗ ${name} — ${safe(result.reason ?? "blocked by the sandbox")}`;
  if (result.ended === "no_start" && !isBuiltinCheck(name)) {
    return `✗ ${name} could not start (${typeof result.exitCode === "number" ? `exit ${result.exitCode}` : safe(result.reason ?? "no exit status").replace(/\.$/, "").toLowerCase()}) — check verify.checks.${name} in .casper/project.yaml`;
  }
  if (result.ended === "no_start") {
    return `✗ ${name} could not start (${typeof result.exitCode === "number" ? `exit ${result.exitCode}` : safe(result.reason ?? "no exit status").replace(/\.$/, "").toLowerCase()}) — check verify.${name} in .casper/project.yaml`;
  }
  const why = typeof result.exitCode === "number" ? `exit ${result.exitCode}`
    : timeout ? `timed out after ${duration(Number(timeout[1]))}`
    : result.reason ? safe(result.reason).replace(/\.$/, "").toLowerCase()
    : result.signal ? `stopped by ${safe(result.signal)}` : "no exit status";
  // A lab check touches lab devices: no one-key repair offer, only running it again (it asks first).
  // Once you chose "Ask the model to fix it", the repair line above says so; the receipt never says it did not.
  if (result.kind === "lab") {
    return `✗ ${name} failed on the lab (${why}) — log above;${repaired ? "" : " Casper did not ask the model to fix it."} ${slash(`/verify ${name}`)} runs it again (asks first)`;
  }
  return `✗ ${name} failed (${why}) — log above; ${slash(`/verify repair ${name}`)} to fix`;
}

const duration = formatDuration;
/** How long a check took, left out under a second ("0.0s everywhere" said nothing). */
const elapsed = (ms: number) => ms < 1000 ? "" : formatDuration(ms);

/** The line shown the moment a check Casper runs finishes, before the receipt: "✓ typecheck · 5.9s". */
export function liveCheckLine(result: VerificationResult): string {
  const name = result.name;
  if (result.kind === "report") return `• ${name} · ${reportText(result)} (a diff, not a pass/fail check)`;
  if (result.status === "skip" && !isBuiltinCheck(name)) return `– ${name} · not run${result.reason ? `: ${result.reason.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")}` : ""}`;
  if (result.status === "skip") return `– ${name} · skipped${result.command ? "" : ", no command"}`;
  // A lab check's own label ("dry run not guaranteed") stays beside its result.
  const label = result.label ? `${result.label.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")} · ` : "";
  if (result.status === "pass") return result.reused ? `✓ ${name} · passed earlier, reused` : `✓ ${name}${[label.replace(/ · $/, ""), elapsed(result.durationMs)].filter(Boolean).map((part) => ` · ${part}`).join("")}`;
  const timeout = /^Timed out after (\d+)ms$/.exec(result.reason ?? "");
  if (result.ended === "timeout") return `✗ ${name} · timed out${timeout ? ` after ${duration(Number(timeout[1]))}` : ""}`;
  if (result.ended === "no_start") return `✗ ${name} · could not start${typeof result.exitCode === "number" ? ` (exit ${result.exitCode})` : ""}`;
  if (result.ended === "blocked") return `✗ ${name} · ${(result.reason ?? "blocked by the sandbox").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")}`;
  const why = typeof result.exitCode === "number" ? `exit ${result.exitCode}` : result.signal ? `stopped by ${result.signal}`
    : result.reason ? result.reason.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ") : "no exit status";
  return `✗ ${name} · ${label}${why}${elapsed(result.durationMs) ? ` · ${elapsed(result.durationMs)}` : ""}`;
}

function pathList(paths: string[], safe: (text: string) => string, count = true): string {
  const shown = paths.slice(0, RECEIPT_PATH_LIMIT).map(safe).join(", ");
  const more = paths.length > RECEIPT_PATH_LIMIT ? ` … +${paths.length - RECEIPT_PATH_LIMIT} more` : "";
  return `${count ? `${paths.length} ${paths.length === 1 ? "file" : "files"}: ` : ""}${shown}${more}`;
}

/** A folder as a shell runs it: plain when it needs no quotes; otherwise in single quotes, with a leading ~/ left
 * outside them so the shell still expands it (a quoted "~" is a folder named ~, and "$x" would be expanded). */
function shellFolder(folder: string): string {
  if (/^[\w./~:@%+=,-]+$/.test(folder)) return folder;
  if (process.platform === "win32") return JSON.stringify(folder);
  const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
  return folder.startsWith("~/") ? `~/${quote(folder.slice(2))}` : quote(folder);
}
