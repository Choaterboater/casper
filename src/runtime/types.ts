import type { Readable } from "node:stream";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ToolObservationInput, ToolObservationOutput } from "./observation";
import type { PromptCacheSetting } from "./cache";

export interface RuntimeToolContext {
  /** Serialize multi-file mutations with the runtime's native file writers. */
  withFileLocks<T>(paths: string[], work: () => Promise<T>): Promise<T>;
}

export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Run one at a time: the tool asks the human or drives shared state, so parallel calls would
   * clash. Pi then runs every call in that batch in order, so keep this off read-only tools. */
  sequential?: boolean;
  execute(args: Record<string, unknown>, signal?: AbortSignal, context?: RuntimeToolContext): Promise<{ text: string; isError?: boolean }>;
}

export interface RuntimeStartOptions {
  cwd: string;
  systemPromptAppend?: string;
  tools?: RuntimeTool[];
  /** Append diagnostics to successful native edit/write results before the next model turn.
   * Path is literal (native input syntax expanded once), absolute or relative to cwd. */
  afterFileEdit?: (path: string, signal?: AbortSignal) => Promise<string | undefined>;
  /** Return a reason to block a tool call before it executes (empty/undefined = allow). Called for every
   * tool: built-in, Casper's own and MCP tools.
   * Read as a closure each call, so per-task gate state can change between calls. */
  beforeToolGate?: (toolName: string, input: Record<string, unknown> | undefined) => string | undefined;
  /** May wait (for a question) before a tool call runs; a reason stops the model's turn. Casper's spend pause. */
  beforeToolWait?: (toolName: string, signal?: AbortSignal) => Promise<string | undefined>;
  /** Hide device secrets in native tool output (read, bash, powershell, grep) before the model sees
   * it. Gets every text block of one result; returns the replaced blocks and a note, or undefined
   * to leave the result as it is. Also called for failed commands, whose output is still shown. */
  scrubToolOutput?: (toolName: string, input: Record<string, unknown>, texts: string[], signal?: AbortSignal)
    => Promise<{ texts: string[]; note?: string } | undefined>;
  /** How the AI's bash runs: in the shell sandbox, or after a question when no sandbox can run. Unset: as it is
   * (provider keys are always taken out of its environment). */
  shell?: RuntimeShell;
  /** The project's sandbox.denyRead (absolute): the file tools refuse these like ~/.ssh. */
  privatePaths?: readonly string[];
  /** The same list read fresh at each tool call, for a conversation that outlives a workspace rebind. */
  currentPrivatePaths?: () => readonly string[];
  /** How long the provider keeps the prompt cache (`cache:` in ~/.casper/config.yaml). Unset: auto. */
  cache?: PromptCacheSetting;
}

/** What the private ssh login adds to one allowed ssh command (see src/ssh/askpass.ts). */
export interface SshRun {
  /** Added to this command's environment only. */
  env?: Record<string, string>;
  /** The command has ended: stop listening. */
  done?(): Promise<void>;
  /** A plain line added to the output when the command fails (why ssh will not be asked for a password). */
  afterFail?: string;
  /** A plain line added only when the command fails and ssh's own words say the login was refused. */
  afterAuthFail?: string;
}

/** The AI's shell, as Casper holds it (see src/sandbox/manager.ts). */
export interface RuntimeShell {
  /** The command as the sandbox runs it (`id` set), or as it is when nothing holds it. */
  wrap(command: string, cwd: string): Promise<{ command: string; id?: string; ssh?: SshRun }>;
  /** A held command has ended (the sandbox cleans up after it). */
  finished?(id: string): void;
  /** After a held command failed: what the sandbox refused, as one line the AI reads, or undefined. */
  refused?(id: string, output: string): Promise<string | undefined>;
  /** When no sandbox runs: a numbered question first; a reason refuses the command. `reached`: this command's
   * "Reach <host>?" was already answered (a service start asked before the sandbox failed on it); not asked again. */
  approve?(command: string, signal?: AbortSignal, options?: { reached?: boolean }): Promise<string | undefined>;
  /** Before the AI's edit or write lands outside the project: a reason refuses it; undefined lets it run. Works
   * with no sandbox too. */
  outsideWrite?(absolute: string): Promise<string | undefined>;
  /** That edit or write went through (the receipt says so). */
  wroteOutside?(absolute: string): void;
  /** Provider keys you keep in the shell's environment (shell.keepEnv). */
  keepEnv?: readonly string[];
  /** A private folder (0700) for Pi's full-output logs of long commands, removed with the session. */
  logDir?(): Promise<string | undefined>;
}

