import { existsSync } from "node:fs";
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
  RuntimeEventListener,
  RuntimeForkOptions,
  RuntimeReadOnlyStartOptions,
  RuntimeSession,
  RuntimeSessionInfo,
  RuntimeStartOptions,
  RuntimeState,
  RuntimeSwitchOptions,
  RuntimeTool,
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

  constructor(
    private readonly runtime: AgentSessionRuntime,
    private readonly tools: PiToolController,
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

  async prompt(text: string): Promise<void> {
    const cancel = () => { void this.runtime.session.abort().catch(() => {}); };
    this.readOnly?.options.signal.addEventListener("abort", cancel, { once: true });
    try {
      this.readOnly?.options.signal.throwIfAborted();
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
          this.emit({ type: "tool_end", toolName: event.toolName, toolCallId: event.toolCallId, input, output: event.toolName === "bash" ? observationOutput(event.result) : undefined, isError: event.isError });
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

export class PiRuntime implements AgentRuntime {
  private runtime?: AgentSessionRuntime;
  private wrapper?: PiRuntimeSession;

  start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    return this.create(options);
  }

  startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    for (const limit of [options.maxTurns, options.maxToolCalls]) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid read-only runtime budget");
    }
    return this.create({ cwd: options.cwd, systemPromptAppend: options.systemPromptAppend }, options);
  }

  private async create(options: RuntimeStartOptions, readOnly?: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    if (this.runtime) throw new Error("Pi runtime already started");
    readOnly?.signal.throwIfAborted();
    const agentDir = getAgentDir();
    const modelRuntime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json`, signal: readOnly?.signal });
    const tools = new PiToolController(options.tools ?? []);
    let limitReason: string | undefined;
    let toolCalls = 0;
    let turns = 0;

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      readOnly?.signal.throwIfAborted();
      const extensionFactory = (pi: ExtensionAPI) => {
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
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager: global ? SettingsManager.inMemory({
          defaultProvider: global.defaultProvider, defaultModel: global.defaultModel,
          defaultThinkingLevel: global.defaultThinkingLevel,
          compaction: { enabled: false }, retry: { enabled: false },
        }) : undefined,
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
        },
      });
      readOnly?.signal.throwIfAborted();
      const created = await createAgentSessionFromServices({
        services, sessionManager, sessionStartEvent,
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

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: options.cwd,
      agentDir,
      sessionManager: readOnly ? SessionManager.inMemory(options.cwd) : SessionManager.create(options.cwd),
    });
    this.wrapper = new PiRuntimeSession(this.runtime, tools, readOnly ? { options: readOnly, limitReason: () => limitReason } : undefined);
    return this.wrapper;
  }

  async dispose(): Promise<void> {
    this.wrapper?.detach();
    this.wrapper = undefined;
    const runtime = this.runtime;
    this.runtime = undefined;
    await runtime?.dispose();
  }
}
