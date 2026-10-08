import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonical, readSmall, writePrivate } from "../mcp/consent";
import { SKILL_NAME } from "../skills/metadata";
import { fingerprints, readPackFolder, type PackContents } from "./files";
import { isPackPath, PackError } from "./manifest";

/**
 * The packs you added: their files in ~/.casper/packs/<name>/, and what you were shown when you said yes in
 * ~/.casper/packs.json (source, version, skill folders and the sha256 of every file). Each record carries a keyed
 * hash (HMAC-SHA256; the key is 32 random bytes in ~/.casper/packs.key, 0600), so a record Casper's own /pack add
 * didn't write never counts. A pack whose files no longer match its record is not used until you add it again.
 * All three are in ~/.casper, which the AI's shell can't write, and they are private to the AI's tools.
 */

export const PACKS_FOLDER = path.join(".casper", "packs");
export const PACK_RECORDS = path.join(".casper", "packs.json");
export const PACK_KEY = path.join(".casper", "packs.key");

const VERSION = 1;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface PackRecord {
  name: string;
  version: string;
  /** What you typed it from: a GitHub link pinned to a commit, or a folder's full path. */
  source: string;
  skills: string[];
  /** Every file you were shown, by path inside the pack: its sha256. */
  files: Record<string, string>;
  addedAt: string;
}

interface StoredRecord extends PackRecord { mac: string }
/** As stored: entries are kept as they are when another is saved, and checked only when read. */
interface RecordFile { version: 1; packs: Record<string, unknown> }

export interface InstalledPack {
  record: PackRecord;
  folder: string;
  /** Why it is not used, when it isn't: its files changed since you added it, or are gone. */
  problem?: string;
}

export interface PackListing {
  packs: InstalledPack[];
  /** Records that don't check out (damaged, or not written by Casper): by name, not used. */
  rejected: string[];
  diagnostics: string[];
}

export function packFolder(home: string, name: string): string {
  return path.join(home, PACKS_FOLDER, name);
}

