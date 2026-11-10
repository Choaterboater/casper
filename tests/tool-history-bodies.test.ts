import { expect, test } from "bun:test";
import type { AssistantMessage, JsonObject, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { newElisions } from "../src/runtime/elision";
import { ToolHistory, TOOL_HISTORY_MIN_BODY_CHARS, type ToolHistoryCheckpoint, type ToolHistoryWindow } from "../src/runtime/tool-history";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A conversation built one round at a time: each round is one tool call and its result. */
class Conversation {
  readonly messages: Message[] = [{ role: "system", content: "Fixed instructions", timestamp: 0 }];
  private clock = 0;
  constructor(request: string) { this.user(request); }
  user(text: string): void { this.messages.push({ role: "user", content: text, timestamp: ++this.clock }); }
  round(name: string, args: JsonObject, output: string, options: { text?: string; isError?: boolean } = {}): string {
    const id = `call_${++this.clock}`;
    const assistant: AssistantMessage = { role: "assistant", content: [{ type: "text", text: options.text ?? "Next step." },
      { type: "toolCall", id, name, arguments: args }], timestamp: this.clock, api: "openai-completions", provider: "fixture",
    model: "fixture", stopReason: "toolUse", usage };
    const result: ToolResultMessage = { role: "toolResult", toolCallId: id, toolName: name, timestamp: this.clock,
      content: [{ type: "text", text: output }], isError: options.isError ?? false };
    this.messages.push(assistant, result);
    return id;
  }
  answer(text: string): void {
    this.messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: ++this.clock, api: "openai-completions",
      provider: "fixture", model: "fixture", stopReason: "stop", usage });
  }
}
/** Distinct code lines per file, so one file's body never quotes another's. */
const code = (file: string, lines: number) => Array.from({ length: lines }, (_, n) => `export const ${file}Value${n} = compute("${file}", ${n});`).join("\n") + "\n";
const filler = (conversation: Conversation, rounds: number) => {
  for (let n = 0; n < rounds; n++) conversation.round("bash", { command: `echo step ${n}` }, `step ${n}`, { text: "Carry on." });
};
const callArgs = (messages: Message[], id: string) => messages.flatMap((message) => message.role === "assistant"
  ? message.content.flatMap((part) => part.type === "toolCall" && part.id === id ? [part.arguments] : []) : [])[0]!;
const window: ToolHistoryWindow = { contextWindow: 40_000 };

test("old write, edit and heredoc bodies become stubs naming the file and its size; the transcript is unchanged", () => {
  const c = new Conversation("Build the tracker.");
  const write = c.round("write", { path: "public/app.js", content: code("app", 120) }, "Successfully wrote to public/app.js");
  const edit = c.round("edit", { path: "src/server.ts", edits: [{ oldText: code("old", 30), newText: code("server", 40) }] }, "Edited src/server.ts");
  const heredoc = c.round("bash", { command: `mkdir -p test && cat > test/api.test.js <<'EOF'\n${code("api", 80)}EOF` }, "");
  const legacy = c.round("edit", { path: "src/db.ts", oldText: code("dbOld", 30), newText: code("db", 30) }, "Edited src/db.ts");
  filler(c, 4);
  const bytes = JSON.stringify(c.messages);
  const projected = new ToolHistory().project(c.messages, true, { ...window, followUp: true });
  expect(projected.checkpoint?.masks.map((mask) => mask.key.split(":")[0])).toEqual(["body", "body", "body", "body"]);
  const sent = projected.messages;
  expect(callArgs(sent, write)).toEqual({ path: "public/app.js", content: "[content of write public/app.js (120 lines) hidden, read the file before judging or editing it]" });
  expect(callArgs(sent, edit)).toEqual({ path: "src/server.ts", edits: [{ oldText: "[hidden]", newText: "[text of 1 replacement in edit src/server.ts hidden, read the file before judging or editing it]" }] });
  expect(callArgs(sent, heredoc)).toEqual({ command: "mkdir -p test && cat > test/api.test.js <<'EOF'\n[content of test/api.test.js (80 lines) hidden, read the file before judging or editing it]\nEOF" });
  expect(callArgs(sent, legacy)).toEqual({ path: "src/db.ts", edits: [{ oldText: "[hidden]", newText: "[text of 1 replacement in edit src/db.ts hidden, read the file before judging or editing it]" }] });
  // Only call arguments change: results, text and the saved conversation stay as they were.
  expect(JSON.stringify(c.messages)).toBe(bytes);
  expect(sent.filter((message) => message.role !== "assistant")).toEqual(c.messages.filter((message) => message.role !== "assistant"));
  // Every stub names its file and tells the model to read it first, so a review never judges code it no longer sees.
  for (const mask of projected.checkpoint!.masks) {
    expect(mask.text.length).toBeLessThanOrEqual(512);
    expect(mask.text).toEndWith(", read the file before judging or editing it]");
  }
});

