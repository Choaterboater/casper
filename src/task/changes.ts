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
/** Pictures, video, audio and archives: a folder too big to list with them is listed without them (`media: false`). */
const MEDIA_FILE = /\.(?:jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|mp4|m4v|mov|webm|mkv|avi|mp3|m4a|wav|flac|ogg|zip|gz|tgz|7z|rar)$/i;
const MEDIA_LEFT_OUT = Symbol("media left out");
/** A snapshot taken with `media: false`: a comparison with it leaves those files out on both sides. */
export function mediaLeftOut(snapshot: ReadonlyMap<string, string>): boolean {
  return (snapshot as { [MEDIA_LEFT_OUT]?: true })[MEDIA_LEFT_OUT] === true;
}
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
 * `size:<bytes>:<mtime>`, unreadable ones by `error:<code>`. A trailing `:x` marks a file anyone can run
 * (POSIX only; Windows has no such bit, so a mode change there is never a change). Throws when aborted or when the tree
 * exceeds the file limit (SNAPSHOT_FILE_LIMIT). */
export async function snapshotTree(root: string, signal?: AbortSignal, options: { fileLimit?: number; git?: boolean; include?: Iterable<string>; media?: boolean } = {}): Promise<Map<string, string>> {
  const limit = options.fileLimit ?? SNAPSHOT_FILE_LIMIT;
  const kept = (relative: string) => options.media !== false || !MEDIA_FILE.test(relative);
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
  const gitFiles = options.git === false ? undefined : await gitListed(root, signal);
  const listed = gitFiles?.filter(kept);
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
      else if ((entry.isFile() || entry.isSymbolicLink()) && kept(next)) files.push(next);
    }
    await digestAll(files);
  }
  // Casper's own folder is skipped, but the project's settings file in it is the project's: a change to it is listed.
  // `include` names files to list even when git ignores them: those listed before a task (a file the task added to
  // .gitignore is not removed) and those the task's own tools wrote (an ignored file the AI wrote is a change).
  for (const relative of new Set([PROJECT_FILE, ...listed ? options.include ?? [] : []])) {
    if (digests.has(relative) || !relative || !kept(relative) || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) continue;
    signal?.throwIfAborted();
    const digest = await digestEntry(path.join(root, relative), chunks[0]!);
    if (digest !== undefined) digests.set(relative, digest);
  }
  if (options.media === false) Object.defineProperty(digests, MEDIA_LEFT_OUT, { value: true });
  return digests;
}

/** The project's Casper settings: inside the skipped .casper folder, yet listed like any project file. */
const PROJECT_FILE = ".casper/project.yaml";

async function digestEntry(target: string, chunk: Buffer): Promise<string | undefined> {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) return `link:${await readlink(target)}`;
    if (!stats.isFile()) return undefined;
    // Whether anyone can run the file is part of what it is (chmod +x is a change); Windows has no such bit.
    const run = process.platform !== "win32" && (stats.mode & 0o111) !== 0 ? ":x" : "";
    if (stats.size > HASH_LIMIT) return `size:${stats.size}:${stats.mtimeMs}${run}`;
    const handle = await openNoFollow(target);
    try {
      const hash = createHash("sha256");
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        hash.update(chunk.subarray(0, bytesRead));
      }
      return hash.digest("hex") + run;
    } finally { await handle.close(); }
  } catch (error) {
    const code = errorCode(error);
    return code && VANISHED[code] ? undefined : `error:${code ?? "unknown"}`;
  }
}

/**
 * Whether a task's change list would fail here, found cheaply when a folder opens: more than SNAPSHOT_FILE_LIMIT files
 * (counted as the snapshot walks, without reading them) or a folder that can't be read. Undefined when the walk ran out
 * of `budgetMs` first: Casper doesn't guess.
 */
export async function unlistable(root: string, budgetMs = 1_500): Promise<"too-many" | "unreadable" | undefined | false> {
  const deadline = Date.now() + budgetMs;
  const pending = [""];
  let files = 0;
  while (pending.length) {
    if (Date.now() > deadline) return undefined;
    const relative = pending.pop()!;
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
    catch (error) { if (VANISHED[errorCode(error) ?? ""]) continue; return "unreadable"; }
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!await skipped(root, next, entry.name)) pending.push(next); }
      else if ((entry.isFile() || entry.isSymbolicLink()) && ++files > SNAPSHOT_FILE_LIMIT) return "too-many";
    }
  }
  return false;
}

