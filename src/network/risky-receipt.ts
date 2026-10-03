/**
 * Risky config lines in the receipt: after a task, the config files it changed are read with GreenCLI's checker
 * (risky-lines.ts) and each dangerous line the task added (reload, shutdown, erase, delete interfaces …) is listed
 * with what it does. Lines that were already there (a baseline taken at task start), and comment lines, are not.
 * Shown for reading only; never a pass or a fail.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { scrubText } from "../secrets/scrub";
import { classifyLine } from "./risky-lines";

export interface RiskyLine { file: string; line: number; text: string; reason: string }
/** Each config file's dangerous lines (trimmed text → how many times), from before the task. */
export type RiskyBaseline = Map<string, Map<string, number>>;

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINES = 20;
const MAX_BASELINE_FILES = 300;
const COMMENT = /^\s*(?:!|#|\/\/|\/\*)/;

/** Config files: anything under a configs/ folder, and .cfg, .conf and Junos .set files. */
export function isConfigFile(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  return parts.slice(0, -1).includes("configs") || /\.(cfg|conf|set)$/i.test(relative);
}

/** A plain file inside the project (not a link out of it), read as text; undefined otherwise. */
async function readInside(root: string, relative: string): Promise<{ file: string; text: string } | undefined> {
  const absolute = path.resolve(root, relative);
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const [real, realRoot] = await Promise.all([realpath(absolute), realpath(root)]);
    const inside = path.relative(realRoot, real);
    if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
    return { file: path.relative(root, absolute).split(path.sep).join("/"), text: await readFile(absolute, "utf8") };
  } catch { return undefined; }
}

function dangerous(text: string): { index: number; line: string; reason: string }[] {
  const found: { index: number; line: string; reason: string }[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (COMMENT.test(line)) continue;
    const verdict = classifyLine(line);
    if (verdict.kind === "dangerous") found.push({ index, line: line.trim(), reason: verdict.reason! });
  }
  return found;
}

/** The dangerous lines already in the project's config files (taken at task start). */
export async function riskyBaseline(root: string, paths: readonly string[]): Promise<RiskyBaseline> {
  const baseline: RiskyBaseline = new Map();
  for (const relative of paths.filter(isConfigFile).slice(0, MAX_BASELINE_FILES)) {
    const read = await readInside(root, relative);
    if (!read) continue;
    const counts = new Map<string, number>();
    for (const { line } of dangerous(read.text)) counts.set(line, (counts.get(line) ?? 0) + 1);
    if (counts.size) baseline.set(read.file, counts);
  }
  return baseline;
}

/** The dangerous lines the task added to the changed config files: at most 20, secrets hidden; `more` counts the rest. */
export async function riskyLinesIn(root: string, changed: readonly string[], baseline: RiskyBaseline = new Map()): Promise<RiskyLine[] & { more?: number }> {
  const found: RiskyLine[] & { more?: number } = [];
  let more = 0;
  for (const relative of changed.filter(isConfigFile)) {
    const read = await readInside(root, relative);
    if (!read) continue;
    const before = new Map(baseline.get(read.file) ?? []);
    for (const { index, line, reason } of dangerous(read.text)) {
      const left = before.get(line) ?? 0;
      if (left > 0) { before.set(line, left - 1); continue; }
      if (found.length >= MAX_LINES) { more++; continue; }
      const shown = scrubText(line).text;
      found.push({ file: read.file, line: index + 1, text: shown.length > 80 ? `${shown.slice(0, 77)}…` : shown, reason });
    }
  }
  if (more) found.more = more;
  return found;
}
