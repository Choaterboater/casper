import { expect, test } from "bun:test";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { parseCliArgs, UsageError } from "../src/cli-args";
import { AcpAsker, optionKind } from "../src/acp/permission";
import { RpcConnection } from "../src/acp/rpc";
import { sessionArgs } from "../src/acp/server";
import { askedWithout, promptText } from "../src/acp/session";
import { hider, UpdateMapper } from "../src/acp/updates";
import { NO, YES_ONCE, YES_SESSION } from "../src/app/safe-choices";
import type { AwayQuestion } from "../src/tui/terminal";

const box: AwayQuestion = { kind: "approve", question: "The AI wants to write to ~/notes. Allow it?", preview: "~/notes/todo.md\n", choices: [{ label: NO }, { label: YES_ONCE }, { label: YES_SESSION }], from: "approval" };

/** A permission channel that answers with `reply` and records what was sent. */
function channel(reply: (params: Record<string, any>, signal: AbortSignal) => Promise<unknown>) {
  const sent: Record<string, any>[] = [];
  const updates: Record<string, any>[] = [];
  return { sent, updates, request: (params: Record<string, any>, signal: AbortSignal) => { sent.push(params); return reply(params, signal); }, update: (update: Record<string, any>) => { updates.push(update); } };
}

test("Casper's choice labels keep their order and get ACP kinds: No rejects, this once allows once, a session-wide yes allows always", () => {
  expect([NO, YES_ONCE, YES_SESSION, "Yes to everything", "Preview first", "No, and stop"].map(optionKind))
    .toEqual(["reject_once", "allow_once", "allow_always", "allow_always", "allow_once", "reject_once"]);
});

test("a picked option is that label; the box is a step of its own that closes with the answer", async () => {
  const seen = channel(async (params) => ({ outcome: { outcome: "selected", optionId: params.options[1].optionId } }));
  expect(await new AcpAsker("s1", seen).ask(box)).toEqual([YES_ONCE]);
  expect(seen.sent[0]).toMatchObject({ sessionId: "s1", toolCall: { toolCallId: "casper-approval-1", title: box.question, status: "pending" },
    options: [{ optionId: "1", name: NO, kind: "reject_once" }, { optionId: "2", name: YES_ONCE, kind: "allow_once" }, { optionId: "3", name: YES_SESSION, kind: "allow_always" }] });
  expect(seen.sent[0]!.toolCall.content[0].content.text).toBe("~/notes/todo.md");
  expect(seen.updates.map((update) => [update.sessionUpdate, update.toolCallId, update.status])).toEqual([["tool_call", "casper-approval-1", "pending"], ["tool_call_update", "casper-approval-1", "completed"]]);
});

