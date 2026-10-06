import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { openNoFollow } from "../platform/files";
import { safeGitArgs } from "../platform/git";

const execFileAsync = promisify(execFile);

/** Never descended: VCS internals, dependency trees, Casper's own state, and Python environments and
 * caches (a project's .venv alone can hold tens of thousands of files). */
export const SKIPPED_DIRECTORIES: Record<string, true> = { ".git": true, node_modules: true, ".casper": true,
  ".venv": true, __pycache__: true, ".mypy_cache": true, ".pytest_cache": true, ".ruff_cache": true, ".tox": true,
  // Dev server build caches: a page check writes them, and they are never the user's change.
  ".next": true, ".nuxt": true, ".svelte-kit": true, ".astro": true, ".vite": true };

/** A `venv` folder is skipped only when it is a virtual environment, never a source folder of that name. */
async function skipped(root: string, relative: string, name: string): Promise<boolean> {
  if (Object.hasOwn(SKIPPED_DIRECTORIES, name)) return true;
  // Streamlit's own cache folder, written while a page check runs the app (never .streamlit's config files).
  if (relative.replace(/\\/g, "/") === ".streamlit/cache") return true;
  return name === "venv" && Boolean(await lstat(path.join(root, relative, "pyvenv.cfg")).catch(() => undefined));
}

/** Tracked files plus untracked ones git does not ignore: what the user's repository is made of. Undefined
 * outside a git work tree (or when git is unavailable), and when git lists nothing (the folder itself is
 * ignored by an enclosing repository), so the caller walks the folder instead. A nested repository or
 * submodule is one listed folder entry, which the caller walks. */
