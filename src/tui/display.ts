/** How much of the work shows on screen. quiet: the model's words, failures and receipts. normal: steps fold
 * into one summary line, with the changed files under it. detailed: every step, with a small diff under each edit. */
export const DISPLAY_LEVELS = ["quiet", "normal", "detailed"] as const;
export type DisplayLevel = typeof DISPLAY_LEVELS[number];

/** /details with no word: the next level, round the list. */
export function nextDisplay(level: DisplayLevel): DisplayLevel {
  return DISPLAY_LEVELS[(DISPLAY_LEVELS.indexOf(level) + 1) % DISPLAY_LEVELS.length]!;
}

/** The changed lines of a unified diff, indented under the edit's line; at most `max`, then how many more. */
export function inlineDiff(patch: string, max = 12): string[] {
  const changed: string[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (inHunk && /^[+-]/.test(line)) changed.push(`    ${line.slice(0, 1)} ${line.slice(1)}`);
  }
  if (changed.length <= max) return changed;
  return [...changed.slice(0, max), `    … ${changed.length - max} more lines · /diff after the task shows them all`];
}
