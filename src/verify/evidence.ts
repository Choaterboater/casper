import type { ProjectCommand } from "../project/model";

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
}

export interface VerificationReport {
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

// Repository output may contain terminal escape sequences. Evidence stays raw;
// only the compact terminal presentation is sanitized.
function terminalText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export function formatVerificationResult(result: VerificationResult): string {
  const mark = { pass: "✓", fail: "✗", skip: "–" }[result.status];
  const detail = result.reason ?? (result.exitCode === null ? result.signal : `exit ${result.exitCode}`);
  return `${mark} ${result.name}${result.command ? `  ${terminalText(result.command)}` : ""}  (${detail ? terminalText(detail) + "; " : ""}${result.durationMs}ms${result.truncated ? "; output truncated" : ""})`;
}

export function formatVerificationReport(report: VerificationReport): string {
  const counts = ["pass", "fail", "skip"].map((status) =>
    `${report.results.filter((result) => result.status === status).length} ${status}`,
  ).join(", ");
  return `Verification ${report.status}: ${counts}; ${report.repairAttempts} repair attempt(s).${report.reason ? ` ${terminalText(report.reason)}` : ""}`;
}
