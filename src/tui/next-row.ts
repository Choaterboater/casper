/**
 * The one row of next steps printed under a receipt: "Next: 1 Show diff · 2 Undo · 3 Add a test …".
 *
 * Slots 1 and 2 always mean Show diff and Undo, so the same key does the same thing after every task, and 1, the key
 * a stray "1 more thing…" or an answer to the model's own "1)" list would hit, only shows something; other
 * steps (suggested flows, a page check, a lab check) start at 3. Nothing is asked and nothing waits: a lone
 * number typed on an empty prompt runs that step, and anything else typed is simply the next request. The AI
 * never picks from this row; only a key the user presses does.
 */
import { lineText } from "./format";

export const DIFF_SLOT = 1;
export const UNDO_SLOT = 2;
export const FIRST_EXTRA_SLOT = 3;
const LAST_SLOT = 9;

export interface NextItem {
  /** Plain words: "Undo", "Show diff", "Add a test that proves the fix". */
  label: string;
  /** What the key submits, exactly as if the user typed it: "/undo", "/diff 12". */
  command: string;
  /** A few words after the label: "uses tokens", "free". */
  note?: string;
  /** Why it is offered, or exactly what it will write; printed on its own line under the row. */
  why?: string;
}

export interface NextRow {
  /** The text to print under the receipt: the row, then one line per step that says why. */
  line: string;
  /** Which key submits which command. */
  keys: Map<string, string>;
}

const plain = (text: string) => lineText(text).replace(/\s+/g, " ").trim();

/** The row, or undefined when there is nothing to offer. Steps past 9 are left out: one key picks a step. */
export function buildNextRow(input: { undo?: NextItem; diff?: NextItem; more?: readonly NextItem[]; hint?: string }): NextRow | undefined {
  const slots: Array<[number, NextItem]> = [];
  if (input.diff) slots.push([DIFF_SLOT, input.diff]);
  if (input.undo) slots.push([UNDO_SLOT, input.undo]);
  (input.more ?? []).forEach((item, index) => slots.push([FIRST_EXTRA_SLOT + index, item]));
  const shown = slots.filter(([key, item]) => key <= LAST_SLOT && plain(item.label) && item.command.trim());
  if (!shown.length) return undefined;
  const keys = new Map(shown.map(([key, item]) => [String(key), item.command.trim()]));
  const row = `Next: ${shown.map(([key, item]) => `${key} ${plain(item.label)}${item.note ? ` (${plain(item.note)})` : ""}`).join(" · ")}`;
  const why = shown.filter(([, item]) => item.why && plain(item.why)).map(([key, item]) => `  ${key}: ${plain(item.why!)}`);
  const hint = input.hint && plain(input.hint) ? [`  ${plain(input.hint)}`] : [];
  return { line: [row, ...why, ...hint].join("\n"), keys };
}
