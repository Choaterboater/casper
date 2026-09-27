import { expect, test } from "bun:test";
import { extractChecklist, normalizeCases, parseChecklistCases } from "../src/task/checklist";

test("the first JSON array in prose or a fence is the checklist", () => {
  expect(parseChecklistCases("Here are the cases [from the request]:\n```json\n[\"limit(0) throws \\\"limit must be positive\\\"\", \"returns [1, 2] in order\"]\n```\nDone."))
    .toEqual({ cases: ["limit(0) throws \"limit must be positive\"", "returns [1, 2] in order"], dropped: 0 });
});

test("non-strings and blank entries are dropped; each case is one line of at most 200 characters", () => {
  expect(parseChecklistCases(`[1, null, {"case": "x"}, "  ", "empty input\\nreturns []\\u202e", "${"a".repeat(250)}"]`))
    .toEqual({ cases: ["empty input returns []", "a".repeat(200)], dropped: 0 });
});

test("at most 80 cases are kept, and the ones left out are counted", () => {
  const { cases, dropped } = parseChecklistCases(JSON.stringify(Array.from({ length: 93 }, (_, index) => `case ${index}`))) as { cases: string[]; dropped: number };
  expect(cases).toHaveLength(80);
  expect(cases.at(-1)).toBe("case 79");
  expect(dropped).toBe(13);
});

test("a bullet or numbered list is read when the answer has no JSON array", () => {
  expect(parseChecklistCases("The cases:\n- limit(0) throws\n* the 6th call is rejected\n• reset clears a key\n1. size counts keys\n2) cost 0 is a probe\nThat is all."))
    .toEqual({ cases: ["limit(0) throws", "the 6th call is rejected", "reset clears a key", "size counts keys", "cost 0 is a probe"], dropped: 0 });
});

test("an array cut off at the answer budget keeps its complete cases", () => {
  expect(parseChecklistCases('```json\n["limit(0) throws", "message is \\"too many\\"", "the 6th ca'))
    .toEqual({ cases: ["limit(0) throws", 'message is "too many"'], dropped: 0 });
});

test("an answer without a JSON array, or with no usable case, is an error", () => {
  expect(parseChecklistCases("The request states no cases.")).toEqual({ error: "the checklist answer had no list of cases" });
  expect(parseChecklistCases("[unquoted, words]")).toEqual({ error: "the checklist answer had no list of cases" });
  expect(parseChecklistCases("[1, 2]")).toEqual({ error: "the checklist answer listed no cases" });
});

test("the call is low effort with room for a long list", async () => {
  let asked: { effort?: string; maxTokens?: number } = {};
  await extractChecklist({ complete: async (input) => { asked = input; return { text: "[\"a\"]", usage: null }; }, request: "Add limit()" });
  expect({ effort: asked.effort, maxTokens: asked.maxTokens }).toEqual({ effort: "low", maxTokens: 24000 });
});

test("a failed model call is an error that keeps the call's usage", async () => {
  const usage = { tokens: 12, estimatedCost: 0.001 };
  expect(await extractChecklist({ complete: async () => ({ text: "[\"ignored\"]", error: "rate limited", usage }), request: "Add limit()" }))
    .toEqual({ error: "the checklist model call failed: rate limited", usage });
});

test("edited lines get the answer's limits; a leading bullet and blank lines are dropped", () => {
  expect(normalizeCases(["- limit(0) throws", "  * returns [1, 2]‮ ", "", "   ", "-", "a\tb", "x".repeat(250)]))
    .toEqual(["limit(0) throws", "returns [1, 2]", "a b", "x".repeat(200)]);
  expect(normalizeCases(Array.from({ length: 90 }, (_, index) => `case ${index}`))).toHaveLength(80);
  expect(normalizeCases(["", " - "])).toEqual([]);
});
