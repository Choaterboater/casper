import { afterAll, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "./support/temp-dir";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccountInfo, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { CLAUDE_SUBSCRIPTION, registerClaudeSubscription, streamClaudeSubscription } from "../src/runtime/claude-subscription";
import { ClaudeSessions } from "../src/runtime/claude-session";

/**
 * One live Claude Code session per conversation (decision 54): Claude Code keeps the turns, thinking included, and its
 * calls of Casper's tools are answered with the results Casper's own tools gave. The fake below behaves as Claude Code
 * does: it reads user messages from the held-open input, runs the model's turns, and calls Casper's tools through the
 * proposal server (a real MCP client over an in-memory link), waiting for each answer before the next model turn.
 */

const root = await mkdtemp(path.join(os.tmpdir(), "casper-claude-live-"));
afterAll(async () => { await removeTempDir(root); });
const catalog = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
await registerClaudeSubscription(catalog, process.cwd(), { env: { CASPER_CLAUDE_PATH: "nonexistent-fixture" } });
const model = catalog.getModel(CLAUDE_SUBSCRIPTION, "claude-opus-4-8")!;
const account: AccountInfo = { apiProvider: "firstParty", subscriptionType: "max", apiKeySource: "none" };
const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const context = normalizeContext({ systemPrompt: "Casper policy.", messages: [{ role: "user", content: "Read the fixture.", timestamp: 1 }], tools: [tool] });

const raw = (event: unknown) => ({ type: "stream_event", event, parent_tool_use_id: null, uuid: "00000000-0000-4000-8000-000000000000", session_id: "fixture" }) as SDKMessage;
/** One model turn: a text answer, or calls of Casper's tools. */
function turn(id: string, reply: { text: string } | { calls: Array<{ id: string; name: string; args: object }> }): { events: SDKMessage[]; calls?: Array<{ id: string; name: string; args: object }> } {
  const blocks = "text" in reply ? [[{ type: "text", text: "" }, { type: "text_delta", text: reply.text }]]
    : reply.calls.map(call => [{ type: "tool_use", id: call.id, name: `mcp__casper__${call.name}`, input: {} }, { type: "input_json_delta", partial_json: JSON.stringify(call.args) }]);
  return { events: [
    raw({ type: "message_start", message: { id, model: model.id, usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } }),
    ...blocks.flatMap(([start, delta], index) => [raw({ type: "content_block_start", index, content_block: start }), raw({ type: "content_block_delta", index, delta }), raw({ type: "content_block_stop", index })]),
    raw({ type: "message_delta", delta: { stop_reason: "text" in reply ? "end_turn" : "tool_use" }, usage: { output_tokens: 3 } }),
    raw({ type: "message_stop" }),
  ], ...("calls" in reply ? { calls: reply.calls } : {}) };
}

/** A scripted turn; `early`: Claude Code calls before Casper has read the turn; `noIds`: an older Claude Code that doesn't
 * name the tool_use in its calls; `quit`: Claude Code ends after the turn. */
type Step = ReturnType<typeof turn> & { early?: boolean; noIds?: boolean; quit?: boolean };
const hang = { hang: true } as unknown as Step;
function claudeCode(script: Step[], info: AccountInfo = account) {
  const sessions: Array<{ options: Options; prompts: SDKUserMessage[]; answers: unknown[]; closed: boolean }> = [];
  let next = 0;
  const query = (input: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) => {
    const record = { options: input.options, prompts: [] as SDKUserMessage[], answers: [] as unknown[], closed: false };
    sessions.push(record);
    return { accountInfo: async () => info, close: () => { record.closed = true; },
      async *[Symbol.asyncIterator]() {
        const server = (input.options.mcpServers?.casper as { instance?: McpServer } | undefined)?.instance;
        const client = new Client({ name: "claude-code-fixture", version: "1" });
        if (server) { const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(a), client.connect(b)]); }
        const prompts = input.prompt[Symbol.asyncIterator]();
        for (;;) {
          const prompt = await prompts.next();
          if (prompt.done || record.closed) return;
          record.prompts.push(prompt.value);
          for (;;) {
            const step = script[next++];
            if (!step) return;
            // Claude Code still working on the next turn (until the session is closed).
            if ("hang" in step) { await new Promise<void>(resolve => { const wait = setInterval(() => { if (record.closed) { clearInterval(wait); resolve(); } }, 5); }); return; }
            // Claude Code calls the tools as soon as the turn ends; Casper may not have read that turn yet ("early").
            const call = (entry: { id: string; name: string; args: object }) => client.callTool({ name: entry.name, arguments: entry.args as Record<string, unknown>,
              ...(step.noIds ? {} : { _meta: { "claudecode/toolUseId": entry.id } }) });
            const early = step.early ? step.calls!.map(call) : undefined;
            yield* step.events;
            if (early) { for (const answer of await Promise.all(early)) record.answers.push(answer); continue; }
            // Claude Code ended after the turn without calling the tools (a crash, its own limit): its result, then gone.
            if (step.quit) {
              yield { type: "result", subtype: "error_max_turns", is_error: true, errors: ["Reached maximum number of turns (1)"] } as unknown as SDKMessage;
              await new Promise<void>(resolve => { const wait = setInterval(() => { if (record.closed) { clearInterval(wait); resolve(); } }, 5); });
              return;
            }
            if (!step.calls) { yield { type: "result", subtype: "success", is_error: false } as SDKMessage; break; }
            for (const entry of step.calls) record.answers.push(await call(entry));
          }
        }
      } };
  };
  return { query, sessions };
}

