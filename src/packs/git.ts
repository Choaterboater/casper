import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installEnv } from "../security/env";
import { runFetchStep, type ToolRunner } from "../security/spawn";
import { PACK_LIMITS, readPackFolder, shownLine, SKIPPED_ANYWHERE, type PackContents } from "./files";
import { isPackPath, packPathRefusal, PackError } from "./manifest";

/**
 * A pack from GitHub, named by one commit: https://github.com/<owner>/<repo>@<the full 40-character commit id>.
 * A branch or tag can point somewhere else tomorrow, so neither is taken; adding it again is the only update.
 *
 * Only https, only github.com, no redirects. git runs with no settings of yours or the system's (GIT_CONFIG_GLOBAL is
 * the null device, GIT_CONFIG_NOSYSTEM=1, no GIT_* from your environment), hooks pointed at an empty folder, every
 * protocol but https refused, no credential helper and no prompt. It fetches that one commit, depth 1, no tags, no
 * submodules, into a temp folder (through the shell sandbox's host list where a sandbox runs). Nothing is checked
 * out: each file is read from git's objects, so a filter, an attribute or LFS never runs. Then the files go through
 * the same checks as a folder.
 *
 * GitHub serves a commit made in any fork of a repository at the repository's own address, so a commit id alone
 * doesn't say whose it is. Before any file is fetched, the commit must be on one of the repository's own branches or
 * tags: a second fetch takes the history of those (commits only, no files) and git checks the commit is in it.
 */

export const PACK_GIT_HOST = "github.com";

export interface GitPackSource {
  /** What git fetches: https://github.com/<owner>/<repo>.git */
  url: string;
  /** github.com/<owner>/<repo>, lowercase: the same source whatever the commit. */
  repo: string;
  commit: string;
  /** github.com/<owner>/<repo> as typed, for the box. */
  shown: string;
  /** https://github.com/<owner>/<repo>@<commit>: what you would type again. */
  text: string;
}

export const GIT_SOURCE_HELP = "A pack from GitHub is added by one commit: /pack add https://github.com/owner/repo@<the full 40-character commit id>. Casper never follows a branch or tag.";
export const GIT_MISSING = "Adding a pack from GitHub needs git, and git isn't installed. Install git, or download the pack and type /pack add <folder>.";

/** A source that reads as an address rather than a folder. */
export function isGitSource(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^git@/i.test(text) || /^(?:www\.)?github\.com[/:]/i.test(text);
}

export function parseGitSource(text: string): GitPackSource {
  if (!/^https:\/\//i.test(text)) throw new PackError(`Casper fetches packs over https only. ${GIT_SOURCE_HELP}`);
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})@([0-9a-fA-F]+)$/.exec(text);
  const host = /^https:\/\/([^/@?#]+)/i.exec(text)?.[1]?.toLowerCase();
  if (host !== PACK_GIT_HOST) throw new PackError(`Casper fetches packs from ${PACK_GIT_HOST} only. For a pack from somewhere else, download it and type /pack add <folder>.`);
  if (!match) throw new PackError(GIT_SOURCE_HELP);
  const owner = match[1]!;
  const repo = match[2]!.replace(/\.git$/i, "");
  const commit = match[3]!.toLowerCase();
  if (!repo || repo === "." || repo === ".." || commit.length !== 40) throw new PackError(GIT_SOURCE_HELP);
  const shown = `${PACK_GIT_HOST}/${owner}/${repo}`;
  return { url: `https://${shown}.git`, repo: shown.toLowerCase(), commit, shown, text: `https://${shown}@${commit}` };
}

/** The settings every pack git command runs with. `hooks` is an empty folder. */
export function packGitConfig(hooks: string): string[] {
  return [
    "-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", "-c", "core.symlinks=false",
    "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false",
    "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "-c", "submodule.recurse=false",
    "-c", "credential.helper=", "-c", "core.askPass=", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
  ];
}

/** Your proxy and certificates, and nothing of git's from your environment or settings. git on Windows can't open
 * the null device by its \\.\nul name, so it gets NUL there. */
export function packGitEnv(base: NodeJS.ProcessEnv, scratch: string, platform: NodeJS.Platform = process.platform): Record<string, string> {
  return {
    ...installEnv(base), HOME: scratch, XDG_CONFIG_HOME: path.join(scratch, ".config"),
    GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ALLOW_PROTOCOL: "https", GIT_LFS_SKIP_SMUDGE: "1",
  };
}

export interface LocalGitResult { code: number | null; stdout: Buffer; stderr: string; missing?: boolean }
/** A git command on the temp copy only, no network: raw bytes out. */
export type LocalGit = (args: readonly string[], options: { cwd: string; env: Record<string, string>; maxBytes: number; signal?: AbortSignal }) => Promise<LocalGitResult>;

const LOCAL_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 120_000;

export const runLocalGit: LocalGit = (args, options) => new Promise((resolve) => {
  const stdout: Buffer[] = [];
  let bytes = 0;
  let stderr = "";
  let tooLarge = false;
  let child: ReturnType<typeof spawn>;
  try { child = spawn("git", [...args], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
  catch { resolve({ code: null, stdout: Buffer.alloc(0), stderr: "", missing: true }); return; }
  const stop = () => child.kill("SIGKILL");
  const timer = setTimeout(stop, LOCAL_TIMEOUT_MS);
  options.signal?.addEventListener("abort", stop, { once: true });
  child.stdout!.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > options.maxBytes) { tooLarge = true; stop(); return; }
    stdout.push(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096); });
  let settled = false;
  const done = (code: number | null, missing = false) => {
    if (settled) return; settled = true;
    clearTimeout(timer); options.signal?.removeEventListener("abort", stop);
    resolve({ code: tooLarge ? null : code, stdout: Buffer.concat(stdout), stderr, ...(missing ? { missing } : {}) });
  };
  child.once("error", (error: NodeJS.ErrnoException) => done(null, error.code === "ENOENT"));
  child.once("close", (code) => done(code));
});

