import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parentsStayInside } from "../platform/files";
import { redactPreview } from "../tui/format";
import { detectProject, toolNeeds, type ProjectFacts, type ToolNeed } from "./detect";
import { securityEnv, securityHome } from "./env";
import { changesSinceHead, gitState } from "./git";
import { findTool, osvDbDir, osvDbState, ownCopyLine, type ToolLocation } from "./install";
import { PARSERS, semgrepErrors } from "./parse";
import { fastapiRules, mcpRules } from "./rules";
import { runTool, type ToolRunner, type ToolRunResult } from "./spawn";
import { applyIgnores, configIgnores, judgeIgnoreFiles, loadApprovals, newIgnores, type IgnoreContext } from "./suppressions";
import { ranToEnd, SECURITY_TOOLS, toolArgs, type SecurityToolSpec, type ToolArgsContext } from "./tools";
import { SECURITY_TOOL_ORDER, type IgnoreEntry, type IgnoreFile, type SecurityFinding, type SecurityToolId } from "./types";

/**
 * The security check engine behind /security-review and `casper security`. Shaped like `casper mcp check`:
 * each tool is one step, and a tool that is missing, crashes or times out is "not run" with a reason and
 * never stops the others. No model is called here: this is tools only, and costs no tokens.
 */

export type ToolStatus = "ok" | "problems" | "not-run" | "not-needed" | "off";

export interface ToolReport {
  id: SecurityToolId;
  label: string;
  status: ToolStatus;
  /** The plain detail after the status: a reason, the advisory data's age, "online checks off". */
  text: string;
  problems: number;
  notes: number;
  /** The version that ran, and whether it was Casper's pinned copy or the user's own. */
  version?: string;
  source?: "pinned" | "path";
  /** "gitleaks: using your 8.18.0 (Casper pins 8.30.1)". */
  ownCopy?: string;
}

export interface SecurityReport {
  target: { name: string; path: string };
  tools: ToolReport[];
  /** Findings no committed or approved ignore hides, most severe first. */
  findings: SecurityFinding[];
  ignores: {
    /** Findings hidden by ignores the user committed (inline markers and committed config files). */
    committed: number;
    /** Findings hidden by ignores the user approved in Casper. */
    approved: number;
    /** Ignores added since the last commit that the user has not approved. They hide nothing. */
    new: IgnoreEntry[];
    /** Ignores outside git: Casper cannot tell who added them, so they hide nothing. */
    unknown: IgnoreEntry[];
  };
  /** The tools' own ignore and config files, and whether each was used. */
  ignoreFiles: IgnoreFile[];
  /** Needed tools that are not installed (the host offers to install them). */
  missing: SecurityToolId[];
  problems: number;
  notes: number;
  notRun: number;
  exitCode: 0 | 1;
}

export interface SecurityCheckOptions {
  /** The repo folder. */
  root: string;
  homeDir: string;
  /** The environment tools start from; only an allowlist of names passes on. */
  baseEnv?: NodeJS.ProcessEnv;
  /** --strict: a check that did not run, or a new ignore, also exits 1. */
  strict?: boolean;
  /** mcp-scanner is opt-in (a large install). */
  mcpScanner?: boolean;
  /** The server's tools/list JSON for mcp-scanner (from `casper mcp check`). */
  mcpToolsJson?: string;
  /** Changed ignore files the user chose to use this run ("1 Use my changed file"). */
  useChangedIgnoreFiles?: string[];
  /** Run only these tools (tests, `casper security --only`). */
  only?: SecurityToolId[];
  timeouts?: Partial<Record<SecurityToolId, number>>;
  /** Test seams. */
  find?: (spec: SecurityToolSpec) => Promise<ToolLocation>;
  run?: ToolRunner;
  now?: () => Date;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** Progress while the check runs. */
  write?: (text: string) => void;
}

