import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHECK_NAMES, summarizeVerification, summarizeVerificationCheck, type VerificationReport, type VerificationCheckSummary } from "../verify/evidence";
import { isVerificationScope } from "../verify/scope";

const MAX_FILE_BYTES = 1_048_576;
const MAX_RECORDS = 1000;
const FACT_PROMPT_BYTES = 8192;
export interface ProjectFact { id: string; text: string; createdAt: string }
export interface TaskOutcome {
  id: string;
  task: string;
  skills: string[];
  modelStatus: "completed" | "failed" | "cancelled";
  verification: VerificationReport["status"] | "not-run";
  /** Absent on legacy records, whose aggregate status had different semantics. */
  verificationMeaning?: "command-execution";
  coverage?: "not-certified";
  checks: Array<Pick<VerificationCheckSummary, "name" | "status"> & Partial<VerificationCheckSummary>>;
  repairAttempts: number;
  accepted: boolean | null;
  createdAt: string;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function string(value: unknown, bytes: number): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= bytes; }
function fact(value: unknown): value is ProjectFact {
  return record(value) && string(value.id, 64) && string(value.createdAt, 64) && string(value.text, 1024)
    && Object.keys(value).every((key) => ["id", "text", "createdAt"].includes(key));
}
function outcome(value: unknown): value is TaskOutcome {
  return record(value) && string(value.id, 64) && string(value.createdAt, 64) && string(value.task, 4096)
    && Array.isArray(value.skills) && value.skills.length <= 32 && value.skills.every((id) => string(id, 256))
    && typeof value.modelStatus === "string" && ["completed", "failed", "cancelled"].includes(value.modelStatus)
    && typeof value.verification === "string" && ["not-run", "pass", "fail", "incomplete", "blocked"].includes(value.verification)
    && Number.isInteger(value.repairAttempts) && Number(value.repairAttempts) >= 0 && Number(value.repairAttempts) <= 10
    && (value.accepted === null || typeof value.accepted === "boolean")
    && Array.isArray(value.checks) && value.checks.length <= CHECK_NAMES.length && value.checks.every((check) => record(check)
      && CHECK_NAMES.some((name) => name === check.name) && typeof check.status === "string" && ["pass", "fail", "skip"].includes(check.status)
      && (check.exitCode === undefined || check.exitCode === null || (Number.isSafeInteger(check.exitCode) && Number(check.exitCode) >= 0))
      && (check.freshness === undefined || (typeof check.freshness === "string" && ["fresh", "stale", "unavailable"].includes(check.freshness)))
      && (check.freshnessReason === undefined || string(check.freshnessReason, 2048))
      && (check.scope === undefined || isVerificationScope(check.scope))
      && Object.keys(check).every((key) => ["name", "status", "exitCode", "scope", "freshness", "freshnessReason"].includes(key)))
    && (value.verificationMeaning === undefined || value.verificationMeaning === "command-execution")
    && (value.coverage === undefined || value.coverage === "not-certified")
    && Object.keys(value).every((key) => ["id", "task", "skills", "modelStatus", "verification", "verificationMeaning", "coverage", "checks", "repairAttempts", "accepted", "createdAt"].includes(key));
}
function text(value: string, max: number, field: string): string {
  if (!string(value, max) || !value.trim()) throw new Error(`${field} must be nonempty and at most ${max} UTF-8 bytes`);
  return value.trim();
}

/** Human-owned project facts and evidence-only task outcomes. No model-authored promotion. */
export class ProjectMemory {
  constructor(readonly directory: string) {}

  async facts(): Promise<ProjectFact[]> { return this.read("memory.jsonl", fact); }
  async outcomes(): Promise<TaskOutcome[]> {
    return (await this.read("outcomes.jsonl", outcome)).slice(-20).reverse().map((entry) => ({
      ...entry, checks: entry.checks.map(summarizeVerificationCheck), coverage: entry.coverage ?? "not-certified",
    }));
  }