export interface GitFetchOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  /** The fetch (tests pass one that reads a local copy). */
  fetch?: ToolRunner;
  local?: LocalGit;
}

/** git's last line, as plain words: never more than one line of what a server said. */
function gitSaid(stderr: string): string {
  const last = stderr.split("\n").map((line) => shownLine(line)).filter(Boolean).at(-1);
  return last ? ` (git: ${last.length > 160 ? `${last.slice(0, 159)}…` : last})` : "";
}

function fetchFailure(source: GitPackSource, stderr: string, ended?: string): string {
  const short = source.commit.slice(0, 12);
  if (ended === "timeout") return `Fetching ${source.repo} took more than 2 minutes, so Casper stopped. Nothing was added.`;
  if (/not our ref|couldn't find remote ref|no such remote ref|unadvertised object|not a valid object/i.test(stderr)) return `${source.repo} has no commit ${short}. Check the commit id. Nothing was added.`;
  if (/repository not found|could not read username|authentication failed|terminal prompts disabled|403|401/i.test(stderr)) return `${source.repo} isn't there or isn't public. Casper fetches public repositories only. Nothing was added.`;
  if (/redirect/i.test(stderr)) return `github.com answered with a redirect, and Casper doesn't follow redirects. Nothing was added.`;
  if (/could not resolve host|failed to connect|timed out|connection (?:refused|reset)|network is unreachable|proxy/i.test(stderr)) return `Casper could not reach github.com. Check your connection, then try again. Nothing was added.`;
  return `git could not fetch ${source.repo} at ${short}${gitSaid(stderr)}. Nothing was added.`;
}

/** The commit is somewhere GitHub serves it from, but not on the repository's own branches or tags: most likely a fork's. */
function notOnBranch(source: GitPackSource): string {
  return `Commit ${source.commit.slice(0, 12)} is not on any branch or tag of ${source.shown}. GitHub also serves commits made in other people's copies (forks) of a repository at its address, so Casper takes only a commit on the repository's own branches or tags. Nothing was added.`;
}

interface TreeEntry { mode: string; type: string; oid: string; size: number; path: string }

function treeEntries(listing: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const line of listing.toString("utf8").split("\0")) {
    if (!line) continue;
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t(.+)$/s.exec(line);
    if (!match) throw new PackError("git listed the commit in a way Casper doesn't read. Nothing was added.");
    entries.push({ mode: match[1]!, type: match[2]!, oid: match[3]!, size: match[4] === "-" ? -1 : Number(match[4]), path: match[5]! });
  }
  return entries;
}

