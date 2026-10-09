import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Dirent } from "node:fs";
import { safeGitArgs } from "../platform/git";
import { PROJECT_SIGNAL_NAMES } from "./model";
import { noiseFilter, type NoiseOptions } from "./noise";

const execFileAsync = promisify(execFile);

export interface ProjectInfo {
  cwd: string;
  root: string;
  name: string;
  gitBranch: string | null;
  isGit: boolean;
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", safeGitArgs(args), { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function inspectProject(cwd: string): Promise<ProjectInfo> {
  const resolvedCwd = path.resolve(cwd);
  const gitRoot = await git(["rev-parse", "--show-toplevel"], resolvedCwd);
  // Git prints C:/... on Windows; keep the root in the same form as every other path.
  const root = gitRoot ? path.resolve(gitRoot) : resolvedCwd;
  const gitBranch = gitRoot ? await git(["branch", "--show-current"], root) : null;

  return {
    cwd: resolvedCwd,
    root,
    name: folderName(root),
    gitBranch,
    isGit: Boolean(gitRoot),
  };
}

/** The folder's name as the banner, footer and title show it, never empty: "~" for the home folder, and the root
 * itself ("C:\\", "/") for the top of a drive. */
export function folderName(root: string, home = os.homedir()): string {
  const resolved = path.resolve(root);
  if (home && resolved === path.resolve(home)) return "~";
  return path.basename(resolved) || resolved;
}

/** True when the directory carries a project marker (git or any recognized project file). */
export async function hasProjectSignals(dir: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }
  return entries.includes(".git") || entries.some(name => PROJECT_SIGNAL_NAMES.has(name));
}

const CANDIDATE_SKIP = new Set([
  "node_modules", "Library", "Applications", "Pictures", "Movies", "Music", "Public", "Desktop",
  ".Trash", ".cache", ".bun", ".cargo", ".deno", ".docker", ".npm", ".rustup", ".local", ".config",
]);
const CANDIDATE_SCAN_BUDGET = 4000;
const CANDIDATE_CAP = 8;
/** Home subfolders people keep repositories in; from home each is searched one level down. */
const CODE_CONTAINERS = new Set(["code", "projects", "src", "dev", "repos", "workspace"]);

/** Shallow scan for openable projects: directories (up to two levels below `from`, skipping
 * hidden and heavyweight dirs) that carry a project marker themselves or one level below.
 * From home: ~/Documents, then the common code folders (~/code, ~/Projects, …), then direct
 * children of home. Bounded so a launch from the home folder stays fast. */
export async function findProjectCandidates(cwd: string, options: { homeDir?: string; limit?: number; noise?: NoiseOptions } = {}): Promise<string[]> {
  const limit = options.limit ?? CANDIDATE_CAP;
  const homeDir = options.homeDir ?? os.homedir();
  const found: string[] = [];
  const skip = noiseFilter(cwd, { homeDir, ...options.noise });
  let budget = CANDIDATE_SCAN_BUDGET;
  async function probe(dir: string, depth: number): Promise<void> {
    if (budget <= 0 || found.length >= limit) return;
    budget -= 1;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget <= 0 || found.length >= limit) return;
      if (!entry.isDirectory() || entry.name.startsWith(".") || CANDIDATE_SKIP.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (skip(child)) continue;
      let childEntries: string[] | undefined;
      try {
        childEntries = await readdir(child);
      } catch {
        continue;
      }
      budget -= 1;
      if (childEntries.includes(".git") || childEntries.some(name => PROJECT_SIGNAL_NAMES.has(name))) {
        found.push(child);
        continue;
      }
      if (depth < 1) await probe(child, depth + 1);
    }
  }
  await probe(cwd === homeDir ? path.join(homeDir, "Documents") : cwd, 0);
  if (cwd === homeDir) {
    // Case-insensitive match on the real names, so ~/Projects and ~/projects are one folder.
    const containers = await readdir(homeDir, { withFileTypes: true })
      .then(entries => entries.filter(entry => entry.isDirectory() && CODE_CONTAINERS.has(entry.name.toLowerCase())), () => []);
    for (const container of containers) if (found.length < limit && budget > 0) await probe(path.join(homeDir, container.name), 1);
    if (found.length < limit && budget > 0) await probe(homeDir, 1);
  }
  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}
