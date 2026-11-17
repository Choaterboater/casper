/**
 * A lock folder for Casper's own state files (memory, saved session branches, learning drafts, worktree creation)
 * that says who holds it, so a lock left by a Casper that was killed, or by a computer that restarted, is taken
 * over instead of blocking every later update (decision 109).
 *
 * The lock is a folder made with mkdir (0700) holding one owner file (0600) whose name carries the holder's pid,
 * when this computer started (boot, in seconds), which computer (a short hash of its host name) and a random id:
 * `owner.<pid>.<boot>.<host>.<id>`. A holder on another computer (a home folder shared over the network) is judged
 * by its file's age alone, since its boot and pid say nothing here. Taking over is race
 * safe without a second lock: a stale owner file is removed by its unique name, and the emptied folder with rmdir,
 * which never removes a folder that holds an owner file. A holder checks it is the only owner in the folder after
 * writing its file, so two processes never both hold one folder.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { busyOnWindows, lockBusy } from "./files";

/** Boot times this far apart are the same start of the computer (the clock is read twice, and NTP nudges it). */
const BOOT_SLACK_S = 60;
/** A gone pid counts only once its owner file is this old. */
const DEAD_GRACE_MS = 2_000;
/** A lock folder with no owner file (an older Casper made it, or a holder was killed in its first instant) is
 * taken over once it is this old. */
const OWNERLESS_MS = 5 * 60_000;
/** An owner file from another computer is taken over once it is this old. */
const OTHER_HOST_MS = OWNERLESS_MS;

/** When this computer started, in whole seconds since 1970: the same for every process until it restarts. */
export function bootEpoch(now = Date.now(), uptime = os.uptime()): number {
  return Math.round(now / 1000 - uptime);
}

/** This computer, as 8 hex characters of its host name's hash (the name itself is not written down). */
export function hostId(name = os.hostname()): string {
  return createHash("sha256").update(name).digest("hex").slice(0, 8);
}

/** True when two boot times name the same start of this computer. */
export function sameBoot(a: number, b: number): boolean {
  return Math.abs(a - b) <= BOOT_SLACK_S;
}

/** False only when the process is certainly gone (ESRCH); another user's process, or any other answer, is alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export interface StateLockOptions {
  /** The error text while a live owner holds the lock after every try. */
  busy: string;
  /** Tries, and the wait between them: 100 × 20 ms unless the caller says otherwise. */
  attempts?: number;
  waitMs?: number;
  signal?: AbortSignal;
  /** Test seams. */
  alive?: (pid: number) => boolean;
  boot?: () => number;
  host?: () => string;
  now?: () => number;
  /** Runs after a lock is judged stale and before it is taken over. */
  beforeTakeover?: () => Promise<void>;
}

interface Owner { pid: number; boot: number; host: string; id: string }

const OWNER = /^owner\.(\d{1,10})\.(\d{1,12})\.([0-9a-f]{8})\.([0-9a-f]{16})$/;

function parseOwner(name: string): Owner | undefined {
  const match = OWNER.exec(name);
  return match ? { pid: Number(match[1]), boot: Number(match[2]), host: match[3]!, id: match[4]! } : undefined;
}

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** Hold the lock folder at `lock` while `fn` runs. A live owner makes it wait and, after the last try, throw `busy`. */
export async function withStateLock<T>(lock: string, fn: () => Promise<T>, options: StateLockOptions): Promise<T> {
  const file = await acquire(lock, options);
  try { return await fn(); }
  finally { await release(lock, file); }
}

async function acquire(lock: string, options: StateLockOptions): Promise<string> {
  const attempts = options.attempts ?? 100;
  for (let attempt = 0; attempt < attempts; attempt++) {
    options.signal?.throwIfAborted();
    const file = await take(lock, options);
    if (file) return file;
    if (await takeOver(lock, options)) continue;
    await new Promise((resolve) => setTimeout(resolve, options.waitMs ?? 20));
  }
  throw new Error(options.busy);
}

/** The owner file's path when this process now holds the lock; undefined when someone else does. */
async function take(lock: string, options: StateLockOptions): Promise<string | undefined> {
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (lockBusy(error)) return undefined; throw error; }
  const owner: Owner = { pid: process.pid, boot: (options.boot ?? bootEpoch)(), host: (options.host ?? hostId)(), id: randomBytes(8).toString("hex") };
  const name = `owner.${owner.pid}.${owner.boot}.${owner.host}.${owner.id}`;
  const file = path.join(lock, name);
  try { await writeFile(file, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    // The folder went while it was empty (a waiter took it over as ownerless): try again.
    if (code(error) === "ENOENT") return undefined;
    await rmdir(lock).catch(() => {});
    throw error;
  }
  const entries = await readdir(lock).catch(() => [] as string[]);
  if (entries.length === 1 && entries[0] === name) return file;
  // Another process wrote into this same folder at the same moment: both step back and try again.
  await unlink(file).catch(() => {});
  await rmdir(lock).catch(() => {});
  return undefined;
}

/** True when a stale lock was taken away (try again now), false when a live owner holds it (wait). */
async function takeOver(lock: string, options: StateLockOptions): Promise<boolean> {
  let entries: string[];
  try { entries = await readdir(lock); }
  catch (error) { return code(error) === "ENOENT"; }
  const now = (options.now ?? Date.now)();
  if (entries.length === 0) {
    const info = await lstat(lock).catch(() => undefined);
    if (!info) return true;
    if (now - info.mtimeMs <= OWNERLESS_MS) return false;
    await options.beforeTakeover?.();
    // rmdir removes only an empty folder: never one a holder has written its owner file into.
    try { await rmdir(lock); return true; }
    catch (error) { return code(error) === "ENOENT"; }
  }
  const owners = entries.map(parseOwner);
  if (!owners.every(Boolean)) return false;
  for (const [index, owner] of owners.entries()) {
    if (!await stale(owner!, path.join(lock, entries[index]!), now, options)) return false;
  }
  await options.beforeTakeover?.();
  // Each name is unique to one holder, so this removes only the stale files judged above, even if the folder was
  // taken over and made again meanwhile. Then rmdir removes the folder only if no one has written into it since.
  for (const entry of entries) await unlink(path.join(lock, entry)).catch(() => {});
  try { await rmdir(lock); return true; }
  catch (error) { return code(error) === "ENOENT"; }
}

async function stale(owner: Owner, file: string, now: number, options: StateLockOptions): Promise<boolean> {
  const age = async () => { const info = await lstat(file).catch(() => undefined); return info ? now - info.mtimeMs : -Infinity; };
  // Another computer's boot and pids mean nothing on this one: only an owner file left for minutes is stale.
  if (owner.host !== (options.host ?? hostId)()) return await age() > OTHER_HOST_MS;
  if (!sameBoot(owner.boot, (options.boot ?? bootEpoch)())) return true;
  if ((options.alive ?? pidAlive)(owner.pid)) return false;
  return await age() > DEAD_GRACE_MS;
}

async function release(lock: string, file: string): Promise<void> {
  // Gone already means another Casper took it over; its folder is not this one's to remove.
  try { await unlink(file); } catch { return; }
  for (let attempt = 1; ; attempt++) {
    try { await rmdir(lock); return; }
    catch (error) {
      // On Windows a file another program still has open (a virus scanner) leaves the folder not yet empty.
      const retry = busyOnWindows(error) || (process.platform === "win32" && code(error) === "ENOTEMPTY");
      if (!retry || attempt >= 50) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}
