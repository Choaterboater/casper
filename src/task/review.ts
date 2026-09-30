/** The requirements review: before Casper finishes a fix or feature, the model checks its work against
 * every stated requirement and reports the gaps it fixed or left open, with a count. The answer is the
 * model's own claim, never Casper's evidence; admitted gaps still count against the result. */

/** Two shapes, so `done` means one thing. A full checklist (the first answer's, or a legacy review
 * answer): done/open are every ticked and open requirement. The review's delta answer: fixed/open are
 * only the gaps it added tests or fixes for and those still open, with covered/total from its
 * "Covered: n of m" line (absent after a bare "all covered."). incomplete: the review round hit
 * ROUND_MAX_TURNS before it ended, and the checklist (if any) is from its last answer. */
export type RequirementsReview =
  | { done: string[]; open: string[]; incomplete?: true }
  | { fixed: string[]; open: string[]; covered?: number; total?: number; incomplete?: true }
  | { missing: true; incomplete?: true };

/** Model turns each round after the task turn (the requirements review, the proof repair) may take.
 * Decided in Phase 4a: the review was 41-44% of Casper's wall time and added no first-time-right
 * in pinned runs, so it is off by default; the proof round keeps the same 12 turns. A round still
 * working after 12 turns is exploring, not checking. A smaller --max-turns wins and stays the task's
 * own stop. */
export const ROUND_MAX_TURNS = 12;

const ITEM = /^\s*[-*]\s*\[([ xX])\]\s+(.+?)\s*$/;
const MAX_DONE = 50;
const MAX_ITEM_CHARS = 300;

/** Checkbox lines from the answer; undefined when it has none. Ticked items are capped at 50 for the
 * receipt; open items never are, since an admitted gap makes the change not verified. */
export function parseChecklist(answer: string): { done: string[]; open: string[] } | undefined {
  const done: string[] = [];
  const open: string[] = [];
  for (const line of answer.split(/\r?\n/)) {
    const item = ITEM.exec(line);
    if (!item || (item[1] !== " " && done.length >= MAX_DONE)) continue;
    const text = item[2]!.length > MAX_ITEM_CHARS ? `${item[2]!.slice(0, MAX_ITEM_CHARS - 1)}…` : item[2]!;
    (item[1] === " " ? open : done).push(text);
  }
  return done.length || open.length ? { done, open } : undefined;
}

/** "Covered: n of m requirements" at the start of a line, tolerating markdown emphasis; the colon is required
 * so prose ("we covered 3 of 3") is not a count. */
const COVERED = /^[ \t]*\**Covered:\**[ \t]*(\d+)[ \t]*of[ \t]*(\d+)\b/im;
/** The delta answer's heading; a bare "Requirements review: all covered." is all covered without a count. */
const DELTA = /^[ \t]*\**Requirements review:/im;
const ALL_COVERED = /^[ \t]*\**Requirements review:\**[ \t]*all covered\b/im;

/** The review round's answer: its gap lines plus the requirement count (the delta format), or a legacy
 * full checklist without a count. Undefined when it has neither. */
export function parseReview(answer: string): RequirementsReview | undefined {
  const checklist = parseChecklist(answer);
  const covered = COVERED.exec(answer);
  if (!covered && !(checklist ? DELTA : ALL_COVERED).test(answer)) return checklist;
  return { fixed: checklist?.done ?? [], open: checklist?.open ?? [],
    ...(covered ? { covered: Number(covered[1]), total: Number(covered[2]) } : {}) };
}

/** The checklist format parseChecklist reads. The task turn asks only for its open-item line (the gaps; a full
 * ticked list made answers long and is the model's own claim anyway); the review's delta answer reuses that line
 * under its own heading and a count. */
export const OPEN_ITEM_FORMAT = "- [ ] <requirement> — <why it is still not done>";
export const CHECKLIST_FORMAT: readonly string[] = [
  "Requirements:",
  "- [x] <requirement> — <the test that covers it>",
  OPEN_ITEM_FORMAT,
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
    OPEN_ITEM_FORMAT,
    "Covered: <n> of <m> requirements.",
    "With no gaps, answer only:",
    "Requirements review: all covered.",
    "Covered: <m> of <m> requirements.",
    "Original request:",
    request,
  ].join("\n");
}
