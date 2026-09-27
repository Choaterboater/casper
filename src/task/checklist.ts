import type { AcceptanceCompletion } from "../verify/acceptance";

/** verification.checklist: the concrete cases a request states, listed by one model call outside the
 * task conversation before the model's turn, so the model can test each one. */
export const CHECKLIST_SYSTEM_PROMPT = "Casper checklist. List every concrete behavior case the request states: inputs and the outputs they must give, errors and when they happen, boundaries and edge values, orders, and formats. Write each case as one short line that quotes the request's specifics (names, values, messages). Leave out process instructions such as which files to read, which dependencies to use, or keeping existing tests. Do not add cases the request does not state. Answer with only a JSON array of strings.";

/** Listing cases is a short answer: a low-effort call with a capped answer is enough. */
const EFFORT = "low";
const MAX_TOKENS = 8000;
const CASE_LIMIT = 200;
const CASE_COUNT = 40;

export type ChecklistResult = ({ cases: string[] } | { error: string }) & {
  /** null when the provider reported none. */
  usage: { tokens: number; estimatedCost: number } | null;
};

export async function extractChecklist(input: { complete: AcceptanceCompletion; request: string; signal?: AbortSignal }): Promise<ChecklistResult> {
  const answer = await input.complete({ systemPrompt: CHECKLIST_SYSTEM_PROMPT, user: `Request:\n${input.request}`, signal: input.signal, effort: EFFORT, maxTokens: MAX_TOKENS });
  const usage = answer.usage;
  if (answer.error !== undefined) return { error: `the checklist model call failed: ${answer.error}`, usage };
  const parsed = parseChecklistCases(answer.text);
  return "error" in parsed ? { ...parsed, usage } : { cases: parsed.cases, usage };
}

/** The first JSON array in the answer (prose or a fence around it is fine): its non-empty strings,
 * each on one line without control characters, at most 200 characters, at most 40 of them. */
export function parseChecklistCases(text: string): { cases: string[] } | { error: string } {
  const array = firstJsonArray(text);
  if (!array) return { error: "the checklist answer had no JSON array" };
  const cases = array
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, CASE_LIMIT).trimEnd())
    .filter(Boolean)
    .slice(0, CASE_COUNT);
  return cases.length ? { cases } : { error: "the checklist answer listed no cases" };
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
