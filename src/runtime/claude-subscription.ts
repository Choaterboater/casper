import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import type { AccountInfo, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { calculateCost, createAssistantMessageEventStream, type Api, type AssistantMessage, type Message, type Model, type SimpleStreamOptions, type Tool, type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { parseJsonWithRepair } from "@earendil-works/pi-ai/utils/json-parse";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { returnClaudeFiles } from "../platform/home-owner";
import { invalidArguments } from "./tool-repair";
import { ClaudeSession, ClaudeSessions, messageKey, type QueryHandle } from "./claude-session";

export const CLAUDE_SUBSCRIPTION = "claude-subscription";
const PREFIX = "mcp__casper__";
type QueryFactory = (input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryHandle;

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

/** Plan names change (CLI "max" became SDK "Claude Ultra"), so any named plan passes unless it
 * says free, API or console. The provider and key-source checks keep API keys out. */
function isSubscriptionPlan(plan: string | undefined): boolean {
  const name = plan?.trim() ?? "";
  return name !== "" && !/^(unknown|none|null|undefined)$/i.test(name) && !/\b(free|api|console)\b/i.test(name);
}

const reported = (value: string) => JSON.stringify(value.replace(/\p{C}/gu, "").slice(0, 60));

export function assertSubscriptionAccount(account: AccountInfo): void {
  if (account.apiProvider !== "firstParty" || !isSubscriptionPlan(account.subscriptionType)
    || (account.apiKeySource !== undefined && !["none", "oauth"].includes(account.apiKeySource))) {
    const plan = account.subscriptionType?.trim() ? `plan ${reported(account.subscriptionType)}` : "no plan";
    const key = account.apiKeySource !== undefined ? `, key source ${reported(account.apiKeySource)}` : "";
    throw new Error(`Claude subscription requires Claude Code signed in to a paid Claude plan (Pro, Max, Ultra, Team or Enterprise). Claude Code reported ${plan} (provider ${reported(account.apiProvider ?? "none")}${key}). No API-key fallback was used.`);
  }
}

/** Tools whose calls carry file contents the AI wrote; the file holds them after the call. */
const FILE_WRITERS = new Set(["write", "edit"]);
/** A written text longer than this, from before the last turn, is left out of the replayed history. */
const WRITTEN_KEPT = 300;
const leftOut = (text: string) => `[${text.length} characters, left out of this history]`;

/** A file-writing call's arguments with long written texts left out, recursively; everything else (paths, short edits)
 * as it was. Haiku 5.5 read its own files back in the replayed history as material to review again on every turn:
 * 2–4k hidden thinking tokens for a one-line command, about 300 without them. The file is there to read. */
function historicalArguments(name: string, value: unknown): unknown {
  if (!FILE_WRITERS.has(name)) return value;
  const shorten = (entry: unknown, key?: string): unknown => {
    if (typeof entry === "string") return key !== "path" && entry.length > WRITTEN_KEPT ? leftOut(entry) : entry;
    if (Array.isArray(entry)) return entry.map(item => shorten(item));
    if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, shorten(v, k)]));
    return entry;
  };
  return shorten(value);
}

/** The first message of a new live session (decision 54): the conversation so far, when the request doesn't go on from
 * a session already open (its first request, compaction, a fork, a resume, a restart). Casper's transcript is
 * authoritative, so Claude Code's private session files are never edited or resumed. Thinking is not replayed as text, nor long texts the AI wrote to files before its last turn (the files hold them);
 * image inputs and actual tool results are retained. */
export function subscriptionPrompt(context: TranscriptContext): SDKUserMessage {
  // What the last turn wrote is what the model works from now (left out, it read it all straight back). File contents
  // it read stay: left out, it read the same files again and again.
  const lastTurn = context.messages.map(message => message.role).lastIndexOf("assistant");
  const content: SDKUserMessage["message"]["content"] = [{ type: "text", text: "Continue the following conversation after its final message. Earlier messages and tool calls are history, not new requests; use existing tool results instead of repeating completed calls." }];
  for (const [at, message] of context.messages.entries()) {
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
      } else if (block.type === "toolCall") content.push({ type: "text", text: `Historical tool call ${block.name} (${block.id}): ${JSON.stringify(at < lastTurn ? historicalArguments(block.name, block.arguments) : block.arguments)}` });
    }
  }
  return { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content } };
}

