/**
 * Folders and repositories outside the project that a task's commands worked in. The sandbox records only the places
 * you allowed the AI's edit and write tools; with no sandbox, or once you said yes to everything, a `cd ../other &&
 * python fix.py` changed another repository and the receipt said nothing. Before the first command (or outside edit)
 * that names such a place, Casper notes its state: a git repository's HEAD and the files git shows as changed, or a
 * small folder's files. At the receipt it compares again. Casper only reads, and only places the commands named
 * (their folder, `cd`, `git -C`, and paths in a repository); undo never reaches them.
 */
import { execFile } from "node:child_process";
import { lstat, readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { leavesLocalFilesAlone } from "../flows/plan";
import { isOutside } from "../platform/inside";
import { safeGitArgs } from "../platform/git";
import { realpathLongest } from "../platform/project-paths";
import { splitShell } from "../sandbox/remote";
import { diffSnapshots, snapshotTree } from "./changes";

const exec = promisify(execFile);
/** A folder that isn't a repository is compared only when it is this small. */
export const OUTSIDE_FOLDER_LIMIT = 2_000;
/** Places noted per task; a command that names more is not followed further. */
const PLACES_LIMIT = 16;
/** Changed files git may list for one repository before Casper stops hashing them. */
const DIRTY_LIMIT = 2_000;
const GIT_TIMEOUT_MS = 5_000;

/** One place outside the project the task changed, or may have. */
export interface OutsideChange {
  /** The folder as a person would type it: ~/Documents/sensor-lib. */
  place: string;
  /** The folder itself, for "Switch there". */
  dir: string;
  repository: boolean;
  /** Changed files, relative to `place` with `/`. */
  files: string[];
  /** Commits made on its branch during the task, short ids, newest first. */
  commits?: string[];
  /** Casper couldn't compare it (too many files, git failed): it may have changed. */
  unknown?: string;
  /** The AI ran a test runner there itself: its result is not Casper's check. */
  testsRun?: true;
}

/** A command that runs a project's tests: the AI's own run, never counted as Casper's check. */
const TEST_RUNNER = /\b(?:pytest|python3?\s+-m\s+(?:pytest|unittest)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|go\s+test|cargo\s+test|make\s+test|tox|nox)\b/;

type RepoState = { head: string | null; dirty: Map<string, string> } | { unknown: string };
type Place = ({ dir: string; repository: true; start: Promise<RepoState> } | { dir: string; repository: false; start: Promise<Map<string, string> | { unknown: string }> }) & { tests?: true };

async function git(dir: string, args: string[], input?: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
  const child = exec("git", safeGitArgs(args), { cwd: dir, env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (input !== undefined) { child.child.stdin?.end(input); }
  return (await child).stdout;
}

async function repoState(dir: string): Promise<RepoState> {
  try {
    const head = (await git(dir, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "")).trim() || null;
    const status = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
    const paths = status.split("\0").filter(Boolean).map((entry) => entry.slice(3));
    if (paths.length > DIRTY_LIMIT) return { unknown: `over ${DIRTY_LIMIT.toLocaleString("en-US")} changed files` };
    const dirty = new Map<string, string>();
    const present: string[] = [];
    for (const file of paths) {
      const stats = await lstat(path.join(dir, file)).catch(() => undefined);
      // A link is what it points to (git can't hash a link to a folder); only regular files go to git.
      if (stats?.isSymbolicLink()) dirty.set(file, `link:${await readlink(path.join(dir, file)).catch(() => "")}`);
      else if (stats?.isFile()) present.push(file);
      else dirty.set(file, stats ? "other" : "deleted");
    }
    if (present.length) {
      const hashes = (await git(dir, ["hash-object", "--stdin-paths"], `${present.join("\n")}\n`)).split("\n").filter(Boolean);
      present.forEach((file, index) => dirty.set(file, hashes[index] ?? "unknown"));
    }
    return { head, dirty };
  } catch { return { unknown: "git could not read it" }; }
}

async function folderState(dir: string): Promise<Map<string, string> | { unknown: string }> {
  try { return await snapshotTree(dir, undefined, { fileLimit: OUTSIDE_FOLDER_LIMIT, git: false }); }
  catch { return { unknown: "too many files to compare" }; }
}

/** The repository's top folder, or undefined when `dir` is not in one. */
async function repositoryOf(dir: string): Promise<string | undefined> {
  const top = (await git(dir, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  return top ? realpathLongest(path.resolve(top)) : undefined;
}

/** The nearest folder that exists at or above `target`. */
async function existingFolder(target: string): Promise<string | undefined> {
  for (let dir = target; ; dir = path.dirname(dir)) {
    const stats = await lstat(dir).catch(() => undefined);
    if (stats?.isDirectory()) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The folders a command works in, as it names them: the folder it starts in, each `cd` or `pushd`, and `git -C`. The
 * paths it names (absolute or ~/) count only inside a repository. */
export function commandPlaces(command: string, cwd: string, home: string, platform: NodeJS.Platform = process.platform): { folders: string[]; paths: string[] } {
  const folders = [cwd];
  const paths: string[] = [];
  const system = platform === "win32" ? path.win32 : path;
  // Git Bash on Windows writes C:\Users as /c/Users.
  const native = (word: string) => platform === "win32" ? word.replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`) : word;
  const resolve = (word: string, from: string) => system.resolve(from, word === "~" ? home : word.startsWith("~/") ? system.join(home, word.slice(2)) : native(word));
  let here = cwd;
  for (const { words } of splitShell(command).segments) {
    const [name, ...args] = words;
    if ((name === "cd" || name === "pushd") && args[0] && !args[0].startsWith("-") && !args[0].includes("$")) {
      here = resolve(args[0], here);
      folders.push(here);
    }
    if (name === "git") {
      const at = args.indexOf("-C");
      if (at >= 0 && args[at + 1] && !args[at + 1]!.includes("$")) folders.push(resolve(args[at + 1]!, here));
    }
    if (name === "cd" || name === "pushd") continue;
    for (const word of args) {
      const bare = word.replace(/^[^=]*=(?=[~/])/, "");
      if ((bare.startsWith("/") || bare.startsWith("~/")) && !bare.includes("$")) paths.push(resolve(bare, here));
    }
  }
  return { folders: [...new Set(folders)], paths: [...new Set(paths)] };
}

export class OutsideWork {
  private readonly places = new Map<string, Place>();
  /** Each folder's repository, looked up once a task: a command that works there again waits for nothing. */
  private readonly repositories = new Map<string, Promise<string | undefined>>();
  private readonly root: string;
  private readonly skip: string[];

  private readonly home: string;

  constructor(root: string, home: string, temp: readonly string[] = [os.tmpdir()]) {
    this.root = realpathLongest(path.resolve(root));
    this.home = realpathLongest(path.resolve(home));
    this.skip = temp.map((dir) => realpathLongest(path.resolve(dir)));
  }

  /** Before one of the AI's shell commands runs: notes the places it names outside the project, once each. */
  async before(command: string, cwd: string): Promise<void> {
    if (leavesLocalFilesAlone(command, this.home)) return;
    const { folders, paths } = commandPlaces(command, cwd, this.home);
    const noted = await Promise.all([...folders.map((dir) => this.note(dir, true)), ...paths.map((file) => this.note(file, false))]);
    if (TEST_RUNNER.test(command)) for (const place of noted.slice(0, folders.length)) if (place) place.tests = true;
  }

  /** Before the AI's edit or write tool changes `absolute`, outside the project. */
  async beforeWrite(absolute: string): Promise<void> { await this.note(absolute, false); }

  private outside(dir: string): boolean {
    const inside = (parent: string, child: string) => { const relative = path.relative(parent, child); return !relative || !isOutside(relative); };
    // Inside the project, holding the project (Documents for a project in it), the home folder or a temp folder: not followed.
    return !inside(this.root, dir) && !inside(dir, this.root) && !inside(dir, this.home)
      && (inside(this.home, dir) || !this.skip.some((temp) => inside(temp, dir)));
  }

  /** The place `target` is in, noted the first time; undefined when Casper doesn't follow it. */
  private async note(target: string, folder: boolean): Promise<Place | undefined> {
    const existing = await existingFolder(realpathLongest(path.resolve(target)));
    if (!existing || !this.outside(existing)) return undefined;
    let lookup = this.repositories.get(existing);
    if (!lookup) this.repositories.set(existing, lookup = repositoryOf(existing));
    const repository = await lookup;
    if (repository) {
      if (!this.outside(repository)) return undefined;
      const known = this.places.get(repository);
      if (known) { await known.start; return known; }
      if (this.places.size >= PLACES_LIMIT) return undefined;
      const place: Place = { dir: repository, repository: true, start: repoState(repository) };
      this.places.set(repository, place);
      await place.start;
      return place;
    }
    // A folder outside any repository is followed only where a command works in it, never for a path it names.
    const known = this.places.get(existing);
    if (known) { await known.start; return known; }
    if (!folder || this.places.size >= PLACES_LIMIT) return undefined;
    const place: Place = { dir: existing, repository: false, start: folderState(existing) };
    this.places.set(existing, place);
    await place.start;
    return place;
  }

  /** What changed in each place since it was noted. Places with no change are left out. */
  async finish(): Promise<OutsideChange[]> {
    const changes: OutsideChange[] = [];
    for (const place of this.places.values()) {
      const shown = tilde(place.dir, this.home);
      const base = { place: shown, dir: place.dir, ...(place.tests ? { testsRun: true as const } : {}) };
      if (place.repository) {
        const before = await place.start;
        if ("unknown" in before) { changes.push({ ...base, repository: true, files: [], unknown: before.unknown }); continue; }
        const after = await repoState(place.dir);
        if ("unknown" in after) { changes.push({ ...base, repository: true, files: [], unknown: after.unknown }); continue; }
        const files = new Set<string>();
        let commits: string[] = [];
        if (after.head && after.head !== before.head) {
          const range = before.head ? `${before.head}..${after.head}` : after.head;
          commits = (await git(place.dir, ["rev-list", "--abbrev-commit", "--max-count=20", range]).catch(() => "")).split("\n").filter(Boolean);
          const named = before.head ? await git(place.dir, ["diff", "--name-only", "-z", before.head, after.head]).catch(() => "")
            : await git(place.dir, ["ls-tree", "-r", "--name-only", "-z", after.head]).catch(() => "");
          for (const file of named.split("\0").filter(Boolean)) files.add(file);
        }
        for (const [file, hash] of after.dirty) if (before.dirty.get(file) !== hash) files.add(file);
        for (const file of before.dirty.keys()) if (!after.dirty.has(file)) files.add(file);
        if (files.size || commits.length) changes.push({ ...base, repository: true, files: [...files].sort(), ...(commits.length ? { commits } : {}) });
        continue;
      }
      const before = await place.start;
      if ("unknown" in before) continue;
      const after = await folderState(place.dir);
      if ("unknown" in after) { changes.push({ ...base, repository: false, files: [], unknown: after.unknown }); continue; }
      const diff = diffSnapshots(before, after);
      const files = [...diff.added, ...diff.modified, ...diff.removed].sort();
      if (files.length) changes.push({ ...base, repository: false, files });
    }
    return changes.sort((a, b) => a.place.localeCompare(b.place));
  }
}

function tilde(dir: string, home: string): string {
  const relative = path.relative(home, dir);
  return relative && !isOutside(relative) ? `~/${relative.split(path.sep).join("/")}` : dir;
}
