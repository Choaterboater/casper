import { expect, test } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { ToolHistory as Projector, TOOL_HISTORY_KEEP_TURNS, TOOL_HISTORY_MIN_CHARS, type ToolHistoryWindow } from "../src/runtime/tool-history";

/** Each fixture read is about 2,850 tokens: in a 50k window, nine rounds hide five reads, more than the four kept
 * reads a rebuild re-reads. */
class ToolHistory extends Projector {
  override project(messages: Message[], enabled = true, window: ToolHistoryWindow = { contextWindow: 50_000 }) {
    return super.project(messages, enabled, window);
  }
}

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function assistant(n: number, text = "Continue."): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text },
    { type: "toolCall", id: `call_${n}`, name: "read", arguments: { path: `src/file-${n}.ts` } }],
  timestamp: n, api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", usage };
}
function result(n: number): ToolResultMessage {
  return { role: "toolResult", toolCallId: `call_${n}`, toolName: "read", timestamp: n,
    content: [{ type: "text", text: "const value = 123;\n".repeat(600) }], isError: false };
}
function history(turns = 9): Message[] {
  return [{ role: "system", content: "Fixed instructions", timestamp: 0 },
    { role: "user", content: "Make the change.", timestamp: 0 },
    ...Array.from({ length: turns }, (_, n) => [assistant(n), result(n)]).flat()];
}
function text(message: Message): string {
  return typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? part.text : "").join("\n");
}
const outputs = (messages: Message[]) => messages.filter((message) => message.role === "toolResult");

test("default hides bulky results once they outweigh the rebuild, never the last four, without mutating the transcript", () => {
  const original = history(); const bytes = JSON.stringify(original);
  const projected = new ToolHistory().project(original);
  expect(projected.checkpoint?.masks).toHaveLength(5);
  expect(text(outputs(projected.messages)[0]!)).toBe("[output of read src/file-0.ts hidden, re-run to see it]");
  expect(outputs(projected.messages).slice(-TOOL_HISTORY_KEEP_TURNS)).toEqual(outputs(original).slice(-4));
  expect(JSON.stringify(original)).toBe(bytes);
  expect(projected.messages.filter((message) => message.role !== "toolResult")).toEqual(original.filter((message) => message.role !== "toolResult"));
  // Eight rounds would hide four reads while the rebuild re-reads four kept ones: not yet worth it.
  expect(new ToolHistory().project(history(8)).checkpoint).toBeUndefined();
});

test("the full previous message prefix is byte-identical between checkpoints, including repeated requests", () => {
  // A 100k window: hiding waits for 20k hideable tokens (eight reads), and the prompt never passes 60%.
  const window = { contextWindow: 100_000 };
  const masker = new ToolHistory(); const original = history();
  let previous = masker.project(original, true, window).messages;
  const checkpoints: number[] = [];
  for (let n = 9; n < 24; n++) {
    expect(masker.project(original, true, window).checkpoint).toBeUndefined();
    original.push(assistant(n), result(n));
    const next = masker.project(original, true, window);
    if (next.checkpoint) {
      checkpoints.push(n + 1);
      expect(next.checkpoint.masks).toHaveLength(8);
    } else expect(JSON.stringify(next.messages.slice(0, previous.length))).toBe(JSON.stringify(previous));
    previous = next.messages;
  }
  expect(checkpoints).toEqual([12, 20]);
});

test("short sessions never pay a rebuild: little hideable output and a roomy window keep every byte", () => {
  const masker = new ToolHistory(); const original = history(4);
  for (let n = 4; n < 20; n++) {
    original.push(assistant(n), result(n));
    expect(masker.project(original, true, { contextWindow: 1_000_000 }).checkpoint).toBeUndefined();
  }
  // A filling window hides once even before eight new rounds, to put off compaction.
  const early = history(7);
  for (const output of outputs(early).slice(3)) output.content = [{ type: "text", text: "short" }];
  expect(new ToolHistory().project(early, true, { contextWindow: 1_000_000 }).checkpoint).toBeUndefined();
  expect(new ToolHistory().project(early, true, { contextWindow: 12_000 }).checkpoint?.masks).toHaveLength(3);
  // Reported usage counts too: the system prompt and tools are part of the window.
  expect(new ToolHistory().project(early, true, { contextWindow: 16_000 }).checkpoint).toBeUndefined();
  (early.at(-2) as AssistantMessage).usage = { ...usage, input: 10_000 };
  expect(new ToolHistory().project(early, true, { contextWindow: 16_000 }).checkpoint?.masks).toHaveLength(3);
});