/** Safe preflight diagnostic; callers may surface this exact message without forwarding provider errors. */
export const READ_ONLY_STATE_CONFLICT = "Read-only workspace overlaps writable runtime state; choose a different source or move runtime state outside it.";

export interface RuntimeReadOnlyStartOptions {
  cwd: string;
  systemPromptAppend?: string;
  signal: AbortSignal;
  maxTurns: number;
  maxToolCalls: number;
  /** Spends one tool-free turn after the budget is exhausted so the child can report what it
   * found instead of ending mid-tool-call with an empty result. Off by default: the turn
   * budgets stay exactly what a caller asked for. */
  reportTurn?: boolean;
  /** Casper role for this child; unset roles use the Casper startup default. */
  modelRole?: "fast" | "review";
  /** The same secret scrubbing as the main session: a child's reads reach a model too. */
  scrubToolOutput?: RuntimeStartOptions["scrubToolOutput"];
  /** A reason refuses the call before it runs (the security review keeps key and .env files from its child). */
  beforeToolGate?: RuntimeStartOptions["beforeToolGate"];
  /** The parent session's cache setting. A child lives for minutes, so only off changes it: it keeps the short cache. */
  cache?: PromptCacheSetting;
  /** The project's sandbox.denyRead (absolute), as for the main session. */
  privatePaths?: readonly string[];
}

/** A crew builder: a bounded child that may edit and run commands, but only in its own copy of the project (`cwd`).
 * It gets the built-in tools only: no MCP, no delegate, no crew, no questions. */
export interface RuntimeBuilderStartOptions extends Omit<RuntimeReadOnlyStartOptions, "modelRole"> {
  /** Its bash: the session's sandbox around the copy, with nobody to ask (what would ask is refused). */
  shell?: RuntimeShell;
  /** Before each tool call, after the gates (the task's spend pause); a reason ends the builder's run. */
  beforeToolWait?: RuntimeStartOptions["beforeToolWait"];
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
  /** How the selected provider is paid: a subscription sign-in (the catalog price is not what
   * the user pays) or per token (API key, credits). Absent when unknown. */
  billing?: "subscription" | "per-token";
  selectionSource?: "conversation" | "default" | "none";
  defaultModel?: { provider: string; id: string };
  /** Generation is blocked until the user resolves this selection. */
  blocked?: string;
  /** The model has a catalog price (true) or is free (false); unset when unknown. */
  priced?: boolean;
  /** The model can see images (true) or reads text only (false); unset when no model is selected. */
  images?: boolean;
}

export interface RuntimePickerIO {
  input: Readable & { isRaw?: boolean; setRawMode?(raw: boolean): unknown };
  output: { write(text: string): void; columns?: number; rows?: number;
    on?(event: "resize", listener: () => void): unknown; off?(event: "resize", listener: () => void): unknown };
  color: boolean;
  onEOF(): void;
}

/** Private raw input with panels rendered by the host, never as transcript control bytes. */
export interface RuntimeLoginIO extends RuntimePickerIO {
  show(component?: Component): void;
  requestRender(): void;
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
  /** Exclusive raw input; panels share the host renderer and text output lands in the transcript. */
  run<T>(operation: (io: RuntimeLoginIO) => Promise<T>): Promise<T>;
  /** Mount a focusable component where the prompt editor sits; transcript and footer stay live. */
  mount<T>(operation: (view: RuntimePickerView) => Promise<T>): Promise<T>;
}

export type RuntimeAuthProvider = "openai-codex" | "github-copilot" | "anthropic" | "openrouter";

