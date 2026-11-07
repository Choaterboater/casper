import { describe, expect, test } from "bun:test";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { parseCliArgs, UsageError } from "../src/cli-args";
import { AcpAsker, formAnswer, optionKind, questionSchema } from "../src/acp/permission";
import { RpcConnection } from "../src/acp/rpc";
import { sessionArgs } from "../src/acp/server";
import { askedWithout, promptText } from "../src/acp/session";
import { hider, keptLines, UpdateMapper, type AcpReceipt } from "../src/acp/updates";
import { NO, PLAN_ANSWER_HINT, PLAN_CHANGE_HINT, PLAN_CHANGE_QUESTION, YES_ONCE, YES_SESSION } from "../src/app/safe-choices";
import { until } from "./support/acp-client";
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
  expect(out.map((update) => (update.content as { text: string }).text)).toEqual(["Looking at it", "\n\n[image] <secret hidden>.png is not a PNG, JPEG, GIF or WebP picture; not attached\n"]);
  expect(mapper.flush()).toEqual([]);
});

/** The agent message an app shows, as Markdown renders it: each paragraph, its lines as the app shows them. */
const rendered = (updates: Array<Record<string, unknown>>) => Bun.markdown.html(updates.map((update) => (update.content as { text: string }).text).join(""))
  .split(/<\/p>\s*/).filter((paragraph) => paragraph.trim()).map((paragraph) => paragraph.replace(/^\s*<p>/, "").split(/<br \/>\n?/).map((line) => line.replaceAll("&#39;", "'").replaceAll("&amp;", "&")));

test("the receipt reaches the app as the terminal prints it: its own paragraph after the model's words, each line on its own", () => {
  const lines = ["– Not verified — the model's review lists unfinished items", "✓ Changed 2 files: calc.py, test_calc.py", "✓ test passed (python3 -m unittest discover)",
    "– Changed while checking: test_calc.py", "Undo: casper /undo 1 · Diff: casper /diff 1"];
  const receipt = { text: lines.join("\n") } as AcpReceipt;
  const mapper = new UpdateMapper(hider(() => []));
  const out = [...mapper.map({ type: "assistant_delta", text: "Tests: 3 passed." }), ...mapper.map({ type: "assistant_message", text: "Tests: 3 passed." }), ...mapper.receipt(receipt)];
  expect(rendered(out)).toEqual([["Tests: 3 passed."], lines]);
  // The data keeps the receipt's text as --json prints it.
  expect((out.at(-1)!._meta as { casper: { receipt: AcpReceipt } }).casper.receipt.text).toBe(lines.join("\n"));
  // Two [image] notes and the model's words after them: each note on its own line, the words a paragraph of their own.
  const notes = new UpdateMapper(hider(() => []));
  expect(rendered([...notes.note("[image] a.heic is not a PNG; not attached"), ...notes.note("[image] b.heic is not a PNG; not attached"),
    ...notes.map({ type: "assistant_delta", text: "Here is what I see.\n" }), ...notes.map({ type: "error", message: "quota reached\ntry again in an hour" })]))
    .toEqual([["[image] a.heic is not a PNG; not attached"], ["[image] b.heic is not a PNG; not attached"], ["Here is what I see."], ["[error] quota reached", "try again in an hour"]]);  // A line of only spaces ends the paragraph as a blank line does, so the line before it gets no break (one that ends a
  // paragraph would show as a backslash).
  expect(Bun.markdown.html(keptLines("[error] quota\n  \nretry later"))).not.toContain("\\");
});

