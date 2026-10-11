/** Pictures from the user's ChatGPT plan, through the Codex CLI they installed and signed in to. Casper never uses
 * the plan's sign-in itself: Codex runs in an empty temp folder, under its own read-only sandbox, with Casper's
 * instructions only and none of Casper's or the shell's keys, and the picture its image tool saved is copied back. */

import { lstat, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCodex, type ToolRunner } from "../security/spawn";
import { imageType, MAX_PICTURE_BYTES } from "./format";

/** How long one Codex picture may take. */
export const CODEX_TIMEOUT_MS = 180_000;

/** What Codex gets from Casper's environment: where it lives and how it reaches the network. No keys: it signs in
 * with its own ~/.codex login (an OPENAI_API_KEY here would bill the key instead of the plan). */
const PASSED = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP", "CODEX_HOME", "XDG_CONFIG_HOME",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "no_proxy", "all_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS", "SystemRoot", "windir", "SystemDrive", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramData"];

export interface CodexOptions {
  env?: NodeJS.ProcessEnv;
  run?: ToolRunner;
  timeoutMs?: number;
}

export function codexEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const name of PASSED) if (env[name]) clean[name] = env[name]!;
  return clean;
}

/** The codex program on PATH, or undefined. Runs nothing. */
export function findCodex(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return Bun.which("codex", { PATH: env.PATH ?? "" }) ?? undefined;
}

/** `codex login status` says it is signed in with a ChatGPT plan (an API key sign-in would cost money). */
export async function codexSignedIn(file: string, options: CodexOptions = {}, signal?: AbortSignal): Promise<boolean> {
  const result = await (options.run ?? runCodex)({ file, args: ["login", "status"], cwd: os.tmpdir(), env: codexEnvironment(options.env),
    timeoutMs: 15_000, ...(signal ? { signal } : {}), maxStdoutBytes: 64 * 1024 });
  return result.exitCode === 0 && /\bChatGPT\b/i.test(`${result.stdout}\n${result.stderr}`);
}

/** One picture from Codex: its bytes, or why there is none. Codex's built-in image tool saves what it makes under
 * $CODEX_HOME/generated_images/<session>/ by itself, so Codex is told only to make the picture (writing it out itself
 * took dozens of shell steps) and Casper copies the newest picture saved there after the call started. Codex runs
 * with `-s read-only`: the image tool is Codex's own, not a command, so it works there, and nothing else is needed. */
export async function codexPicture(file: string, prompt: string, options: CodexOptions = {},
  signal?: AbortSignal): Promise<{ bytes: Uint8Array } | { failed: string }> {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), "casper-picture-")));
  try {
    const instructions = `Use your built-in image_gen tool to generate exactly one image of: ${prompt}\n`
      + "Do not save, copy, decode or write the image yourself, and do not run shell commands. Reply only DONE when the image is generated.";
    // Whole seconds: some file systems keep mtimes to the second.
    const started = Math.floor(Date.now() / 1000) * 1000;
    const result = await (options.run ?? runCodex)({ file, cwd: folder, env: codexEnvironment(options.env), timeoutMs: options.timeoutMs ?? CODEX_TIMEOUT_MS,
      args: ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "-C", folder, "--enable", "image_generation", "-s", "read-only", instructions],
      ...(signal ? { signal } : {}) });
    if (result.ended === "cancelled") return { failed: "cancelled" };
    const bytes = await newestPicture(codexHome(options.env), started, threadId(result.stdout));
    if (bytes) return { bytes };
    if (result.ended === "timeout") return { failed: `took longer than ${Math.round((options.timeoutMs ?? CODEX_TIMEOUT_MS) / 1000)} s` };
    if (result.ended === "no_start") return { failed: "could not start" };
    return { failed: codexError(result.stdout) ?? (result.exitCode ? `stopped (exit ${result.exitCode}) without a picture` : "made no picture") };
  } finally { await rm(folder, { recursive: true, force: true }).catch(() => {}); }
}

/** $CODEX_HOME, else ~/.codex. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".codex");
}

/** The session id Codex's events give (its generated_images folder has that name). */
function threadId(events: string): string | undefined {
  return /"type":"thread\.started"[^\n]*?"thread_id":"([\w-]+)"/.exec(events)?.[1];
}

/** The newest .png, .jpg or .webp in any folder of <home>/generated_images saved at or after `since`; this session's
 * folder first when Codex named it. Links are never followed, so nothing outside Codex's home is read. */
async function newestPicture(home: string, since: number, session?: string): Promise<Uint8Array | undefined> {
  const images = path.join(home, "generated_images");
  if (!(await lstat(images).catch(() => undefined))?.isDirectory()) return undefined;
  const found: Array<{ file: string; mtime: number; ours: boolean }> = [];
  for (const folder of await readdir(images, { withFileTypes: true }).catch(() => [])) {
    if (!folder.isDirectory()) continue;
    const dir = path.join(images, folder.name);
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, entry.name);
      if (!entry.isFile() || !/\.(?:png|jpe?g|webp)$/i.test(entry.name)) continue;
      const info = await lstat(file).catch(() => undefined);
      if (info?.isFile() && info.mtimeMs >= since && info.size <= MAX_PICTURE_BYTES) found.push({ file, mtime: info.mtimeMs, ours: folder.name === session });
    }
  }
  found.sort((a, b) => Number(b.ours) - Number(a.ours) || b.mtime - a.mtime);
  for (const { file } of found) {
    const bytes = new Uint8Array(await readFile(file));
    if (imageType(bytes)) return bytes;
  }
  return undefined;
}

/** The last error Codex's JSON lines report, short. */
function codexError(events: string): string | undefined {
  let found: string | undefined;
  for (const line of events.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; message?: unknown; error?: { message?: unknown } };
    try { event = JSON.parse(line) as typeof event; } catch { continue; }
    const message = event.type === "error" ? event.message : event.type === "turn.failed" ? event.error?.message : undefined;
    if (typeof message === "string" && message.trim()) found = message.trim();
  }
  return found ? found.replace(/\s+/g, " ").slice(0, 300) : undefined;
}
