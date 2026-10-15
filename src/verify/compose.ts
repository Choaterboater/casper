import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isSecretName, scrubExactValues } from "../secrets/assignments";
import { SECRET_MARKER } from "../secrets/scrub";
import { onPath } from "../security/install";
import { runCommandCheck, type CommandCheckOptions, type CommandWrap } from "./command";
import type { VerificationResult } from "./evidence";
import type { VerificationScope } from "./scope";

/**
 * Docker Compose files the project already has (a home lab keeps one folder per stack): found from its files each
 * time it is opened, never cached, and run as the `compose` check with Compose's own validator,
 * `docker compose -f <file> config --quiet`, in each file's own folder so its `.env` is read. `config` needs no
 * Docker daemon and never pulls or starts anything; `--quiet` keeps it from printing the resolved file, which holds
 * the `.env` values. Without docker (or its compose command) the check only skips and says so. A project that names
 * its own `compose` check under verify.checks keeps it, and `verification.compose: false` (/settings) turns it off.
 */
export const COMPOSE_CHECK = "compose";

/** What the check runs, for the live line and the AI's list of checks. */
export const COMPOSE_COMMAND = "docker compose config --quiet";

export const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

/** At most this many files are checked. */
export const COMPOSE_MAX_FILES = 20;

/** Folders at most this deep below the project are searched (`stacks/media/compose.yaml`). */
const MAX_DEPTH = 2;

/** At most this many folders are read, so a media library or a big monorepo can't slow it down. */
const MAX_FOLDERS = 500;

/** Folders never searched besides hidden ones (`.git` among them). */
const SKIP = new Set(["node_modules", "venv", "__pycache__", "dist", "coverage", "target", "vendor"]);

export interface ComposePlan {
  /** Project-relative paths with `/`, root files first, then by folder name. */
  files: string[];
  /** docker was on PATH when the project was opened. Without it the check only skips. */
  docker: boolean;
}

/** The project's compose files, root first, at most two folders down and at most COMPOSE_MAX_FILES. */
export async function findComposeFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  let level = [""];
  let read = 0;
  for (let depth = 0; depth <= MAX_DEPTH && level.length && found.length < COMPOSE_MAX_FILES; depth++) {
    const next: string[] = [];
    for (const folder of level) {
      if (++read > MAX_FOLDERS) return found;
      const entries = await readdir(path.join(root, folder), { withFileTypes: true }).catch(() => []);
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      // Only real files and folders: a link could lead out of the project.
      for (const entry of entries) {
        const relative = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.isFile() && COMPOSE_FILES.includes(entry.name) && found.length < COMPOSE_MAX_FILES) found.push(relative);
        else if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name)) next.push(relative);
      }
    }
    level = next;
  }
  return found;
}

/** The compose check for this project, or undefined when it has no compose file. */
export async function detectCompose(root: string, env: NodeJS.ProcessEnv = process.env): Promise<ComposePlan | undefined> {
  const files = await findComposeFiles(root);
  if (!files.length) return undefined;
  return { files, docker: Boolean(await onPath("docker", env)) };
}

/** The found compose check, unless the project named its own check `compose`. */
export function detectedCompose(model: { compose?: ComposePlan; namedChecks?: Record<string, unknown> }): ComposePlan | undefined {
  return model.compose && !model.namedChecks?.[COMPOSE_CHECK] ? model.compose : undefined;
}

/** The files that make it worth running: a stack's whole folder (its .env and the configs it mounts), or a root
 * compose file and the root .env. */
export function composeScope(plan: ComposePlan): VerificationScope {
  const inputs = new Set<string>();
  for (const file of plan.files) {
    const folder = path.posix.dirname(file);
    if (folder === ".") { inputs.add(file); inputs.add(".env"); }
    else inputs.add(folder);
  }
  return { inputs: [...inputs] };
}

export const DOCKER_MISSING = "Docker isn't installed here (no docker on PATH), so the compose files were not checked. Casper doesn't install it";
export const COMPOSE_MISSING = "Docker Compose isn't installed here (docker has no compose command), so the compose files were not checked. Casper doesn't install it";

const NO_COMPOSE = /'compose' is not a docker command|unknown command "compose"|unknown shorthand flag: 'f' in -f/;

/**
 * The values in a stack's .env that Compose's errors can echo (`invalid hostPort: <value>`): secret-named ones of 4
 * characters or more, and any other long one. Numbers, yes/no words, paths and addresses are left out.
 */
