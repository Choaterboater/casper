import { lstat, readlink, realpath, rmdir, symlink, unlink } from "node:fs/promises";
import path from "node:path";

/**
 * A crew copy has no installed dependencies (git does not track them). Casper links your folder's own into each
 * copy instead of installing: fast, no cost, no clashes. Builders are told not to install; the sandbox keeps their
 * writes in the copy, so the linked folders are read-only to them in practice.
 */
export const DEPENDENCY_FOLDERS: readonly string[] = ["node_modules", ".venv", "vendor"];

async function kind(file: string): Promise<"folder" | "link" | "other" | undefined> {
  try {
    const stats = await lstat(file);
    return stats.isSymbolicLink() ? "link" : stats.isDirectory() ? "folder" : "other";
  } catch { return undefined; }
}

/** The dependency folders your folder has (real folders, not links), in DEPENDENCY_FOLDERS order. */
export async function dependencyFoldersIn(main: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of DEPENDENCY_FOLDERS) if (await kind(path.join(main, name)) === "folder") found.push(name);
  return found;
}

/** Links each dependency folder your folder has and the copy lacks (a tracked vendor/ is already there). */
export async function linkDependencies(main: string, copy: string): Promise<string[]> {
  const linked: string[] = [];
  for (const name of DEPENDENCY_FOLDERS) {
    if (await kind(path.join(main, name)) !== "folder" || await kind(path.join(copy, name)) !== undefined) continue;
    try {
      // A junction on Windows needs no developer mode.
      await symlink(path.join(main, name), path.join(copy, name), process.platform === "win32" ? "junction" : "dir");
      linked.push(name);
    } catch { /* the builder says so if it needs it */ }
  }
  return linked;
}

/** Whether the link at `file` points at `target` (a Windows junction may read back with a `\\?\` start). */
async function pointsAt(file: string, target: string): Promise<boolean> {
  const plain = (value: string) => {
    const resolved = path.resolve(path.dirname(file), value.replace(/^\\\\\?\\/, "")).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  try { if (plain(await readlink(file)) === plain(target)) return true; } catch { return false; }
  try { return await realpath(file) === await realpath(target); } catch { return false; }
}

/** Takes the links out again (before the copy's changes are read), never a real folder a builder made. With `main`,
 * only the links that point at its folders: a link the repository itself tracks (`vendor -> third`) stays. */
export async function unlinkDependencies(copy: string, main?: string): Promise<void> {
  for (const name of DEPENDENCY_FOLDERS) {
    const file = path.join(copy, name);
    if (await kind(file) !== "link" || (main !== undefined && !await pointsAt(file, path.join(main, name)))) continue;
    // A Windows junction comes out with rmdir (never what it points to).
    await unlink(file).catch(() => rmdir(file)).catch(() => {});
  }
}
