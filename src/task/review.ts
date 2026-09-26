/** The requirements review: before Casper finishes a fix or feature, the model checks its work against
 * every stated requirement and ends with a checklist. The checklist is the model's own claim, never
 * Casper's evidence; admitted gaps still count against the result. */

/** `incomplete`: the review round hit REVIEW_MAX_TURNS before it ended; the checklist (if any) is from its last answer. */
export type RequirementsReview =
  | { done: string[]; open: string[]; total?: number; incomplete?: true }
  | { missing: true; incomplete?: true };

/** Model turns the review round (and the proof repair round) may take. Pinned benchmarks: the review was
 * 41-44% of Casper's wall time and, on the latest runs, added no first-time-right over no review at all;
 * a round that is still working after 12 turns is exploring, not checking. A smaller --max-turns wins
 * and stays the task's own stop. */
export const REVIEW_MAX_TURNS = 12;

const ITEM = /^\s*[-*]\s*\[([ xX])\]\s+(.+?)\s*$/;
const MAX_ITEMS = 50;
const MAX_ITEM_CHARS = 300;

/** Checkbox lines from the answer; undefined when it has none. */
export function parseChecklist(answer: string): { done: string[]; open: string[] } | undefined {
  const done: string[] = [];
  const open: string[] = [];
  for (const line of answer.split(/\r?\n/)) {
    const item = ITEM.exec(line);
    if (!item || done.length + open.length >= MAX_ITEMS) continue;
    const text = item[2]!.length > MAX_ITEM_CHARS ? `${item[2]!.slice(0, MAX_ITEM_CHARS - 1)}…` : item[2]!;
    (item[1] === " " ? open : done).push(text);
  }
  return done.length || open.length ? { done, open } : undefined;
}

/** The checklist lines parseChecklist reads; both the task turn and the review ask for exactly these. */
export const CHECKLIST_FORMAT: readonly string[] = [
  "Requirements:",
  "- [x] <requirement> — <the test that covers it>",
  "- [ ] <requirement> — <why it is still not done>",
];

export function requirementsReviewPrompt(request: string): string {
  return [
    "Casper requirements review.",
    "The checks pass. Now find what the request asks for that no test checks yet.",
    "List every requirement that the request and the project's docs (for example CONTEXT.md) state: each behavior, output format, order, default, limit, error case and edge case, including the small ones.",
    "Give each case its own line. A rule that covers several inputs, options or errors is several requirements (for example: each missing option, each malformed value, an unknown option).",
    "If your earlier answer ends with a checklist, start from it: add what it missed and split what it merged. Work from what you have already read; reopen a file only to check a detail.",
    "Tick a requirement only when a test you can name asserts it; code that merely looks right or an unasserted claim is not enough. For every unticked line, add the test now and fix the code if it fails. Do not weaken, skip or delete tests. Run the tests once your additions are done.",
    "End your answer with this checklist, one line per requirement:",
    ...CHECKLIST_FORMAT,
    "Original request:",
    request,
  ].join("\n");
}
