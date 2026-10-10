import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import type { AccountInfo, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { calculateCost, createAssistantMessageEventStream, type Api, type AssistantMessage, type Model, type SimpleStreamOptions, type Tool, type TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const CLAUDE_SUBSCRIPTION = "claude-subscription";
const PREFIX = "mcp__casper__";
type QueryFactory = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Pick<Query, "accountInfo" | "close" | typeof Symbol.asyncIterator>;

/** Use the installed native CLI, including in compiled Casper. The SDK's bundled executable
 * cannot be addressed inside a Bun executable. Never use a shell to launch a Windows .cmd shim. */
export function claudeExecutable(env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform, which: (name: string) => string | null = Bun.which): string | undefined {
  const override = platform === "win32" ? Object.entries(env).find(([name]) => name.toUpperCase() === "CASPER_CLAUDE_PATH")?.[1] : env.CASPER_CLAUDE_PATH;
  const candidate = override || (platform === "win32" ? which("claude.exe") : which("claude"));
  if (!candidate || (platform === "win32" && !candidate.toLowerCase().endsWith(".exe"))) return undefined;
  try { return realpathSync(candidate); } catch { return undefined; }
}

/** Clear API/gateway/cloud overrides even when the SDK merges env with process.env.
 * No credentials are read or copied. Claude Code owns its own login and refresh. */
export function subscriptionEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const clean = { ...env };
  for (const name of Object.keys(clean)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_SESSION_ACCESS_TOKEN$|CLAUDE_CODE_HOST_SESSION_ID$|CLAUDE_CODE_ENTRYPOINT$|CLAUDE_AGENT_SDK_ENTRYPOINT$)/i.test(name)) clean[name] = undefined;
  }
  return { ...clean, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
}

export function assertSubscriptionAccount(account: AccountInfo): void {
  if (account.apiProvider !== "firstParty" || !/^(pro|max|team|enterprise)$/i.test(account.subscriptionType ?? "")
    || !["none", "oauth"].includes(account.apiKeySource ?? "")) {
    throw new Error("Claude subscription requires Claude Code signed in to a Pro, Max, Team or Enterprise plan. No API-key fallback was used.");
  }
}

/** Casper's transcript is authoritative. Replaying a labelled transcript avoids editing
 * Claude Code's private session files and works after compaction, forks and restarts.
 * Thinking is not replayed as text; image inputs and actual tool results are retained. */
export function subscriptionPrompt(context: TranscriptContext): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = [];
  for (const message of context.messages) {
    if (message.role === "system") continue;
    const label = message.role === "toolResult"
      ? `TOOL RESULT ${message.toolName} (${message.toolCallId})${message.isError ? " ERROR" : ""}:`
      : `${message.role.toUpperCase()}:`;
    content.push({ type: "text", text: label });
    if (typeof message.content === "string") { content.push({ type: "text", text: message.content }); continue; }
    for (const block of message.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "image") {
        if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType)) throw new Error(`Unsupported Claude image type: ${block.mimeType}`);
        content.push({ type: "image", source: { type: "base64", data: block.data, media_type: block.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp" } });
      } else if (block.type === "toolCall") content.push({ type: "text", text: `Historical tool call ${block.name} (${block.id}): ${JSON.stringify(block.arguments)}` });
    }
  }
  return { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content } };
}

/** Only declarations cross the SDK boundary. Neither this handler nor canUseTool can
 * execute anything; Pi receives proposals and calls Casper's existing gated tools. */
export function proposalServer(tools: readonly Tool[]): McpServer {
  const server = new McpServer({ name: "casper", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({
    name: tool.name, description: tool.description, inputSchema: { ...tool.parameters, type: "object" as const },
    _meta: { "anthropic/alwaysLoad": true },
  })) }));
  server.server.setRequestHandler(CallToolRequestSchema, async () => ({
    isError: true, content: [{ type: "text", text: "Tool execution belongs to Casper, not this model transport." }],
  }));
  return server;
}

