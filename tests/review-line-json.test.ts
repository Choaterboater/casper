import { expect, test } from "bun:test";
import { reviewerLine } from "../src/crew/review-line";

test("a reviewer that answers with JSON gets a one-line summary, not the raw JSON", () => {
  // The comparison's blind review: "[crew] Reviewer 1: {"A": {"webPage": 7, "config": 8, … "reasons": {…".
  const json = JSON.stringify({ A: { webPage: 7, config: 8, quality: 8, reasons: { webPage: "All three pages load directly." } }, B: { webPage: 8, config: 8, quality: 8 } });
  expect(reviewerLine(json)).toBe("Review returned as data for A, B (the AI reads it)");
  expect(reviewerLine("```json\n" + json + "\n```")).toBe("Review returned as data for A, B (the AI reads it)");
  expect(reviewerLine('{"A": {"webPage": 7, "reasons": {"webPage": "cut off')).toBe("Review returned as data (the AI reads it)");
  expect(reviewerLine("No findings.")).toBe("No findings.");
});
