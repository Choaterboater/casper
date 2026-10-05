import { expect, test } from "bun:test";
import { formatJsonEvent, receiptEvent, RuntimeEventMapper } from "../src/app/json-events";

test("tool targets and error messages are redacted; a provider failure becomes an error event", () => {
  let clock = 0;
  const mapper = new RuntimeEventMapper(() => clock);
  expect(mapper.map({ type: "tool_start", toolName: "bash", toolCallId: "t1", input: { command: "curl -H 'Authorization: Bearer abc123' https://user:pw@example.com" } }))
    .toEqual([{ type: "tool_start", tool: "bash", id: "t1", target: "curl -H 'Authorization: <redacted> <redacted>' https://<redacted>@example.com" }]);
  clock = 42.4;
  expect(mapper.map({ type: "tool_end", toolName: "bash", toolCallId: "t1", isError: true })).toEqual([{ type: "tool_end", tool: "bash", id: "t1", ok: false, ms: 42 }]);
  mapper.map({ type: "assistant_response_start" });
  mapper.map({ type: "assistant_text_delta", delta: "partial" });
  expect(mapper.map({ type: "assistant_response_end", stopReason: "error", errorMessage: "quota for sk-abcdefghijkl exceeded" })).toEqual([
    { type: "assistant_message", text: "partial" },
    { type: "error", message: "quota for <redacted> exceeded" },
  ]);
  // A cancel is not an error; a tool-use turn with no text emits nothing.
  expect(mapper.map({ type: "assistant_response_end", stopReason: "aborted", errorMessage: "aborted" })).toEqual([]);
  expect(mapper.map({ type: "assistant_response_end", stopReason: "toolUse" })).toEqual([]);
  // A provider error Pi is about to retry is not the outcome: no error event for it.
  expect(mapper.map({ type: "assistant_response_end", stopReason: "error", errorMessage: "429", retrying: true })).toEqual([]);
});

test("each event is one line with v:1, and terminal controls stay escaped", () => {
  const line = formatJsonEvent({ type: "assistant_delta", text: "a\u001b[2Jb\u009bc\u202ed\n" });
  expect(line.endsWith("\n")).toBe(true);
  expect(line.slice(0, -1)).not.toMatch(/[\n\u001b\u009b\u202e]/);
  expect(JSON.parse(line)).toEqual({ v: 1, type: "assistant_delta", text: "a\u001b[2Jb\u009bc\u202ed\n" });
});

test("a receipt exists even for a local command, and unknown changes are null", () => {
  expect(receiptEvent(undefined, undefined, 0)).toMatchObject({ outcome: "unchanged", changed: [], checks: [], text: "" });
  expect(receiptEvent(undefined, { execution: "completed", possibleMutations: true }, 0)).toMatchObject({ outcome: "not_verified", changed: null });
});

test("the receipt carries the task's model usage, and null when no model task ran", () => {
  expect(receiptEvent(undefined, undefined, 0).usage).toBeNull();
  expect(receiptEvent(undefined, { execution: "completed", usage: { turns: 4, tokens: null, estimatedCost: null } }, 0).usage)
    .toEqual({ turns: 4, tokens: null, estimatedCost: null });
});

test("the JSON receipt redacts secrets in the proof's failing output and the review items, never the task's own evidence", () => {
  const proof = { status: "proven" as const, check: "test" as const, command: "npm test", testsChanged: true,
    without: { exitCode: 1, ended: "fail" as const, reason: "failed with token=abc123secret", output: "Authorization: Bearer sk-live-abcdefghijkl\nexpected 2" } };
  const review = { done: ["uses password=hunter22 from env"], open: ["still sends Authorization: Bearer sk-open-abcdefghijkl"] };
  const task = { execution: "completed" as const, proof, review };
  const event = receiptEvent(undefined, task, 0);
  // The human text quotes the open review item; it is redacted like the fields.
  expect(event.text).toContain("still sends Authorization: <redacted>");
  expect(event.text).not.toContain("sk-open-abcdefghijkl");
  const text = JSON.stringify(event);
  expect(text).not.toContain("sk-live-abcdefghijkl");
  expect(text).not.toContain("abc123secret");
  expect(text).not.toContain("hunter22");
  expect(text).not.toContain("sk-open-abcdefghijkl");
  expect(text).toContain("expected 2");
  expect(task.proof.without.output).toContain("sk-live-abcdefghijkl");
  expect(task.review.done[0]).toContain("hunter22");
});