/** Fetches one commit's files into a temp folder, reads them as a folder pack, and removes the temp folder. */
export async function fetchGitPack(source: GitPackSource, options: GitFetchOptions = {}): Promise<PackContents> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "casper-pack-"));
  try {
    const hooks = path.join(scratch, "no-hooks");
    const repo = path.join(scratch, "repo");
    const history = path.join(scratch, "history");
    const tree = path.join(scratch, "tree");
    await mkdir(hooks);
    await mkdir(tree);
    const env = packGitEnv(options.env ?? process.env, scratch, options.platform);
    const config = packGitConfig(hooks);
    const local = options.local ?? runLocalGit;
    const git = (args: string[], maxBytes = 64 * 1024) => local([...config, ...args], { cwd: scratch, env, maxBytes, ...(options.signal ? { signal: options.signal } : {}) });
    const version = await git(["--version"]);
    if (version.missing || version.code !== 0) throw new PackError(GIT_MISSING);
    if ((await git(["init", "-q", "--template=", repo])).code !== 0 || (await git(["init", "-q", "--template=", history])).code !== 0) {
      throw new PackError("git could not make a temp folder for the fetch. Nothing was added.");
    }
    const fetch = async (args: string[]) => {
      const run = await (options.fetch ?? runFetchStep)({
        file: "git", args: [...config, ...args], cwd: scratch, env, timeoutMs: FETCH_TIMEOUT_MS, maxStdoutBytes: 64 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (run.ended === "no_start") throw new PackError(GIT_MISSING);
      if (run.ended === "cancelled") throw new PackError("Stopped. Nothing was added.");
      if (run.exitCode !== 0) throw new PackError(fetchFailure(source, run.stderr, run.ended));
    };
    // The repository's own branches and tags, and the commit, with their history but no files (a partial fetch).
    await fetch(["-c", "extensions.partialClone=casper", "-c", "remote.casper.promisor=true", "-C", history, "fetch", "--quiet", "--filter=tree:0",
      "--no-tags", "--no-recurse-submodules", "--", source.url, "+refs/heads/*:refs/casper/heads/*", "+refs/tags/*:refs/casper/tags/*", source.commit]);
    const owned = await git(["-C", history, "for-each-ref", "--count=1", "--format=%(refname)", "--contains", source.commit, "refs/casper/"]);
    if (owned.code !== 0 || !owned.stdout.toString("utf8").trim()) throw new PackError(notOnBranch(source));
    await fetch(["-C", repo, "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", source.url, source.commit]);
    const resolved = await git(["-C", repo, "rev-parse", "--verify", "--quiet", `${source.commit}^{commit}`]);
    if (resolved.code !== 0 || resolved.stdout.toString("utf8").trim() !== source.commit) throw new PackError(`${source.repo} has no commit ${source.commit.slice(0, 12)}. Nothing was added.`);
    const listed = await git(["-C", repo, "ls-tree", "-r", "-l", "-z", "--full-tree", source.commit], 4 * 1024 * 1024);
    if (listed.code !== 0) throw new PackError(`git could not list the commit${gitSaid(listed.stderr)}. Nothing was added.`);
    // The files macOS and Windows leave are skipped as in a folder: never written, read or shown.
    const entries = treeEntries(listed.stdout).filter((entry) => !entry.path.split("/").some((part) => SKIPPED_ANYWHERE.has(part)));
    if (entries.length > PACK_LIMITS.files) throw new PackError(`The pack has more than ${PACK_LIMITS.files} files.`);
    let total = 0;
    const seen = new Map<string, string>();
    for (const entry of entries) {
      const shown = JSON.stringify(shownLine(entry.path));
      if (entry.mode === "120000") throw new PackError(`${shown} is a link. A pack holds plain files only.`);
      if (entry.mode === "160000") throw new PackError(`${shown} is a submodule. Casper doesn't fetch submodules.`);
      if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) throw new PackError(`${shown} is not a plain file.`);
      if (entry.path.split("/").length - 1 > PACK_LIMITS.depth) throw new PackError(`${shown} is more than ${PACK_LIMITS.depth} folders deep.`);
      if (!isPackPath(entry.path)) throw new PackError(packPathRefusal(entry.path, shown));
      // Two names that differ only in case, of a file or a folder, would be one on Windows and macOS.
      const parts = entry.path.split("/");
      for (let depth = 1; depth <= parts.length; depth += 1) {
        const inside = parts.slice(0, depth).join("/");
        if ((seen.get(inside.toLowerCase()) ?? inside) !== inside) throw new PackError(`${inside} is there twice, in different case.`);
        seen.set(inside.toLowerCase(), inside);
      }
      if (entry.size > PACK_LIMITS.fileBytes) throw new PackError(`${entry.path} is larger than ${PACK_LIMITS.fileBytes / 1024} KB.`);
      total += entry.size;
      if (total > PACK_LIMITS.totalBytes) throw new PackError(`The pack is larger than ${PACK_LIMITS.totalBytes / 1024 / 1024} MB.`);
    }
    for (const entry of entries) {
      const blob = await git(["-C", repo, "cat-file", "blob", entry.oid], PACK_LIMITS.fileBytes);
      if (blob.code !== 0 || blob.stdout.length !== entry.size) throw new PackError(`git could not read ${entry.path}. Nothing was added.`);
      if (blob.stdout.subarray(0, 64).toString("utf8").startsWith("version https://git-lfs.github.com/spec/")) {
        throw new PackError(`${entry.path} is stored with Git LFS, which a pack can't use.`);
      }
      const target = path.join(tree, ...entry.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      try { await writeFile(target, blob.stdout, { flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PackError(`${entry.path} is there twice.`);
        throw error;
      }
    }
    return await readPackFolder(tree);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
