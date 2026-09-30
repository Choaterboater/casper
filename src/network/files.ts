import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { readReferenceFile, referenceText } from "../references/files";

export const MAX_SCAN_BYTES = 256 * 1024;
export const MAX_FOLDER_FILES = 200;

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** The real path of a project file or folder. Links that lead out of the project, and missing paths, are errors. */
export async function resolveInside(root: string, relative: string): Promise<string> {
  const realRoot = await realpath(root);
  let real: string;
  try {
    real = await realpath(path.join(realRoot, relative));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${relative} is not there`);
    throw error;
  }
  if (!inside(realRoot, real)) throw new Error(`${relative} leads outside the project; Casper does not follow it`);
  return real;
}

/**
 * Expand declared files: a folder (written with or without a trailing "/")
 * becomes its regular files, one level deep, never through links.
 */
export async function expandFiles(root: string, entries: readonly string[]): Promise<{ relative: string; absolute: string }[]> {
  const files: { relative: string; absolute: string }[] = [];
  for (const entry of entries) {
    const absolute = await resolveInside(root, entry);
    const info = await lstat(absolute);
    if (info.isFile()) { files.push({ relative: entry.replace(/[\\/]+$/, ""), absolute }); continue; }
    if (!info.isDirectory()) throw new Error(`${entry} is not a file or a folder`);
    const names = (await readdir(absolute)).sort();
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const child = path.join(absolute, name);
      const childInfo = await lstat(child);
      if (!childInfo.isFile()) continue;
      files.push({ relative: path.posix.join(entry.replace(/[\\/]+$/, ""), name), absolute: child });
      if (files.length > MAX_FOLDER_FILES) throw new Error(`more than ${MAX_FOLDER_FILES} files to check; name them more narrowly`);
    }
  }
  return files;
}

/** Bounded UTF-8 read of a project file that never follows a final link. */
export async function readSmallText(absolute: string, maxBytes = MAX_SCAN_BYTES): Promise<string> {
  return referenceText(await readReferenceFile(absolute, maxBytes));
}
