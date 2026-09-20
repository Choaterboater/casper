import type { Readable } from "node:stream";
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

/** Safe preflight diagnostic; callers may surface this exact message without forwarding provider errors. */
export const READ_ONLY_STATE_CONFLICT = "Read-only workspace overlaps writable runtime state; choose a different source or move runtime state outside it.";

export interface RuntimeReadOnlyStartOptions {
  cwd: string;
  systemPromptAppend?: string;
  signal: AbortSignal;
  maxTurns: number;
  maxToolCalls: number;
}

export interface RuntimeStatus {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  /** Local credential snapshot only; never a provider connectivity claim. */
  auth: "configured" | "missing" | "unknown";
  selectionSource?: "conversation" | "default" | "none";
  defaultModel?: { provider: string; id: string };
  /** Generation is blocked until the user resolves this selection. */
  blocked?: string;
}

export interface RuntimePickerIO {
  input: Readable & { isRaw?: boolean; setRawMode?(raw: boolean): unknown };
  output: { write(text: string): void; columns?: number; rows?: number;
    on?(event: "resize", listener: () => void): unknown; off?(event: "resize", listener: () => void): unknown };
  color: boolean;
  onEOF(): void;
}

/** A host grants exclusive terminal ownership only for this operation. No Pi UI types escape. */
export interface RuntimeModelPickerHost {
  run<T>(operation: (io: RuntimePickerIO) => Promise<T>): Promise<T>;
}

export interface RuntimeModelSelectionOptions {
  query?: string;
  /** Explicitly select AND save a Casper startup default. */
  persist?: boolean;
  signal?: AbortSignal;
  picker?: RuntimeModelPickerHost;
}

export interface RuntimeModelSelection {
  status: RuntimeStatus;
  selected: boolean;
  savedDefault: boolean;
  /** Plain-terminal listing; opening a list never selects its first row. */
  models?: Array<{ provider: string; id: string; name: string }>;
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
  getStatus?(): RuntimeStatus;
  selectModel?(options: RuntimeModelSelectionOptions): Promise<RuntimeModelSelection>;
  prompt(text: string, signal?: AbortSignal): Promise<void>;
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
