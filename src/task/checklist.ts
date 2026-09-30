import type { AcceptanceCompletion } from "../verify/acceptance";

/** verification.checklist: the concrete cases a request states, listed by one model call outside the
 * task conversation before the model's turn, so the model can test each one. */
export const CHECKLIST_SYSTEM_PROMPT = "Casper checklist. List every concrete behavior case the request states: inputs and the outputs they must give, errors and when they happen, boundaries and edge values, orders, and formats. Write each case as one short line that quotes the request's specifics (names, values, messages). Leave out process instructions such as which files to read, which dependencies to use, or keeping existing tests. Do not add cases the request does not state. Answer with only a JSON array of strings.";

/** Listing cases is a short answer, so the call is low effort. A long request can still list 50-60
 * cases and some models reason at length first, so the answer has room: at 8,000 tokens DeepSeek V4.1
 * Flash ran out on 7 of 12 long requests and listed nothing. */
const EFFORT = "low";
const MAX_TOKENS = 24_000;
const CASE_LIMIT = 200;
const CASE_COUNT = 80;

/** `dropped`: cases the answer listed beyond the 80 kept, so a cut list is never silent. */
export type ChecklistResult = ({ cases: string[]; dropped: number } | { error: string }) & {
  /** null when the provider reported none. */
  usage: { tokens: number; estimatedCost: number } | null;
};

export async function extractChecklist(input: { complete: AcceptanceCompletion; request: string; signal?: AbortSignal }): Promise<ChecklistResult> {
  const answer = await input.complete({ systemPrompt: CHECKLIST_SYSTEM_PROMPT, user: `Request:\n${input.request}`, signal: input.signal, effort: EFFORT, maxTokens: MAX_TOKENS });
  const usage = answer.usage;
  if (answer.error !== undefined) return { error: `the checklist model call failed: ${answer.error}`, usage };
  const parsed = parseChecklistCases(answer.text);
  return "error" in parsed ? { ...parsed, usage } : { cases: parsed.cases, dropped: parsed.dropped, usage };
}

/** The answer's cases, read from the first JSON array (prose or a fence around it is fine); failing
 * that, from an array the answer budget cut off (its complete strings); failing that, from a bullet
 * or numbered list. Kept as normalizeCases keeps them, with the count left out past the 80th. */
export function parseChecklistCases(text: string): { cases: string[]; dropped: number } | { error: string } {
  const array = firstJsonArray(text);
  const listed = array ? array.filter((item): item is string => typeof item === "string") : cutOffArray(text) ?? listLines(text);
  if (!listed) return { error: "the checklist answer had no list of cases" };
  const all = cleanCases(listed);
  return all.length ? { cases: all.slice(0, CASE_COUNT), dropped: Math.max(0, all.length - CASE_COUNT) } : { cases: [], dropped: 0 };
}

/** Cases as Casper keeps them, from the model's answer or the user's edit: each on one line without
 * control characters or a leading bullet, at most 200 characters, blank ones dropped, at most 80. */
export function normalizeCases(lines: readonly string[]): string[] {
  return cleanCases(lines).slice(0, CASE_COUNT);
}

function cleanCases(lines: readonly string[]): string[] {
  return lines
    .map((item) => item.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()
      .replace(/^[-*•](?: |$)/, "").trim().slice(0, CASE_LIMIT).trimEnd())
    .filter(Boolean);
}

/** An array whose closing `]` never came (the answer hit its budget): the complete strings after the first `[`. */
function cutOffArray(text: string): string[] | undefined {
  const start = text.indexOf("[");
  if (start === -1) return undefined;
  const strings = [...text.slice(start).matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map(([literal]) => {
    try { return JSON.parse(literal) as string; } catch { return undefined; }
  }).filter((item): item is string => item !== undefined);
  return strings.length ? strings : undefined;
}

/** Lines starting `- `, `* `, `• `, `1. ` or `1) `: a list the model wrote instead of JSON. */
function listLines(text: string): string[] | undefined {
  const items = text.split(/\r?\n/).map((line) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line)?.[1]).filter((item): item is string => Boolean(item));
  return items.length ? items : undefined;
}

/** Scans from each `[` to its matching `]` (skipping brackets inside strings) and returns the first
 * span that parses as a JSON array. */
function firstJsonArray(text: string): unknown[] | undefined {
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (char === "\\") index++;
        else if (char === "\"") inString = false;
      } else if (char === "\"") inString = true;
      else if (char === "[") depth++;
      else if (char === "]" && --depth === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(start, index + 1));
          if (Array.isArray(value)) return value;
        } catch { /* not JSON: try the next `[` */ }
        break;
      }
    }
  }
  return undefined;
}

/** The section appended to the task prompt. */
export function formatChecklistPrompt(cases: readonly string[]): string {
  return `Cases your request states (Casper's checklist). Handle every one, and write one test per case that asserts exactly that case:\n${cases.map((item) => `- ${item}`).join("\n")}`;
}
