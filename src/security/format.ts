import { terminalText } from "../tui/format";
import { numberedChoices, type NumberedQuestion } from "./install";
import type { SecurityReport, ToolReport } from "./run";
import type { IgnoreEntry, IgnoreFile, SecurityFinding } from "./types";
import { currentSandbox, type ShellSandbox } from "../sandbox/manager";

/**
 * The security report as text and as --json. Casper's own words never call the code "safe" or
 * "secure": the tools found what they found, and that is all the report says.
 */

/** The header's second line: what holds the tools on this machine now. It says "no network" only where the shell
 * sandbox enforces it (Linux); elsewhere it says what Casper does and that nothing blocks their network. */
export function securityNetworkLine(sandbox: Pick<ShellSandbox, "on" | "platform" | "state" | "failure"> | undefined = currentSandbox()): string {
  if (sandbox?.on && sandbox.platform === "linux") return "Casper runs these tools in the shell sandbox: no network, no passwords or tokens, and no writes outside the project and temp.";
  if (sandbox?.on) return "Casper runs these tools in the shell sandbox (they reach only listed hosts), with no passwords or tokens.";
  const why = sandbox ? sandbox.failure ?? sandbox.state.reason ?? "no sandbox" : "no sandbox";
  return `${SECURITY_OFFLINE_LINE} Nothing blocks their network here (${why}).`;
}

/** What Casper does for the tools when no sandbox holds them. */
export const SECURITY_OFFLINE_LINE = "Casper runs these tools with a dead proxy and no passwords or tokens.";
export const SECURITY_EXIT_LINE = "Exit codes: 0 no problems, 1 problems, 64 usage mistake";
export const SECURITY_RESULT_TAIL = "This is what these tools found. It does not prove the code has no problems.";

export function formatSecurityHeader(target: SecurityReport["target"]): string {
  return `Security check: ${terminalText(target.name)} (${terminalText(target.path)})\n${securityNetworkLine()}\n`;
}

function plural(count: number, word: string, many = `${word}s`): string {
  return `${count} ${count === 1 ? word : many}`;
}

const STATUS_WORDS: Record<ToolReport["status"], string> = { ok: "ok", problems: "", "not-run": "not run", "not-needed": "not needed", off: "off" };

function statusWord(tool: ToolReport): string {
  if (tool.status === "problems") return plural(tool.problems, "problem");
  if (tool.status === "ok" && tool.notes) return `ok, ${plural(tool.notes, "note")}`;
  return STATUS_WORDS[tool.status];
}

/** "src/x.py:12" or "requirements.txt" or 'tool "get_weather"'. */
export function findingPlace(finding: Pick<SecurityFinding, "file" | "line">): string {
  if (!finding.file) return "";
  return finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
}

/** One aligned tool line: "gitleaks      1 problem    app/server.py:8  looks like a secret (…)". */
export function formatToolLine(tool: ToolReport, findings: readonly SecurityFinding[]): string[] {
  const mine = findings.filter((finding) => finding.tool === tool.id);
  const head = `${terminalText(tool.label).padEnd(14)}${statusWord(tool).padEnd(13)}`;
  const lines: string[] = [];
  if (mine.length === 1 && !tool.text) {
    lines.push(`${head}${formatFindingText(mine[0]!)}`);
  } else {
    lines.push(`${head}${terminalText(tool.text)}`.trimEnd());
    for (const finding of mine) lines.push(`  ${formatFindingText(finding)}`);
  }
  if (tool.ownCopy) lines.push(`  ${terminalText(tool.ownCopy)}`);
  return lines;
}

export function formatFindingText(finding: SecurityFinding): string {
  const place = findingPlace(finding);
  const rule = finding.tool === "gitleaks" || finding.tool === "osv-scanner" ? "" : ` [${terminalText(finding.rule)}]`;
  const note = finding.severity === "low" ? " (note)" : "";
  return `${place ? `${terminalText(place)}  ` : ""}${terminalText(finding.text)}${rule}${note}`;
}

function ignoreLine(entry: IgnoreEntry): string {
  return `${terminalText(entry.file)}:${entry.line}  ${terminalText(entry.marker)}`;
}

