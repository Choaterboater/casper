/** The security tools Casper knows. Each one is called as-is; Casper never copies their code. */
export type SecurityToolId = "gitleaks" | "ruff" | "semgrep" | "zizmor" | "osv-scanner" | "ansible-lint" | "mcp-scanner";

export const SECURITY_TOOL_ORDER: readonly SecurityToolId[] = ["gitleaks", "ruff", "semgrep", "zizmor", "osv-scanner", "ansible-lint", "mcp-scanner"];

/** Casper's own severity scale. Only medium and high count as problems; low is a note. */
export type SecuritySeverity = "high" | "medium" | "low";

export interface SecurityFinding {
  tool: SecurityToolId;
  /** Path relative to the repo root, with forward slashes. Empty for findings keyed by name (mcp-scanner). */
  file: string;
  /** 1-based. 0 when the tool gives no line (an osv-scanner package that is not found in its lockfile). */
  line: number;
  endLine?: number;
  /** The tool's rule id: "github-pat", "S608", "casper.mcp-tool-shell-from-input", "GHSA-…". */
  rule: string;
  severity: SecuritySeverity;
  /** One plain sentence. Secret values are never kept; text from tools is escaped when printed. */
  text: string;
  /** For findings without a file:line: the MCP tool name (mcp-scanner) or the package (osv-scanner). */
  key?: string;
}

/** An inline ignore marker such as `# nosec B608` or `gitleaks:allow`. */
export interface IgnoreMarker {
  /** The tool the marker speaks to. */
  tool: SecurityToolId;
  file: string;
  line: number;
  /** The marker as written, e.g. "# nosec B608". */
  marker: string;
  /** Rule codes the marker names; empty means every rule of that tool. Ruff codes are S-numbers. */
  codes: string[];
}

/** Whether an ignore counts: only the user can make one count, by committing it or approving it. */
export type IgnoreStatus = "committed" | "approved" | "new" | "unknown";

export interface IgnoreEntry extends IgnoreMarker {
  status: IgnoreStatus;
}

/** A tool's own ignore or config file (.gitleaks.toml, osv-scanner.toml, …) and whether Casper used it. */
export interface IgnoreFile {
  file: string;
  tool: SecurityToolId;
  /** committed: the file matches HEAD (or the user approved this content, or chose it for this run). */
  status: "committed" | "approved" | "chosen" | "changed" | "unknown";
  used: boolean;
}
