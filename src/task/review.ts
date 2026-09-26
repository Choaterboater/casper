/** The requirements review: before Casper finishes a fix or feature, the model checks its work against
 * every stated requirement and reports the gaps it fixed or left open, with a count. The answer is the
 * model's own claim, never Casper's evidence; admitted gaps still count against the result. */

/** done/open: the review's ticked and open lines (with a `total`, only the gaps it fixed or left open);
 * total: the requirement count from its "Covered: n of m" line, when it gave one. */
export type RequirementsReview =
  | { done: string[]; open: string[]; total?: number; incomplete?: true }
  | { missing: true; incomplete?: true };

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

/** "Covered: n of m requirements", tolerating markdown emphasis. Only m is kept: the open list decides. */
const COVERED = /^\s*\**Covered:?\**\s*(\d+)\s*of\s*(\d+)\b/im;

/** The review round's answer: its gap lines plus the requirement count. An answer with no gaps is only
 * the count; a legacy full checklist still reads, without a total. Undefined when it has neither. */
export function parseReview(answer: string): { done: string[]; open: string[]; total?: number } | undefined {
  const checklist = parseChecklist(answer);
  const covered = COVERED.exec(answer);
  if (!covered) return checklist;
  return { ...(checklist ?? { done: [], open: [] }), total: Number(covered[2]) };
}

/** The checklist lines parseChecklist reads; both the task turn and the review ask for exactly these. */
export const CHECKLIST_FORMAT: readonly string[] = [
  "Requirements:",
  "- [x] <requirement> — <the test that covers it>",
  "- [ ] <requirement> — <why it is still not done>",
];

/** Checks every case but answers only the gaps: a full re-listed checklist made the answer 3.7-4.9x
 * Pi's length and the round 41-44% of the wall time, with no first-time-right gain in pinned runs. */
export function requirementsReviewPrompt(request: string): string {
  return [
    "Casper requirements review.",
    "The checks pass. Now find what the request asks for that no test checks yet.",
    "Go through every requirement that the request and the project's docs (for example CONTEXT.md) state: each behavior, output format, order, default, limit, error case and edge case, including the small ones.",
    "Check one case at a time. A rule that covers several inputs, options or errors is several requirements (for example: each missing option, each malformed value, an unknown option).",
    "If your earlier answer ends with a checklist, start from it: add what it missed and split what it merged. Work from what you have already read; reopen a file only to check a detail.",
    "A requirement is covered only when a test you can name asserts it; code that merely looks right or an unasserted claim is not enough. For every uncovered one, add the test now and fix the code if it fails. Do not weaken, skip or delete tests. Run the tests once your additions are done.",
    "Your answer reports only the gaps, one case per line: do not list requirements that were already covered and do not summarize the change. End it with:",
    "Requirements review:",
    "- [x] <requirement> — <the test you added for it>",
    "- [ ] <requirement> — <why it is still not done>",
    "Covered: <n> of <m> requirements.",
    "With no gaps, answer only:",
    "Requirements review: all covered.",
    "Covered: <m> of <m> requirements.",
    "Original request:",
    request,
  ].join("\n");
}
