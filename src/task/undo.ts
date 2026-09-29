/**
 * Undo for a task's file changes, at no token cost.
 *
 * Casper keeps its own copies in a separate git folder, ~/.casper/projects/<project>/undo.git, with one index per
 * work tree. It never reads or writes the project's own .git (its objects, index, hooks or config), and it works in
 * folders that are not git repositories. The design and git recipe are adapted from OpenCode's snapshots
 * (packages/opencode/src/snapshot/index.ts at 7945de2, MIT, Copyright (c) 2025 opencode): a separate --git-dir and
 * --work-tree, `add --all` then `write-tree`, a diff between two trees, and a per-file revert. The undo rules follow
 * Aider's (design only): only Casper's own changes, never a file changed since, newest first.
 *
 * What is never copied, so never undone: dependency trees, caches and build folders (the same list as the receipt's
 * change list), files git ignores, secret files (.env, keys, credentials; see secrets/files.ts), files over 8 MB,
 * and the contents of nested repositories. Files go back through the no-follow helpers: a link is never followed,
 * a folder is never removed with what is in it, and a file the task did not create is never deleted.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readlink, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openNoFollow, parentsStayInside, removeProjectFile, writeProjectFile, writeProjectLink } from "../platform/files";
import { isSecretFile } from "../secrets/files";
import { HASH_LIMIT, SKIPPED_DIRECTORIES, SNAPSHOT_FILE_LIMIT } from "./changes";

/** Each git call is bounded; a slow or stuck call makes undo unavailable, never the task wait. */
const GIT_TIMEOUT_MS = 30_000;
/** /diff shows at most this much. */
export const DIFF_LIMIT = 64 * 1024;
/** A file bigger than this is never read to compare it with a copy: it counts as changed. */
const COMPARE_LIMIT = 64 * 1024 * 1024;
/** Another Casper holding the lock this long has stopped: its lock is taken over. */
const STALE_LOCK_MS = 120_000;
const MODE_LINK = "120000";
const MODE_GITLINK = "160000";

/** A file left out of the copy, so undo can't put it back. */
export interface LeftOut {
  path: string;
  why: "secret" | "big" | "nested repo";
}

export type UndoSnapshot = { tree: string; left: LeftOut[] } | { unavailable: string };

export interface TreeEntry { mode: string; sha: string }

/** One file that differs between two copies: what it is in `from` and what it becomes in `to` (absent: no file). */
export interface UndoChange {
  path: string;
  from?: TreeEntry;
  to?: TreeEntry;
}

export interface UndoPlan {
  /** Files that still match `from` and can go to `to`. */
  ready: UndoChange[];
  /** Files changed since (they no longer match `from`): never touched. */
  changedSince: string[];
  /** Files Casper can't put back, with why (a nested repository). */
  blocked: Array<{ path: string; why: string }>;
}

export interface UndoApplied {
  restored: string[];
  skipped: Array<{ path: string; why: string }>;
}

/** The plain reason for "Undo not available: …". */
export function leftOutWhy(entry: LeftOut): string {
  return entry.why === "secret" ? "Casper keeps no copy of secret files" : entry.why === "big" ? "over 8 MB" : "a nested repository";
}

class GitError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