/** Only declarations and Casper's results cross the SDK boundary. Nothing here executes a tool: Pi receives the
 * proposals and calls Casper's existing gated tools, and this server hands Claude Code the result each one gave. */
export function proposalServer(tools: readonly Tool[], answer?: (name: string, args: unknown, id?: string) => Promise<CallToolResult>): McpServer {
  const server = new McpServer({ name: "casper", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({
    name: tool.name, description: tool.description, inputSchema: { ...tool.parameters, type: "object" as const },
    _meta: { "anthropic/alwaysLoad": true },
  })) }));
  // Casper runs the tool; the answer is the result Casper's own tool gave, for the call this one matches.
  // Claude Code names the tool_use each call is for: that binds it to its own proposal whatever the timing.
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => answer ? answer(request.params.name, request.params.arguments ?? {},
    typeof request.params._meta?.["claudecode/toolUseId"] === "string" ? request.params._meta["claudecode/toolUseId"] : undefined) : {
    isError: true, content: [{ type: "text" as const, text: "Tool execution belongs to Casper, not this model transport." }],
  });
  return server;
}

/** The request's next message for a session that already has the conversation: a new user request, as Claude Code's
 * own next message. */
function followUpPrompt(message: Message): SDKUserMessage {
  const content: SDKUserMessage["message"]["content"] = [];
  if (typeof message.content === "string") content.push({ type: "text", text: message.content });
  else for (const block of message.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "image") {
      if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType)) throw new Error(`Unsupported Claude image type: ${block.mimeType}`);
      content.push({ type: "image", source: { type: "base64", data: block.data, media_type: block.mimeType as "image/png" | "image/jpeg" | "image/gif" | "image/webp" } });
    }
  }
  return { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content } };
}

