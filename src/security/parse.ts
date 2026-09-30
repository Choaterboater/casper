import path from "node:path";
import { redactPreview, terminalText } from "../tui/format";
import type { SecurityFinding, SecuritySeverity, SecurityToolId } from "./types";

/**
 * Turns each tool's JSON into SecurityFindings. Everything a tool prints is untrusted: text is redacted
 * and escaped, secret values (gitleaks' Secret and Match) are never read, and paths are made relative
 * to the repo root. A malformed report throws, and the tool is then "not run" rather than "ok".
 */

export interface ParseContext {
  root: string;
  /** Reads a repo file's text to place osv-scanner packages on a lockfile line. */
  readText?: (relative: string) => string | undefined;
}

const TEXT_LIMIT = 240;

/** Text that may carry a value rather than just describe a finding. */
const VALUE_SHAPED = /(sk-[\w-]{8,}|gh[pousr]_\w{8,}|github_pat_\w{8,}|AKIA[A-Z0-9]{16}|\b(?:Bearer|Basic)\s+\S+|:\/\/[^\s/@]+:[^\s/@]+@|(?:password|passwd|secret|token|api[_-]?key|authorization)\w*["']?\s*[:=]\s*["']?[^\s"',;)]{4,})/i;

/**
 * Tool text, made safe to print. Tools describe a finding ("Possible hardcoded password assigned to:
 * GITHUB_TOKEN") without quoting the value, so that stays readable; text that looks like it carries a
 * value is hidden the conservative way (redactPreview). Always escaped for the terminal.
 */
export function cleanToolText(text: unknown): string {
  const readable = (typeof text === "string" ? text : "").replace(/\s+/g, " ").trim();
  return (VALUE_SHAPED.test(readable) ? redactPreview(readable) : terminalText(readable)).slice(0, TEXT_LIMIT);
}

const clean = cleanToolText;

/** A path from a tool, relative to the root with forward slashes. Outside the root keeps its name only. */
export function relativePath(root: string, file: unknown): string {
  if (typeof file !== "string" || !file) return "";
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return path.basename(file);
  return relative.split(path.sep).join("/");
}

function positiveLine(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function jsonOf(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) throw new Error("the tool printed no report");
  return JSON.parse(text) as unknown;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`the ${what} report is not in the expected shape`);
  return value;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** gitleaks: never keeps Secret or Match, even when --redact did not apply. */
export function parseGitleaks(stdout: string, context: ParseContext): SecurityFinding[] {
  return asArray(jsonOf(stdout), "gitleaks").filter(isObject).map((item) => {
    const rule = clean(item.RuleID) || "secret";
    const line = positiveLine(item.StartLine);
    const endLine = positiveLine(item.EndLine);
    return {
      tool: "gitleaks", file: relativePath(context.root, item.File), line,
      ...(endLine > line ? { endLine } : {}),
      rule, severity: "high" as const,
      text: `looks like a secret (${rule}, value hidden)`,
    };
  });
}

/** ruff --output-format json: only S rules (Casper selects them), all medium. */
export function parseRuff(stdout: string, context: ParseContext): SecurityFinding[] {
  return asArray(jsonOf(stdout), "ruff").filter(isObject).flatMap((item): SecurityFinding[] => {
    const code = typeof item.code === "string" ? item.code : "";
    if (!/^S\d{3}$/.test(code)) return [];
    const location = isObject(item.location) ? item.location : {};
    const end = isObject(item.end_location) ? item.end_location : {};
    const line = positiveLine(location.row);
    const endLine = positiveLine(end.row);
    return [{
      tool: "ruff", file: relativePath(context.root, item.filename), line, ...(endLine > line ? { endLine } : {}),
      rule: code, severity: "medium", text: clean(item.message),
    }];
  });
}

/** Semgrep prefixes a local rule's id with its folder path ("home.me.rules.casper.x"): keep "casper.x". */
export function semgrepRuleId(checkId: string): string {
  const match = /(?:^|\.)(casper\.[a-z0-9-]+)$/.exec(checkId);
  return match ? match[1]! : checkId.split(".").pop() ?? checkId;
}

const SEVERITIES = new Set<SecuritySeverity>(["high", "medium", "low"]);

export function parseSemgrep(stdout: string, context: ParseContext): SecurityFinding[] {
  const report = jsonOf(stdout);
  if (!isObject(report)) throw new Error("the semgrep report is not in the expected shape");
  return asArray(report.results, "semgrep").filter(isObject).map((item) => {
    const extra = isObject(item.extra) ? item.extra : {};
    const metadata = isObject(extra.metadata) ? extra.metadata : {};
    const start = isObject(item.start) ? item.start : {};
    const end = isObject(item.end) ? item.end : {};
    const own = typeof metadata["casper-severity"] === "string" ? metadata["casper-severity"] as SecuritySeverity : undefined;
    const severity: SecuritySeverity = own && SEVERITIES.has(own) ? own
      : extra.severity === "ERROR" ? "high" : extra.severity === "WARNING" ? "medium" : "low";
    const line = positiveLine(start.line);
    const endLine = positiveLine(end.line);
    return {
      tool: "semgrep" as const, file: relativePath(context.root, item.path), line, ...(endLine > line ? { endLine } : {}),
      rule: semgrepRuleId(typeof item.check_id === "string" ? item.check_id : "rule"), severity, text: clean(extra.message),
    };
  });
}

