import type { ProjectCommand } from "../project/model";
import type { SmokeReport } from "../services/smoke";
import type { PageReport } from "../services/page-report";
import type { CheckName } from "./named";
import type { VerificationScope } from "./scope";

export type { CheckName } from "./named";

export const CHECK_NAMES: readonly ProjectCommand[] = ["typecheck", "lint", "test", "build"];

/** How a failed check may be repaired. "repairable": Casper hands it to the model. "ask": only after the
 * user says so (a check that did not finish, a lab check). "never": not a code failure to fix (a report,
 * a check that could not run for a missing tool). */
export type RepairClass = "repairable" | "ask" | "never";

export interface VerificationResult {
  name: CheckName;
  status: "pass" | "fail" | "skip";
  command?: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  reason?: string;
  /** Bounded identity of declared inputs only, not complete dependency coverage. */
  workspaceState?: string;
  scope?: VerificationScope;
  freshness?: "fresh" | "stale" | "unavailable";
  freshnessReason?: string;
  /** True when a passing result with matching local filesystem evidence was reused. */
  reused?: boolean;
  /** Set only when the command did not finish as a test run: it timed out, or it could not start
   * (spawn error, bad folder, or the shell's 126/127), or the shell sandbox blocked it (it wanted to write or
   * reach something it may not). Such a failure is not the code failing. */
  ended?: "timeout" | "no_start" | "blocked";
  /** Named checks only. Absent: an ordinary pass/fail check. "report": a diff shown for reading, never a pass
   * or a fail. "lab": a check on the user's own lab devices, run only when the user starts it. */
  kind?: "report" | "lab";
  /** A few plain words shown beside the result, e.g. "dry run not guaranteed". */
  label?: string;
  /** Lab checks only: the devices the check was pointed at. */
  hosts?: string[];
  /** Reports only: the one-line summary ("12 lines to change · 12 to undo"). Secrets already hidden. */
  summary?: string;
  /** Set by the check itself when its failure must not go to the model on its own (see repairClass). */
  repair?: RepairClass;
}

/** How this result may be repaired. Only failures are; reports never are; an unfinished or lab check only
 * after asking the user; a check may also say so itself. */
export function repairClass(result: Pick<VerificationResult, "status" | "kind" | "ended" | "repair">): RepairClass {
  if (result.status !== "fail" || result.kind === "report") return "never";
  if (result.repair) return result.repair;
  // The sandbox said no: nothing for the model to fix, and retrying gets the same answer.
  if (result.ended === "blocked") return "never";
  return result.kind === "lab" || result.ended ? "ask" : "repairable";
}

/** Results that decide a run's status: reports never do. */
export function countedResults<T extends Pick<VerificationResult, "kind">>(results: readonly T[]): T[] {
  return results.filter((result) => result.kind !== "report");
}

export interface VerificationReport {
  /** Selected command outcomes only. Freshness and behavioral coverage are separate. */
  status: "pass" | "fail" | "incomplete" | "blocked";
  repairAttempts: number;
  rounds: VerificationResult[][];
  results: VerificationResult[];
  reason?: string;
  /** The last smoke run against fresh services, when the task had smoke checks and the commands passed. */
  smoke?: SmokeReport;
  /** The task had smoke checks but the loop ended with command failures, so they never ran (smoke runs only on passing commands). */
  smokeSkipped?: "command checks failed";
  /** The last page check against the dev server, when the task had changed pages and the commands passed. */
  pages?: PageReport;
  /** The task had pages to check but the loop ended with command failures, so they never opened. */
  pagesSkipped?: "command checks failed";
  /** The model each repair used, in order, when the host said (for example the big model on the last try). */
  repairModels?: string[];
}

/** A plain duration: "0.3s", "1m 5s", "10m". */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function verificationStatus(all: VerificationResult[]): VerificationReport["status"] {
  // A report (a diff) never makes a run pass, fail or incomplete.
  const results = countedResults(all);
  if (results.some((result) => result.status === "fail")) return "fail";
  if (!results.length || results.some((result) => result.status === "skip")) return "incomplete";
  return "pass";
}

export interface VerificationCheckSummary {
  name: CheckName;
  status: VerificationResult["status"];
  exitCode: number | null;
  scope?: VerificationScope;
  freshness: NonNullable<VerificationResult["freshness"]>;
  freshnessReason?: string;
  kind?: VerificationResult["kind"];
  label?: string;
  hosts?: string[];
}

/** One compact projection for receipts and durable history. No raw command output,
 * fingerprint, transcript, or inferred behavioral/human acceptance. */
