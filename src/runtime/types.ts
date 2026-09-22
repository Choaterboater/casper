import type { Readable } from "node:stream";
import type { Component, TUI } from "@earendil-works/pi-tui";
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
  /** Return a reason to block a native tool call before it executes (empty/undefined = allow).
   * Read as a closure each call, so per-task gate state can change between calls. */
  beforeToolGate?: (toolName: string, input: Record<string, unknown> | undefined) => string | undefined;
}

/** Safe preflight diagnostic; callers may surface this exact message without forwarding provider errors. */
export const READ_ONLY_STATE_CONFLICT = "Read-only workspace overlaps writable runtime state; choose a different source or move runtime state outside it.";

export interface RuntimeReadOnlyStartOptions {
  cwd: string;
  systemPromptAppend?: string;
  signal: AbortSignal;
  maxTurns: number;
  maxToolCalls: number;
  /** Casper role for this child; unset roles use the Casper startup default. */
  modelRole?: "fast" | "review";
}

export interface RuntimeStatus {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  availableThinkingLevels?: string[];
  configuredEffort?: string;
  modelRole?: string;
  autoEffort?: { state: "pending" | "classified" | "fallback" | "unavailable"; classifier?: string };
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

/** Interactive pickers render inside the host's live surface, in place of the prompt editor. */
export interface RuntimePickerView {
  readonly tui: TUI;
  readonly color: boolean;
  /** Show this component in the editor slot until the operation settles. */
  show(component: Component): void;
  onEOF(): void;
}

/** A host lends its terminal for one operation at a time. No Pi UI types escape. */
export interface RuntimeModelPickerHost {
  /** Exclusive raw input for line-oriented flows such as login. Output still lands in the transcript. */
  run<T>(operation: (io: RuntimePickerIO) => Promise<T>): Promise<T>;
  /** Mount a focusable component where the prompt editor sits; transcript and footer stay live. */
  mount<T>(operation: (view: RuntimePickerView) => Promise<T>): Promise<T>;
}

export type RuntimeAuthProvider = "openai-codex" | "github-copilot" | "anthropic" | "openrouter";

export interface RuntimeAuthenticationOptions {
  /** Omit to show the local provider chooser. Secrets are never command arguments. */
  provider?: RuntimeAuthProvider;
  terminalHost: RuntimeModelPickerHost;
  signal?: AbortSignal;
}

/** No credentials or provider diagnostics may cross this boundary. */
export type RuntimeAuthenticationResult =
  | { status: "saved" }
  | { status: "saved-needs-refresh" }
  | { status: "cancelled"; effect: "none" | "unknown" }
  | { status: "failed"; effect: "none" | "unknown"; reason: "unavailable" | "destination" | "provider" };

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

export interface RuntimeUsage {
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** SDK/catalog estimate, never an invoice or subscription charge. */
  estimatedCost?: number;
  /** Separate classifier usage; not included in conversation token totals. */
  effortClassification?: { requests: number; tokens: RuntimeUsage["tokens"]; estimatedCost?: number };
  messages: number;
}

export interface RuntimeConversation { id: string; name?: string; modified: string; }

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
  | { type: "model_controls_changed"; status: RuntimeStatus }
  | { type: "assistant_response_start" }
  | { type: "assistant_response_end"; stopReason: string; errorMessage?: string }
  | { type: "assistant_text_delta"; delta: string }
  /** The model is producing something not yet visible: reasoning, or a tool call's arguments
   * (a large `write` body streams for seconds before `tool_start`). `chars` is cumulative for
   * the current block; this is liveness for the person watching, never transcript content. */
  | { type: "assistant_progress"; kind: "thinking" | "tool_call"; toolName?: string; chars: number }
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
  getModelRoles?(): Record<string, string>;
  setModelRole?(role: string, selector?: string): Promise<Record<string, string>>;
  setEffort?(level: string, persist: boolean): Promise<RuntimeStatus>;
  getUsage?(): RuntimeUsage;
  listConversations?(): Promise<RuntimeConversation[]>;
  clearConversation?(): Promise<void>;
  resumeConversation?(id: string): Promise<void>;
  compact?(instructions?: string, signal?: AbortSignal): Promise<void>;
  prompt(text: string, signal?: AbortSignal, options?: { request: string }): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: RuntimeEventListener): () => void;
  getState(): RuntimeState;
}

export interface AgentRuntime {
  /** Local chooser/consent precedes any writable auth storage or provider operation. */
  authenticate?(options: RuntimeAuthenticationOptions): Promise<RuntimeAuthenticationResult>;
  start(options: RuntimeStartOptions): Promise<RuntimeSession>;
  /** Explicit capability, not an optional hint to start(). Must enforce read/grep/find/ls only,
   * disable ambient executable extensions and persistence, honor cancellation and run limits.
   * Implementations must be fresh, independently owned runtime instances. */
  startReadOnly?(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession>;
  dispose(): Promise<void>;
}
