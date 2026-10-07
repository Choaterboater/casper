import { constants } from "node:fs";
import { lstat, mkdir, open, symlink, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

/**
 * Windows omits O_NOFOLLOW and O_NONBLOCK, so those flags degrade to 0 there and
 * the no-follow callers add an explicit final-symlink rejection instead. That
 * check is a pre-open observation, not the atomic POSIX guarantee.
 */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;

async function openStateFile(filePath: string, access: number, noFollow: boolean): Promise<FileHandle> {
  if (noFollow && !NO_FOLLOW && (await lstat(filePath)).isSymbolicLink()) throw new Error("Final symlinks are not read as files");
  return open(filePath, access | (noFollow ? NO_FOLLOW : 0) | NONBLOCK);
}

/** True when a failed lock-folder (or lock-file) create means "someone else has it, try again". On Windows, creating
 * a name that another process is deleting fails with EPERM, EACCES or EBUSY instead of EEXIST; elsewhere those
 * codes are real permission problems and must not be retried. */
export function lockBusy(error: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EEXIST") return true;
  return platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
}

/** Read-only source open that never follows a final symlink or waits on a special file. */
export const openNoFollow = (filePath: string): Promise<FileHandle> =>
  openStateFile(filePath, constants.O_RDONLY, true);

/** Read/write open of an already-validated target with the same no-follow promise. */
export const openNoFollowUpdate = (filePath: string): Promise<FileHandle> =>
  openStateFile(filePath, constants.O_RDWR, true);

/** Read-only open for configuration that is allowed to be a symlink to a regular file. */
export const openFollowed = (filePath: string): Promise<FileHandle> =>
  openStateFile(filePath, constants.O_RDONLY, false);
/**
 * Whether every folder between `root` and `root/relative` is a real directory inside `root`, never a
 * symlink. A path under a linked folder resolves somewhere else, so creating, copying or removing it
 * would act outside the tree. A missing folder counts as safe: mkdir creates it as a real directory.
 */
export async function parentsStayInside(root: string, relative: string): Promise<boolean> {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || parts.some((part) => part === "..") || path.isAbsolute(relative)) return false;
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stats = await lstat(current).catch(() => undefined);
    if (!stats) return true;
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  }
  return true;
}

/**
 * The shared no-follow file helpers for work inside a project folder (a new project's files, undo restoring
 * files, security findings, the file guard). Every part of the path below `root` must be a real folder, never
 * a link; the file itself is never followed; a FIFO or device never blocks. `relative` uses / or \\ and may
 * not climb out with "..".
 */

function projectPath(root: string, relative: string): string {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (!parts.length || path.isAbsolute(relative) || parts.includes("..") || relative.includes("\0")) throw new Error(`${relative} is not a path inside the project`);
  return path.join(root, ...parts);
}

async function checkParents(root: string, relative: string): Promise<void> {
  if (!(await parentsStayInside(root, relative))) throw new Error(`${relative} goes through a link or a file; Casper won't follow it`);
}

/** A project file's text, or undefined when it is not there. A link, a folder, a special file or one over
 * `maxBytes` is an error: Casper never reads through a link. */
export async function readProjectText(root: string, relative: string, maxBytes: number): Promise<string | undefined> {
  const file = projectPath(root, relative);
  await checkParents(root, relative);
  let handle: FileHandle;
  try { handle = await openNoFollow(file); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP" || code === "EMLINK" || /symlink/i.test((error as Error).message)) throw new Error(`${relative} is a link; Casper won't read through it`);
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${relative} isn't a regular file`);
    if (info.size > maxBytes) throw new Error(`${relative} is over ${maxBytes} bytes`);
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`${relative} is over ${maxBytes} bytes`);
    return text;
  } finally { await handle.close(); }
}

export type ProjectWriteMode =
  /** Only a new file: an existing one is kept ("kept"). */
  | "create"
  /** Create or overwrite. */
  | "replace"
  /** Add to the end, creating the file when missing. */
  | "append";

/** Write a project file without following links: missing folders are made as real folders; an existing link, or
 * a folder or special file in its place, is refused. */
export async function writeProjectFile(root: string, relative: string, data: string | Uint8Array,
  options: { mode: ProjectWriteMode; fileMode?: number; /** Set these permission bits after writing (undo's exec bit). */ chmod?: number }): Promise<"written" | "kept"> {
  const file = projectPath(root, relative);
  await checkParents(root, relative);
  await makeFolders(root, relative, file);
  const existing = await lstat(file).catch(() => undefined);
  if (existing?.isSymbolicLink()) throw new Error(`${relative} is a link; Casper won't write through it`);
  if (existing && !existing.isFile()) throw new Error(`${relative} exists and isn't a file`);
  // No O_TRUNC here: a file with a second name (a hard link) may be someone else's file, and truncating on open
  // would empty it before Casper could look.
  const base = constants.O_WRONLY | NO_FOLLOW | NONBLOCK;
  const flags = base | (options.mode === "append" ? constants.O_APPEND | constants.O_CREAT
    : options.mode === "replace" ? constants.O_CREAT : constants.O_CREAT | constants.O_EXCL);
  const openFile = async (how: number): Promise<FileHandle | "kept"> => {
    try { return await open(file, how, options.fileMode ?? 0o644); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" && options.mode === "create") return "kept";
      if (code === "ELOOP" || code === "EMLINK") throw new Error(`${relative} is a link; Casper won't write through it`);
      throw error;
    }
  };
  let handle = await openFile(flags);
  if (handle === "kept") return "kept";
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${relative} isn't a regular file`);
    if (info.nlink > 1) {
      // A hard link shares its content with a file that may be outside the project (~/.bashrc): never write into it.
      if (options.mode === "append") throw new Error(`${relative} is a hard link to another file; Casper won't write through it`);
      // Replace puts a new file under this name and leaves the other name's content alone.
      await handle.close();
      await unlink(file);
      const fresh = await openFile(base | constants.O_CREAT | constants.O_EXCL);
      if (fresh === "kept") throw new Error(`${relative} changed while Casper was writing it`);
      handle = fresh;
    } else if (options.mode === "replace") await handle.truncate(0);
    await handle.writeFile(data);
    if (options.chmod !== undefined) await handle.chmod(options.chmod);
  } finally { await handle.close().catch(() => {}); }
  return "written";
}

/** Make each missing folder above `file` one at a time and check it is still a real folder, never a link. */
async function makeFolders(root: string, relative: string, file: string): Promise<void> {
  const parts = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    await mkdir(current).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${relative} goes through a link or a file; Casper won't follow it`);
  }
}

/** Make a symbolic link inside the project (undo putting a link back). The link is made, never followed; its folders
 * are real folders; anything already at the path is refused (remove it first). */
export async function writeProjectLink(root: string, relative: string, target: string): Promise<void> {
  const file = projectPath(root, relative);
  await checkParents(root, relative);
  await makeFolders(root, relative, file);
  if (await lstat(file).catch(() => undefined)) throw new Error(`${relative} is already there`);
  await symlink(target, file);
}

/** Remove a project file: a link is removed itself, never what it points to; a folder is refused. Missing is fine. */
export async function removeProjectFile(root: string, relative: string): Promise<"removed" | "missing"> {
  const file = projectPath(root, relative);
  await checkParents(root, relative);
  const info = await lstat(file).catch(() => undefined);
  if (!info) return "missing";
  if (info.isDirectory()) throw new Error(`${relative} is a folder; Casper removes files only`);
  await unlink(file);
  return "removed";
}