async function gitListed(root: string, signal?: AbortSignal): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync("git", safeGitArgs(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
      { cwd: root, timeout: 15_000, maxBuffer: 256 * 1024 * 1024, signal, encoding: "utf8" });
    const listed = [...new Set(stdout.split("\0").filter(Boolean).map((relative) => relative.replace(/\/+$/, "")))];
    const skips = new Map<string, Promise<boolean>>();
    const kept = await Promise.all(listed.map(async (relative) => await insideSkipped(root, relative, skips) ? undefined : relative));
    const files = kept.filter((relative): relative is string => relative !== undefined);
    return files.length ? files : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

/** A listed path under a folder the walk would skip (.venv, caches, node_modules, a real venv). */
async function insideSkipped(root: string, relative: string, cache: Map<string, Promise<boolean>>): Promise<boolean> {
  const parts = relative.split("/");
  for (let index = 0; index < parts.length - 1; index++) {
    const folder = parts.slice(0, index + 1).join("/");
    let skip = cache.get(folder);
    if (!skip) cache.set(folder, skip = skipped(root, folder, parts[index]!));
    if (await skip) return true;
  }
  return false;
}
/** Removed between listing and inspection: absent from this snapshot, like any other missing path. */
const VANISHED: Record<string, true> = { ENOENT: true, ENOTDIR: true };
/** Beyond this a file is identified by size and mtime; hashing it would stall the receipt. */
export const HASH_LIMIT = 8 * 1024 * 1024;
/** A tree larger than this reports "unknown" rather than making the user wait. */
export const SNAPSHOT_FILE_LIMIT = 20_000;
const CHUNK = 64 * 1024;
/** Open handles per directory batch; one read buffer each. */
const CONCURRENCY = 16;

export interface TreeChanges {
  added: string[];
  modified: string[];
  removed: string[];
}

/** Relative path → content identity. In a git work tree the paths are what git lists (tracked, plus
 * untracked files it does not ignore), so an ignored .venv or build folder of any size is left out;
 * elsewhere the folder is walked without dependency trees, virtual environments and caches.
 * Symlinks are never followed (`link:<target>`), oversized files are identified by
 * `size:<bytes>:<mtime>`, unreadable ones by `error:<code>`. Throws when aborted or when the tree
 * exceeds the file limit (SNAPSHOT_FILE_LIMIT). */
export async function snapshotTree(root: string, signal?: AbortSignal, options: { fileLimit?: number; git?: boolean; include?: Iterable<string> } = {}): Promise<Map<string, string>> {
  const limit = options.fileLimit ?? SNAPSHOT_FILE_LIMIT;
  const digests = new Map<string, string>();
  const chunks = Array.from({ length: CONCURRENCY }, () => Buffer.allocUnsafe(CHUNK));
  const digestAll = async (files: string[]) => {
    for (let start = 0; start < files.length; start += CONCURRENCY) {
      signal?.throwIfAborted();
      if (digests.size + files.length - start > limit) throw new RangeError(`Workspace exceeds ${limit} files`);
      const batch = files.slice(start, start + CONCURRENCY);
      const results = await Promise.all(batch.map((next, index) => digestEntry(path.join(root, next), chunks[index]!)));
      results.forEach((digest, index) => { if (digest !== undefined) digests.set(batch[index]!, digest); });
    }
  };
  const listed = options.git === false ? undefined : await gitListed(root, signal);
  const pending = listed ? [] : [""];
  if (listed) {
    if (listed.length > limit) throw new RangeError(`Workspace exceeds ${limit} files`);
    await digestAll(listed);
    // A nested repository or submodule is listed as one folder: walk it like any other folder.
    for (const relative of listed) {
      if (digests.has(relative)) continue;
      const stats = await lstat(path.join(root, relative)).catch(() => undefined);
      if (stats?.isDirectory()) pending.push(relative);
    }
  }
  while (pending.length) {
    signal?.throwIfAborted();
    const relative = pending.pop()!;
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
    catch (error) { if (VANISHED[errorCode(error) ?? ""]) continue; throw error; }
    const files: string[] = [];
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!await skipped(root, next, entry.name)) pending.push(next); }
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(next);
    }
    await digestAll(files);
  }
  // Casper's own folder is skipped, but the project's settings file in it is the project's: a change to it is listed.
  // `include` names files to list even when git ignores them: those listed before a task (a file the task added to
  // .gitignore is not removed) and those the task's own tools wrote (an ignored file the AI wrote is a change).
  for (const relative of new Set([PROJECT_FILE, ...listed ? options.include ?? [] : []])) {
    if (digests.has(relative) || !relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) continue;
    signal?.throwIfAborted();
    const digest = await digestEntry(path.join(root, relative), chunks[0]!);
    if (digest !== undefined) digests.set(relative, digest);
  }
  return digests;
}

/** The project's Casper settings: inside the skipped .casper folder, yet listed like any project file. */
const PROJECT_FILE = ".casper/project.yaml";

async function digestEntry(target: string, chunk: Buffer): Promise<string | undefined> {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) return `link:${await readlink(target)}`;
    if (!stats.isFile()) return undefined;
    if (stats.size > HASH_LIMIT) return `size:${stats.size}:${stats.mtimeMs}`;
    const handle = await openNoFollow(target);
    try {
      const hash = createHash("sha256");
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        hash.update(chunk.subarray(0, bytesRead));
      }
      return hash.digest("hex");
    } finally { await handle.close(); }
  } catch (error) {
    const code = errorCode(error);
    return code && VANISHED[code] ? undefined : `error:${code ?? "unknown"}`;
  }
}

/** Why a snapshot failed, in plain words for the receipt. */
export function snapshotFailureReason(error: unknown): string {
  const over = error instanceof RangeError ? /exceeds (\d+) files/.exec(error.message) : null;
  if (over) return `this folder has over ${Number(over[1]).toLocaleString("en-US")} files; open a project folder`;
  const code = errorCode(error);
  return code ? `Casper could not read this folder (${code})` : "Casper could not read this folder";
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

/** Added/modified/removed paths, sorted. Removals cannot be content-compared. */
export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): TreeChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [relative, digest] of after) {
    if (!before.has(relative)) added.push(relative);
    else if (before.get(relative) !== digest) modified.push(relative);
  }
  for (const relative of before.keys()) if (!after.has(relative)) removed.push(relative);
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}
