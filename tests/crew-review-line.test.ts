import { expect, test } from "bun:test";
import { reviewerLine } from "../src/crew/review-line";

// A crew debug report: three of four reviewers showed "[crew] Reviewer 2: ## Findings" and nothing else.
test("a reviewer's line is the first line of its report that says something, without the Markdown", () => {
  expect(reviewerLine("## Findings\n\n1. **High:** HTML 502 responses become \"API unavailable\" (web/src/api/rest.ts:40)\n")).toBe("High: HTML 502 responses become \"API unavailable\" (web/src/api/rest.ts:40)");
  expect(reviewerLine("### Finding — Medium: testing an existing singleton ignores proposed settings")).toBe("Finding — Medium: testing an existing singleton ignores proposed settings");
  expect(reviewerLine("Summary:\n---\n- No findings.")).toBe("No findings.");
  expect(reviewerLine("No findings.")).toBe("No findings.");
  expect(reviewerLine("## Findings\n")).toBe("Review completed");
  expect(reviewerLine(undefined)).toBe("Review completed");
});