const TEXT_BYTES = 4 * 1024 * 1024;
const SEMGREP_TARGET_LIMIT = 5000;
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/** A repo file's text for ignore markers: a regular file inside the root, never through a link. */
export async function readRepoText(root: string, relative: string): Promise<string | undefined> {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) return undefined;
  if (!(await parentsStayInside(root, relative))) return undefined;
  try {
    const details = await lstat(path.join(root, relative));
    if (!details.isFile() || details.size > TEXT_BYTES) return undefined;
    return await readFile(path.join(root, relative), "utf8");
  } catch { return undefined; }
}

/** Casper's "default rules" gitleaks config, used when the repo's own .gitleaks.toml is not. */
export const GITLEAKS_DEFAULT_CONFIG = `# Casper: gitleaks' own default rules, skipping folders that are not the project's code.
[extend]
useDefault = true

[[allowlists]]
description = "Casper: installed packages and caches"
paths = ['''(^|/)(node_modules|\\.venv|venv|\\.git|__pycache__|\\.tox|\\.mypy_cache|\\.ruff_cache)/''']
`;

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function minutes(ms: number): string {
  return ms >= 60_000 ? plural(Math.round(ms / 60_000), "minute") : plural(Math.round(ms / 1000), "second");
}

/** A plain reason for a run that did not finish. The tool's own words are redacted and cut short. */
function notRunReason(spec: SecurityToolSpec, result: ToolRunResult, timeoutMs: number): string {
  if (result.ended === "timeout") return `took longer than ${minutes(timeoutMs)}; stopped`;
  if (result.ended === "cancelled") return "stopped";
  if (result.ended === "no_start") return "could not start";
  if (result.ended === "too_large") return "its report was too large to read";
  const last = result.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
  const code = result.signal ? `was stopped by ${result.signal}` : `ended with exit code ${result.exitCode}`;
  return last ? `${code}: ${redactPreview(last).slice(0, 160)}` : code;
}

/** The osv-scanner detail: "advisory data downloaded 2026-09-20 (9 days old)". */
export function osvAgeText(downloadedAt: Date, ageDays: number): string {
  return `advisory data downloaded ${downloadedAt.toISOString().slice(0, 10)} (${ageDays === 0 ? "today" : ageDays === 1 ? "1 day old" : `${ageDays} days old`})`;
}

export const OSV_NO_DATA = "no advisory data yet. /security-review update downloads it (asks first)";
export const MCP_NEEDS_TOOLS = "needs the server's tool list: save its tools/list reply to a file, then casper security --mcp-tools <file>";

export class SecurityCheck {
  private readonly write: (text: string) => void;
  private readonly now: () => Date;

  constructor(private readonly options: SecurityCheckOptions) {
    this.write = options.write ?? (() => {});
    this.now = options.now ?? (() => new Date());
  }