const result = (id: string, text: string): Message => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 3 });

test("a tool call and its result go on in the same Claude Code session: nothing is replayed, and Claude Code's call gets Casper's result", async () => {
  const fake = claudeCode([turn("msg_1", { calls: [{ id: "call_1", name: "read", args: { path: "fixture.txt" } }] }), turn("msg_2", { text: "It says hello." })]);
  const deps = { query: fake.query, executable: "fixture", sessions: new ClaudeSessions() };
  const first = await streamClaudeSubscription(model, context, { reasoning: "medium" }, deps).result();
  expect(first).toMatchObject({ stopReason: "toolUse", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "fixture.txt" } }] });
  const second = await streamClaudeSubscription(model, normalizeContext({ messages: [...context.messages, first, result("call_1", "hello from the file")] }),
    { reasoning: "medium" }, deps).result();
  expect(second).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "It says hello." }] });
  // One Claude Code session, one message sent to it: the tool result went through the proposal server, not a replay.
  expect(fake.sessions).toHaveLength(1);
  expect(fake.sessions[0]!.prompts).toHaveLength(1);
  expect(fake.sessions[0]!.answers).toEqual([{ isError: false, content: [{ type: "text", text: "hello from the file" }] }]);
  // Claude Code runs Casper's tools only through the proposal server, never its own.
  expect(fake.sessions[0]!.options).toMatchObject({ tools: [], persistSession: false, settingSources: [], permissionMode: "default" });
  expect(fake.sessions[0]!.options.allowedTools).toBeUndefined();
  expect(fake.sessions[0]!.options.maxTurns).toBeUndefined();
  expect(await fake.sessions[0]!.options.canUseTool!("Bash", {}, {} as never)).toMatchObject({ behavior: "deny" });
  expect(fake.sessions[0]!.closed).toBe(false);
  deps.sessions.closeAll();
  expect(fake.sessions[0]!.closed).toBe(true);
});

test("a follow-up request in the same conversation is one new message to the same session", async () => {
  const fake = claudeCode([turn("msg_1", { text: "Done." }), turn("msg_2", { text: "Again." })]);
  const deps = { query: fake.query, executable: "fixture", sessions: new ClaudeSessions() };
  const first = await streamClaudeSubscription(model, context, undefined, deps).result();
  const next = normalizeContext({ messages: [...context.messages, first, { role: "user", content: "And once more.", timestamp: 4 }] });
  expect(await streamClaudeSubscription(model, next, undefined, deps).result()).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Again." }] });
  expect(fake.sessions).toHaveLength(1);
  expect(fake.sessions[0]!.prompts[1]!.message.content).toEqual([{ type: "text", text: "And once more." }]);
  deps.sessions.closeAll();
});