test("a body stays while it is recent, named, quoted, failed, small, not a file, or hiding is off", () => {
  const c = new Conversation("Build the tracker.");
  const named = c.round("write", { path: "public/named.js", content: code("named", 100) }, "ok");
  const edited = c.round("write", { path: "public/edited.js", content: code("edited", 100) }, "ok");
  const quoted = c.round("write", { path: "public/quoted.js", content: code("quoted", 100) }, "ok");
  const failed = c.round("write", { path: "/root/denied.js", content: code("denied", 100) }, "EACCES", { isError: true });
  const small = c.round("write", { path: "public/small.js", content: "x".repeat(TOOL_HISTORY_MIN_BODY_CHARS - 1) }, "ok");
  const script = c.round("bash", { command: `python3 - <<'EOF'\n${code("script", 100)}EOF` }, "done");
  const two = c.round("bash", { command: `cat > a.txt <<'EOF'\n${code("a", 60)}EOF\ncat > b.txt <<'EOF'\n${code("b", 60)}EOF` }, "");
  // Big enough to outweigh what the rebuild re-reads after it (the cost rule is tested elsewhere).
  const hidden = c.round("write", { path: "public/hidden.js", content: code("hidden", 300) }, "ok");
  filler(c, 2);
  c.round("read", { path: "public/named.js" }, "short", { text: "Checking named.js again." });
  c.round("edit", { path: "public/edited.js", edits: [{ oldText: "a", newText: "b" }] }, "ok");
  c.round("edit", { path: "src/other.ts", edits: [{ oldText: "export const quotedValue7 = compute(\"quoted\", 7);", newText: "x" }] }, "ok");
  const recent = c.round("write", { path: "public/recent.js", content: code("recent", 100) }, "ok");
  const projected = new ToolHistory().project(c.messages, true, { ...window, followUp: true });
  const sent = projected.messages;
  for (const id of [named, edited, quoted, failed, small, script, two, recent]) expect(callArgs(sent, id)).toEqual(callArgs(c.messages, id));
  expect(callArgs(sent, hidden).content).toBe("[content of write public/hidden.js (300 lines) hidden, read the file before judging or editing it]");
  // A model that copies the stub back into a file gets the placeholder note, as for "// ... existing code ...".
  expect(newElisions("", `${callArgs(sent, hidden).content}\n`)).toHaveLength(1);
  expect(newElisions("", "[text of 2 replacements in edit src/a.ts hidden, read the file before judging or editing it]")).toHaveLength(1);
  // A vague pointer back at an earlier write keeps every body this time.
  c.user("Compare it with the previous version.");
  expect(new ToolHistory().project(c.messages, true, { ...window, followUp: true }).checkpoint).toBeUndefined();
  // Off: nothing new is hidden, even at a follow-up round.
  expect(new ToolHistory().project(c.messages.slice(0, -1), false, { ...window, followUp: true })).toEqual({ messages: c.messages.slice(0, -1) });
});

test("a follow-up round hides at once, but not crumbs; between checkpoints the prefix is byte-identical; stubs survive restore", () => {
  const c = new Conversation("Build the tracker.");
  c.round("write", { path: "public/app.js", content: code("app", 200) }, "ok");
  filler(c, 4);
  // An ordinary request waits: below a fifth of the window, eight rounds, or 60% full.
  expect(new ToolHistory().project(c.messages, true, window).checkpoint).toBeUndefined();
  // A follow-up round needs 5% of the window to go: about 2.4k tokens is not enough in a 100k window.
  expect(new ToolHistory().project(c.messages, true, { contextWindow: 100_000, followUp: true }).checkpoint).toBeUndefined();
  const history = new ToolHistory();
  const first = history.project(c.messages, true, { ...window, followUp: true });
  expect(first.checkpoint?.masks).toHaveLength(1);
  let previous = first.messages;
  for (let n = 0; n < 6; n++) {
    c.round("bash", { command: `echo more ${n}` }, "more");
    const next = history.project(c.messages, true, window);
    expect(next.checkpoint).toBeUndefined();
    expect(JSON.stringify(next.messages.slice(0, previous.length))).toBe(JSON.stringify(previous));
    previous = next.messages;
  }
  // Pi restores the projection from saved records before every request; a hidden body stays hidden, even with hiding off.
  const resumed = new ToolHistory(); resumed.restore(first.checkpoint);
  expect(resumed.project(c.messages, false, window).messages).toEqual(previous);
});

