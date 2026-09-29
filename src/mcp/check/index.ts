import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { UsageError, type McpCheckCommand } from "../../cli-args";
import { redactPreview } from "../../tui/format";
import { findExampleConfigs, readCheckConfig, reviewExampleConfigs, startDefinition, type CheckConfig, type ExampleConfig, type StartDefinition } from "./examples";
import { formatCheckHeader } from "./format";
import { findRepoCommands, REPO_TIMEOUTS, repoFinding, runRepoCommand, type RepoCommand, type RepoCommands } from "./repo";
import { checkEnv } from "./sandbox";
import { serverSteps } from "./server";

export type FindingStatus = "ok" | "fail" | "warn" | "note" | "skip" | "none";
/** Report sections, in print order. */
export type CheckSection = "repo" | "server" | "examples" | "inspector" | "live";

export interface Finding {
  section: CheckSection;
  status: FindingStatus;
  /** A short name: "doctor", a tool name, a file name. */
  label: string;
  /** One plain sentence. Server and repo text is untrusted: it is escaped when printed. */
  text: string;
  /** Extra lines printed under the finding, such as the last lines a server printed (secrets hidden). */
  detail?: string[];
}

export interface CheckReport {
  target: { name: string; path: string };
  /** True unless --live: no tool calls, credentials removed, web proxy blocked (best effort). */
  offline: boolean;
  findings: Finding[];
  problems: number;
  warnings: number;
  notes: number;
  /** 0 no problems, 1 problems (or warnings with --strict). Usage mistakes exit 64 before a report exists. */
  exitCode: 0 | 1;
}

/** What a later check step (server probe, labels, schemas, router, Inspector, live calls) can use. */
export interface CheckContext {
  root: string;
  cmd: McpCheckCommand;
  /** The environment for anything this check starts: offline (scrubbed) unless --live. */
  env: NodeJS.ProcessEnv;
  config: CheckConfig;
  repo: RepoCommands;
  examples: ExampleConfig[];
  start?: StartDefinition;
  signal: AbortSignal;
  /** Output shown while the check runs (progress, failing command output). */
  write(text: string): void;
  /** Cleanup that must run when the check ends or is interrupted, e.g. stopping the server. */
  onClose(cleanup: () => Promise<void> | void): void;
}

export type CheckStep = (context: CheckContext) => Promise<Finding[]>;

export interface McpCheckOptions {
  /** Progress and failing command output. Defaults to nothing. */
  write?: (text: string) => void;
  /** The environment the check starts from; defaults to Casper's own. */
  baseEnv?: NodeJS.ProcessEnv;
  timeouts?: Partial<typeof REPO_TIMEOUTS>;
  homeDir?: string;
  /** Starts the server and checks startup, stdout, labels, schemas and the router. Defaults to
   * serverSteps(); give it together with `live`, which uses the connection it opens. */
  serverChecks?: CheckStep;
  /** A second-client cross-check (such as the MCP Inspector CLI); skipped when not given. */
  inspector?: CheckStep;
  /** Read-only calls; runs only with --live. Defaults to serverSteps(). */
  live?: CheckStep;
}

const OUTPUT_LINES = 40;

export function countFindings(findings: readonly Finding[]): Pick<CheckReport, "problems" | "warnings" | "notes"> {
  return {
    problems: findings.filter((finding) => finding.status === "fail").length,
    warnings: findings.filter((finding) => finding.status === "warn").length,
    notes: findings.filter((finding) => finding.status === "note").length,
  };
}

export function checkExitCode(findings: readonly Finding[], strict: boolean): 0 | 1 {
  const { problems, warnings } = countFindings(findings);
  return problems > 0 || (strict && warnings > 0) ? 1 : 0;
}

/** The repo folder, resolved. A missing folder is a usage mistake (exit 64), not a failed check. */
export async function resolveRepoRoot(repo: string): Promise<string> {
  const resolved = path.resolve(repo);
  if (!(await stat(resolved).then((entry) => entry.isDirectory(), () => false))) throw new UsageError(`mcp check: not a folder: ${repo}`);
  return realpath(resolved);
}

/**
 * `casper mcp check`: runs the repo's own doctor, safety tests and full tests, then checks the server and
 * its example configs. Offline by default: it calls no tools. One failing step never stops the others.
 */
export class McpCheck {
  private readonly controller = new AbortController();
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private readonly write: (text: string) => void;
  private running?: Promise<CheckReport>;
  private readonly serverChecks: CheckStep;
  private readonly live: CheckStep;

  constructor(private readonly cmd: McpCheckCommand, private readonly options: McpCheckOptions = {}) {
    this.write = options.write ?? (() => {});
    const defaults = serverSteps();
    this.serverChecks = options.serverChecks ?? defaults.serverChecks;
    this.live = options.live ?? defaults.live;
  }

  run(): Promise<CheckReport> {
    this.running ??= this.check();
    return this.running;
  }

