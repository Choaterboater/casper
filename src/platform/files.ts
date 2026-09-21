import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

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

/** Read-only source open that never follows a final symlink or waits on a special file. */
export const openNoFollow = (filePath: string): Promise<FileHandle> =>
  openStateFile(filePath, constants.O_RDONLY, true);

/** Read/write open of an already-validated target with the same no-follow promise. */
export const openNoFollowUpdate = (filePath: string): Promise<FileHandle> =>
  openStateFile(filePath, constants.O_RDWR, true);

/** Read-only open for configuration that is allowed to be a symlink to a regular file. */
export const openFollowed = (filePath: string): Promise<FileHandle> =>
  openStateFile(filePath, constants.O_RDONLY, false);