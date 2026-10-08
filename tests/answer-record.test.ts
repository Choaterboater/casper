import { expect, test } from "bun:test";
import type { CasperApp } from "../src/app";
import { answerServerQuestion, recordedApproval } from "../src/app/approvals";
import { NO, YES_ONCE } from "../src/app/safe-choices";

/**
 * An answered box is recorded once. The rich terminal keeps the box in the transcript with ✓ on the answer, so no
 * "[approval]" or "[server question]" line follows it; the plain terminal has no such record and prints the line, and
 * so does a box closed without an answer (its record only says "skipped").
 */

function appWith(rich: boolean, answer: string | undefined) {
  const written: string[] = [];
  const terminal = { rich, approve: async () => answer };
  const app = { interactive: true, closing: false, approvalQueue: Promise.resolve(), terminal, output: { write: (text: string) => { written.push(text); } } };
  return { app: app as unknown as CasperApp, written };
}

const OPTIONS = [{ label: NO }, { label: YES_ONCE }];

test("an answered approval box is its own record on the rich terminal; the plain terminal prints the outcome line", async () => {
  const rich = appWith(true, YES_ONCE);
  expect(await recordedApproval(rich.app, "", "Make this change?", OPTIONS)).toBe(YES_ONCE);
  expect(rich.written.join("")).not.toContain("[approval]");

  const plain = appWith(false, YES_ONCE);
  await recordedApproval(plain.app, "", "Make this change?", OPTIONS);
  expect(plain.written.join("")).toContain("[approval] allowed\n");

  // Esc: the box says "(skipped)", so the line says what that meant.
  const skipped = appWith(true, undefined);
  expect(await recordedApproval(skipped.app, "", "Make this change?", OPTIONS)).toBeUndefined();
  expect(skipped.written.join("")).toContain("[approval] denied\n");
});

test("a server question answered in the box adds no [server question] line on the rich terminal", async () => {
  const question = { server: "net", realTool: "bounce_port", message: "Bounce port 1/1/1?", kind: "boolean" as const };
  const rich = appWith(true, "Yes");
  expect(await answerServerQuestion(rich.app, question as never, new AbortController().signal)).toEqual({ action: "accept", value: true });
  expect(rich.written.join("")).not.toContain("[server question]");

  const plain = appWith(false, "Yes");
  await answerServerQuestion(plain.app, question as never, new AbortController().signal);
  expect(plain.written.join("")).toContain("[server question] yes\n");
});
