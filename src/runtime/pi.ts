import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  AgentRuntime,
  RuntimeEventListener,
  RuntimeSession,
  RuntimeStartOptions,
  RuntimeState,
} from "./types";

class PiRuntimeSession implements RuntimeSession {
  private readonly listeners = new Set<RuntimeEventListener>();

  constructor(
    private readonly cwd: string,
    private readonly session: AgentSession,
  ) {
    this.session.subscribe((event) => {
      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            this.emit({ type: "assistant_text_delta", delta: event.assistantMessageEvent.delta });
          }
          break;
        case "tool_execution_start":
          this.emit({ type: "tool_start", toolName: event.toolName });
          break;
        case "tool_execution_end":
          this.emit({ type: "tool_end", toolName: event.toolName, isError: event.isError });
          break;
        case "agent_end":
          this.emit({ type: "message_end" });
          break;
      }
    });
  }

  async prompt(text: string): Promise<void> {
    try {
      await this.session.prompt(text);
    } catch (error) {
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): RuntimeState {
    return {
      cwd: this.cwd,
      isStreaming: this.session.isStreaming,
    };
  }

  private emit(event: Parameters<RuntimeEventListener>[0]): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export class PiRuntime implements AgentRuntime {
  private session?: AgentSession;

  async start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    const agentDir = getAgentDir();
    const modelRuntime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` });
    const settingsManager = SettingsManager.create(options.cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      settingsManager,
      systemPromptOverride: (basePrompt) => {
        if (!options.systemPromptAppend) {
          return basePrompt;
        }

        return `${basePrompt}\n\n${options.systemPromptAppend}`;
      },
    });
    await resourceLoader.reload();

    const result = await createAgentSession({
      cwd: options.cwd,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.create(options.cwd),
      settingsManager,
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    });

    this.session = result.session;
    return new PiRuntimeSession(options.cwd, result.session);
  }

  async dispose(): Promise<void> {
    this.session?.dispose();
    this.session = undefined;
  }
}