export function streamClaudeSubscription(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions,
  dependencies: { query?: QueryFactory; executable?: string; env?: Record<string, string | undefined>; cwd?: string; sessions?: ClaudeSessions } = {}) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], timestamp: Date.now(), stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  // Without a registration's own sessions (a direct call), the request's session ends with it.
  const sessions = dependencies.sessions ?? new ClaudeSessions(0);
  void (async () => {
    let session: ClaudeSession | undefined;
    let ok = false;
    const abort = () => session?.close();
    options?.signal?.addEventListener("abort", abort, { once: true });
    try {
      options?.signal?.throwIfAborted();
      const inheritedEnv = { ...(dependencies.env ?? process.env), ...options?.env };
      const executable = dependencies.executable ?? claudeExecutable(inheritedEnv);
      if (!executable) throw new Error("Claude subscription needs a native Claude Code installation on PATH (claude.exe on Windows), or CASPER_CLAUDE_PATH pointing to it. Sign in using Claude Code first.");
      const tools = options?.toolChoice === "none" ? [] : getCurrentTools(context.messages);
      const names = new Set(tools.map(tool => tool.name));
      const reasoning = options?.reasoning;
      const systemPrompt = getCurrentSystemPrompt(context.messages);
      const cwd = dependencies.cwd ?? process.cwd();
      // What a session was started with: a request with other settings, tools or instructions starts its own.
      const signature = JSON.stringify([model.id, executable, cwd, reasoning ?? null, options?.maxTokens ?? null, options?.cacheRetention ?? null,
        systemPrompt, tools.map(tool => [tool.name, tool.description, tool.parameters])]);
      const keys = context.messages.map(messageKey);
      /** A new session seeded with the conversation so far, once Claude Code's account is a paid plan's. */
      const open = async (): Promise<ClaudeSession> => {
        const fresh = new ClaudeSession(signature, tools.length > 0);
        fresh.busy = true;
        sessions.add(fresh);
        try {
          const factory = dependencies.query ?? (await import("@anthropic-ai/claude-agent-sdk")).query;
          const env = subscriptionEnvironment(inheritedEnv);
          // The model's own cap, as Pi's Anthropic provider sends it; Claude Code's default is lower and it clamps to the model's limit.
          const maxTokens = options?.maxTokens || model.maxTokens;
          if (maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
          if (options?.cacheRetention === "none") env.DISABLE_PROMPT_CACHING = "1";
          const server = proposalServer(tools, (name, args, id) => fresh.answer(name, args, id));
          fresh.start(factory({ prompt: fresh.input, options: {
            cwd, pathToClaudeCodeExecutable: executable, env,
            model: model.id, systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt }, tools: [],
            mcpServers: tools.length ? { casper: { type: "sdk", name: "casper", instance: server } } : {},
            strictMcpConfig: true, settingSources: [], persistSession: false, includePartialMessages: true,
            // Claude Code runs only Casper's own tools, through the proposal server, which answers with Casper's results.
            // canUseTool decides every call: an allowedTools entry would skip it.
            permissionMode: "default", canUseTool: async (name, input) => name.startsWith(PREFIX) && names.has(name.slice(PREFIX.length))
              ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Casper executes all tools." },
            // A side request with no tools is one model turn; a session with tools goes on as Claude Code's own does.
            ...(tools.length ? {} : { maxTurns: 1 }),
            ...(reasoning ? { effort: reasoning === "minimal" ? "low" : reasoning } : { thinking: { type: "disabled" as const } }),
          } }));
          const account = await new Promise<AccountInfo>((resolve, reject) => {
            const cleanup = () => { clearTimeout(timer); options?.signal?.removeEventListener("abort", cancelled); };
            const fail = (error: unknown) => { cleanup(); reject(error); };
            const cancelled = () => fail(new Error("Claude subscription request aborted."));
            const timer = setTimeout(() => fail(new Error("Claude Code initialization timed out.")), options?.timeoutMs ?? 30_000);
            options?.signal?.addEventListener("abort", cancelled, { once: true });
            Promise.resolve().then(() => fresh.query!.accountInfo()).then(value => { cleanup(); resolve(value); }, fail);
            // Abort can precede installing the listener while the SDK module loads.
            if (options?.signal?.aborted) cancelled();
          });
          options?.signal?.throwIfAborted();
          // Nothing reaches Claude Code before the account is a paid plan's: the transcript is sent only after this.
          assertSubscriptionAccount(account);
          fresh.input.push(subscriptionPrompt(context));
          return fresh;
        } catch (error) {
          // A refused plan, an abort or a start that failed leaves no session open.
          sessions.drop(fresh);
          throw error;
        }
      };
      const found = tools.length ? sessions.find(signature, keys, context.messages) : undefined;
      if (found) {
        session = found.session;
        session.busy = true;
        if (found.tail[0]!.role === "toolResult") session.deliver(found.tail as ToolResultMessage[]);
        else session.input.push(followUpPrompt(found.tail[0]!));
      } else session = await open();
      stream.push({ type: "start", partial: message });
      try { await readTurn(session, message, stream, names, options?.signal, Boolean(found)); }
      catch (error) {
        if (!(error instanceof SessionEnded)) throw error;
        // Claude Code ended between turns (a crash, its own limit): the request seeds a new session instead.
        sessions.drop(session);
        session = await open();
        await readTurn(session, message, stream, names, options?.signal, false);
      }
      if (message.content.some(block => block.type === "toolCall")) {
        if (message.stopReason === "length") throw new Error("Claude exhausted its output limit during a tool proposal; no tools were executed.");
        message.stopReason = "toolUse";
      }
      session.proposed(message.content.flatMap(block => block.type === "toolCall" ? [{ id: block.id, name: block.name, arguments: block.arguments }] : []));
      message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
      calculateCost(model, message.usage);
      session.known = [...keys, messageKey(message)];
      ok = true;
      stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
    } catch (error) {
      message.stopReason = options?.signal?.aborted ? "aborted" : "error";
      message.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } finally {
      options?.signal?.removeEventListener("abort", abort);
      if (session) sessions.settle(session, ok);
      await returnClaudeFiles().catch(() => {});
      stream.end();
    }
  })();
  return stream;
}

/** A session already open ended before the request's turn started. */
class SessionEnded extends Error {}

/** One model turn of the session into `message`: to the end of a turn that proposes tools (Claude Code then calls them
 * through the proposal server), or to Claude Code's result for a turn that answers. */