test("a request that doesn't go on from the session (compaction, a fork, a resume) starts a new session that replays the transcript", async () => {
  const fake = claudeCode([turn("msg_1", { text: "Done." }), turn("msg_2", { text: "From the summary." })]);
  const deps = { query: fake.query, executable: "fixture", sessions: new ClaudeSessions() };
  await streamClaudeSubscription(model, context, undefined, deps).result();
  // Compaction replaces the history with a summary: not this session's messages.
  const compacted = normalizeContext({ systemPrompt: "Casper policy.", tools: [tool], messages: [{ role: "user", content: "Summary: the fixture was read.", timestamp: 9 },
    { role: "user", content: "Go on.", timestamp: 10 }] });
  expect(await streamClaudeSubscription(model, compacted, undefined, deps).result()).toMatchObject({ content: [{ type: "text", text: "From the summary." }] });
  expect(fake.sessions).toHaveLength(2);
  expect(fake.sessions[1]!.prompts[0]!.message.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Continue the following conversation") });
  expect(JSON.stringify(fake.sessions[1]!.prompts[0])).toContain("Summary: the fixture was read.");
  deps.sessions.closeAll();
});

test.each([["names its tool_use", false], ["names none (an older Claude Code)", true]])("each of Claude Code's calls gets the result of its own proposal, even when it calls before Casper has read the turn: Claude Code %s", async (_, noIds) => {
  const fake = claudeCode([{ ...turn("msg_1", { calls: [{ id: "call_1", name: "read", args: { path: "a.txt" } }] }), noIds },
    { ...turn("msg_2", { calls: [{ id: "call_2", name: "write", args: { path: "b.txt" } }, { id: "call_3", name: "read", args: { path: "c.txt" } }] }), early: true, noIds },
    turn("msg_3", { text: "Done." })]);
  const deps = { query: fake.query, executable: "fixture", sessions: new ClaudeSessions() };
  const writer = { name: "write", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
  const start = normalizeContext({ systemPrompt: "Casper policy.", messages: [{ role: "user", content: "Go.", timestamp: 1 }], tools: [tool, writer] });
  const first = await streamClaudeSubscription(model, start, undefined, deps).result();
  const asked = [...start.messages, first, result("call_1", "A")];
  const second = await streamClaudeSubscription(model, normalizeContext({ messages: asked }), undefined, deps).result();
  expect(second.content.map(block => block.type === "toolCall" ? block.id : block.type)).toEqual(["call_2", "call_3"]);
  // Pi sends the results in its own order; each still reaches the call it belongs to.
  const results = [{ ...result("call_3", "C"), toolName: "read" }, { ...result("call_2", "wrote B"), toolName: "write" }];
  const third = await streamClaudeSubscription(model, normalizeContext({ messages: [...asked, second, ...results] }), undefined, deps).result();
  expect(third.content).toEqual([{ type: "text", text: "Done." }]);
  expect(fake.sessions).toHaveLength(1);
  expect(fake.sessions[0]!.answers).toEqual([{ isError: false, content: [{ type: "text", text: "A" }] },
    { isError: false, content: [{ type: "text", text: "wrote B" }] }, { isError: false, content: [{ type: "text", text: "C" }] }]);
  deps.sessions.closeAll();
});

test("a session that ends between turns is closed, and the request starts a new session that replays the transcript", async () => {
  const quits = { ...turn("msg_1", { calls: [{ id: "call_1", name: "read", args: { path: "fixture.txt" } }] }), quit: true };
  const fake = claudeCode([quits, turn("msg_2", { text: "It says hello." })]);
  const deps = { query: fake.query, executable: "fixture", sessions: new ClaudeSessions() };
  const first = await streamClaudeSubscription(model, context, undefined, deps).result();
  expect(first.stopReason).toBe("toolUse");
  const second = await streamClaudeSubscription(model, normalizeContext({ messages: [...context.messages, first, result("call_1", "hello from the file")] }),
    undefined, deps).result();
  expect(second).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "It says hello." }] });
  expect(fake.sessions).toHaveLength(2);
  expect(fake.sessions[0]!.closed).toBe(true);
  expect(JSON.stringify(fake.sessions[1]!.prompts[0])).toContain("hello from the file");
  deps.sessions.closeAll();
});

