import type { ToolObservationInput, ToolObservationOutput } from "./observation";

export interface RuntimeToolContext {
  /** Serialize multi-file mutations with the runtime's native file writers. */
  withFileLocks<T>(paths: string[], work: () => Promise<T>): Promise<T>;
}

export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal?: AbortSignal, context?: RuntimeToolContext): Promise<{ text: string; isError?: boolean }>;
}

export interface RuntimeStartOptions {
  cwd: string;
  systemPromptAppend?: string;
  tools?: RuntimeTool[];
  /** Append diagnostics to successful native edit/write results before the next model turn.
   * Path is literal (native input syntax expanded once), absolute or relative to cwd. */
  afterFileEdit?: (path: string, signal?: AbortSignal) => Promise<string | undefined>;
}

export interface RuntimeReadOnlyStartOptions {
  cwd: string;
  systemPromptAppend?: string;
  signal: AbortSignal;
  maxTurns: number;
  maxToolCalls: number;
}

export interface RuntimeState {
  cwd: string;
  isStreaming: boolean;
}

export interface RuntimeSessionInfo {
  cwd: string;
  sessionId: string;
  sessionFile: string;
  name?: string;
}

export interface RuntimeForkOptions {
  cwd: string;
  name: string;
  context?: string;
}

export interface RuntimeSwitchOptions {
  cwd: string;
  sessionFile: string;
  context?: string;
}

export type RuntimeEvent =
  | { type: "assistant_response_start" }
  | { type: "assistant_response_end"; stopReason: string; errorMessage?: string }
  | { type: "assistant_text_delta"; delta: string }
  | { type: "tool_start"; toolName: string; toolCallId?: string; input?: ToolObservationInput }
  /** Diagnostic tool status only: isError=false is not process-exit evidence. */
  | { type: "tool_end"; toolName: string; toolCallId?: string; input?: ToolObservationInput; output?: ToolObservationOutput; isError: boolean }
  | { type: "message_end" }
  | { type: "error"; message: string };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface RuntimeSession {
  /** Replace Casper-owned custom tools between prompts; preserve runtime built-ins. */
  setTools?(tools: RuntimeTool[]): void;
  /** Pi-backed named-session operations. Other runtime adapters may omit these. */
  getSessionInfo?(): RuntimeSessionInfo;
  forkSession?(options: RuntimeForkOptions): Promise<RuntimeSessionInfo>;
  switchSession?(options: RuntimeSwitchOptions): Promise<RuntimeSessionInfo>;
  /** Persist context in the active conversation without triggering a model turn. */
  appendContext?(text: string): Promise<void>;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: RuntimeEventListener): () => void;
  getState(): RuntimeState;
}

export interface AgentRuntime {
  start(options: RuntimeStartOptions): Promise<RuntimeSession>;
  /** Explicit capability, not an optional hint to start(). Must enforce read/grep/find/ls only,
   * disable ambient executable extensions and persistence, honor cancellation and run limits.
   * Implementations must be fresh, independently owned runtime instances. */
  startReadOnly?(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession>;
  dispose(): Promise<void>;
}
