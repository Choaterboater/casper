import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openNoFollowUpdate, writeProjectFile } from "../platform/files";
import { safeGitArgs } from "../platform/git";
import { loadProjectModel, type ProjectCommand } from "../project/model";
import { runCommandCheck } from "../verify/command";
import { sandboxedArgv, sandboxPath, type SandboxedSpawn } from "../sandbox/spawn";
import { UV_PYTHONS } from "../sandbox/policy";
import {
  getTemplate, initArgv, MARKER_FILE, NAME_RULE, PACKAGE_HOST, renderFiles, renderValues, validName,
  type TemplateManifest, type TemplateTool,
} from "./templates";

/**
 * `casper new`: a local step that costs no model tokens. It runs the real init tool (uv init or
 * bun init) with a cleaned environment, lays the bundled template over the result, adds dev
 * packages, runs the project's own detected checks once, and makes a first commit with the
 * user's own git identity. The checks prove the new project runs; they prove no change.
 */

export interface ToolRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not start at all (ENOENT: not installed). */
  error?: string;
  missing?: boolean;
}

export type ToolRunner = (argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }) => Promise<ToolRun>;

export interface NewProjectOptions {
  /** The folder the project goes in (~/Projects). It must exist. */
  parent: string;
  name: string;
  template: string;
  /** The environment tools start from; defaults to Casper's own. */
  env?: NodeJS.ProcessEnv;
  /** Home for "~/" in messages and Casper's project cache; defaults to env.HOME or the OS home. */
  homeDir?: string;
  signal?: AbortSignal;
  /** Progress lines while it works, e.g. "  uv init …". */
  onStep?: (line: string) => void;
  /** Runs one tool with shell off. Defaults to spawning it. */
  run?: ToolRunner;
  /** Per check; default 10 minutes. */
  checkTimeoutMs?: number;
  /** Per init/add tool run; default 10 minutes. */
  toolTimeoutMs?: number;
  now?: Date;
}

export type NewProjectStatus = "ready" | "created" | "not_created";

export interface NewProjectCheck {
  name: ProjectCommand;
  command: string;
  status: "pass" | "fail";
  durationMs: number;
  /** "3 tests", when the output says. */
  detail?: string;
  /** The last lines of output, for a failed check. */
  output?: string;
}

export interface NewProjectResult {
  status: NewProjectStatus;
  /** 0 ready, 1 created but not ready (or a tool failed), 64 usage. */
  exitCode: 0 | 1 | 64;
  /** The project folder (it may not exist when status is not_created). */
  dir: string;
  /** dir with the home folder shown as ~. */
  displayDir: string;
  name: string;
  template?: Pick<TemplateManifest, "id" | "version" | "kind" | "title">;
  /** Why it is not ready or not created, one plain sentence. */
  reason?: string;
  /** Output of the tool or check that failed, last lines. */
  output?: string;
  checks: NewProjectCheck[];
  /** Short hash of the first commit. */
  commit?: string;
  /** Plain notes, e.g. the offline hint. */
  notes: string[];
  /** Template files not written because the init tool already wrote them. */
  kept: string[];
}

const TEN_MINUTES = 10 * 60_000;
const STOPPED = "stopped before it finished.";
const OUTPUT_LINES = 20;

/** Variables that make the init tool write somewhere else or run the wrong interpreter. */
const INIT_DROPPED = ["BUN_OPTIONS", "NODE_OPTIONS", "VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME", "UV_PROJECT_ENVIRONMENT",
  "CONDA_PREFIX", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE"];

/** AI provider credentials: no tool Casper starts here needs them. */
const PROVIDER_KEY = /(_API_KEY|_AUTH_TOKEN|_OAUTH_TOKEN)$|^(COPILOT_GITHUB_TOKEN|HF_TOKEN|PI_.*|CASPER_.*)$/;

/** Anything named like a secret: the new project's tests must run without one. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|CREDENTIAL|PRIVATE_KEY)/i;

/** The environment for init, add and git: no redirecting variables and no AI provider keys. */
export function initEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || INIT_DROPPED.includes(name) || PROVIDER_KEY.test(name)) continue;
    clean[name] = value;
  }
  return clean;
}