test("two model messages in one turn reach the app as two paragraphs; the streamed chunks of one message stay joined", () => {
  const mapper = new UpdateMapper(hider(() => []));
  const out = [
    ...mapper.map({ type: "assistant_delta", text: "Still not done: none.\n" }), ...mapper.map({ type: "assistant_delta", text: "Covered: 3 of 3 " }),
    ...mapper.map({ type: "assistant_delta", text: "requirements." }), ...mapper.map({ type: "assistant_message", text: "" }),
    ...mapper.map({ type: "assistant_delta", text: "I found no issues" }), ...mapper.map({ type: "assistant_delta", text: ": all done." }), ...mapper.map({ type: "assistant_message", text: "" }),
  ];
  expect(out.map((update) => (update.content as { text: string }).text).join("")).toBe("Still not done: none.\nCovered: 3 of 3 requirements.\n\nI found no issues: all done.");
  expect(rendered(out)).toEqual([["Still not done: none.\nCovered: 3 of 3 requirements."], ["I found no issues: all done."]]);
  // After a tool step the app starts a new block itself: nothing goes before the next message's words, nor before a
  // new prompt's.
  const steps = new UpdateMapper((text) => text, { holdsSecret: () => false });
  steps.map({ type: "assistant_delta", text: "Reading." }); steps.map({ type: "assistant_message", text: "" });
  steps.runtime({ type: "tool_start", toolName: "read", toolCallId: "call_1", input: { path: "a.js" }, args: { path: "a.js" } });
  expect(steps.map({ type: "assistant_delta", text: "Done.\n" }).map((update) => (update.content as { text: string }).text)).toEqual(["Done.\n"]);
  steps.map({ type: "assistant_message", text: "" });
  steps.newPrompt();
  expect(steps.map({ type: "assistant_delta", text: "Next.\n" }).map((update) => (update.content as { text: string }).text)).toEqual(["Next.\n"]);
});

test("a command's output is one fenced block, a whole line at a time (a secret split across two writes is hidden whole); model text, a note or a flush closes it", () => {
  const mapper = new UpdateMapper(hider(() => ["value-from-the-env-1234"]));
  const texts = (updates: Array<Record<string, unknown>>) => updates.map((update) => (update.content as { text: string }).text);
  expect(texts([...mapper.commandText(" model   value-from-"), ...mapper.commandText("the-env-1234\n mcp       2 configured\n"), ...mapper.commandText(" shell")]))
    .toEqual(["````text\n model   <secret hidden>\n mcp       2 configured\n"]);
  // The model speaking ends the block: its part line first, then the close, then the model's words.
  expect(texts(mapper.map({ type: "assistant_delta", text: "Done.\n" }))).toEqual([" shell\n", "````\n", "Done.\n"]);
  expect(texts([...mapper.commandText("again\n"), ...mapper.note("[plan] Nothing was built.")])).toEqual(["````text\nagain\n", "````\n", "[plan] Nothing was built.\n"]);
  expect(texts([...mapper.commandText("last\n"), ...mapper.flush()])).toEqual(["````text\nlast\n", "````\n"]);
  expect(mapper.flush()).toEqual([]);
});

