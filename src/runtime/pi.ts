import { existsSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { READ_ONLY_STATE_CONFLICT } from "./types";
import { PiModels } from "./pi-models";
import { authenticatePi } from "./pi-auth";
import { isOpenRouterModel, openRouterAttribution } from "./openrouter-attribution";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  ExtensionAPI,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { nativeEditPath, observationInput, observationOutput, patchLineCounts, type ToolObservationInput } from "./observation";
import type {
  AgentRuntime,
  RuntimeAuthenticationOptions,
  RuntimeAuthenticationResult,
  RuntimeEventListener,
  RuntimeModelSelection,
  RuntimeModelSelectionOptions,
  RuntimeForkOptions,
  RuntimeReadOnlyStartOptions,
  RuntimeSession,
  RuntimeSessionInfo,
  RuntimeStartOptions,
  RuntimeState,
  RuntimeStatus,
  RuntimeSwitchOptions,
  RuntimeTool,
  RuntimeUsage,
  RuntimeConversation,
} from "./types";

class PiToolController {
  private tools: RuntimeTool[];
  private update: (tools: RuntimeTool[]) => void = () => {};

  constructor(initial: RuntimeTool[]) {
    this.tools = [...initial];
  }

  current(): RuntimeTool[] {
    return [...this.tools];
  }

  install(update: (tools: RuntimeTool[]) => void): void {
    this.update = update;
  }

  set(tools: RuntimeTool[]): void {
    this.tools = [...tools];
    this.update(this.current());
  }
}

class PiRuntimeSession implements RuntimeSession {
  private readonly listeners = new Set<RuntimeEventListener>();
  private readonly toolInputs = new Map<string, ToolObservationInput>();
  private unsubscribePi?: () => void;
  private promptActive = false;
  private progressChars = 0;
  private progressReported = 0;
  private promptController?: AbortController;

  constructor(
    private readonly runtime: AgentSessionRuntime,
    private readonly tools: PiToolController,
    private readonly models: PiModels,
    private readonly readOnly?: { options: RuntimeReadOnlyStartOptions; limitReason: () => string | undefined },
  ) {
    this.bind(runtime.session);
    runtime.setRebindSession(async (session) => { this.bind(session); });
  }

  setTools = (tools: RuntimeTool[]): void => {
    if (this.readOnly) throw new Error("Read-only subagent tools cannot be replaced");
    this.tools.set(tools);
  };

  getSessionInfo(): RuntimeSessionInfo {
    const session = this.runtime.session;
    if (!session.sessionFile) throw new Error("Conversation persistence is unavailable");
    return {
      cwd: this.runtime.cwd,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      name: session.sessionName,
    };
  }

  async forkSession(options: RuntimeForkOptions): Promise<RuntimeSessionInfo> {
    if (this.readOnly) throw new Error("Read-only subagents cannot fork sessions");
    if (this.busy || this.models.busy) throw new Error("Wait for active work before forking sessions.");
    const source = this.runtime.session;
    const sourcePath = source.sessionFile;
    if (!sourcePath) throw new Error("Conversation persistence is unavailable");
    // Pi defers creating a JSONL file until the first assistant response. Export
    // only an as-yet-unwritten session so SessionManager.forkFrom remains the
    // sole owner of the persisted session format and active conversation path.
    if (!existsSync(sourcePath)) source.exportToJsonl(sourcePath);
    const forked = SessionManager.forkFrom(sourcePath, options.cwd);
    forked.appendSessionInfo(options.name);
    const targetPath = forked.getSessionFile();
    if (!targetPath) throw new Error("The conversation fork was not persisted");
    const result = await this.runtime.switchSession(targetPath);
    if (result.cancelled) throw new Error("Conversation fork was cancelled");
    if (options.context) await this.appendContext(options.context);
    return this.getSessionInfo();
  }

  async switchSession(options: RuntimeSwitchOptions): Promise<RuntimeSessionInfo> {
    if (this.readOnly) throw new Error("Read-only subagents cannot switch sessions");
    if (this.busy || this.models.busy) throw new Error("Wait for active work before switching sessions.");
    const result = await this.runtime.switchSession(options.sessionFile, { cwdOverride: options.cwd });
    if (result.cancelled) throw new Error("Conversation switch was cancelled");
    if (options.context) await this.appendContext(options.context);
    return this.getSessionInfo();
  }

  async appendContext(text: string): Promise<void> {
    await this.runtime.session.sendCustomMessage({
      customType: "casper.project-context",
      content: text,
      display: false,
      details: { cwd: this.runtime.cwd },
    });
  }

  get busy(): boolean { return this.promptActive || !this.runtime.session.isIdle; }

  selectModel(options: RuntimeModelSelectionOptions): Promise<RuntimeModelSelection> {
    if (this.busy || this.models.busy) throw new Error("Wait for active work before changing models.");
    if (this.readOnly) throw new Error("Model selection is unavailable in read-only children.");
    return this.models.select(this.runtime.session, options);
  }

  selectDefaultModel(options: { provider?: string; signal?: AbortSignal } = {}): Promise<RuntimeModelSelection | undefined> {
    if (this.busy || this.models.busy) throw new Error("Wait for active work before changing models.");
    if (this.readOnly) return Promise.resolve(undefined);
    return this.models.selectDefaultIfUnset(this.runtime.session, options);
  }

  setEffort(level: string, persist: boolean): Promise<RuntimeStatus> {
    if (this.busy || this.readOnly || this.models.busy) throw new Error("Effort cannot be changed during active work or in a read-only child.");
    return this.models.setEffort(this.runtime.session, level, persist);
  }

  getModelRoles(): Record<string, string> {
    return this.models.getRoles();
  }

  setModelRole(role: string, selector?: string): Promise<Record<string, string>> {
    if (this.busy || this.readOnly || this.models.busy) throw new Error("Model roles cannot be changed during active work or in a read-only child.");
    return this.models.setRole(role, selector);
  }

  getUsage(): RuntimeUsage {
    const session = this.runtime.session;
    const stats = session.getSessionStats();
    return { context: this.getStatus().model ? session.getContextUsage() : undefined,
      tokens: stats.tokens, messages: stats.totalMessages,
      estimatedCost: stats.cost > 0 ? stats.cost : undefined,
      effortClassification: this.models.usage(session) };
  }

  complete(input: { systemPrompt: string; user: string; signal?: AbortSignal; effort?: string; maxTokens?: number }) {
    return this.models.complete(this.runtime.session, input);
  }

  async listConversations(): Promise<RuntimeConversation[]> {
    return (await SessionManager.list(this.runtime.cwd)).map(info => ({ id: info.id, name: info.name, modified: info.modified.toISOString() }));
  }

  private persistUnwrittenConversation(): void {
    const session = this.runtime.session;
    if (session.sessionFile && !existsSync(session.sessionFile)) {
      session.exportToJsonl(session.sessionFile);
      session.sessionManager.setSessionFile(session.sessionFile);
    }
  }

  async clearConversation(): Promise<void> {
    if (this.busy || this.readOnly || this.models.busy) throw new Error("Wait for active work before clearing context.");
    this.persistUnwrittenConversation();
    const result = await this.runtime.newSession();
    if (result.cancelled) throw new Error("New conversation cancelled.");
    this.persistUnwrittenConversation();
  }

  async resumeConversation(id: string, options: { keepUnwritten?: boolean } = {}): Promise<void> {
    if (this.busy || this.readOnly || this.models.busy) throw new Error("Wait for active work before resuming.");
    const saved = (await SessionManager.list(this.runtime.cwd)).filter(info => info.id === id);
    if (saved.length !== 1) throw new Error("Unknown or ambiguous conversation ID in this workspace. Use /resume to list IDs.");
    if (options.keepUnwritten !== false) this.persistUnwrittenConversation();
    const result = await this.runtime.switchSession(saved[0]!.path, { cwdOverride: this.runtime.cwd });
    if (result.cancelled) throw new Error("Resume cancelled.");
  }

  async compact(instructions?: string, signal?: AbortSignal): Promise<void> {
    if (this.busy || this.readOnly) throw new Error("Wait for active work before compacting.");
    this.models.assertReady(this.runtime.session);
    const session = this.runtime.session;
    const abort = () => session.abortCompaction();
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abort, { once: true });
    try { await session.compact(instructions); signal?.throwIfAborted(); }
    finally { signal?.removeEventListener("abort", abort); }
  }

  getStatus(): RuntimeStatus {
    return this.models.status(this.runtime.session);
  }

  async prompt(text: string, signal?: AbortSignal, options?: { request: string; maxTurns?: number }): Promise<void> {
    if (this.promptActive) throw new Error("A prompt is already active.");
    this.promptActive = true;
    const controller = this.promptController = new AbortController();
    const promptSignal = AbortSignal.any([
      controller.signal,
      ...(signal ? [signal] : []),
      ...(this.readOnly ? [this.readOnly.options.signal] : []),
    ]);
    const session = this.runtime.session;
    const cancel = () => { void session.abort().catch(() => {}); };
    const agent = session.agent;
    const stream = agent.streamFunction;
    // A read-only child already owns its budget; a main-session limit applies to this prompt only.
    const previousFinish = agent.finishTurn;
    const maxTurns = this.readOnly ? undefined : options?.maxTurns;
    let turns = 0;
    let limited = false;
    if (maxTurns !== undefined) agent.finishTurn = async (turn, finishSignal) => {
      const previous = await previousFinish?.(turn, finishSignal);
      if (previous?.action === "end") return previous;
      // Error and aborted responses end the run anyway; they are not counted turns.
      if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return previous ?? undefined;
      turns++;
      limited = turns >= maxTurns && turn.message.content.some((part) => part.type === "toolCall");
      return limited ? { action: "end" } : previous ?? undefined;
    };
    // Pi can resolve auth before its agent has an AbortController. Keep the
    // preparation signal linked at the last seam before provider execution.
    agent.streamFunction = (model, context, streamOptions) => {
      promptSignal.throwIfAborted();
      return stream(model, context, {
        ...streamOptions,
        signal: streamOptions?.signal ? AbortSignal.any([promptSignal, streamOptions.signal]) : promptSignal,
      });
    };
    promptSignal.addEventListener("abort", cancel, { once: true });
    try {
      promptSignal.throwIfAborted();
      const status = await this.models.preparePrompt(session, options?.request ?? text, promptSignal);
      promptSignal.throwIfAborted();
      if (status.configuredEffort === "auto") this.emit({ type: "model_controls_changed", status });
      promptSignal.throwIfAborted();
      await session.prompt(text, { expandPromptTemplates: !this.readOnly });
      promptSignal.throwIfAborted();
      const limitReason = this.readOnly?.limitReason();
      if (limitReason) this.emit({ type: "assistant_response_end", stopReason: "limit", errorMessage: limitReason });
      if (limited) this.emit({ type: "turn_limit", turns });
    } catch (error) {
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      agent.streamFunction = stream;
      if (maxTurns !== undefined) agent.finishTurn = previousFinish;
      promptSignal.removeEventListener("abort", cancel);
      this.promptController = undefined;
      this.promptActive = false;
    }
  }

  abort(): Promise<void> {
    this.promptController?.abort();
    return this.runtime.session.abort();
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): RuntimeState {
    return {
      cwd: this.runtime.cwd,
      isStreaming: this.runtime.session.isStreaming,
    };
  }

  detach(): void {
    this.unsubscribePi?.();
    this.unsubscribePi = undefined;
    this.toolInputs.clear();
    this.listeners.clear();
  }

  private bind(session: AgentSession): void {
    this.unsubscribePi?.();
    this.toolInputs.clear();
    this.unsubscribePi = session.subscribe((event) => {
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") this.emit({
            type: "assistant_response_start", provider: session.model?.provider, model: session.model?.id,
          });
          break;
        case "message_end":
          if (event.message.role === "assistant") {
            const { totalTokens, cost } = event.message.usage ?? {};
            const reported = Number.isFinite(totalTokens) && Number.isFinite(cost?.total);
            this.emit({
              type: "assistant_response_end", stopReason: event.message.stopReason, errorMessage: event.message.errorMessage,
              ...(reported ? { usage: { tokens: totalTokens!, estimatedCost: cost!.total } } : {}),
            });
          }
          break;
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") { this.emit({ type: "assistant_text_delta", delta: update.delta }); break; }
          if (update.type === "thinking_start" || update.type === "toolcall_start") this.progressChars = 0;
          else if (update.type === "thinking_delta" || update.type === "toolcall_delta") this.progressChars += update.delta.length;
          else break;
          // Coalesce: the first event of a block and then every 256 characters.
          if (this.progressChars !== 0 && this.progressChars - this.progressReported < 256) break;
          this.progressReported = this.progressChars;
          const block = update.partial.content[update.contentIndex];
          this.emit({ type: "assistant_progress", kind: update.type.startsWith("thinking") ? "thinking" : "tool_call",
            toolName: block?.type === "toolCall" ? block.name : undefined, chars: this.progressChars });
          break;
        }
        case "tool_execution_start": {
          const input = observationInput(event.args);
          if (["edit", "write"].includes(event.toolName) && input.path !== undefined) input.path = nativeEditPath(input.path);
          if (this.toolInputs.size < 64) this.toolInputs.set(event.toolCallId, input);
          this.emit({ type: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId, input });
          break;
        }
        case "tool_execution_end": {
          const input = this.toolInputs.get(event.toolCallId);
          this.toolInputs.delete(event.toolCallId);
          const lines = event.toolName === "edit" && !event.isError ? patchLineCounts(event.result) : undefined;
          this.emit({ type: "tool_end", toolName: event.toolName, toolCallId: event.toolCallId, input, output: event.toolName === "bash" || event.isError ? observationOutput(event.result) : undefined,
            isError: event.isError, ...(lines ? { lines } : {}) });
          break;
        }
        case "agent_end":
          this.toolInputs.clear();
          this.emit({ type: "message_end" });
          break;
      }
    });
  }

  private emit(event: Parameters<RuntimeEventListener>[0]): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Context files (AGENTS.md, CLAUDE.md) may be repository-controlled: a committed symlink must
 * not send `~/.aws/credentials` to the provider. The workspace's own file loads only when its
 * realpath stays under the workspace. Ancestor files (a parent of a nested checkout can be just as
 * hostile) load only when they resolve inside their own directory or to another context file, so a
 * dotfiles link still works. The engine store's own file is the user's. */
