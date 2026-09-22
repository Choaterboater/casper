import { createHash } from "node:crypto";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { openNoFollow } from "../platform/files";

/** Never descended: VCS internals, dependency trees and Casper's own state. */
const SKIPPED_DIRECTORIES: Record<string, true> = { ".git": true, node_modules: true, ".casper": true };
/** Removed between listing and inspection: absent from this snapshot, like any other missing path. */
const VANISHED: Record<string, true> = { ENOENT: true, ENOTDIR: true };
/** Beyond this a file is identified by size and mtime; hashing it would stall the receipt. */
const HASH_LIMIT = 8 * 1024 * 1024;
/** A tree larger than this reports "unknown" rather than making the user wait. */
export const SNAPSHOT_FILE_LIMIT = 20_000;
const CHUNK = 64 * 1024;
/** Open handles per directory batch; one read buffer each. */
const CONCURRENCY = 16;

export interface TreeChanges {
  added: string[];
  modified: string[];
  removed: string[];
}

/** Relative path → content identity. Symlinks are never followed (`link:<target>`), oversized
 * files are identified by `size:<bytes>:<mtime>`, unreadable ones by `error:<code>`. Throws
 * when aborted or when the tree exceeds SNAPSHOT_FILE_LIMIT entries. */
export async function snapshotTree(root: string, signal?: AbortSignal): Promise<Map<string, string>> {
  const digests = new Map<string, string>();
  const chunks = Array.from({ length: CONCURRENCY }, () => Buffer.allocUnsafe(CHUNK));
  const pending = [""];
  while (pending.length) {
    signal?.throwIfAborted();
    const relative = pending.pop()!;
    let entries;
    try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
    catch (error) { if (VANISHED[errorCode(error) ?? ""]) continue; throw error; }
    const files: string[] = [];
    for (const entry of entries) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!Object.hasOwn(SKIPPED_DIRECTORIES, entry.name)) pending.push(next); }
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(next);
    }
    for (let start = 0; start < files.length; start += CONCURRENCY) {
      signal?.throwIfAborted();
      if (digests.size + files.length - start > SNAPSHOT_FILE_LIMIT) throw new RangeError(`Workspace exceeds ${SNAPSHOT_FILE_LIMIT} files`);
      const batch = files.slice(start, start + CONCURRENCY);
      const results = await Promise.all(batch.map((next, index) => digestEntry(path.join(root, next), chunks[index]!)));
      results.forEach((digest, index) => { if (digest !== undefined) digests.set(batch[index]!, digest); });
    }
  }
  return digests;
}

async function digestEntry(target: string, chunk: Buffer): Promise<string | undefined> {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) return `link:${await readlink(target)}`;
    if (!stats.isFile()) return undefined;
    if (stats.size > HASH_LIMIT) return `size:${stats.size}:${stats.mtimeMs}`;
    const handle = await openNoFollow(target);
    try {
      const hash = createHash("sha256");
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        hash.update(chunk.subarray(0, bytesRead));
      }
      return hash.digest("hex");
    } finally { await handle.close(); }
  } catch (error) {
    const code = errorCode(error);
    return code && VANISHED[code] ? undefined : `error:${code ?? "unknown"}`;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

/** Added/modified/removed paths, sorted. Removals cannot be content-compared. */
export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): TreeChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [relative, digest] of after) {
    if (!before.has(relative)) added.push(relative);
    else if (before.get(relative) !== digest) modified.push(relative);
  }
  for (const relative of before.keys()) if (!after.has(relative)) removed.push(relative);
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}