test("a line of four or more backticks in a command's output (a Markdown file in /diff or /output) stays inside its block", () => {
  const mapper = new UpdateMapper(hider(() => []));
  const output = ["````markdown", "```sh", "```", "````", " ````  ", "# Heading from the file", "![img](http://192.0.2.1/x.png)", "`````", ""].join("\n");
  const sent = [...mapper.commandText(output), ...mapper.flush()].map((update) => (update.content as { text: string }).text).join("");
  // As CommonMark reads it: a line of 4 or more backticks, at most 3 spaces in and nothing but spaces after, closes
  // the block. Only the last line does; every line of the output is inside it.
  const lines = sent.split("\n");
  const closers = lines.flatMap((line, index) => /^ {0,3}`{4,}[ \t]*$/.test(line) ? [index] : []);
  expect(lines[0]).toBe("````text");
  expect(closers).toEqual([lines.length - 2]);
  expect(lines.slice(1, -2).join("\n").replaceAll("\u200b", "")).toBe(output.trimEnd());
});

test("JSON-RPC: a request's after hook runs once its reply line is written, and never after an error reply", async () => {
  const input = new PassThrough();
  const written: string[] = [];
  const connection = new RpcConnection(input, (line) => { written.push(line); });
  connection.onRequest("session/new", async () => ({ sessionId: "s1" }), (result, params) => { written.push(`after ${JSON.stringify(result)} ${JSON.stringify(params)}`); });
  connection.onRequest("session/load", async () => { throw new Error("no"); }, () => { written.push("after load"); });
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/p" } })}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/load", params: {} })}\n`);
  input.end();
  await connection.closed;
  // The replies are written as their handlers settle.
  for (let tries = 0; written.length < 3 && tries < 200; tries++) await Bun.sleep(5);
  expect(written).toEqual([
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } })}\n`,
    'after {"sessionId":"s1"} {"cwd":"/p"}',
    `${JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "no" } })}\n`,
  ]);
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

describe("the AI's questions reach an ACP app as forms (decision 83)", () => {
  type Sent = Record<string, any>;
  const AI: AwayQuestion = { kind: "ask", question: "Which database?", choices: [{ label: "Postgres", description: "a server" }, { label: "SQLite" }], typed: true, from: "ai" };
  const OWN: AwayQuestion = { kind: "pick", question: "Which port?", choices: [{ label: "3000" }, { label: "8080" }], typed: true, from: "casper" };
  /** A channel that answers forms with `reply`; `step` is the ask tool's running step, if any. */
  const forms = (reply: (params: Sent, signal: AbortSignal) => Promise<unknown>, step?: string) => {
    const base = channel(async () => ({ outcome: { outcome: "selected", optionId: "1" } }));
    const asked: Sent[] = [];
    return { ...base, asked, elicit: (params: Sent, signal: AbortSignal) => { asked.push(params); return reply(params, signal); },
      stepFor: (question: AwayQuestion) => question.from === "ai" ? step : undefined };
  };
  const answering = (seen: ReturnType<typeof forms>, hide?: (text: string) => string, waitMs?: number) => {
    const asker = new AcpAsker("s1", seen, hide, waitMs);
    asker.questions = () => true;
    return asker;
  };

  test("A typed question from the AI asks through elicitation/create on the ask tool's own step and sends no extra tool call", async () => {
    // The ask tool's step is the one running under the model's own id.
    const mapper = new UpdateMapper(hider(() => []));
    const [start] = mapper.runtime({ type: "tool_start", toolName: "ask", toolCallId: "m1", args: { question: AI.question } } as never).slice(-1);
    expect(mapper.runningStep("ask")).toBe(start!.toolCallId as string);
    expect(mapper.runningStep("write")).toBeUndefined();
    const seen = forms(async () => ({ action: "accept", content: { answer: "2" } }), mapper.runningStep("ask"));
    expect(await answering(seen).ask(AI)).toEqual(["SQLite"]);
    expect(seen.asked).toHaveLength(1);
    expect(seen.asked[0]).toEqual({ sessionId: "s1", toolCallId: start!.toolCallId, mode: "form", message: AI.question,
      requestedSchema: { type: "object", required: [], properties: {
        answer: { type: "string", title: "Choose", oneOf: [{ const: "1", title: "Postgres", description: "a server" }, { const: "2", title: "SQLite" }] },
        other: { type: "string", title: "Or type your answer" } } },
      _meta: { casper: { question: { from: "ai", multi: false, typed: true } } } });
    // The ask tool's step closes itself with the tool's result: the question sends no step of its own.
    expect(seen.updates).toEqual([]);
    expect(seen.sent).toEqual([]);
  });

  test("Casper's own typed pick opens a casper-question step and closes it with the answer", async () => {
    const seen = forms(async () => ({ action: "accept", content: { answer: "1", other: "  4000 " } }));
    expect(await answering(seen).ask(OWN)).toEqual(["4000"]);
    expect(seen.asked[0]!.toolCallId).toBe("casper-question-1");
    expect(seen.updates).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "casper-question-1", title: "Which port?", kind: "other", status: "pending",
        _meta: { casper: { question: { question: "Which port?", options: [{ label: "3000" }, { label: "8080" }], multi: false, typed: true } } } },
      { sessionUpdate: "tool_call_update", toolCallId: "casper-question-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "→ 4000" } }] },
    ]);
    // A picked choice with no typed words is that choice's label; the next question is a step of its own.
    const picked = forms(async () => ({ action: "accept", content: { answer: "2" } }));
    const asker = answering(picked);
    expect(await asker.ask(OWN)).toEqual(["8080"]);
    expect(await asker.ask(OWN)).toEqual(["8080"]);
    expect(picked.updates.map((update) => update.toolCallId)).toEqual(["casper-question-1", "casper-question-1", "casper-question-2", "casper-question-2"]);
    // The AI's question with no ask step running (a runtime that sends no step) gets one, titled as the AI's.
    const lone = forms(async () => ({ action: "accept", content: { answer: "1" } }));
    expect(await answering(lone).ask(AI)).toEqual(["Postgres"]);
    expect(lone.updates[0]).toMatchObject({ toolCallId: "casper-question-1", title: "The AI asks: Which database?" });
  });

  test("A multi pick gives its picks in order, drops unknown choices and puts typed words last", async () => {
    const multi: AwayQuestion = { ...AI, multi: true, choices: [{ label: "Postgres" }, { label: "SQLite" }, { label: "Redis" }] };
    const schema = questionSchema(multi, (text) => text);
    expect(schema.properties.answer).toEqual({ type: "array", title: "Choose", items: { anyOf: [{ const: "1", title: "Postgres" }, { const: "2", title: "SQLite" }, { const: "3", title: "Redis" }] } });
    expect(formAnswer({ action: "accept", content: { answer: ["3", "9", "1", "x"], other: " and a cache " } }, multi)).toEqual(["Postgres", "Redis", "and a cache"]);
    expect(formAnswer({ action: "accept", content: { answer: ["2"] } }, multi)).toEqual(["SQLite"]);
    expect(formAnswer({ action: "accept", content: { answer: [] } }, multi)).toBeUndefined();
    // Typed words count only where the question takes them.
    expect(formAnswer({ action: "accept", content: { answer: ["2"], other: "MySQL" } }, { ...multi, typed: false })).toEqual(["SQLite"]);
    expect(questionSchema({ ...multi, typed: false }, (text) => text).properties.other).toBeUndefined();
    // A single pick prefers the typed words; a line collapses its spaces and must not be empty.
    expect(formAnswer({ action: "accept", content: { answer: "1", other: "MySQL" } }, AI)).toEqual(["MySQL"]);
    expect(formAnswer({ action: "accept", content: { answer: "7" } }, AI)).toBeUndefined();
    const line: AwayQuestion = { kind: "line", question: "What should change?", choices: [], typed: true, hint: "Type the change" };
    expect(questionSchema(line, (text) => text)).toEqual({ type: "object", required: ["answer"], properties: { answer: { type: "string", title: "Type the change" } } });
    expect(formAnswer({ action: "accept", content: { answer: "  drop\n step   3 " } }, line)).toEqual(["drop step 3"]);
    expect(formAnswer({ action: "accept", content: { answer: "   " } }, line)).toBeUndefined();
    expect(questionSchema({ ...line, hint: undefined }, (text) => text).properties.answer.title).toBe("Your answer");
  });

  test("A declined, cancelled, failed, aborted or timed-out form is skipped and its own step closes failed", async () => {
    const replies: Array<(params: Sent, signal: AbortSignal) => Promise<unknown>> = [
      async () => ({ action: "decline" }),
      async () => ({ action: "cancel" }),
      async () => { throw new Error("the client could not show it"); },
      async () => null,
    ];
    for (const reply of replies) {
      const seen = forms(reply);
      expect(await answering(seen).ask(OWN)).toBeUndefined();
      expect(seen.updates.at(-1)).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "casper-question-1", status: "failed", content: [{ type: "content", content: { type: "text", text: "— skipped" } }] });
    }
    const never = forms((_params, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    // No answer in time.
    const started = performance.now();
    expect(await answering(never, undefined, 50).ask(OWN)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(never.updates.at(-1)).toMatchObject({ status: "failed" });
    // The task stopped while the form was open, and a task already stopped asks nothing.
    const stop = new AbortController();
    const waiting = answering(never).ask(OWN, stop.signal);
    stop.abort();
    expect(await waiting).toBeUndefined();
    const before = never.asked.length;
    expect(await answering(never).ask(OWN, stop.signal)).toBeUndefined();
    expect(never.asked).toHaveLength(before);
  });

  test("Question words, labels, descriptions and the echoed answer are hidden, and a hidden label maps back by its index", async () => {
    const secret = "value-from-the-env-1234";
    const question: AwayQuestion = { kind: "pick", question: `Use ${secret}?`, choices: [{ label: "Keep it" }, { label: `Send ${secret}`, description: `as ${secret}` }], typed: true, from: "casper" };
    const seen = forms(async (params) => ({ action: "accept", content: { answer: params.requestedSchema.properties.answer.oneOf[1].const } }));
    expect(await answering(seen, hider(() => [secret])).ask(question)).toEqual([`Send ${secret}`]);
    const out = JSON.stringify([seen.asked, seen.updates]);
    expect(out).not.toContain(secret);
    expect(seen.asked[0]!.requestedSchema.properties.answer.oneOf[1]).toEqual({ const: "2", title: "Send <secret hidden>", description: "as <secret hidden>" });
    expect(seen.updates.at(-1)!.content[0].content.text).toBe("→ Send <secret hidden>");
  });

  test("Read only closes an open box but not an open question", async () => {
    let answerForm!: (value: unknown) => void;
    const seen = forms(() => new Promise((resolve) => { answerForm = resolve; }));
    const pending = (_params: Sent, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled"))));
    const asker = new AcpAsker("s1", { ...seen, request: pending }, undefined);
    asker.questions = () => true;
    const question = asker.ask(OWN);
    const approval = asker.ask(box);
    await until(() => seen.asked.length === 1 && seen.updates.some((update) => update.toolCallId === "casper-approval-1"), 5_000, "the form and the box");
    asker.withdrawAll();
    expect(await approval).toBeUndefined();
    answerForm({ action: "accept", content: { answer: "2" } });
    expect(await question).toEqual(["8080"]);
  });

  test("A client without form support gets no question update and the question is skipped at once", async () => {
    const seen = forms(async () => ({ action: "accept", content: { answer: "1" } }), "casper-tool-1");
    const asker = new AcpAsker("s1", seen);
    for (const question of [AI, OWN, { ...AI, multi: true, typed: false, from: "casper" as const }, { kind: "line" as const, question: "What should change?", choices: [], typed: true }]) {
      expect(await asker.ask(question)).toBeUndefined();
    }
    expect([seen.asked, seen.sent, seen.updates]).toEqual([[], [], []]);
  });

  test("Choice 1 of a Casper pick is reject_once", async () => {
    const seen = forms(async () => undefined);
    const asker = answering(seen);
    seen.request = async (params: Sent) => { seen.sent.push(params); return { outcome: { outcome: "selected", optionId: "1" } }; };
    const pick: AwayQuestion = { kind: "pick", question: "Run this command?", choices: [{ label: "Leave it" }, { label: YES_ONCE }, { label: YES_SESSION }], from: "casper" };
    expect(await asker.ask(pick)).toEqual(["Leave it"]);
    expect(seen.sent[0]!.options.map((option: Sent) => [option.name, option.kind])).toEqual([["Leave it", "reject_once"], [YES_ONCE, "allow_once"], [YES_SESSION, "allow_once"]]);
    // Choice 1 is the safe one, so picking it closes the step as a No.
    expect(seen.updates.at(-1)).toMatchObject({ status: "failed", content: [{ content: { text: "→ Leave it" } }] });
    // An approval keeps its label's kind.
    await asker.ask(box);
    expect(seen.sent[1]!.options.map((option: Sent) => option.kind)).toEqual(["reject_once", "allow_once", "allow_always"]);
    // A plain pick never goes to a form.
    expect(seen.asked).toEqual([]);
  });

  test("Every question that can reach an app as typed words comes from the ask tool, the question round or the plan change line, and none asks for a secret", async () => {
    // A typed question is the AI's ask (from "ai", or a held one's own from), a pick with typed: true, or a typed line. Each place that
    // asks one is listed here, with whether an app can see it: the rest need Casper's own terminal (app.interactive).
    const root = path.join(import.meta.dir, "../src");
    const found: string[] = [];
    for (const file of new Bun.Glob("**/*.ts").scanSync(root)) {
      const name = file.split(path.sep).join("/");
      // The terminal itself, which every one of them goes through.
      if (name.startsWith("tui/")) continue;
      const text = await Bun.file(path.join(root, file)).text();
      for (const line of text.split("\n")) {
        if (/\.askLine\(|\.(?:pick|ask)\([^\n]*(?:typed: true|"ai"\)|\.from\b)/.test(line)) found.push(`${name}: ${line.trim().slice(0, 60)}`);
      }
    }
    const reachesApp = [
      "app/approvals.ts: return app.terminal.ask(question, options, multi, signals.le", // the ask tool
      "app/task-run.ts: const answer = await app.terminal.pick(q.question, q.options", // the plan's question round
      "app/task-run.ts: const typed = await app.terminal.askLine(question, questions", // the plan's open questions
      "app/task-run.ts: const typed = await app.terminal.askLine(PLAN_CHANGE_QUESTIO", // the plan change line
    ];
    const terminalOnly = [
      "app/workspace.ts: pick: (question, options, signal) => app.terminal.pick(quest", // new project: app.interactive
      "app/jobs.ts: const answer = await app.terminal.askLine(question.question,", // /jobs answer: app.interactive
      "app/jobs.ts: picked = await app.terminal.ask(question.question, question.", // /jobs answer: app.interactive
    ];
    expect(found.sort()).toEqual([...reachesApp, ...terminalOnly].sort());
    // None of them asks for a secret: a password, a token or a key has Casper's own hidden box, which never crosses.
    for (const words of [PLAN_CHANGE_QUESTION, PLAN_CHANGE_HINT, PLAN_ANSWER_HINT]) expect(words).not.toMatch(/password|passphrase|secret|token|api key/i);
    for (const file of ["app/secret-tool.ts", "app/wiring.ts"]) {
      const text = await Bun.file(path.join(root, file)).text();
      expect(text).toContain("password: true");
      expect(text).not.toMatch(/\.askLine\(|\.ask\([^\n]*"ai"\)|typed: true/);
    }
    // The hidden box is only offered where Casper has its own terminal.
    expect(await Bun.file(path.join(root, "app/secret-tool.ts")).text()).toContain("canAsk: () => app.interactive && app.terminal.canAsk");
  });
});

describe("the plan's Build box, its steps and the plan option reach an ACP app (decision 84)", () => {
  const review = { markdown: "# Add a greeting\n\n## Steps\n1. Write greeting.txt\n", approve: "Build", change: "Change the plan" };
  const PLAN_BOX: AwayQuestion = { kind: "pick", question: "Build this plan?", choices: [{ label: "Stop", description: "nothing is built" },
    { label: "Build", description: "the model builds these steps" }, { label: "Change the plan", description: "tell the model what to change" }], from: "casper", review };

  test("The Build box carries the plan text and its labels, with Build allow_once and Stop and Change the plan reject_once", async () => {
    const seen = channel(async (params) => ({ outcome: { outcome: "selected", optionId: params.options[1].optionId } }));
    expect(await new AcpAsker("s1", seen).ask(PLAN_BOX)).toEqual(["Build"]);
    const sent = seen.sent[0]!;
    expect(sent.options.map((option: { name: string; kind: string }) => [option.name, option.kind]))
      .toEqual([["Stop", "reject_once"], ["Build", "allow_once"], ["Change the plan", "reject_once"]]);
    expect(sent.toolCall.content).toEqual([{ type: "content", content: { type: "text", text: review.markdown } }]);
    expect(sent.toolCall._meta).toEqual({ casper: { plan: { approve: "Build", change: "Change the plan" } } });
    // The tool_call the app saw start carries the same plan.
    expect(seen.updates[0]).toMatchObject({ sessionUpdate: "tool_call", toolCallId: sent.toolCall.toolCallId, _meta: { casper: { plan: { approve: "Build", change: "Change the plan" } } } });
    // Change the plan is a "no" to building: the step closes failed, and the answer is still its label.
    const changing = channel(async (params) => ({ outcome: { outcome: "selected", optionId: params.options[2].optionId } }));
    expect(await new AcpAsker("s1", changing).ask(PLAN_BOX)).toEqual(["Change the plan"]);
    expect(changing.updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
    // The plan's words and labels are hidden as every update is.
    const secret = "PLUMPLUMPLUM42";
    const hidden = channel(async () => ({ outcome: { outcome: "cancelled" } }));
    expect(await new AcpAsker("s1", hidden, hider(() => [secret])).ask({ ...PLAN_BOX, review: { ...review, markdown: `# Use ${secret}\n` } })).toBeUndefined();
    expect(JSON.stringify([hidden.sent, hidden.updates])).not.toContain(secret);
    // A box without a plan has no plan meta.
    const plain = channel(async () => ({ outcome: { outcome: "cancelled" } }));
    await new AcpAsker("s1", plain).ask({ ...PLAN_BOX, review: undefined });
    expect(plain.sent[0]!.toolCall._meta).toBeUndefined();
  });

  test("No answer to the Build box in time is Stop, the same answer as a cancel, and its step closes failed", async () => {
    const silent = channel((_params, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    expect(await new AcpAsker("s1", silent, undefined, 20).ask(PLAN_BOX)).toBeUndefined();
    expect(silent.updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed",
      content: [{ type: "content", content: { type: "text", text: "→ No (no answer)" } }] });
    // A cancel gives the same answer, so the plan turn stops and keeps the plan for both (tests/acp-plan.integration.test.ts).
    const cancelled = channel(async () => ({ outcome: { outcome: "cancelled" } }));
    expect(await new AcpAsker("s1", cancelled).ask(PLAN_BOX)).toBeUndefined();
  });

  test("Plan steps replace the task stage as hidden entries", () => {
    const secret = "PLUMPLUMPLUM42";
    const mapper = new UpdateMapper(hider(() => [secret]));
    const entries = (updates: Record<string, any>[]) => updates.at(-1)!.entries.map((entry: { content: string; status: string }) => [entry.content, entry.status]);
    // Before the task stage starts, the steps are where it will be.
    expect(entries(mapper.planSteps([{ title: "Write greeting.txt", status: "active" }, { title: `Use ${secret}`, status: "pending" }])))
      .toEqual([["Write greeting.txt", "in_progress"], ["Use <secret hidden>", "pending"]]);
    // The task stage does not show as a stage of its own while there are steps; the checks come after them.
    expect(entries(mapper.map({ type: "phase", phase: "task", state: "start" } as never))).toEqual([["Write greeting.txt", "in_progress"], ["Use <secret hidden>", "pending"]]);
    expect(entries(mapper.planSteps([{ title: "Write greeting.txt", status: "done" }, { title: `Use ${secret}`, status: "not-done", reason: "Waiting for the path" }])))
      .toEqual([["Write greeting.txt", "completed"], ["Use <secret hidden> (not done: Waiting for the path)", "pending"]]);
    expect(entries(mapper.map({ type: "phase", phase: "checks", state: "start" } as never)))
      .toEqual([["Write greeting.txt", "completed"], ["Use <secret hidden> (not done: Waiting for the path)", "pending"], ["Run the project's checks", "in_progress"]]);
    // A new prompt has no steps: the task stage is a stage again.
    mapper.newPrompt();
    expect(entries(mapper.map({ type: "phase", phase: "task", state: "start" } as never))[0]).toEqual(["Do the task", "in_progress"]);
  });

  test("While planning, the model's text is a thought, and an answer without a plan still arrives as a message", () => {
    const secret = "PLUMPLUMPLUM42";
    let planning = true;
    const mapper = new UpdateMapper(hider(() => [secret]), { planning: () => planning });
    const kinds = (updates: Record<string, any>[]) => updates.map((update) => [update.sessionUpdate, update.content.text]);
    // A thought goes out a whole line at a time too, so a secret split across two deltas is hidden whole.
    expect(kinds(mapper.map({ type: "assistant_delta", text: "Reading app.py; the key is PLUMPLUM" }))).toEqual([]);
    expect(kinds(mapper.map({ type: "assistant_delta", text: "PLUM42\nSteps:" }))).toEqual([["agent_thought_chunk", "Reading app.py; the key is <secret hidden>\n"]]);
    expect(kinds(mapper.map({ type: "assistant_message" } as never))).toEqual([["agent_thought_chunk", "Steps:"]]);
    planning = false;
    // The held words, when they were no plan, reach the app as a message of their own.
    expect(kinds(mapper.words(`I could not plan this: ${secret} is unclear.\n`))).toEqual([["agent_message_chunk", "I could not plan this: <secret hidden> is unclear.\n"]]);
    expect(kinds([...mapper.map({ type: "assistant_delta", text: "Next words\n" })])).toEqual([["agent_message_chunk", "\nNext words\n"]]);
    // Not planning, the model's text is a message as before.
    expect(kinds(new UpdateMapper(hider(() => [])).map({ type: "assistant_delta", text: "Hello\n" }))).toEqual([["agent_message_chunk", "Hello\n"]]);
  });
});

