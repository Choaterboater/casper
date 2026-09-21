import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

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
