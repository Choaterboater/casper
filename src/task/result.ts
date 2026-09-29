import { formatDuration, formatVerificationReport, type VerificationReport, type VerificationResult } from "../verify/evidence";
import type { ProjectCommand } from "../project/model";
import type { BrowserReport } from "../browser/scenario";
import type { ServiceState } from "../services/manager";
import type { SmokeReport } from "../services/smoke";
import type { AutoCheckSkip, VerificationMode } from "../verify/mode";
import type { ChangeProof } from "../verify/proof";
import type { AcceptanceResult } from "../verify/acceptance";
import { ROUND_MAX_TURNS, type RequirementsReview } from "./review";

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
  /** Checking came from Casper's default, not a --verify flag or `verification.mode`. */
  verificationDefaulted?: true;
  /** Why auto mode ran no check after the model turn. */
  autoSkipped?: AutoCheckSkip;
  /** `--max-turns` stopped the model after this many turns, before it finished. */
  turnLimit?: number;
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
    // Smoke alone verifies only with evidence: a model check that passed before the change is an observation.
    const observationsOnly = !verification!.results.length && !verification!.smoke?.checks.some((check) => check.evidence);
    const rejected = task?.acceptance?.status === "fail" && task.acceptance.mode === "verdict";
    return stale || task?.proof?.status === "unproven" || admittedGaps || observationsOnly || rejected ? "not_verified" : "verified";
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
      // Casper was asked (flag or configuration) to verify changed files and had nothing to run: not a
      // pass. Checking only by default in a project with no checks is not a failure of the run.
      return task?.autoSkipped === "no-checks" && !task.verificationDefaulted ? 2 : 0;
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
  if (task.acceptance) lines.push(receiptLine("acceptance", acceptanceLine(task.acceptance, safe)));
  if (task.review) lines.push(receiptLine("review", reviewLine(task.review, safe).replace(/\n/g, "; ")));
  if (report?.smoke) {
    if (task.services?.length) lines.push(receiptLine("services", task.services.map((service) => `${safe(service.name)} ${service.state}${service.origin ? ` ${service.origin}` : ""}`).join("; ")));
    lines.push(receiptLine("smoke", `${report.smoke.status}: ${report.smoke.checks.map((check) => `${safe(check.name)} [${check.source}] ${safe(check.service)} ${check.request.method} ${safe(check.request.path)}: ${check.status}`
      + `${check.actual ? ` (${check.actual.status})` : ""}${check.baseline ? `, baseline ${check.baseline}${check.baselineAfterEdits ? " (after edits)" : ""}` : ""}${check.status === "pass" && !check.evidence ? ", observation only" : ""}`
      + `${check.status !== "pass" && check.reason ? ` — ${safe(check.reason)}` : ""}`).join("; ")}.${report.smoke.reason ? ` ${safe(report.smoke.reason)}` : ""}${crashNotes(report.smoke, safe).map((note) => ` ${note}.`).join("")} Model checks are the model's expectations, run by Casper.`));
  }
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
  if (task.acceptance) lines.push(acceptanceLine(task.acceptance, safe));
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

  if (report?.smoke) lines.push(smokeLine(report.smoke, task.services, safe));
  else if (report?.smokeSkipped) lines.push(`• Smoke not run: ${report.smokeSkipped}`);
  if (task.browser) {
    const failed = task.browser.checks.filter((check) => check.status === "fail").map((check) => safe(check.name));
    lines.push(task.browser.status === "pass" ? `✓ Browser checks passed (${task.browser.checks.length})`
      : task.browser.status === "fail" ? `✗ Browser checks failed: ${failed.join(", ")}` : "• Browser checks incomplete");
  }
  return withVerdict(task, lines, options);
}

/** Line 1 of every receipt: what the run proved, in one line. "Verified" means the checks passed on the
 * final files and a test fails without the change (ADR 0001); anything less says why. The JSON outcome
 * and exit code are unchanged by it. A reason already on its own line moves up instead of repeating. */
export function receiptVerdict(task: TaskResult, options: ReceiptOptions = {}): string | undefined {
  return formatReceipt(task, options).split("\n")[0] || undefined;
}

