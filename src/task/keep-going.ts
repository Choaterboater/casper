/** Keep going until done (docs/adr/0002/39-keep-going.md). A real session ended task after task with "Still not done"
 * lines the AI could do itself, and the person had to write "do all of them". When the AI stops with work open, or
 * says what it does next and stops, and asks the person nothing, Casper sends it on itself, a bounded number of times.
 * Read from the AI's own last words, like the ending line (src/task/ending.ts): no extra model call. */
import { taskEnding } from "./ending";
import { parseChecklist } from "./review";
import type { PlanStepReport } from "../flows/plan-build";

/** Rounds per task at most; a round that leaves as much open as before also ends them. */
export const KEEP_GOING_ROUNDS = 2;
/** Open items named in the prompt; the rest are counted. */
const ITEMS_SHOWN = 12;

export interface KeepGoingNeed { items: string[]; next: boolean }

/** Why the AI should carry on, from its last message: its "Still not done" lines, or its last words saying what it
 * does next. Undefined when it asked the person something, or finished with nothing open. */
export function keepGoingNeed(answer: string): KeepGoingNeed | undefined {
  const ending = taskEnding(answer);
  if (ending === "question") return undefined;
  const items = parseChecklist(answer)?.open ?? [];
  const next = ending === "next";
  return items.length || next ? { items, next } : undefined;
}

/** The words Casper sends: what is open (and the accepted plan's steps not reported done), do what you can, leave only
 * what needs the person, and say why. */
export function keepGoingPrompt(need: KeepGoingNeed, steps: ReadonlyArray<{ step: number; title: string }>): string {
  const open = [...need.items, ...steps.map(({ step, title }) => `Plan step ${step}: ${title}`)];
  const shown = open.slice(0, ITEMS_SHOWN).map(item => `- ${item}`);
  if (open.length > ITEMS_SHOWN) shown.push(`- and ${open.length - ITEMS_SHOWN} more`);
  return [
    open.length ? "Casper: you stopped with work still open." : "Casper: you stopped before the work was done.",
    ...(need.next ? ["You said what you do next and stopped: do it now."] : []),
    ...(open.length ? ["Still open:", ...shown] : []),
    "Do now what you can do yourself (edits, commands, tests, fixes to data). Leave only what needs the person (their device, account or a choice only they can make) and say why; for a choice, use the ask tool. End as before, with only what is still not done.",
  ].join("\n");
}

/** For the task after a build: the accepted plan's steps it left open, and where the plan is, so "finish it" or "do all
 * of them" has the list without reading Casper's own records. */
export function openPlanNote(file: string, steps: ReadonlyArray<{ step: number } & PlanStepReport>): string | undefined {
  if (!steps.length) return undefined;
  const listed = steps.map(({ step, title, status, reason }) => `${step}. ${title}${status === "not-done" && reason ? ` (not done: ${reason})` : ""}`);
  return `Open from the plan built earlier in this conversation (${file}): ${listed.join("; ")}. They are part of the work when the person asks to finish it.`;
}