test("cancelled, an error, an unknown option, a stopped task and no answer in time are all No (undefined)", async () => {
  const outcomes: Array<(params: Record<string, any>, signal: AbortSignal) => Promise<unknown>> = [
    async () => ({ outcome: { outcome: "cancelled" } }),
    async () => { throw new Error("the client could not ask"); },
    async () => ({ outcome: { outcome: "selected", optionId: "9" } }),
    async () => null,
  ];
  for (const reply of outcomes) {
    const seen = channel(reply);
    expect(await new AcpAsker("s1", seen).ask(box)).toBeUndefined();
    expect(seen.updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
  }
  // Never answered: the wait ends it.
  const never = channel((_params, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const started = performance.now();
  expect(await new AcpAsker("s1", never, (text) => text, 50).ask(box)).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(5_000);
  // The task stopped while the box was open.
  const stop = new AbortController();
  const waiting = new AcpAsker("s1", never).ask(box, stop.signal);
  stop.abort();
  expect(await waiting).toBeUndefined();
});

test("only numbered boxes go to the client: a question that needs typed words or several picks gets no answer and sends nothing", async () => {
  const seen = channel(async () => ({ outcome: { outcome: "selected", optionId: "1" } }));
  const asker = new AcpAsker("s1", seen);
  expect(await asker.ask({ ...box, kind: "ask", typed: true })).toBeUndefined();
  expect(await asker.ask({ ...box, kind: "pick", multi: true })).toBeUndefined();
  expect(await asker.ask({ ...box, kind: "line" })).toBeUndefined();
  expect(seen.sent).toEqual([]);
});

test("the model's text goes out a line at a time, so a secret split across two deltas is still hidden whole", () => {
  const mapper = new UpdateMapper(hider(() => ["value-from-the-env-1234"]));
  const out = [
    ...mapper.map({ type: "assistant_delta", text: "Key: sk-abcd" }),
    ...mapper.map({ type: "assistant_delta", text: "ef0123456789 and value-from-" }),
    ...mapper.map({ type: "assistant_delta", text: "the-env-1234\nnext line" }),
    ...mapper.map({ type: "assistant_message", text: "" }),
  ];
  const textOut = out.map((update) => (update.content as { text: string }).text).join("");
  expect(textOut).not.toContain("sk-abcdef0123456789");
  expect(textOut).not.toContain("value-from-the-env-1234");
  expect(textOut).toContain("<secret hidden>");
  expect(textOut.endsWith("next line")).toBe(true);
});

test("a tool id the model uses again in a later turn is a new step for the client", () => {
  const mapper = new UpdateMapper((text) => text, { holdsSecret: () => false });
  const step = (file: string, ok: boolean) => [
    ...mapper.runtime({ type: "tool_start", toolName: "write", toolCallId: "call_0", input: { path: file }, args: { path: file, content: "x\n" } }),
    ...mapper.runtime({ type: "tool_end", toolName: "write", toolCallId: "call_0", input: { path: file }, isError: !ok, display: { text: "", truncated: false, before: null } }),
  ];
  const ids = [...step("a.js", true), ...step("b.js", false)].map((update) => [update.sessionUpdate, update.toolCallId, update.status]);
  expect(ids).toEqual([["tool_call", "casper-tool-1", "in_progress"], ["tool_call_update", "casper-tool-1", "completed"],
    ["tool_call", "casper-tool-2", "in_progress"], ["tool_call_update", "casper-tool-2", "failed"]]);
});

test("casper acp takes the run options before or after acp; prompt options and words are usage mistakes", () => {
  expect(parseCliArgs(["acp"]).command).toBe("acp");
  expect(parseCliArgs(["--model", "fixture/first", "acp", "--effort", "high", "--no-sandbox", "--allow-host", "example.com"]))
    .toMatchObject({ command: "acp", model: "fixture/first", effort: "high", noSandbox: true, allowHosts: ["example.com"], rest: [] });
  expect(parseCliArgs(["acp", "--continue"])).toMatchObject({ command: "acp", continueConversation: true });
  // Words after acp are a prompt, as before.
  expect(parseCliArgs(["acp", "is", "a", "protocol"])).toMatchObject({ command: "prompt", rest: ["acp", "is", "a", "protocol"] });
  for (const args of [["acp", "--json"], ["-p", "acp"], ["acp", "--model", "x", "hello"], ["acp", "--mcp", "notes"], ["acp", "--continue", "--resume", "abc"]]) {
    expect(() => parseCliArgs(args)).toThrow(UsageError);
  }
});

test("each session process gets the router's options without --cd (the client names its folder)", () => {
  expect(sessionArgs(["--cd", "~/code", "acp", "--model", "x", "--cd=elsewhere", "--no-sandbox"])).toEqual(["acp", "--model", "x", "--no-sandbox"]);
});

test("a prompt is its text blocks, a linked file by its quoted path, embedded text with its address; an empty one is refused", () => {
  const file = path.resolve("/p/a.ts");
  expect(promptText([{ type: "text", text: "Fix it" }, { type: "resource_link", uri: pathToFileURL(file).href, name: "a.ts" }, { type: "resource", resource: { uri: "file:///p/b.ts", text: "x" } }]))
    .toBe(`Fix it\nAttached file a.ts: "${file}"\nfile:///p/b.ts\nx`);
  expect(() => promptText([{ type: "image", data: "", mimeType: "image/png" }])).toThrow("Nothing in the prompt Casper can read.\nA picture sent with the request could not be read; it was not attached.");
});

test("a note for the person goes after the model's text so far, on a line of its own, hidden like the rest", () => {
  const mapper = new UpdateMapper(hider(() => ["value-from-the-env-1234"]));
  const out = [...mapper.map({ type: "assistant_delta", text: "Looking at it" }), ...mapper.note("[image] value-from-the-env-1234.png is not a PNG, JPEG, GIF or WebP picture; not attached")];
  expect(out.map((update) => (update.content as { text: string }).text)).toEqual(["Looking at it", "[image] <secret hidden>.png is not a PNG, JPEG, GIF or WebP picture; not attached\n"]);
  expect(mapper.flush()).toEqual([]);
});

test("JSON-RPC: a line that is not JSON gets a parse error, an unknown method gets Method not found", async () => {
  const input = new PassThrough();
  const written: string[] = [];
  const connection = new RpcConnection(input, (line) => { written.push(line); });
  input.write("not json\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/set_mode", params: {} })}\n`);
  input.end();
  await connection.closed;
  expect(written.map((line) => JSON.parse(line))).toEqual([
    { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
    { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "Method not found: session/set_mode" } },
  ]);
});

test("JSON-RPC: a picture-sized line read in small chunks costs its length, and lines split or packed across chunks all arrive", async () => {
  const big = `${JSON.stringify({ jsonrpc: "2.0", method: "seen", params: { data: "x".repeat(16 * 1024 * 1024) } })}\n`;
  const small = (n: number) => `${JSON.stringify({ jsonrpc: "2.0", method: "seen", params: { data: `é${n}` } })}\n`;
  const text = `${small(1)}${big}${small(2)}${small(3)}`;
  // 1 KB chunks: searching the whole line so far on each one took seconds here; the bound is far above the real cost.
  // Byte chunks, so a two-byte letter can be cut between them too.
  const bytes = Buffer.from(text);
  async function* chunks() { for (let at = 0; at < bytes.length; at += 1024) yield bytes.subarray(at, at + 1024); }
  const seen: number[] = [];
  const started = performance.now();
  const connection = new RpcConnection(chunks(), () => {});
  connection.onNotification("seen", (params) => { seen.push(String(params.data).length); });
  await connection.closed;
  expect(performance.now() - started).toBeLessThan(1500);
  expect(seen).toEqual([2, 16 * 1024 * 1024, 2, 2]);
});

test("a pasted agent transcript is left out of what was asked; a prompt without one is read whole (undefined)", () => {
  const text = (words: string) => ({ type: "text", text: words });
  const ask = (...blocks: Array<{ type: string; text: string }>) => askedWithout(blocks, promptText(blocks));
  const transcript = "❯ fix the failing sum test\n● I'll fix sum.js and add tests\n⎿ Edited sum.js\n● Done";
  expect(ask(text(`Why did the other agent stop?\n${transcript}`))).toBe("Why did the other agent stop?");
  expect(ask(text("Why did it stop?"), text(transcript))).toBe("Why did it stop?");
  // Words after the paste go with it: nothing typed is left, so no checklist is made from the paste.
  expect(ask(text(`${transcript}\nwhy?`))).toBe("");
  // A spec or a note with a bullet or two is no transcript.
  expect(ask(text("Fix sum.js\n● sum(1, 2) is 3\nThanks"))).toBeUndefined();
  expect(ask(text("Fix sum.js"))).toBeUndefined();
});
