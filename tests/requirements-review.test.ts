import { expect, test } from "bun:test";
import { CHECKLIST_FORMAT, parseChecklist, parseReview, requirementsReviewPrompt } from "../src/task/review";
import { formatTaskPrompt } from "../src/task/classify";
import { formatReceipt, formatTaskResult, taskOutcome, type TaskResult } from "../src/task/result";
import type { VerificationReport, VerificationResult } from "../src/verify/evidence";

test("the review checklist is read from the model's answer: ticked and open requirements", () => {
  expect(parseChecklist([
    "I rechecked everything and added a timeout test.",
    "",
    "Requirements:",
    "- [x] `--json` prints one array line — tests/json.test.ts",
    "* [X] tls-error for a non-TLS listener — tests/tls.test.ts",
    "- [ ] handshake timeout — not implemented: node:tls has no handshake timeout option",
  ].join("\n"))).toEqual({
    done: ["`--json` prints one array line — tests/json.test.ts", "tls-error for a non-TLS listener — tests/tls.test.ts"],
    open: ["handshake timeout — not implemented: node:tls has no handshake timeout option"],
  });
  // No checklist at all is not an empty one.
  expect(parseChecklist("Everything is covered.")).toBeUndefined();
});

test("the review prompt checks every stated requirement, from the request and the project docs, but answers only the gaps", () => {
  const prompt = requirementsReviewPrompt("Add --tls to portcheck.");
  expect(prompt).toContain("Add --tls to portcheck.");
  expect(prompt).toContain("CONTEXT.md");
  expect(prompt).toContain("each behavior, output format, order, default, limit, error case and edge case");
  // A: only a named test that asserts it counts as covered; anything else is added now or left open.
  expect(prompt).toContain("covered only when a test you can name asserts it");
  // A rule over several inputs, options or errors was checked as one case and half tested.
  expect(prompt).toContain("Check one case at a time");
  expect(prompt).toContain("Do not weaken, skip or delete tests");
  expect(prompt).toContain("Run the tests once");
  // The answer re-listed every covered requirement (3.7-4.9x Pi's length); it now names only gaps and a count.
  expect(prompt).toContain("- [x] <requirement> — <the test you added for it>");
  expect(prompt).toContain("- [ ] <requirement> — <why it is still not done>");
  // The open-item line is the task turn's own, so both rounds read the same way.
  expect(prompt).toContain(CHECKLIST_FORMAT[2]!);
  expect(prompt).toContain("Covered: <n> of <m> requirements.");
  expect(prompt).toContain("Requirements review: all covered.\nCovered: <m> of <m> requirements.");
  expect(prompt).toContain("do not list requirements that were already covered");
});

test("the review answer is read as its gaps plus the requirement count", () => {
  // Delta: only what the review fixed (fixed) or left open, and the count. done is only ever a full checklist.
  expect(parseReview([
    "Requirements review:",
    "- [x] unknown option exits 2 — tests/cli.test.ts",
    "- [ ] handshake timeout — node:tls has no option",
    "Covered: 5 of 6 requirements.",
  ].join("\n"))).toEqual({ fixed: ["unknown option exits 2 — tests/cli.test.ts"], open: ["handshake timeout — node:tls has no option"], covered: 5, total: 6 });
  // No gaps: the explicit all-covered answer, markdown emphasis allowed.
  expect(parseReview("Requirements review: all covered.\nCovered: 7 of 7 requirements.")).toEqual({ fixed: [], open: [], covered: 7, total: 7 });
  expect(parseReview("**Covered:** 3 of 3 requirements")).toEqual({ fixed: [], open: [], covered: 3, total: 3 });
  // Both numbers are kept: the open list decides the outcome, the count the wording.
  expect(parseReview("Covered: 2 of 3 requirements.")).toEqual({ fixed: [], open: [], covered: 2, total: 3 });
  // The all-covered answer without its count is still all covered, just uncounted.
  expect(parseReview("Requirements review: all covered.")).toEqual({ fixed: [], open: [] });
  expect(parseReview("**Requirements review:** all covered")).toEqual({ fixed: [], open: [] });
  // The delta header with gap lines but no count is still the delta format.
  expect(parseReview("Requirements review:\n- [x] a — t1")).toEqual({ fixed: ["a — t1"], open: [] });
  // A legacy full checklist still reads as before, without a count.
  expect(parseReview("Requirements:\n- [x] a — t1\n- [x] b — t2")).toEqual({ done: ["a — t1", "b — t2"], open: [] });
  // Neither a checklist nor a count is no review at all.
  expect(parseReview("Everything is covered.")).toBeUndefined();
  // The count needs its colon, at the start of a line.
  expect(parseReview("Covered 3 of 3 requirements.")).toBeUndefined();
  expect(parseReview("I think we have covered: 3 of 3 requirements.")).toBeUndefined();
  expect(parseReview("The tests are all covered.")).toBeUndefined();
});

