import { terminalText } from "../../tui/format";
import type { CheckReport, CheckSection, Finding } from "./index";

const SECTION_TITLES: Record<CheckSection, string> = {
  repo: "Repo checks",
  server: "Server",
  examples: "Example configs",
  inspector: "Inspector",
  live: "Live",
};
const SECTION_ORDER: CheckSection[] = ["repo", "server", "examples", "inspector", "live"];

export const OFFLINE_LINES = [
  "Offline: no tool calls. Credentials removed, web proxy blocked. Use --live to allow read calls.",
  "Offline is best effort: a program that reads its own .env or opens SSH itself can still reach the network.",
];
export const LIVE_LINE = "Live: read-only calls to your real systems are allowed. Write tools are never called.";
export const EXIT_CODES_LINE = "Exit codes: 0 no problems, 1 problems (or warnings with --strict), 64 usage mistake";

/** "Checking <name> (<path>)" and what offline or live mode means. */
export function formatCheckHeader(report: Pick<CheckReport, "target" | "offline">): string {
  const lines = [`Checking ${terminalText(report.target.name)} (${terminalText(report.target.path)})`, ...(report.offline ? OFFLINE_LINES : [LIVE_LINE])];
  return `${lines.join("\n")}\n`;
}

/** One aligned line: status, label, text. Labels and text can quote repo or server text, so both are escaped. */
export function formatFinding(finding: Finding): string {
  const label = terminalText(finding.label);
  return `  ${finding.status.padEnd(6)}${label.length < 14 ? label.padEnd(14) : `${label}  `}${terminalText(finding.text)}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function formatCheckReport(report: CheckReport, options: { header?: boolean } = {}): string {
  const lines: string[] = [];
  if (options.header !== false) lines.push(formatCheckHeader(report).trimEnd());
  for (const section of SECTION_ORDER) {
    const findings = report.findings.filter((finding) => finding.section === section);
    if (!findings.length) continue;
    lines.push(SECTION_TITLES[section], ...findings.map(formatFinding));
  }
  lines.push(`Result: ${plural(report.problems, "problem")}, ${plural(report.warnings, "warning")}, ${plural(report.notes, "note")}`);
  lines.push(EXIT_CODES_LINE);
  return `${lines.join("\n")}\n`;
}

/** --json: the same report as one JSON document, versioned for scripts. */
export function checkReportJson(report: CheckReport): { version: 1 } & CheckReport {
  return { version: 1, ...report };
}
