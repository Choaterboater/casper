import { expect, test } from "bun:test";
import { DEFAULT_SYSTEM_PROMPT_APPEND, LEAN_SYSTEM_PROMPT_APPEND } from "../src/app/prompt";
import { askTool, type AskChannel } from "../src/tui/ask";

const channel: AskChannel = { available: () => false, ask: async () => undefined, record: () => {} };

test("the AI is told to use the ask picker for any choice or confirmation, not a question in prose at the end of a reply", () => {
  const description = askTool(channel).description;
  expect(description).toContain("choose or confirm something at any point");
  expect(description).toContain("\"shall I do X next?\"");
  expect(description).toContain("instead of ending a reply with a question in prose");
  expect(description).toContain("the safe choice first");
  expect(description).toContain("After the answer, reply with only what is new");
  expect(description).not.toContain("before acting on under-specified requirements");
  const line = DEFAULT_SYSTEM_PROMPT_APPEND.split("\n").find((text) => text.includes("the ask tool"));
  expect(line).toContain("Whenever the user must choose or confirm something");
  expect(line).toContain("a mid-task check");
  expect(line).toContain("not a question ending your reply; prose only if no options fit");
  expect(line).toContain("Never ask what the repository answers");
  expect(line).not.toContain("ask before building");
  expect(LEAN_SYSTEM_PROMPT_APPEND).toContain("Choices: ask tool, safe first; prose if none fit.");
});

test("the AI does the next step it can take instead of stopping to announce it, and stops when finished", () => {
  expect(DEFAULT_SYSTEM_PROMPT_APPEND).toContain("Don't stop to say what you'll do next: do it. Work left for the user: one next action. Finished: stop, no forced next step");
  expect(LEAN_SYSTEM_PROMPT_APPEND).toContain("Act, don't announce; one next step or stop; no filler/time guesses.");
  expect(DEFAULT_SYSTEM_PROMPT_APPEND).not.toContain("give one useful next action");
});
