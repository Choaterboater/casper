/** The requirements review: before Casper finishes a fix or feature, the model checks its work against
 * every stated requirement and ends with a checklist. The checklist is the model's own claim, never
 * Casper's evidence; admitted gaps still count against the result. */

export type RequirementsReview = { done: string[]; open: string[] } | { missing: true };

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

export function requirementsReviewPrompt(request: string): string {
  return [
    "Casper requirements review.",
    "Before Casper finishes, check your work against the request one requirement at a time. List every requirement that the request and the project's docs (for example CONTEXT.md) state: each behavior, output format, limit, error case and edge case, including the small ones.",
    "For each one, confirm the code implements it and a test exercises it. Fix every gap now: implement what is missing and add the missing tests. Do not weaken, skip or delete tests.",
    "End your answer with this checklist, one line per requirement:",
    "Requirements:",
    "- [x] <requirement> — <the test that covers it>",
    "- [ ] <requirement> — <why it is still not done>",
    "Original request:",
    request,
  ].join("\n");
}
