/** One numbered-choice style for every question, box and picker (the ask box, approvals, sign-in, effort and the
 * plain terminal): each row's number, the hint under the rows, and which keys pick. Up to nine rows a digit picks at
 * once; past nine every row keeps its number, typed and sent with Enter, so no row is reachable by arrows alone. */

/** The most rows a single digit picks at once. */
export const KEY_PICK_MAX = 9;

/** "3 " in front of row 3, padded so a list past nine rows lines up (" 3 " beside "12 "). */
export function choiceNumber(index: number, count: number): string {
  return `${String(index + 1).padStart(String(count).length)} `;
}

/** The last row of a box that takes a typed answer (the AI's questions, a project name): picking it opens a line to
 * type the answer in. Casper adds it; it is never one of the asker's choices, and approvals and pickers don't have it. */
export const OTHER_CHOICE = "Other — type your own answer";

/** The keys part of the hint: "Press 1-4 or Up/Down + Enter", "Press 1 or Enter", or "Type 1-23 + Enter or Up/Down + Enter". */
export function choiceKeys(count: number): string {
  if (count <= 1) return "Press 1 or Enter";
  return count <= KEY_PICK_MAX ? `Press 1-${count} or Up/Down + Enter` : `Type 1-${count} + Enter or Up/Down + Enter`;
}

/** The hint under a numbered list: the keys, then what else the box takes ("Esc skip", "Esc is No"). */
export function choiceHint(count: number, ...rest: string[]): string {
  return [choiceKeys(count), ...rest].join(" · ");
}

/** The row a single key picks at once (a digit, while every row has one), or -1. */
export function keyChoice(key: string, count: number): number {
  const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
  return count <= KEY_PICK_MAX && digit < count ? digit : -1;
}

/** The row a typed number names ("12" and Enter, past nine rows), or -1. */
export function typedChoice(text: string, count: number): number {
  const number = /^\d{1,3}$/.test(text.trim()) ? Number(text.trim()) : 0;
  return count > KEY_PICK_MAX && number >= 1 && number <= count ? number - 1 : -1;
}

/** The plain terminal's prompt under numbered choices, the same for every question and box: "Type 1, 2 or 3: ",
 * or "Type 1-23: " past nine. Enter alone picks 1, which is always the safe choice. */
export function numberPrompt(count: number): string {
  if (count > KEY_PICK_MAX) return `Type 1-${count}: `;
  const digits = Array.from({ length: count }, (_, index) => String(index + 1));
  return `Type ${digits.length === 2 ? "1 or 2" : `${digits.slice(0, -1).join(", ")} or ${digits.at(-1)}`}: `;
}

/** A box's own record: given the chosen label, the line it leaves instead of "<question> → <answer>" ("" for none,
 * undefined for the usual one). A skipped box always leaves the usual line. */
export interface PickRecord { record?: (answer: string) => string | undefined }

/** What a closed question, picker or approval leaves in the transcript: one line, "<question> → <answer>", or
 * "<question> — skipped" when nobody answered (Esc, Ctrl+C, a stopped task). The question is its first line; the
 * choices, the hint and the lines under the question go with the box. */
export function answerRecord(question: string, answer: readonly string[] | undefined): { question: string; answer?: string } {
  const first = question.split("\n").map(line => line.trim()).find(Boolean) ?? "";
  const asked = first.replace(/\s+/g, " ").replace(/:$/, "");
  const said = answer?.map(part => part.replace(/\s+/g, " ").trim()).filter(Boolean).join(", ");
  return said ? { question: asked, answer: said } : { question: asked };
}

/** The record as plain text: "Pick a server → lab", "Make this change? → Yes, this once", "Settings — skipped". */
export function answerRecordText(question: string, answer: readonly string[] | undefined): string {
  const record = answerRecord(question, answer);
  return record.answer !== undefined ? `${record.question} → ${record.answer}` : `${record.question} — skipped`;
}
