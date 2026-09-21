import { opendir, realpath, type FileHandle } from "node:fs/promises";
import { openNoFollow, openNoFollowUpdate } from "../platform/files";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyTextEdits, type TextEdit } from "./edits";
import { record } from "./protocol";

export const MAX_FILE_BYTES = 1024 * 1024;
export interface Snapshot { path: string; text: string; dev: number; ino: number }
export interface PlannedFile extends Snapshot { next: string; edits: TextEdit[] }

export async function projectPath(root: string, input: string): Promise<string> {
  const target = input.startsWith("file:") ? fileURLToPath(input) : path.resolve(root, input);
  const canonical = await realpath(target);
  const relative = path.relative(root, canonical);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || relative.split(path.sep).some((part) => [".git", ".casper", "node_modules"].includes(part))) {
    throw new Error("LSP path is outside the editable project");
  }
  return canonical;
}

/** Allocate for this file, not the global limit; one sentinel byte detects growth.
 * A changing size fails closed, and short OS reads are accumulated until EOF.
 */
async function readSnapshotBytes(file: FileHandle, expectedBytes: number): Promise<Buffer> {
  const bytes = Buffer.alloc(expectedBytes + 1);
  let length = 0;
  while (length < bytes.length) {
    const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
    if (!bytesRead) break;
    length += bytesRead;
  }
  if (length !== expectedBytes) throw new Error("LSP file size changed during snapshot");
  return bytes.subarray(0, length);
}

export async function snapshot(root: string, input: string): Promise<Snapshot> {
  const target = await projectPath(root, input);
  const file = await openNoFollow(target);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error("LSP requires a regular, single-link file within 1 MiB");
    const bytes = await readSnapshotBytes(file, stat.size);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes("\0")) throw new Error("LSP binary file rejected");
    return { path: target, text, dev: stat.dev, ino: stat.ino };
  } finally { await file.close(); }
}

/** Bounded workspace snapshot for rename; unsupported/oversized workspaces fail closed. */
export async function workspaceSnapshots(root: string, extensions: string[]): Promise<Snapshot[]> {
  const result: Snapshot[] = [];
  let visited = 0;
  let bytes = 0;
  async function walk(directory: string): Promise<void> {
    for await (const entry of await opendir(directory)) {
      if (++visited > 10_000) throw new Error("Rename workspace scan limit exceeded");
      if ([".git", ".casper", "node_modules"].includes(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
        const current = await snapshot(root, target);
        bytes += Buffer.byteLength(current.text);
        if (result.length >= 100 || bytes > 4 * MAX_FILE_BYTES) throw new Error("Rename workspace exceeds 100 files / 4 MiB");
        result.push(current);
      }
    }
  }
  await walk(root);
  return result;
}

function parseEdits(value: unknown): TextEdit[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error("Invalid LSP edits");
  return value.map((item) => {
    if (!record(item) || Object.keys(item).some((key) => !["range", "newText"].includes(key))
      || typeof item.newText !== "string" || !record(item.range)) throw new Error("Unsupported LSP edit");
    const position = (p: unknown) => {
      if (!record(p) || typeof p.line !== "number" || typeof p.character !== "number") throw new Error("Invalid LSP range");
      return { line: p.line, character: p.character };
    };
    return { range: { start: position(item.range.start), end: position(item.range.end) }, newText: item.newText };
  });
}

/** Preflight every target before approval or any filesystem mutation. */
export async function planWorkspaceEdit(root: string, value: unknown, versions: ReadonlyMap<string, number>): Promise<PlannedFile[]> {
  if (!record(value) || Object.keys(value).some((key) => !["changes", "documentChanges"].includes(key))
    || (value.changes !== undefined && value.documentChanges !== undefined)) throw new Error("Unsupported workspace edit");
  const entries: { uri: string; edits: unknown; version?: number | null }[] = [];
  if (value.changes !== undefined) {
    if (!record(value.changes)) throw new Error("Invalid workspace changes");
    for (const [uri, edits] of Object.entries(value.changes)) entries.push({ uri, edits });
  } else if (Array.isArray(value.documentChanges)) {
    for (const change of value.documentChanges) {
      if (!record(change) || "kind" in change || !record(change.textDocument) || typeof change.textDocument.uri !== "string"
        || (change.textDocument.version !== null && !Number.isSafeInteger(change.textDocument.version))) throw new Error("Resource operations or invalid versions are unsupported");
      entries.push({ uri: change.textDocument.uri, edits: change.edits, version: change.textDocument.version as number | null });
    }
  } else throw new Error("Missing workspace changes");
  if (!entries.length || entries.length > 100) throw new Error("Rename requires 1–100 files");
  const files: PlannedFile[] = [];
  let bytes = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const url = new URL(entry.uri);
    if (url.protocol !== "file:" || url.search || url.hash) throw new Error("Only local file URIs are supported");
    const current = await snapshot(root, entry.uri);
    if (seen.has(current.path)) throw new Error("Duplicate workspace target");
    seen.add(current.path);
    if (entry.version != null && versions.get(current.path) !== entry.version) throw new Error("Stale LSP document version");
    const edits = parseEdits(entry.edits);
    const next = applyTextEdits(current.text, edits);
    bytes += Buffer.byteLength(current.text) + Buffer.byteLength(next);
    if (Buffer.byteLength(next) > MAX_FILE_BYTES || bytes > 8 * MAX_FILE_BYTES) throw new Error("Rename snapshot budget exceeded");
    if (next !== current.text) files.push({ ...current, next, edits });
  }
  if (!files.length) throw new Error("Rename contains no changes");
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function validatePlan(root: string, files: readonly PlannedFile[]): Promise<void> {
  for (const file of files) {
    const current = await snapshot(root, file.path);
    if (current.path !== file.path || current.dev !== file.dev || current.ino !== file.ino || current.text !== file.text) throw new Error("Rename snapshot changed; request a new plan");
  }
}

/** No automatic rollback: a failed later write must never clobber intervening user edits. */
export async function commitPlan(root: string, files: readonly PlannedFile[], signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted();
  await validatePlan(root, files);
  signal?.throwIfAborted();
  const written: string[] = [];
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      await validatePlan(root, [file]);
      signal?.throwIfAborted();
      const handle = await openNoFollowUpdate(file.path);
      try {
        const stat = await handle.stat();
        if (stat.dev !== file.dev || stat.ino !== file.ino || stat.nlink !== 1 || !stat.isFile()) throw new Error("Rename target identity changed");
        if (stat.size !== Buffer.byteLength(file.text)) throw new Error("Rename snapshot changed");
        const bytes = await readSnapshotBytes(handle, stat.size);
        if (!bytes.equals(Buffer.from(file.text))) throw new Error("Rename snapshot changed");
        // Record before the first write so even a partial-file I/O failure is disclosed.
        signal?.throwIfAborted();
        written.push(file.path);
        const next = Buffer.from(file.next);
        let offset = 0;
        while (offset < next.length) {
          signal?.throwIfAborted();
          const result = await handle.write(next, offset, next.length - offset, offset);
          if (!result.bytesWritten) throw new Error("Short rename write");
          offset += result.bytesWritten;
        }
        signal?.throwIfAborted();
        await handle.truncate(next.length);
      } finally { await handle.close(); }
    }
    return written;
  } catch {
    throw new Error(`Rename failed; possibly modified files: ${JSON.stringify(written.map((file) => path.relative(root, file)))}. No rollback or replay performed; inspect these files.`);
  }
}