export function streamClaudeSubscription(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions,
  dependencies: { query?: QueryFactory; executable?: string; env?: Record<string, string | undefined>; cwd?: string } = {}) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], timestamp: Date.now(), stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  void (async () => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options?.signal?.addEventListener("abort", abort, { once: true });
    let query: ReturnType<QueryFactory> | undefined;
    let server: McpServer | undefined;
    let release: (() => void) | undefined;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let authorized = false;
    try {
      options?.signal?.throwIfAborted();
      const inheritedEnv = { ...(dependencies.env ?? process.env), ...options?.env };
      const executable = dependencies.executable ?? claudeExecutable(inheritedEnv);
      if (!executable) throw new Error("Claude subscription needs a native Claude Code installation on PATH (claude.exe on Windows), or CASPER_CLAUDE_PATH pointing to it. Sign in using Claude Code first.");
      const factory = dependencies.query ?? (await import("@anthropic-ai/claude-agent-sdk")).query;
      const tools = options?.toolChoice === "none" ? [] : getCurrentTools(context.messages);
      const names = new Set(tools.map(tool => tool.name));
      server = proposalServer(tools);
      const prompt = subscriptionPrompt(context);
      const reasoning = options?.reasoning;
      const env = subscriptionEnvironment(inheritedEnv);
      if (options?.maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(options.maxTokens);
      if (options?.cacheRetention === "none") env.DISABLE_PROMPT_CACHING = "1";
      query = factory({ prompt: (async function* () { await ready; if (authorized && !controller.signal.aborted) yield prompt; })(), options: {
        cwd: dependencies.cwd ?? process.cwd(), pathToClaudeCodeExecutable: executable, env,
        model: model.id, systemPrompt: getCurrentSystemPrompt(context.messages), tools: [],
        mcpServers: tools.length ? { casper: { type: "sdk", name: "casper", instance: server } } : {},
        strictMcpConfig: true, settingSources: [], persistSession: false, includePartialMessages: true,
        permissionMode: "dontAsk", canUseTool: async () => ({ behavior: "deny", message: "Casper executes all tools." }),
        maxTurns: 1, abortController: controller,
        ...(reasoning ? { effort: reasoning === "minimal" ? "low" : reasoning } : { thinking: { type: "disabled" as const } }),
      } });
      const account = await new Promise<AccountInfo>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", cancelled); };
        const fail = (error: unknown) => { cleanup(); reject(error); };
        const cancelled = () => fail(new Error("Claude subscription request aborted."));
        const timer = setTimeout(() => fail(new Error("Claude Code initialization timed out.")), options?.timeoutMs ?? 30_000);
        controller.signal.addEventListener("abort", cancelled, { once: true });
        Promise.resolve().then(() => query!.accountInfo()).then(value => { cleanup(); resolve(value); }, fail);
        // Abort can precede installing the listener while the SDK module loads.
        if (controller.signal.aborted) cancelled();
      });
      options?.signal?.throwIfAborted();
      assertSubscriptionAccount(account);
      authorized = true; release!();
      stream.push({ type: "start", partial: message });
      const blocks = new Map<number, number>();
      const json = new Map<number, string>();
      let completed = false;
      for await (const event of query) {
        options?.signal?.throwIfAborted();
        if (event.type === "system" && event.subtype === "init" && !["none", "oauth"].includes(event.apiKeySource)) throw new Error("Claude Code switched to API-key authentication; subscription request stopped.");
        if (event.type === "assistant" && event.error) {
          const detail = event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
          throw new Error(`Claude subscription request failed: ${detail || event.error}`);
        }
        if (event.type === "result") {
          if (event.is_error && !(event.subtype === "error_max_turns" && message.content.some(block => block.type === "toolCall"))) {
            throw new Error(event.subtype === "success" ? "Claude subscription request failed." : event.errors.join("\n"));
          }
          completed = true;
          continue;
        }
        if (event.type !== "stream_event" || event.parent_tool_use_id) continue;
        const raw = event.event;
        if (raw.type === "message_start") {
          if (message.responseId) throw new Error("Claude returned multiple model turns to a single-turn transport.");
          message.responseId = raw.message.id; message.responseModel = raw.message.model;
          message.usage.input = raw.message.usage.input_tokens;
          message.usage.output = raw.message.usage.output_tokens;
          message.usage.cacheRead = raw.message.usage.cache_read_input_tokens ?? 0;
          message.usage.cacheWrite = raw.message.usage.cache_creation_input_tokens ?? 0;
        } else if (raw.type === "content_block_start") {
          const block = raw.content_block; const index = message.content.length;
          if (block.type === "text") {
            message.content.push({ type: "text", text: block.text }); blocks.set(raw.index, index);
            stream.push({ type: "text_start", contentIndex: index, partial: message });
          } else if (block.type === "thinking" || block.type === "redacted_thinking") {
            message.content.push(block.type === "thinking" ? { type: "thinking", thinking: block.thinking }
              : { type: "thinking", thinking: "", redacted: true, thinkingSignature: block.data });
            blocks.set(raw.index, index);
            stream.push({ type: "thinking_start", contentIndex: index, partial: message });
          } else if (block.type === "tool_use") {
            const name = block.name.startsWith(PREFIX) ? block.name.slice(PREFIX.length) : "";
            if (!names.has(name)) throw new Error(`Claude proposed an undeclared tool: ${block.name}`);
            message.content.push({ type: "toolCall", id: block.id, name, arguments: {} }); blocks.set(raw.index, index);
            json.set(raw.index, Object.keys(block.input as object).length ? JSON.stringify(block.input) : "");
            stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
          } else throw new Error(`Unsupported Claude content block: ${block.type}`);
        } else if (raw.type === "content_block_delta") {
          const index = blocks.get(raw.index); if (index === undefined) throw new Error("Claude stream delta has no content block.");
          const block = message.content[index]!; const delta = raw.delta;
          if (delta.type === "text_delta" && block.type === "text") {
            block.text += delta.text; stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: message });
          } else if (delta.type === "thinking_delta" && block.type === "thinking") {
            block.thinking += delta.thinking; stream.push({ type: "thinking_delta", contentIndex: index, delta: delta.thinking, partial: message });
          } else if (delta.type === "signature_delta" && block.type === "thinking") block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
          else if (delta.type === "input_json_delta" && block.type === "toolCall") {
            json.set(raw.index, (json.get(raw.index) ?? "") + delta.partial_json);
            stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.partial_json, partial: message });
          }
        } else if (raw.type === "content_block_stop") {
          const index = blocks.get(raw.index); if (index === undefined) throw new Error("Claude stream ended an unknown block.");
          const block = message.content[index]!;
          if (block.type === "text") stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
          else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: message });
          else {
            const args: unknown = JSON.parse(json.get(raw.index) || "{}");
            if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Claude tool arguments must be a JSON object.");
            block.arguments = args as typeof block.arguments;
            stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
          }
          blocks.delete(raw.index);
        } else if (raw.type === "message_delta") {
          message.usage.output = raw.usage.output_tokens;
          if (raw.delta.stop_reason === "max_tokens") message.stopReason = "length";
        }
      }
      if (!completed || !message.responseId || blocks.size) throw new Error("Claude subscription stream ended before a complete response.");
      message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
      calculateCost(model, message.usage);
      if (message.content.some(block => block.type === "toolCall")) {
        if (message.stopReason === "length") throw new Error("Claude exhausted its output limit during a tool proposal; no tools were executed.");
        message.stopReason = "toolUse";
      }
      stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
    } catch (error) {
      message.stopReason = controller.signal.aborted || options?.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      release?.();
      try { query?.close(); } catch { /* Already closed after abort. */ }
      try { await server?.close(); } catch { /* Transport is already gone. */ }
      options?.signal?.removeEventListener("abort", abort);
      stream.end();
    }
  })();
  return stream;
}

