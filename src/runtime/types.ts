export interface RuntimeStartOptions {
  cwd: string;
  systemPromptAppend?: string;
}

export interface RuntimeState {
  cwd: string;
  isStreaming: boolean;
}

export type RuntimeEvent =
  | { type: "assistant_text_delta"; delta: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_end"; toolName: string; isError: boolean }
  | { type: "message_end" }
  | { type: "error"; message: string };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface RuntimeSession {
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: RuntimeEventListener): () => void;
  getState(): RuntimeState;
}

export interface AgentRuntime {
  start(options: RuntimeStartOptions): Promise<RuntimeSession>;
  dispose(): Promise<void>;
}
