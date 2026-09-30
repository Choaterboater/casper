import { lstat } from "node:fs/promises";
import path from "node:path";
import { findProjectCandidates, hasProjectSignals, type ProjectInfo } from "./inspect";
import { loadProjectModel, type ProjectModel } from "./model";

/**
 * A project folder inside the open folder: the AI built sample-tools inside ~/Documents, so Documents has no
 * checks but sample-tools does. Casper runs sample-tools' own checks for that task and offers to switch there.
 */
export interface ChildProject {
  dir: string;
  /** "sample-tools", relative to the open folder, with "/". */
  relative: string;
  model: ProjectModel;
}

async function isDirectory(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => undefined))?.isDirectory() ?? false;
}

/** Own project signs: a marker file (pyproject.toml, package.json, go.mod ...) or a tests folder. */
export async function looksLikeProject(dir: string): Promise<boolean> {
  return await hasProjectSignals(dir) || await isDirectory(path.join(dir, "tests")) || await isDirectory(path.join(dir, "test"));
}

async function childModel(dir: string, homeDir: string): Promise<ProjectModel> {
  const info: ProjectInfo = { cwd: dir, root: dir, name: path.basename(dir), gitBranch: null, isGit: await isDirectory(path.join(dir, ".git")) };
  return loadProjectModel(info, { homeDir });
}

/** The one child project that holds every changed path, the outermost when they nest; undefined when the paths are
 * spread out, sit in the open folder itself or in a hidden folder. */
export async function childProjectOf(root: string, changedPaths: readonly string[], homeDir: string): Promise<ChildProject | undefined> {
  if (!changedPaths.length) return undefined;
  const folders = changedPaths.map((file) => file.split(/[\\/]/).slice(0, -1));
  let common = folders[0]!;
  for (const folder of folders.slice(1)) {
    let same = 0;
    while (same < common.length && same < folder.length && common[same] === folder[same]) same++;
    common = common.slice(0, same);
  }
  if (!common.length || common[0]!.startsWith(".") || common.includes("..")) return undefined;
  for (let depth = 1; depth <= common.length; depth++) {
    const relative = common.slice(0, depth).join("/");
    const dir = path.join(root, ...common.slice(0, depth));
    if (await looksLikeProject(dir)) return { dir, relative, model: await childModel(dir, homeDir) };
  }
  return undefined;
}

/** Project folders under `root` that have a test command, nearest first, for /verify with nothing here. */
export async function childProjectsWithTests(root: string, homeDir: string, limit = 3): Promise<ChildProject[]> {
  const found: ChildProject[] = [];
  for (const dir of await findProjectCandidates(root, { homeDir })) {
    if (path.resolve(dir) === path.resolve(root)) continue;
    const model = await childModel(dir, homeDir).catch(() => undefined);
    if (!model?.commands.test?.trim()) continue;
    found.push({ dir, relative: path.relative(root, dir).split(path.sep).join("/"), model });
    if (found.length >= limit) break;
  }
  return found;
}
