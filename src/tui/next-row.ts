/**
 * The one row of next steps printed under a receipt: "Next: 1 Undo · 2 Show diff · 3 Add a test …".
 *
 * Slots 1 and 2 always mean Undo and Show diff, so the same key does the same thing after every task; other
 * steps (suggested flows, a page check, a lab check) start at 3. Nothing is asked and nothing waits: a lone
 * number typed on an empty prompt runs that step, and anything else typed is simply the next request. The AI
 * never picks from this row; only a key the user presses does.
 */

export const UNDO_SLOT = 1;
export const DIFF_SLOT = 2;
export const FIRST_EXTRA_SLOT = 3;
const LAST_SLOT = 9;

export interface NextItem {
  /** Plain words: "Undo", "Show diff", "Add a test that proves the fix". */
  label: string;
  /** What the key submits, exactly as if the user typed it: "/undo", "/diff 12". */
  command: string;
  /** A few words after the label: "uses tokens", "free". */
  note?: string;
}

export interface NextRow {
  /** The line to print under the receipt. */
  line: string;
  /** Which key submits which command. */
  keys: Map<string, string>;
}

const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();

/** The row, or undefined when there is nothing to offer. Steps past 9 are left out: one key picks a step. */
export function buildNextRow(input: { undo?: NextItem; diff?: NextItem; more?: readonly NextItem[] }): NextRow | undefined {
  const slots: Array<[number, NextItem]> = [];
  if (input.undo) slots.push([UNDO_SLOT, input.undo]);
  if (input.diff) slots.push([DIFF_SLOT, input.diff]);
  (input.more ?? []).forEach((item, index) => slots.push([FIRST_EXTRA_SLOT + index, item]));
  const shown = slots.filter(([key, item]) => key <= LAST_SLOT && plain(item.label) && item.command.trim());
  if (!shown.length) return undefined;
  const keys = new Map(shown.map(([key, item]) => [String(key), item.command.trim()]));
  const line = `Next: ${shown.map(([key, item]) => `${key} ${plain(item.label)}${item.note ? ` (${plain(item.note)})` : ""}`).join(" · ")}`;
  return { line, keys };
}
