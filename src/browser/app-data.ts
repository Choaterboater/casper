import { lstat, mkdir, opendir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appDataFile } from "../services/app-data";
import { PROJECT_SCOPE } from "./scenario";

/**
 * The app's own data files (data.json, SQLite with its -wal/-shm, logs) as they were at one moment. An end replay
 * puts back the data its check was recorded with, so checks written as a chain (each expecting the totals the
 * last one left) replay on the data they saw, and after all replays the data as the AI left it comes back.
 * A file that was absent is kept as absent: restoring removes it. Bounded: a project with more or bigger data
 * files than this has no snapshot, and its replays run on the data as it is.
 */
export interface AppData { readonly files: ReadonlyMap<string, Buffer> }

const MAX_FILES = 32;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const SKIPPED = new Set([...(PROJECT_SCOPE.exclude ?? []), ".casper"]);

export async function snapshotAppData(root: string, signal?: AbortSignal): Promise<AppData | undefined> {
  const files = new Map<string, Buffer>();
  let total = 0, entries = 0;
  const visit = async (relative: string): Promise<boolean> => {
    for await (const entry of await opendir(path.join(root, relative))) {
      signal?.throwIfAborted();
      if (++entries > MAX_ENTRIES) return false;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!relative && SKIPPED.has(entry.name)) continue;
        if (!await visit(child)) return false;
      } else if (entry.isFile() && appDataFile(child)) {
        const size = (await lstat(path.join(root, child))).size;
        total += size;
        if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || files.size >= MAX_FILES) return false;
        files.set(child, await readFile(path.join(root, child)));
      }
    }
    return true;
  };
  try { return await visit("") ? { files } : undefined; }
  catch (error) { signal?.throwIfAborted(); return undefined; }
}

/** Whether the data now differs from the snapshot: only then is it restored and the app restarted. */
export function sameAppData(a: AppData, b: AppData): boolean {
  if (a.files.size !== b.files.size) return false;
  for (const [file, bytes] of a.files) if (!b.files.get(file)?.equals(bytes)) return false;
  return true;
}

/** Puts the snapshot back: its files as they were, and data files made since removed. */
export async function restoreAppData(root: string, wanted: AppData, now: AppData): Promise<void> {
  for (const file of now.files.keys()) if (!wanted.files.has(file)) await rm(path.join(root, file), { force: true });
  for (const [file, bytes] of wanted.files) {
    if (now.files.get(file)?.equals(bytes)) continue;
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), bytes);
  }
}
