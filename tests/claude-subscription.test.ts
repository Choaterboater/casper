import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { removeTempDir } from "./support/temp-dir";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AccountInfo, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { assertSubscriptionAccount, claudeExecutable, CLAUDE_SUBSCRIPTION, proposalServer, registerClaudeSubscription, streamClaudeSubscription, subscriptionEnvironment, subscriptionPrompt } from "../src/runtime/claude-subscription";
import { subscriptionName } from "../src/tui/usage";

const account: AccountInfo = { apiProvider: "firstParty", subscriptionType: "max", apiKeySource: "none" };
const tool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const context = normalizeContext({ systemPrompt: "Casper policy: ask before consequential actions.",
  messages: [{ role: "user", content: "Read the fixture.", timestamp: 1 }], tools: [tool] });
const root = await mkdtemp(path.join(os.tmpdir(), "casper-claude-subscription-"));
afterAll(async () => { await removeTempDir(root); });
const catalog = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
await registerClaudeSubscription(catalog, process.cwd(), { env: { CASPER_CLAUDE_PATH: "nonexistent-fixture" } });
const model = catalog.getModel(CLAUDE_SUBSCRIPTION, "claude-opus-4-8")!;

function raw(event: unknown): SDKMessage {
  return { type: "stream_event", event, parent_tool_use_id: null, uuid: "00000000-0000-4000-8000-000000000000", session_id: "fixture" } as SDKMessage;
}
function result(subtype = "success"): SDKMessage {
  return { type: "result", subtype, is_error: subtype !== "success", errors: ["synthetic failure"] } as SDKMessage;
}
function events(toolCall = false): SDKMessage[] {
  return [
    raw({ type: "message_start", message: { id: "msg_fixture", model: model.id, usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } }),
    raw({ type: "content_block_start", index: 0, content_block: toolCall ? { type: "tool_use", id: "call_fixture", name: "mcp__casper__read", input: {} } : { type: "text", text: "" } }),
    raw({ type: "content_block_delta", index: 0, delta: toolCall ? { type: "input_json_delta", partial_json: '{"path":"fixture.txt"}' } : { type: "text_delta", text: "Hello" } }),
    raw({ type: "content_block_stop", index: 0 }),
    raw({ type: "message_delta", delta: { stop_reason: toolCall ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } }),
    raw({ type: "message_stop" }), result(toolCall ? "error_max_turns" : "success"),
  ];
}
function fakeQuery(messages = events(), info: AccountInfo = account) {
  let calls = 0;
  let captured: { options: Options; prompt: AsyncIterable<SDKUserMessage> } | undefined;
  let closed = false; const prompts: SDKUserMessage[] = [];
  const query = (input: { options: Options; prompt: AsyncIterable<SDKUserMessage> }) => {
    calls++; captured = input;
    return { accountInfo: async () => info, close: () => { closed = true; },
      async *[Symbol.asyncIterator]() { for await (const prompt of input.prompt) prompts.push(prompt); yield* messages; } };
  };
  return { query, options: () => captured!.options, prompts, closed: () => closed, calls: () => calls };
}

test("a subscription catalog without native Claude Code has no available models or fabricated authentication", async () => {
  const isolated = await ModelRuntime.create({ authPath: path.join(root, "missing-auth.json"), modelsPath: null, refreshOnCreate: false });
  await registerClaudeSubscription(isolated, root, { env: { CASPER_CLAUDE_PATH: "nonexistent-fixture" } });
  await isolated.getAvailable();
  expect(isolated.getModel(CLAUDE_SUBSCRIPTION, "claude-opus-4-8")).toBeDefined();
  expect(isolated.hasConfiguredAuth(CLAUDE_SUBSCRIPTION)).toBe(false);
  expect(isolated.getAvailableSnapshot().filter(entry => entry.provider === CLAUDE_SUBSCRIPTION)).toEqual([]);
});

test("registering the subscription provider leaves the existing anthropic provider and models unchanged", async () => {
  const isolated = await ModelRuntime.create({ authPath: path.join(root, "unchanged-auth.json"), modelsPath: null, refreshOnCreate: false });
  const provider = isolated.getProvider("anthropic");
  const models = structuredClone(isolated.getModels("anthropic"));
  await registerClaudeSubscription(isolated, root, { env: { CASPER_CLAUDE_PATH: "nonexistent-fixture" } });
  expect(isolated.getProvider("anthropic")).toBe(provider);
  expect(isolated.getModels("anthropic")).toEqual(models);
});