export function containedContextFile(file: string, cwd: string, agentDir?: string): boolean {
  const resolved = path.resolve(file);
  const within = (root: string, target: string) => {
    const inside = path.relative(root, target);
    return Boolean(inside) && inside !== ".." && !inside.startsWith(`..${path.sep}`) && !path.isAbsolute(inside);
  };
  try {
    if (agentDir && path.dirname(resolved) === path.resolve(agentDir)) return true;
    const real = realpathSync(resolved);
    if (path.dirname(resolved) === path.resolve(cwd)) return within(realpathSync(cwd), real);
    return within(realpathSync(path.dirname(resolved)), real) || /^(agents|claude)\.md$/i.test(path.basename(real));
  } catch { return false; }
}

/** Resolve existing state aliases and prospective missing suffixes without creating anything.
 * This is a bounded, non-atomic preflight, not protection against concurrent path replacement. */
async function canonicalStatePath(file: string, signal: AbortSignal): Promise<string> {
  if (Buffer.byteLength(file) > 4096) throw new Error("Writable runtime state path exceeds the preflight limit");
  let prefix = file;
  const suffix: string[] = [];
  for (let step = 0; step < 128; step++) {
    signal.throwIfAborted();
    try { return path.join(await realpath(prefix), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink is not a missing ordinary path: never invent its destination.
      const entry = await lstat(prefix).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      if (entry) throw new Error("Cannot resolve writable runtime state");
      const parent = path.dirname(prefix);
      if (parent === prefix) throw error;
      suffix.unshift(path.basename(prefix));
      prefix = parent;
    }
  }
  throw new Error("Writable runtime state path exceeds the preflight limit");
}

async function checkReadOnlyState(options: RuntimeReadOnlyStartOptions, agentDir: string): Promise<void> {
  const root = await realpath(options.cwd);
  // Pi owns these locations. Check the directory plus the two files it can write
  // during ModelRuntime.create, including file symlinks into an otherwise separate source.
  for (const target of [agentDir, `${agentDir}/auth.json`, path.join(agentDir, "models-store.json")]) {
    const destination = await canonicalStatePath(target, options.signal);
    const relative = path.relative(root, destination);
    if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw new Error(READ_ONLY_STATE_CONFLICT);
    }
  }
  options.signal.throwIfAborted();
}

