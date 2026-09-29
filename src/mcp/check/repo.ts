import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { detectPythonCommands, pythonRunner, VIRTUALENVS } from "../../project/model";
import { runCommandCheck } from "../../verify/command";
import type { VerificationResult } from "../../verify/evidence";
import type { Finding } from "./index";

/** A command the check runs in the repo, and where Casper found it. */
export interface RepoCommand {
  command: string;
  /** Short plain text for the report, e.g. "14 files" or "-m safety". */
  summary?: string;
  /** uv project: a missing package is fixed with `uv sync`. */
  uv?: boolean;
}

export interface RepoCommands {
  doctor?: RepoCommand;
  safetyTests?: RepoCommand;
  tests?: RepoCommand;
  /** Every test file found (relative, forward slashes), for text searches such as the router refusal test. */
  testFiles: string[];
}

/** Test file names that suggest a safety test: write gates, read-only guards, redaction, confirmations. */
export const SAFETY_TEST_NAME = /(safety|write_gate|writes?_|readonly|read_only|guard|blocklist|destructive|confirm|dry_run|annotation|redact|token_security|access)/i;

export const REPO_TIMEOUTS = { doctor: 2 * 60_000, safetyTests: 5 * 60_000, tests: 15 * 60_000 };

const MAX_FILE = 1024 * 1024;
const TEST_DIRS = ["tests", "test"];
const PYTHON_TEST = /^(test_.+|.+_test)\.py$/;
const SCRIPT_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;

async function readText(root: string, relative: string): Promise<string> {
  try {
    const file = path.join(root, relative);
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_FILE) return "";
    return await readFile(file, "utf8");
  } catch { return ""; }
}

async function exists(root: string, relative: string): Promise<boolean> {
  return lstat(path.join(root, relative)).then(() => true, () => false);
}

/** The body of one TOML table, up to the next table header. */
function tomlTable(source: string, name: string): string {
  const start = source.search(new RegExp(`^\\[${name.replace(/\./g, "\\.")}\\]\\s*$`, "m"));
  if (start < 0) return "";
  const rest = source.slice(start).split("\n").slice(1);
  const end = rest.findIndex((line) => /^\[/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** `name = "module:function"` lines of [project.scripts]. */
function projectScripts(pyproject: string): Array<{ name: string; target: string }> {
  return [...tomlTable(pyproject, "project.scripts").matchAll(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*=\s*["']([^"']+)["']/gm)]
    .map((match) => ({ name: match[1]!, target: match[2]! }));
}

function makeTarget(makefile: string, name: string): boolean {
  return new RegExp(`^${name}\\s*:(?!=)`, "m").test(makefile);
}

function packageScripts(source: string): Record<string, string> {
  try {
    const parsed = JSON.parse(source) as { scripts?: unknown };
    if (parsed && typeof parsed.scripts === "object" && parsed.scripts && !Array.isArray(parsed.scripts)) {
      return Object.fromEntries(Object.entries(parsed.scripts).filter(([, value]) => typeof value === "string")) as Record<string, string>;
    }
  } catch { /* not a package.json we can read */ }
  return {};
}

async function packageManager(root: string): Promise<string> {
  if (await exists(root, "bun.lock") || await exists(root, "bun.lockb")) return "bun";
  if (await exists(root, "pnpm-lock.yaml")) return "pnpm";
  if (await exists(root, "yarn.lock")) return "yarn";
  return "npm";
}

/** A shell word: plain paths stay readable, anything else is single-quoted. */
export function shellWord(value: string): string {
  return /^[\w./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/** Test files under tests/ or test/ (4 levels, at most 2,000), relative with forward slashes. */
async function findTestFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 4 || found.length >= 2000) return;
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "__pycache__") await walk(child, depth + 1);
      else if (entry.isFile() && (PYTHON_TEST.test(entry.name) || SCRIPT_TEST.test(entry.name))) found.push(child);
    }
  };
  for (const dir of TEST_DIRS) await walk(dir, 1);
  return found;
}