/** The environment for the first checks: initEnv without anything named like a secret. */
export function checkEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = initEnv(env);
  for (const name of Object.keys(clean)) if (SECRET_NAME.test(name)) delete clean[name];
  return clean;
}

/** uv and bun fetch and run package code: they run in the shell sandbox when one holds commands, writing only the
 * new folder, temp and package caches, and reaching only the listed registries. git runs as it is: the first
 * commit uses your own git settings and hooks. */
export const spawnTool: ToolRunner = async (argv, options) => {
  let plan: SandboxedSpawn;
  try { plan = argv[0] === "uv" || argv[0] === "bun" ? await sandboxedArgv(argv[0], argv.slice(1), { cwd: options.cwd, network: "ask", extraWrite: argv[1] === "--version" ? [] : argv[0] === "uv" ? [options.cwd, path.join(os.homedir(), UV_PYTHONS)] : [options.cwd] }) : { file: argv[0]!, args: argv.slice(1), shell: false }; }
  catch (error) { return { exitCode: null, stdout: "", stderr: "", error: (error as Error).message, missing: false }; }
  const run = await spawnPlanned(plan, options);
  return plan.held && run.exitCode === 127 ? { ...run, missing: true } : run;
};

const spawnPlanned = (plan: SandboxedSpawn, { cwd, env, signal, timeoutMs }: Parameters<ToolRunner>[1]): Promise<ToolRun> => new Promise((resolve) => {
  let stdout = "";
  let stderr = "";
  let settled = false;
  const done = (run: ToolRun) => { if (!settled) { settled = true; clearTimeout(timer); resolve(run); } };
  let child;
  try {
    child = spawn(plan.file, plan.args, { cwd, env: sandboxPath(env, Boolean(plan.held)), shell: plan.shell, stdio: ["ignore", "pipe", "pipe"], signal, windowsHide: true });
  } catch (error) {
    done({ exitCode: null, stdout, stderr, error: (error as Error).message, missing: (error as NodeJS.ErrnoException).code === "ENOENT" });
    return;
  }
  const timer = setTimeout(() => { stderr += `\nStopped after ${Math.round(timeoutMs / 1000)}s`; child.kill("SIGKILL"); }, timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-64_000); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-64_000); });
  child.on("error", (error: NodeJS.ErrnoException) => done({ exitCode: null, stdout, stderr, error: error.message, missing: error.code === "ENOENT" }));
  child.on("close", (exitCode) => done({ exitCode, stdout, stderr }));
});

/** A path with the home folder shown as ~. */
export function tildePath(dir: string, home: string): string {
  const relative = path.relative(home, dir);
  if (relative === "") return "~";
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? `~/${relative.split(path.sep).join("/")}` : dir;
}

function lastLines(text: string, count = OUTPUT_LINES): string {
  return text.split(/\r?\n/).filter((line) => line.trim()).slice(-count).join("\n");
}

const INSTALL: Record<TemplateTool | "git", { what: string; url: string }> = {
  uv: { what: "a Python project", url: "https://docs.astral.sh/uv/" },
  bun: { what: "a web project", url: "https://bun.sh/" },
  git: { what: "a project", url: "https://git-scm.com/downloads" },
};

/** "Casper needs uv to start a Python project and it isn't installed. …" */
export function missingToolMessage(tool: TemplateTool | "git"): string {
  const { what, url } = INSTALL[tool];
  return `Casper needs ${tool} to start ${what} and it isn't installed. Install it from ${url} and run casper new again.`;
}

