/** Running GitHub's command line tool (gh) for the `github` tool: outside the shell sandbox, by Casper's own code, with
 * an argument list Casper builds from checked values. The model never writes an argument, never sees gh's login or
 * its config folder (private places), and gets back only compact text from the verbs in tool.ts. */

import os from "node:os";
import { SECRET_ENV_NAME } from "../mcp/check/sandbox";
import { git } from "../security/git";
import { runInstallStep, type ToolRunner } from "../security/spawn";

export const GH_TIMEOUT_MS = 30_000;
/** What one gh call may print before Casper stops it: a list of pull requests, or a job's whole log (only its tail is kept). */
export const JSON_BYTES = 1024 * 1024;
export const LOG_BYTES = 8 * 1024 * 1024;

/** The names gh needs from Casper's own environment. Everything else is dropped, and any other credential-looking name
 * with it. GH_TOKEN and GITHUB_TOKEN pass only because you set them for gh yourself. */
const KEEP = new Set(["PATH", "HOME", "USER", "USERNAME", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TMPDIR", "TEMP", "TMP", "TERM",
  "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"]);
const KEEP_WINDOWS = new Set(["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH"]);
const TOKEN_NAMES = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

export function githubEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const keep = KEEP.has(upper) || upper.startsWith("LC_") || (platform === "win32" && KEEP_WINDOWS.has(upper));
    if (keep && (TOKEN_NAMES.has(upper) || !SECRET_ENV_NAME.test(name))) env[name] = value;
  }
  // gh never asks, paints, updates itself or prints debug lines (which can hold a token) here.
  env.GH_PROMPT_DISABLED = "1";
  env.GH_NO_UPDATE_NOTIFIER = "1";
  env.GH_NO_EXTENSION_UPDATE_NOTIFIER = "1";
  env.GH_SPINNER_DISABLED = "1";
  env.NO_COLOR = "1";
  return env;
}

export interface Repo { owner: string; name: string }
const PART = /^[A-Za-z0-9_.-]+$/;
export const repoText = (repo: Repo) => `${repo.owner}/${repo.name}`;

/** owner and name of a github.com remote (https, ssh or scp style), or undefined for anything else. */
export function parseRemote(url: string): Repo | undefined {
  const match = /^(?:https?:\/\/(?:[^/@]+@)?|ssh:\/\/(?:[^/@]+@)?|git@)github\.com[/:]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!match) return undefined;
  const [, owner, name] = match;
  // No leading "-" or "." parts: a name is one argument value, never a flag or a path step.
  const ok = (part: string) => PART.test(part) && !part.startsWith("-") && !/^\.+$/.test(part);
  return ok(owner!) && ok(name!) ? { owner: owner!, name: name! } : undefined;
}

/** The repo of the project's `origin` remote, read with Casper's own git (no repo hooks or config commands). */
export async function projectRepo(root: string): Promise<Repo | undefined> {
  const result = await git(root, ["remote", "get-url", "origin"], 10_000);
  return result.code === 0 ? parseRemote(result.stdout.split("\n")[0] ?? "") : undefined;
}

export type GhResult = { ok: true; stdout: string } | { ok: false; message: string };

export const GH_MISSING = "GitHub's gh tool is not installed here. Install it from https://cli.github.com, then run `gh auth login` in your own terminal.";
export const GH_SIGNED_OUT = "gh is not signed in to GitHub. Run `gh auth login` in your own terminal, then ask again.";
const SIGNED_OUT = /gh auth login|not logged in|authentication required|bad credentials|HTTP 401|requires authentication/i;

export interface GhOptions {
  run?: ToolRunner;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxBytes?: number;
  /** Turns gh's own stderr into one safe line. */
  clean: (text: string) => string;
}

/** One gh call. `args` are built by Casper from checked values only. */
export async function runGh(args: readonly string[], options: GhOptions): Promise<GhResult> {
  const result = await (options.run ?? runInstallStep)({
    file: "gh", args, cwd: os.tmpdir(), env: githubEnv(options.env ?? process.env), timeoutMs: GH_TIMEOUT_MS,
    maxStdoutBytes: options.maxBytes ?? JSON_BYTES, ...(options.signal ? { signal: options.signal } : {}),
  });
  if (result.ended === "no_start") return { ok: false, message: GH_MISSING };
  if (result.ended === "cancelled") return { ok: false, message: "Cancelled." };
  if (result.ended === "timeout") return { ok: false, message: `GitHub did not answer within ${GH_TIMEOUT_MS / 1000} seconds.` };
  if (result.ended === "too_large") return { ok: false, message: "GitHub's answer was too large to read." };
  if (result.exitCode !== 0) {
    if (SIGNED_OUT.test(result.stderr)) return { ok: false, message: GH_SIGNED_OUT };
    const line = options.clean(result.stderr.split("\n").find((entry) => entry.trim()) ?? "").slice(0, 200);
    return { ok: false, message: `gh could not do that${line ? `: ${line}` : "."}` };
  }
  return { ok: true, stdout: result.stdout };
}

/** The argument lists, one per verb. Only these shapes exist. */
export const ghArgs = {
  prs: (repo: Repo) => ["pr", "list", "-R", repoText(repo), "--state", "open", "--limit", "20",
    "--json", "number,title,author,headRefName,isDraft,mergeable,reviewDecision,statusCheckRollup"],
  pr: (repo: Repo, number: number) => ["pr", "view", String(number), "-R", repoText(repo),
    "--json", "number,title,state,author,headRefName,baseRefName,isDraft,mergeable,reviewDecision,statusCheckRollup"],
  log: (repo: Repo, job: string) => ["run", "view", "--job", job, "-R", repoText(repo), "--log-failed"],
  rerun: (repo: Repo, run: string) => ["run", "rerun", run, "--failed", "-R", repoText(repo)],
};