  async run(): Promise<SecurityReport> {
    const root = await realpath(path.resolve(this.options.root));
    if (!(await stat(root)).isDirectory()) throw new Error(`not a folder: ${this.options.root}`);
    const { homeDir } = this.options;
    const platform = this.options.platform ?? process.platform;
    const git = await gitState(root);
    const changes = await changesSinceHead(root, git);
    const context: IgnoreContext = {
      root, git, changed: changes?.changed, untracked: changes?.untracked,
      approvals: await loadApprovals(root, homeDir), readText: (file) => readRepoText(root, file),
    };
    const facts = await detectProject(root, git);
    const needs = toolNeeds(facts, { mcpScanner: this.options.mcpScanner, mcpToolsJson: this.options.mcpToolsJson });
    const ignoreFiles = await judgeIgnoreFiles(context, { useChanged: this.options.useChangedIgnoreFiles });
    const used = (file: string) => ignoreFiles.some((entry) => entry.file === file && entry.used);

    // The tools' stand-in HOME: an empty folder of Casper's, so they never read the user's own settings.
    await mkdir(path.join(securityHome(homeDir), ".config"), { recursive: true, mode: 0o700 });
    const scratch = await mkdtemp(path.join(os.tmpdir(), "casper-security-"));
    const tools: ToolReport[] = [];
    const findings: SecurityFinding[] = [];
    const missing: SecurityToolId[] = [];
    try {
      const args = await this.prepare(scratch, root, facts, used);
      for (const id of SECURITY_TOOL_ORDER) {
        if (this.options.signal?.aborted) break;
        if (this.options.only && !this.options.only.includes(id)) continue;
        const outcome = await this.step(id, needs[id], root, args, facts, platform);
        tools.push(outcome.report);
        findings.push(...outcome.findings);
        if (outcome.missing) missing.push(id);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }

    const applied = await applyIgnores(findings, context, configIgnores(ignoreFiles));
    const added = await newIgnores(context);
    const newEntries = dedupe([...applied.flagged.filter((entry) => entry.status === "new"), ...added]);
    const unknownEntries = dedupe(applied.flagged.filter((entry) => entry.status === "unknown"));
    const visible = applied.visible.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
    for (const tool of tools) {
      if (tool.status !== "ok" && tool.status !== "problems") continue;
      const mine = visible.filter((finding) => finding.tool === tool.id);
      tool.problems = mine.filter((finding) => finding.severity !== "low").length;
      tool.notes = mine.length - tool.problems;
      tool.status = tool.problems ? "problems" : "ok";
    }
    const problems = visible.filter((finding) => finding.severity !== "low").length;
    const notRun = tools.filter((tool) => tool.status === "not-run").length;
    const failing = problems > 0 || (this.options.strict === true && (notRun > 0 || newEntries.length > 0));
    return {
      target: { name: path.basename(root), path: root },
      tools, findings: visible,
      ignores: { committed: applied.hidden.committed + applied.hidden.config, approved: applied.hidden.approved, new: newEntries, unknown: unknownEntries },
      ignoreFiles: ignoreFiles.map(({ text: _text, ...entry }) => entry),
      missing, problems, notes: visible.length - problems, notRun,
      exitCode: failing ? 1 : 0,
    };
  }

  /** Writes Casper's rules and stand-in config files for this run, and decides which repo files are used. */
  private async prepare(scratch: string, root: string, facts: ProjectFacts, used: (file: string) => boolean): Promise<ToolArgsContext> {
    const semgrepRules: string[] = [];
    if (facts.mcpServer) { await writeFile(path.join(scratch, "mcp.yaml"), mcpRules); semgrepRules.push(path.join(scratch, "mcp.yaml")); }
    if (facts.fastapi) { await writeFile(path.join(scratch, "fastapi.yaml"), fastapiRules); semgrepRules.push(path.join(scratch, "fastapi.yaml")); }
    await writeFile(path.join(scratch, "gitleaks-default.toml"), GITLEAKS_DEFAULT_CONFIG);
    const emptyDir = path.join(scratch, "empty");
    await mkdir(emptyDir);
    await writeFile(path.join(scratch, "osv-scanner.toml"), "# Casper: the repo's osv-scanner.toml changed since the last commit, so none is used.\n");
    await writeFile(path.join(scratch, "ansible-lint.yml"), "# Casper: the repo's ansible-lint config changed since the last commit, so none is used.\nskip_list: []\n");
    await writeFile(path.join(scratch, "ansible-lint-ignore"), "");
    // ansible-lint runs Ansible, which reads ./ansible.cfg: a vault_password_file there is a script it would run.
    await writeFile(path.join(scratch, "ansible.cfg"), "# Written by Casper for one run. The repo's own ansible.cfg is not read.\n[defaults]\nretry_files_enabled = False\n\n[inventory]\nenable_plugins = host_list, yaml, ini\n");
    const ansibleConfigs = [".ansible-lint", ".ansible-lint.yml", ".ansible-lint.yaml", ".config/ansible-lint.yml", ".config/ansible-lint.yaml"];
    const ansibleIgnores = [".ansible-lint-ignore", ".config/ansible-lint-ignore.txt"];
    const exists = async (file: string) => (await readRepoText(root, file)) !== undefined;
    const anyUnused = async (files: string[]) => { for (const file of files) if (await exists(file) && !used(file)) return true; return false; };
    const semgrepIgnoreUsed = !(await exists(".semgrepignore")) || used(".semgrepignore");
    return {
      root,
      semgrepRules,
      // Explicit files skip .semgrepignore, which cannot be turned off any other way.
      semgrepTargets: semgrepIgnoreUsed ? undefined : facts.python.slice(0, SEMGREP_TARGET_LIMIT),
      gitleaksConfig: (await exists(".gitleaks.toml")) && used(".gitleaks.toml") ? path.join(root, ".gitleaks.toml") : path.join(scratch, "gitleaks-default.toml"),
      gitleaksIgnoreDir: (await exists(".gitleaksignore")) && used(".gitleaksignore") ? root : emptyDir,
      osvConfig: (await exists("osv-scanner.toml")) && !used("osv-scanner.toml") ? path.join(scratch, "osv-scanner.toml") : undefined,
      ansibleConfig: await anyUnused(ansibleConfigs) ? path.join(scratch, "ansible-lint.yml") : undefined,
      ansibleIgnore: await anyUnused(ansibleIgnores) ? path.join(scratch, "ansible-lint-ignore") : undefined,
      ansibleTargets: facts.ansible.filter((file) => file !== "."),
      ansibleCfg: path.join(scratch, "ansible.cfg"),
      mcpToolsJson: this.options.mcpToolsJson,
    };
  }

  private async step(id: SecurityToolId, need: ToolNeed, root: string, args: ToolArgsContext, facts: ProjectFacts, platform: NodeJS.Platform):
    Promise<{ report: ToolReport; findings: SecurityFinding[]; missing?: boolean }> {
    const spec = SECURITY_TOOLS[id];
    const report = (status: ToolStatus, text: string, extra: Partial<ToolReport> = {}): ToolReport =>
      ({ id, label: spec.label, status, text, problems: 0, notes: 0, ...extra });
    if (!need.needed) return { report: report(need.off ? "off" : "not-needed", need.reason), findings: [] };
    if (id === "semgrep" && platform === "win32") return { report: report("not-run", "not run on Windows (semgrep needs Linux or macOS)"), findings: [] };
    if (id === "mcp-scanner" && !args.mcpToolsJson) return { report: report("not-run", MCP_NEEDS_TOOLS), findings: [] };
    if (id === "semgrep" && args.semgrepTargets && !args.semgrepTargets.length) return { report: report("not-needed", "no Python files"), findings: [] };
    const location = await (this.options.find ?? ((toolSpec) => findTool(toolSpec, { homeDir: this.options.homeDir, env: this.options.baseEnv, run: this.options.run })))(spec);
    if (location.kind === "missing") return { report: report("not-run", "not installed"), findings: [], missing: true };
    const source = { version: location.version, source: location.kind, ownCopy: ownCopyLine(spec, location) };
    const extraEnv: Record<string, string> = {};
    let okText = "";
    if (id === "osv-scanner") {
      const state = await osvDbState(this.options.homeDir, this.now());
      if (!state.present) return { report: report("not-run", OSV_NO_DATA, source), findings: [] };
      extraEnv.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY = osvDbDir(this.options.homeDir);
      okText = osvAgeText(state.downloadedAt!, state.ageDays!);
    }
    if (id === "zizmor") okText = "online checks off (offline)";
    if (id === "ansible-lint") okText = "it runs this repo's own Ansible plugins";
    if (id === "ansible-lint" && args.ansibleCfg) extraEnv.ANSIBLE_CONFIG = args.ansibleCfg;
    if (id === "ansible-lint" && location.kind === "pinned") extraEnv.PATH = `${path.dirname(location.path)}${path.delimiter}${this.options.baseEnv?.PATH ?? process.env.PATH ?? ""}`;
    const timeoutMs = this.options.timeouts?.[id] ?? spec.timeoutMs;
    this.write(`Running ${spec.label}…\n`);
    let argv: string[];
    try { argv = toolArgs(id, args); } catch (error) { return { report: report("not-run", error instanceof Error ? error.message : String(error), source), findings: [] }; }
    const result = await (this.options.run ?? runTool)({
      file: location.path, args: argv, cwd: root, timeoutMs, signal: this.options.signal,
      env: securityEnv(this.options.baseEnv ?? process.env, { homeDir: this.options.homeDir, extra: extraEnv, platform }),
    });
    if (id === "osv-scanner" && /no offline version of the OSV database/i.test(result.stderr)) {
      return { report: report("not-run", "no advisory data for some package types here. /security-review update downloads it (asks first)", source), findings: [] };
    }
    if (result.ended || !ranToEnd(id, result.exitCode)) return { report: report("not-run", notRunReason(spec, result, timeoutMs), source), findings: [] };
    let parsed: SecurityFinding[];
    try {
      parsed = id === "osv-scanner" && result.exitCode === 128 ? [] : PARSERS[id](result.stdout, { root, readText: () => undefined });
      if (id === "osv-scanner") {
        const texts = new Map<string, string | undefined>();
        for (const finding of parsed) if (finding.file && !texts.has(finding.file)) texts.set(finding.file, await readRepoText(root, finding.file));
        parsed = PARSERS[id](result.stdout, { root, readText: (file) => texts.get(file) });
      }
      if (id === "mcp-scanner") parsed = parsed.map((finding) => ({ ...finding, file: args.mcpToolsJson ? path.basename(args.mcpToolsJson) : "" }));
    } catch (error) {
      return { report: report("not-run", `its report could not be read (${error instanceof Error ? redactPreview(error.message).slice(0, 120) : "unknown"})`, source), findings: [] };
    }
    if (id === "semgrep") {
      const errors = semgrepErrors(result.stdout);
      if (errors) okText = `${plural(errors, "file")} could not be read`;
    }
    return { report: report("ok", okText, source), findings: parsed };
  }
}

function dedupe(entries: IgnoreEntry[]): IgnoreEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.file}:${entry.line}:${entry.tool}:${entry.marker}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runSecurityCheck(options: SecurityCheckOptions): Promise<SecurityReport> {
  return new SecurityCheck(options).run();
}

