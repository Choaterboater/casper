/** How much of the work shows on screen. quiet: the model's words, failures and receipts. normal: steps fold
 * into one row naming what was done, with edits and failures in a box. detailed: every step, and every edit's diff. */
export const DISPLAY_LEVELS = ["quiet", "normal", "detailed"] as const;
export type DisplayLevel = typeof DISPLAY_LEVELS[number];

/** /details with no word: the next level, round the list. */
export function nextDisplay(level: DisplayLevel): DisplayLevel {
  return DISPLAY_LEVELS[(DISPLAY_LEVELS.indexOf(level) + 1) % DISPLAY_LEVELS.length]!;
}

/** One changed line of a unified diff: added or removed, and its text. */
export interface DiffLine { sign: "+" | "-"; text: string }

/** The changed lines of a unified diff's hunks, in order (the file headers and context lines left out). */
export function diffLines(patch: string): DiffLine[] {
  const changed: DiffLine[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (inHunk && /^[+-]/.test(line)) changed.push({ sign: line[0] as "+" | "-", text: line.slice(1) });
  }
  return changed;
}

/** The changed lines of a unified diff, indented under the edit's line; at most `max`, then how many more. */
export function inlineDiff(patch: string, max = 12): string[] {
  const changed = diffLines(patch).map(line => `    ${line.sign} ${line.text}`);
  if (changed.length <= max) return changed;
  return [...changed.slice(0, max), `    … ${changed.length - max} more lines · /diff after the task shows them all`];
}