export interface RuntimeAuthenticationOptions {
  /** Omit to show the local provider chooser. Secrets are never command arguments. */
  provider?: RuntimeAuthProvider;
  /** Show the numbered list even when the provider has one way (Casper opened sign-in by itself, so the
   * user sees what is about to happen). /login <provider> leaves it off and a single way starts at once. */
  list?: boolean;
  terminalHost: RuntimeModelPickerHost;
  signal?: AbortSignal;
}

/** No credentials or provider diagnostics may cross this boundary. */
export type RuntimeAuthenticationResult =
  | { status: "saved" }
  | { status: "saved-needs-refresh" }
  | { status: "cancelled"; effect: "none" | "unknown" }
  | { status: "failed"; effect: "none" | "unknown"; reason: "unavailable" | "destination" | "provider"; detail?: string };

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

export interface RuntimeModelInfo {
  provider: string;
  id: string;
  contextWindow?: number;
  /** Catalog price in dollars per million input tokens; an estimate, never a bill. */
  inputCostPerMillion?: number;
  /** The model can see images. */
  images?: boolean;
}

/** A picture sent with a request: base64 bytes and their type (image/png, image/jpeg, image/gif, image/webp). */
export interface RuntimeImage { data: string; mimeType: string }

export interface RuntimeUsage {
  context?: { tokens: number | null; contextWindow: number; percent: number | null };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** SDK/catalog estimate, never an invoice or subscription charge. */
  estimatedCost?: number;
  /** Separate classifier usage; not included in conversation token totals. */
  effortClassification?: { requests: number; tokens: RuntimeUsage["tokens"]; estimatedCost?: number };
  messages: number;
}