test("subscription provider is distinct, enabled and dispatched through ModelRuntime, without an API key", async () => {
  expect(model.provider).toBe(CLAUDE_SUBSCRIPTION);
  expect(catalog.getModel("anthropic", model.id)).toBeDefined();
  expect(subscriptionName(CLAUDE_SUBSCRIPTION)).toBe("Claude subscription");
  // Missing executable is a provider error, not a request through the Anthropic HTTP adapter.
  const response = await catalog.completeSimple(model, { messages: [] }, { env: { CASPER_CLAUDE_PATH: "nonexistent-fixture" } });
  expect(response.stopReason).toBe("error");
  expect(response.errorMessage).toContain("native Claude Code");
});

test("native executable discovery supports Windows paths and rejects npm command shims", async () => {
  // These files only stand in for installed executables; no program is run.
  expect(claudeExecutable({ CASPER_CLAUDE_PATH: import.meta.path }, "darwin", () => null)).toBe(realpathSync(import.meta.path));
  const exe = path.join(root, "Claude Code.exe"); await writeFile(exe, "synthetic");
  expect(claudeExecutable({}, "win32", name => name === "claude.exe" ? exe : null)).toBe(realpathSync(exe));
  expect(claudeExecutable({ CASPER_CLAUDE_PATH: "C:\\fixture\\claude.cmd" }, "win32", () => null)).toBeUndefined();
});

test("native Claude discovery uses claude on Mac/Linux and claude.exe on Windows", async () => {
  const native = path.join(root, "discovery.exe"); await writeFile(native, "synthetic");
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const requested: string[] = [];
    expect(claudeExecutable({}, platform, name => { requested.push(name); return native; })).toBe(realpathSync(native));
    expect(requested).toEqual([platform === "win32" ? "claude.exe" : "claude"]);
  }
});

test("CASPER_CLAUDE_PATH overrides discovery on Mac and native Windows", async () => {
  const native = path.join(root, "override.exe"); await writeFile(native, "synthetic");
  for (const platform of ["darwin", "win32"] as const) {
    expect(claudeExecutable({ CASPER_CLAUDE_PATH: native }, platform, () => { throw new Error("PATH must not be searched"); })).toBe(realpathSync(native));
  }
});

test("native Windows executable override accepts case-insensitive environment names", async () => {
  const native = path.join(root, "case-override.exe"); await writeFile(native, "synthetic");
  expect(claudeExecutable({ casper_claude_path: native }, "win32", () => null)).toBe(realpathSync(native));
});

test("Windows case variants of API, gateway and cloud overrides are cleared too", () => {
  const env = { anthropic_api_key: "synthetic", Anthropic_Base_Url: "https://example.invalid", claude_code_use_vertex: "1", claude_code_oauth_token: "synthetic" };
  const clean = subscriptionEnvironment(env);
  for (const name of Object.keys(env)) expect(clean[name]).toBeUndefined();
});

test("subscription availability trusts only native Claude Code's signed-in plan status", async () => {
  const native = path.join(root, "status.exe"); await writeFile(native, "synthetic");
  let status: { loggedIn: boolean; authMethod: string; subscriptionType: string } = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };
  const isolated = await ModelRuntime.create({ authPath: path.join(root, "status-auth.json"), modelsPath: null, refreshOnCreate: false });
  await registerClaudeSubscription(isolated, root, { env: { CASPER_CLAUDE_PATH: native }, status: async () => status });
  await isolated.getAvailable();
  expect(isolated.hasConfiguredAuth(CLAUDE_SUBSCRIPTION)).toBe(true);
  expect((await isolated.getAuth(CLAUDE_SUBSCRIPTION))?.auth).toEqual({});
  for (const invalid of [{ ...status, loggedIn: false }, { ...status, authMethod: "api_key" }, { ...status, subscriptionType: "unknown" }]) {
    status = invalid;
    await isolated.getAvailable();
    expect(isolated.hasConfiguredAuth(CLAUDE_SUBSCRIPTION)).toBe(false);
  }
});