export function summarizeVerificationCheck(result: Pick<VerificationResult, "name" | "status"> & Partial<VerificationResult>): VerificationCheckSummary {
  const freshness = result.freshness === "stale" ? "stale" : result.scope ? result.freshness ?? "unavailable" : "unavailable";
  return { name: result.name, status: result.status, exitCode: result.exitCode ?? null,
    scope: result.scope ? structuredClone(result.scope) : undefined, freshness,
    freshnessReason: result.freshnessReason?.slice(0, 512) ?? (freshness === "fresh" ? undefined
      : freshness === "stale" ? "Declared inputs changed." : "Input freshness was not recorded or scope was not declared."),
    ...(result.kind ? { kind: result.kind } : {}), ...(result.label ? { label: result.label.slice(0, 200) } : {}),
    ...(result.hosts ? { hosts: result.hosts.slice(0, 256) } : {}) };
}

export function summarizeVerification(report: VerificationReport) {
  return { status: report.status, checks: report.results.map(summarizeVerificationCheck),
    repairAttempts: report.repairAttempts, coverage: "not-certified" as const };
}

function formatQualification(check: VerificationCheckSummary): string {
  // With no declared scope there are no inputs to be fresh or stale; the stored reason ("No input
  // scope declared") says the same thing, so the display keeps only the consequence.
  if (!check.scope) return "scope undeclared; current files unverified; reuse disabled";
  return `inputs ${check.freshness}; scope ${terminalText(JSON.stringify(check.scope))}`
    + (check.freshnessReason ? `; ${terminalText(check.freshnessReason).replace(/\.$/, "")}` : "")
    + (check.freshness === "fresh" ? "; declared local scope only" : "; current files unverified; reuse disabled");
}

// Repository output may contain terminal escape sequences. Evidence stays raw;
// only the compact terminal presentation is sanitized.
function terminalText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
}

export function formatVerificationResult(result: VerificationResult): string {
  if (result.kind === "report") return `• ${result.name}  ${reportText(result)} (a diff, not a pass/fail check)`;
  // Nothing ran for a skip, so input freshness and scope carry no information.
  if (result.status === "skip") return `– ${result.name}  ${result.kind || result.label ? "not run" : "skipped"}${result.reason ? `: ${terminalText(result.reason)}` : ""}`;
  const mark = result.status === "pass" ? "✓" : "✗";
  const detail = result.reason ?? (result.exitCode === null ? result.signal : `exit ${result.exitCode}`);
  const source = (result.label ? `${terminalText(result.label)}; ` : "") + (result.reused ? "reused declared-input evidence; " : "");
  return `${mark} ${result.name}${result.command ? `  ${terminalText(result.command)}` : ""}  (${source}${detail ? terminalText(detail) + "; " : ""}${result.durationMs}ms${result.truncated ? "; output truncated" : ""}; ${formatQualification(summarizeVerificationCheck(result))})`;
}

/** A report's summary, or why it has none. */
export function reportText(result: Pick<VerificationResult, "summary" | "reason" | "status">): string {
  if (result.summary) return terminalText(result.summary);
  return `no diff: ${terminalText(result.reason ?? (result.status === "skip" ? "not run" : "the tool failed"))}`;
}

/** `compact` keeps the outcome, counts and only the qualifications that limit what a pass means
 * (checks whose inputs were not fresh); skip reasons and fresh-check detail were printed above. */
export function formatVerificationReport(report: VerificationReport, options: { compact?: boolean } = {}): string {
  const summary = summarizeVerification(report);
  const counted = countedResults(summary.checks);
  const reports = summary.checks.length - counted.length;
  const counts = ["pass", "fail", "skip"].map((status) =>
    `${counted.filter((check) => check.status === status).length} ${status}`,
  ).join(", ") + (reports ? `, ${reports} ${reports === 1 ? "report" : "reports"}` : "");
  const head = `Checks ${summary.status} (command execution): ${counts}; ${summary.repairAttempts} repair attempt(s).`
    + (report.reason ? ` ${terminalText(report.reason)}` : "");
  if (options.compact) {
    const limits = counted.filter((check) => check.status === "pass" && check.freshness !== "fresh").map((check) => `${check.name}: ${formatQualification(check)}`).join(" | ");
    return `${head}${limits ? ` ${limits}.` : ""} Requested behavior is not independently certified.`;
  }
  const qualifications = counted.filter((check) => check.status !== "skip").map((check) => `${check.name}: ${formatQualification(check)}`).join(" | ");
  const skipped = new Map<string, CheckName[]>();
  for (const result of countedResults(report.results)) if (result.status === "skip") skipped.set(result.reason ?? "skipped", [...(skipped.get(result.reason ?? "skipped") ?? []), result.name]);
  const skips = [...skipped].map(([reason, names]) => `Skipped ${names.join(", ")}: ${terminalText(reason).replace(/\.$/, "")}.`).join(" ");
  return `${head}${qualifications ? ` ${qualifications}.` : ""}${skips ? ` ${skips}` : ""} Requested behavior is not independently certified.`;
}