test("a session's sign-in is checked before anything is sent; a refused plan, an aborted request or a side request keeps no session", async () => {
  const refused = claudeCode([turn("msg_1", { text: "never" })], { apiProvider: "firstParty", subscriptionType: "free", apiKeySource: "none" });
  const deps = { query: refused.query, executable: "fixture", sessions: new ClaudeSessions() };
  const denied = await streamClaudeSubscription(model, context, undefined, deps).result();
  expect(denied.stopReason).toBe("error");
  expect(denied.errorMessage).toContain("paid Claude plan");
  expect(refused.sessions[0]!.prompts).toHaveLength(0);
  expect(refused.sessions[0]!.closed).toBe(true);
  expect(deps.sessions.sessions).toHaveLength(0);
  // A side request with no tools (a title, a summary) is answered and its session closed.
  const side = claudeCode([turn("msg_1", { text: "A title" })]);
  const sideDeps = { query: side.query, executable: "fixture", sessions: new ClaudeSessions() };
  await streamClaudeSubscription(model, context, { toolChoice: "none" }, sideDeps).result();
  expect(side.sessions[0]!.closed).toBe(true);
  expect(sideDeps.sessions.sessions).toHaveLength(0);
  // A request stopped while Claude Code works on its turn closes the session; the next request starts afresh.
  const stopped = claudeCode([turn("msg_1", { calls: [{ id: "call_1", name: "read", args: { path: "a" } }] }), hang]);
  const stoppedDeps = { query: stopped.query, executable: "fixture", sessions: new ClaudeSessions() };
  const controller = new AbortController();
  const first = await streamClaudeSubscription(model, context, undefined, stoppedDeps).result();
  setTimeout(() => controller.abort(), 30);
  const aborted = await streamClaudeSubscription(model, normalizeContext({ messages: [...context.messages, first as AssistantMessage, result("call_1", "x")] }),
    { signal: controller.signal }, stoppedDeps).result();
  expect(aborted.stopReason).toBe("aborted");
  expect(stopped.sessions[0]!.closed).toBe(true);
  expect(stoppedDeps.sessions.sessions).toHaveLength(0);
});

test("a registration's live sessions end with the runtime that registered them, so Claude Code doesn't keep Casper running", async () => {
  const fake = claudeCode([turn("msg_1", { calls: [{ id: "call_1", name: "read", args: { path: "fixture.txt" } }] }), hang]);
  const native = path.join(root, "registered.exe"); await writeFile(native, "synthetic");
  const isolated = await ModelRuntime.create({ authPath: path.join(root, "registered-auth.json"), modelsPath: null, refreshOnCreate: false });
  const sessions = await registerClaudeSubscription(isolated, root, { env: { CASPER_CLAUDE_PATH: native }, query: fake.query as never,
    status: async () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }) });
  const registered = isolated.getModel(CLAUDE_SUBSCRIPTION, "claude-opus-4-8")!;
  const response = await isolated.streamSimple(registered, { systemPrompt: "Casper policy.", messages: [{ role: "user", content: "Read the fixture.", timestamp: 1 }], tools: [tool] }).result();
  expect(response.stopReason).toBe("toolUse");
  expect(fake.sessions).toHaveLength(1); expect(fake.sessions[0]!.closed).toBe(false);
  sessions.closeAll();
  expect(fake.sessions[0]!.closed).toBe(true);
});
