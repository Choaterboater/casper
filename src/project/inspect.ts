import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Dirent } from "node:fs";
import { PROJECT_SIGNAL_NAMES } from "./model";

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
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function inspectProject(cwd: string): Promise<ProjectInfo> {
  const resolvedCwd = path.resolve(cwd);
  const gitRoot = await git(["rev-parse", "--show-toplevel"], resolvedCwd);
  const root = gitRoot ?? resolvedCwd;
  const gitBranch = gitRoot ? await git(["branch", "--show-current"], root) : null;

  return {
    cwd: resolvedCwd,
    root,
    name: path.basename(root),
    gitBranch,
    isGit: Boolean(gitRoot),
  };
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

/** Shallow scan for openable projects: directories (up to two levels below `from`, skipping
 * hidden and heavyweight dirs) that carry a project marker themselves or one level below.
 * Bounded so a launch from the home folder stays fast. */
export async function findProjectCandidates(cwd: string, options: { homeDir?: string; limit?: number } = {}): Promise<string[]> {
  const limit = options.limit ?? CANDIDATE_CAP;
  const homeDir = options.homeDir ?? os.homedir();
  const found: string[] = [];
  let budget = 4000;
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
  if (cwd === homeDir && found.length < limit && budget > 0) await probe(homeDir, 1);
  return found.sort((a, b) => a.localeCompare(b));
}