/** Why a snapshot failed, in plain words for the receipt. */
export function snapshotFailureReason(error: unknown): string {
  const over = error instanceof RangeError ? /exceeds (\d+) files/.exec(error.message) : null;
  if (over) return `${NOT_A_PROJECT} (over ${Number(over[1]).toLocaleString("en-US")} files)`;
  const code = errorCode(error);
  return code ? `Casper could not read this folder (${code})` : "Casper could not read this folder";
}

/** Said once on a receipt for a folder too big to list (the top of a drive, a home folder): no change list, no undo. */
export const NOT_A_PROJECT = "not a project folder";

/** The reason snapshotFailureReason gives for a folder with too many files to list. */
export function tooManyFiles(reason: string): boolean { return reason.startsWith(NOT_A_PROJECT); }

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

/** Files moved or renamed: an added file whose content is that of a removed one (`mv run run-1/run`). A move is no
 * change of code: it is left out of checks, the proof and the config list, and said on the receipt as one line. */
export function findMoves(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, changes: TreeChanges): Array<{ from: string; to: string; rewritten?: true; copied?: true }> {
  const gone = new Map<string, string[]>();
  // Its old path removed, or written anew since (a relaunched run writes runs/ again after the old one moved aside).
  for (const file of [...changes.removed, ...changes.modified]) {
    const digest = before.get(file);
    if (digest !== undefined) gone.set(digest, [...gone.get(digest) ?? [], file]);
  }
  const moves: Array<{ from: string; to: string; rewritten?: true; copied?: true }> = [];
  const rewritten = new Set(changes.modified);
  const unmatched: string[] = [];
  for (const file of changes.added) {
    const from = gone.get(after.get(file) ?? "\0")?.shift();
    if (from) moves.push({ from, to: file, ...(rewritten.has(from) ? { rewritten: true as const } : {}) });
    else unmatched.push(file);
  }
  // Into a folder files were moved into, a file with the bytes of one from before is moved too, also when its old path
  // holds the same bytes again (a relaunched run writes the same template). A copy anywhere else is new work.
  const into = new Set(moves.map((move) => move.to.split("/")[0]!));
  const sources = new Map<string, string>();
  for (const [file, digest] of before) if (!sources.has(digest)) sources.set(digest, file);
  // A folder the task made (`cp -R scripts package.json run-9/`): what it holds with the bytes of a file from before is a
  // copy, not new work. A copy anywhere else is new work.
  const tops = new Set([...before.keys()].map((file) => file.split("/")[0]!));
  for (const file of unmatched) {
    const top = file.split("/")[0]!, from = file.includes("/") ? sources.get(after.get(file) ?? "\0") : undefined;
    if (!from) continue;
    if (into.has(top)) moves.push({ from, to: file, rewritten: true });
    else if (!tops.has(top)) moves.push({ from, to: file, copied: true });
  }
  return moves.sort((left, right) => left.to.localeCompare(right.to));
}

/** `changes` without the moved files: where they went, and where they came from when that is gone. A path written anew
 * after its file moved away stays a change. */
export function withoutMoves(changes: TreeChanges, moves: ReadonlyArray<{ from: string; to: string; copied?: true }>): TreeChanges {
  if (!moves.length) return changes;
  const moved = new Set(moves.flatMap((move) => [move.to, ...move.copied ? [] : [move.from]]));
  const keep = (file: string) => !moved.has(file);
  return { added: changes.added.filter(keep), modified: changes.modified, removed: changes.removed.filter(keep) };
}

/** "run-1/": where moved files went, as the deepest folder they share, or up to two top folders. */
export function movedInto(moves: ReadonlyArray<{ to: string }>): string {
  const parts = moves.map((move) => move.to.split("/").slice(0, -1));
  let shared = parts[0] ?? [];
  for (const folder of parts) { let at = 0; while (at < shared.length && shared[at] === folder[at]) at++; shared = shared.slice(0, at); }
  if (shared.length) return `${shared.join("/")}/`;
  const tops = [...new Set(moves.map((move) => move.to.split("/")[0]!))];
  return tops.length <= 2 ? tops.map((top) => `${top}/`).join(" and ") : "several folders";
}

/** Added/modified/removed paths, sorted. Removals cannot be content-compared. */
export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): TreeChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  // One side left the pictures out (the folder went over the limit with them): they are no change on either side.
  const leftOut = mediaLeftOut(before) || mediaLeftOut(after);
  for (const [relative, digest] of after) {
    if (leftOut && MEDIA_FILE.test(relative)) continue;
    if (!before.has(relative)) added.push(relative);
    else if (before.get(relative) !== digest) modified.push(relative);
  }
  for (const relative of before.keys()) if (!after.has(relative) && !(leftOut && MEDIA_FILE.test(relative))) removed.push(relative);
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}
