/**
 * Which of a task's folder changes the task made. Casper compares the folder before and after a task, and counted every
 * difference as the task's: a file another program saved meanwhile (a second AI tool, an editor) was checked as the
 * task's work and deleted by its undo. The task's tools that can write (any tool but reads, searches and a plain ssh)
 * are timed while they run; a file whose time of change falls while none of them ran is another program's. A file the
 * task's own edit and write tools named is always the task's. A deleted file, an unreadable time, or anything while a
 * command or service the task left running could still write, is one Casper can't tell: it stays the task's on the
 * receipt, and undo asks before touching it.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { TreeChanges } from "./changes";

/** File times are compared this loosely: some file systems keep them to the second (FAT, SMB keeps two). */
export const ATTRIBUTION_SLACK_MS = 2_000;

/** The times the task's writing tools ran. A tool still running counts up to now. */
export class WriteWindows {
  private readonly open = new Map<string, number>();
  private readonly kept = new Map<string, number>();
  private readonly done: Array<[number, number]> = [];
  private lastEnd: number;

  constructor(readonly since: number = Date.now()) { this.lastEnd = since; }

  /** A tool that may write began. `keep`: it may go on writing after it returns (a picture still being made), until
   * `release`. */
  start(id: string, keep = false, at = Date.now()): void {
    (keep ? this.kept : this.open).set(id, at);
  }

  /** That tool ended. One whose start was never seen counts from the end of the one before it. */
  end(id: string, at = Date.now()): void {
    if (this.kept.has(id)) return;
    const start = this.open.get(id) ?? this.lastEnd;
    this.open.delete(id);
    this.done.push([start, at]);
    this.lastEnd = Math.max(this.lastEnd, at);
  }

  /** The kept tools are done writing (the pictures are finished). */
  release(at = Date.now()): void {
    for (const start of this.kept.values()) this.done.push([start, at]);
    this.kept.clear();
  }

  /** A command moved to the background, or a service ran: either may write between the tools' runs. */
  unsure = false;

  get any(): boolean { return this.done.length > 0 || this.open.size > 0 || this.kept.size > 0; }

  windows(now = Date.now()): Array<[number, number]> {
    return [...this.done, ...[...this.open.values(), ...this.kept.values()].map((start): [number, number] => [start, now])];
  }
}

export interface Attribution {
  /** Changed while a writing tool ran, or by the task's own edit and write tools. */
  task: string[];
  /** Changed while none of the task's tools that write ran: another program's. */
  others: string[];
  /** The task's on the receipt, but Casper can't tell: undo asks before touching them. */
  unsure: string[];
}

export interface AttributionInput {
  root: string;
  changes: TreeChanges;
  windows: ReadonlyArray<readonly [number, number]>;
  /** When the task's starting copy was taken, and when its ending one was. */
  since: number;
  until: number;
  /** Files the task's edit and write tools named, relative to `root` with `/`. */
  toolFiles?: ReadonlySet<string>;
  /** A command or service the task left running may have written at any time. */
  unsure?: boolean;
  /** The time a file or folder last changed, or undefined when it can't be read. */
  changedAt?: (absolute: string) => Promise<number | undefined>;
  slackMs?: number;
}

const modified = async (absolute: string) => (await lstat(absolute).catch(() => undefined))?.mtimeMs;

export async function attributeChanges(input: AttributionInput): Promise<Attribution> {
  const slack = input.slackMs ?? ATTRIBUTION_SLACK_MS;
  const changedAt = input.changedAt ?? modified;
  const during = (time: number) => input.windows.some(([start, end]) => time >= start - slack && time <= end + slack);
  const result: Attribution = { task: [], others: [], unsure: [] };
  const absolute = (file: string) => path.join(input.root, ...file.split("/"));
  const place = async (file: string, time: number | undefined) => {
    if (time === undefined) { result.unsure.push(file); return; }
    // Before the task (an archive unpacked, `cp -p`) or after its last copy: the time says nothing, so it is the task's.
    if (time < input.since - slack || time > input.until + slack || during(time)) { result.task.push(file); return; }
    (input.unsure ? result.unsure : result.others).push(file);
  };
  for (const file of [...input.changes.added, ...input.changes.modified]) {
    if (input.toolFiles?.has(file)) { result.task.push(file); continue; }
    await place(file, await changedAt(absolute(file)));
  }
  // A deleted file has no time of its own: its folder's (or the nearest one left) says when an entry last went or came.
  // Inside a tool's run it is the task's; otherwise Casper can't tell.
  for (const file of input.changes.removed) {
    if (input.toolFiles?.has(file)) { result.task.push(file); continue; }
    let folder = path.posix.dirname(file);
    let time: number | undefined;
    for (;;) {
      time = await changedAt(folder === "." ? input.root : absolute(folder));
      if (time !== undefined || folder === ".") break;
      folder = path.posix.dirname(folder);
    }
    if (time !== undefined && (during(time) || time < input.since - slack)) result.task.push(file);
    else result.unsure.push(file);
  }
  for (const list of [result.task, result.others, result.unsure]) list.sort();
  return result;
}

/** `snapshot` with `files` as they were in `before`: the task's comparisons then leave another program's files out. */
export function withoutFiles(snapshot: Map<string, string>, before: ReadonlyMap<string, string>, files: readonly string[], as?: ReadonlyMap<string, string>): Map<string, string> {
  if (!files.length) return snapshot;
  const next = new Map(snapshot);
  for (const file of files) {
    // Only while the file is still as the other program left it: a later change is the task's again.
    if (as && as.get(file) !== snapshot.get(file)) continue;
    const was = before.get(file);
    if (was === undefined) next.delete(file); else next.set(file, was);
  }
  return next;
}
