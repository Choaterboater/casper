import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectCommand } from "../project/model";
import type { VerificationResult } from "./evidence";

/** Last measured duration of each check, keyed by its exact command so an edited command is
 * unmeasured again. A cache for choosing a default mode, never verification evidence. */
type Timings = Partial<Record<ProjectCommand, { command: string; ms: number }>>;

const FILE = "check-timings.json";

async function read(stateDirectory: string): Promise<Timings> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(stateDirectory, FILE), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Timings : {};
  } catch { return {}; }
}

/** Total measured time of `checks`, or undefined while any of them is unmeasured. */
export async function measuredCheckTime(stateDirectory: string, checks: readonly ProjectCommand[],
  commands: Partial<Record<ProjectCommand, string>>): Promise<number | undefined> {
  if (!checks.length) return undefined;
  const timings = await read(stateDirectory);
  let total = 0;
  for (const name of checks) {
    const entry = timings[name];
    if (!entry || entry.command !== commands[name] || typeof entry.ms !== "number" || !Number.isFinite(entry.ms)) return undefined;
    total += entry.ms;
  }
  return total;
}

/** Best-effort: executed runs only (not reused, skipped or cancelled). */
export async function recordCheckTimings(stateDirectory: string, results: readonly VerificationResult[]): Promise<void> {
  const executed = results.filter((result) => result.command && !result.reused && result.status !== "skip" && result.reason !== "Verification cancelled");
  if (!executed.length) return;
  try {
    const timings = await read(stateDirectory);
    for (const result of executed) timings[result.name] = { command: result.command!, ms: result.durationMs };
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const temporary = path.join(stateDirectory, `${FILE}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, JSON.stringify(timings), { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(stateDirectory, FILE));
  } catch { /* A lost timing only keeps the session in offer mode. */ }
}