function withVerdict(task: TaskResult, body: string[], options: ReceiptOptions): string {
  const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
  const promote = (prefix: string, fallback: string): string[] => {
    const index = body.findIndex((line) => line.startsWith(prefix));
    return index < 0 ? [fallback, ...body] : [body[index]!, ...body.slice(0, index), ...body.slice(index + 1)];
  };
  const report = task.verification;
  const outcome = taskOutcome(report, task);
  const changed = Boolean(task.changedPaths?.length || task.changedDuringChecks?.length || (!task.changedPaths && task.possibleMutations));
  const failedChecks = (report?.results ?? []).filter((result) => result.status === "fail")
    .map((result) => `${result.name} ${result.ended === "timeout" ? "timed out" : result.ended === "no_start" ? "could not start" : "failed"}`);
  let lines: string[];
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
      else if (failedChecks.length && report!.results.every((result) => result.status !== "fail" || result.ended)) {
        lines = [`✗ Not checked — ${failedChecks.join(", ")}, so the change was not tested`, ...body];
      } else if (failedChecks.length) lines = [`✗ Failed — ${failedChecks.join(", ")}`, ...body];
      else if (report?.status === "blocked") lines = [`✗ Failed — checks stopped${report.reason ? `: ${safe(report.reason).replace(/\.$/, "").toLowerCase()}` : ""}`, ...body];
      else lines = ["✗ Failed — browser checks failed", ...body];
      break;
    case "incomplete":
      lines = [task.turnLimit !== undefined
        ? `• Incomplete — stopped after ${task.turnLimit} ${task.turnLimit === 1 ? "turn" : "turns"} (--max-turns); changes so far are kept; ${options.surface === "one-shot" ? "casper --continue" : "send another request"} to go on`
        : "• Incomplete — not every check ran", ...body];
      break;
    case "verified": {
      const proof = task.proof;
      if (proof?.status === "proven") lines = [loadFailure(proof) ? "✓ Verified — the checks pass; without the change the tests could not even load"
        : "✓ Verified — the checks pass, and the tests fail without the change", ...body];
      else if (!changed) lines = [task.changedPaths ? "✓ Checks passed — no files changed" : "✓ Checks passed", ...body];
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
  return lines.join("\n");
}

function notVerifiedReason(task: TaskResult): string {
  const report = task.verification;
  if (report?.results.some((result) => result.status === "pass" && result.freshness === "stale")) return "files changed after the checks passed";
  if (task.proof?.status === "unproven") return "the tests pass without the change too";
  if (task.review && "open" in task.review && task.review.open.length) return "the model's review lists unfinished items";
  if (task.acceptance?.status === "fail" && task.acceptance.mode === "verdict") return "tests written from the request fail";
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

function checkLine(result: VerificationResult, safe: (text: string) => string, slash: (command: string) => string): string {
  const name = result.name;
  if (result.status === "skip") {
    return result.command ? `• Not verified — ${name} was skipped.` : `• Not verified — ${name} has no command. Add verify.${name} to .casper/project.yaml.`;
  }
  if (result.status === "pass") {
    if (result.freshness === "stale") return `• Not verified — stale: files changed after the last passing ${name}. Run ${slash(`/verify ${name}`)}.`;
    // A reused pass did not run again: the time shown is the earlier run's, so the receipt says so.
    return `✓ ${name} passed${result.reused ? " earlier in this task, reused" : ""} (${result.command ? `${safe(result.command)}, ` : ""}${duration(result.durationMs)})`;
  }
  const timeout = /^Timed out after (\d+)ms$/.exec(result.reason ?? "");
  // Unfinished checks are not the code failing: Casper does not repair them, so it does not offer to.
  if (result.ended === "timeout") {
    return `✗ ${name} timed out${timeout ? ` after ${duration(Number(timeout[1]))}` : ""} — it did not finish, so it was not checked; ${slash(`/verify ${name}`)} to run it again, or raise verification.timeoutMs in .casper/project.yaml`;
  }
  if (result.ended === "no_start") {
    return `✗ ${name} could not start (${typeof result.exitCode === "number" ? `exit ${result.exitCode}` : safe(result.reason ?? "no exit status").replace(/\.$/, "").toLowerCase()}) — check verify.${name} in .casper/project.yaml`;
  }
  const why = typeof result.exitCode === "number" ? `exit ${result.exitCode}`
    : timeout ? `timed out after ${duration(Number(timeout[1]))}`
    : result.reason ? safe(result.reason).replace(/\.$/, "").toLowerCase()
    : result.signal ? `stopped by ${safe(result.signal)}` : "no exit status";
  return `✗ ${name} failed (${why}) — log above; ${slash(`/verify repair ${name}`)} to fix`;
}

const duration = formatDuration;

/** The line shown the moment a check Casper runs finishes, before the receipt: "✓ typecheck · 5.9s". */
export function liveCheckLine(result: VerificationResult): string {
  const name = result.name;
  if (result.status === "skip") return `– ${name} · skipped${result.command ? "" : ", no command"}`;
  if (result.status === "pass") return result.reused ? `✓ ${name} · passed earlier, reused` : `✓ ${name} · ${duration(result.durationMs)}`;
  const timeout = /^Timed out after (\d+)ms$/.exec(result.reason ?? "");
  if (result.ended === "timeout") return `✗ ${name} · timed out${timeout ? ` after ${duration(Number(timeout[1]))}` : ""}`;
  if (result.ended === "no_start") return `✗ ${name} · could not start${typeof result.exitCode === "number" ? ` (exit ${result.exitCode})` : ""}`;
  return `✗ ${name} · ${typeof result.exitCode === "number" ? `exit ${result.exitCode}` : result.signal ? `stopped by ${result.signal}` : "no exit status"} · ${duration(result.durationMs)}`;
}

function pathList(paths: string[], safe: (text: string) => string, count = true): string {
  const shown = paths.slice(0, RECEIPT_PATH_LIMIT).map(safe).join(", ");
  const more = paths.length > RECEIPT_PATH_LIMIT ? ` … +${paths.length - RECEIPT_PATH_LIMIT} more` : "";
  return `${count ? `${paths.length} ${paths.length === 1 ? "file" : "files"}: ` : ""}${shown}${more}`;
}