/** Each request as Pi makes it: a fresh projector restored from the saved records, then projected. */
function replay(conversation: Message[], options: { enabled: boolean; followUps: Set<number> }) {
  const records: ToolHistoryCheckpoint[] = [];
  let tokens = 0; let breaks = 0; let previous: Message[] | undefined;
  for (let end = 1; end < conversation.length; end++) {
    if (conversation[end]!.role !== "assistant") continue;
    const history = new ToolHistory(); for (const record of records) history.restore(record);
    const request = conversation.slice(0, end);
    const projected = history.project(request, options.enabled, { contextWindow: 200_000, followUp: options.followUps.has(end - 1) });
    if (projected.checkpoint) records.push(projected.checkpoint);
    tokens += Math.ceil(JSON.stringify(projected.messages).length / 4);
    if (previous && JSON.stringify(projected.messages.slice(0, previous.length)) !== JSON.stringify(previous)) breaks++;
    previous = projected.messages;
  }
  return { tokens, breaks };
}

test("a recorded-style build with reviews sends far fewer tokens, with few cache rebuilds", () => {
  const c = new Conversation("Build a habit tracker: an API, a page and tests.");
  const followUps = new Set<number>();
  const files = ["server", "routes", "store", "validate", "app", "render", "styles", "chart", "storage", "format"];
  c.round("read", { path: "package.json" }, `{"name":"tracker","scripts":{"test":"bun test"}}`, { text: "Looking at the project." });
  for (const [index, file] of files.entries()) {
    c.round("write", { path: `src/${file}.ts`, content: code(file, 60 + index * 15) }, `Successfully wrote to src/${file}.ts`, { text: `Writing src/${file}.ts.` });
    if (index % 3 === 2) c.round("bash", { command: "bun test" }, `${index * 4} pass\n0 fail\n` + "ok line\n".repeat(200), { text: "Running the tests." });
  }
  c.round("bash", { command: `cat > test/api.test.ts <<'EOF'\n${code("apiTest", 150)}EOF` }, "", { text: "Adding API tests." });
  c.round("bash", { command: "bun test" }, "1 fail\nexpected 3, got 2", { text: "Running the tests." });
  c.round("edit", { path: "src/store.ts", edits: [{ oldText: code("store", 20), newText: code("storeFixed", 30) }] }, "ok", { text: "Fixing src/store.ts." });
  c.round("bash", { command: "bun test" }, "40 pass\n0 fail", { text: "Running the tests." });
  c.answer("The tracker is built and the tests pass.");
  // Casper's own rounds: a requirements review, then a self-review, each reading and adding a little.
  for (const [round, name] of [["requirements", "reviewOne"], ["self", "reviewTwo"]] as const) {
    c.user(`Casper ${round} review. Work from what you have already read; reopen a file only to check a detail.`);
    followUps.add(c.messages.length - 1);
    c.round("read", { path: "src/routes.ts" }, code("routes", 75), { text: "Checking the routes." });
    c.round("write", { path: `test/${name}.test.ts`, content: code(name, 90) }, "ok", { text: "Adding a missing test." });
    c.round("bash", { command: "bun test" }, "44 pass\n0 fail", { text: "Running the tests." });
    c.answer("Review done.");
  }
  const off = replay(c.messages, { enabled: false, followUps });
  const ordinary = replay(c.messages, { enabled: true, followUps: new Set() });
  const on = replay(c.messages, { enabled: true, followUps });
  // In a 200k window this build never reaches the ordinary marks, so only the follow-up rounds hide anything.
  expect(ordinary.tokens).toBe(off.tokens);
  // Measured on this conversation: about a third fewer tokens over the whole task, from hiding at the first review.
  expect(on.tokens).toBeLessThan(off.tokens * 0.7);
  // The cache is rebuilt once at that checkpoint, never request after request.
  expect(off.breaks).toBe(0);
  expect(on.breaks).toBe(1);
});