test("off stops new masks, never restores old ones; resume and fork restore the same bytes", () => {
  const masker = new ToolHistory(); const original = history();
  expect(masker.project(original, false).messages).toEqual(original);
  const first = masker.project(original);
  const resumed = new ToolHistory(); resumed.restore(first.checkpoint);
  expect(resumed.project(original, false).messages).toEqual(first.messages);
  expect(resumed.project(original).checkpoint).toBeUndefined();
  for (let n = 8; n < 16; n++) original.push(assistant(n), result(n));
  const off = resumed.project(original, false);
  expect(text(outputs(off.messages)[0]!)).toContain("hidden");
  expect(outputs(off.messages)[5]).toEqual(result(5));
  const second = resumed.project(original);
  const fork = new ToolHistory(); fork.restore(first.checkpoint); fork.restore(second.checkpoint);
  expect(fork.project(original).messages).toEqual(second.messages);
  // A rewind to a branch without either checkpoint keeps the originals.
  expect(new ToolHistory().project(history(3)).messages).toEqual(history(3));
});

test.each(["src/file-0.ts", "file-0.ts", "call_0", "Keep using that output", "const value = 123; // this complete quoted line is still needed", "activeSourceSymbol"])("recent reference keeps the old output: %s", (reference) => {
  const original = history();
  (original[3] as ToolResultMessage).content = [{ type: "text", text: "const value = 123; // this complete quoted line is still needed\nconst activeSourceSymbol = 1;\n".repeat(200) }];
  original.push({ role: "user", timestamp: 9, content: reference });
  expect(outputs(new ToolHistory().project(original).messages)[0]).toEqual(original[3] as ToolResultMessage);
});

test("thinking and tool arguments pin references, and the current user request stays active throughout long tasks", () => {
  for (const mode of ["thinking", "argument", "user"] as const) {
    const original = history();
    if (mode === "user") original[1] = { role: "user", content: "Use src/file-0.ts", timestamp: 0 };
    else {
      const last = original.at(-2) as AssistantMessage;
      if (mode === "thinking") last.content.push({ type: "thinking", thinking: "src/file-0.ts" });
      else last.content.push({ type: "toolCall", id: "edit", name: "edit", arguments: { path: "src/file-0.ts" } });
    }
    expect(outputs(new ToolHistory().project(original).messages)[0]).toEqual(result(0));
  }
});

test("short results, errors, unmatched results, writes, MCP and check evidence are never hidden", () => {
  for (const mode of ["short", "error", "unmatched", "write", "mcp_tool", "casper_check"] as const) {
    const original = history(); const output = original[3] as ToolResultMessage;
    if (mode === "short") output.content = [{ type: "text", text: "x".repeat(TOOL_HISTORY_MIN_CHARS - 1) }];
    else if (mode === "error") output.isError = true;
    else if (mode === "unmatched") output.toolCallId = "missing";
    else output.toolName = mode;
    expect(outputs(new ToolHistory().project(original).messages)[0]).toEqual(output);
  }
});

test("the exact size threshold and recent tool image boundary are retained correctly", () => {
  for (const size of [TOOL_HISTORY_MIN_CHARS - 1, TOOL_HISTORY_MIN_CHARS]) {
    const original = history(); const output = original[3] as ToolResultMessage;
    output.content = [{ type: "text", text: "x".repeat(size) }];
    expect(text(outputs(new ToolHistory().project(original).messages)[0]!)).toContain(size === TOOL_HISTORY_MIN_CHARS ? "hidden" : "x".repeat(size));
  }
  const original = history();
  for (const output of outputs(original)) output.content = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
  const projected = outputs(new ToolHistory().project(original, true, { contextWindow: 20_000 }).messages);
  expect(projected.slice(0, 5).every((output) => output.content.every((part) => part.type !== "image"))).toBe(true);
  expect(projected.slice(5)).toEqual(outputs(original).slice(5));
});

test("command results can be hidden but failures and unfinished background output cannot", () => {
  for (const suffix of ["", "1 failed", "error: incomplete", "timed out", "Command exited with code 2", "Command aborted", "killed", "running in the background", "Still running after 120 s; moved to the background (task fixture)."]) {
    const original = history(); const call = (original[2] as AssistantMessage).content.at(-1)!;
    if (call.type !== "toolCall") throw new Error("fixture call missing");
    call.name = "bash"; call.arguments = { command: "printf synthetic" };
    const output = original[3] as ToolResultMessage;
    output.toolName = "bash"; output.content = [{ type: "text", text: "synthetic line\n".repeat(800) + suffix }];
    const projected = outputs(new ToolHistory().project(original).messages)[0]!;
    if (suffix) expect(projected).toEqual(output);
    else expect(text(projected)).toContain("[output of bash printf synthetic hidden, re-run only if safe to see it]");
  }
});