/** Parse errors semgrep reports next to its results: shown as a note, never as a pass. */
export function semgrepErrors(stdout: string): number {
  try {
    const report = jsonOf(stdout);
    return isObject(report) && Array.isArray(report.errors) ? report.errors.length : 0;
  } catch { return 0; }
}

const ZIZMOR_SEVERITY: Record<string, SecuritySeverity> = { high: "high", medium: "medium", low: "low", informational: "low", unknown: "low" };

/** zizmor --format json (v1): concrete rows are 0-based. */
export function parseZizmor(stdout: string, context: ParseContext): SecurityFinding[] {
  return asArray(jsonOf(stdout), "zizmor").filter(isObject).flatMap((item): SecurityFinding[] => {
    const locations = Array.isArray(item.locations) ? item.locations.filter(isObject) : [];
    const primary = locations.find((location) => isObject(location.symbolic) && location.symbolic.kind === "Primary") ?? locations[0];
    if (!primary) return [];
    const symbolic = isObject(primary.symbolic) ? primary.symbolic : {};
    const key = isObject(symbolic.key) ? symbolic.key : {};
    const local = isObject(key.Local) ? key.Local : undefined;
    // Remote findings cannot happen with --offline; keep them out rather than guess a file.
    if (!local) return [];
    const concrete = isObject(primary.concrete) && isObject(primary.concrete.location) ? primary.concrete.location : {};
    const start = isObject(concrete.start_point) ? concrete.start_point : {};
    const end = isObject(concrete.end_point) ? concrete.end_point : {};
    const row = typeof start.row === "number" ? start.row + 1 : 0;
    const endRow = typeof end.row === "number" ? end.row + 1 : 0;
    const determinations = isObject(item.determinations) ? item.determinations : {};
    const severity = ZIZMOR_SEVERITY[String(determinations.severity ?? "unknown").toLowerCase()] ?? "low";
    const annotation = typeof symbolic.annotation === "string" && symbolic.annotation ? `: ${symbolic.annotation}` : "";
    return [{
      tool: "zizmor", file: relativePath(context.root, local.verbatim_path ?? local.given_path ?? local.path), line: positiveLine(row),
      ...(endRow > row ? { endLine: endRow } : {}),
      rule: clean(item.ident) || "audit", severity, text: clean(`${String(item.desc ?? "")}${annotation}`),
    }];
  });
}

function cvssSeverity(score: unknown): SecuritySeverity {
  const value = typeof score === "string" ? Number.parseFloat(score) : typeof score === "number" ? score : Number.NaN;
  if (Number.isNaN(value)) return "medium";
  return value >= 7 ? "high" : value >= 4 ? "medium" : "low";
}

function fixedVersions(vulnerabilities: Json[], ids: string[]): string[] {
  const fixed = new Set<string>();
  for (const vulnerability of vulnerabilities) {
    if (!ids.includes(String(vulnerability.id))) continue;
    for (const affected of Array.isArray(vulnerability.affected) ? vulnerability.affected.filter(isObject) : []) {
      for (const range of Array.isArray(affected.ranges) ? affected.ranges.filter(isObject) : []) {
        if (range.type !== "ECOSYSTEM" && range.type !== "SEMVER") continue;
        for (const event of Array.isArray(range.events) ? range.events.filter(isObject) : []) {
          if (typeof event.fixed === "string") fixed.add(event.fixed);
        }
      }
    }
  }
  return [...fixed];
}

function packageLine(text: string | undefined, name: string): number {
  if (!text || !name) return 0;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[-_.]/g, "[-_.]");
  const pattern = new RegExp(`(^|[\\s"'/@])${escaped}([\\s"'=<>~!@:\\[;,]|$)`, "i");
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => pattern.test(line));
  return index + 1;
}

/** Compares dotted versions number by number ("2.10.1" > "2.9"). Non-numeric parts compare as text. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.+-]/);
  const right = b.split(/[.+-]/);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] ?? "0";
    const y = right[index] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    const order = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : nx - ny;
    if (order) return order;
  }
  return 0;
}

const SEVERITY_ORDER: Record<SecuritySeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * osv-scanner --format json: one finding per vulnerable package, placed on its lockfile line, with the
 * advisory ids and the lowest version that fixes them all.
 */