function recordMac(record: PackRecord, key: Buffer): string {
  const { name, version, source, skills, files } = record;
  return createHmac("sha256", key).update(`casper/packs v${VERSION}\n${canonical({ name, version, source, skills, files })}`).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One stored record in the shape Casper writes, or undefined. */
function storedRecord(name: string, value: unknown): StoredRecord | undefined {
  if (!SKILL_NAME.test(name) || name.length > 64 || !isObject(value)) return undefined;
  const { version, source, skills, files, addedAt, mac } = value;
  if (typeof version !== "string" || typeof source !== "string" || typeof addedAt !== "string" || typeof mac !== "string" || !SHA256.test(mac)) return undefined;
  if (!Array.isArray(skills) || !skills.every((folder) => typeof folder === "string" && isPackPath(folder))) return undefined;
  if (!isObject(files) || !Object.entries(files).every(([file, sha]) => isPackPath(file) && typeof sha === "string" && SHA256.test(sha))) return undefined;
  return { name, version, source, skills: skills as string[], files: { ...files } as Record<string, string>, addedAt: addedAt.slice(0, 40), mac };
}

async function readKey(home: string, diagnostics: string[]): Promise<Buffer | undefined> {
  let read;
  try { read = await readSmall(path.join(home, PACK_KEY), 256); }
  catch { diagnostics.push("Cannot read ~/.casper/packs.key, so no pack is used. Add them again with /pack add."); return undefined; }
  if (!read) return undefined;
  if (process.platform !== "win32" && (read.mode & 0o077) !== 0) {
    diagnostics.push("~/.casper/packs.key can be read by other users, so no pack is used. Add them again with /pack add.");
    return undefined;
  }
  const text = read.text.trim();
  if (!SHA256.test(text)) { diagnostics.push("~/.casper/packs.key is damaged, so no pack is used. Add them again with /pack add."); return undefined; }
  return Buffer.from(text, "hex");
}

/** The record file as stored: each entry as it is, checked only by readRecords. A damaged file reads as empty. */
async function readRecordFile(home: string, diagnostics: string[]): Promise<RecordFile> {
  const empty: RecordFile = { version: VERSION, packs: Object.create(null) };
  let read;
  try { read = await readSmall(path.join(home, PACK_RECORDS), MAX_RECORD_BYTES); }
  catch { diagnostics.push("Cannot read ~/.casper/packs.json, so no pack is used."); return empty; }
  if (!read) return empty;
  let document: unknown;
  try { document = JSON.parse(read.text); } catch { document = undefined; }
  if (!isObject(document) || document.version !== VERSION || !isObject(document.packs)) {
    diagnostics.push("~/.casper/packs.json is damaged, so no pack is used. Add them again with /pack add.");
    return empty;
  }
  return { version: VERSION, packs: Object.assign(Object.create(null) as Record<string, unknown>, document.packs) };
}

/** The records whose keyed hash checks out, and the names of those that don't (a name that isn't a pack name at all
 * is only counted). */
async function readRecords(home: string, diagnostics: string[]): Promise<{ records: PackRecord[]; rejected: string[] }> {
  const file = await readRecordFile(home, diagnostics);
  const names = Object.keys(file.packs).sort();
  if (!names.length) return { records: [], rejected: [] };
  const key = await readKey(home, diagnostics);
  const records: PackRecord[] = [];
  const rejected: string[] = [];
  let unnamed = 0;
  const keyProblem = diagnostics.length;
  for (const name of names) {
    if (!SKILL_NAME.test(name) || name.length > 64) { unnamed += 1; continue; }
    const stored = storedRecord(name, file.packs[name]);
    if (!stored || !key) { rejected.push(name); continue; }
    const { mac, ...record } = stored;
    if (mac === recordMac(record, key)) records.push(record);
    else rejected.push(name);
  }
  if (rejected.length && !key && !keyProblem) diagnostics.push("~/.casper/packs.key is missing, so no pack is used. Add them again with /pack add.");
  if (unnamed) diagnostics.push(`~/.casper/packs.json has ${unnamed === 1 ? "an entry" : `${unnamed} entries`} with a name no pack can have; ignored.`);
  if (rejected.length && key) diagnostics.push(`~/.casper/packs.json has ${rejected.length === 1 ? "a record" : "records"} Casper didn't write (${rejected.join(", ")}), so ${rejected.length === 1 ? "that pack isn't" : "those packs aren't"} used. /pack remove clears ${rejected.length === 1 ? "it" : "them"}; /pack add adds a pack again.`);
  return { records, rejected };
}

/** Whether the files in a pack's folder are exactly the ones its record lists, unchanged. */
async function packProblem(record: PackRecord, folder: string): Promise<string | undefined> {
  let contents: PackContents;
  try { contents = await readPackFolder(folder); }
  catch (error) {
    if (!(await lstat(folder).then(() => true, () => false))) return "its folder is gone";
    return `its files changed since you added it (${error instanceof Error ? error.message : String(error)})`;
  }
  const now = fingerprints(contents.files);
  const same = Object.keys(now).length === Object.keys(record.files).length
    && Object.entries(now).every(([file, sha]) => Object.hasOwn(record.files, file) && record.files[file] === sha)
    && canonical(contents.manifest.skills) === canonical(record.skills) && contents.manifest.name === record.name;
  return same ? undefined : "its files changed since you added it";
}

/** Every pack you added, each checked against what you were shown. Reads only ~/.casper. */
export async function loadInstalledPacks(home: string): Promise<PackListing> {
  const diagnostics: string[] = [];
  const { records, rejected } = await readRecords(home, diagnostics);
  const packs: InstalledPack[] = [];
  for (const record of records) {
    const folder = packFolder(home, record.name);
    const problem = await packProblem(record, folder);
    packs.push({ record, folder, ...(problem ? { problem } : {}) });
  }
  return { packs, rejected, diagnostics };
}

/** The key, made on first use. A new key can't vouch for older records: they stay unused until added again. */
async function ensureKey(home: string): Promise<Buffer> {
  const existing = await readKey(home, []);
  if (existing) return existing;
  const key = randomBytes(32);
  await writePrivate(path.join(home, PACK_KEY), `${key.toString("hex")}\n`);
  return key;
}

async function saveRecords(home: string, change: (packs: Record<string, unknown>) => void): Promise<void> {
  const file = await readRecordFile(home, []);
  change(file.packs);
  await writePrivate(path.join(home, PACK_RECORDS), `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Writes the checked files into a new staging folder in ~/.casper/packs, reads that copy back the same way, and
 * returns it: what you are shown is what lands. Only regular files are written, and nothing is run or made
 * executable. The caller removes the folder unless it is swapped in.
 */
export async function stagePack(home: string, contents: PackContents): Promise<{ dir: string; contents: PackContents }> {
  const root = path.join(home, PACKS_FOLDER);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, `.add-${randomUUID()}`);
  await mkdir(dir, { mode: 0o700 });
  try {
    for (const file of contents.files) {
      if (!isPackPath(file.path)) throw new PackError(`${file.path} is not a plain path inside the pack.`);
      const target = path.join(dir, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.text, { flag: "wx" });
    }
    const copied = await readPackFolder(dir);
    if (canonical(fingerprints(copied.files)) !== canonical(fingerprints(contents.files))) throw new PackError("The copy didn't match what was read. Nothing was added.");
    return { dir, contents: copied };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Swaps a staged pack in as ~/.casper/packs/<name> and records it. The staged files are hashed once more first: if
 * anything changed since you were shown them, nothing is added. A pack already there is replaced in one rename
 * (put back if the second rename fails).
 */
export async function installPack(home: string, staged: { dir: string; contents: PackContents }, source: string, now = new Date()): Promise<void> {
  const { manifest } = staged.contents;
  const shown = fingerprints(staged.contents.files);
  try {
    const again = await readPackFolder(staged.dir);
    if (canonical(fingerprints(again.files)) !== canonical(shown)) throw new PackError("The pack's files changed while you were looking. Nothing was added.");
    const key = await ensureKey(home);
    const target = packFolder(home, manifest.name);
    const old = `${target}.old`;
    await rm(old, { recursive: true, force: true });
    const hadOld = await lstat(target).then(() => true, () => false);
    if (hadOld) await rename(target, old);
    try { await rename(staged.dir, target); }
    catch (error) {
      if (hadOld) await rename(old, target).catch(() => undefined);
      throw error;
    }
    await rm(old, { recursive: true, force: true });
    const record: PackRecord = { name: manifest.name, version: manifest.version, source, skills: [...manifest.skills], files: shown, addedAt: now.toISOString() };
    await saveRecords(home, (packs) => { packs[manifest.name] = { ...record, mac: recordMac(record, key) }; });
  } finally {
    await rm(staged.dir, { recursive: true, force: true });
  }
}

/** Removes a pack's record, then its folder. False when there was neither. */
export async function removePack(home: string, name: string): Promise<boolean> {
  if (!SKILL_NAME.test(name) || name.length > 64) return false;
  const records = await readRecordFile(home, []);
  const listed = Object.hasOwn(records.packs, name);
  if (listed) await saveRecords(home, (packs) => { delete packs[name]; });
  const folder = packFolder(home, name);
  const there = await lstat(folder).then(() => true, () => false);
  if (there) await rm(folder, { recursive: true, force: true });
  return listed || there;
}

/** Staging folders a stopped /pack add left behind, older than an hour. */
export async function clearStaleStaging(home: string, now = Date.now()): Promise<void> {
  const root = path.join(home, PACKS_FOLDER);
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!name.startsWith(".add-") && !name.endsWith(".old")) continue;
    const details = await lstat(path.join(root, name)).catch(() => undefined);
    if (details && now - details.mtimeMs > 3_600_000) await rm(path.join(root, name), { recursive: true, force: true });
  }
}