/** Where the repo keeps its doctor, safety tests and full tests. Reads files only; runs nothing. */
export async function findRepoCommands(root: string): Promise<RepoCommands> {
  const [pyproject, makefile, packageJson, pytestIni] = await Promise.all([
    readText(root, "pyproject.toml"), readText(root, "Makefile"), readText(root, "package.json"), readText(root, "pytest.ini"),
  ]);
  let requirements = "";
  try {
    for (const name of (await readdir(root)).filter((name) => /^requirements[\w.-]*\.txt$/i.test(name)).sort()) requirements += `${await readText(root, name)}\n`;
  } catch { /* unreadable folder: no requirements */ }
  const uv = await exists(root, "uv.lock");
  const poetry = await exists(root, "poetry.lock") || /^\[tool\.poetry\]/m.test(pyproject);
  let virtualenv: string | null = null;
  for (const name of VIRTUALENVS) if (!virtualenv && (await lstat(path.join(root, name)).catch(() => undefined))?.isDirectory()) virtualenv = name;
  const python = uv ? "uv run python" : poetry ? "poetry run python"
    : virtualenv ? (process.platform === "win32" ? `${virtualenv}\\Scripts\\python.exe` : `${virtualenv}/bin/python`)
    : process.platform === "win32" ? "python" : "python3";
  const isPython = Boolean(pyproject || requirements);
  const names = new Set([...(uv ? ["uv.lock"] : []), ...(poetry ? ["poetry.lock"] : [])]);
  const runner = pythonRunner(names, pyproject, virtualenv);
  const pytest = isPython ? detectPythonCommands(pyproject, requirements, runner).test : undefined;
  const scripts = packageScripts(packageJson);
  const manager = packageJson ? await packageManager(root) : "npm";
  const result: RepoCommands = { testFiles: await findTestFiles(root) };

  // Doctor: a [project.scripts] entry, then scripts/doctor.py, then `make doctor`, then package.json.
  const doctorScript = projectScripts(pyproject).find((script) => /doctor|selfcheck/i.test(script.name));
  if (doctorScript) {
    const shim = virtualenv ? `${virtualenv}/bin/${doctorScript.name}` : "";
    const command = uv ? `uv run ${doctorScript.name}` : poetry ? `poetry run ${doctorScript.name}`
      : shim && await exists(root, shim) ? shim : `${python} -m ${doctorScript.target.split(":")[0]}`;
    result.doctor = { command, uv };
  } else if (await exists(root, "scripts/doctor.py")) result.doctor = { command: `${python} scripts/doctor.py`, uv };
  else if (makeTarget(makefile, "doctor")) result.doctor = { command: "make doctor" };
  else if (scripts.doctor) result.doctor = { command: `${manager} run doctor` };

  // Full tests: pytest when the project names it, else `make test`, else package.json's test script.
  if (pytest) result.tests = { command: pytest, uv };
  else if (makeTarget(makefile, "test")) result.tests = { command: "make test", uv };
  else if (scripts.test && !/no test specified/.test(scripts.test)) result.tests = { command: `${manager} run test` };

  // Safety tests: a declared pytest `safety` marker, else test files whose names say so.
  const markers = `${tomlTable(pyproject, "tool.pytest.ini_options")}\n${pytestIni}`;
  const markerDeclared = /^\s*markers\s*=/m.test(markers) && /["'\s]safety\s*:/.test(markers.slice(markers.search(/^\s*markers\s*=/m)));
  if (isPython && markerDeclared) {
    result.safetyTests = { command: `${runner.tool("pytest")} -m safety`, summary: "-m safety", uv };
  } else {
    const safetyFiles = result.testFiles.filter((file) => file.endsWith(".py") && SAFETY_TEST_NAME.test(path.posix.basename(file)));
    if (safetyFiles.length) {
      const command = pytest
        ? `${runner.tool("pytest")} ${safetyFiles.map(shellWord).join(" ")}`
        : `${python} -m unittest ${safetyFiles.map((file) => shellWord(file.replace(/\.py$/, "").replace(/\//g, "."))).join(" ")}`;
      result.safetyTests = { command, summary: `${safetyFiles.length} file${safetyFiles.length === 1 ? "" : "s"}`, uv };
    }
  }
  return result;
}

/** How long a command took, in plain seconds. */
export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export const MISSING_PACKAGES = /ModuleNotFoundError|No module named|not found in the cache|wasn't found in the cache|Network connectivity is disabled|not found in cache|Failed to spawn: `|command not found|: not found\b/;

/** One plain line for a finished repo command. */
export function repoFinding(label: string, command: RepoCommand, result: VerificationResult): Finding {
  const output = `${result.stdout}\n${result.stderr}`;
  const time = seconds(result.durationMs);
  const what = command.summary ?? command.command;
  if (result.status === "pass") {
    const summary = /^.*Summary:.*$/m.exec(result.stdout)?.[0]?.trim();
    return { section: "repo", status: "ok", label, text: `${what} (${time})${summary ? ` · ${summary.slice(summary.indexOf("Summary:"))}` : ""}` };
  }
  if (result.ended === "timeout") return { section: "repo", status: "fail", label, text: `${command.command}: did not finish in ${seconds(result.durationMs)}` };
  if (result.reason === "Verification cancelled") return { section: "repo", status: "skip", label, text: "stopped" };
  if (MISSING_PACKAGES.test(output)) {
    const fix = command.uv ? "Run `uv sync` in the repo, then check again." : "Install the repo's packages, then check again.";
    return { section: "repo", status: "fail", label, text: `Not set up: ${command.command} needs packages that are not installed. ${fix}` };
  }
  const failed = [...output.matchAll(/\b(\d+) failed\b/g)].map((match) => Number(match[1]));
  const unittest = /FAILED \(([^)]*)\)/.exec(output)?.[1];
  const unittestCount = unittest ? [...unittest.matchAll(/(?:failures|errors)=(\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0) : 0;
  const count = failed.length ? failed[failed.length - 1]! : unittestCount;
  const detail = count ? `${count} failed` : `exit code ${result.exitCode ?? "none"}`;
  return { section: "repo", status: "fail", label, text: `${command.command}: ${detail} (see output above)` };
}

export interface RunRepoCommandOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export function runRepoCommand(command: RepoCommand, options: RunRepoCommandOptions): Promise<VerificationResult> {
  return runCommandCheck({ name: "test", command: command.command, cwd: options.root, timeoutMs: options.timeoutMs, signal: options.signal, env: options.env });
}