/** Output that says the registry could not be reached. */
const OFFLINE = /(failed to fetch|failed to connect|could not connect|couldn't connect|dns error|name resolution|network is unreachable|connection refused|connection reset|timed out|offline|no route to host|temporary failure|ENOTFOUND|ECONNREFUSED|ConnectionRefused|tcp connect error)/i;

/** "3 tests" from pytest's or bun test's summary line. */
export function testCount(output: string): string | undefined {
  const pytest = /(\d+) passed/.exec(output);
  const bun = /^\s*(\d+) pass\b/m.exec(output);
  const count = Number(pytest?.[1] ?? bun?.[1]);
  return Number.isFinite(count) && count > 0 ? `${count} test${count === 1 ? "" : "s"}` : undefined;
}

const CHECK_ORDER: ProjectCommand[] = ["typecheck", "lint", "test"];
const CHECK_WORD: Record<ProjectCommand, string> = { typecheck: "typecheck", lint: "lint", test: "tests", build: "build" };

async function isEmptyDir(dir: string): Promise<boolean> {
  return (await readdir(dir)).length === 0;
}

/** Writes one template file inside the target without following links out. */
async function writeTemplateFile(target: string, relative: string, text: string, mode: "new" | "replace" | "append"): Promise<"written" | "kept"> {
  return writeProjectFile(target, relative, text, { mode: mode === "new" ? "create" : mode });
}

/** Sets the package name and adds scripts in package.json (bun templates). */
async function mergePackageJson(target: string, fields: NonNullable<TemplateManifest["packageJson"]>, fillText: (text: string) => string): Promise<void> {
  const handle = await openNoFollowUpdate(path.join(target, "package.json"));
  try {
    const parsed = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
    if (fields.name) parsed.name = fillText(fields.name);
    if (fields.scripts) {
      const scripts = (parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {}) as Record<string, string>;
      for (const [key, value] of Object.entries(fields.scripts)) scripts[key] = fillText(value);
      parsed.scripts = scripts;
    }
    const text = `${JSON.stringify(parsed, null, 2)}\n`;
    await handle.truncate(0);
    await handle.write(text, 0, "utf8");
  } finally { await handle.close(); }
}

function packagesLine(packages: string[]): string {
  return packages.map((spec) => spec.replace(/[<>=!~;[].*$/, "")).join(", ");
}

export async function createProject(options: NewProjectOptions): Promise<NewProjectResult> {
  const baseEnv = options.env ?? process.env;
  const home = options.homeDir ?? baseEnv.HOME ?? os.homedir();
  const run = options.run ?? spawnTool;
  const step = options.onStep ?? (() => {});
  const toolTimeoutMs = options.toolTimeoutMs ?? TEN_MINUTES;
  const parent = path.resolve(options.parent);
  const dir = path.join(parent, options.name);
  const displayDir = tildePath(dir, home);
  const result: NewProjectResult = { status: "not_created", exitCode: 1, dir, displayDir, name: options.name, checks: [], notes: [], kept: [] };
  const notCreated = (reason: string, exitCode: 1 | 64 = 1): NewProjectResult => ({ ...result, status: "not_created", exitCode, reason });
  const notReady = (reason: string, output?: string): NewProjectResult => ({ ...result, status: "created", exitCode: 1, reason, ...(output ? { output } : {}) });

  if (!validName(options.name)) return notCreated(NAME_RULE, 64);
  if (options.signal?.aborted) return notCreated("stopped before anything was written.");
  const template = getTemplate(options.template);
  if (!template) return notCreated(`There's no template called ${options.template}. Run casper new --list to see them.`, 64);
  const manifest = template.manifest;
  result.template = { id: manifest.id, version: manifest.version, kind: manifest.kind, title: manifest.title };

  const toolEnv = initEnv(baseEnv);
  const tool = async (argv: string[], cwd: string, timeoutMs = toolTimeoutMs) => run(argv, { cwd, env: toolEnv, signal: options.signal, timeoutMs });

  // Preflight: every tool this template needs, before anything is written.
  const parentInfo = await stat(parent).catch(() => undefined);
  if (!parentInfo?.isDirectory()) return notCreated(`${tildePath(parent, home)} isn't a folder.`);
  for (const name of [manifest.tool, "git"] as const) {
    const probe = await tool([name, "--version"], parent, 30_000);
    if (probe.missing || probe.exitCode !== 0) return notCreated(missingToolMessage(name));
  }

  // The folder: new, or an existing empty real folder. Never through a link.
  const existing = await lstat(dir).catch(() => undefined);
  if (existing?.isSymbolicLink()) return notCreated(`${displayDir} is a link. Pick another name.`);
  if (existing && !existing.isDirectory()) return notCreated(`${displayDir} already exists and isn't a folder. Pick another name.`);
  if (existing && !(await isEmptyDir(dir))) return notCreated(`${displayDir} already exists and isn't empty. Pick another name.`);
  if (!existing) {
    try { await mkdir(dir); } catch (error) { return notCreated(`Couldn't create ${displayDir}: ${(error as Error).message}`); }
  }

  // Is the new folder inside someone's repository? Then no git init and no commit there.
  const top = await tool(["git", ...safeGitArgs(["rev-parse", "--show-toplevel"])], dir, 30_000);
  const outerRepo = top.exitCode === 0 ? top.stdout.trim() : "";

  const values = renderValues(options.name, options.now);
  const host = PACKAGE_HOST[manifest.tool];
  let announcedDownloads = false;
  const downloads = () => { if (!announcedDownloads) { announcedDownloads = true; step(`  Getting packages from ${host}`); } };
  const offlineNote = `Couldn't get packages from ${host} (offline?). The folder has the template but no packages; run ${manifest.tool === "uv" ? "uv sync" : "bun install"} when you're online.`;

  // 1. The real init tool, as-is, in the new folder.
  const init = initArgv(manifest, values);
  if (manifest.tool === "bun") downloads();
  step(`  ${init.slice(0, 2).join(" ")} …`);
  const initRun = await tool(init, dir);
  if (options.signal?.aborted) return notReady(STOPPED);
  if (initRun.exitCode !== 0) {
    const output = lastLines(`${initRun.stdout}\n${initRun.stderr}`);
    if (manifest.tool === "bun" && OFFLINE.test(output)) return { ...notReady(`${init.slice(0, 2).join(" ")} couldn't get packages.`, output), notes: [offlineNote] };
    return notReady(`${init.slice(0, 2).join(" ")} failed.`, output);
  }
  const marker = MARKER_FILE[manifest.tool];
  if (!(await lstat(path.join(dir, marker)).then((info) => info.isFile(), () => false))) {
    return notReady(`${init.slice(0, 2).join(" ")} didn't create ${marker} here.`, lastLines(`${initRun.stdout}\n${initRun.stderr}`));
  }

  // 2. The template over the result.
  try {
    if (manifest.packageJson) await mergePackageJson(dir, manifest.packageJson, (text) => text.replace(/\{\{name\}\}/g, values.name));
    const replace = new Set(manifest.replace);
    for (const file of renderFiles(template, values)) {
      const mode = file.append ? "append" : replace.has(file.source) ? "replace" : "new";
      if (await writeTemplateFile(dir, file.path, file.text, mode) === "kept") result.kept.push(file.path);
    }
  } catch (error) {
    return notReady(`Couldn't write the template: ${(error as Error).message}`);
  }

  // 3. Packages.
  const adds: Array<{ argv: string[]; packages: string[] }> = [];
  if (manifest.tool === "uv") {
    if (manifest.add.length) adds.push({ argv: ["uv", "add", ...manifest.add], packages: manifest.add });
    if (manifest.addDev.length) adds.push({ argv: ["uv", "add", "--dev", ...manifest.addDev], packages: manifest.addDev });
  } else {
    if (manifest.add.length) adds.push({ argv: ["bun", "add", ...manifest.add], packages: manifest.add });
    if (manifest.addDev.length) adds.push({ argv: ["bun", "add", "-d", ...manifest.addDev], packages: manifest.addDev });
  }
  for (const add of adds) {
    downloads();
    step(`  adding ${packagesLine(add.packages)} …`);
    const added = await tool(add.argv, dir);
    if (options.signal?.aborted) return notReady(STOPPED);
    if (added.exitCode !== 0) {
      const output = lastLines(`${added.stdout}\n${added.stderr}`);
      if (OFFLINE.test(output)) return { ...notReady(`couldn't get packages from ${host}.`, output), notes: [offlineNote] };
      return notReady(`${add.argv.slice(0, 2).join(" ")} failed.`, output);
    }
  }

  // 4. git init, only when the folder isn't inside another repository. A .git that is already here was made by
  // the init tool or a package's own code, not by git init: Casper runs no git in it (git would run its hooks).
  if (!outerRepo && await lstat(path.join(dir, ".git")).then(() => true, () => false)) {
    return notReady("a .git folder appeared while packages were added, so Casper ran no git here. Look at it, then run git init and git commit yourself.");
  }
  if (!outerRepo) {
    const initGit = await tool(["git", "init", "-q"], dir, 60_000);
    if (initGit.exitCode !== 0) return notReady("git init failed.", lastLines(initGit.stderr));
  }

  // 5. The project's own detected checks, once, without secrets in the environment.
  const model = await loadProjectModel({ cwd: dir, root: dir, name: options.name, gitBranch: null, isGit: !outerRepo }, { homeDir: home });
  const env = checkEnv(baseEnv);
  for (const name of CHECK_ORDER) {
    const command = model.commands[name];
    if (!command) continue;
    step(`  running ${CHECK_WORD[name]} …`);
    const checked = await runCommandCheck({ name, command, cwd: dir, timeoutMs: options.checkTimeoutMs ?? TEN_MINUTES, signal: options.signal, env, sandbox: { extraWrite: [dir] } });
    const output = `${checked.stdout}\n${checked.stderr}`;
    const detail = name === "test" && checked.status === "pass" ? testCount(output) : undefined;
    result.checks.push({
      name, command, status: checked.status === "pass" ? "pass" : "fail", durationMs: checked.durationMs,
      ...(detail ? { detail } : {}),
      ...(checked.status !== "pass" ? { output: lastLines(checked.reason ? `${output}\n${checked.reason}` : output) } : {}),
    });
  }
  if (options.signal?.aborted) return notReady(STOPPED);
  if (!result.checks.length) return notReady("Casper found no checks to run.");
  const failed = result.checks.find((check) => check.status === "fail");
  if (failed) return notReady(`${CHECK_WORD[failed.name]} failed.`, failed.output);

  // 6. The first commit, with the user's own identity and hooks. Casper never sets an identity.
  if (outerRepo) return notReady(`it's inside the git repository at ${tildePath(outerRepo, home)}; commit it there when you're ready.`);
  const config = async (key: string) => {
    const got = await tool(["git", "config", key], dir, 30_000);
    return got.exitCode === 0 ? got.stdout.trim() : "";
  };
  const name = await config("user.name");
  const email = await config("user.email");
  const hasName = Boolean(name || (baseEnv.GIT_AUTHOR_NAME && baseEnv.GIT_COMMITTER_NAME));
  const hasEmail = Boolean(email || (baseEnv.GIT_AUTHOR_EMAIL && baseEnv.GIT_COMMITTER_EMAIL) || baseEnv.EMAIL);
  if (!hasName || !hasEmail) {
    return notReady("git doesn't know your name yet. Set it with: git config --global user.name \"Your Name\" and user.email, then run git commit.");
  }
  step("  first commit …");
  const added = await tool(["git", "add", "-A"], dir, 120_000);
  if (added.exitCode !== 0) return notReady("git add failed.", lastLines(added.stderr));
  const message = `Start ${options.name} from Casper template ${manifest.id} v${manifest.version}`;
  const committed = await tool(["git", "commit", "-q", "-m", message], dir, 120_000);
  if (committed.exitCode !== 0) return notReady("git commit failed.", lastLines(`${committed.stdout}\n${committed.stderr}`));
  const head = await tool(["git", ...safeGitArgs(["rev-parse", "--short", "HEAD"])], dir, 30_000);
  result.commit = head.stdout.trim();
  return { ...result, status: "ready", exitCode: 0 };
}