test("subscription environment explicitly clears API, gateway, cloud and inherited identity overrides", () => {
  const original = { PATH: "fixture", ANTHROPIC_API_KEY: "synthetic", ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_CUSTOM_HEADERS: "synthetic", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_OAUTH_TOKEN: "synthetic", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CONFIG_DIR: "fixture" };
  const clean = subscriptionEnvironment(original);
  expect(clean.ANTHROPIC_API_KEY).toBeUndefined(); expect(clean.ANTHROPIC_BASE_URL).toBeUndefined();
  expect(clean.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined(); expect(clean.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  expect(clean.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined(); expect(clean.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  expect(clean.PATH).toBe("fixture"); expect(clean.CLAUDE_CONFIG_DIR).toBe("fixture");
  expect(original.ANTHROPIC_API_KEY).toBe("synthetic");
});

test("account check rejects API keys, gateways and unknown plans", () => {
  expect(() => assertSubscriptionAccount(account)).not.toThrow();
  for (const info of [{ ...account, apiKeySource: "ANTHROPIC_API_KEY" }, { ...account, apiProvider: "gateway" as const }, { ...account, subscriptionType: undefined }, {}]) {
    expect(() => assertSubscriptionAccount(info)).toThrow("No API-key fallback");
  }
});

test("MCP declarations preserve JSON schemas and cannot execute tools", async () => {
  const server = proposalServer([tool]); const client = new Client({ name: "fixture", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    expect((await client.listTools()).tools[0]).toMatchObject({ name: tool.name, inputSchema: tool.parameters });
    expect(await client.callTool({ name: "read", arguments: { path: "fixture.txt" } })).toMatchObject({ isError: true });
  } finally { await client.close(); await server.close(); }
});

test("text streams and usage translate, with prompt fidelity and no SDK-side execution", async () => {
  const fake = fakeQuery(); const stream = streamClaudeSubscription(model, context, { reasoning: "high", maxTokens: 100, cacheRetention: "none" },
    { ...fake, executable: "fixture", cwd: "fixture-project", env: { ANTHROPIC_API_KEY: "synthetic" } });
  const observed = []; for await (const event of stream) observed.push(event.type);
  const response = await stream.result();
  expect(response.stopReason).toBe("stop"); expect(response.content).toEqual([{ type: "text", text: "Hello" }]);
  expect(response.usage).toMatchObject({ input: 20, output: 3, cacheRead: 10, cacheWrite: 5, totalTokens: 38 });
  expect(observed).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
  expect(fake.options()).toMatchObject({ systemPrompt: "Casper policy: ask before consequential actions.", cwd: "fixture-project", tools: [], maxTurns: 1,
    strictMcpConfig: true, settingSources: [], persistSession: false, effort: "high", permissionMode: "dontAsk" });
  expect(fake.options().env!.ANTHROPIC_API_KEY).toBeUndefined();
  expect(fake.options().env!.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("100");
  expect(await fake.options().canUseTool!("Bash", {}, {} as never)).toMatchObject({ behavior: "deny" });
  expect(fake.prompts).toHaveLength(1); expect(fake.closed()).toBe(true);
});

test("each completion creates one SDK query and replays visible history as labelled text, without native resume", async () => {
  const first = fakeQuery();
  const response = await streamClaudeSubscription(model, context, undefined, { ...first, executable: "fixture" }).result();
  const second = fakeQuery();
  await streamClaudeSubscription(model, normalizeContext({ messages: [...context.messages, response, { role: "user", content: "Next request", timestamp: 2 }] }),
    undefined, { ...second, executable: "fixture" }).result();
  for (const fake of [first, second]) {
    expect(fake.calls()).toBe(1); expect(fake.prompts).toHaveLength(1);
    expect(fake.options().persistSession).toBe(false);
    expect(fake.options().resume).toBeUndefined(); expect(fake.options().continue).toBeUndefined();
  }
  expect(second.prompts[0]!.message.content).toEqual([
    { type: "text", text: "USER:" }, { type: "text", text: "Read the fixture." },
    { type: "text", text: "ASSISTANT:" }, { type: "text", text: "Hello" },
    { type: "text", text: "USER:" }, { type: "text", text: "Next request" },
  ]);
});

test("Claude Code receives no Casper-managed credentials, refresh, identity or billing-header recipe", async () => {
  const fake = fakeQuery();
  await streamClaudeSubscription(model, context, { apiKey: "synthetic", headers: { "x-app": "synthetic" }, metadata: { user_id: "synthetic" } },
    { ...fake, executable: "fixture", env: {} }).result();
  expect(fake.options().env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  expect(fake.options().pathToClaudeCodeExecutable).toBe("fixture");
  expect(fake.options().settingSources).toEqual([]);
});

test("tool proposals are returned to Casper, not run by the SDK", async () => {
  const fake = fakeQuery(events(true));
  const response = await streamClaudeSubscription(model, context, undefined, { ...fake, executable: "fixture" }).result();
  expect(response.stopReason).toBe("toolUse");
  expect(response.content).toEqual([{ type: "toolCall", name: "read", id: "call_fixture", arguments: { path: "fixture.txt" } }]);
});

test("failed subscription auth never releases a user prompt", async () => {
  const fake = fakeQuery(events(), { ...account, apiKeySource: "ANTHROPIC_API_KEY" });
  const response = await streamClaudeSubscription(model, context, undefined, { ...fake, executable: "fixture" }).result();
  expect(response.stopReason).toBe("error"); expect(fake.prompts).toHaveLength(0); expect(fake.closed()).toBe(true);
});

test("undeclared tools, invalid arguments, server errors and truncated streams fail closed", async () => {
  const unknown = events(true); unknown[1] = raw({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "fixture", name: "Bash" } });
  const invalid = events(true); invalid[2] = raw({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "[]" } });
  for (const messages of [unknown, invalid, events().slice(0, 3), [result("error_during_execution")]]) {
    const fake = fakeQuery(messages);
    expect((await streamClaudeSubscription(model, context, undefined, { ...fake, executable: "fixture" }).result()).stopReason).toBe("error");
    expect(fake.closed()).toBe(true);
  }
});

test("an already aborted call does not launch a subprocess", async () => {
  const fake = fakeQuery(); const controller = new AbortController(); controller.abort();
  const response = await streamClaudeSubscription(model, context, { signal: controller.signal }, { ...fake, executable: "fixture" }).result();
  expect(response.stopReason).toBe("aborted"); expect(fake.closed()).toBe(false);
});

test("cancellation and timeout during SDK initialization close the query without releasing input", async () => {
  for (const cancel of [false, true]) {
    const fake = fakeQuery(); const controller = new AbortController();
    const query = (input: Parameters<typeof fake.query>[0]) => ({ ...fake.query(input), accountInfo: () => new Promise<AccountInfo>(() => {}) });
    const stream = streamClaudeSubscription(model, context, { signal: controller.signal, timeoutMs: cancel ? 1_000 : 5 }, { query, executable: "fixture" });
    if (cancel) setTimeout(() => controller.abort(), 5);
    const response = await stream.result();
    expect(response.stopReason).toBe(cancel ? "aborted" : "error");
    expect(fake.closed()).toBe(true); expect(fake.prompts).toHaveLength(0);
  }
});

test("tool-less side requests do not expose tools and truncated tool proposals are not executable", async () => {
  const fake = fakeQuery();
  await streamClaudeSubscription(model, context, { toolChoice: "none" }, { ...fake, executable: "fixture" }).result();
  expect(fake.options().mcpServers).toEqual({});
  const truncated = events(true);
  truncated[4] = raw({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 3 } });
  const response = await streamClaudeSubscription(model, context, undefined, { ...fakeQuery(truncated), executable: "fixture" }).result();
  expect(response.stopReason).toBe("error"); expect(response.errorMessage).toContain("output limit");
});

test("history preserves real results and images after a fork or compaction, without replaying thinking", () => {
  const prompt = subscriptionPrompt(normalizeContext({ messages: [
    { role: "user", content: [{ type: "image", data: "fixture", mimeType: "image/png" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "thinking", thinking: "not replayed" }, { type: "toolCall", name: "read", id: "fixture", arguments: { path: "fixture.txt" } }],
      api: model.api, provider: model.provider, model: model.id, timestamp: 2, stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: "toolResult", toolCallId: "fixture", toolName: "read", content: [{ type: "text", text: "actual file content" }], isError: false, timestamp: 3 },
  ] }));
  const text = JSON.stringify(prompt);
  expect(text).toContain("actual file content"); expect(text).toContain("Historical tool call");
  expect(text).toContain('"type":"image"'); expect(text).not.toContain("not replayed");
});
