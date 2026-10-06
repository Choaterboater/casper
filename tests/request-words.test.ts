import { expect, test } from "bun:test";
import { parseRequestWords } from "../src/app/request-words";

test("words at the start, followed by : , or a new line, set this task and leave the request", () => {
  expect(parseRequestWords("think hard: why does the cache miss")).toEqual({ text: "why does the cache miss", effort: "top" });
  expect(parseRequestWords("Quick, rename foo to bar")).toEqual({ text: "rename foo to bar", effort: "low" });
  expect(parseRequestWords("big model: find the race")).toEqual({ text: "find the race", role: "reason" });
  expect(parseRequestWords("use the big model: find the race")).toEqual({ text: "find the race", role: "reason" });
  expect(parseRequestWords("fast model:\nlist the files")).toEqual({ text: "list the files", role: "fast" });
  expect(parseRequestWords("use the fast model, list the files")).toEqual({ text: "list the files", role: "fast" });
  expect(parseRequestWords("plan first: add a login page")).toEqual({ text: "add a login page", planFirst: true });
  // Several may lead.
  expect(parseRequestWords("big model, think hard: find the race")).toEqual({ text: "find the race", role: "reason", effort: "top" });
});

test("the same words anywhere else, or without : , or a new line after them, are just words", () => {
  for (const line of ["please think hard: about this", "quick fix for the login", "the big model: is it set?", "thinking hard: x",
    "quickly: do it", "big models: compare them", "think hard"]) {
    expect(parseRequestWords(line)).toEqual({ text: line });
  }
  // Words alone are not a request.
  expect(parseRequestWords("think hard:")).toEqual({ text: "think hard:" });
  // Only the first line's start: a second line's words are text.
  expect(parseRequestWords("fix the test\nbig model: no")).toEqual({ text: "fix the test\nbig model: no" });
});

test("ultrathink: a whole word anywhere in the typed line, taken out of the request", () => {
  expect(parseRequestWords("ultrathink fix the race")).toEqual({ text: "fix the race", effort: "top" });
  expect(parseRequestWords("fix the race ultrathink")).toEqual({ text: "fix the race", effort: "top" });
  expect(parseRequestWords("fix the ULTRATHINK race")).toEqual({ text: "fix the race", effort: "top" });
  expect(parseRequestWords("quick: ultrathink this")).toEqual({ text: "this", effort: "top" });
  expect(parseRequestWords("ultrathinking about it")).toEqual({ text: "ultrathinking about it" });
  expect(parseRequestWords("ultrathink")).toEqual({ text: "ultrathink" });
});

test("pasted text is never read as words: a pasted block starting with big model: does nothing", () => {
  const block = "big model: this came from a log\nthink hard: and so did this";
  expect(parseRequestWords(block, [block])).toEqual({ text: block });
  // Typed words before a paste still count; the paste stays as it is.
  expect(parseRequestWords(`think hard: explain\n${block}`, [block])).toEqual({ text: `explain\n${block}`, effort: "top" });
  // ultrathink inside the paste is not the person's.
  expect(parseRequestWords("explain ultrathink here", ["ultrathink here"])).toEqual({ text: "explain ultrathink here" });
  expect(parseRequestWords("ultrathink: explain this log line", ["this log line"])).toEqual({ text: "explain this log line", effort: "top" });
});
