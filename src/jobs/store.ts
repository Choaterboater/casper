/**
 * Walk-away jobs: a task that kept going after its terminal closed (decision 51). One record a job, in the project's own
 * private state folder, ~/.casper/projects/<key>/jobs/<id>.json, next to its log (<id>.log) and, while it waits on
 * you, the answer another Casper writes (<id>.answer.json). Only Casper writes here: the folder is under
 * ~/.casper/projects, which the AI's tools can neither read nor change.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { readSmall, writePrivate } from "../mcp/consent";
import { isProjectKey } from "../pages/store";

export type JobStatus = "running" | "waiting" | "done" | "stopped";

export interface JobChoice { label: string; description?: string }

/** A question the job holds for you: the same box, shown again where you answer it. */
export interface JobQuestion {
  id: string;
  /** approve: an approval box (1 is No); pick: Casper's numbered question; ask: the AI's ask tool; line: one typed line. */
  kind: "approve" | "pick" | "ask" | "line";
  preview?: string;
  question: string;
  choices: JobChoice[];
  multi?: boolean;
  /** The question takes typed words (the AI's own questions). */
  typed?: boolean;
  /** "ai" when the AI asks, as the box says. */
  from?: "ai" | "casper" | "approval";
  hint?: string;
  askedAt: string;
}

export interface JobRecord {
  version: 1;
  id: string;
  pid: number;
  /** The folder the job works in, and its name for the row. */
  root: string;
  folder: string;
  /** The request, secrets hidden, one line. */
  request: string;
  leftAt: string;
  updatedAt: string;
  status: JobStatus;
  question?: JobQuestion;
  endedAt?: string;
  /** Why it stopped, in plain words. */
  why?: string;
  /** The task's receipt: its number in that folder (/receipt n, /undo n) and its plain lines. */
  receipt?: { n?: number; text: string };
  /** The AI's last words. */
  answer?: string;
  /** You saw the result: the start's row no longer offers it. */
  seen?: boolean;
}

/** `note`: words typed with a No on an approval, for the job's AI, as at the keyboard. */
export interface JobAnswer { question: string; picked: string[] | null; note?: string }

/** A job and where it is kept. `here`: the folder Casper is in now. `key`: the project key ("app-<16 hex>"). */
export interface ListedJob { record: JobRecord; key: string; here: boolean; directory: string }

const ID = /^[0-9a-f]{12}$/;
const RECORD_BYTES = 256 * 1024;
const ANSWER_BYTES = 16 * 1024;
export const ANSWER_TEXT_LIMIT = 4_000;

export function jobsDirectory(stateDirectory: string): string { return path.join(stateDirectory, "jobs"); }
export function jobLog(directory: string, id: string): string { return path.join(directory, `${id}.log`); }

export function newJobId(): string { return randomBytes(6).toString("hex"); }

