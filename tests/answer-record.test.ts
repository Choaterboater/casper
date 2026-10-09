import { expect, test } from "bun:test";
import type { CasperApp } from "../src/app";
import { answerServerQuestion, recordedApproval } from "../src/app/approvals";
import { NO, YES_ONCE } from "../src/app/safe-choices";

/**
 * An answered box is recorded once. A box that was shown leaves its own one-line record on either terminal
 * ("Make this change? → Yes, this once", or "— skipped (No)"), so no "[approval]" or "[server question]" line follows
 * it; only where no box could be shown does the outcome line say what happened.
 */

function appWith(shown: boolean, answer: string | undefined) {
  const written: string[] = [];
  const terminal = { records: 0, approve: async () => { if (shown) terminal.records++; return answer; } };
  const app = { interactive: true, closing: false, approvalQueue: Promise.resolve(), terminal, output: { write: (text: string) => { written.push(text); } } };
  return { app: app as unknown as CasperApp, written };
}

const OPTIONS = [{ label: NO }, { label: YES_ONCE }];

test("a box that was shown is its own record; a box that could not show leaves the outcome line", async () => {
  const shown = appWith(true, YES_ONCE);
  expect(await recordedApproval(shown.app, "", "Make this change?", OPTIONS)).toBe(YES_ONCE);
  expect(shown.written.join("")).not.toContain("[approval]");

  // Esc: the record says "— skipped (No)", so no line follows it either.
  const skipped = appWith(true, undefined);
  expect(await recordedApproval(skipped.app, "", "Make this change?", OPTIONS)).toBeUndefined();
  expect(skipped.written.join("")).not.toContain("[approval]");

  const unshown = appWith(false, undefined);
  expect(await recordedApproval(unshown.app, "", "Make this change?", OPTIONS)).toBeUndefined();
  expect(unshown.written.join("")).toContain("[approval] denied\n");
});

test("a server question answered in the box adds no [server question] line", async () => {
  const question = { server: "net", realTool: "bounce_port", message: "Bounce port 1/1/1?", kind: "boolean" as const };
  const shown = appWith(true, "Yes");
  expect(await answerServerQuestion(shown.app, question as never, new AbortController().signal)).toEqual({ action: "accept", value: true });
  expect(shown.written.join("")).not.toContain("[server question]");

  const unshown = appWith(false, undefined);
  await answerServerQuestion(unshown.app, question as never, new AbortController().signal);
  expect(unshown.written.join("")).toContain("[server question] no\n");
});