test("old tool screenshots hide; user images, recent pictures and actively referenced screenshots stay", () => {
  const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
  for (const action of ["screenshot", "check"]) {
    const original = history(); const call = (original[2] as AssistantMessage).content.at(-1)!;
    if (call.type !== "toolCall") throw new Error("fixture call missing");
    call.name = "browser"; call.arguments = { action };
    const output = original[3] as ToolResultMessage;
    output.toolName = "browser"; output.content = [{ type: "text", text: "Recorded check evidence" }, image];
    original[1] = { role: "user", timestamp: 0, content: [{ type: "text", text: "Make it work" }, image] };
    const projected = new ToolHistory().project(original, true, { contextWindow: 40_000 });
    expect(outputs(projected.messages)[0]!.content.some((part) => part.type === "image")).toBe(false);
    expect(projected.messages[1]).toEqual(original[1]!);
    if (action === "check") expect(text(outputs(projected.messages)[0]!)).toContain("Recorded check evidence");
    original.push({ role: "user", timestamp: 9, content: "Still using the screenshot" });
    expect(outputs(new ToolHistory().project(original).messages)[0]).toEqual(output);
  }
});

test("compaction resets the checkpoint cadence, surviving stubs never change", () => {
  const masker = new ToolHistory(); const first = masker.project(history(16));
  const compacted = history(2); expect(masker.project(compacted).checkpoint?.turns).toBe(0);
  expect(text(outputs(masker.project(compacted).messages)[0]!)).toContain("hidden");
  // Nothing new to hide: no checkpoint, so no rebuild.
  expect(masker.project(history(8)).checkpoint).toBeUndefined();
  expect(masker.project(history(21)).checkpoint?.turns).toBe(21);
  const resumed = new ToolHistory(); resumed.restore(first.checkpoint);
  expect(resumed.project(compacted).messages).toEqual(masker.project(compacted).messages);
});

test("compaction retains real tail identities and surviving masks without relying on reused keys", () => {
  const original = history(16); const first = new ToolHistory().project(original);
  // Retain rounds 10–16, including masks on 10–12, as a compaction tail.
  const compacted: Message[] = [original[0]!, { role: "user", content: "Compacted summary", timestamp: 100 }, ...original.slice(20)];
  const projector = new ToolHistory(); projector.restore(first.checkpoint);
  const reset = projector.project(compacted);
  expect(reset.checkpoint?.turns).toBe(0);
  expect(outputs(reset.messages).slice(0, 3)).toEqual(outputs(first.messages).slice(9, 12));
  expect(outputs(reset.messages).slice(-4)).toEqual(outputs(original).slice(-4));
  const restarted = new ToolHistory(); restarted.restore(first.checkpoint); restarted.restore(reset.checkpoint);
  compacted.push(assistant(16), result(16));
  expect(restarted.project(compacted).checkpoint).toBeUndefined();
  for (let n = 17; n < 21; n++) compacted.push(assistant(n), result(n));
  expect(restarted.project(compacted).checkpoint?.turns).toBe(12);
});

test("compaction epoch resets persist even when the projector is rebuilt each request", () => {
  const records: unknown[] = [];
  const project = (messages: Message[]) => {
    const projector = new ToolHistory(); for (const record of records) projector.restore(record);
    const next = projector.project(messages); if (next.checkpoint) records.push(next.checkpoint);
    return next;
  };
  project(history(9));
  const compacted = history(2);
  expect(project(compacted).checkpoint?.turns).toBe(0);
  expect(project(compacted).checkpoint).toBeUndefined();
  expect(project(history(14)).checkpoint?.turns).toBe(14);
  // A new first surviving assistant detects compaction even if the total has already grown back.
  const replaced = history(14); (replaced[2] as AssistantMessage).timestamp = 100;
  expect(project(replaced).checkpoint?.turns).toBe(0);
  expect(project(replaced).checkpoint).toBeUndefined();
});

test("reused provider call IDs are associated with their preceding call, not a later one", () => {
  const original = history();
  const later = original[4] as AssistantMessage;
  const call = later.content.at(-1)!;
  if (call.type !== "toolCall") throw new Error("fixture call missing");
  call.id = "call_0";
  (original[5] as ToolResultMessage).toolCallId = "call_0";
  const projected = outputs(new ToolHistory().project(original).messages);
  expect(text(projected[0]!)).toContain("read src/file-0.ts hidden");
  expect(text(projected[1]!)).toContain("read src/file-1.ts hidden");
});

test("malformed records are ignored, stubs do not grow or change, and rereads get fresh output", () => {
  const masker = new ToolHistory();
  for (const record of [null, {}, { turns: -1, masks: [] }, { turns: 8, masks: [null, { key: 1 }] }]) masker.restore(record);
  const first = new ToolHistory().project(history()); masker.restore(first.checkpoint);
  masker.restore({ turns: 8, masks: [{ ...first.checkpoint!.masks[0], text: "different" }] });
  const original = history();
  const nextCall = assistant(9); const call = nextCall.content.at(-1)!;
  if (call.type === "toolCall") call.arguments = { path: "src/file-0.ts" };
  original.push(nextCall, result(9));
  const projected = masker.project(original);
  expect(text(outputs(projected.messages)[0]!)).toBe(text(outputs(first.messages)[0]!));
  expect(outputs(projected.messages).at(-1)).toEqual(result(9));
});
