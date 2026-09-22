import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { openNoFollow } from "../platform/files";
import type { TaskIntent } from "../task/classify";

export const AUTO_EFFORT = "auto";

/** Pi's thinking levels from lightest to heaviest; a model supports a subset. */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Casper's per-request choice when effort is `auto`: reading, explaining and drawing get light
 * reasoning; changing code gets heavy reasoning. The result is the lightest supported level at
 * or above the target, or the heaviest supported level when none reaches it.
 */
export function autoEffortLevel(intent: TaskIntent, available: readonly string[]): string | undefined {
  const target = intent === "fix" || intent === "implement" || intent === "refactor" ? "high" : intent === "test" || intent === "configure" ? "medium" : "low";
  const supported = LEVELS.filter((level) => available.includes(level));
  if (!supported.length) return available[0];
  const floor = LEVELS.indexOf(target);
  return supported.find((level) => LEVELS.indexOf(level) >= floor) ?? supported.at(-1);
}

const FILE = "effort.json";

/** The remembered `auto` choice lives beside Casper's settings, never inside Pi's typed thinking levels. */
export async function readAutoEffort(home: string): Promise<boolean> {
  try {
    const file = await openNoFollow(path.join(home, ".casper", FILE));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024) return false;
      const buffer = Buffer.alloc(1025);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      return typeof value === "object" && value !== null && Reflect.get(value, "mode") === AUTO_EFFORT;
    } finally { await file.close(); }
  } catch { return false; }
}

export async function writeAutoEffort(home: string, enabled: boolean): Promise<void> {
  const target = path.join(home, ".casper", FILE);
  if (!enabled) { await rm(target, { force: true }); return; }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ mode: AUTO_EFFORT })}\n`, { mode: 0o600 });
}
