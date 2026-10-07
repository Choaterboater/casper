import { expect, test } from "bun:test";
import { isToolCallAsText } from "../src/task/text-tool-call";
import { type TaskResult, formatReceipt, formatShortReceipt, receiptVerdict, taskExitCode, taskOutcome } from "../src/task/result";

const call = '{"name":"bash","arguments":{"command":"ls"}}';

test("an answer that is only a tool call written as text is recognised", () => {
  expect(isToolCallAsText(call)).toBe(true);
  expect(isToolCallAsText(`  \n${call}\n`)).toBe(true);
  expect(isToolCallAsText('{"tool":"read","parameters":{"path":"a.ts"}}')).toBe(true);
  expect(isToolCallAsText('{"function":"write","input":{"path":"a"}}')).toBe(true);
  expect(isToolCallAsText('{"type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}')).toBe(true);
  expect(isToolCallAsText(`\`\`\`json\n${call}\n\`\`\``)).toBe(true);
  expect(isToolCallAsText(`<tool_call>${call}</tool_call>`)).toBe(true);
  expect(isToolCallAsText(`<tool_call>\n${call}\n</tool_call>\n`)).toBe(true);
});

test("plain answers that merely contain JSON or code are left alone", () => {
  expect(isToolCallAsText(`Run this:\n\`\`\`json\n${call}\n\`\`\`\nIt lists files.`)).toBe(false);
  expect(isToolCallAsText(`The call looks like ${call}.`)).toBe(false);
  expect(isToolCallAsText('{"name":"Ada","age":36}')).toBe(false);
  expect(isToolCallAsText('{"name":"Ada","input":"hello"}')).toBe(false);
  expect(isToolCallAsText('{"arguments":{"a":1}}')).toBe(false);
  expect(isToolCallAsText(`\`\`\`json\n${call}\n\`\`\`\n\`\`\`json\n${call}\n\`\`\``)).toBe(false);
  expect(isToolCallAsText("```ts\nconst x = 1;\n```")).toBe(false);
  expect(isToolCallAsText("")).toBe(false);
  expect(isToolCallAsText("{not json}")).toBe(false);
});

test("the receipt says the model did not act, and the run is not a success", () => {
  const task: TaskResult = { execution: "completed", changedPaths: [], wroteToolCallAsText: true };
  expect(taskOutcome(undefined, task)).toBe("incomplete");
  expect(taskExitCode(undefined, task)).toBe(2);
  expect(receiptVerdict(task)).toBe("• Did not act — the model wrote a tool call as text instead of using it");
  expect(formatShortReceipt(task)).toContain("Did not act");
  expect(formatReceipt({ execution: "completed", changedPaths: [] })).not.toContain("Did not act");
});