/**
 * The tools this project needs that are not installed, found before anything runs, so the host can ask once
 * ("1 Install them · 2 Run what's installed · 3 Stop") before any download.
 */
export async function missingSecurityTools(options: Pick<SecurityCheckOptions, "root" | "homeDir" | "baseEnv" | "mcpScanner" | "mcpToolsJson" | "find" | "run" | "platform">): Promise<SecurityToolId[]> {
  const root = await realpath(path.resolve(options.root));
  const platform = options.platform ?? process.platform;
  const facts = await detectProject(root, await gitState(root));
  const needs = toolNeeds(facts, { mcpScanner: options.mcpScanner, mcpToolsJson: options.mcpToolsJson });
  const missing: SecurityToolId[] = [];
  for (const id of SECURITY_TOOL_ORDER) {
    if (!needs[id].needed || (id === "semgrep" && platform === "win32") || (id === "mcp-scanner" && !options.mcpToolsJson)) continue;
    const spec = SECURITY_TOOLS[id];
    const location = await (options.find ?? ((toolSpec) => findTool(toolSpec, { homeDir: options.homeDir, env: options.baseEnv, run: options.run })))(spec);
    if (location.kind === "missing") missing.push(id);
  }
  return missing;
}

export interface IgnoreState {
  /** The tools' own ignore files and whether each would be used now. */
  files: Array<IgnoreFile & { text: string }>;
  /** Ignores added since the last commit that the user has not approved. */
  fresh: IgnoreEntry[];
  approvals: Awaited<ReturnType<typeof loadApprovals>>;
}

/** Which ignores count right now, with no tool run: for the questions before a run and /security-review ignores. */
export async function ignoreState(rootFolder: string, homeDir: string): Promise<IgnoreState> {
  const root = await realpath(path.resolve(rootFolder));
  const git = await gitState(root);
  const changes = await changesSinceHead(root, git);
  const approvals = await loadApprovals(root, homeDir);
  const context: IgnoreContext = { root, git, changed: changes?.changed, untracked: changes?.untracked, approvals, readText: (file) => readRepoText(root, file) };
  return { files: await judgeIgnoreFiles(context), fresh: dedupe(await newIgnores(context)), approvals };
}
