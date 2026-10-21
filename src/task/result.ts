import { formatVerificationReport, reportText, type CheckName, type VerificationReport, type VerificationResult } from "../verify/evidence";
import { modelErrorNext, type ModelErrorCause } from "../runtime/model-errors";
import type { RiskyLine } from "../network/risky-receipt";
import { isBuiltinCheck } from "../verify/named";
import { missingProgram, missingProgramLine } from "../verify/missing-program";
import { DRY_RUN_LABEL } from "../network/checks";
import type { ProjectCommand } from "../project/model";
import type { BrowserReport } from "../browser/scenario";
import type { ServiceState } from "../services/manager";
import type { SmokeReport } from "../services/smoke";
import type { AppSmokeReport } from "../services/try-it";
import { formatPageReport, pageFailureSummary } from "../services/page-report";
import type { AutoCheckSkip, VerificationMode } from "../verify/mode";
import type { ChangeProof } from "../verify/proof";
import type { AcceptanceResult } from "../verify/acceptance";
import { ROUND_MAX_TURNS, type RequirementsReview } from "./review";
import { formatLimit } from "./spend";
import { BRANCH_MOVED_LINE, GIT_MOVEMENT_UNKNOWN } from "./git-movement";
import { configChanges, type ConfigChanges } from "./config-files";
import { formatCost, formatDuration, lineText, redactPreview } from "../tui/format";
import { planReceipt, planSummary, type PlanStepReport } from "../flows/plan-build";

/** Tool-reported diagnostics, not process exit evidence or a reusable check pass. */
export interface ObservedCheck {
  name: ProjectCommand;
  command: string;
  toolStatus: "success" | "error";
  output: string;
  truncated: boolean;
}

/** Model use during one task, including repairs and helpers. Turns stay the main conversation's own. */
export interface TaskUsage {
  /** Model responses (turns). */
  turns: number;
  /** Totals of what the provider reported per response. Null when a response had no report or the
   * task also made model calls Casper does not total (a delegated subagent, automatic effort's
   * classifier): unknown, never an undercount. The cost is a catalog estimate, never an invoice. */
  tokens: number | null;
  estimatedCost: number | null;
  input?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  output?: number | null;
  helpers?: Array<Omit<TaskUsage, "turns" | "helpers"> & { role: "explorer" | "reviewer" | "builder"; goal: string; part?: number }>;
}

/** One acknowledged cleanup incident; commands are safe display-only previews. */
export interface CleanupReport {
  state: "stopped" | "left-running" | "unconfirmed";
  processes: Array<{ pid: number; group: number; command: string }>;
  unattended?: true;
}

export function cleanupReceiptLines(reports: readonly CleanupReport[]): string[] {
  return reports.flatMap(report => [
    report.state === "stopped" ? "– Owned processes stopped; cleanup confirmed"
      : report.state === "left-running" ? "⚠ Owned processes left running by your choice; cleanup unconfirmed"
      : "⚠ Owned process cleanup unconfirmed",
    ...report.processes.map(process => `– PID ${process.pid} · ${lineText(redactPreview(process.command))}`),
  ]);
}

/** Execution completion is not behavioral acceptance or proof of correctness. */
export interface TaskResult {
  execution: "completed" | "failed" | "cancelled";
  cleanup?: CleanupReport[];
  /** The model's whole answer was a tool call written as text, and the task made no tool calls: nothing was done. */
  wroteToolCallAsText?: true;
  /** Why the model run failed, when the provider's error names a cause (bad key, no credits, rate limit …). */
  modelError?: ModelErrorCause;
  verification?: VerificationReport;
  /** One final app request/load and its cleanup; a runtime observation, never behavioral proof. */
  appSmoke?: AppSmokeReport;
  browser?: BrowserReport;
  /** The model's answer says the browser checks passed; only said when Casper's record disagrees. */
  browserClaimed?: boolean;
  /** Native edit/write paths the runtime reported; may lie outside the workspace root. */
  observedEdits?: string[];
  /** Workspace-relative paths whose content identity differed between the snapshots taken before
   * the model turn and right after it (added, modified or removed). Undefined when a snapshot
   * failed or was skipped. */
  changedPaths?: string[];
  /** The project's HEAD or branch moved while the task ran. */
  branchMoved?: true;
  /** Git's baseline was unreadable: no task-only change count or Undo can be offered. */
  branchChangesUnknown?: true;
  /** Paths that changed after the model turn, while Casper's own checks and repair ran. Repair
   * edits are model work too, but they belong to the verification round, not the request. */
  changedDuringChecks?: string[];
  /** A mutation-capable tool ran but no workspace snapshot could confirm or refute writes. */
  possibleMutations?: boolean;
  /** Why Casper could not compare the folder ("not a project folder (over 20,000 files)"), and
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
  /** Accepted-plan progress reported by the model; never check evidence. */
  planSteps?: PlanStepReport[];
  /** The session's managed services at the end of the task (the origin while starting or ready). */
  services?: Array<{ name: string; origin?: string; state: ServiceState }>;
  /** A known test-runner command the model ran without error while the project had no test command: only ever
   * offered as a suggestion to remember, never check evidence. */
  testRunner?: string;
  /** Files that changed during a plan turn anyway (Casper blocks the changes it can see; this names the rest). */
  changedWhilePlanning?: string[];
  /** Files that changed while the model only read, searched or ran a plain ssh elsewhere: another program's, not checked. */
  changedNotByModel?: string[];
  /** Repairs that ran on the user's big model: the extra try the user chose, or repair.bigModelLastTry. */
  bigModel?: { model: string; attempts: number; /** Picked for this task only, not saved as the big model. */ oneOff?: true };
  /** Casper's security tools ran for this task: counts only, never finding text. */
  security?: SecuritySummary;
  /** This task's saved receipt number (/receipt <n>), when receipts are kept. */
  receipt?: number;
  /** Why the task's changed pages were not opened, as plain receipt lines: the dev server can't start (a missing
   * install), or every changed page needs a value ("– /devices/[id] not opened: …"). Never a failure. */
  pageNotes?: string[];
  /** How many page screenshots the AI was shown to check the look (showPages). Advice, never a check. */
  pagesShown?: number;
  /** Parts builders landed that no reviewer finished (a reviewer that timed out, failed or was cut off, or none was
   * started): said in one line, never a failure. */
  partsNotReviewed?: PartNotReviewed[];
  /** The one full selected-check sweep after the crew's reviewers, fixes and final repairs, never cached. */
  crewChecks?: { status: VerificationReport["status"] | "not-run"; checks: CheckName[]; reason?: string };
  /** Whether /undo can put this task's files back, and why not. `left` names changed files Casper keeps no copy of. */
  undo?: { available: true; left?: Array<{ path: string; why: string }> } | { available: false; reason: string };
  /** Changes on other machines, read from the text of the AI's ssh and scp commands (never guessed beyond it). */
  remoteChanges?: Array<{ host: string; changes: string[] }>;
  /** Commands to other machines Casper stopped before they ran (your No, a run that can't ask, the sandbox). */
  remoteNotRun?: Array<{ host: string; commands: number }>;
  /** A secret appeared in a command the AI sent: hidden on screen, in records and here, but the AI has it. */
  secretInCommand?: true;
  /** Files the AI's writes and edits added a secret to (never the value): a note, nothing was stopped. */
  secretInFiles?: string[];
  /** Whether the shell sandbox held this task's shell commands and checks, and why not ("--no-sandbox"). */
  sandbox?: { held: true } | { held: false; reason: string };
  /** Folders outside the project this task wrote to after you allowed them (~/ form). Casper keeps no undo copy. */
  outsideWrites?: string[];
  /** Folders outside the project you allowed a shell command to write (~/ form): allowed, not known written. */
  outsideAllowed?: string[];
  /** Dangerous lines in the config files this task changed (reload, shutdown, erase …): shown, never a pass or a fail. */
  riskyLines?: RiskyLine[];
  /** How many more risky lines there were past the 20 listed. */
  riskyMore?: number;
}

/** A landed part of a crew that no reviewer finished: its number, its files and why ("the reviewer timed out"). */
export interface PartNotReviewed { part: number; files: string[]; why: string }