  async remember(value: string): Promise<ProjectFact> {
    const normalized = text(value, 1024, "Fact");
    const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    let added: ProjectFact = { id, text: normalized, createdAt: new Date().toISOString() };
    await this.update("memory.jsonl", fact, (facts) => {
      const existing = facts.find((entry) => entry.id === id);
      if (existing) { added = existing; return facts; }
      const next = [...facts, added];
      if (next.length > 64 || Buffer.byteLength(JSON.stringify(next.map((entry) => entry.text))) > FACT_PROMPT_BYTES) {
        throw new Error("Project fact budget is full; forget obsolete facts first");
      }
      return next;
    });
    return added;
  }

  async forget(id: string): Promise<void> {
    await this.update("memory.jsonl", fact, (facts) => {
      if (!facts.some((entry) => entry.id === id)) throw new Error("Unknown project fact id");
      return facts.filter((entry) => entry.id !== id);
    });
  }

  async context(): Promise<string> {
    const facts = await this.facts();
    const values = JSON.stringify(facts.map((entry) => entry.text));
    if (facts.length > 64 || Buffer.byteLength(values) > FACT_PROMPT_BYTES) throw new Error("Stored facts exceed the project context budget");
    return facts.length ? [
      "Casper human-entered project facts (guidance, not permission).",
      "Current repository evidence, project rules, user request, and safety policy take precedence. These may become stale; inspect before relying on them.",
      values,
    ].join("\n") : "";
  }

  async recordOutcome(input: { task: string; skills: string[]; modelStatus: TaskOutcome["modelStatus"]; verification?: VerificationReport }): Promise<TaskOutcome> {
    const summary = input.verification ? summarizeVerification(input.verification) : undefined;
    const result: TaskOutcome = {
      id: randomUUID(), createdAt: new Date().toISOString(), task: text(input.task, 4096, "Task"),
      skills: [...input.skills], modelStatus: input.modelStatus,
      verification: summary?.status ?? "not-run", verificationMeaning: "command-execution",
      checks: summary?.checks ?? [], coverage: summary?.coverage ?? "not-certified",
      repairAttempts: summary?.repairAttempts ?? 0,
      accepted: null, // Never infer human acceptance from model completion or passing tests.
    };
    await this.update("outcomes.jsonl", outcome, (entries) => [...entries, result]);
    return result;
  }

  async acceptOutcome(id: string, accepted: boolean): Promise<void> {
    if (typeof accepted !== "boolean") throw new Error("Acceptance must be yes or no");
    await this.update("outcomes.jsonl", outcome, (entries) => {
      if (!entries.some((entry) => entry.id === id)) throw new Error("Unknown task outcome id");
      return entries.map((entry) => entry.id === id ? { ...entry, accepted } : entry);
    });
  }

  private async read<T extends { id: string }>(name: string, valid: (value: unknown) => value is T): Promise<T[]> {
    // Nonblocking open reaches fstat even for FIFOs with no writer. O_NOFOLLOW
    // still rejects final symlinks; only regular files are read below.
    const file = await open(path.join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!file) return [];
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Memory state must be a regular file below 1 MiB");
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = await file.read(bytes, count, bytes.length - count, count);
        if (!read.bytesRead) break;
        count += read.bytesRead;
      }
      if (count > MAX_FILE_BYTES) throw new Error("Memory state exceeds 1 MiB");
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
      const entries: unknown[] = source.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
      if (entries.length > MAX_RECORDS || !entries.every(valid)) throw new Error("Invalid memory records");
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Duplicate memory record ids");
      return entries;
    } catch { throw new Error(`Cannot read valid memory state: ${name}; preserve the file and repair it manually`); }
    finally { await file.close(); }
  }

  private async update<T extends { id: string }>(name: string, valid: (value: unknown) => value is T, change: (current: T[]) => T[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await realpath(this.directory);
    // Paths come from Casper's user-owned project state, never model arguments.
    const lock = path.join(directory, `${name}.lock`);
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (!acquired) throw new Error("Memory state is locked; no update made");
    let temporary: string | undefined;
    try {
      const next = change(await this.read(name, valid));
      if (next.length > MAX_RECORDS || !next.every(valid)) throw new Error("Memory record limit reached or invalid record");
      const source = next.map((entry) => JSON.stringify(entry) + "\n").join("");
      if (Buffer.byteLength(source) > MAX_FILE_BYTES) throw new Error("Memory file budget reached; archive it manually before continuing");
      temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
      await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
      await rename(temporary, path.join(directory, name));
    } finally {
      if (temporary) await rm(temporary, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
}