export function parseOsv(stdout: string, context: ParseContext): SecurityFinding[] {
  const report = jsonOf(stdout);
  if (!isObject(report)) throw new Error("the osv-scanner report is not in the expected shape");
  const findings: SecurityFinding[] = [];
  for (const result of asArray(report.results ?? [], "osv-scanner").filter(isObject)) {
    const source = isObject(result.source) ? result.source : {};
    const file = relativePath(context.root, source.path);
    const text = file ? context.readText?.(file) : undefined;
    for (const entry of Array.isArray(result.packages) ? result.packages.filter(isObject) : []) {
      const pkg = isObject(entry.package) ? entry.package : {};
      const name = clean(pkg.name);
      const version = clean(pkg.version);
      const vulnerabilities = Array.isArray(entry.vulnerabilities) ? entry.vulnerabilities.filter(isObject) : [];
      const groups = (Array.isArray(entry.groups) ? entry.groups.filter(isObject) : [])
        .map((group) => ({ ids: Array.isArray(group.ids) ? group.ids.map(String) : [], severity: cvssSeverity(group.max_severity) }))
        .filter((group) => group.ids.length);
      if (!groups.length) continue;
      const shown = groups.map((group) => clean(group.ids.find((one) => one.startsWith("GHSA-")) ?? group.ids[0]));
      // The version that fixes every advisory: the highest of each advisory's lowest fix.
      const perGroupFix = groups.map((group) => fixedVersions(vulnerabilities, group.ids).sort(compareVersions)[0]);
      const allFixed = perGroupFix.every(Boolean) ? [...perGroupFix as string[]].sort((a, b) => compareVersions(b, a))[0] : undefined;
      const severity = groups.map((group) => group.severity).sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b])[0]!;
      const count = groups.length === 1 ? "a known advisory" : `${groups.length} known advisories`;
      const ids = `${shown.slice(0, 3).join(", ")}${shown.length > 3 ? ` and ${shown.length - 3} more` : ""}`;
      findings.push({
        tool: "osv-scanner", file, line: packageLine(text, name), rule: shown[0]!, severity, key: `${name}@${version}`,
        text: clean(`${name} ${version} has ${count} (${ids})${allFixed ? `; ${clean(allFixed)} fixes ${groups.length === 1 ? "it" : "all of them"}` : ""}`),
      });
    }
  }
  return findings;
}

/**
 * ansible-lint codeclimate JSON. Most of its rules are about style; only the security-relevant ones are
 * findings here. The rest are counted, not listed.
 */
export const ANSIBLE_SECURITY_RULES = new Set([
  "no-log-password", "risky-file-permissions", "risky-octal", "risky-shell-pipe", "partial-become", "inline-env-var", "command-instead-of-module",
]);

export function parseAnsibleLint(stdout: string, context: ParseContext): SecurityFinding[] {
  const text = stdout.trim();
  if (!text) return [];
  return asArray(jsonOf(text), "ansible-lint").filter(isObject).flatMap((item): SecurityFinding[] => {
    const rule = typeof item.check_name === "string" ? item.check_name : "";
    const base = rule.replace(/\[.*$/, "");
    if (!ANSIBLE_SECURITY_RULES.has(base)) return [];
    const location = isObject(item.location) ? item.location : {};
    const lines = isObject(location.lines) ? location.lines : undefined;
    const positions = isObject(location.positions) && isObject(location.positions.begin) ? location.positions.begin : undefined;
    const line = positiveLine(lines?.begin ?? positions?.line);
    return [{
      tool: "ansible-lint", file: relativePath(context.root, location.path), line,
      rule, severity: base === "command-instead-of-module" ? "low" : "medium", text: clean(item.description),
    }];
  });
}

const MCP_SEVERITY: Record<string, SecuritySeverity> = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

/** mcp-scanner --format raw: results are keyed by tool name, not file:line. */
export function parseMcpScanner(stdout: string, context: ParseContext & { toolsFile?: string } = { root: "" }): SecurityFinding[] {
  const report = jsonOf(stdout);
  if (!isObject(report)) throw new Error("the mcp-scanner report is not in the expected shape");
  const findings: SecurityFinding[] = [];
  for (const result of asArray(report.scan_results, "mcp-scanner").filter(isObject)) {
    if (result.is_safe === true) continue;
    const analyzers = isObject(result.findings) ? result.findings : {};
    for (const [analyzer, value] of Object.entries(analyzers)) {
      if (!isObject(value)) continue;
      const severity = MCP_SEVERITY[String(value.severity ?? "").toUpperCase()];
      if (!severity) continue;
      const threats = Array.isArray(value.threat_names) ? value.threat_names.map(String) : [];
      const name = clean(result.tool_name);
      findings.push({
        tool: "mcp-scanner", file: context.toolsFile ? relativePath(context.root, context.toolsFile) : "", line: 0, key: name,
        rule: clean(threats[0] ?? analyzer).toLowerCase().replace(/\s+/g, "-") || analyzer, severity,
        text: clean(`tool "${name}": ${threats.length ? threats.join(", ").toLowerCase() : String(value.threat_summary ?? "flagged")} in its description`),
      });
    }
  }
  return findings;
}

export const PARSERS: Record<SecurityToolId, (stdout: string, context: ParseContext) => SecurityFinding[]> = {
  gitleaks: parseGitleaks,
  ruff: parseRuff,
  semgrep: parseSemgrep,
  zizmor: parseZizmor,
  "osv-scanner": parseOsv,
  "ansible-lint": parseAnsibleLint,
  "mcp-scanner": parseMcpScanner,
};