/** "part 1 (a.ts, b.ts; the reviewer timed out), part 2 (c.ts; no reviewer looked at it)". */
export function formatNotReviewed(items: readonly PartNotReviewed[], safe: (text: string) => string = lineText): string {
  return items.map(({ part, files, why }) => `part ${part} (${files.length > 3 ? `${files.slice(0, 3).map(safe).join(", ")} and ${files.length - 3} more` : files.map(safe).join(", ")}; ${safe(why)})`).join(", ");
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
  if (task?.cleanup?.some(incident => incident.state !== "stopped")) return false;
  if (task?.appSmoke && (task.appSmoke.status === "fail" || (task.appSmoke.status === "not-run" && !task.appSmoke.deferred && !task.appSmoke.nothingToStart) || task.appSmoke.cleanup === "unconfirmed")) return false;
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

/** A proof that can say Verified: a run without the change that timed out or never started did not show the old code
 * failing, so it keeps its "Proven, weakly" line and is not proof (a crash is still kept as evidence). */
function provesChange(proof?: ChangeProof): boolean {
  return proof?.status === "proven" && proof.without.ended !== "timeout" && proof.without.ended !== "no_start";
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
  if (status === "fail" || status === "blocked" || task?.browser?.status === "fail" || task?.appSmoke?.status === "fail") return "failed";
  if (status === "incomplete" || task?.browser?.status === "incomplete" || (task?.appSmoke?.status === "not-run" && !task.appSmoke.deferred && !task.appSmoke.nothingToStart) || task?.appSmoke?.cleanup === "unconfirmed") return "incomplete";
  if (task?.cleanup?.some(incident => incident.state !== "stopped")) return "incomplete";
  // Commands to another machine that Casper stopped: whatever the AI said about that machine did not happen.
  if (task?.remoteNotRun?.length) return "incomplete";
  // The model only wrote a tool call as text: it did not act, which is not "unchanged and fine".
  if (task?.wroteToolCallAsText && status !== "pass") return "incomplete";
  const changed = Boolean(task?.changedPaths?.length || task?.changedDuringChecks?.length || (!task?.changedPaths && task?.possibleMutations));
  // "verified" is what the verdict line calls Verified (ADR 0001): the checks pass on changed files and a test fails
  // without the change. Checks that passed without that proof are not_verified; checksPassed still says they passed.
  if (status === "pass") {
    if (!checksPassed(report, task)) return "not_verified";
    if (!changed) return "unchanged";
    return provesChange(task?.proof) ? "verified" : "not_verified";
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
 * the receipt's "– Not run on …" lines below it give each machine's count. */
function remoteNotRunVerdict(remotes: NonNullable<TaskResult["remoteNotRun"]>, safe: (text: string) => string): string {
  const count = remotes.reduce((sum, remote) => sum + remote.commands, 0);
  return `${count === 1 ? "a command" : "commands"} to ${remotes.map((remote) => safe(remote.host)).join(", ")} did not run`;
}

/** The browser checks that decide the result: all but the ones the AI withdrew as written wrong. */
function countedBrowserChecks(checks: BrowserReport["checks"]): BrowserReport["checks"] {
  return checks.filter((check) => check.status !== "withdrawn");
}

/** Why browser checks that all passed still leave the task incomplete: an edit or command ran after some or all of
 * them, or Casper can't tie them to the final files. Each says "them" only when it covers every check. */
function browserPassedVerdict(checks: BrowserReport["checks"]): string {
  const which = (count: number) => count === checks.length ? "them" : "some of them";
  const stale = checks.filter((check) => check.freshness === "stale").length;
  const untied = checks.filter((check) => check.freshness === "unavailable").length;
  return `the browser checks passed, but ${stale ? `an edit or command ran after ${which(stale)}` : `Casper can't tie ${which(untied)} to the final files`}`;
}

/** An ssh command whose text shows no change Casper knows: it ran there all the same. */
export const REMOTE_UNKNOWN = "Casper can't tell from the command text whether they changed anything there";

/** The receipt's line when the AI typed a secret into a command. */
export const SECRET_IN_COMMAND = "A secret appeared in a command; change it after this task.";

/** More paths than this are summarized; the full list stays in the result. */
const RECEIPT_PATH_LIMIT = 8;

/** The receipt's line when the AI wrote a secret into files; the value is never shown. */
export function secretInFilesText(files: string[], safe: (text: string) => string): string {
  const shown = files.slice(0, RECEIPT_PATH_LIMIT).map(safe).join(", ");
  const more = files.length > RECEIPT_PATH_LIMIT ? ` … +${files.length - RECEIPT_PATH_LIMIT} more` : "";
  return `A secret was written into ${shown}${more} (not shown). Keep secrets in an env file or a secrets store.`;
}

export function formatTaskResult(task: TaskResult): string {
  const report = task.verification;
  const safe = lineText;
  const lines = [`[task] Execution ${task.execution}`, ...planReceipt(task.planSteps), ...cleanupReceiptLines(task.cleanup ?? [])];
  if (task.spendLimit) lines.push(receiptLine("spend", `stopped at ${formatCost(task.spendLimit.spent)}, the ${formatLimit(task.spendLimit.limit)} limit for one task (spend.pauseAt)`));

  if (task.observedEdits?.length) lines.push(receiptLine("tool edits", task.observedEdits.map(safe).join(", ")));
  if (task.changedPaths) lines.push(receiptLine("changes", formatChangedPaths(task.changedPaths, safe)));
  else if (task.possibleMutations) lines.push(receiptLine("changes", `unknown (${task.snapshotFailure ? safe(task.snapshotFailure.reason) : "workspace snapshot failed"})`));
  if (task.changedDuringChecks?.length) lines.push(receiptLine("check edits", formatChangedPaths(task.changedDuringChecks, safe)));
  if (task.branchChangesUnknown) lines.push(`– ${task.branchMoved ? "The branch moved during this task; " : ""}${GIT_MOVEMENT_UNKNOWN}; undo is unavailable`);
  else if (task.branchMoved) lines.push(BRANCH_MOVED_LINE);
  if (task.observedChecks?.length) {
    lines.push(receiptLine("shell", `${task.observedChecks.map(({ name, toolStatus }) => `${name}:${toolStatus}`).join(", ")} (diagnostics only)`));
  }

  lines.push(receiptLine("verification", report ? formatVerificationReport(report, { compact: true }) : "no Casper verification recorded."));
  if (task.proof) lines.push(receiptLine("proof", proofLine(task.proof, safe).line));
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
  if (task.appSmoke) lines.push(receiptLine("app smoke", appSmokeLine(task.appSmoke, safe)));
  if (report?.pages) lines.push(receiptLine("pages", `${report.pages.status}: ${report.pages.pages.map((page) => `${safe(page.path)} ${page.status}${page.httpStatus !== null ? ` (${page.httpStatus})` : ""}`).join("; ") || "none opened"}${report.pages.reason ? `. ${safe(report.pages.reason)}` : ""}`));
  else if (task.pageNotes?.length) lines.push(receiptLine("pages", task.pageNotes.map((note) => safe(note.replace(/^– /, ""))).join("; ")));
  if (task.partsNotReviewed?.length) lines.push(receiptLine("not reviewed", formatNotReviewed(task.partsNotReviewed, safe)));
  if (task.crewChecks) lines.push(receiptLine("crew checks", crewChecksText(task.crewChecks)));
  if (task.pagesShown) lines.push(receiptLine("look", pagesShownText(task.pagesShown)));
  if (task.bigModel) lines.push(receiptLine("big model", `${safe(task.bigModel.model)} for ${task.bigModel.attempts} ${task.bigModel.attempts === 1 ? "repair" : "repairs"}`));
  if (task.security) lines.push(receiptLine("security", securityText(task.security)));
  for (const remote of task.remoteChanges ?? []) lines.push(receiptLine(`on ${safe(remote.host)}`.slice(0, 12), remote.changes.length
    ? `${remote.changes.map(safe).join("; ")} (from the commands Casper saw)` : REMOTE_UNKNOWN));
  for (const remote of task.remoteNotRun ?? []) lines.push(receiptLine(`not on ${safe(remote.host)}`.slice(0, 12), remoteNotRunText(remote.commands)));
  if (task.secretInCommand) lines.push(receiptLine("secret", SECRET_IN_COMMAND));
  if (task.secretInFiles?.length) lines.push(receiptLine("secret", secretInFilesText(task.secretInFiles, safe)));
  if (task.sandbox) lines.push(receiptLine("sandbox", task.sandbox.held
    ? `shell commands and checks held${labRan(report) ? `; ${LAB_OUTSIDE}` : ""}` : `not sandboxed (${safe(task.sandbox.reason)})`));
  const outside = [
    ...(task.outsideWrites?.length ? [`wrote ${task.outsideWrites.map(safe).join(", ")} (you allowed it; no undo copy)`] : []),
    ...(task.outsideAllowed?.length ? [`allowed shell writes to ${task.outsideAllowed.map(safe).join(", ")} (no undo copy)`] : []),
  ];
  if (outside.length) lines.push(receiptLine("outside", outside.join("; ")));
  if (task.riskyLines?.length) lines.push(receiptLine("risky", task.riskyLines.map((risky) => `${safe(risky.file)}:${risky.line} ${safe(risky.text)} (${risky.reason})`).join(" · ")
    + (task.riskyMore ? ` · and ${task.riskyMore} more` : "")));
  if (task.undo && !(!task.undo.available && task.undo.reason === UNDO_NOTHING_CHANGED)) {
    lines.push(receiptLine("undo", task.undo.available ? `available${task.receipt ? ` (/undo ${task.receipt})` : ""}${task.undo.left?.length ? `; no copy of ${task.undo.left.map((entry) => safe(entry.path)).join(", ")}` : ""}` : `not available: ${safe(task.undo.reason)}`));
  }
  if (task.browser) {
    lines.push(receiptLine("browser", `assertions ${task.browser.status}: ${task.browser.checks.map(check => `${safe(check.name)}:${check.status}${check.withdrawn ? ` (${safe(check.withdrawn)})` : ""}, inputs ${check.freshness}, baseline ${check.baseline}`).join("; ")}. Declared local scope only; server build/external state and overall acceptance not certified.`));
  }
  return lines.join("\n");
}

function crewChecksText(run: NonNullable<TaskResult["crewChecks"]>): string {
  return `Crew full checks on the combined result: ${run.status}${run.checks.length ? ` (${run.checks.map(lineText).join(", ")})` : ""}${run.reason ? ` — ${lineText(run.reason)}` : ""}`;
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
  /** Notes about the session rather than the task (the shell not sandboxed, a folder too big to compare) that an earlier
   * receipt said in full: said again in one short line (see rememberSessionNotes). /receipt still says them in full. */
  seenNotes?: ReadonlySet<string>;
}

/** Where a receipt line belongs: line 1 (the verdict); why the change is not verified (`why`: the proof, and checks
 * Casper did not run or count); the checks; what changed, with risky config lines (`config`) and other machines
 * (`devices`) apart; what needs you (`open`); notes; undo; and the commands to run next. */
export type ReceiptSection = "verdict" | "why" | "checks" | "changed" | "config" | "devices" | "open" | "notes" | "undo" | "next";

/** The receipt's main kinds of line: each also comes in parts (status, detail, actions). */
export type ReceiptKind = "verdict" | "check" | "changed" | "repairs" | "proof" | "checklist" | "undo" | "not-verified";

/** One receipt line, where it belongs and, for the main kinds, its parts. */
export interface ReceiptItem {
  /** The line as the text receipt prints it. */
  line: string;
  section: ReceiptSection;
  kind?: ReceiptKind;
  /** What happened, in the line's words: the verdict's name ("Failed", "Checks passed · not proven"), a check's
   * "passed" or "timed out", "Not proven", "Undo can't put back". */
  status?: string;
  /** The evidence or the reason: "exit 1", "15 files: …", "the tests pass without the change too". */
  detail?: string;
  /** What to type next, as typed here: a command ("/verify repair test", 'casper "/verify test"') or a request ('"add tests"'). */
  actions?: string[];
  /** The check, or the other machine, the line is about. */
  name?: string;
  /** How long a check ran, when a second or more ("1.3s"). */
  time?: string;
  /** Said with line 1 because it went well, in these words ("" says nothing); only on the short receipt. */
  fold?: string;
}

type LineInfo = Omit<ReceiptItem, "line" | "fold">;
type Parts = Omit<LineInfo, "section">;

/** The short receipt (what formatShortReceipt prints) as items: line 1, then every other line in the order shown. */
export interface ReceiptView {
  /** Line 1; none when the receipt is only undo lines. */
  verdict?: ReceiptItem;
  /** All is well: line 1's words on the one-line receipt ("✓ Verified"), before the folded items' words. */
  short?: string;
  /** What went well (with `fold`) first, then the rest: what needs you (⚠) first, the session notes said before, the
   * checklist, undo. A line printed as two (a review cut off with a gap) is two items. */
  items: ReceiptItem[];
  /** The config files this task changed (the task's own and its repairs'), which no text receipt names apart. */
  config: ConfigChanges;
}

/** A receipt note about the session's state rather than the task: its key (what it says, so a change says it in full
 * again) and the words it shrinks to once said. */
interface SessionNote { key: string; short: string }

const sandboxOffLine = (reason: string) => `– Shell commands and checks were not sandboxed (${reason})`;
const changesUnknownLine = (reason: string) => `– Changes unknown: ${reason}`;

/** This task's session notes, by the receipt line that says each one. */
function sessionNotes(task: TaskResult): Map<string, SessionNote> {
  const safe = lineText;
  const notes = new Map<string, SessionNote>();
  if (!task.changedPaths && task.possibleMutations && task.snapshotFailure) {
    const reason = safe(task.snapshotFailure.reason);
    notes.set(changesUnknownLine(reason), { key: `changes:${reason}`, short: `changes unknown (${reason.replace(/\s*\(.*$/, "")})` });
  }
  if (task.sandbox && !task.sandbox.held) {
    const reason = safe(task.sandbox.reason);
    notes.set(sandboxOffLine(reason), { key: `sandbox:${reason}`, short: "not sandboxed" });
  }
  return notes;
}

/** After a short receipt: the session notes it said, so the next receipt says them short. A note whose state ended
 * (the sandbox back on, a folder Casper can compare) is forgotten, so the next time it comes back it is said in full. */
export function rememberSessionNotes(seen: Set<string>, task: TaskResult): void {
  const keys = [...sessionNotes(task).values()].map((note) => note.key);
  for (const kind of ["sandbox:", "changes:"]) {
    if (keys.some((key) => key.startsWith(kind))) continue;
    for (const key of [...seen]) if (key.startsWith(kind)) seen.delete(key);
  }
  for (const key of keys) seen.add(key);
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
  return [...lines, ...undo.map((item) => item.line)].join("\n");
}

/** "The AI looked at 4 screenshots of the pages (advice, not a check)". */
function pagesShownText(count: number): string {
  return `The AI looked at ${count} screenshot${count === 1 ? "" : "s"} of the pages (advice, not a check)`;
}

/** The receipt as the terminal shows it after a task: one line when all is well ("✓ Verified · test passed ·
 * 3 files changed"), and each problem on its own short line under it. The full form stays in formatReceipt
 * (--json `text`, saved receipt summaries) and formatTaskResult (/receipt). */
export function formatShortReceipt(task: TaskResult, options: ReceiptOptions = {}): string {
  const { verdict, short, items } = receiptView(task, options);
  const rest = items.filter((item) => item.fold === undefined).map((item) => item.line);
  if (!verdict) return rest.join("\n");
  const parts = items.flatMap((item) => item.fold ? [item.fold] : []);
  // All well: one line. Otherwise the verdict says what is wrong, and what went well shares one line under it.
  // Check names stay as typed: "✓ test passed", never "Test".
  const head = short !== undefined ? [[short, ...parts].join(" · ")] : [verdict.line, ...(parts.length ? [`✓ ${parts.join(" · ")}`] : [])];
  return [...head, ...rest].join("\n");
}

/** The short receipt as items, each with its section, for a terminal that lays the receipt out in rows. */
export function receiptView(task: TaskResult, options: ReceiptOptions = {}): ReceiptView {
  const { lines, undo, folds, short, info } = receiptParts(task, options, true);
  const config = configChanges([...new Set([...task.changedPaths ?? [], ...task.changedDuringChecks ?? []])]);
  const about = (line: string): LineInfo => info.get(line) ?? { section: "notes" };
  // A line printed as two (a review cut off with a gap) is two items, each in its own section.
  const items = (line: string): ReceiptItem[] => line.split("\n").map((part) => ({ line: part, ...(info.get(part) ?? about(line)) }));
  if (!lines.length) return { items: undo, config };
  const notes = sessionNotes(task);
  // Said in full on an earlier receipt this session: one short line at the end says them all.
  const again = (line: string) => Boolean(options.seenNotes?.has(notes.get(line)?.key ?? "\0"));
  const [verdict, ...body] = lines;
  // Repairs and "no files changed" are news only beside a pass; with a problem they keep their own line.
  const folded = (line: string) => folds.has(line) && (short !== undefined || !(line.startsWith("↻ ") || line === "– No files changed"));
  // Checks first, then the files, then repairs: "✓ Verified · test passed · 3 files changed · after 1 repair".
  const rank = (line: string) => line.startsWith("↻ ") ? 2 : line.startsWith("✓ Changed ") || line === "– No files changed" ? 1 : 0;
  const well = body.filter(folded).sort((a, b) => rank(a) - rank(b)).map((line): ReceiptItem => ({ line, ...about(line), fold: folds.get(line)! }));
  // The problems come right after the verdict, a warning to act on (⚠) first; the checklist's line follows them.
  const rest = body.filter((line) => !folded(line) && !again(line));
  const urgent = (line: string) => line.startsWith("⚠ ");
  const repeated = body.filter(again).map((line) => notes.get(line)!.short);
  const same: ReceiptItem[] = repeated.length ? [{ line: `– Same as before: ${repeated.join(" · ")} (/receipt)`, section: "notes" }] : [];
  return { verdict: { line: verdict!, ...about(verdict!) }, ...(short !== undefined ? { short } : {}), config,
    items: [...well, ...rest.filter(urgent).flatMap(items), ...rest.filter((line) => !urgent(line)).flatMap(items), ...same, ...checklistLines(task, lineText), ...undo] };
}

/** True when every failing check also failed on the files from before the change and was left as it is. */
function failingBeforeOnly(report: VerificationReport | undefined): boolean {
  const before = report?.failingBefore;
  if (!before?.length) return false;
  const failing = report!.results.filter((result) => result.status === "fail" && result.kind !== "report");
  return failing.length > 0 && failing.every((result) => before.includes(result.name));
}

/** The request's checklist on the short receipt: said only when the model's own review lists something not done
 * or the checks did not pass, so the cases are not confirmed. /receipt lists every case. The model's open items
 * come from its answer (the request and project docs), not the checklist, so they are not counted against it. */
function checklistLines(task: TaskResult, safe: (text: string) => string): ReceiptItem[] {
  const cases = task.checklist?.length ?? 0;
  if (!cases) return [];
  const review = task.review;
  const open = review && "open" in review ? review.open : [];
  if (open.length && !review?.incomplete) {
    const status = `${open.length} ${open.length === 1 ? "requirement" : "requirements"} not met`;
    const said = `the model says: ${open.map(safe).join("; ")}`;
    return [{ line: `⚠ ${status}, ${said}`, section: "open", kind: "checklist", status, detail: said }];
  }
  const changed = Boolean(task.changedPaths?.length || task.changedDuringChecks?.length || (!task.changedPaths && task.possibleMutations));
  if (!changed || checksPassed(task.verification, task)) return [];
  const why = task.execution !== "completed" || task.turnLimit !== undefined || task.spendLimit !== undefined ? "the task did not finish" : !task.verification ? "no checks ran"
    : task.verification.status === "pass" ? "the checks do not prove the change"
    : failingBeforeOnly(task.verification) ? "a check fails with and without this change" : "the checks did not pass";
  const status = `${cases} ${cases === 1 ? "case" : "cases"} from your request not confirmed`;
  return [{ line: `– ${status}: ${why} (/receipt lists them)`, section: "why", kind: "checklist", status, detail: why, actions: ["/receipt"] }];
}

/** The receipt's lines (verdict first), its undo lines, and the short form's pieces: `folds` maps a line that
 * says all is well to the few words it becomes on the one-line receipt ("" drops it); `short` is the verdict
 * word when nothing is wrong; `info` gives each line's section and parts. `onScreen`: the plan checklist is one line
 * (/receipt lists every step). */
function receiptParts(task: TaskResult, options: ReceiptOptions, onScreen = false):
  { lines: string[]; undo: ReceiptItem[]; folds: Map<string, string>; short?: string; info: Map<string, LineInfo> } {
  const safe = lineText;
  const slash = (command: string) => options.surface === "one-shot" ? `casper "${command}"` : command;
  const lines: string[] = [];
  const info = new Map<string, LineInfo>();
  const folds = new Map<string, string>();
  const add = (section: ReceiptSection, line: string, parts: Parts = {}) => { lines.push(line); info.set(line, { section, ...parts }); };
  const fold = (section: ReceiptSection, line: string, short: string, parts: Parts = {}) => { add(section, line, parts); folds.set(line, short); };
  // Cleanup Casper could not confirm needs you, its processes with it.
  for (const report of task.cleanup ?? []) for (const line of cleanupReceiptLines([report])) add(report.state === "stopped" ? "notes" : "open", line);
  const changedPart = (status: string, detail?: string): Parts => ({ kind: "changed", status, ...(detail ? { detail } : {}) });
  if (task.changedPaths?.length) {
    const list = pathList(task.changedPaths, safe);
    fold("changed", `✓ Changed ${list}`, changedShort(task.changedPaths, safe), changedPart("Changed", list));
  }
  else if (task.changedPaths && task.autoSkipped === "no-changes" && !task.verification) add("changed", "– No files changed, so Casper ran no checks", changedPart("No files changed", "Casper ran no checks"));
  else if (task.changedPaths) fold("changed", "– No files changed", "no files changed", changedPart("No files changed"));
  else if (task.possibleMutations) {
    const reason = task.snapshotFailure ? safe(task.snapshotFailure.reason) : undefined;
    add("changed", reason ? changesUnknownLine(reason) : "– Changes unknown — Casper could not compare the workspace", changedPart("Changes unknown", reason ?? "Casper could not compare the workspace"));
  }
  if (!task.changedPaths && task.snapshotFailure?.edited.length) {
    const list = pathList(task.snapshotFailure.edited, safe, false);
    add("changed", `– Changed (seen by Casper's edit and write tools): ${list}`, changedPart("Changed (seen by Casper's edit and write tools)", list));
  }

  const report = task.verification;
  if (report?.repairAttempts) {
    const repairs = `${report.repairAttempts} ${report.repairAttempts === 1 ? "repair" : "repairs"}${task.bigModel ? ` (the last on ${task.bigModel.oneOff ? "" : "your big model "}${safe(task.bigModel.model)})` : ""}`;
    fold("checks", `↻ Casper tried ${repairs}`, `after ${repairs}`, { kind: "repairs", status: "tried", detail: repairs });
  }
  for (const result of report?.results ?? []) {
    const { line, ...parts } = checkLine(result, safe, slash, !!report?.repairAttempts);
    if (result.status === "pass" && result.freshness !== "stale" && result.kind !== "report") fold("checks", line, `${result.name} passed${result.reused ? " earlier" : ""}${result.label ? ` (${safe(result.label)}${result.command ? ` · ${safe(result.command)}` : ""})` : ""}`, parts);
    else add("checks", line, parts);
  }
  if (report?.status === "blocked" && report.reason) {
    const reason = safe(report.reason).replace(/\.$/, "");
    add("checks", `✗ Checks stopped — ${reason}`, { kind: "check", status: "stopped", detail: reason });
  }

  const recorded = new Set(report?.results.map((result) => result.name));
  for (const observed of task.observedChecks ?? []) {
    if (recorded.has(observed.name)) continue;
    const ran = `${observed.name} ran via bash only (${safe(observed.command)}: ${observed.toolStatus === "success" ? "passed" : "failed"})`;
    const verify = slash(`/verify ${observed.name}`);
    add("why", `– Not verified — ${ran}. Run ${verify} to record a check.`, { kind: "not-verified", name: observed.name, status: "Not verified", detail: ran, actions: [verify] });
  }

  // A strong proof is what "Verified" says; a weak one keeps its line.
  if (task.proof) {
    const { line, ...parts } = proofLine(task.proof, safe);
    if (line.startsWith("✓ Proven:")) fold("why", line, "", parts); else add("why", line, parts);
  }
  if (task.acceptance) {
    const line = acceptanceLine(task.acceptance, safe);
    if (task.acceptance.status === "pass") fold("checks", line, "tests written from the request pass");
    else add(line.startsWith("⚠ ") ? "open" : line.startsWith("✗ ") ? "checks" : "notes", line);
  }
  // The model's own "all covered" claim is not evidence: the short receipt leaves it out. A count short of its
  // total ("3 of 5") and its gaps keep their line; with a checklist the gaps become the checklist's line.
  if (task.review) {
    const line = reviewLine(task.review, safe);
    const asCases = Boolean(task.checklist?.length && !task.review.incomplete && "open" in task.review && task.review.open.length);
    // The model's admitted gaps need you; the rest is its own claim, a note. A review cut off with a gap is two lines.
    const section = (text: string): ReceiptSection => text.startsWith("⚠ ") ? "open" : "notes";
    if (line.startsWith("– The model's review: all ") || asCases) fold(section(line), line, ""); else add(section(line), line);
    for (const part of line.split("\n")) info.set(part, { section: section(part) });
  }
  if (task.changedDuringChecks?.length) add("changed", `– Changed while checking: ${pathList(task.changedDuringChecks, safe, false)}`);
  if (task.changedWhilePlanning?.length) add("changed", `– Changed while planning: ${pathList(task.changedWhilePlanning, safe, false)}`);
  if (task.changedNotByModel?.length) add("changed", `– Changed meanwhile by another program, not the AI (not checked): ${pathList(task.changedNotByModel, safe, false)}`);
  for (const line of onScreen ? planSummary(task.planSteps) : planReceipt(task.planSteps)) add("notes", line);
  if (task.branchChangesUnknown) add("notes", `– ${task.branchMoved ? "The branch moved during this task; " : ""}${GIT_MOVEMENT_UNKNOWN}; undo is unavailable`);
  else if (task.branchMoved) add("notes", BRANCH_MOVED_LINE);

  const changed = Boolean(task.changedPaths?.length || (!task.changedPaths && task.possibleMutations));
  if (!report && !task.observedChecks?.length && task.execution === "completed") {
    const why = (line: string, status: string, detail?: string, action?: string) =>
      add("why", line, { kind: "not-verified", status, ...(detail ? { detail } : {}), ...(action ? { actions: [action] } : {}) });
    const only = (what: string) => `only ${what} changed${task.changedPaths?.length ? ` (${pathList(task.changedPaths, safe, false)})` : ""}`;
    if (task.autoSkipped === "no-checks") {
      if (options.checksHintShown) why("– Not verified — no checks set up", "Not verified", "no checks set up");
      else why(NO_CHECKS_LINE, "Not checked", "no tests yet", '"add tests"');
    }
    else if (task.autoSkipped === "app-data") why(`– Checks skipped — ${only("a running app's database files")}; ${slash("/verify")} runs them anyway.`, "Checks skipped", only("a running app's database files"), slash("/verify"));
    else if (task.autoSkipped === "docs-only") why(`– Checks skipped — ${only("documentation")}; ${slash("/verify")} runs them anyway.`, "Checks skipped", only("documentation"), slash("/verify"));
    else if (task.autoSkipped === "not-covered") why("– Not verified — no configured check covers the changed files.", "Not verified", "no configured check covers the changed files");
    else if (changed && task.verificationMode === "off") {
      why(`– Not verified — checks are off for this run. ${options.surface === "one-shot" ? "Run casper --verify to have Casper check." : "Run /verify to check these changes."}`,
        "Not verified", "checks are off for this run", options.surface === "one-shot" ? "casper --verify" : "/verify");
    } else if (changed && task.verificationMode === "offer") why(`– Not verified — run ${slash("/verify")} to check these changes.`, "Not verified", undefined, slash("/verify"));
  }

  if (task.appSmoke) add("checks", appSmokeLine(task.appSmoke, safe));
  if (report?.smoke) add("checks", smokeLine(report.smoke, task.services, safe));
  else if (report?.smokeSkipped) add("checks", `– Smoke not run: ${report.smokeSkipped}`);
  // Page text is already scrubbed and cut short by the page check.
  if (report?.pages) for (const line of formatPageReport(report.pages).flatMap((line) => line.split("\n")).map(safe)) add("checks", line);
  else if (report?.pagesSkipped) add("checks", `– Pages not checked: ${report.pagesSkipped}`);
  for (const note of task.pageNotes ?? []) add("notes", safe(note));
  if (task.pagesShown) add("notes", `– ${pagesShownText(task.pagesShown)}`);
  if (task.partsNotReviewed?.length) add("notes", `– Not reviewed: ${formatNotReviewed(task.partsNotReviewed, safe)}`);
  if (task.crewChecks) add("checks", `– ${crewChecksText(task.crewChecks)}`);
  if (task.security) add("checks", `– Security tools: ${securityText(task.security)} (what the tools found; not proof the code has no problems)`);
  for (const remote of task.remoteChanges ?? []) {
    const host = safe(remote.host);
    if (remote.changes.length) {
      const changes = remote.changes.map(safe).join("; ");
      add("devices", `– Changed on ${host} (from the commands Casper saw): ${changes}`, { name: host, detail: changes });
    } else add("devices", `– Ran commands on ${host} over ssh; ${REMOTE_UNKNOWN}`, { name: host, detail: `ran commands over ssh; ${REMOTE_UNKNOWN}` });
  }
  for (const remote of task.remoteNotRun ?? []) {
    add("devices", `– Not run on ${safe(remote.host)}: ${remoteNotRunText(remote.commands)}`, { name: safe(remote.host), detail: remoteNotRunText(remote.commands) });
  }
  // Something to do: a warning, said before the notes.
  if (task.secretInCommand) add("open", `⚠ ${SECRET_IN_COMMAND}`);
  if (task.secretInFiles?.length) add("open", `– ${secretInFilesText(task.secretInFiles, safe)}`);
  // Only the exception is said: a task whose shell commands and checks ran with your own permissions.
  if (task.sandbox && !task.sandbox.held) add("notes", sandboxOffLine(safe(task.sandbox.reason)));
  else if (task.sandbox && labRan(report)) add("notes", `– Lab checks ran outside the sandbox (${LAB_OUTSIDE_WHY})`);
  for (const folder of task.outsideWrites ?? []) add("changed", `– Wrote outside the project: ${safe(folder)} (you allowed it; no undo copy)`);
  for (const folder of task.outsideAllowed ?? []) add("notes", `– Allowed writes outside the project: ${safe(folder)} (no undo copy)`);
  for (const risky of task.riskyLines ?? []) add("config", `– Risky config lines (not a check): ${safe(risky.file)}:${risky.line} ${safe(risky.text)} — ${risky.reason}`);
  if (task.riskyMore) add("config", `– Risky config lines (not a check): and ${task.riskyMore} more`);
  if (task.browser) {
    // Checks the AI withdrew as written wrong: named with its reason, never counted for or against the result.
    const withdrawn = task.browser.checks.filter((check) => check.status === "withdrawn");
    const checks = countedBrowserChecks(task.browser.checks);
    const failed = checks.filter((check) => check.status === "fail").map((check) => safe(check.name));
    // The answer may say the checks passed; the receipt is Casper's record, so it says where they differ.
    const claimed = task.browserClaimed ? " — the answer above says they passed" : "";
    if (task.browser.status === "pass") fold("checks", `✓ Browser checks passed (${checks.length})`, `browser checks passed (${checks.length})`);
    else if (task.browser.status === "fail") add("checks", `✗ Browser checks failed: ${failed.join(", ")}${claimed}`);
    else {
      // Incomplete: count what passed, name what did not finish, and say why a pass does not count
      // (a later edit or command made it stale, or Casper can't tie it to the final files).
      const passed = checks.filter((check) => check.status === "pass");
      const open = checks.filter((check) => check.status !== "pass").map((check) => safe(check.name));
      const stale = passed.filter((check) => check.freshness === "stale").length;
      const untied = passed.filter((check) => check.freshness === "unavailable").length;
      // "all" and "them" only when they cover every check, never one that did not finish.
      const total = checks.length, every = (count: number) => count === total;
      const notes = [open.length ? `not finished: ${open.join(", ")}` : "",
        stale ? `${every(stale) ? "all" : stale} ran before a later edit or command (replay to count)` : "",
        untied ? `Casper can't tie ${every(untied) ? "them" : `${untied} of them`} to the final files` : ""].filter(Boolean);
      if (passed.length) add("checks", `– Browser checks: ${passed.length} of ${checks.length} passed${notes.length ? `; ${notes.join("; ")}` : ""}`);
      else if (checks.length || claimed) add("checks", claimed ? `– Browser checks did not finish${claimed}; Casper saw no passing browser check` : "– Browser checks incomplete");
    }
    if (withdrawn.length) add("checks", `– ${withdrawn.length} ${withdrawn.length === 1 ? "check" : "checks"} withdrawn by the AI: ${withdrawn
      .map((check) => `${safe(check.name)}${check.withdrawn ? ` (${safe(check.withdrawn)})` : ""}`).join(", ")}`);
  }
  const verdict = withVerdict(task, lines, options, info);
  return { lines: verdict.lines, undo: undoLines(task, options, safe), folds, info, ...(verdict.short ? { short: verdict.short } : {}) };
}

/** "changed a.ts, b.ts" for a few files, "12 files changed" past three. */
function changedShort(paths: string[], safe: (text: string) => string): string {
  return paths.length <= 3 ? `changed ${paths.map(safe).join(", ")}` : `${paths.length} files changed`;
}

/** The full no-checks line, shown once per session; later receipts say it short. */
export const NO_CHECKS_LINE = '– Not checked — no tests yet. Say "add tests".';

/** The undo reason when a task changed nothing: nothing to say on the receipt. */
export const UNDO_NOTHING_CHANGED = "no files changed";

/** The undo reason in a folder too big to list: the "Changes unknown: not a project folder" line already says it. */
export const UNDO_NOT_PROJECT = "not a project folder";

/** The files undo can't put back that a receipt names: ones not named before, up to the limit. */
export function undoPathsShown(task: Pick<TaskResult, "undo">, undoNamed?: ReadonlySet<string>): string[] {
  if (!task.undo?.available) return [];
  return (task.undo.left ?? []).filter((entry) => !undoNamed?.has(entry.path)).slice(0, RECEIPT_PATH_LIMIT).map((entry) => entry.path);
}

/** The receipt's last lines about undo: what it can't put back, why it is not available, and (one-shot) the commands.
 * The interactive receipt's "Next: 1 Show diff · 2 Undo" row is printed by the app. */
function undoLines(task: TaskResult, options: ReceiptOptions, safe: (text: string) => string): ReceiptItem[] {
  const undo = task.undo;
  if (!undo) return [];
  // A folder that is not a project is said once, on the "Changes unknown" line.
  if (!undo.available) {
    if (undo.reason === UNDO_NOTHING_CHANGED || undo.reason === UNDO_NOT_PROJECT) return [];
    const reason = safe(undo.reason).replace(/\.$/, "");
    return [{ line: `– Undo not available: ${reason}`, section: "undo", kind: "undo", status: "Undo not available", detail: reason }];
  }
  const items: ReceiptItem[] = [];
  const left = undo.left?.filter((entry) => !options.undoNamed?.has(entry.path)) ?? [];
  if (left.length) {
    const named = `${left.slice(0, RECEIPT_PATH_LIMIT).map((entry) => `${safe(entry.path)} (${safe(entry.why)})`).join(", ")}${left.length > RECEIPT_PATH_LIMIT ? ` … +${left.length - RECEIPT_PATH_LIMIT} more` : ""}`;
    items.push({ line: `– Undo can't put back: ${named}`, section: "undo", kind: "undo", status: "Undo can't put back", detail: named });
  }
  if (options.surface === "one-shot") {
    const cd = options.folder ? `--cd ${shellFolder(safe(options.folder))} ` : "";
    const n = task.receipt ? ` ${task.receipt}` : "";
    items.push({ line: `Undo: casper ${cd}/undo${n} · Diff: casper ${cd}/diff${n}`, section: "next", kind: "undo", actions: [`casper ${cd}/undo${n}`, `casper ${cd}/diff${n}`] });
  }
  return items;
}

/** Line 1 of every receipt: what the run proved, in one line. "Verified" means the checks passed on the
 * final files and a test fails without the change (ADR 0001); anything less says why. The JSON outcome
 * "verified" means exactly this line. A reason already on its own line moves up instead of repeating. */
export function receiptVerdict(task: TaskResult, options: ReceiptOptions = {}): string | undefined {
  return formatReceipt(task, options).split("\n")[0] || undefined;
}

function withVerdict(task: TaskResult, body: string[], options: ReceiptOptions, info: Map<string, LineInfo>): { lines: string[]; short?: string } {
  const safe = lineText;
  // Line 1 in parts: its name, the reason after " — " (without a closing "Run …" or "Say …" sentence) and its commands.
  const head = (line: string, status: string, parts: { detail?: string; actions?: string[] } = {}): string => {
    const detail = parts.detail ?? (line.includes(" — ") ? line.slice(line.indexOf(" — ") + 3).replace(/\.(?: (?:Run|Say) .*)?$/, "") : undefined);
    info.set(line, { section: "verdict", kind: "verdict", status, ...(detail ? { detail } : {}), ...(parts.actions?.length ? { actions: parts.actions } : {}) });
    return line;
  };
  const promote = (prefix: string, fallback: string, status: string): string[] => {
    const index = body.findIndex((line) => line.startsWith(prefix));
    if (index < 0) return [head(fallback, status), ...body];
    const moved = body[index]!, was = info.get(moved);
    return [head(moved, status, { ...(moved.includes(" — ") ? {} : { detail: was?.detail }), actions: was?.actions }), ...body.slice(0, index), ...body.slice(index + 1)];
  };
  const report = task.verification;
  // The verdict lines for checks that passed are the same whatever the outcome calls them: "✓ Verified" only with
  // proof, "✓ Checks passed" with nothing changed, "– Checks passed — not proven" otherwise.
  const outcome = report?.status === "pass" && checksPassed(report, task) && !["cancelled", "failed", "incomplete"].includes(taskOutcome(report, task))
    ? "passed" : taskOutcome(report, task);
  const changed = Boolean(task.changedPaths?.length || task.changedDuringChecks?.length || (!task.changedPaths && task.possibleMutations));
  const failedChecks = (report?.results ?? []).filter((result) => result.status === "fail" && result.kind !== "report")
    .map((result) => `${result.name} ${result.ended === "timeout" ? "timed out" : result.ended === "no_start" ? "could not start" : result.ended === "blocked" ? "was blocked by the sandbox" : "failed"}`);
  // Only unfinished checks: the change was not tested, which is not the same as the code being wrong.
  const onlyUnfinished = failedChecks.length > 0 && report!.results.every((result) => result.status !== "fail" || result.kind === "report" || result.ended);
  const notChecked = (): string[] => {
    // A timeout is said once here, with its limit and how to run it again; its own check line is left out.
    const failing = report!.results.filter((result) => result.status === "fail" && result.kind !== "report");
    const timedOut = failing.filter((result) => result.ended === "timeout");
    const what = failing.map((result, index) => {
      const limit = result.ended === "timeout" ? /^Timed out after (\d+)ms$/.exec(result.reason ?? "") : null;
      return limit ? `${result.name} timed out after ${duration(Number(limit[1]))}` : failedChecks[index]!;
    });
    const again = timedOut.map((result) => options.surface === "one-shot" ? `casper "/verify ${result.name}"` : `/verify ${result.name}`);
    const reason = `${what.join(", ")}, so the change was not tested`;
    return [head(`✗ Not checked — ${reason}${again.length ? `; ${again.join(", ")} runs it again` : ""}`, "Not checked", { detail: reason, actions: again }),
      ...body.filter((line) => !timedOut.some((result) => line.startsWith(`✗ ${result.name} timed out`)))];
  };
  let lines: string[];
  let short: string | undefined;
  switch (outcome) {
    case "cancelled":
      lines = [head("✗ Stopped — cancelled; changes already made are kept", "Stopped"), ...body]; break;
    case "failed":
      if (task.execution === "failed") {
        // Casper checked the edits the model left: say how they fared, then what to do next.
        const checked = !report?.results.length ? "" : failedChecks.length ? `; on those changes ${failedChecks.join(", ")}` : "; the checks pass on those changes";
        const nextStep = modelErrorNext(task.modelError, options.surface === "one-shot")
          ?? (options.surface === "one-shot" ? "casper --model <provider/id> \"…\" to try another model" : "/model to try another model, then ask again");
        const next = `– Next: ${nextStep}`;
        info.set(next, { section: "next", detail: nextStep });
        const verdict = task.changedPaths?.length === 0 && !task.possibleMutations
          ? "✗ Failed — the model run failed before changing any files" : `✗ Failed — the model run failed; changes already made are kept${checked}`;
        lines = [head(verdict, "Failed"), ...body, next];
      }
      else if (onlyUnfinished) lines = notChecked();
      // Every failing check failed on the files from before too, and the user left it: the change did not cause it.
      else if (failedChecks.length && failingBeforeOnly(report)) {
        lines = [head(`– Not caused by this change — ${report!.failingBefore!.join(", ")} already failed before it; left as it is`, "Not caused by this change"), ...body];
      }
      else if (failedChecks.length) lines = [head(`✗ Failed — ${failedChecks.join(", ")}`, "Failed"), ...body];
      else if (report?.pages?.status === "fail") lines = [head(`✗ Failed — ${safe(pageFailureSummary(report.pages) ?? "a page failed")}`, "Failed"), ...body];
      else if (task.appSmoke?.status === "fail") lines = [head(`✗ Failed — app smoke: ${safe(redactPreview(task.appSmoke.reason ?? "the request failed"))}`, "Failed"), ...body];
      else if (report?.status === "blocked") lines = [head(`✗ Failed — checks stopped${report.reason ? `: ${safe(report.reason).replace(/\.$/, "").toLowerCase()}` : ""}`, "Failed"), ...body];
      else lines = [head("✗ Failed — browser checks failed", "Failed"), ...body];
      break;
    case "incomplete": {
      // The checks never ran to the end (timed out, could not start, blocked by the sandbox): name them, as when failed.
      if (onlyUnfinished && report?.status === "incomplete" && task.spendLimit === undefined && task.turnLimit === undefined) { lines = notChecked(); break; }
      const stopped = task.spendLimit !== undefined || task.turnLimit !== undefined;
      const line = task.spendLimit !== undefined
        ? `– Incomplete — stopped at ${formatCost(task.spendLimit.spent)}, the ${formatLimit(task.spendLimit.limit)} limit for one task (spend.pauseAt); changes so far are kept; ${options.surface === "one-shot" ? "casper --continue" : "send another request"} to go on`
        : task.turnLimit !== undefined
        ? `– Incomplete — stopped after ${task.turnLimit} ${task.turnLimit === 1 ? "turn" : "turns"} (--max-turns); changes so far are kept; ${options.surface === "one-shot" ? "casper --continue" : "send another request"} to go on`
        : task.cleanup?.some(incident => incident.state !== "stopped") ? "– Incomplete — owned process cleanup is unconfirmed"
        : (task.appSmoke?.status === "not-run" && !task.appSmoke.deferred && !task.appSmoke.nothingToStart) || task.appSmoke?.cleanup === "unconfirmed" ? "– Incomplete — app smoke did not finish"
        : task.remoteNotRun?.length ? `– Incomplete — ${remoteNotRunVerdict(task.remoteNotRun, safe)}`
        : task.wroteToolCallAsText ? "– Did not act — the model wrote a tool call as text instead of using it"
        : report?.reason === NO_CHECKS_FOUND && !report.results.length ? NO_CHECKS_LINE
        // The AI withdrew every browser check it recorded: nothing is left to show the page works.
        : task.browser?.status === "incomplete" && report?.status !== "incomplete" && task.browser.checks.length > 0
          && !countedBrowserChecks(task.browser.checks).length ? "– Incomplete — every browser check was withdrawn; none is left to show the page works"
        // Every browser check ran and passed, but not on the final files: say that, not "not every check ran".
        : task.browser?.status === "incomplete" && report?.status !== "incomplete" && countedBrowserChecks(task.browser.checks).length > 0
          && countedBrowserChecks(task.browser.checks).every((check) => check.status === "pass") ? `– Incomplete — ${browserPassedVerdict(countedBrowserChecks(task.browser.checks))}`
        : "– Incomplete — not every check ran";
      lines = [head(line, line === NO_CHECKS_LINE ? "Not checked" : line.startsWith("– Did not act") ? "Did not act" : "Incomplete", {
        actions: line === NO_CHECKS_LINE ? ['"add tests"'] : stopped && options.surface === "one-shot" ? ["casper --continue"] : [] }), ...body];
      break;
    }
    case "verified":
    case "passed": {
      const proof = task.proof;
      if (proof?.status === "proven" && provesChange(proof)) {
        const weak = loadFailure(proof);
        lines = [head(weak ? "✓ Verified — the checks pass; without the change the tests could not even load"
          : "✓ Verified — the checks pass, and the tests fail without the change", "Verified"), ...body];
        if (!weak) short = "✓ Verified";
      } else if (!changed) { lines = [head(task.changedPaths ? "✓ Checks passed — no files changed" : "✓ Checks passed", "Checks passed"), ...body]; short = "✓ Checks passed"; }
      else {
        const why = proof?.status === "unavailable" ? proof.reason
          : proof?.status === "proven" ? `without the change ${proof.check} ${proof.without.ended === "timeout" ? "timed out" : "could not start"}, so it did not show the old code failing`
          : task.proofSkipped ?? "Casper did not compare the tests with and without the change";
        const reason = safe(why).replace(/\.$/, "");
        lines = [head(`– Checks passed — not proven: ${reason}`, "Checks passed · not proven", { detail: reason }), ...body];
      }
      break;
    }
    case "not_verified":
      lines = body.includes(NO_CHECKS_LINE) ? promote(NO_CHECKS_LINE, NO_CHECKS_LINE, "Not checked") : promote("– Not verified", `– Not verified — ${notVerifiedReason(task)}`, "Not verified"); break;
    case "unchanged":
      lines = body.length ? promote("– No files changed", "– No files changed", "No files changed") : body; break;
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

/** The completion smoke is deliberately a narrow observation, separate from test/proof evidence. */
function appSmokeLine(report: AppSmokeReport, text: (text: string) => string): string {
  const safe = (value: string) => text(redactPreview(value));
  const mark = report.status === "pass" ? "✓" : report.status === "fail" ? "✗" : "–";
  const status = report.status === "pass" ? "passed" : report.status === "fail" ? "failed" : report.status === "off" ? "not run (off)" : "not run";
  const request = report.path ? ` · ${safe(report.method ?? "GET")} ${safe(report.path)}${report.httpStatus !== undefined ? ` → HTTP ${report.httpStatus}` : ""}` : "";
  const cleanup = report.cleanup === "stopped" ? "; app stopped" : report.cleanup === "preserved" ? "; existing service left running"
    : report.cleanup === "unconfirmed" ? "; cleanup unconfirmed" : "";
  return `${mark} App smoke: ${status}${report.label ? ` · ${safe(report.label)}` : ""}${request}${report.reason ? ` — ${safe(report.reason)}` : ""}${cleanup}${report.reused ? " (reused final-file check)" : ""}`;
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
  const mark = smoke.status === "fail" ? "✗" : smoke.status === "pass" && smoke.checks.some((check) => check.evidence) ? "✓" : "–";
  return `${mark} ${names.length === 1 ? "Service" : "Services"} ${where}; smoke ${passed}/${smoke.checks.length} passed`
    + `${failed ? `; failed: ${failed}` : ""}${incomplete ? `; incomplete: ${incomplete}` : ""}${smoke.reason ? `; ${safe(smoke.reason).replace(/\.$/, "")}` : ""}${crashNotes(smoke, safe).map((note) => `; ${note}`).join("")}${model.length ? ` (model-declared, run by Casper: ${model.join("; ")})` : ""}`;
}

function reviewLine(review: RequirementsReview, safe: (text: string) => string): string {
  const open = "open" in review && review.open.length ? `⚠ The model's review says not done: ${review.open.map(safe).join("; ")}` : "";
  // A review cut off by its own budget claims nothing complete; admitted gaps still stand.
  if (review.incomplete) {
    return [`– The model's review stopped at its ${ROUND_MAX_TURNS}-turn budget (its own claim so far, not checked by Casper)`, open].filter(Boolean).join("\n");
  }
  if ("missing" in review) return "– The model's review returned no checklist";
  if (open) return open;
  // The delta answer: fixed holds only the gaps the review added tests or fixes for. A count short of
  // its total is not "all covered", even with no open line listed (the open lines still decide the outcome).
  if ("fixed" in review) {
    const fixed = review.fixed.length ? `${review.fixed.length} ${review.fixed.length === 1 ? "gap" : "gaps"} fixed` : "no gaps found";
    const count = review.total === undefined ? "all requirements" : review.covered !== undefined && review.covered < review.total
      ? `${review.covered} of ${review.total} requirements` : `all ${review.total} requirements`;
    return `– The model's review: ${count} covered (${fixed}; its own claim, not checked by Casper)`;
  }
  return `– The model's review: all ${review.done.length} requirements covered (its own claim, not checked by Casper)`;
}

function acceptanceLine(acceptance: NonNullable<TaskResult["acceptance"]>, safe: (text: string) => string): string {
  if (acceptance.status === "pass") return "✓ Independent acceptance: tests written from the request alone pass";
  const names = acceptance.unconfirmed?.map(safe).join("; ");
  if (acceptance.status === "fail" && acceptance.mode === "warn") {
    return names ? `⚠ Not confirmed by tests written from the request: ${names}` : "⚠ Independent acceptance: tests written from the request alone fail";
  }
  if (acceptance.status === "fail") return `✗ Independent acceptance: tests written from the request alone fail${names ? `: ${names}` : ""}`;
  return `– Independent acceptance not run: ${safe(acceptance.reason ?? "unknown reason")}`;
}

/** The error that kept the tests from loading without the change (an import of what the change adds). */
function loadFailure(proof: ChangeProof): RegExpExecArray | null {
  if (proof.status !== "proven" || proof.without.ended !== "fail") return null;
  return /ImportError|ModuleNotFoundError|errors? (?:during|while) collect|error collecting|Cannot find module|is not exported|SyntaxError|NameError|has no exported member/i
    .exec(proof.without.output ?? "");
}

/** The proof's line and its parts: "Proven", "Proven, weakly" or "Not proven", and what showed it. */
function proofLine(proof: ChangeProof, safe: (text: string) => string): { line: string } & Parts {
  const say = (mark: string, status: string, detail: string, separator = ": ") => ({ line: `${mark} ${status}${separator}${detail}`, kind: "proof" as const, status, detail });
  if (proof.status === "proven") {
    const { exitCode, ended, reason } = proof.without;
    // Tests that could not even load without the change (a missing function to import) are weaker evidence
    // than a failing assertion: say which it was.
    const load = loadFailure(proof);
    if (ended === "fail" && load) return say("✓", "Proven, weakly", `without this change ${proof.check} could not load (exit ${exitCode}, ${load[0]}), and it passes with the change`);
    if (ended === "fail") return say("✓", "Proven", `${proof.check} fails without this change (exit ${exitCode}) and passes with it`);
    // A timeout, crash or missing command shows the old code did not pass, not that a test caught it.
    const timeout = /^Timed out after (\d+)ms$/.exec(reason ?? "");
    const how = ended === "timeout" ? `timed out${timeout ? ` after ${duration(Number(timeout[1]))}` : ""}`
      : ended === "crash" ? `crashed or was killed (exit ${exitCode})` : `could not start (exit ${exitCode})`;
    return say("✓", "Proven, weakly", `${proof.check} passes with this change; without it ${proof.check} ${how} instead of failing`);
  }
  if (proof.status === "unproven") {
    return say("⚠", "Not proven", `${proof.check} passes without this change too${proof.testsChanged ? "; the changed tests do not check it" : ", and no test was added or changed"}`);
  }
  return say("–", "Not proven", safe(proof.reason).replace(/\.$/, ""), " — ");
}

/** A check's line and its parts: the check, what happened, the evidence (exit, command, reason), its time, and the
 * command that acts on it. */
function checkLine(result: VerificationResult, safe: (text: string) => string, slash: (command: string) => string, repaired = false): { line: string } & Parts {
  const name = result.name;
  const took = result.kind !== "report" && (result.status === "pass" || result.status === "fail") ? elapsed(result.durationMs) : "";
  const say = (line: string, status: string, detail?: string, action?: string) =>
    ({ line, kind: "check" as const, name, status, ...(detail ? { detail } : {}), ...(action ? { actions: [action] } : {}), ...(took ? { time: took } : {}) });
  // A report is shown for reading: never a pass, a fail or a reason the change is not verified.
  if (result.kind === "report") return say(`– ${name}  ${reportText(result)} (a diff, not a pass/fail check)`, "report", reportText(result));
  // A named check that could not run (a missing tool, a lab check) says why in its own words.
  if (result.status === "skip" && !isBuiltinCheck(name)) {
    const reason = safe(result.reason ?? "skipped").replace(/\.$/, "");
    return say(`– Not verified — ${name} not run: ${reason}`, "not run", reason);
  }
  if (result.status === "skip") {
    const ask = name === "test" ? '"add tests"' : `"set up ${name}"`;
    return result.command ? say(`– Not verified — ${name} was skipped.`, "was skipped") : say(`– Not verified — ${name} has no command here. Say ${ask}.`, "has no command here", undefined, ask);
  }
  if (result.status === "pass") {
    if (result.freshness === "stale") {
      return say(`– Not verified — stale: files changed after the last passing ${name}. Run ${slash(`/verify ${name}`)}.`, "stale", `files changed after the last passing ${name}`, slash(`/verify ${name}`));
    }
    // A reused pass did not run again: the time shown is the earlier run's, so the receipt says so.
    const how = [result.label ? safe(result.label) : "", result.command ? safe(result.command) : ""].filter(Boolean).join(" · ");
    const inside = how && took ? `${how}, ${took}` : how || took;
    return say(`✓ ${name} passed${result.reused ? " earlier in this task, reused" : ""}${inside ? ` (${inside})` : ""}`, result.reused ? "passed earlier in this task, reused" : "passed", how);
  }
  const timeout = /^Timed out after (\d+)ms$/.exec(result.reason ?? "");
  // Unfinished checks are not the code failing: Casper does not repair them, so it does not offer to.
  if (result.ended === "timeout") {
    const after = timeout ? `after ${duration(Number(timeout[1]))}` : undefined;
    return say(`✗ ${name} timed out${after ? ` ${after}` : ""} — it did not finish, so it was not checked; ${slash(`/verify ${name}`)} to run it again (a session offers more time)`,
      "timed out", after, slash(`/verify ${name}`));
  }
  // The sandbox refused something the check tried: the same words the AI sees, so it does not retry it.
  if (result.ended === "blocked") {
    const reason = safe(result.reason ?? "blocked by the sandbox");
    return say(`✗ ${name} — ${reason}`, "blocked", reason);
  }
  // Its own program isn't on this computer: the config is fine, so the line says what to install.
  const missing = missingProgram(result);
  if (missing) return say(`✗ ${name} could not start — ${missingProgramLine(missing)}; install it, then ${slash(`/verify ${name}`)}`, "could not start", missingProgramLine(missing), slash(`/verify ${name}`));
  if (result.ended === "no_start") {
    const why = typeof result.exitCode === "number" ? `exit ${result.exitCode}` : safe(result.reason ?? "no exit status").replace(/\.$/, "").toLowerCase();
    return say(`✗ ${name} could not start (${why}) — check verify.${isBuiltinCheck(name) ? "" : "checks."}${name} in .casper/project.yaml`, "could not start", why);
  }
  const why = typeof result.exitCode === "number" ? `exit ${result.exitCode}`
    : timeout ? `timed out after ${duration(Number(timeout[1]))}`
    : result.reason ? safe(result.reason).replace(/\.$/, "").toLowerCase()
    : result.signal ? `stopped by ${safe(result.signal)}` : "no exit status";
  // A lab check touches lab devices: no one-key repair offer, only running it again (it asks first).
  // Once you chose "Ask the model to fix it", the repair line above says so; the receipt never says it did not.
  if (result.kind === "lab") {
    return say(`✗ ${name} failed on the lab (${why}) — log above;${repaired ? "" : " Casper did not ask the model to fix it."} ${slash(`/verify ${name}`)} runs it again (asks first)`,
      "failed on the lab", why, slash(`/verify ${name}`));
  }
  return say(`✗ ${name} failed (${why}) — log above; ${slash(`/verify repair ${name}`)} to fix`, "failed", why, slash(`/verify repair ${name}`));
}

const duration = formatDuration;
/** How long a check took, left out under a second ("0.0s everywhere" said nothing). */
const elapsed = (ms: number) => ms < 1000 ? "" : formatDuration(ms);

/** The line shown the moment a check Casper runs finishes, before the receipt: "✓ typecheck · 5.9s". */
export function liveCheckLine(result: VerificationResult): string {
  const name = result.name;
  if (result.kind === "report") return `– ${name} · ${reportText(result)} (a diff, not a pass/fail check)`;
  if (result.status === "skip" && !isBuiltinCheck(name)) return `– ${name} · not run${result.reason ? `: ${lineText(result.reason)}` : ""}`;
  if (result.status === "skip") return `– ${name} · skipped${result.command ? "" : ", no command"}`;
  // A lab check's own label ("dry run not guaranteed") stays beside its result.
  const label = result.label ? `${lineText(result.label)} · ` : "";
  if (result.status === "pass") return result.reused ? `✓ ${name} · passed earlier, reused` : `✓ ${name}${[label.replace(/ · $/, ""), elapsed(result.durationMs)].filter(Boolean).map((part) => ` · ${part}`).join("")}`;
  const timeout = /^Timed out after (\d+)ms$/.exec(result.reason ?? "");
  if (result.ended === "timeout") return `✗ ${name} · timed out${timeout ? ` after ${duration(Number(timeout[1]))}` : ""}`;
  if (result.ended === "no_start") return `✗ ${name} · could not start${typeof result.exitCode === "number" ? ` (exit ${result.exitCode})` : ""}`;
  if (result.ended === "blocked") return `✗ ${name} · ${lineText(result.reason ?? "blocked by the sandbox")}`;
  const why = typeof result.exitCode === "number" ? `exit ${result.exitCode}` : result.signal ? `stopped by ${result.signal}`
    : result.reason ? lineText(result.reason) : "no exit status";
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
  const windows = process.platform === "win32";
  if ((windows ? /^[\w.\\/~:@%+=,-]+$/ : /^[\w./~:@%+=,-]+$/).test(folder)) return folder;
  // cmd and PowerShell take the folder in double quotes with its backslashes as they are (a Windows path has no ").
  if (windows) return `"${folder}"`;
  const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
  return folder.startsWith("~/") ? `~/${quote(folder.slice(2))}` : quote(folder);
}
