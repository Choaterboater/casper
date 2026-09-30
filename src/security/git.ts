import { spawn } from "node:child_process";
import { safeGitArgs } from "../platform/git";

/**
 * The few read-only git questions the security check asks: which files exist, which changed since the
 * last commit, and which lines. Repo config cannot run anything (safeGitArgs turns off fsmonitor and
 * hooks; diffs use no external diff or textconv), and inherited GIT_* variables cannot point git at
 * another repository.
 */

const GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface GitResult { code: number | null; stdout: string }

function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !/^GIT_/i.test(name)) env[name] = value;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

export function git(root: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", safeGitArgs(args), { cwd: root, env: gitEnv(process.env), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch { resolve({ code: null, stdout: "" }); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > GIT_OUTPUT_BYTES) { child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, stdout: "" }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: size > GIT_OUTPUT_BYTES ? null : code, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

export interface GitState {
  /** The folder is inside a git work tree. */
  inRepo: boolean;
  /** The repo has at least one commit, so "committed" has a meaning. */
  hasHead: boolean;
}

export async function gitState(root: string): Promise<GitState> {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { inRepo: false, hasHead: false };
  const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return { inRepo: true, hasHead: head.code === 0 };
}

const splitZ = (text: string): string[] => text.split("\0").filter(Boolean);

/** Tracked files plus untracked files git does not ignore, relative to `root`. */
export async function gitFiles(root: string): Promise<string[] | undefined> {
  const listed = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"]);
  return listed.code === 0 ? [...new Set(splitZ(listed.stdout))] : undefined;
}

export interface HeadChanges {
  /** Files that differ from HEAD (staged or not), plus untracked files. */
  changed: Set<string>;
  /** Files git does not track and does not ignore: every line of them is new. */
  untracked: Set<string>;
}

export async function changesSinceHead(root: string, state: GitState): Promise<HeadChanges | undefined> {
  if (!state.inRepo) return undefined;
  const others = await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if (others.code !== 0) return undefined;
  const untracked = new Set(splitZ(others.stdout));
  if (!state.hasHead) {
    const tracked = await git(root, ["ls-files", "-z", "--cached"]);
    return { changed: new Set([...splitZ(tracked.stdout), ...untracked]), untracked };
  }
  const diff = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--relative", "HEAD", "--"]);
  if (diff.code !== 0) return undefined;
  return { changed: new Set([...splitZ(diff.stdout), ...untracked]), untracked };
}

/**
 * Worktree line numbers (1-based) that are new or changed since HEAD in one tracked file. A line that is
 * not in this set reads the same as in HEAD, so a marker on it was committed by the user.
 */
export async function linesChangedSinceHead(root: string, file: string): Promise<Set<number> | undefined> {
  const diff = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U0", "HEAD", "--", `:(literal)${file}`]);
  if (diff.code !== 0) return undefined;
  const lines = new Set<number>();
  for (const match of diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let line = start; line < start + count; line++) lines.add(line);
  }
  return lines;
}

/** Whether HEAD has this file. A git-ignored file is not in HEAD, so nothing in it was committed. */
export async function inHead(root: string, file: string): Promise<boolean> {
  return (await git(root, ["cat-file", "-e", `HEAD:./${file}`])).code === 0;
}

/** A file's text in HEAD, or undefined when it is not there. */
export async function headText(root: string, file: string): Promise<string | undefined> {
  const shown = await git(root, ["show", `HEAD:./${file}`]);
  return shown.code === 0 ? shown.stdout : undefined;
}