test("a change the review will check gets the request itself as its first turn, as Pi sends it", () => {
  const model = { commands: { test: "npm test" } } as unknown as Parameters<typeof formatTaskPrompt>[2];
  // The review asks for every requirement and its test afterwards; asking in the first turn too made the
  // model enumerate tests before it had working code (pinned ablation: same accuracy, fewer turns without).
  expect(formatTaskPrompt("Add --tls to `portcheck`.", { intent: "implement", mode: "modify", verification: [] }, model,
    { verificationMode: "auto", proveChange: true, reviewFollows: true })).toBe("Add --tls to `portcheck`.");
  // After project facts or skills, the request keeps its label so it does not run on from them.
  expect(formatTaskPrompt("Add --tls to `portcheck`.", { intent: "implement", mode: "modify", verification: [] }, model,
    { verificationMode: "auto", proveChange: true, reviewFollows: true, afterContext: true })).toBe("User request:\nAdd --tls to `portcheck`.");
  // An under-specified target still gets the clarification nudge.
  expect(formatTaskPrompt("build me a REST API", { intent: "implement", mode: "modify", verification: [] }, model,
    { verificationMode: "auto", proveChange: true, reviewFollows: true })).toBe(
    "The target is under-specified: if the ask tool is available, ask one concrete question with options before the first edit.\nUser request:\nbuild me a REST API");
  // Without a review to follow (offer mode, or no proof), the hints stay.
  expect(formatTaskPrompt("Add --tls to `portcheck`.", { intent: "implement", mode: "modify", verification: [] }, model,
    { verificationMode: "offer", proveChange: false, reviewFollows: true })).toContain("Casper initial classification");
});

test("with the review off, the first turn asks for the checklist in the exact format the review parses", () => {
  const model = { commands: { test: "npm test" } } as unknown as Parameters<typeof formatTaskPrompt>[2];
  const prompt = formatTaskPrompt("Add --tls to portcheck.", { intent: "implement", mode: "modify", verification: [] }, model, { proveChange: true, reviewFollows: false });
  // A checklist in any other shape reads as none, and costs a whole review round.
  expect(prompt).toContain("- [x] <requirement> — <the test that covers it>");
  expect(prompt).toContain("- [ ] <requirement> — <why it is still not done>");
  expect(prompt).toContain("Give each case its own line");
  expect(parseChecklist("Requirements:\n- [x] --tls connects — tests/tls.test.ts")).toEqual({ done: ["--tls connects — tests/tls.test.ts"], open: [] });
});

const check: VerificationResult = { name: "test", status: "pass", command: "npm test", cwd: "/r", exitCode: 0, signal: null,
  stdout: "", stderr: "", truncated: false, durationMs: 300, freshness: "fresh" };
const passed: VerificationReport = { status: "pass", repairAttempts: 0, rounds: [[check]], results: [check] };
const task = (review: TaskResult["review"]): TaskResult => ({ execution: "completed", verificationMode: "auto", changedPaths: ["src/a.ts"], verification: passed, review,
  proof: { status: "proven", check: "test", command: "bun test", testsChanged: true, without: { exitCode: 1, ended: "fail" } } });

