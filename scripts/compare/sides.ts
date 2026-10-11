import { closeSync, openSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ask, BASELINE_COMMIT, BASELINE_TAG, expandHome, REPO_ROOT, saveConfig, type CompareConfig, type Side } from "./config";
import { runOwned } from "./proc";
import type { ComparePrompt } from "./prompts";

const isFile = (file: string) => stat(file).then((info) => info.isFile(), () => false);
const isDir = (dir: string) => stat(dir).then((info) => info.isDirectory(), () => false);

async function output(command: string[], cwd: string): Promise<{ ok: boolean; text: string }> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [text, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { ok: code === 0, text: code === 0 ? text.trim() : (err || text).trim() };
}

/** Side A: a clone of Casper at the pinned release, made once and checked by commit every run. Returns its command. */
export async function prepareBaseline(home: string, log: (line: string) => void): Promise<string[]> {
  const dir = path.join(home, `casper-${BASELINE_TAG}`);
  const head = async () => (await output(["git", "rev-parse", "HEAD"], dir).catch(() => ({ ok: false, text: "" }))).text;
  if (!await isDir(dir) || await head() !== BASELINE_COMMIT) {
    await rm(dir, { recursive: true, force: true });
    const origin = await output(["git", "remote", "get-url", "origin"], REPO_ROOT);
    const source = origin.ok && origin.text ? origin.text : "https://github.com/Choaterboater/casper.git";
    log(`Getting Casper ${BASELINE_TAG} for side A (once) ...`);
    const clone = await output(["git", "clone", "--quiet", "--depth", "1", "--branch", BASELINE_TAG, source, dir], home);
    if (!clone.ok) throw new Error(`Could not get Casper ${BASELINE_TAG}: ${clone.text}`);
    if (await head() !== BASELINE_COMMIT) throw new Error(`${BASELINE_TAG} in ${source} is not commit ${BASELINE_COMMIT.slice(0, 7)}; side A would not be the release.`);
  }
  if (!await isDir(path.join(dir, "node_modules"))) {
    log(`Installing Casper ${BASELINE_TAG}'s packages (once) ...`);
    const install = await output([process.execPath, "install", "--frozen-lockfile"], dir);
    if (!install.ok) throw new Error(`bun install failed in ${dir}: ${install.text.slice(-600)}`);
  }
  return [process.execPath, path.join(dir, "src", "cli.ts")];
}

/** Side B: this checkout's Casper, and which commit it was, so later tallies can tell experiments apart. */
export async function experimentBuild(): Promise<{ command: string[]; commit: string; dirty: boolean }> {
  const commit = await output(["git", "rev-parse", "--short", "HEAD"], REPO_ROOT);
  const status = await output(["git", "status", "--porcelain", "--untracked-files=no"], REPO_ROOT);
  return { command: [process.execPath, path.join(REPO_ROOT, "src", "cli.ts")], commit: commit.ok ? commit.text : "unknown", dirty: Boolean(status.text) };
}

const looksLikeSkyn3t = async (dir: string) => await isFile(path.join(dir, "pyproject.toml")) && await isFile(path.join(dir, "skyn3t", "__init__.py"));

/** How to run SkyN3t from its checkout: its own virtual env, else uv, else a `skyn3t` on PATH. */
export async function skyn3tCommand(dir: string): Promise<string[] | undefined> {
  const venv = path.join(dir, ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "skyn3t.exe" : "skyn3t");
  if (await isFile(venv)) return [venv];
  const uv = Bun.which("uv");
  if (uv && await isFile(path.join(dir, "uv.lock"))) return [uv, "run", "--project", dir, "skyn3t"];
  const onPath = Bun.which("skyn3t");
  return onPath ? [onPath] : undefined;
}

/** Side C: the SkyN3t checkout. Asked once, then remembered in config.json. */
export async function prepareSkyn3t(home: string, config: CompareConfig, given?: string): Promise<{ dir: string; command: string[] }> {
  let dir = given ? path.resolve(expandHome(given)) : config.skyn3tDir;
  if (!dir || !await looksLikeSkyn3t(dir)) {
    const guesses = [path.join(REPO_ROOT, "..", "skyn3t-2-0"), path.join(os.homedir(), "skyn3t-2-0"), path.join(os.homedir(), "Documents", "skyn3t-2-0")];
    let guess: string | undefined;
    for (const candidate of guesses) if (await looksLikeSkyn3t(candidate)) { guess = candidate; break; }
    const answer = await ask(`Where is your SkyN3t folder (the one with pyproject.toml)?${guess ? ` [${guess}]` : ""} `, "--skyn3t <folder>");
    dir = path.resolve(expandHome(answer || guess || ""));
    if (!await looksLikeSkyn3t(dir)) throw new Error(`${dir} is not a SkyN3t checkout (no pyproject.toml and skyn3t/__init__.py).`);
  }
  const command = await skyn3tCommand(dir);
  if (!command) throw new Error(`Found SkyN3t in ${dir} but no way to run it: make its .venv (uv sync), install uv, or put skyn3t on PATH.`);
  if (config.skyn3tDir !== dir) await saveConfig(home, { ...config, skyn3tDir: dir });
  return { dir, command };
}

