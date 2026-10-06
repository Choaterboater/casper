import { lstat, rmdir, symlink, unlink } from "node:fs/promises";
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

/** Takes the links out again (before the copy's changes are read), never a real folder a builder made. */
export async function unlinkDependencies(copy: string): Promise<void> {
  for (const name of DEPENDENCY_FOLDERS) {
    const file = path.join(copy, name);
    // A Windows junction comes out with rmdir (never what it points to).
    if (await kind(file) === "link") await unlink(file).catch(() => rmdir(file)).catch(() => {});
  }
}
