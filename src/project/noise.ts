/** Folders that are never offered as "a project you worked in" or "a project found": temporary and cache folders,
 * installed packages, and benchmark or scratch runs. A saved conversation can name one of these (a test run, a
 * throwaway check), and listing it only buries the real projects. A folder the person types is never checked here. */

import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isOutside } from "../platform/inside";

export interface NoiseOptions {
  /** Defaults to this machine's platform; injected so Windows paths can be checked anywhere. */
  platform?: NodeJS.Platform;
  /** The temporary folders. Defaults to os.tmpdir() and its real path. */
  tmpDirs?: readonly string[];
  /** The home folder, which holds AppData (Windows) or the cache folders (macOS, Linux). Defaults to os.homedir(). */
  homeDir?: string;
}

/** Folders that hold throwaway work: an agent's scratchpad, and benchmark or test-run output (bench-runs, benchmark-runs, runs). */
const SCRATCH_NAME = /^(scratchpad$|bench(?:mark)?[-_]?runs?\b)/i;

function defaultTmpDirs(): string[] {
  const tmp = os.tmpdir();
  let real = tmp;
  try { real = realpathSync(tmp); } catch { /* no such folder: the path as given */ }
  return [...new Set([tmp, real])];
}

/** True when `dir` is `root` or inside it. */
function within(p: path.PlatformPath, root: string, dir: string, fold: (text: string) => string): boolean {
  const relative = p.relative(fold(p.resolve(root)), fold(p.resolve(dir)));
  // isOutside checks the host's notion of absolute; `p` also covers another drive on an injected Windows platform.
  return relative === "" || (!isOutside(relative) && !p.isAbsolute(relative));
}

/** Whether `dir` sits in a temp, cache, package or scratch place. */
export function isNoiseFolder(dir: string, options: NoiseOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const fold = (text: string) => windows ? text.toLowerCase() : text;
  const home = options.homeDir ?? os.homedir();
  const roots = [
    ...(options.tmpDirs ?? defaultTmpDirs()),
    ...(windows ? [p.join(home, "AppData")] : [p.join(home, "Library", "Caches"), p.join(home, ".cache")]),
  ];
  if (roots.some(root => within(p, root, dir, fold))) return true;
  return p.resolve(dir).split(/[\\/]+/).some(segment =>
    fold(segment) === "node_modules" || SCRATCH_NAME.test(segment));
}

/** A test for the folders to skip under `base`, or one that skips nothing when `base` is itself such a place: a
 * person who opened a scratch folder on purpose still sees the projects in it. */
export function noiseFilter(base: string, options: NoiseOptions = {}): (dir: string) => boolean {
  return isNoiseFolder(base, options) ? () => false : dir => isNoiseFolder(dir, options);
}