/** Whether the process is still there (a process of another user counts). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

const text = (value: unknown, max: number): string | undefined => typeof value === "string" ? value.slice(0, max) : undefined;

function choices(value: unknown): JobChoice[] | undefined {
  if (!Array.isArray(value) || value.length > 20) return undefined;
  const list: JobChoice[] = [];
  for (const item of value) {
    const label = text((item as JobChoice | undefined)?.label, 200);
    if (!label) return undefined;
    const description = text((item as JobChoice).description, 400);
    list.push({ label, ...(description ? { description } : {}) });
  }
  return list;
}

function question(value: unknown): JobQuestion | undefined {
  const raw = value as Partial<JobQuestion> | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const id = text(raw.id, 64), kind = raw.kind, asked = text(raw.question, 8_000), list = choices(raw.choices ?? []), askedAt = text(raw.askedAt, 40);
  if (!id || !asked || !list || !askedAt || !["approve", "pick", "ask", "line"].includes(kind as string)) return undefined;
  const preview = text(raw.preview, 64_000), hint = text(raw.hint, 400);
  const from = raw.from === "ai" || raw.from === "casper" || raw.from === "approval" ? raw.from : undefined;
  return { id, kind: kind as JobQuestion["kind"], question: asked, choices: list, askedAt, ...(preview ? { preview } : {}), ...(hint ? { hint } : {}),
    ...(raw.multi === true ? { multi: true } : {}), ...(raw.typed === true ? { typed: true } : {}), ...(from ? { from } : {}) };
}

/** A record as read back: anything that isn't one Casper wrote is left out. */
export function parseJob(raw: string, id: string): JobRecord | undefined {
  let value: Partial<JobRecord>;
  try { value = JSON.parse(raw) as Partial<JobRecord>; } catch { return undefined; }
  if (!value || value.version !== 1 || value.id !== id || !Number.isInteger(value.pid)) return undefined;
  const root = text(value.root, 4_096), folder = text(value.folder, 200), request = text(value.request, 400);
  const leftAt = text(value.leftAt, 40), updatedAt = text(value.updatedAt, 40);
  if (!root || folder === undefined || request === undefined || !leftAt || !updatedAt) return undefined;
  if (!["running", "waiting", "done", "stopped"].includes(value.status as string)) return undefined;
  const asked = value.question === undefined ? undefined : question(value.question);
  const receiptText = text(value.receipt?.text, 32_000);
  const n = value.receipt?.n;
  const endedAt = text(value.endedAt, 40), why = text(value.why, 400), answer = text(value.answer, ANSWER_TEXT_LIMIT);
  return {
    version: 1, id, pid: value.pid!, root, folder, request, leftAt, updatedAt, status: value.status!,
    ...(asked ? { question: asked } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(why ? { why } : {}),
    ...(receiptText !== undefined ? { receipt: { text: receiptText, ...(Number.isInteger(n) && n! > 0 ? { n } : {}) } } : {}),
    ...(answer ? { answer } : {}),
    ...(value.seen === true ? { seen: true } : {}),
  };
}

export const GONE_WHY = "Casper stopped before the job ended (the computer restarted, or it was closed)";

/** A job whose Casper is gone without ending it (the computer restarted, or it was killed) reads as stopped. */
export function settled(record: JobRecord, alive = processAlive): JobRecord {
  if ((record.status === "running" || record.status === "waiting") && !alive(record.pid)) {
    const { question: _gone, ...rest } = record;
    return { ...rest, status: "stopped", why: GONE_WHY };
  }
  return record;
}

/** The record, written in one step (owner only). Sync: the first one is written while the terminal hangs up. */
export function writeJobSync(directory: string, record: JobRecord): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${record.id}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = openSync(temporary, "wx", 0o600);
  try { writeSync(handle, `${JSON.stringify(record, null, 2)}\n`); fsyncSync(handle); }
  finally { closeSync(handle); }
  try { renameSync(temporary, file); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

export async function writeJob(directory: string, record: JobRecord): Promise<void> {
  await writePrivate(path.join(directory, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

export async function readJob(directory: string, id: string): Promise<JobRecord | undefined> {
  if (!ID.test(id)) return undefined;
  const file = await readSmall(path.join(directory, `${id}.json`), RECORD_BYTES).catch(() => undefined);
  return file ? parseJob(file.text, id) : undefined;
}

/** The answer you gave in another Casper, for this question only. */
export async function readAnswer(directory: string, id: string, questionId: string): Promise<JobAnswer | undefined> {
  const file = await readSmall(path.join(directory, `${id}.answer.json`), ANSWER_BYTES).catch(() => undefined);
  if (!file) return undefined;
  try {
    const value = JSON.parse(file.text) as Partial<JobAnswer>;
    if (value.question !== questionId) return undefined;
    if (value.picked === null) return { question: questionId, picked: null };
    if (!Array.isArray(value.picked) || value.picked.length > 20 || !value.picked.every((item) => typeof item === "string")) return undefined;
    const note = typeof value.note === "string" && value.note.trim() ? value.note.slice(0, ANSWER_TEXT_LIMIT) : undefined;
    return { question: questionId, picked: value.picked.map((item) => item.slice(0, ANSWER_TEXT_LIMIT)), ...(note ? { note } : {}) };
  } catch { return undefined; }
}

export async function writeAnswer(directory: string, id: string, answer: JobAnswer): Promise<void> {
  if (!ID.test(id)) throw new Error("not a job");
  await writePrivate(path.join(directory, `${id}.answer.json`), `${JSON.stringify(answer)}\n`);
}

export async function removeAnswer(directory: string, id: string): Promise<void> {
  await rm(path.join(directory, `${id}.answer.json`), { force: true });
}

/** Every folder's jobs, this folder's first, then the newest. A folder name must be a project key; anything else
 * under ~/.casper/projects is skipped. */
export async function listJobs(homeDir: string, hereKey?: string, alive = processAlive): Promise<ListedJob[]> {
  const base = path.join(homeDir, ".casper", "projects");
  const keys = await readdir(base).catch(() => [] as string[]);
  const found = await Promise.all(keys.filter(isProjectKey).map(async (key) => {
    const directory = path.join(base, key, "jobs");
    const names = await readdir(directory).catch(() => [] as string[]);
    const records = await Promise.all(names.map((name) => /^([0-9a-f]{12})\.json$/.exec(name)?.[1])
      .filter((id): id is string => Boolean(id)).map((id) => readJob(directory, id)));
    return records.filter((record): record is JobRecord => Boolean(record))
      .map((record): ListedJob => ({ record: settled(record, alive), key, here: key === hereKey, directory }));
  }));
  return found.flat().sort((a, b) => Number(b.here) - Number(a.here) || b.record.updatedAt.localeCompare(a.record.updatedAt));
}

/** Finished jobs older than `days` go, record and log. Ones still working or waiting stay. */
export async function pruneJobs(directory: string, days = 30, now = Date.now()): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const id of names.map((name) => /^([0-9a-f]{12})\.json$/.exec(name)?.[1]).filter((id): id is string => Boolean(id))) {
    const record = await readJob(directory, id);
    if (!record || (record.status !== "done" && record.status !== "stopped")) continue;
    if (now - Date.parse(record.endedAt ?? record.updatedAt) < days * 86_400_000) continue;
    for (const file of [`${id}.json`, `${id}.log`, `${id}.answer.json`]) await rm(path.join(directory, file), { force: true }).catch(() => {});
  }
}

/** Another Casper's job still working in this folder (one job a folder). Sync: asked while the terminal hangs up. */
export function liveJobSync(directory: string, ownPid = process.pid, alive = processAlive): JobRecord | undefined {
  let names: string[];
  try { names = readdirSync(directory); } catch { return undefined; }
  for (const name of names) {
    const id = /^([0-9a-f]{12})\.json$/.exec(name)?.[1];
    if (!id) continue;
    let raw: string;
    try { raw = readFileSync(path.join(directory, name), "utf8"); } catch { continue; }
    const record = parseJob(raw.slice(0, RECORD_BYTES), id);
    if (record && record.pid !== ownPid && (record.status === "running" || record.status === "waiting") && alive(record.pid)) return record;
  }
  return undefined;
}