/** "Ignores: 15 you committed, 1 new one you didn't approve: src/x.py:12  # nosec B608". */
export function formatIgnores(report: SecurityReport): string[] {
  const { committed, approved } = report.ignores;
  const fresh = report.ignores.new;
  const unknown = report.ignores.unknown;
  if (!committed && !approved && !fresh.length && !unknown.length) return [];
  const parts: string[] = [];
  if (committed) parts.push(`${committed} you committed`);
  if (approved) parts.push(`${approved} you approved`);
  if (fresh.length) parts.push(`${fresh.length} new ${fresh.length === 1 ? "one" : "ones"} you didn't approve`);
  if (unknown.length) parts.push(`${unknown.length} Casper can't place (not a git repo), so not used`);
  const lines = [`Ignores: ${parts.join(", ")}${fresh.length === 1 && !unknown.length ? `: ${ignoreLine(fresh[0]!)}` : ""}`];
  if (fresh.length > 1) for (const entry of fresh) lines.push(`  ${ignoreLine(entry)}`);
  for (const entry of unknown) lines.push(`  ${ignoreLine(entry)}`);
  return lines;
}

/** ".gitleaks.toml changed since your last commit, so Casper used the default rules." */
export function changedIgnoreFileLine(file: IgnoreFile): string {
  const fallback = file.tool === "gitleaks" ? "the default rules" : file.tool === "ruff" ? "no ignores from it" : "none of its ignores";
  const why = file.status === "unknown" ? "Casper can't tell who changed it (not a git repo)" : "changed since your last commit";
  return `${terminalText(file.file)} ${why}, so Casper used ${fallback}.`;
}

export function formatResultLine(report: SecurityReport): string {
  const parts = [plural(report.problems, "problem")];
  if (report.notes) parts.push(plural(report.notes, "note"));
  if (report.ignores.new.length) parts.push(plural(report.ignores.new.length, "new ignore"));
  if (report.notRun) parts.push(`${plural(report.notRun, "check")} not run`);
  return `Result: ${parts.join(", ")}. ${SECURITY_RESULT_TAIL}`;
}

export function formatSecurityReport(report: SecurityReport, options: { header?: boolean } = {}): string {
  const lines: string[] = [];
  if (options.header !== false) lines.push(formatSecurityHeader(report.target).trimEnd());
  for (const tool of report.tools) lines.push(...formatToolLine(tool, report.findings));
  for (const file of report.ignoreFiles) if (!file.used) lines.push(changedIgnoreFileLine(file));
  lines.push(...formatIgnores(report));
  lines.push(formatResultLine(report));
  return `${lines.join("\n")}\n`;
}

/** --json: one versioned document for scripts. Same facts as the text; secret values are never in it. */
export function securityReportJson(report: SecurityReport): {
  version: 1; target: SecurityReport["target"]; tools: ToolReport[]; findings: SecurityFinding[];
  ignores: { committed: number; approved: number; new: IgnoreEntry[]; unknown: IgnoreEntry[] }; ignoreFiles: IgnoreFile[];
  notRun: Array<{ id: string; reason: string }>; problems: number; notes: number; exitCode: 0 | 1;
} {
  return {
    version: 1, target: report.target, tools: report.tools, findings: report.findings, ignores: report.ignores, ignoreFiles: report.ignoreFiles,
    notRun: report.tools.filter((tool) => tool.status === "not-run").map((tool) => ({ id: tool.id, reason: tool.text })),
    problems: report.problems, notes: report.notes, exitCode: report.exitCode,
  };
}

/** A numbered question as one block: the text, then "1 … · 2 … · 3 …". */
export function formatQuestion(question: NumberedQuestion): string {
  return `${question.text}\n${numberedChoices(question.choices)}\n`;
}

/** The choice for one unapproved ignore: "1 Leave it flagged · 2 Show the line · 3 Keep it (I approve)".
 * Leave it flagged comes first, so Enter never approves an ignore. */
export const IGNORE_CHOICES = ["Leave it flagged", "Show the line", "Keep it (I approve)"] as const;
export const IGNORE_APPROVE = IGNORE_CHOICES[2];
export function ignoreQuestion(entry: IgnoreEntry): NumberedQuestion {
  return { text: `New ignore you didn't approve: ${ignoreLine(entry)}`, choices: [...IGNORE_CHOICES] };
}

/** The choice for a changed ignore file: "1 Keep the default · 2 Use my changed file" (Enter keeps the default). */
export const IGNORE_FILE_CHOICES = ["Keep the default", "Use my changed file"] as const;
export const IGNORE_FILE_USE = IGNORE_FILE_CHOICES[1];
export function ignoreFileQuestion(file: IgnoreFile): NumberedQuestion {
  return { text: changedIgnoreFileLine(file), choices: [...IGNORE_FILE_CHOICES] };
}

/** The counts a task receipt keeps of a security run: never finding text. */
export function securitySummary(report: SecurityReport): { problems: number; notes: number; notRun: number; tools: Array<{ id: string; status: ToolReport["status"] }> } {
  return { problems: report.problems, notes: report.notes, notRun: report.notRun, tools: report.tools.map((tool) => ({ id: tool.id, status: tool.status })) };
}
