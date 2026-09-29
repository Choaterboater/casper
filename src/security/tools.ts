import path from "node:path";
import ansibleLintLock from "./locks/ansible-lint.txt" with { type: "text" };
import mcpScannerLock from "./locks/cisco-ai-mcp-scanner.txt" with { type: "text" };
import ruffLock from "./locks/ruff.txt" with { type: "text" };
import semgrepLock from "./locks/semgrep.txt" with { type: "text" };
import zizmorLock from "./locks/zizmor.txt" with { type: "text" };
import type { SecurityToolId } from "./types";

/**
 * Casper's pinned security tools. Go programs come from their GitHub releases and are checked against
 * the sha256 written here before anything is unpacked. Python programs install through uv from lock
 * files with a hash for every package. Bumping a pin is a manual step: change the version, the hashes
 * (from the release's own checksum file) or regenerate the lock, then run the CI real-tool job.
 */

export type PlatformKey = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64" | "win32-arm64";

export interface BinaryAsset {
  url: string;
  sha256: string;
  /** How the download is packed; "raw" is the program itself. */
  archive: "tar.gz" | "zip" | "raw";
  /** The program's path inside the archive (or the file name to save a raw download as). */
  member: string;
}

export type ToolSource =
  | { kind: "binary"; assets: Partial<Record<PlatformKey, BinaryAsset>> }
  | { kind: "uv-lock"; package: string; lock: string; lockName: string; python: string; entry: string };

export interface SecurityToolSpec {
  id: SecurityToolId;
  /** The name shown in the report ("ruff S", not "ruff"). */
  label: string;
  /** The program name on PATH. */
  command: string;
  version: string;
  licence: string;
  homepage: string;
  source: ToolSource;
  /** Roughly how much disk the pinned copy takes, for the install question. */
  approxMB: number;
  /** Where the install downloads from. */
  hosts: string[];
  /** Opt-in tools never run or install unless the user turns them on (large installs). */
  optIn?: boolean;
  /** Longest a single run may take. */
  timeoutMs: number;
}

const GITLEAKS_VERSION = "8.30.1";
const GITLEAKS_BASE = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}`;
const OSV_VERSION = "2.6.0";
const OSV_BASE = `https://github.com/google/osv-scanner/releases/download/v${OSV_VERSION}`;

/** Python 3.12 or newer for every locked tool (cisco-ai-mcp-scanner needs 3.11.4+). */
const PYTHON = ">=3.12";

