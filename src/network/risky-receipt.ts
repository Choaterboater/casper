/**
 * Risky config lines in the receipt: after a task, the config files it changed are read with GreenCLI's checker
 * (risky-lines.ts) and each dangerous line (reload, shutdown, erase, delete interfaces …) is listed with what it
 * does. Shown for reading only; never a pass or a fail.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { scrubText } from "../secrets/scrub";
import { classifyLine } from "./risky-lines";

export interface RiskyLine { file: string; line: number; text: string; reason: string }

const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINES = 20;

/** Config files: anything under a configs/ folder, and .cfg, .conf and Junos .set files. */
export function isConfigFile(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  return parts.slice(0, -1).includes("configs") || /\.(cfg|conf|set)$/i.test(relative);
}

/** The dangerous lines in the changed config files (project-relative paths), at most 20, secrets hidden. */
export async function riskyLinesIn(root: string, changed: readonly string[]): Promise<RiskyLine[]> {
  const found: RiskyLine[] = [];
  for (const file of changed.filter(isConfigFile)) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    let text: string;
    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      text = await readFile(absolute, "utf8");
    } catch { continue; }
    const lines = text.split(/\r\n|\r|\n/);
    for (let index = 0; index < lines.length && found.length < MAX_LINES; index++) {
      const verdict = classifyLine(lines[index]!);
      if (verdict.kind !== "dangerous") continue;
      const shown = scrubText(lines[index]!.trim()).text;
      found.push({ file: relative.split(path.sep).join("/"), line: index + 1, text: shown.length > 80 ? `${shown.slice(0, 77)}…` : shown, reason: verdict.reason! });
    }
  }
  return found;
}
