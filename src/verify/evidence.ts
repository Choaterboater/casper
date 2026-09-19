import type { ProjectCommand } from "../project/model";
import type { VerificationScope } from "./scope";

export const CHECK_NAMES: readonly ProjectCommand[] = ["typecheck", "lint", "test", "build"];

export interface VerificationResult {
  name: ProjectCommand;
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
}

export interface VerificationReport {
  /** Selected command outcomes only. Freshness and behavioral coverage are separate. */
  status: "pass" | "fail" | "incomplete" | "blocked";
  repairAttempts: number;
  rounds: VerificationResult[][];
  results: VerificationResult[];
  reason?: string;
}

export function verificationStatus(results: VerificationResult[]): VerificationReport["status"] {
  if (results.some((result) => result.status === "fail")) return "fail";
  if (!results.length || results.some((result) => result.status === "skip")) return "incomplete";
  return "pass";
}

export interface VerificationCheckSummary {
  name: ProjectCommand;
  status: VerificationResult["status"];
  exitCode: number | null;
  scope?: VerificationScope;
  freshness: NonNullable<VerificationResult["freshness"]>;
  freshnessReason?: string;
}

/** One compact projection for receipts and durable history. No raw command output,
 * fingerprint, transcript, or inferred behavioral/human acceptance. */
export function summarizeVerificationCheck(result: Pick<VerificationResult, "name" | "status"> & Partial<VerificationResult>): VerificationCheckSummary {
  const freshness = result.freshness === "stale" ? "stale" : result.scope ? result.freshness ?? "unavailable" : "unavailable";
  return { name: result.name, status: result.status, exitCode: result.exitCode ?? null,
    scope: result.scope ? structuredClone(result.scope) : undefined, freshness,
    freshnessReason: result.freshnessReason?.slice(0, 512) ?? (freshness === "fresh" ? undefined
      : freshness === "stale" ? "Declared inputs changed." : "Input freshness was not recorded or scope was not declared.") };
}

export function summarizeVerification(report: VerificationReport) {
  return { status: report.status, checks: report.results.map(summarizeVerificationCheck),
    repairAttempts: report.repairAttempts, coverage: "not-certified" as const };
}

function formatQualification(check: VerificationCheckSummary): string {
  return `inputs ${check.freshness}; scope ${check.scope ? terminalText(JSON.stringify(check.scope)) : "undeclared"}`
    + (check.freshnessReason ? `; ${terminalText(check.freshnessReason).replace(/\.$/, "")}` : "")
    + (check.freshness === "fresh" ? "; declared local scope only" : "; current files unverified; reuse disabled");
}

// Repository output may contain terminal escape sequences. Evidence stays raw;
// only the compact terminal presentation is sanitized.
function terminalText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
}

export function formatVerificationResult(result: VerificationResult): string {
  const mark = { pass: "✓", fail: "✗", skip: "–" }[result.status];
  const detail = result.reason ?? (result.exitCode === null ? result.signal : `exit ${result.exitCode}`);
  const source = result.reused ? "reused declared-input evidence; " : "";
  return `${mark} ${result.name}${result.command ? `  ${terminalText(result.command)}` : ""}  (${source}${detail ? terminalText(detail) + "; " : ""}${result.durationMs}ms${result.truncated ? "; output truncated" : ""}; ${formatQualification(summarizeVerificationCheck(result))})`;
}

export function formatVerificationReport(report: VerificationReport): string {
  const summary = summarizeVerification(report);
  const counts = ["pass", "fail", "skip"].map((status) =>
    `${summary.checks.filter((check) => check.status === status).length} ${status}`,
  ).join(", ");
  const qualifications = summary.checks.map((check) => `${check.name}: ${formatQualification(check)}`).join(" | ");
  return `Checks ${summary.status} (command execution): ${counts}; ${summary.repairAttempts} repair attempt(s).`
    + (report.reason ? ` ${terminalText(report.reason)}` : "")
    + (qualifications ? ` ${qualifications}.` : "")
    + " requested behavior is not independently certified.";
}
