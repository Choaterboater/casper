import { openQuestions, type ParsedPlan } from "./plan";

/** What a plan rewrite changed: per section, the lines removed (-) and added (+) in order, and their counts. */
export interface PlanChanges { added: number; removed: number; rows: string[] }

const SECTIONS: ReadonlyArray<readonly [string, (plan: ParsedPlan) => readonly string[] | undefined]> = [
  ["Title", plan => plan.title ? [plan.title] : undefined],
  ["Note", plan => plan.note],
  ["Goal", plan => plan.goal],
  ["What I found", plan => plan.found],
  ["What you'll see", plan => [...plan.see ?? [], ...plan.mockup ?? []]],
  ["Screens", plan => plan.screens],
  ["Data", plan => plan.data],
  ["Look", plan => plan.look],
  ["First version", plan => plan.firstVersion],
  ["Later", plan => plan.later],
  ["Steps", plan => plan.steps.map((step, index) => `${index + 1}. ${step}`)],
  ["Done means", plan => plan.tests.map((item, index) => `${index + 1}. ${item}`)],
  ["Open questions", plan => openQuestions(plan)],
  ["Details", plan => plan.details],
];

/** A line as shown: one line, without its bullet. A step keeps its number. */
const shown = (line: string) => line.trim().replace(/^[-*+•]\s+/, "").replace(/\s+/g, " ");
/** A line as compared: without its number too, so a step that only moved down one is not a change. */
const key = (line: string) => shown(line).replace(/^\d+[.)]\s+/, "");

type Edit = { kind: "-" | "+"; line: string };

/** The removals and additions that turn `before` into `after`, in order (a longest common subsequence). */
function edits(before: readonly string[], after: readonly string[]): Edit[] {
  const a = before.filter(line => line.trim()), b = after.filter(line => line.trim());
  const ka = a.map(key), kb = b.map(key);
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] = ka[i] === kb[j] ? common[(i + 1) * width + j + 1]! + 1 : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }
  const result: Edit[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && ka[i] === kb[j]) { i++; j++; }
    else if (j >= b.length || (i < a.length && common[(i + 1) * width + j]! >= common[i * width + j + 1]!)) result.push({ kind: "-", line: a[i++]! });
    else result.push({ kind: "+", line: b[j++]! });
  }
  return result;
}

/** What a rewrite changed, section by section, for a plan too long to print again: at most `limit` rows, then how many
 * more changed lines there are. Nothing changed is no rows. */
export function planChanges(before: ParsedPlan, after: ParsedPlan, limit = 24): PlanChanges {
  let added = 0, removed = 0, hidden = 0;
  const rows: string[] = [];
  for (const [heading, lines] of SECTIONS) {
    const changed = edits(lines(before) ?? [], lines(after) ?? []);
    if (!changed.length) continue;
    for (const edit of changed) if (edit.kind === "+") added++; else removed++;
    if (rows.length >= limit) { hidden += changed.length; continue; }
    rows.push(heading);
    for (const edit of changed) {
      if (rows.length >= limit) hidden++;
      else rows.push(`  ${edit.kind} ${shown(edit.line)}`);
    }
  }
  if (hidden) rows.push(`  … ${hidden} more changed ${hidden === 1 ? "line" : "lines"}`);
  return { added, removed, rows };
}