export async function envSecretValues(folder: string): Promise<string[]> {
  const text = await readFile(path.join(folder, ".env"), "utf8").catch(() => "");
  const values = new Set<string>();
  for (const line of text.slice(0, 1024 * 1024).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = /^(["'])(.*)\1$/.exec(value);
    value = quote ? quote[2]! : value.replace(/\s+#.*$/, "");
    if (value.length < 4 || /^\d+$/.test(value) || /^(?:true|false|yes|no|on|off)$/i.test(value)) continue;
    if (isSecretName(match[1]!) || (value.length >= 12 && !/^(?:\/|~|\.{1,2}\/|[a-z][\w+.-]*:\/\/[^@]*$)/i.test(value))) values.add(value);
  }
  return [...values];
}

/** Compose's output with the .env values hidden, and a quoted cut-off piece of one too (`parsing "Sup3rS3"`). */
function hideEnvValues(text: string, values: readonly string[]): string {
  if (!values.length) return text;
  return scrubExactValues(text, values).text
    .replace(/"([^"\n]{4,})"/g, (whole, inner: string) => values.some((value) => value.includes(inner)) ? `"${SECRET_MARKER}"` : whole);
}

const errorLines = (result: VerificationResult) => `${result.stderr}\n${result.stdout}`.replace(/\x1b\[[\d;]*[A-Za-z]/g, "")
  .split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());

export interface ComposeRunOptions {
  root: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onCleanupFailure?: CommandCheckOptions["onCleanupFailure"];
  wrap?: CommandWrap;
  /** The environment docker gets and is looked for in; unset: Casper's own. */
  env?: NodeJS.ProcessEnv;
}

/** Runs Compose's validator on the project's compose files as they are now: files the change added count too. A
 * failure names each file that failed and Compose's own error lines. */
export async function runComposeCheck(options: ComposeRunOptions): Promise<VerificationResult> {
  const { root } = options;
  const base = { name: COMPOSE_CHECK, command: COMPOSE_COMMAND, cwd: root, signal: null, truncated: false } as const;
  const skip = (reason: string, durationMs = 0): VerificationResult =>
    ({ ...base, status: "skip", exitCode: null, stdout: "", stderr: "", durationMs, reason, repair: "never" });
  const files = await findComposeFiles(root);
  if (!files.length) return skip("no compose files are left in the project");
  if (!await onPath("docker", options.env ?? process.env)) return skip(DOCKER_MISSING);
  const started = performance.now();
  const failed: { file: string; result: VerificationResult }[] = [];
  for (const file of files) {
    const result = await runCommandCheck({
      name: COMPOSE_CHECK, argv: ["docker", "compose", "-f", path.posix.basename(file), "config", "--quiet"],
      cwd: path.join(root, path.posix.dirname(file)), timeoutMs: options.timeoutMs, signal: options.signal,
      onCleanupFailure: options.onCleanupFailure, ...(options.wrap ? { wrap: options.wrap } : {}), ...(options.env ? { env: options.env } : {}),
    });
    if (result.status === "pass") continue;
    // Not started, stopped, cut short or blocked by the sandbox: that says more than any file's error.
    if (result.ended === "no_start") return skip(DOCKER_MISSING, Math.round(performance.now() - started));
    if (NO_COMPOSE.test(`${result.stderr}\n${result.stdout}`)) return skip(COMPOSE_MISSING, Math.round(performance.now() - started));
    // Compose's errors can hold values from the stack's .env: those never reach the AI, the screen or the receipt.
    const values = await envSecretValues(path.join(root, path.posix.dirname(file)));
    const hidden = { ...result, stdout: hideEnvValues(result.stdout, values), stderr: hideEnvValues(result.stderr, values),
      ...(result.reason ? { reason: hideEnvValues(result.reason, values) } : {}) };
    if (result.ended || result.reason) return { ...hidden, command: COMPOSE_COMMAND, cwd: root };
    failed.push({ file, result: hidden });
  }
  const durationMs = Math.round(performance.now() - started);
  const count = `${files.length} compose file${files.length === 1 ? "" : "s"}`;
  if (!failed.length) return { ...base, status: "pass", exitCode: 0, stdout: "", stderr: "", durationMs, label: count };
  const stderr = failed.map(({ file, result }) => [`${file}:`, ...errorLines(result).slice(0, 20).map((line) => `  ${line}`)].join("\n")).join("\n");
  const first = failed[0]!;
  const more = failed.length > 1 ? ` (and ${failed.length - 1} more)` : "";
  const error = (errorLines(first.result)[0] ?? `docker compose exited with ${first.result.exitCode}`).trim().slice(0, 300);
  const reason = `${first.file} is not valid — ${error}${more}`;
  return { ...base, status: "fail", exitCode: first.result.exitCode, stdout: "", stderr, durationMs, reason,
    truncated: failed.some(({ result }) => result.truncated), label: count };
}
