import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

/** The three sides of the blind compare. Only the judge page's X/Y/Z labels are shuffled; these never are. */
export const SIDES = ["A", "B", "C"] as const;
export type Side = (typeof SIDES)[number];
export const SIDE_NAMES: Record<Side, string> = { A: "Casper v0.2.32", B: "Casper experiment", C: "SkyN3t" };

/** Side A is pinned to this release, checked by commit so a moved tag or a `casper update` cannot change it. */
export const BASELINE_TAG = "v0.2.32";
export const BASELINE_COMMIT = "7df90a5f65265feeb2d817007a56b8265c97bc76";

/** This checkout: side B runs its src/cli.ts. */
export const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

/** Runs, picks and the saved settings live outside the repo, so nothing personal is committed. */
export function compareHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CASPER_COMPARE_HOME?.trim() || path.join(os.homedir(), "casper-compare");
}

export interface CompareConfig {
  /** The SkyN3t checkout (the folder with pyproject.toml). */
  skyn3tDir?: string;
}

export async function loadConfig(home: string): Promise<CompareConfig> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    return value && typeof value === "object" ? value as CompareConfig : {};
  } catch { return {}; }
}

export async function saveConfig(home: string, config: CompareConfig): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** One question on the terminal. A script with no terminal can't answer, so it stops and says which flag to pass. */
export async function ask(question: string, flag: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`No terminal to ask "${question.trim()}". Pass ${flag}.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

/** `~/x` → the home folder. */
export const expandHome = (value: string): string => value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
