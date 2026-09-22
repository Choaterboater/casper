import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { READ_ONLY_STATE_CONFLICT } from "./types";
import { PiModels } from "./pi-models";
import { authenticatePi } from "./pi-auth";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { nativeEditPath, observationInput, observationOutput, type ToolObservationInput } from "./observation";
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

  constructor(
    private readonly runtime: AgentSessionRuntime,
    private readonly tools: PiToolController,
    private readonly readOnly?: { options: RuntimeReadOnlyStartOptions; limitReason: () => string | undefined },
    private readonly models?: PiModels,
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
    if (!session.sessionFile) throw new Error("Pi session persistence is unavailable");
    return {
      cwd: this.runtime.cwd,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      name: session.sessionName,
    };
  }

  async forkSession(options: RuntimeForkOptions): Promise<RuntimeSessionInfo> {
    if (this.readOnly) throw new Error("Read-only subagents cannot fork sessions");
    const source = this.runtime.session;
    const sourcePath = source.sessionFile;
    if (!sourcePath) throw new Error("Pi session persistence is unavailable");
    // Pi defers creating a JSONL file until the first assistant response. Export
    // only an as-yet-unwritten session so SessionManager.forkFrom remains the
    // sole owner of the persisted session format and active conversation path.
    if (!existsSync(sourcePath)) source.exportToJsonl(sourcePath);
    const forked = SessionManager.forkFrom(sourcePath, options.cwd);
    forked.appendSessionInfo(options.name);
    const targetPath = forked.getSessionFile();
    if (!targetPath) throw new Error("Pi did not create a persistent fork");
    const result = await this.runtime.switchSession(targetPath);
    if (result.cancelled) throw new Error("Pi session fork was cancelled");
    if (options.context) await this.appendContext(options.context);
    return this.getSessionInfo();
  }

  async switchSession(options: RuntimeSwitchOptions): Promise<RuntimeSessionInfo> {
    if (this.readOnly) throw new Error("Read-only subagents cannot switch sessions");
    const result = await this.runtime.switchSession(options.sessionFile, { cwdOverride: options.cwd });
    if (result.cancelled) throw new Error("Pi session switch was cancelled");
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
    if (this.promptActive) throw new Error("Wait for active work before changing models.");
    if (!this.models) throw new Error("Model selection is unavailable in read-only children.");
    return this.models.select(this.runtime.session, options);
  }

  setEffort(level: string, persist: boolean): Promise<RuntimeStatus> {
    if (this.busy || !this.models) throw new Error("Effort cannot be changed during active work or in a read-only child.");
    return this.models.setEffort(this.runtime.session, level, persist);
  }

  getUsage(): RuntimeUsage {
    const session = this.runtime.session;
    const stats = session.getSessionStats();
    return { context: this.getStatus().model ? session.getContextUsage() : undefined,
      tokens: stats.tokens, messages: stats.totalMessages,
      estimatedCost: stats.cost > 0 ? stats.cost : undefined };
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
    if (this.busy || this.readOnly || this.models?.busy) throw new Error("Wait for active work before clearing context.");
    this.persistUnwrittenConversation();
    const result = await this.runtime.newSession();
    if (result.cancelled) throw new Error("New conversation cancelled.");
    this.persistUnwrittenConversation();
  }

  async resumeConversation(id: string): Promise<void> {
    if (this.busy || this.readOnly || this.models?.busy) throw new Error("Wait for active work before resuming.");
    const saved = (await SessionManager.list(this.runtime.cwd)).filter(info => info.id === id);
    if (saved.length !== 1) throw new Error("Unknown or ambiguous conversation ID in this workspace. Use /resume to list IDs.");
    this.persistUnwrittenConversation();
    const result = await this.runtime.switchSession(saved[0]!.path, { cwdOverride: this.runtime.cwd });
    if (result.cancelled) throw new Error("Resume cancelled.");
  }

  async compact(instructions?: string, signal?: AbortSignal): Promise<void> {
    if (this.busy || this.readOnly) throw new Error("Wait for active work before compacting.");
    this.models?.assertReady(this.runtime.session);
    const session = this.runtime.session;
    const abort = () => session.abortCompaction();
    signal?.throwIfAborted();
    signal?.addEventListener("abort", abort, { once: true });
    try { await session.compact(instructions); signal?.throwIfAborted(); }
    finally { signal?.removeEventListener("abort", abort); }
  }

  getStatus(): RuntimeStatus {
    const session = this.runtime.session;
    if (this.models) return this.models.status(session);
    const model = session.model;
    return {
      provider: model?.provider, model: model?.id, thinkingLevel: session.thinkingLevel,
      auth: model ? session.modelRuntime.hasConfiguredAuth(model.provider) ? "configured" : "missing" : "unknown",
    };
  }

  async prompt(text: string, signal?: AbortSignal): Promise<void> {
    if (this.promptActive) throw new Error("A prompt is already active.");
    this.promptActive = true;
    const cancel = () => { void this.runtime.session.abort().catch(() => {}); };
    const agent = this.runtime.session.agent;
    const stream = agent.streamFunction;
    // Cancellation can arrive while Pi is resolving auth, before its agent has
    // an AbortController. Never start a late request after that cancellation.
    if (signal) agent.streamFunction = (model, context, options) => {
      signal.throwIfAborted();
      return stream(model, context, options);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    this.readOnly?.options.signal.addEventListener("abort", cancel, { once: true });
    try {
      signal?.throwIfAborted();
      this.readOnly?.options.signal.throwIfAborted();
      this.models?.assertReady(this.runtime.session);
      await this.runtime.session.prompt(text, { expandPromptTemplates: !this.readOnly });
      const limitReason = this.readOnly?.limitReason();
      if (limitReason) this.emit({ type: "assistant_response_end", stopReason: "limit", errorMessage: limitReason });
    } catch (error) {
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.promptActive = false;
      if (signal) agent.streamFunction = stream;
      signal?.removeEventListener("abort", cancel);
      this.readOnly?.options.signal.removeEventListener("abort", cancel);
    }
  }

  abort(): Promise<void> {
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
          if (event.message.role === "assistant") this.emit({ type: "assistant_response_start" });
          break;
        case "message_end":
          if (event.message.role === "assistant") this.emit({
            type: "assistant_response_end", stopReason: event.message.stopReason, errorMessage: event.message.errorMessage,
          });
          break;
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            this.emit({ type: "assistant_text_delta", delta: event.assistantMessageEvent.delta });
          }
          break;
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
          this.emit({ type: "tool_end", toolName: event.toolName, toolCallId: event.toolCallId, input, output: event.toolName === "bash" || event.isError ? observationOutput(event.result) : undefined, isError: event.isError });
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
    if (this.runtime) throw new Error("Pi runtime already started");
    readOnly?.signal.throwIfAborted();
    const agentDir = getAgentDir();
    if (readOnly) await checkReadOnlyState(readOnly, agentDir);
    const modelRuntime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json`, signal: readOnly?.signal });
    const models = this.models = readOnly ? undefined : new PiModels(modelRuntime, agentDir);
    const tools = new PiToolController(options.tools ?? []);
    let limitReason: string | undefined;
    let toolCalls = 0;
    let turns = 0;

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      readOnly?.signal.throwIfAborted();
      const extensionFactory = (pi: ExtensionAPI) => {
        if (!readOnly) pi.on("tool_call", (event) => {
          // Keep Pi's native execution, output handling, and process-tree cleanup.
          if (event.toolName === "bash" && event.input.timeout === undefined) event.input.timeout = 120;
        });
        if (readOnly) pi.on("tool_call", () => {
          if (readOnly.signal.aborted || ++toolCalls > readOnly.maxToolCalls) {
            limitReason = readOnly.signal.aborted ? "Subagent cancelled" : "Subagent tool-call budget exhausted";
            return { block: true, reason: limitReason, terminate: true };
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
      // Child runs inherit only global model choice, not executable packages,
      // hooks, project settings, or ambient skills. In-memory settings prevent
      // child model/session choices from rewriting the user's Pi preferences.
      const global = readOnly ? SettingsManager.create(cwd, agentDir).getGlobalSettings() : undefined;
      const build = async (modelOptions?: { settingsManager: SettingsManager; modelRuntime: ModelRuntime; model: AgentSession["model"] }) => {
        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          modelRuntime: modelOptions?.modelRuntime ?? modelRuntime,
          settingsManager: modelOptions?.settingsManager ?? (global ? SettingsManager.inMemory({
            defaultProvider: global.defaultProvider, defaultModel: global.defaultModel,
            defaultThinkingLevel: global.defaultThinkingLevel,
            compaction: { enabled: false }, retry: { enabled: false },
          }) : undefined),
          resourceLoaderOptions: {
            extensionFactories: [extensionFactory],
            ...(readOnly ? {
              noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
              systemPrompt: options.systemPromptAppend ?? "Read-only Casper subagent.",
              appendSystemPrompt: [],
            } : {}),
            // Casper owns discovery, trust checks, and per-task skill selection.
            noSkills: true,
            skillsOverride: () => ({ skills: [], diagnostics: [] }),
            systemPromptOverride: (basePrompt) => readOnly ? options.systemPromptAppend : options.systemPromptAppend
              ? `${basePrompt ?? ""}\n\n${options.systemPromptAppend}`
              : basePrompt,
            appendSystemPromptOverride: (base) => readOnly ? base : [
              ...base,
              "Casper applies a 120-second timeout to bash commands when timeout is omitted. Supply an explicit finite timeout in seconds for intentionally longer commands. After a search times out, narrow its scope rather than retrying the same broad search.",
              "Keep repository searches rooted in the current workspace. Prefer the find, grep, and ls tools with explicit paths. Do not scan the filesystem root or unrelated directories to locate a missing project file; treat stale documentation as possible and inspect the current tree. Search outside the workspace only when the user's task requires it.",
            ],
          },
        });
        readOnly?.signal.throwIfAborted();
        const created = await createAgentSessionFromServices({
          services, sessionManager, sessionStartEvent, model: modelOptions?.model,
          ...(readOnly ? { tools: ["read", "grep", "find", "ls"] } : {}),
        });
        if (readOnly) {
          const stream = created.session.agent.streamFunction;
          created.session.agent.streamFunction = (model, context, streamOptions) => {
            // prompt() can await auth before an agent AbortController exists. Link
            // the caller's cancellation at the last seam before provider execution.
            readOnly.signal.throwIfAborted();
            return stream(model, context, streamOptions);
          };
          created.session.agent.shouldStopAfterTurn = ({ message }) => {
            turns++;
            if (!limitReason && message.content.some((part) => part.type === "toolCall") && (turns >= readOnly.maxTurns || toolCalls >= readOnly.maxToolCalls)) {
              limitReason = "Subagent turn/tool-call budget exhausted";
            }
            return Boolean(limitReason) || readOnly.signal.aborted;
          };
        } else created.session.setActiveToolsByName([
          "read", "bash", "edit", "write", "grep", "find", "ls",
          ...tools.current().map((tool) => tool.name),
        ]);
        return { ...created, services, diagnostics: services.diagnostics };
      };
      return models ? models.create(cwd, sessionManager, build) : build();
    };

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: options.cwd,
      agentDir,
      sessionManager: readOnly ? SessionManager.inMemory(options.cwd) : SessionManager.create(options.cwd),
    });
    this.wrapper = new PiRuntimeSession(this.runtime, tools, readOnly ? { options: readOnly, limitReason: () => limitReason } : undefined, models);
    return this.wrapper;
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    await this.authWork;
    await this.models?.close(); this.models = undefined;
    this.wrapper?.detach();
    this.wrapper = undefined;
    const runtime = this.runtime;
    this.runtime = undefined;
    await runtime?.dispose();
  }
}