export const SECURITY_TOOLS: Record<SecurityToolId, SecurityToolSpec> = {
  gitleaks: {
    id: "gitleaks", label: "gitleaks", command: "gitleaks", version: GITLEAKS_VERSION, licence: "MIT",
    homepage: "https://github.com/gitleaks/gitleaks", approxMB: 21, hosts: ["github.com"], timeoutMs: 300_000,
    // sha256 values from gitleaks_8.30.1_checksums.txt on the release.
    source: { kind: "binary", assets: {
      "linux-x64": { url: `${GITLEAKS_BASE}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz`, sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb", archive: "tar.gz", member: "gitleaks" },
      "linux-arm64": { url: `${GITLEAKS_BASE}/gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz`, sha256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080", archive: "tar.gz", member: "gitleaks" },
      "darwin-x64": { url: `${GITLEAKS_BASE}/gitleaks_${GITLEAKS_VERSION}_darwin_x64.tar.gz`, sha256: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709", archive: "tar.gz", member: "gitleaks" },
      "darwin-arm64": { url: `${GITLEAKS_BASE}/gitleaks_${GITLEAKS_VERSION}_darwin_arm64.tar.gz`, sha256: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5", archive: "tar.gz", member: "gitleaks" },
      "win32-x64": { url: `${GITLEAKS_BASE}/gitleaks_${GITLEAKS_VERSION}_windows_x64.zip`, sha256: "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e", archive: "zip", member: "gitleaks.exe" },
      "win32-arm64": { url: `${GITLEAKS_BASE}/gitleaks_${GITLEAKS_VERSION}_windows_arm64.zip`, sha256: "b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f", archive: "zip", member: "gitleaks.exe" },
    } },
  },
  ruff: {
    id: "ruff", label: "ruff S", command: "ruff", version: "0.16.9", licence: "MIT (S rules port bandit, Apache-2.0)",
    homepage: "https://github.com/astral-sh/ruff", approxMB: 24, hosts: ["pypi.org"], timeoutMs: 120_000,
    source: { kind: "uv-lock", package: "ruff", lock: ruffLock, lockName: "ruff.txt", python: PYTHON, entry: "ruff" },
  },
  semgrep: {
    id: "semgrep", label: "semgrep", command: "semgrep", version: "1.178.0", licence: "LGPL-2.1-or-later (engine only; Casper's rules are MIT)",
    homepage: "https://github.com/semgrep/semgrep", approxMB: 300, hosts: ["pypi.org"], timeoutMs: 600_000,
    source: { kind: "uv-lock", package: "semgrep", lock: semgrepLock, lockName: "semgrep.txt", python: PYTHON, entry: "semgrep" },
  },
  zizmor: {
    id: "zizmor", label: "zizmor", command: "zizmor", version: "1.30.1", licence: "MIT",
    homepage: "https://github.com/zizmorcore/zizmor", approxMB: 26, hosts: ["pypi.org"], timeoutMs: 120_000,
    source: { kind: "uv-lock", package: "zizmor", lock: zizmorLock, lockName: "zizmor.txt", python: PYTHON, entry: "zizmor" },
  },
  "osv-scanner": {
    id: "osv-scanner", label: "osv-scanner", command: "osv-scanner", version: OSV_VERSION, licence: "Apache-2.0",
    homepage: "https://github.com/google/osv-scanner", approxMB: 55, hosts: ["github.com"], timeoutMs: 300_000,
    // sha256 values from osv-scanner_SHA256SUMS on the release.
    source: { kind: "binary", assets: {
      "linux-x64": { url: `${OSV_BASE}/osv-scanner_linux_amd64`, sha256: "ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108", archive: "raw", member: "osv-scanner" },
      "linux-arm64": { url: `${OSV_BASE}/osv-scanner_linux_arm64`, sha256: "2c71403eb443d05891c4f268c3ad771cf4f16e5443463fd7851ef8f454d3c7e4", archive: "raw", member: "osv-scanner" },
      "darwin-x64": { url: `${OSV_BASE}/osv-scanner_darwin_amd64`, sha256: "60c5296637e977b28eeda5c7f13573e447659a632922737f94d11fa7e30ad6ca", archive: "raw", member: "osv-scanner" },
      "darwin-arm64": { url: `${OSV_BASE}/osv-scanner_darwin_arm64`, sha256: "98c460dcd37de25819babd757d04542045b6243113e209edcd4d89fedb0256b4", archive: "raw", member: "osv-scanner" },
      "win32-x64": { url: `${OSV_BASE}/osv-scanner_windows_amd64.exe`, sha256: "e0ed7644118b717b028c249ee9d3515024e55e8510747ca08906eb96765354d6", archive: "raw", member: "osv-scanner.exe" },
      "win32-arm64": { url: `${OSV_BASE}/osv-scanner_windows_arm64.exe`, sha256: "ca1379da0e408279ef2c85cde0846a903495738a91c7b065a208048437c1686c", archive: "raw", member: "osv-scanner.exe" },
    } },
  },
  "ansible-lint": {
    id: "ansible-lint", label: "ansible-lint", command: "ansible-lint", version: "26.9.0", licence: "GPL-3.0-or-later (called, never copied)",
    homepage: "https://github.com/ansible/ansible-lint", approxMB: 55, hosts: ["pypi.org"], timeoutMs: 600_000,
    source: { kind: "uv-lock", package: "ansible-lint", lock: ansibleLintLock, lockName: "ansible-lint.txt", python: PYTHON, entry: "ansible-lint" },
  },
  "mcp-scanner": {
    id: "mcp-scanner", label: "mcp-scanner", command: "mcp-scanner", version: "4.8.4", licence: "Apache-2.0",
    homepage: "https://github.com/cisco-ai-defense/mcp-scanner", approxMB: 235, hosts: ["pypi.org"], timeoutMs: 300_000, optIn: true,
    source: { kind: "uv-lock", package: "cisco-ai-mcp-scanner", lock: mcpScannerLock, lockName: "cisco-ai-mcp-scanner.txt", python: PYTHON, entry: "mcp-scanner" },
  },
};

export function hostPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): PlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return (["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"] as const).find((known) => known === key);
}

/**
 * The curated ruff S set: medium-and-up bandit checks. Plain `--select S` gave 185 findings on one
 * real MCP server repo (mostly asserts, temp paths and urlopen); this set gave 25.
 */
export const RUFF_SECURITY_RULES = [
  "S102", "S103", "S104", "S105", "S106", "S107", "S113", "S201", "S301", "S307", "S324",
  "S501", "S502", "S503", "S504", "S505", "S506", "S507", "S508", "S509",
  "S602", "S604", "S605", "S608", "S611", "S701",
] as const;

/** What Casper decided about each tool's own config and ignore files for this run. */
export interface ToolArgsContext {
  /** The folder the tool runs in: the repo root. */
  root: string;
  /** Casper's semgrep rule files, written to a temp folder for this run. */
  semgrepRules: string[];
  /** Explicit files for semgrep when the repo's .semgrepignore is not used (explicit files skip it). */
  semgrepTargets?: string[];
  /** The committed .gitleaks.toml, or Casper's own "default rules" config when it changed. */
  gitleaksConfig: string;
  /** A folder whose .gitleaksignore gitleaks reads: the repo root when committed, else an empty folder. */
  gitleaksIgnoreDir: string;
  /** Casper's empty config when the repo's osv-scanner.toml is not used; unset uses the repo's. */
  osvConfig?: string;
  /** Casper's empty ansible-lint config and ignore file when the repo's are not used. */
  ansibleConfig?: string;
  ansibleIgnore?: string;
  ansibleTargets?: string[];
  /** The tools/list JSON for mcp-scanner. */
  mcpToolsJson?: string;
}

/**
 * The argument list for each tool: offline flags always on, inline ignores always off (Casper applies
 * ignores itself, so only the user's committed or approved ones count), JSON output on stdout.
 */
export function toolArgs(id: SecurityToolId, context: ToolArgsContext): string[] {
  switch (id) {
    case "gitleaks":
      return ["dir", ".", "--redact", "--no-banner", "--report-format", "json", "--report-path", "-", "--ignore-gitleaks-allow",
        "--exit-code", "1", "--log-level", "error", "--max-target-megabytes", "5",
        "--config", context.gitleaksConfig, "--gitleaks-ignore-path", context.gitleaksIgnoreDir];
    case "ruff":
      return ["check", "--isolated", "--no-cache", "--ignore-noqa", "--select", RUFF_SECURITY_RULES.join(","),
        "--output-format", "json", "--extend-exclude", "tests", "--extend-exclude", "test", "--exit-zero", "."];
    case "semgrep":
      return ["scan", "--metrics=off", "--disable-version-check", "--disable-nosem", "--oss-only", "--json", "--quiet", "--no-rewrite-rule-ids",
        ...context.semgrepRules.flatMap((rule) => ["--config", rule]), "--", ...(context.semgrepTargets ?? ["."])];
    case "zizmor":
      return ["--offline", "--no-ignores", "--no-config", "--no-progress", "--no-exit-codes", "--format", "json", "."];
    case "osv-scanner":
      return ["scan", "source", "--offline", "--format", "json", "--recursive", ...(context.osvConfig ? ["--config", context.osvConfig] : []), "."];
    case "ansible-lint":
      return ["--offline", "-f", "codeclimate", "--nocolor",
        ...(context.ansibleConfig ? ["-c", context.ansibleConfig] : []), ...(context.ansibleIgnore ? ["-i", context.ansibleIgnore] : []),
        ...(context.ansibleTargets ?? [])];
    case "mcp-scanner":
      if (!context.mcpToolsJson) throw new Error("mcp-scanner needs the server's tool list");
      return ["--analyzers", "yara", "--format", "raw", "static", "--tools", context.mcpToolsJson];
  }
}

/** Exit codes that mean "the tool ran to the end" (with or without findings). Anything else is "not run". */
export function ranToEnd(id: SecurityToolId, exitCode: number | null): boolean {
  if (exitCode === null) return false;
  switch (id) {
    case "gitleaks": return exitCode === 0 || exitCode === 1;
    case "ruff": return exitCode === 0 || exitCode === 1;
    case "semgrep": return exitCode === 0 || exitCode === 1;
    case "zizmor": return exitCode === 0 || exitCode >= 10 && exitCode <= 14;
    // 128: no packages found, which is fine: nothing to check.
    case "osv-scanner": return exitCode === 0 || exitCode === 1 || exitCode === 128;
    case "ansible-lint": return exitCode === 0 || exitCode === 2;
    case "mcp-scanner": return exitCode === 0;
  }
}

/** The pinned copy's folder: ~/.casper/tools/<id>-<version>. */
export function pinnedToolDir(homeDir: string, spec: SecurityToolSpec): string {
  return path.join(homeDir, ".casper", "tools", `${spec.id}-${spec.version}`);
}

/** The program inside a pinned copy. */
export function pinnedToolPath(homeDir: string, spec: SecurityToolSpec, platform: NodeJS.Platform = process.platform): string {
  const dir = pinnedToolDir(homeDir, spec);
  const exe = platform === "win32" ? ".exe" : "";
  if (spec.source.kind === "binary") return path.join(dir, "bin", `${spec.command}${exe}`);
  return platform === "win32" ? path.join(dir, "venv", "Scripts", `${spec.source.entry}.exe`) : path.join(dir, "venv", "bin", spec.source.entry);
}