async function readTurn(session: ClaudeSession, message: AssistantMessage, stream: ReturnType<typeof createAssistantMessageEventStream>,
  names: ReadonlySet<string>, signal: AbortSignal | undefined, continued: boolean): Promise<void> {
  const blocks = new Map<number, number>();
  const json = new Map<number, string>();
  /** Blocks whose arguments are streaming: the streamed pieces are the whole arguments, never added to a starting input. */
  const streamed = new Set<number>();
  /** Output of earlier responses in this answer (Claude Code carrying on after the output cap, or starting over). */
  let outputBefore = 0;
  /** The current response reached its message_stop. */
  let ended = false;
  for (;;) {
    const next = await session.events.next();
    signal?.throwIfAborted();
    // A session already open that ends before its next turn starts has nothing of this request: it can be seeded again.
    if (continued && !message.responseId && (next.done || next.value.type === "result")) throw new SessionEnded();
    if (next.done) {
      if (session.error) throw session.error;
      throw new Error("Claude subscription stream ended before a complete response.");
    }
    const event = next.value;
    if (event.type === "system" && event.subtype === "init" && !["none", "oauth"].includes(event.apiKeySource)) throw new Error("Claude Code switched to API-key authentication; subscription request stopped.");
    if (event.type === "assistant" && event.error) {
      const detail = event.message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      throw new Error(`Claude subscription request failed: ${detail || event.error}`);
    }
    if (event.type === "result") {
      // A side request's one turn ends with Claude Code's turn limit, after a complete tool proposal.
      if (event.is_error && !(event.subtype === "error_max_turns" && message.content.some(block => block.type === "toolCall"))) {
        throw new Error(event.subtype === "success" ? "Claude subscription request failed." : event.errors.join("\n"));
      }
      if (!message.responseId || blocks.size) throw new Error("Claude subscription stream ended before a complete response.");
      return;
    }
    if (event.type !== "stream_event" || event.parent_tool_use_id) continue;
    const raw = event.event;
    if (raw.type === "message_start") {
      // After a response cut off at the output cap, Claude Code carries on with its own next one: the rest of this answer.
      const carriesOn = message.responseId !== undefined && message.stopReason === "length" && !message.content.some(block => block.type === "toolCall");
      // A response that never ended was abandoned: Claude Code asked again (a stalled request it retried). Before any of
      // the answer streamed, the new response is the answer; after part of it, Pi asks again for the whole turn.
      const startedOver = message.responseId !== undefined && !ended && !carriesOn;
      if (startedOver && message.content.some(block => block.type !== "thinking")) {
        throw new Error("Claude subscription stream was interrupted: Claude Code started the response over after part of it had streamed.");
      }
      if (message.responseId && !carriesOn && !startedOver) throw new Error("Claude returned multiple model turns to a single-turn transport.");
      if (startedOver) {
        for (const [, index] of blocks) {
          const block = message.content[index];
          if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: message });
        }
        blocks.clear(); json.clear(); streamed.clear();
        outputBefore = message.usage.output;
      }
      if (carriesOn) { message.stopReason = "stop"; outputBefore = message.usage.output; }
      ended = false;
      message.responseId = raw.message.id; message.responseModel = raw.message.model;
      message.usage.input += raw.message.usage.input_tokens;
      message.usage.output = outputBefore + raw.message.usage.output_tokens;
      message.usage.cacheRead += raw.message.usage.cache_read_input_tokens ?? 0;
      message.usage.cacheWrite += raw.message.usage.cache_creation_input_tokens ?? 0;
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
        // Claude sometimes drops the MCP prefix and calls one of Casper's tools by its own name (`bash`); Claude Code's
        // built-in tools (`Bash`, `Read`) are never Casper's, so they still stop the turn.
        const name = block.name.startsWith(PREFIX) ? block.name.slice(PREFIX.length) : block.name;
        if (!names.has(name)) throw new Error(`Claude proposed an undeclared tool: ${block.name}`);
        message.content.push({ type: "toolCall", id: block.id, name, arguments: {} }); blocks.set(raw.index, index);
        json.set(raw.index, Object.keys(block.input as object).length ? JSON.stringify(block.input) : ""); streamed.delete(raw.index);
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
        json.set(raw.index, (streamed.has(raw.index) ? json.get(raw.index) ?? "" : "") + delta.partial_json); streamed.add(raw.index);
        stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.partial_json, partial: message });
      }
    } else if (raw.type === "content_block_stop") {
      const index = blocks.get(raw.index); if (index === undefined) throw new Error("Claude stream ended an unknown block.");
      const block = message.content[index]!;
      if (block.type === "text") stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
      else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: message });
      else {
        block.arguments = toolArguments(json.get(raw.index) || "{}") as typeof block.arguments;
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
      }
      blocks.delete(raw.index);
    } else if (raw.type === "message_delta") {
      message.usage.output = outputBefore + raw.usage.output_tokens;
      if (raw.delta.stop_reason === "max_tokens") message.stopReason = "length";
    } else if (raw.type === "message_stop") {
      if (!message.responseId || blocks.size) throw new Error("Claude subscription stream ended before a complete response.");
      ended = true;
      // A turn that proposes tools ends here: Claude Code now calls them through the proposal server.
      if (message.content.some(block => block.type === "toolCall")) return;
    }
  }
}