/** The git blob id of these bytes (SHA-1 object format, which the undo folder always uses). */
export function blobId(data: Buffer): string {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

export class UndoStore {
  readonly gitDir: string;
  private readonly index: string;
  private readonly excludes: string;
  private readonly root: string;
  private readonly fileLimit: number;

  constructor(options: { stateDirectory: string; root: string; fileLimit?: number }) {
    this.gitDir = path.join(options.stateDirectory, "undo.git");
    this.root = options.root;
    const id = createHash("sha256").update(options.root).digest("hex").slice(0, 16);
    this.index = path.join(this.gitDir, `index-${id}`);
    this.excludes = path.join(this.gitDir, `exclude-${id}`);
    this.fileLimit = options.fileLimit ?? SNAPSHOT_FILE_LIMIT;
  }

  /** A clean environment: no system or global git config, no inherited GIT_* variable (a GIT_DIR from a hook would
   * otherwise point every command at the user's repository), no prompts. */
  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) if (!/^GIT_/i.test(name)) env[name] = value;
    return { ...env, GIT_DIR: this.gitDir, GIT_WORK_TREE: this.root, GIT_INDEX_FILE: this.index, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  }

  private git(args: string[], options: { input?: string | Buffer; limit?: number; signal?: AbortSignal } = {}): Promise<{ stdout: Buffer; truncated: boolean }> {
    const argv = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.autocrlf=false", "-c", "core.symlinks=true",
      "-c", "core.longpaths=true", "-c", "core.quotepath=false", "-c", `core.excludesFile=${this.excludes}`, "-c", "gc.auto=0",
      "-c", "maintenance.auto=false", "-c", "core.safecrlf=false", ...args];
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn("git", argv, { cwd: this.root, env: this.env(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (error) { reject(new GitError((error as Error).message, (error as NodeJS.ErrnoException).code)); return; }
      const out: Buffer[] = [];
      let size = 0, truncated = false, stderr = "";
      const limit = options.limit ?? 256 * 1024 * 1024;
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new GitError("git took too long", "ETIMEDOUT")); }, GIT_TIMEOUT_MS);
      const abort = () => { child.kill("SIGKILL"); reject(new GitError("cancelled", "ABORT_ERR")); };
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (size >= limit) { truncated = true; return; }
        const room = limit - size;
        if (chunk.length > room) { truncated = true; chunk = chunk.subarray(0, room); }
        out.push(chunk); size += chunk.length;
      });
      child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
      child.on("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); reject(new GitError(error.message, error.code)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (code === 0) resolve({ stdout: Buffer.concat(out), truncated });
        else reject(new GitError(stderr.trim().split("\n").find(Boolean)?.replace(/^(?:fatal|error): /, "") ?? `git exited ${code}`));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(options.input ?? "");
    });
  }

  private async text(args: string[], options: { input?: string | Buffer } = {}): Promise<string> {
    return (await this.git(args, options)).stdout.toString("utf8");
  }

  /** Makes the private undo folder (0700) once. */
  private async init(): Promise<void> {
    await mkdir(path.dirname(this.gitDir), { recursive: true, mode: 0o700 });
    if (!(await stat(path.join(this.gitDir, "HEAD")).catch(() => undefined))) {
      await mkdir(this.gitDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      await this.git(["init", "-q", "--object-format=sha1"]);
    }
    await chmod(this.gitDir, 0o700).catch(() => {});
    await mkdir(path.join(this.gitDir, "info"), { recursive: true, mode: 0o700 });
    // The project's own .gitattributes may not convert line endings or run filters on the copies: the copy is the
    // file's exact bytes. (Git LFS files are kept as they are on disk.)
    await writeFile(path.join(this.gitDir, "info", "attributes"), "* -text -filter -ident -working-tree-encoding\n", { mode: 0o600 });
    const skipped = Object.keys(SKIPPED_DIRECTORIES).map((name) => `${name}/`);
    const venv = await lstat(path.join(this.root, "venv", "pyvenv.cfg")).catch(() => undefined) ? ["/venv/"] : [];
    await writeFile(this.excludes, [
      "# Casper undo: never copied (dependency trees, caches, build folders, Casper's own state)",
      ...skipped, "/.streamlit/cache/", ...venv, "", "# The project's .git/info/exclude, read only", await this.userExcludes(), "",
    ].join("\n"), { mode: 0o600 });
  }

  /** The project's own .git/info/exclude (read, never written), so a file the project ignores is never copied. */
  private async userExcludes(): Promise<string> {
    const dotGit = path.join(this.root, ".git");
    const read = async (file: string, limit = 256 * 1024): Promise<string> => {
      const handle = await openNoFollow(file).catch(() => undefined);
      if (!handle) return "";
      try { const info = await handle.stat(); return info.isFile() && info.size <= limit ? await handle.readFile("utf8") : ""; }
      finally { await handle.close(); }
    };
    let common = dotGit;
    const info = await lstat(dotGit).catch(() => undefined);
    if (info?.isFile()) {
      // A linked work tree: .git names its folder, whose commondir names the shared one.
      const named = /^gitdir:\s*(.+)$/m.exec(await read(dotGit, 4096))?.[1]?.trim();
      if (!named) return "";
      const gitdir = path.resolve(this.root, named);
      const commondir = (await read(path.join(gitdir, "commondir"), 4096)).trim();
      common = commondir ? path.resolve(gitdir, commondir) : gitdir;
    } else if (!info?.isDirectory()) return "";
    return read(path.join(common, "info", "exclude"));
  }

  /** One Casper at a time works on the undo folder's copies. */
  private async locked<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lock = path.join(this.gitDir, "undo.lock");
    const deadline = Date.now() + GIT_TIMEOUT_MS;
    for (;;) {
      signal?.throwIfAborted();
      try {
        const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        await handle.writeFile(String(process.pid)); await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const held = await lstat(lock).catch(() => undefined);
        if (held && Date.now() - held.mtimeMs > STALE_LOCK_MS) { await unlink(lock).catch(() => {}); continue; }
        if (Date.now() > deadline) throw new GitError("another Casper is saving a copy", "ELOCKED");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try { return await work(); } finally { await unlink(lock).catch(() => {}); }
  }

  /** A copy of the folder as it is now. Never throws: when no copy can be made, says why in plain words. */
  async snapshot(signal?: AbortSignal): Promise<UndoSnapshot> {
    try {
      await this.init();
      return await this.locked(async () => {
        const listed = (await this.git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { signal })).stdout
          .toString("utf8").split("\0").filter(Boolean);
        const unique = [...new Set(listed)];
        if (unique.length > this.fileLimit) return { unavailable: `this folder has more than ${this.fileLimit.toLocaleString("en-US")} files` };
        const left: LeftOut[] = [];
        for (let start = 0; start < unique.length; start += 64) {
          signal?.throwIfAborted();
          await Promise.all(unique.slice(start, start + 64).map(async (relative) => {
            if (relative.endsWith("/")) { left.push({ path: relative.slice(0, -1), why: "nested repo" }); return; }
            if (isSecretFile(relative)) {
              if (await lstat(path.join(this.root, relative)).catch(() => undefined)) left.push({ path: relative, why: "secret" });
              return;
            }
            const info = await lstat(path.join(this.root, relative)).catch(() => undefined);
            if (info?.isFile() && info.size > HASH_LIMIT) left.push({ path: relative, why: "big" });
          }));
        }
        left.sort((a, b) => a.path.localeCompare(b.path));
        // A file left out now may be in the index from an earlier copy (smaller then): drop it, so the copy never
        // holds an old version of it.
        if (left.length) {
          await this.git(["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"],
            { input: left.map((entry) => `:(literal)${entry.path}`).join("\0"), signal });
        }
        await this.git(["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"],
          { input: [".", ...left.map((entry) => `:(exclude,literal)${entry.path}`)].join("\0"), signal });
        const tree = (await this.text(["write-tree"])).trim();
        if (!/^[0-9a-f]{40}$/.test(tree)) throw new GitError("no copy was written");
        return { tree, left };
      }, signal);
    } catch (error) {
      return { unavailable: unavailableReason(error) };
    }
  }

  /** Keeps both copies of task `n` (a ref per copy, so git's clean-up never drops them). */
  async record(n: number, before: string, after: string): Promise<void> {
    await this.git(["update-ref", "--stdin"], { input: `update refs/casper/${n}/before ${before}\nupdate refs/casper/${n}/after ${after}\n` });
  }

  /** Keeps a copy made at another time for task `n` (the files just before an undo, for redo). */
  async keep(n: number, name: "redo", tree: string): Promise<void> {
    await this.git(["update-ref", `refs/casper/${n}/${name}`, tree]);
  }

  /** Stores a small text (a setting file's before/after) under task `n`; returns its id. */
  async storeText(n: number, name: string, text: string): Promise<string> {
    await this.init();
    const id = (await this.text(["hash-object", "-w", "--stdin", "--no-filters"], { input: text })).trim();
    await this.git(["update-ref", `refs/casper/${n}/${name}`, id]);
    return id;
  }

  async readBlob(id: string): Promise<Buffer> {
    if (!/^[0-9a-f]{40}$/.test(id)) throw new Error("not a copy id");
    return (await this.git(["cat-file", "blob", id])).stdout;
  }

  /** The files that differ between two copies. */
  async changes(from: string, to: string): Promise<UndoChange[]> {
    const raw = (await this.git(["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to])).stdout.toString("utf8").split("\0");
    const changes: UndoChange[] = [];
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) [A-Z]/.exec(raw[index]!);
      const file = raw[index + 1]!;
      if (!meta || !file) continue;
      const entry = (mode: string, sha: string): TreeEntry | undefined => mode === "000000" ? undefined : { mode, sha };
      changes.push({ path: file, from: entry(meta[1]!, meta[3]!), to: entry(meta[2]!, meta[4]!) });
    }
    return changes;
  }

  /** The patch (or `--stat`) between two copies, at most DIFF_LIMIT bytes. External diff and textconv programs of
   * the project never run. */
  async diff(from: string, to: string, options: { stat?: boolean; paths?: readonly string[] } = {}): Promise<string> {
    const paths = options.paths?.length ? ["--", ...options.paths.map((file) => `:(literal)${file}`)] : [];
    const { stdout, truncated } = await this.git(["diff-tree", "-r", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv",
      ...(options.stat ? ["--stat=100"] : ["-p"]), from, to, ...paths], { limit: DIFF_LIMIT });
    return `${stdout.toString("utf8")}${truncated ? "\n[diff cut at 64 KiB]\n" : ""}`;
  }

  /** What going from `from` to `to` would do now, file by file: which files still match `from` (ready), which changed
   * since, and which Casper can't put back. `only` limits it to these files. */
  async plan(from: string, to: string, only?: readonly string[]): Promise<UndoPlan> {
    const wanted = only ? new Set(only) : undefined;
    const plan: UndoPlan = { ready: [], changedSince: [], blocked: [] };
    for (const change of await this.changes(from, to)) {
      if (wanted && !wanted.has(change.path)) continue;
      if (change.from?.mode === MODE_GITLINK || change.to?.mode === MODE_GITLINK) { plan.blocked.push({ path: change.path, why: "a nested repository" }); continue; }
      if (sameEntry(await this.current(change.path), change.from)) plan.ready.push(change);
      else plan.changedSince.push(change.path);
    }
    return plan;
  }

  /** The file at `relative` now, as a copy entry; undefined when there is none inside the folder (a path under a
   * linked folder is somewhere else, so it is not here). */
  private async current(relative: string): Promise<TreeEntry | undefined> {
    if (!(await parentsStayInside(this.root, relative).catch(() => false))) return undefined;
    const file = path.join(this.root, relative);
    const info = await lstat(file).catch(() => undefined);
    if (!info) return undefined;
    if (info.isSymbolicLink()) return { mode: MODE_LINK, sha: blobId(Buffer.from(await readlink(file, { encoding: "buffer" }))) };
    if (info.isDirectory()) return { mode: "040000", sha: "folder" };
    if (!info.isFile() || info.size > COMPARE_LIMIT) return { mode: "100644", sha: "unreadable" };
    const handle = await openNoFollow(file).catch(() => undefined);
    if (!handle) return { mode: "100644", sha: "unreadable" };
    try { return { mode: info.mode & 0o111 ? "100755" : "100644", sha: blobId(await handle.readFile()) }; }
    finally { await handle.close(); }
  }

  /** Puts each ready file into its `to` state: removals first (deepest first, a link removed itself), then writes. A
   * folder is removed only when empty and absent from `to`. Never throws for one file: it is skipped with why. */
  async apply(changes: readonly UndoChange[], to: string, signal?: AbortSignal): Promise<UndoApplied> {
    return this.locked(async () => {
      const applied: UndoApplied = { restored: [], skipped: [] };
      const depth = (file: string) => file.split("/").length;
      const keptFolders = new Set((await this.text(["ls-tree", "-r", "-d", "-z", "--name-only", to])).split("\0").filter(Boolean));
      const skip = (file: string, error: unknown) => applied.skipped.push({ path: file, why: plainError(error) });
      for (const change of [...changes].filter((entry) => !entry.to).sort((a, b) => depth(b.path) - depth(a.path))) {
        signal?.throwIfAborted();
        try {
          await removeProjectFile(this.root, change.path);
          applied.restored.push(change.path);
          await this.removeEmptyFolders(change.path, keptFolders);
        } catch (error) { skip(change.path, error); }
      }
      for (const change of [...changes].filter((entry) => entry.to).sort((a, b) => depth(a.path) - depth(b.path))) {
        signal?.throwIfAborted();
        const target = change.to!;
        try {
          const data = await this.readBlob(target.sha);
          const now = await lstat(path.join(this.root, change.path)).catch(() => undefined);
          if (target.mode === MODE_LINK) {
            if (now) await removeProjectFile(this.root, change.path);
            await writeProjectLink(this.root, change.path, data.toString("utf8"));
          } else {
            if (now?.isSymbolicLink()) await removeProjectFile(this.root, change.path);
            const base = now?.isFile() ? now.mode & 0o777 : 0o644;
            const mode = target.mode === "100755" ? base | ((base & 0o444) >> 2) : base & ~0o111;
            await writeProjectFile(this.root, change.path, data, { mode: "replace", fileMode: mode, chmod: mode });
          }
          applied.restored.push(change.path);
        } catch (error) { skip(change.path, error); }
      }
      applied.restored.sort();
      return applied;
    }, signal);
  }

  /** Folders the removed file leaves empty, that `to` does not have, are removed one at a time (never a link). */
  private async removeEmptyFolders(file: string, kept: ReadonlySet<string>): Promise<void> {
    const parts = file.split("/").slice(0, -1);
    while (parts.length) {
      const folder = parts.join("/");
      if (kept.has(folder) || !(await parentsStayInside(this.root, `${folder}/x`).catch(() => false))) return;
      const info = await lstat(path.join(this.root, folder)).catch(() => undefined);
      if (!info?.isDirectory() || info.isSymbolicLink()) return;
      try { await rmdir(path.join(this.root, folder)); } catch { return; }
      parts.pop();
    }
  }

  /** Drops the copies of all but the newest `keep` tasks; every 20th task, git's clean-up runs too. */
  async prune(keep = 100, newest?: number): Promise<void> {
    const refs = (await this.text(["for-each-ref", "--format=%(refname)", "refs/casper/"])).split("\n").filter(Boolean)
      .map((ref) => ({ ref, n: Number(/^refs\/casper\/(\d+)\//.exec(ref)?.[1] ?? NaN) })).filter((entry) => Number.isFinite(entry.n));
    const top = newest ?? Math.max(0, ...refs.map((entry) => entry.n));
    const old = refs.filter((entry) => entry.n <= top - keep).map((entry) => entry.ref);
    if (old.length) await this.git(["update-ref", "--stdin"], { input: old.map((ref) => `delete ${ref}\n`).join("") });
    if (old.length && top % 20 === 0) await this.git(["gc", "--quiet", "--prune=1.hour.ago"]).catch(() => {});
  }

  /** How much disk the copies take, in bytes (for /status). */
  async size(): Promise<number | undefined> {
    try {
      const out = await this.text(["count-objects", "-v"]);
      const kib = (name: string) => Number(new RegExp(`^${name}: (\\d+)$`, "m").exec(out)?.[1] ?? 0);
      return (kib("size") + kib("size-pack")) * 1024;
    } catch { return undefined; }
  }
}

function sameEntry(now: TreeEntry | undefined, copy: TreeEntry | undefined): boolean {
  if (!now || !copy) return !now && !copy;
  return now.sha === copy.sha && (now.mode === MODE_LINK) === (copy.mode === MODE_LINK);
}

function plainError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);
}

function unavailableReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "git is not installed";
  if (code === "ABORT_ERR" || (error as Error | undefined)?.name === "AbortError") return "the task was stopped before a copy was saved";
  if (code === "ETIMEDOUT") return "Casper could not save a copy (it took too long)";
  return `Casper could not save a copy (${plainError(error)})`;
}
