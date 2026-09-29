/**
 * Saved receipts: one small JSON file per task in ~/.casper/projects/<project>/receipts/<n>.json (folder 0700, files
 * 0600), so /receipt, /undo and /diff work after Casper restarts. The task part is stored the way JSON events are
 * (app/json-events.ts storedTaskResult): no check output, and previews with secrets replaced by <redacted>. File
 * paths and copy ids are kept, because undo needs them. The newest 100 are kept.
 */
import { constants } from "node:fs";
import { chmod, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { openNoFollow } from "../platform/files";
import type { TaskResult } from "./result";
import type { LeftOut } from "./undo";

export const RECEIPTS_KEPT = 100;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

export interface ReceiptUndo {
  /** The copy before the task and the copy when its receipt was written. */
  before: string;
  after: string;
  /** The files that differ between the two copies. */
  paths: string[];
  /** Changed files Casper keeps no copy of (secret files, big files, nested repos). */
  left: LeftOut[];
  /** MCP servers the task changed things through (approved calls that were not read-only): undo can't reach them. */
  servers?: string[];
  /** Set by /undo: the files it put back, and the copy made just before, for /redo. Cleared by /redo. */
  undone?: { at: string; restored: string[]; redo: string };
}

/** A saved setting change (Remember this test command): the file's text before and after, as copy ids. */
export interface ReceiptSetting {
  file: string;
  line: string;
  /** Copy id of the text before, or null when Casper created the file. */
  before: string | null;
  after: string;
  undone?: { at: string };
}

export interface StoredReceipt {
  schemaVersion: 1;
  n: number;
  createdAt: string;
  kind: "task" | "setting";
  /** The request, secrets hidden, at most 200 characters. */
  request: string;
  /** The work tree the task ran in. */
  root: string;
  /** The conversation it ran in, and the conversation's position before and after it (for rewinding on undo). */
  sessionId: string | null;
  conversation: { before: string | null; after: string | null } | null;
  undo: ReceiptUndo | { unavailable: string } | null;
  setting?: ReceiptSetting;
  task?: TaskResult;
}

export type ReceiptRead = StoredReceipt | "missing" | "unreadable";

export class ReceiptStore {
  readonly directory: string;

  constructor(stateDirectory: string) {
    this.directory = path.join(stateDirectory, "receipts");
  }

  private file(n: number): string { return path.join(this.directory, `${n}.json`); }

  private async numbers(): Promise<number[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    return names.map((name) => /^([1-9]\d{0,8})\.json$/.exec(name)?.[1]).filter((n): n is string => Boolean(n)).map(Number).sort((a, b) => a - b);
  }

  /** Saves a new receipt under the next free number (two Caspers never share one) and returns it. */
  async add(receipt: Omit<StoredReceipt, "n" | "schemaVersion">): Promise<number> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700).catch(() => {});
    let n = (await this.numbers()).at(-1) ?? 0;
    for (let tries = 0; tries < 1000; tries++) {
      n++;
      let handle;
      try { handle = await open(this.file(n), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw error; }
      try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, n, ...receipt }, null, 1)); }
      finally { await handle.close(); }
      await this.prune(n);
      return n;
    }
    throw new Error("no free receipt number");
  }

  async get(n: number): Promise<ReceiptRead> {
    if (!Number.isSafeInteger(n) || n < 1) return "missing";
    let handle;
    try { handle = await openNoFollow(this.file(n)); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable"; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_RECEIPT_BYTES) return "unreadable";
      const value = JSON.parse(await handle.readFile("utf8")) as StoredReceipt;
      return value && value.schemaVersion === 1 && value.n === n && typeof value.root === "string" ? value : "unreadable";
    } catch { return "unreadable"; } finally { await handle.close(); }
  }

  /** Changes a saved receipt in place (write a new file, then rename it over the old one). */
  async update(n: number, change: (receipt: StoredReceipt) => StoredReceipt): Promise<void> {
    const current = await this.get(n);
    if (typeof current === "string") throw new Error(`Receipt ${n} can't be read.`);
    const next = change(current);
    const temp = path.join(this.directory, `.${n}.${process.pid}.${Date.now()}.tmp`);
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(JSON.stringify(next, null, 1)); } finally { await handle.close(); }
    await rename(temp, this.file(n));
  }

  /** The newest receipts first, at most `limit`, each read or marked unreadable. */
  async list(limit = 10): Promise<Array<{ n: number; receipt: ReceiptRead }>> {
    const numbers = (await this.numbers()).reverse().slice(0, limit);
    return Promise.all(numbers.map(async (n) => ({ n, receipt: await this.get(n) })));
  }

  /** The newest readable receipt that `match` accepts. */
  async latest(match: (receipt: StoredReceipt) => boolean = () => true): Promise<StoredReceipt | undefined> {
    for (const n of (await this.numbers()).reverse()) {
      const receipt = await this.get(n);
      if (typeof receipt !== "string" && match(receipt)) return receipt;
    }
    return undefined;
  }

  private async prune(newest: number): Promise<void> {
    for (const n of await this.numbers()) if (n <= newest - RECEIPTS_KEPT) await unlink(this.file(n)).catch(() => {});
  }
}