/** A tool call's arguments from Claude's streamed JSON. String escapes it got wrong (a raw line break or tab, a regex's
 * `\d`) are mended as Pi mends them for its other providers. Anything still unreadable, or not one object, is never
 * guessed at or partly read: the call comes back marked so it doesn't run, and the model is told to send it again,
 * instead of the whole task stopping (src/runtime/tool-repair.ts). */
function toolArguments(text: string): unknown {
  let args: unknown;
  try { args = parseJsonWithRepair(text); }
  catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/^JSON Parse error: /, "");
    return invalidArguments(`its arguments weren't valid JSON (${detail}); send it again with its arguments as one JSON object, and inside strings escape quotes, backslashes and line breaks`);
  }
  return args && typeof args === "object" && !Array.isArray(args) ? args
    : invalidArguments("its arguments were not one JSON object; send it again with its arguments as one JSON object");
}

/** Registered before model selection for both main sessions and isolated children. Returns the live Claude Code sessions
 * this registration starts: the runtime closes them when it ends, or their processes would keep Casper running. */
export async function registerClaudeSubscription(catalog: ModelRuntime, cwd: string | (() => string),
  dependencies: { env?: Record<string, string | undefined>; status?: typeof claudeAuthStatus; recheckMs?: number; query?: QueryFactory } = {}): Promise<ClaudeSessions> {
  if (catalog.getProvider(CLAUDE_SUBSCRIPTION)) throw new Error("claude-subscription is reserved for Casper's Claude Code transport.");
  const models = catalog.getModels().filter(model => model.provider === "anthropic").map(model => ({
    ...model, provider: CLAUDE_SUBSCRIPTION, baseUrl: "claude-code://local", headers: undefined,
    name: `${model.name} (Claude subscription)`,
    // No cache lifetime, so Pi never warms it: a warm request would be another Claude Code process replaying the whole
    // conversation, and Claude Code keeps the live session's own cache.
    promptCache: undefined,
  }));
  const directory = () => typeof cwd === "function" ? cwd() : cwd;
  // Availability reads only Claude Code's public status, never its credential files. Share
  // simultaneous catalog checks; a later refresh reads again after a Claude Code sign-in.
  let checking: Promise<boolean> | undefined;
  // Only an answer counts: a status check that failed or timed out (Claude Code busy, 5 s limit) keeps the last answer,
  // and a "not signed in" right after a signed-in answer is asked once more first (Claude Code and its desktop app renew
  // the same login, and one answer mid-renewal said signed out). A working sign-in then never reads as "credentials
  // missing" for a /resume line or a repair round. The SDK checks the account again before each request.
  let last = false;
  const available = () => checking ??= (async () => {
    const env = dependencies.env ?? process.env;
    const executable = claudeExecutable(env);
    if (!executable) return last = false;
    const ask = async () => isSubscriptionStatus(await (dependencies.status ?? claudeAuthStatus)(executable, subscriptionEnvironment(env), directory()));
    try {
      let now = await ask();
      if (!now && last) { await Bun.sleep(dependencies.recheckMs ?? 1_500); now = await ask(); }
      return last = now;
    } catch { return last; }
  })().finally(() => { checking = undefined; });
  const sessions = new ClaudeSessions();
  const stream = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
    streamClaudeSubscription(model, context, options, { cwd: directory(), env: dependencies.env, query: dependencies.query, sessions });
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
  return sessions;
}

const exec = promisify(execFile);
type ClaudeAuthStatus = { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
export function isSubscriptionStatus(status: ClaudeAuthStatus | undefined): boolean {
  return status?.loggedIn === true && status.authMethod === "claude.ai" && isSubscriptionPlan(status.subscriptionType);
}
export async function claudeAuthStatus(executable: string, env: Record<string, string | undefined>, cwd: string): Promise<ClaudeAuthStatus | undefined> {
  const { stdout } = await exec(executable, ["auth", "status"], { cwd, env, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true })
    .finally(() => returnClaudeFiles().catch(() => {}));
  const status: unknown = JSON.parse(stdout);
  return status && typeof status === "object" && !Array.isArray(status) ? status as ClaudeAuthStatus : undefined;
}