/** Pi's own rules for its read/edit/write tools. Pi drops its tool rules whenever a custom system prompt
 * is set (as Casper's is), and these are not SDK exports, so Casper restores them in the addendum Pi
 * always keeps. Pinned word for word against Pi's source by tests/tool-rules.test.ts. */
export const PI_TOOL_RULES: readonly string[] = [
  "Use read to examine files instead of cat or sed.",
  "Use edit for precise changes (edits[].oldText must match exactly)",
  "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
  "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
  "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
  "Use write only for new files or complete rewrites.",
];

/** A bash timeout above this is capped: one hour, the longest a Casper check may run, so the cap never
 * cuts short a command a check itself would allow, while a day-long timeout cannot hang a session. */
export const BASH_TIMEOUT_CAP_SECONDS = 3600;

export class PiRuntime implements AgentRuntime {
  private runtime?: AgentSessionRuntime;
  private models?: PiModels;
  private wrapper?: PiRuntimeSession;
  private readonly lifetime = new AbortController();
  private authWork?: Promise<RuntimeAuthenticationResult>;
  private readOnly = false;
  private starting = false;

  async authenticate(options: RuntimeAuthenticationOptions): Promise<RuntimeAuthenticationResult> {
    if (this.readOnly || this.starting || this.authWork || this.wrapper?.busy || this.models?.busy || this.lifetime.signal.aborted) {
      return { status: "failed", effect: "none", reason: "unavailable" };
    }
    this.models?.setAuthenticating(true);
    this.authWork = Promise.resolve().then(async (): Promise<RuntimeAuthenticationResult> => {
      const { provider, ...result } = await authenticatePi(options, path.resolve(getAgentDir(), "auth.json"), this.lifetime.signal);
      if (provider && (result.status === "saved" || result.status === "saved-needs-refresh" || ("effect" in result && result.effect === "unknown"))) {
        this.models?.invalidateAuth(provider);
        if (result.status === "saved" || result.status === "saved-needs-refresh") {
          const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]);
          const refreshed = this.models ? await this.models.refreshAuth(provider, signal) : result.status === "saved";
          return { status: refreshed ? "saved" : "saved-needs-refresh" };
        }
      }
      return result;
    });
    try { return await this.authWork; }
    finally { this.authWork = undefined; this.models?.setAuthenticating(false); }
  }

  start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    return this.create(options);
  }

  startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    for (const limit of [options.maxTurns, options.maxToolCalls]) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid read-only runtime budget");
    }
    this.readOnly = true;
    return this.create({ cwd: options.cwd, systemPromptAppend: options.systemPromptAppend }, options);
  }

  private async create(options: RuntimeStartOptions, readOnly?: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    if (this.authWork || this.starting || this.lifetime.signal.aborted) throw new Error("Runtime is busy or closed.");
    this.starting = true;
    try { return await this.createSession(options, readOnly); }
    finally { this.starting = false; }
  }

  private async createSession(options: RuntimeStartOptions, readOnly?: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    if (this.runtime) throw new Error("Model runtime already started");
    readOnly?.signal.throwIfAborted();
    const agentDir = getAgentDir();
    if (readOnly) await checkReadOnlyState(readOnly, agentDir);
    const modelRuntime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json`, signal: readOnly?.signal });
    const models = this.models = new PiModels(modelRuntime, agentDir);
    const tools = new PiToolController(options.tools ?? []);
    let limitReason: string | undefined;
    let toolCalls = 0;
    let turns = 0;
    /** Set once to spend the single tool-free turn that lets a spent child hand back a report. */
    let wrapUp = false;

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      readOnly?.signal.throwIfAborted();
      const extensionFactory = (pi: ExtensionAPI) => {
        // Runs after the runtime's own attribution, so Casper's identity replaces Pi's. With
        // CASPER_TELEMETRY=0 there is none to add, and the runtime's is off too (agent-store.ts).
        pi.on("before_provider_headers", (event, ctx) => {
          if (isOpenRouterModel(ctx.model)) Object.assign(event.headers, openRouterAttribution());
        });
        if (readOnly) pi.on("tool_call", () => {
          if (readOnly.signal.aborted) {
            limitReason = "Subagent cancelled";
            return { block: true, reason: limitReason, terminate: true };
          }
          // The report turn is tool-free whichever budget ran out: the work is already spent.
          if (wrapUp) return { block: true, reason: limitReason ?? "Subagent budget exhausted", terminate: true };
          if (++toolCalls > readOnly.maxToolCalls) {
            limitReason ??= "Subagent tool-call budget exhausted";
            // Before the report turn the child keeps the loop: cutting it off mid-investigation
            // returns nothing at all.
            return { block: true, reason: `${limitReason}; reply now with your findings and stop calling tools` };
          }
        });
        if (!readOnly) pi.on("tool_call", (event) => {
          // Keep Pi's native execution, output handling, and process-tree cleanup.
          if (event.toolName === "bash" && event.input.timeout === undefined) event.input.timeout = 120;
          else if (event.toolName === "bash" && typeof event.input.timeout === "number" && event.input.timeout > BASH_TIMEOUT_CAP_SECONDS) event.input.timeout = BASH_TIMEOUT_CAP_SECONDS;
          if (options.beforeToolGate && ["edit", "write"].includes(event.toolName)) {
            const reason = options.beforeToolGate(event.toolName, event.input);
            if (reason) return { block: true, reason };
          }
        });
        pi.on("tool_result", async (event, ctx) => {
          if (event.isError || !["edit", "write"].includes(event.toolName) || typeof event.input.path !== "string" || !options.afterFileEdit) return;
          const file = nativeEditPath(event.input.path);
          if (file === undefined) return;
          let text: string | undefined;
          try { text = await options.afterFileEdit(file, ctx.signal); }
          catch { text = "LSP diagnostics unavailable after edit; the file was written. Do not treat missing diagnostics as clean."; }
          if (text) return { content: [...event.content, { type: "text" as const, text }] };
        });
        const withFileLocks = <T>(paths: string[], work: () => Promise<T>): Promise<T> => {
          const ordered = [...new Set(paths)].sort();
          const next = (index: number): Promise<T> => index === ordered.length ? work() : withFileMutationQueue(ordered[index], () => next(index + 1));
          return next(0);
        };
        let owned = new Set<string>();
        const register = (tool: RuntimeTool) => pi.registerTool({
          name: tool.name,
          label: tool.name,
          description: tool.description,
          parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
          ...(tool.sequential ? { executionMode: "sequential" as const } : {}),
          execute: async (_id, args, signal) => {
            const result = await tool.execute(args, signal, { withFileLocks });
            if (result.isError) throw new Error(result.text);
            return { content: [{ type: "text", text: result.text }], details: {} };
          },
        });
        for (const tool of tools.current()) { register(tool); owned.add(tool.name); }
        tools.install((nextTools) => {
          const preserved = pi.getActiveTools().filter((name) => !owned.has(name));
          for (const tool of nextTools) register(tool);
          owned = new Set(nextTools.map((tool) => tool.name));
          pi.setActiveTools([...preserved, ...owned]);
        });
      };
      // PiModels supplies isolated in-memory child settings and Casper-owned
      // routing. Children never inherit Pi's shared default or executable setup.
      const build = async (modelOptions: { settingsManager: SettingsManager; modelRuntime: ModelRuntime; model: AgentSession["model"] }) => {
        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          modelRuntime: modelOptions.modelRuntime,
          settingsManager: modelOptions.settingsManager,
          resourceLoaderOptions: {
            extensionFactories: [extensionFactory],
            ...(readOnly ? {
              noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
              systemPrompt: options.systemPromptAppend ?? "Read-only Casper subagent.",
              appendSystemPrompt: [],
            } : {}),
            agentsFilesOverride: ({ agentsFiles }) => ({ agentsFiles: agentsFiles.filter((file) => containedContextFile(file.path, cwd, agentDir)) }),
            // Casper owns discovery, trust checks, and per-task skill selection.
            noSkills: true,
            skillsOverride: () => ({ skills: [], diagnostics: [] }),
            // `basePrompt` is a discovered SYSTEM.md (the engine store's own; project ones are
            // untrusted), not Pi's built-in prompt, which a custom prompt never includes. Casper's
            // text opens with its identity and leads; the user's SYSTEM.md follows it.
            systemPromptOverride: (basePrompt) => readOnly ? options.systemPromptAppend : options.systemPromptAppend
              ? [options.systemPromptAppend, basePrompt ?? ""].filter(Boolean).join("\n\n")
              : basePrompt,
            appendSystemPromptOverride: (base) => readOnly ? base : [
              ...base,
              `Casper applies a 120-second timeout to bash commands when timeout is omitted, and caps any timeout at ${BASH_TIMEOUT_CAP_SECONDS} seconds. Supply an explicit finite timeout in seconds for intentionally longer commands. After a search times out, narrow its scope rather than retrying the same broad search.`,
              `Tool rules:\n${PI_TOOL_RULES.map((rule) => `- ${rule}`).join("\n")}`,
              "Keep repository searches rooted in the current workspace. Prefer the find, grep, and ls tools with explicit paths. Do not scan the filesystem root or unrelated directories to locate a missing project file; treat stale documentation as possible and inspect the current tree. Search outside the workspace only when the user's task requires it.",
            ],
          },
        });
        readOnly?.signal.throwIfAborted();
        const created = await createAgentSessionFromServices({
          services, sessionManager, sessionStartEvent, model: modelOptions.model,
          ...(readOnly ? { tools: ["read", "grep", "find", "ls"] } : {}),
        });
        if (readOnly) {
          // Chain Pi's own boundary hook, as the main session does: a turn_end handler's decision is
          // honored and dispatch comes before the budget decision. (Children load no extensions, so
          // this changes nothing today.) Extension-driven turns without tool calls never trip the budget.
          const piFinish = created.session.agent.finishTurn;
          created.session.agent.finishTurn = async (turn, finishSignal) => {
            const previous = await piFinish?.(turn, finishSignal);
            const { message } = turn;
            if (previous?.action === "end") return previous;
            if (message.stopReason === "error" || message.stopReason === "aborted") return previous ?? undefined;
            turns++;
            if (!limitReason && message.content.some((part) => part.type === "toolCall") && (turns >= readOnly.maxTurns || toolCalls >= readOnly.maxToolCalls)) {
              limitReason = "Subagent turn/tool-call budget exhausted";
            }
            if (readOnly.signal.aborted) return { action: "end" };
            // A spent child gets exactly one tool-free turn to report what it already found;
            // without it the loop ends on a tool call and the caller receives an empty result.
            if (limitReason && readOnly.reportTurn && !wrapUp) { wrapUp = true; return previous ?? undefined; }
            return limitReason ? { action: "end" } : previous ?? undefined;
          };
        } else created.session.setActiveToolsByName([
          "read", "bash", "edit", "write", "grep", "find", "ls",
          ...tools.current().map((tool) => tool.name),
        ]);
        return { ...created, services, diagnostics: services.diagnostics };
      };
      return models.create(cwd, sessionManager, build, readOnly);
    };

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: options.cwd,
      agentDir,
      sessionManager: readOnly ? SessionManager.inMemory(options.cwd) : SessionManager.create(options.cwd),
    });
    this.wrapper = new PiRuntimeSession(this.runtime, tools, models, readOnly ? { options: readOnly, limitReason: () => limitReason } : undefined);
    return this.wrapper;
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    await this.wrapper?.abort();
    await this.authWork;
    await this.models?.close(); this.models = undefined;
    this.wrapper?.detach();
    this.wrapper = undefined;
    const runtime = this.runtime;
    this.runtime = undefined;
    await runtime?.dispose();
  }
}