export interface RuntimeConversation {
  id: string; name?: string; modified: string;
  /** The first message sent (Casper's wrapper included; see requestOf) and how many messages it has. */
  firstMessage?: string; messages?: number;
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
  | { type: "model_controls_changed"; status: RuntimeStatus }
  | { type: "assistant_response_start"; provider?: string; model?: string }
  /** `usage` is what the provider reported for this response (the SDK's catalog cost estimate,
   * never an invoice); absent when the runtime has no report. */
  | { type: "assistant_response_end"; stopReason: string; errorMessage?: string; usage?: { tokens: number; estimatedCost: number };
      /** A provider error the runtime is about to retry: not the outcome, and not shown as an error. */
      retrying?: boolean }
  /** The provider failed and the runtime tries again after `delayMs` (attempt `attempt` of `maxAttempts`). */
  | { type: "retry"; provider?: string; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "assistant_text_delta"; delta: string }
  /** The model is producing something not yet visible: reasoning, or a tool call's arguments
   * (a large `write` body streams for seconds before `tool_start`). `chars` is cumulative for
   * the current block; this is liveness for the person watching, never transcript content. */
  | { type: "assistant_progress"; kind: "thinking" | "tool_call"; toolName?: string; chars: number }
  | { type: "tool_start"; toolName: string; toolCallId?: string; input?: ToolObservationInput }
  /** A running bash command printed more: the tail of its output so far (screen only, throttled; never in --json). */
  | { type: "tool_progress"; toolName: string; toolCallId?: string; text: string }
  /** Diagnostic tool status only: isError=false is not process-exit evidence. */
  | { type: "tool_end"; toolName: string; toolCallId?: string; input?: ToolObservationInput; output?: ToolObservationOutput; isError: boolean;
      /** A successful edit's size, from the runtime's patch. */
      lines?: { added: number; removed: number };
      /** A successful edit's unified diff, for the screen only (detailed display and ctrl+t). */
      diff?: string }
  | { type: "message_end" }
  /** The prompt's `maxTurns` ended it after that many model turns, with the model still working. */
  | { type: "turn_limit"; turns: number }
  /** A plain-words heads-up for the person, not part of the conversation. */
  | { type: "notice"; message: string }
  | { type: "error"; message: string };

export type RuntimeEventListener = (event: RuntimeEvent) => void;

export interface RuntimeSession {
  /** Replace Casper-owned custom tools between prompts; preserve runtime built-ins. */
  setTools?(tools: RuntimeTool[]): void;
  /** Pi-backed named-session operations. Other runtime adapters may omit these. */
  getSessionInfo?(): RuntimeSessionInfo;
  /** Name the active conversation (shown by /resume and in the window title). */
  setSessionName?(name: string): void;
  forkSession?(options: RuntimeForkOptions): Promise<RuntimeSessionInfo>;
  switchSession?(options: RuntimeSwitchOptions): Promise<RuntimeSessionInfo>;
  /** Persist context in the active conversation without triggering a model turn. */
  appendContext?(text: string): Promise<void>;
  /** Where the conversation is now (its last entry), or null when it is empty. Undo records it before a task. */
  conversationMark?(): string | null;
  /** Rewinds the conversation to `mark` at no token cost, only when it still ends at `expected` (nothing was said
   * since). False, with nothing changed, when it can't. */
  rewindTo?(mark: string | null, expected: string | null): Promise<boolean>;
  getStatus?(): RuntimeStatus;
  selectModel?(options: RuntimeModelSelectionOptions): Promise<RuntimeModelSelection>;
  /** Pick a default model for a signed-in provider only when no model is selected; never overrides a choice. */
  selectDefaultModel?(options?: { provider?: string; signal?: AbortSignal }): Promise<RuntimeModelSelection | undefined>;
  getModelRoles?(): Record<string, string>;
  /** What a selector (`@reason`, `provider/id`) names, without selecting it: its context window and input price
   * per million tokens, when the catalog knows them. Undefined when nothing matches. Makes no call. */
  describeModel?(query: string): RuntimeModelInfo | undefined;
  /** A signed-in model that can see images, for a request with pictures on one that can't: the user's model
   * roles first, then the provider's default. Undefined when none can. Makes no call. */
  visionModel?(): RuntimeModelInfo | undefined;
  setModelRole?(role: string, selector?: string): Promise<Record<string, string>>;
  setEffort?(level: string, persist: boolean): Promise<RuntimeStatus>;
  getUsage?(): RuntimeUsage;
  /** One model call outside the conversation, with the conversation's model and effort unless `effort`
   * asks for another (mapped to what the model supports); `maxTokens` caps the answer. Nothing is added
   * to the transcript. `usage` is null when the provider reported none; `model` names the model that answered. `role: "fast"` uses your fast model when it
   * is set and signed in, else the conversation's model; unset, the review model when set. */
  complete?(input: { systemPrompt: string; user: string; signal?: AbortSignal; effort?: string; maxTokens?: number; role?: "fast" }): Promise<{ text: string; error?: string; usage: { tokens: number; estimatedCost: number } | null;
    /** The model that answered (`provider/id`), when one was called. */
    model?: string }>;
  listConversations?(): Promise<RuntimeConversation[]>;
  clearConversation?(): Promise<void>;
  /** `keepUnwritten: false` drops a new conversation that has no saved response yet instead of
   * saving it for /resume (a startup `--resume` has nothing worth keeping). */
  resumeConversation?(id: string, options?: { keepUnwritten?: boolean }): Promise<void>;
  /** The conversation's last messages with text, oldest first (shown after /resume). */
  recentTurns?(count: number): Array<{ role: "user" | "assistant"; text: string }>;
  compact?(instructions?: string, signal?: AbortSignal): Promise<void>;
  /** `maxTurns` stops the request gracefully after that many model turns (tools of the last turn
   * still finish) and emits turn_limit; unset means no Casper turn limit. `images` go with the text (a model
   * that can't see them gets a placeholder from the runtime). */
  prompt(text: string, signal?: AbortSignal, options?: { request: string; maxTurns?: number; images?: readonly RuntimeImage[] }): Promise<void>;
  /** A line the user typed while the model works: the model reads it at its next step. False, with nothing sent,
   * when no prompt is running (the caller keeps it as the next request). */
  steer?(text: string): Promise<boolean>;
  /** Lines steered in that the model never read (the run ended first); they are taken out of the runtime. */
  takeUnsent?(): string[];
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
  /** A crew builder (see RuntimeBuilderStartOptions): the same run limits and cancellation as a read-only child,
   * on a fresh, independently owned runtime, with the conversation's default model. */
  startBuilder?(options: RuntimeBuilderStartOptions): Promise<RuntimeSession>;
  dispose(): Promise<void>;
}