test("the receipt reports the review as the model's own claim, and admitted gaps are not verified", () => {
  expect(formatReceipt(task({ done: ["a", "b"], open: [] }))).toContain("• The model's review: all 2 requirements covered (its own claim, not checked by Casper)");
  expect(formatReceipt(task({ done: ["a"], open: ["handshake timeout — not implemented"] })))
    .toContain("⚠ The model's review says not done: handshake timeout — not implemented");
  expect(formatReceipt(task({ missing: true }))).toContain("• The model's review returned no checklist");
  // With a count, the delta answer reports all m requirements and how many gaps the review fixed.
  expect(formatReceipt(task({ fixed: [], open: [], covered: 7, total: 7 })))
    .toContain("• The model's review: all 7 requirements covered (no gaps found; its own claim, not checked by Casper)");
  expect(formatReceipt(task({ fixed: ["a — t"], open: [], covered: 4, total: 4 })))
    .toContain("• The model's review: all 4 requirements covered (1 gap fixed; its own claim, not checked by Casper)");
  expect(formatTaskResult(task({ fixed: ["a — t", "b — t"], open: [], covered: 4, total: 4 })))
    .toContain("review       • The model's review: all 4 requirements covered (2 gaps fixed; its own claim, not checked by Casper)");
  // A count short of the total is not "all covered", even with no open line listed; open lines still decide the outcome.
  const short = formatReceipt(task({ fixed: ["a — t"], open: [], covered: 5, total: 6 }));
  expect(short).toContain("• The model's review: 5 of 6 requirements covered (1 gap fixed; its own claim, not checked by Casper)");
  expect(short).not.toContain("all 6");
  expect(taskOutcome(undefined, task({ fixed: [], open: [], covered: 5, total: 6 }))).toBe("verified");
  // "all covered" without a count: all covered, no number.
  expect(formatReceipt(task({ fixed: [], open: [] })))
    .toContain("• The model's review: all requirements covered (no gaps found; its own claim, not checked by Casper)");
  expect(formatReceipt(task({ fixed: [], open: ["b — no option"], covered: 3, total: 4 }))).toContain("⚠ The model's review says not done: b — no option");
  expect(taskOutcome(undefined, task({ fixed: [], open: ["b"], covered: 3, total: 4 }))).toBe("not_verified");
  expect(taskOutcome(undefined, task({ fixed: [], open: [], covered: 4, total: 4 }))).toBe("verified");
  expect(taskOutcome(undefined, task({ done: ["a"], open: ["b"] }))).toBe("not_verified");
  expect(taskOutcome(undefined, task({ done: ["a"], open: [] }))).toBe("verified");
  expect(taskOutcome(undefined, task({ missing: true }))).toBe("verified");
});

test("a review stopped at its own turn budget is reported as such; only open items make the change not verified", () => {
  const budget = "• The model's review stopped at its 12-turn budget (its own claim so far, not checked by Casper)";
  expect(formatReceipt(task({ missing: true, incomplete: true }))).toContain(budget);
  expect(formatReceipt(task({ missing: true, incomplete: true }))).not.toContain("returned no checklist");
  const partial = formatReceipt(task({ done: ["a"], open: ["b — not tested yet"], incomplete: true }));
  expect(partial).toContain(budget);
  expect(partial).toContain("⚠ The model's review says not done: b — not tested yet");
  expect(formatReceipt(task({ done: ["a"], open: [], incomplete: true }))).not.toContain("requirements covered");
  expect(taskOutcome(undefined, task({ missing: true, incomplete: true }))).toBe("verified");
  expect(taskOutcome(undefined, task({ done: ["a"], open: [], incomplete: true }))).toBe("verified");
  expect(taskOutcome(undefined, task({ done: ["a"], open: ["b"], incomplete: true }))).toBe("not_verified");
});

test("an open item is never dropped, however long the checklist; done items are capped at 50", () => {
  const answer = [...Array.from({ length: 60 }, (_, index) => `- [x] case ${index} — test ${index}`), "- [ ] the 6th call is rejected"].join("\n");
  const parsed = parseChecklist(answer)!;
  expect(parsed.open).toEqual(["the 6th call is rejected"]);
  expect(parsed.done).toHaveLength(50);
});
