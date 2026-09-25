import { expect, test } from "bun:test";
import { parseChecklist, requirementsReviewPrompt } from "../src/task/review";
import { formatTaskPrompt } from "../src/task/classify";
import { formatReceipt, taskOutcome, type TaskResult } from "../src/task/result";
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

test("the review prompt asks for every stated requirement, from the request and the project docs", () => {
  const prompt = requirementsReviewPrompt("Add --tls to portcheck.");
  expect(prompt).toContain("Add --tls to portcheck.");
  expect(prompt).toContain("CONTEXT.md");
  expect(prompt).toContain("- [ ] <requirement>");
  // A: only a named test that asserts it earns a tick; anything else is added now or left open.
  expect(prompt).toContain("Tick a requirement only when a test you can name asserts it");
  // A rule over several inputs, options or errors was ticked as one line and half tested.
  expect(prompt).toContain("Give each case its own line");
});

test("the first turn asks for the checklist in the exact format the review parses", () => {
  const model = { commands: { test: "npm test" } } as unknown as Parameters<typeof formatTaskPrompt>[2];
  const prompt = formatTaskPrompt("Add --tls to portcheck.", { intent: "implement", mode: "modify", verification: [] }, model, { proveChange: true });
  // A checklist in any other shape reads as none, and costs a whole review round.
  expect(prompt).toContain("- [x] <requirement> — <the test that covers it>");
  expect(prompt).toContain("- [ ] <requirement> — <why it is still not done>");
  expect(prompt).toContain("Give each case its own line");
  expect(parseChecklist("Requirements:\n- [x] --tls connects — tests/tls.test.ts")).toEqual({ done: ["--tls connects — tests/tls.test.ts"], open: [] });
});

const check: VerificationResult = { name: "test", status: "pass", command: "npm test", cwd: "/r", exitCode: 0, signal: null,
  stdout: "", stderr: "", truncated: false, durationMs: 300, freshness: "fresh" };
const passed: VerificationReport = { status: "pass", repairAttempts: 0, rounds: [[check]], results: [check] };
const task = (review: TaskResult["review"]): TaskResult => ({ execution: "completed", verificationMode: "auto", changedPaths: ["src/a.ts"], verification: passed, review });

test("the receipt reports the review as the model's own claim, and admitted gaps are not verified", () => {
  expect(formatReceipt(task({ done: ["a", "b"], open: [] }))).toContain("• The model's review: all 2 requirements covered (its own claim, not checked by Casper)");
  expect(formatReceipt(task({ done: ["a"], open: ["handshake timeout — not implemented"] })))
    .toContain("⚠ The model's review says not done: handshake timeout — not implemented");
  expect(formatReceipt(task({ missing: true }))).toContain("• The model's review returned no checklist");
  expect(taskOutcome(undefined, task({ done: ["a"], open: ["b"] }))).toBe("not_verified");
  expect(taskOutcome(undefined, task({ done: ["a"], open: [] }))).toBe("verified");
  expect(taskOutcome(undefined, task({ missing: true }))).toBe("verified");
});