export interface SideResult {
  side: Side;
  status: "done" | "failed" | "timeout" | "stopped";
  exitCode: number | null;
  minutes: number;
  /** Where the side left its app; the judge starts it from here. */
  appDir: string | null;
  error?: string;
}

export interface SideJob {
  side: Side;
  runDir: string;
  prompt: ComparePrompt;
  model: string;
  timeoutMs: number;
  signal: AbortSignal;
}

const STARTERS_DIR = path.join(import.meta.dir, "starters");

/** Why a side failed, in a line: Casper's last error event, else the end of the side's log. */
export async function failureReason(sideDir: string): Promise<string | undefined> {
  const events = await readFile(path.join(sideDir, "events.jsonl"), "utf8").catch(() => "");
  for (const line of events.split("\n").reverse()) {
    try { const event = JSON.parse(line); if (event?.type === "error" && typeof event.message === "string") return event.message.slice(0, 300); } catch { /* not an event */ }
  }
  const log = await readFile(path.join(sideDir, "run.log"), "utf8").catch(() => "");
  const last = log.split("\n").map((line) => line.trim()).filter(Boolean).slice(-2).join(" / ");
  return last ? last.slice(-300) : undefined;
}

async function withReason(sideDir: string, result: SideResult): Promise<SideResult> {
  if (result.status !== "failed" || result.error) return result;
  const reason = await failureReason(sideDir);
  return reason ? { ...result, error: reason } : result;
}

function result(side: Side, run: { exitCode: number | null; timedOut: boolean; ms: number }, signal: AbortSignal, appDir: string | null): SideResult {
  const status = signal.aborted ? "stopped" : run.timedOut ? "timeout" : run.exitCode === 0 ? "done" : "failed";
  return { side, status, exitCode: run.exitCode, minutes: Math.round(run.ms / 600) / 100, appDir };
}

/** Sides A and B: Casper in a fresh folder (or a copy of the starter), prompt on stdin, JSON events kept. */
export async function runCasperSide(job: SideJob, command: readonly string[]): Promise<SideResult> {
  const sideDir = path.join(job.runDir, job.side);
  const appDir = path.join(sideDir, "app");
  await mkdir(appDir, { recursive: true });
  if (job.prompt.starter) await cp(path.join(STARTERS_DIR, job.prompt.starter), appDir, { recursive: true });
  const events = openSync(path.join(sideDir, "events.jsonl"), "a");
  const log = openSync(path.join(sideDir, "run.log"), "a");
  try {
    const run = await runOwned([...command, "--json", "--model", job.model, "-"], {
      cwd: appDir, env: { ...process.env, NO_COLOR: "1" }, stdin: job.prompt.text, stdout: events, stderr: log,
      timeoutMs: job.timeoutMs, signal: job.signal,
    });
    return await withReason(sideDir, result(job.side, run, job.signal, appDir));
  } finally { closeSync(events); closeSync(log); }
}

/** Side C: SkyN3t builds into this run's own projects folder; an improve imports the starter copy first. */
export async function runSkyn3tSide(job: SideJob, command: readonly string[], modelEnv: Record<string, string>): Promise<SideResult> {
  const sideDir = path.join(job.runDir, job.side);
  const projects = path.join(sideDir, "projects");
  await mkdir(projects, { recursive: true });
  const env = { ...process.env, ...modelEnv, SKYN3T_PROJECTS_DIR: projects, NO_COLOR: "1" };
  const log = openSync(path.join(sideDir, "run.log"), "a");
  const started = performance.now();
  const left = () => Math.max(1, job.timeoutMs - (performance.now() - started));
  try {
    const activity = ["--activity-file", path.join(sideDir, "activity.jsonl")];
    if (job.prompt.starter) {
      const starter = path.join(sideDir, "starter");
      await cp(path.join(STARTERS_DIR, job.prompt.starter), starter, { recursive: true });
      const imported = await runOwned([...command, "project", "import", starter, "--slug", "app"], {
        cwd: sideDir, env, stdout: log, stderr: log, timeoutMs: left(), signal: job.signal,
      });
      if (imported.exitCode !== 0) return await withReason(sideDir, result(job.side, imported, job.signal, null));
    }
    const work = job.prompt.starter
      ? [...command, "studio", "improve", "app", "--goal", job.prompt.text, ...activity]
      : [...command, "studio", "build", job.prompt.text, "--yes", "--slug", "app", ...activity];
    const run = await runOwned(work, { cwd: sideDir, env, stdout: log, stderr: log, timeoutMs: left(), signal: job.signal });
    return await withReason(sideDir, { ...result(job.side, run, job.signal, await builtApp(projects)), minutes: Math.round((performance.now() - started) / 600) / 100 });
  } finally { closeSync(log); }
}

/** The app SkyN3t made: `app` when it kept the slug, else the newest folder it wrote. */
export async function builtApp(projects: string): Promise<string | null> {
  if (await isDir(path.join(projects, "app"))) return path.join(projects, "app");
  const entries = await readdir(projects, { withFileTypes: true }).catch(() => []);
  const dirs = await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map(async (entry) => ({ dir: path.join(projects, entry.name), time: (await stat(path.join(projects, entry.name))).mtimeMs })));
  return dirs.sort((a, b) => b.time - a.time)[0]?.dir ?? null;
}
