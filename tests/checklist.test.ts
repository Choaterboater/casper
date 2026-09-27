import { expect, test } from "bun:test";
import { extractChecklist, parseChecklistCases } from "../src/task/checklist";

test("the first JSON array in prose or a fence is the checklist", () => {
  expect(parseChecklistCases("Here are the cases [from the request]:\n```json\n[\"limit(0) throws \\\"limit must be positive\\\"\", \"returns [1, 2] in order\"]\n```\nDone."))
    .toEqual({ cases: ["limit(0) throws \"limit must be positive\"", "returns [1, 2] in order"] });
});

test("non-strings and blank entries are dropped; each case is one line of at most 200 characters", () => {
  expect(parseChecklistCases(`[1, null, {"case": "x"}, "  ", "empty input\\nreturns []\\u202e", "${"a".repeat(250)}"]`))
    .toEqual({ cases: ["empty input returns []", "a".repeat(200)] });
});

test("at most 40 cases are kept", () => {
  const { cases } = parseChecklistCases(JSON.stringify(Array.from({ length: 50 }, (_, index) => `case ${index}`))) as { cases: string[] };
  expect(cases).toHaveLength(40);
  expect(cases.at(-1)).toBe("case 39");
});

test("an answer without a JSON array, or with no usable case, is an error", () => {
  expect(parseChecklistCases("The request states no cases.")).toEqual({ error: "the checklist answer had no JSON array" });
  expect(parseChecklistCases("[unquoted, words]")).toEqual({ error: "the checklist answer had no JSON array" });
  expect(parseChecklistCases("[1, 2]")).toEqual({ error: "the checklist answer listed no cases" });
});

test("a failed model call is an error that keeps the call's usage", async () => {
  const usage = { tokens: 12, estimatedCost: 0.001 };
  expect(await extractChecklist({ complete: async () => ({ text: "[\"ignored\"]", error: "rate limited", usage }), request: "Add limit()" }))
    .toEqual({ error: "the checklist model call failed: rate limited", usage });
});