  /** Stops the repo commands and the server, then runs every registered cleanup. */
  async close(): Promise<void> {
    this.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.running?.catch(() => undefined), new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch { /* keep cleaning up */ }
    }
  }

  private async check(): Promise<CheckReport> {
    const root = await resolveRepoRoot(this.cmd.repo);
    const offline = !this.cmd.live;
    const target = { name: path.basename(root), path: root };
    this.write(formatCheckHeader({ target, offline }));
    const findings: Finding[] = [];
    const signal = this.controller.signal;
    const env = checkEnv(this.cmd.live, this.options.baseEnv ?? process.env, this.cmd.env);
    const step = async (fallback: Omit<Finding, "text" | "status">, body: () => Promise<Finding[]>) => {
      if (signal.aborted) return;
      try { findings.push(...await body()); } catch (error) {
        findings.push({ ...fallback, status: "fail", text: `Check could not run: ${redactPreview(error instanceof Error ? error.message : String(error))}` });
      }
    };

    const loaded = await readCheckConfig(root);
    if (loaded.error) findings.push({ section: "repo", status: "fail", label: "settings", text: loaded.error });
    const config = loaded.config;
    let repo: RepoCommands = { testFiles: [] };
    await step({ section: "repo", label: "repo" }, async () => { repo = await findRepoCommands(root); return []; });
    const timeouts = { ...REPO_TIMEOUTS, ...this.options.timeouts };
    const runOne = async (label: string, command: RepoCommand | undefined, timeoutMs: number, missing: Finding) => {
      await step({ section: "repo", label }, async () => {
        if (!command) return [missing];
        this.write(`Running ${label}: ${redactPreview(command.command)}\n`);
        const result = await runRepoCommand(command, { root, env, timeoutMs, signal });
        const finding = repoFinding(label, command, result);
        if (finding.status === "fail") this.write(commandOutput(label, `${result.stdout}\n${result.stderr}`));
        return [finding];
      });
    };
    await runOne("doctor", config.doctor ? { command: config.doctor } : repo.doctor, timeouts.doctor,
      { section: "repo", status: "none", label: "doctor", text: "No doctor found. Add a doctor script, or set it in .casper/mcp-check.json." });
    await runOne("safety tests", config.safetyTests ? { command: config.safetyTests } : repo.safetyTests, timeouts.safetyTests,
      { section: "repo", status: "warn", label: "safety tests", text: "No safety tests found (names with write, gate, readonly, guard, block, redact, confirm, dry_run, annotation)." });
    if (this.cmd.quick) findings.push({ section: "repo", status: "skip", label: "tests", text: "--quick" });
    else await runOne("tests", config.tests ? { command: config.tests } : repo.tests, timeouts.tests,
      { section: "repo", status: "none", label: "tests", text: "No test command found. Set \"tests\" in .casper/mcp-check.json." });

    let examples: ExampleConfig[] = [];
    await step({ section: "examples", label: "examples" }, async () => { examples = await findExampleConfigs(root); return []; });
    let start: StartDefinition | undefined;
    await step({ section: "server", label: "starts" }, async () => {
      const found = await startDefinition(root, this.cmd, config, examples, this.options.homeDir);
      if ("error" in found) return [{ section: "server", status: "fail", label: "starts", text: found.error }];
      start = found;
      return [];
    });
    const context: CheckContext = {
      root, cmd: this.cmd, env, config, repo, examples, start, signal,
      write: this.write, onClose: (cleanup) => { this.cleanups.push(cleanup); },
    };
    if (start) await step({ section: "server", label: "starts" }, () => this.serverChecks(context));
    await step({ section: "examples", label: "examples" }, async () => reviewExampleConfigs(examples));
    if (this.options.inspector) await step({ section: "inspector", label: "inspector" }, () => this.options.inspector!(context));
    if (this.cmd.live) await step({ section: "live", label: "live" }, () => this.live(context));
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch { /* keep cleaning up */ }
    }
    return { target, offline, findings, ...countFindings(findings), exitCode: checkExitCode(findings, this.cmd.strict) };
  }
}

/** The last lines of a failing command's output, secrets hidden, for "see output above". */
function commandOutput(label: string, output: string): string {
  const lines = output.split(/\r?\n/).filter((line) => line.trim());
  const shown = lines.slice(-OUTPUT_LINES).map((line) => `  | ${redactPreview(line).slice(0, 300)}`);
  const skipped = lines.length > OUTPUT_LINES ? `  | … ${lines.length - OUTPUT_LINES} earlier lines not shown\n` : "";
  return `${label} output (secrets hidden):\n${skipped}${shown.join("\n")}${shown.length ? "\n" : ""}`;
}

export async function runMcpCheck(cmd: McpCheckCommand, options: McpCheckOptions = {}): Promise<CheckReport> {
  const check = new McpCheck(cmd, options);
  try { return await check.run(); } finally { await check.close(); }
}