describe("an ACP box names its step and carries its diff (decision 85)", () => {
  const file = path.resolve("/work/project/notes/todo.md");
  const edit = { id: "casper-tool-3", diffs: [{ type: "diff", path: file, oldText: "- [ ] one\n", newText: "- [x] one\n" }], locations: [{ path: file }] };
  const cancelled = async () => ({ outcome: { outcome: "cancelled" } });

  test("A box a running step raises names that step and repeats its diffs and file, and a box outside a step names none", async () => {
    const seen = channel(cancelled);
    const asker = new AcpAsker("s1", seen);
    asker.stepOf = () => edit;
    expect(await asker.ask(box)).toBeUndefined();
    const sent = seen.sent[0]!.toolCall;
    // The box's own words first, then the step's diffs; its file, and the step it belongs to.
    expect(sent.content).toEqual([{ type: "content", content: { type: "text", text: "~/notes/todo.md" } }, edit.diffs[0]]);
    expect(sent.locations).toEqual([{ path: file }]);
    expect(sent._meta).toEqual({ casper: { step: "casper-tool-3" } });
    // The tool_call the app saw start carries the same three fields.
    expect(seen.updates[0]).toMatchObject({ sessionUpdate: "tool_call", toolCallId: sent.toolCallId, content: sent.content, locations: sent.locations, _meta: sent._meta });
    // A shell step has no diff and no file: only its id, and a box with no words of its own has no content.
    const shell = channel(cancelled);
    const fromShell = new AcpAsker("s1", shell);
    fromShell.stepOf = () => ({ id: "casper-tool-4", diffs: [] });
    await fromShell.ask({ ...box, preview: undefined });
    expect(shell.sent[0]!.toolCall).not.toHaveProperty("content");
    expect(shell.sent[0]!.toolCall).not.toHaveProperty("locations");
    expect(shell.sent[0]!.toolCall._meta).toEqual({ casper: { step: "casper-tool-4" } });
    // The plan's labels and the step are merged, never one in place of the other.
    const plan = channel(cancelled);
    const fromPlan = new AcpAsker("s1", plan);
    fromPlan.stepOf = () => edit;
    await fromPlan.ask({ ...box, kind: "pick", choices: [{ label: "Stop" }, { label: "Build" }], review: { markdown: "# Plan\n", approve: "Build", change: "Change the plan" } });
    expect(plan.sent[0]!.toolCall._meta).toEqual({ casper: { plan: { approve: "Build", change: "Change the plan" }, step: "casper-tool-3" } });
    // Outside any step: no step, no file, only the box's words, as before.
    const outside = channel(cancelled);
    await new AcpAsker("s1", outside).ask(box);
    expect(outside.sent[0]!.toolCall).not.toHaveProperty("_meta");
    expect(outside.sent[0]!.toolCall).not.toHaveProperty("locations");
    expect(outside.sent[0]!.toolCall.content).toEqual([{ type: "content", content: { type: "text", text: "~/notes/todo.md" } }]);
    // Read only answers No at once, as before: that step names nothing either.
    const readOnly = channel(cancelled);
    const closed = new AcpAsker("s1", readOnly);
    closed.readOnly = () => true;
    closed.stepOf = () => edit;
    expect(await closed.ask(box)).toBeUndefined();
    expect(readOnly.sent).toEqual([]);
    expect(readOnly.updates[0]).not.toHaveProperty("_meta");
    expect(readOnly.updates[0]).not.toHaveProperty("locations");
  });

  test("A linked box is still No for cancelled, an error, an unknown option and no answer in time", async () => {
    const outcomes: Array<(params: Record<string, any>, signal: AbortSignal) => Promise<unknown>> = [
      cancelled,
      async () => { throw new Error("the client could not ask"); },
      async () => ({ outcome: { outcome: "selected", optionId: "9" } }),
      (_params, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    ];
    for (const reply of outcomes) {
      const seen = channel(reply);
      const asker = new AcpAsker("s1", seen, (text) => text, 30);
      asker.stepOf = () => edit;
      expect(await asker.ask(box)).toBeUndefined();
      expect(seen.sent[0]!.toolCall._meta).toEqual({ casper: { step: "casper-tool-3" } });
      expect(seen.updates.at(-1)).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
    }
    // A picked yes is still that label, with the same options in the same order.
    const yes = channel(async (params) => ({ outcome: { outcome: "selected", optionId: params.options[1].optionId } }));
    const asker = new AcpAsker("s1", yes);
    asker.stepOf = () => edit;
    expect(await asker.ask(box)).toEqual([YES_ONCE]);
    expect(yes.sent[0]!.options.map((option: { name: string; kind: string }) => [option.name, option.kind]))
      .toEqual([[NO, "reject_once"], [YES_ONCE, "allow_once"], [YES_SESSION, "allow_always"]]);
  });
});