/** Registered before model selection for both main sessions and isolated children. */
export async function registerClaudeSubscription(catalog: ModelRuntime, cwd: string | (() => string),
  dependencies: { env?: Record<string, string | undefined>; status?: typeof claudeAuthStatus } = {}): Promise<void> {
  if (catalog.getProvider(CLAUDE_SUBSCRIPTION)) throw new Error("claude-subscription is reserved for Casper's Claude Code transport.");
  const models = catalog.getModels().filter(model => model.provider === "anthropic").map(model => ({
    ...model, provider: CLAUDE_SUBSCRIPTION, baseUrl: "claude-code://local", headers: undefined,
    name: `${model.name} (Claude subscription)`,
  }));
  const directory = () => typeof cwd === "function" ? cwd() : cwd;
  // Availability reads only Claude Code's public status, never its credential files. Share
  // simultaneous catalog checks; a later refresh reads again after a Claude Code sign-in.
  let checking: Promise<boolean> | undefined;
  const available = () => checking ??= (async () => {
    const env = dependencies.env ?? process.env;
    const executable = claudeExecutable(env);
    if (!executable) return false;
    try {
      const status = await (dependencies.status ?? claudeAuthStatus)(executable, subscriptionEnvironment(env), directory());
      return status?.loggedIn === true && status.authMethod === "claude.ai"
        && /^(pro|max|team|enterprise)$/i.test(status.subscriptionType ?? "");
    } catch { return false; }
  })().finally(() => { checking = undefined; });
  const stream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
    streamClaudeSubscription(model, context, options, { cwd: directory(), env: dependencies.env });
  catalog.registerNativeProvider({ id: CLAUDE_SUBSCRIPTION, name: "Claude subscription (Claude Code)",
    baseUrl: "claude-code://local", getModels: () => models,
    auth: { apiKey: { name: "Claude Code login", check: async () => await available() ? { type: "api_key", source: "Claude Code" } : undefined,
      // Ambient transport: no API key, OAuth credential or refresh is delegated to Pi.
      // The SDK checks the account again before releasing any input.
      resolve: async () => ({ auth: {}, source: "Claude Code" }),
    } },
    stream: (model, context, options) => stream(model, context, { ...options, toolChoice: undefined, reasoning: undefined }),
    streamSimple: stream,
  });
  await catalog.refresh({ allowNetwork: false, providers: [CLAUDE_SUBSCRIPTION] });
  await catalog.getAvailable();
}

const exec = promisify(execFile);
type ClaudeAuthStatus = { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
async function claudeAuthStatus(executable: string, env: Record<string, string | undefined>, cwd: string): Promise<ClaudeAuthStatus | undefined> {
  const { stdout } = await exec(executable, ["auth", "status"], { cwd, env, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true });
  const status: unknown = JSON.parse(stdout);
  return status && typeof status === "object" && !Array.isArray(status) ? status as ClaudeAuthStatus : undefined;
}
