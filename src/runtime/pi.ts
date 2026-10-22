import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { looksLikeRefusedLogin } from "../ssh/auth-failed";
import { READ_ONLY_STATE_CONFLICT } from "./types";
import { DEFAULT_COMMAND_LIMIT_SECONDS } from "./background-commands";
import { pidFile, STALLED_EXIT_CODE, stalledMessage, watchStall } from "./stalled-commands";
import { matchConversation } from "../sessions/resume";
import { PiModels } from "./pi-models";
import { BASH_TIMEOUT_CAP_SECONDS, COMMAND_GUIDANCE, SEARCH_GUIDANCE, LEAN_COMMAND_GUIDANCE, LEAN_SEARCH_GUIDANCE, projectGuidance } from "./guidance";
import { AgentShellGuard, AGENT_SHELL_GUIDANCE } from "./agent-shell-guard";
export { BASH_TIMEOUT_CAP_SECONDS } from "./guidance";
import { configureLocalServers, dropLocalServers, forgetLocalServer, localServers, localServerSettled, localServersHereSettled, onLocalServer, registerLocalServers, rememberLocalServer, savedLocalServers } from "./local-models";
import { addModelServers, forgetModelServer } from "./add-model-server";
import { serverLabel } from "./model-servers";
import { forgetServerChoices } from "../app/safe-choices";
import { withLoginDisplay, type LoginDisplay } from "../tui/login";
import type { ModelServerActions } from "./pi-models";
import { applyClaudeCodeVersion } from "./claude-code-version";
import { registerClaudeSubscription } from "./claude-subscription";
import { authenticatePi } from "./pi-auth";
import { applyOpenRouterAttribution, isOpenRouterModel } from "./openrouter-attribution";
import { retryUpstreamErrors } from "./model-errors";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createBashToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  CredentialSynchronizationError,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionRuntime,
  BashOperations,
  CreateAgentSessionRuntimeFactory,
  ExtensionAPI,
  SettingsManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TObject, type TProperties } from "typebox";
import { gitGuardReason } from "./git-guard";
import { classifyPath, displayPath, fileToolGate, gitInternalsCommand, privatePathCommand, realpathLongest, resolveToolPath, shellTempPath } from "../platform/project-paths";
/** The AI's tools that take a file or folder `path`. */
const FILE_PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls", "lsp"]);
import { withoutProviderKeys } from "../platform/environment";
import { createOwnedBashOperations } from "./local-bash";
import { ProcessCleanupError } from "../platform/processes";
import { cacheRetentionFor, type PromptCacheSetting } from "./cache";
import { LoopGuard } from "./loop-guard";
import { ToolHistory, TOOL_HISTORY_ENTRY } from "./tool-history";
import { ELISION_NOTE, elisionTexts, newElisions } from "./elision";
import { addsSecret } from "../secrets/files";
import { ToolArgumentRepair } from "./tool-repair";
import { nativeEditPath, observationInput, editPatch, observationOutput, patchLineCounts, stepTitle, writeLineCounts, type ToolObservationInput } from "./observation";
import { reasoningHeadline } from "./reasoning-headline";
import type {
  AgentRuntime,
  RuntimeAuthenticationOptions,
  RuntimeAuthenticationResult,
  RuntimeEventListener,
  RuntimeModelSelection,
  RuntimeModelSelectionOptions,
  RuntimeForkOptions,
  RuntimeReadOnlyStartOptions,
  RuntimeBuilderStartOptions,
  RuntimeSession,
  RuntimeShell,
  RuntimeSessionInfo,
  RuntimeStartOptions,
  RuntimeState,
  RuntimeStatus,
  RuntimeSwitchOptions,
  RuntimeTool,
  RuntimeToolResult,
  RuntimeUsage,
  RuntimeImage,
  RuntimeModelInfo,
  RuntimeModelWordsMatch,
  RuntimeModelWordsOptions,
  RuntimeConversation,
  RuntimeEvent,
} from "./types";
import { isOutside } from "../platform/inside";
import { withToolReason } from "./tool-reason";
import { CheckChangeGuard, guardedFileTools } from "./check-changes";

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
  /** The AI's title for each running shell step, by call id (display only). */
  private readonly toolTitles = new Map<string, string>();
  /** When each running command's output was last forwarded (throttle), by call id. */
  private readonly progressAt = new Map<string, number>();
  private readonly writes = new Map<string, { before: string | undefined | null; after: string }>();
  private unsubscribePi?: () => void;
  private promptActive = false;
  /** A response that ended in a provider error, held until Pi says whether it retries. */
  private heldError?: Extract<RuntimeEvent, { type: "assistant_response_end" }>;
  /** Steered lines the model never read; see takeUnsent. */
  private readonly unsent: string[] = [];
  private progressChars = 0;
  private progressReported = 0;
  /** The end of the current reasoning block's text and the headline last sent from it (status row only). */
  private thinkingTail = "";
  private headline?: string;
  private promptController?: AbortController;

  constructor(
    private readonly runtime: AgentSessionRuntime,
    private readonly tools: PiToolController,
    private readonly models: PiModels,
    private readonly readOnly?: { options: RuntimeReadOnlyStartOptions | RuntimeBuilderStartOptions; limitReason: () => string | undefined; wrapUp: (reason: string) => void },
    private readonly cache?: PromptCacheSetting,
    private readonly hideToolOutput?: () => boolean,
    private readonly agentShellGuard?: AgentShellGuard,
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

  setSessionName(name: string): void {
    this.runtime.session.setSessionName(name);
  }

  exportJsonl(file: string): void {
    this.runtime.session.exportToJsonl(file);
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

  conversationMark(): string | null {
    return this.runtime.session.sessionManager.getLeafId();
  }

  conversationEntries(from?: string): Array<{ id: string; prompt?: string }> {
    return this.runtime.session.sessionManager.getBranch(from).map((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return { id: entry.id };
      const content = entry.message.content;
      return { id: entry.id, prompt: typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n") };
    });
  }

  async rewindTo(mark: string | null, expected: string | null): Promise<boolean> {
    if (this.readOnly || this.busy || this.models.busy) return false;
    const session = this.runtime.session;
    const manager = session.sessionManager;
    if (manager.getLeafId() !== expected) return false;
    if (mark === expected) return true;
    const branch = manager.getBranch();
    const at = mark === null ? -1 : branch.findIndex((entry) => entry.id === mark);
    if (mark !== null && at < 0) return false;
    const next = branch[at + 1];
    if (!next) return false;
    // Navigating to a user or Casper message puts the conversation just before it, with no summary and no model
    // call. The returned editor text is Casper's composed prompt, not the user's words, so it is not used.
    const startsTurn = (entry: typeof next) => entry.type === "custom_message" || (entry.type === "message" && entry.message.role === "user");
    let target: string | undefined;
    if (startsTurn(next)) target = next.id;
    else if (mark !== null && !startsTurn(branch[at]!)) target = mark;
    if (!target) return false;
    // Pi does nothing when asked to go to the entry it is already on: step onto the mark first, then onto the entry.
    if (target === manager.getLeafId()) {
      if (mark === null) return false;
      if ((await session.navigateTree(mark, { summarize: false })).cancelled) return false;
    }
    const result = await session.navigateTree(target, { summarize: false });
    return !result.cancelled && manager.getLeafId() === mark;
  }

  get busy(): boolean { return this.promptActive || !this.runtime.session.isIdle; }

  /** The model is mid-run (between or during its steps): a model or effort change applies from its next step, as Pi
   * reads both before each request. Not before the run has started (auth preflight) or while anything else runs. */
  private get midRun(): boolean { return this.promptActive && this.runtime.session.isStreaming; }

  selectModel(options: RuntimeModelSelectionOptions): Promise<RuntimeModelSelection> {
    if ((this.busy && !this.midRun) || this.models.busy) throw new Error("Wait for active work before changing models.");
    if (this.readOnly) throw new Error("Model selection is unavailable in read-only children.");
    return this.models.select(this.runtime.session, options, this.midRun);
  }

  findModelAgain(options: { signal?: AbortSignal } = {}): Promise<boolean> {
    if (this.busy || this.models.busy || this.readOnly) return Promise.resolve(false);
    return this.models.findModelAgain(this.runtime.session, options.signal);
  }

  localProblems(): string[] { return this.readOnly ? [] : this.models.serverProblems(); }

  selectDefaultModel(options: { provider?: string; signal?: AbortSignal } = {}): Promise<RuntimeModelSelection | undefined> {
    if (this.busy || this.models.busy) throw new Error("Wait for active work before changing models.");
    if (this.readOnly) return Promise.resolve(undefined);
    return this.models.selectDefaultIfUnset(this.runtime.session, options);
  }

  setEffort(level: string, persist: boolean): Promise<RuntimeStatus> {
    if ((this.busy && !this.midRun) || this.readOnly || this.models.busy) throw new Error("Effort cannot be changed during active work or in a read-only child.");
    return this.models.setEffort(this.runtime.session, level, persist, this.midRun);
  }

  getModelRoles(): Record<string, string> {
    return this.models.getRoles();
  }

  describeModel(query: string): RuntimeModelInfo | undefined {
    return this.models.describe(query);
  }

  matchModel(words: string, options?: RuntimeModelWordsOptions): Promise<RuntimeModelWordsMatch> {
    return this.models.matchWords(words, this.runtime.session, options);
  }

  visionModel(): RuntimeModelInfo | undefined {
    return this.models.visionModel(this.runtime.session);
  }

  signedIn(provider: string): boolean { return this.models.signedIn(provider); }

  providerKey(provider: string): Promise<string | undefined> { return this.models.providerKey(provider); }

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

  complete(input: { systemPrompt: string; user: string; signal?: AbortSignal; effort?: string; maxTokens?: number; role?: "fast" }) {
    return this.models.complete(this.runtime.session, input);
  }

  async listConversations(): Promise<RuntimeConversation[]> {
    return (await SessionManager.list(this.runtime.cwd)).map(info => ({ id: info.id, name: info.name, modified: info.modified.toISOString(),
      firstMessage: info.firstMessage.slice(0, 4000), messages: info.messageCount }));
  }

  recentTurns(count: number): Array<{ role: "user" | "assistant"; text: string }> {
    const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (const message of this.runtime.session.messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const content = message.content;
      const text = typeof content === "string" ? content
        : content.map(part => part.type === "text" ? part.text : "").filter(Boolean).join("\n");
      if (text.trim()) turns.push({ role: message.role, text });
    }
    return turns.slice(-Math.max(0, count));
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
    // The exact ID, or the one that starts with it.
    const saved = matchConversation(await SessionManager.list(this.runtime.cwd), id);
    if (options.keepUnwritten !== false) this.persistUnwrittenConversation();
    const result = await this.runtime.switchSession(saved.path, { cwdOverride: this.runtime.cwd });
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

  async prompt(text: string, signal?: AbortSignal, options?: { request: string; maxTurns?: number; images?: readonly RuntimeImage[] }): Promise<void> {
    if (this.promptActive) throw new Error("A prompt is already active.");
    this.promptActive = true;
    this.agentShellGuard?.task(options?.request ?? text, signal ?? options?.request ?? text);
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
      const history = new ToolHistory();
      // Only custom records on this branch count: rewind, resume and forks cannot share mutable masks.
      for (const entry of session.sessionManager.getBranch())
        if (entry.type === "custom" && entry.customType === TOOL_HISTORY_ENTRY) history.restore(entry.data);
      const projected = history.project(context.messages, this.hideToolOutput?.() !== false, { contextWindow: model.contextWindow });
      if (projected.checkpoint) session.sessionManager.appendCustomEntry(TOOL_HISTORY_ENTRY, projected.checkpoint);
      return stream(model, { ...context, messages: projected.messages }, {
        ...streamOptions,
        // Conversation requests follow cache: (auto by default); a request that already chose (none) keeps its choice.
        cacheRetention: streamOptions?.cacheRetention ?? cacheRetentionFor(this.cache, model),
        signal: streamOptions?.signal ? AbortSignal.any([promptSignal, streamOptions.signal]) : promptSignal,
      });
    };
    promptSignal.addEventListener("abort", cancel, { once: true });
    try {
      promptSignal.throwIfAborted();
      const status = await this.models.preparePrompt(session, options?.request ?? text, promptSignal);
      promptSignal.throwIfAborted();
      const notice = this.readOnly ? undefined : this.models.smallWindowNotice(session);
      if (notice) this.emit({ type: "notice", message: notice });
      const localNotice = this.readOnly ? undefined : this.models.localNotice();
      if (localNotice) this.emit({ type: "notice", message: localNotice });
      if (status.configuredEffort === "auto") this.emit({ type: "model_controls_changed", status });
      promptSignal.throwIfAborted();
      const images = options?.images?.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
      await session.prompt(text, { expandPromptTemplates: !this.readOnly, ...(images?.length ? { images } : {}) });
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
      // A line steered in after the model's last step is not lost: it comes back through takeUnsent.
      if (session.pendingMessageCount) { const left = session.clearQueue(); this.unsent.push(...left.steering, ...left.followUp); }
      agent.streamFunction = stream;
      if (maxTurns !== undefined) agent.finishTurn = previousFinish;
      promptSignal.removeEventListener("abort", cancel);
      this.promptController = undefined;
      this.promptActive = false;
    }
  }

  async steer(text: string): Promise<boolean> {
    const session = this.runtime.session;
    if (this.readOnly || !this.promptActive || !session.isStreaming) return false;
    await session.steer(text);
    return true;
  }

  takeUnsent(): string[] {
    const left = this.unsent.splice(0);
    if (!this.promptActive) {
      const queued = this.runtime.session.clearQueue();
      left.push(...queued.steering, ...queued.followUp);
    }
    return left;
  }

  wrapUp(reason: string): void { this.readOnly?.wrapUp(reason); }

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
    this.toolTitles.clear();
    this.listeners.clear();
  }

  private bind(session: AgentSession): void {
    this.unsubscribePi?.();
    this.toolInputs.clear();
    this.toolTitles.clear();
    this.writes.clear();
    this.unsubscribePi = session.subscribe((event) => {
      switch (event.type) {
        case "turn_start":
          this.emit({ type: "assistant_request_start", provider: session.model?.provider, model: session.model?.id });
          break;
        case "message_start":
          if (event.message.role === "assistant") this.emit({
            type: "assistant_response_start", provider: session.model?.provider, model: session.model?.id,
          });
          break;
        case "message_end":
          if (event.message.role === "assistant") {
            const { totalTokens, cost, input, cacheRead, cacheWrite, output } = event.message.usage ?? {};
            const reported = Number.isFinite(totalTokens) && Number.isFinite(cost?.total);
            const end = {
              type: "assistant_response_end" as const, stopReason: event.message.stopReason, errorMessage: event.message.errorMessage,
              ...(reported ? { usage: { tokens: totalTokens, estimatedCost: cost.total, input, cacheRead, cacheWrite, output } } : {}),
            };
            // A provider error may be retried: Pi decides at agent_end, so the error waits until then.
            if (event.message.stopReason === "error") this.heldError = end; else this.emit(end);
          }
          break;
        case "auto_retry_start":
          this.emit({ type: "retry", provider: session.model?.provider, attempt: event.attempt, maxAttempts: event.maxAttempts,
            delayMs: event.delayMs, errorMessage: event.errorMessage });
          break;
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (update.type === "text_delta") { this.emit({ type: "assistant_text_delta", delta: update.delta }); break; }
          if (update.type === "thinking_start" || update.type === "toolcall_start") {
            this.progressChars = 0;
            if (update.type === "thinking_start") { this.thinkingTail = ""; this.headline = undefined; }
          } else if (update.type === "thinking_delta" || update.type === "toolcall_delta") this.progressChars += update.delta.length;
          else break;
          const thinking = update.type.startsWith("thinking");
          // The reasoning's own words, kept short, only for a status-row headline: worked out again when a sentence or a
          // title may have ended, never stored or shown anywhere else.
          let headline = this.headline;
          if (update.type === "thinking_delta") {
            this.thinkingTail = (this.thinkingTail + update.delta).slice(-2000);
            if (/[.!?*\n]/.test(update.delta)) headline = reasoningHeadline(this.thinkingTail);
          }
          // Coalesce: the first event of a block, then every 256 characters, and when the headline changes.
          if (this.progressChars !== 0 && this.progressChars - this.progressReported < 256 && headline === this.headline) break;
          this.progressReported = this.progressChars;
          this.headline = headline;
          const block = update.partial.content[update.contentIndex];
          this.emit({ type: "assistant_progress", kind: thinking ? "thinking" : "tool_call",
            toolName: block?.type === "toolCall" ? block.name : undefined, chars: this.progressChars, ...(thinking && headline ? { headline } : {}) });
          break;
        }
        case "tool_execution_start": {
          const input = observationInput(event.args);
          if (["edit", "write"].includes(event.toolName) && input.path !== undefined) input.path = nativeEditPath(input.path);
          if (this.toolInputs.size < 64) this.toolInputs.set(event.toolCallId, input);
          // A write reports no diff: keep the old text (small files only) to count +N -M when it ends.
          const content = event.toolName === "write" ? Reflect.get(Object(event.args), "content") : undefined;
          const file = input.path === undefined ? undefined : path.resolve(this.runtime.cwd, input.path);
          const before = typeof content === "string" && file !== undefined ? readSmallText(file) : undefined;
          if (typeof content === "string" && file !== undefined && this.writes.size < 64) this.writes.set(event.toolCallId, { before, after: content });
          // A secret the AI writes into a file is a receipt line naming the file (src/secrets/files.ts addsSecret).
          const texts = file === undefined ? undefined : elisionTexts(event.toolName, Object(event.args), before ?? undefined);
          if (file !== undefined && texts && addsSecret(file, texts.before, texts.after)) input.secretWritten = displayPath(file, this.runtime.cwd);
          const description = stepTitle(event.toolName, event.args);
          if (description !== undefined && this.toolTitles.size < 64) this.toolTitles.set(event.toolCallId, description);
          this.emit({ type: "tool_start", toolName: event.toolName, toolCallId: event.toolCallId, input, ...(description !== undefined ? { description } : {}) });
          break;
        }
        case "tool_execution_update": {
          if (event.toolName !== "bash") break;
          // At most ~2 a second per call: a chatty command must not flood the screen.
          const now = Date.now();
          if (now - (this.progressAt.get(event.toolCallId) ?? 0) < 500) break;
          if (this.progressAt.size < 64 || this.progressAt.has(event.toolCallId)) this.progressAt.set(event.toolCallId, now);
          const text = observationOutput(event.partialResult).text;
          if (text) this.emit({ type: "tool_progress", toolName: event.toolName, toolCallId: event.toolCallId, text: text.slice(-2000) });
          break;
        }
        case "tool_execution_end": {
          this.progressAt.delete(event.toolCallId);
          const input = this.toolInputs.get(event.toolCallId);
          this.toolInputs.delete(event.toolCallId);
          const description = this.toolTitles.get(event.toolCallId);
          this.toolTitles.delete(event.toolCallId);
          const write = this.writes.get(event.toolCallId);
          this.writes.delete(event.toolCallId);
          const kept = !event.isError && event.result?.details?.sessionOnlyCheck === true;
          const lines = event.isError || kept ? undefined : event.toolName === "edit" ? patchLineCounts(event.result)
            : write && write.before !== null ? writeLineCounts(write.before, write.after) : undefined;
          const diff = !event.isError && event.toolName === "edit" ? editPatch(event.result) : undefined;
          // Lookup notes (empty results and skipped repeats) need bounded text even on success.
          this.emit({ type: "tool_end", toolName: event.toolName, toolCallId: event.toolCallId, input, output: ["bash", "casper_check", "read", "grep", "find", "ls"].includes(event.toolName) || event.isError || kept ? observationOutput(event.result) : undefined,
            isError: event.isError, ...(description !== undefined ? { description } : {}), ...(kept ? { sessionOnlyCheck: true } : {}), ...(lines ? { lines } : {}), ...(diff ? { diff } : {}) });
          break;
        }
        case "agent_end": {
          this.toolInputs.clear();
          this.toolTitles.clear();
          this.progressAt.clear();
          const held = this.heldError; this.heldError = undefined;
          if (held) this.emit(event.willRetry ? { ...held, retrying: true } : held);
          this.emit({ type: "message_end" });
          break;
        }
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
    return Boolean(inside) && !isOutside(inside);
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
export async function canonicalStatePath(file: string, signal: AbortSignal, fs: { realpath: (file: string) => Promise<string>; lstat: (file: string) => Promise<{ isSymbolicLink(): boolean }> } = { realpath, lstat }): Promise<string> {
  if (Buffer.byteLength(file) > 4096) throw new Error("Writable runtime state path exceeds the preflight limit");
  let prefix = file;
  const suffix: string[] = [];
  for (let step = 0; step < 128; step++) {
    signal.throwIfAborted();
    try { return path.join(await fs.realpath(prefix), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink is not a missing ordinary path: never invent its destination.
      const entry = await fs.lstat(prefix).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
      if (entry?.isSymbolicLink()) throw new Error("Cannot resolve writable runtime state");
      // Another Casper sharing this home created it after realpath looked (auth.json, models-store.json): look again.
      if (entry) continue;
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
    if (!relative || !isOutside(relative)) {
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

/** What the model gets from one of Casper's tools: the text, then its pictures when the model can see images. A model
 * that can't is told the picture was left out, so it does not ask for one again. */
export function toolContent(result: RuntimeToolResult, seesImages: boolean): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  const text = { type: "text" as const, text: result.text };
  if (!result.images?.length) return [text];
  if (!seesImages) return [text, { type: "text", text: "Picture not attached: this model can't see images." }];
  return [text, ...result.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }))];
}

/** What a bounded child is told when its report turn starts: without it a model mid-search calls tools again, they
 * are refused, and the run ends with no report at all. */
export function reportNowText(reason: string): string {
  return `${reason}. No more tool calls. Reply now with your report on what you found or did so far: start with "Partial:", give the evidence you have, then what you did not get to.`;
}

/** Tools whose output may hold a secret (see scrubToolOutput): native reads and shells, dev servers, pages, language servers. */
export const SCRUBBED_TOOLS: ReadonlySet<string> = new Set(["read", "bash", "powershell", "grep", "service", "browser", "lsp"]);

/** What the shell's optional step title asks of the model (decision 25 counts it): the screen shows it with the command. */
export const STEP_TITLE_HELP = "Optional title, at most 8 words, shown with the command (\"Run the unit tests\")";
/** A shell tool's parameters with the optional `description` step title. Display only: Pi runs the command as before,
 * and every check and approval reads the command, never the title. */
export function withStepTitle<P extends TProperties>(parameters: TObject<P>) {
  return Type.Object({ ...parameters.properties, description: Type.Optional(Type.String({ description: STEP_TITLE_HELP })) });
}
export const SCRUB_FAILED_TEXT = "Output not shown: Casper could not check it for device secrets. Try a smaller read or another command.";

/** The path context the file and command gates read. denyRead follows the app's current workspace when the
 * conversation supplies a reader for it (it outlives a rebind), and is read at each call. */
export function toolPathContext(root: string, home: string, agentDir: string | undefined, options: Pick<RuntimeStartOptions, "privatePaths" | "currentPrivatePaths">) {
  const context: { root: string; home: string; agentDir: string | undefined; readonly denyRead?: readonly string[] } = { root, home, agentDir };
  // A getter, defined directly: spreading an object with a getter would freeze its value at that moment.
  if (options.privatePaths?.length || options.currentPrivatePaths) {
    Object.defineProperty(context, "denyRead", { enumerable: true, get: () => options.currentPrivatePaths?.() ?? options.privatePaths ?? [] });
  }
  return context;
}

export class PiRuntime implements AgentRuntime {
  private runtime?: AgentSessionRuntime;
  private models?: PiModels;
  /** The session's model catalog, for adding a model server to it from /login. */
  private catalog?: ModelRuntime;
  private wrapper?: PiRuntimeSession;
  private readonly lifetime = new AbortController();
  private authWork?: Promise<RuntimeAuthenticationResult>;
  private readOnly = false;
  private starting = false;
  /** The session's home folder, where model defaults are kept. */
  private readonly home: string;

  constructor(options: { homeDir?: string } = {}) { this.home = options.homeDir ?? os.homedir(); }

  async authenticate(options: RuntimeAuthenticationOptions): Promise<RuntimeAuthenticationResult> {
    if (this.readOnly || this.starting || this.authWork || this.wrapper?.busy || this.models?.busy || this.lifetime.signal.aborted) {
      return { status: "failed", effect: "none", reason: "unavailable" };
    }
    this.models?.setAuthenticating(true);
    this.authWork = Promise.resolve().then(async (): Promise<RuntimeAuthenticationResult> => {
      // The /login list also adds a model server on another computer (no provider named, a main session only).
      const addServer = options.provider || this.readOnly ? undefined : async (display: LoginDisplay, signal: AbortSignal) => {
        const agentDir = getAgentDir();
        // Before a conversation, a catalog of what models.json and Pi know, only to check names and addresses.
        const catalog = this.catalog ?? await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), refreshOnCreate: false, allowModelNetwork: false, signal });
        return this.addServers(display, catalog);
      };
      const { provider, ...result } = await authenticatePi(options, path.resolve(getAgentDir(), "auth.json"), this.lifetime.signal, addServer);
      if ("servers" in result) return result;
      if (provider && (result.status === "saved" || result.status === "saved-needs-refresh" || ("effect" in result && result.effect === "unknown"))) {
        this.models?.invalidateAuth(provider);
        if (result.status === "saved" || result.status === "saved-needs-refresh") {
          const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : []), AbortSignal.timeout(15_000)]);
          const refreshed = this.models ? await this.models.refreshAuth(provider, signal) : result.status === "saved";
          return { status: refreshed ? "saved" : "saved-needs-refresh", ...result.claudeCode ? { claudeCode: true as const } : {} };
        }
      }
      return result;
    });
    try { return await this.authWork; }
    finally { this.authWork = undefined; this.models?.setAuthenticating(false); }
  }

  /** Casper's login file, read the way /login writes it: builtins only, no model catalog, no network. */
  private credentials(signal?: AbortSignal): Promise<ModelRuntime> {
    return ModelRuntime.create({ authPath: path.resolve(getAgentDir(), "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, signal });
  }

  /** Adding one of your model servers (the screens of src/runtime/add-model-server.ts), as /model and /login use it:
   * saved, and added to this catalog and the looks at once. Resolves with the names added. */
  async addServers(display: LoginDisplay, catalog: ModelRuntime): Promise<{ names: string[]; lines: string[] }> {
    const known = () => [...savedLocalServers().map((server) => ({ name: server.name, root: server.address })),
      ...catalog.getModels().filter((model) => typeof model.baseUrl === "string").map((model) => ({ name: model.provider, root: model.baseUrl.replace(/\/v1\/?$/, "") }))];
    const result = await addModelServers(display, { home: this.home, known,
      taken: () => new Set([...catalog.getProviders().map((provider) => provider.id), ...this.loginNames(), ...savedLocalServers().map((server) => server.name)]) });
    if (result.added.length) {
      const names = new Set(result.added.map(({ server }) => server.name));
      configureLocalServers({ saved: [...savedLocalServers().filter((server) => !names.has(server.name)), ...result.added.map(({ server }) => server)] });
      for (const { server, models: list } of result.added) {
        const found = { provider: server.name, name: serverLabel(server.kind, server.address), baseUrl: `${server.address}/v1`, models: list, saved: true as const };
        rememberLocalServer(found);
        registerLocalServers(catalog, [found]);
      }
    }
    // Found by itself on this computer (it may have started after Casper's first look): its models are usable now.
    for (const found of result.found ?? []) { rememberLocalServer(found); registerLocalServers(catalog, [found]); }
    return { names: result.added.map(({ server }) => server.name), lines: result.lines };
  }

  private modelServers(catalog: ModelRuntime, models: PiModels): ModelServerActions {
    return {
      rows: () => savedLocalServers().map((server) => {
        const problem = models.serverProblem(server.name);
        return { name: server.name, address: server.address, ...problem ? { problem } : {} };
      }),
      add: (io, signal) => withLoginDisplay(io, signal, async (display) => {
        const { names, lines } = await this.addServers(display, catalog);
        for (const line of lines) io.output.write(`[model] ${line}\n`);
        return { ...names[0] ? { name: names[0] } : {}, lines };
      }),
      forget: (name, io, signal) => withLoginDisplay(io, signal, async (display) => {
        const answer = await display.choose(`Forget ${name}?`, forgetServerChoices(name).map((label, index) => ({ id: String(index), label })));
        if (answer !== "1") { io.output.write(`[model] Kept ${name}.\n`); return [`Kept ${name}.`]; }
        await forgetModelServer(name, { home: this.home });
        configureLocalServers({ saved: savedLocalServers().filter((server) => server.name !== name) });
        forgetLocalServer(name);
        models.forgetServer(name);
        try { catalog.unregisterProvider(name); } catch { /* not registered (it never answered) */ }
        const onIt = this.runtime?.session.model?.provider === name;
        const said = `Forgot ${name}.${onIt ? " Your model was on it; pick another." : ""}`;
        io.output.write(`[model] ${said}\n`);
        return [said];
      }),
    };
  }

  /** The names in Casper's login file: any provider's sign-in and the web key. */
  private loginNames(): string[] {
    try {
      const data: unknown = JSON.parse(readFileSync(path.resolve(getAgentDir(), "auth.json"), "utf8").replace(/^\uFEFF/, ""));
      return data && typeof data === "object" ? Object.keys(data) : [];
    } catch { return []; }
  }

  async savedSignIns(signal?: AbortSignal): Promise<Array<{ provider: string; type: "api_key" | "oauth" }>> {
    const credentials = await (await this.credentials(signal)).listCredentials({ signal });
    return credentials.map((credential) => ({ provider: credential.providerId, type: credential.type }));
  }

  async signOut(provider: string, signal?: AbortSignal): Promise<boolean> {
    if (this.readOnly || this.authWork || this.wrapper?.busy || this.models?.busy) throw new Error("Wait for active work before signing out.");
    const runtime = await this.credentials(signal);
    if (!(await runtime.listCredentials({ signal })).some((credential) => credential.providerId === provider)) return false;
    try { await runtime.logout(provider, { signal }); }
    catch (error) {
      // Removed, but the snapshot of that runtime lagged: the live one is refreshed below. Never show SDK errors: they can hold the credential.
      if (!(error instanceof CredentialSynchronizationError)) throw new Error("Casper couldn't remove that sign-in; the login file is unchanged.");
    }
    this.models?.invalidateAuth(provider);
    await this.models?.refreshAuth(provider, AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)]));
    return true;
  }

  start(options: RuntimeStartOptions): Promise<RuntimeSession> {
    return this.create(options);
  }

  startReadOnly(options: RuntimeReadOnlyStartOptions): Promise<RuntimeSession> {
    for (const limit of [options.maxTurns, options.maxToolCalls]) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid read-only runtime budget");
    }
    this.readOnly = true;
    return this.create({ cwd: options.cwd, systemPromptAppend: options.systemPromptAppend,
      ...(options.scrubToolOutput ? { scrubToolOutput: options.scrubToolOutput } : {}),
      ...(options.privatePaths?.length ? { privatePaths: options.privatePaths } : {}) }, options, true);
  }

  startBuilder(options: RuntimeBuilderStartOptions): Promise<RuntimeSession> {
    for (const limit of [options.maxTurns, options.maxToolCalls]) {
      if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid builder runtime budget");
    }
    // A child: no sign-in from it, like a read-only one.
    this.readOnly = true;
    return this.create({ cwd: options.cwd, systemPromptAppend: options.systemPromptAppend, tools: [],
      ...(options.shell ? { shell: options.shell } : {}),
      ...(options.beforeToolGate ? { beforeToolGate: options.beforeToolGate } : {}),
      ...(options.beforeToolWait ? { beforeToolWait: options.beforeToolWait } : {}),
      ...(options.scrubToolOutput ? { scrubToolOutput: options.scrubToolOutput } : {}),
      ...(options.privatePaths?.length ? { privatePaths: options.privatePaths } : {}) }, options, false);
  }

  /** `bounded`: a child's run limits and signal; `readOnlyTools`: a read-only child (false: a crew builder). */
  private async create(options: RuntimeStartOptions, bounded?: RuntimeReadOnlyStartOptions | RuntimeBuilderStartOptions, readOnlyTools = false): Promise<RuntimeSession> {
    if (this.authWork || this.starting || this.lifetime.signal.aborted) throw new Error("Runtime is busy or closed.");
    this.starting = true;
    try { return await this.createSession(options, bounded, readOnlyTools); }
    finally { this.starting = false; }
  }

  private async createSession(options: RuntimeStartOptions, bounded: RuntimeReadOnlyStartOptions | RuntimeBuilderStartOptions | undefined, readOnlyTools: boolean): Promise<RuntimeSession> {
    if (this.runtime) throw new Error("Model runtime already started");
    bounded?.signal.throwIfAborted();
    const agentDir = getAgentDir();
    const readOnly = bounded && readOnlyTools ? bounded as RuntimeReadOnlyStartOptions : undefined;
    if (readOnly) await checkReadOnlyState(readOnly, agentDir);
    // Local model servers are probed in the background: the start never waits for them (a closed port can take
    // seconds on Windows). Only a model the start needs that is not in the catalog yet waits (PiModels.create).
    // A helper never probes: it gets what the main session found.
    // The main session says what the looks cover: the automatic servers (`localModels: false`: none) and the ones you
    // added.
    if (!bounded) configureLocalServers({ auto: options.localModels !== false, saved: options.modelServers ?? [] });
    const local = options.localModels === false && !savedLocalServers().length ? undefined : localServers({ cachedOnly: Boolean(bounded) });
    const modelRuntime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json`, signal: bounded?.signal });
    await registerClaudeSubscription(modelRuntime, () => this.runtime?.cwd ?? options.cwd);
    const models = this.models = new PiModels(modelRuntime, agentDir, this.home);
    if (!bounded) this.catalog = modelRuntime;
    if (local) {
      // The main session adds each server the moment its own look ends: one far away doesn't hold up one here.
      if (!bounded) {
        const stop = onLocalServer((server) => registerLocalServers(modelRuntime, [server]));
        this.lifetime.signal.addEventListener("abort", stop, { once: true });
      }
      models.useLocalServers({
        ready: local.then((found) => { registerLocalServers(modelRuntime, found.servers); dropLocalServers(modelRuntime, found.looked); return found; }),
        refresh: bounded ? undefined : async (signal) => {
          const found = await localServers({ refresh: true, signal });
          registerLocalServers(modelRuntime, found.servers);
          dropLocalServers(modelRuntime, found.looked);
          return found;
        },
        // What a wait was for is added to this catalog before going on: its server may have answered before this
        // runtime listened (a helper never does).
        settled: async (provider) => {
          const servers = provider ? [await localServerSettled(provider)] : await localServersHereSettled();
          registerLocalServers(modelRuntime, servers.filter((server) => server !== undefined));
        },
      });
    }
    if (!bounded) models.useModelServers(this.modelServers(modelRuntime, models));
    if (options.compactAt) models.useCompactAt(options.compactAt);
    const tools = new PiToolController(options.tools ?? []);
    const agentShellGuard = new AgentShellGuard(Boolean(bounded));
    let limitReason: string | undefined;
    let toolCalls = 0;
    let turns = 0;
    /** Set once to spend the single tool-free turn that lets a spent child hand back a report. */
    let wrapUp = false;
    /** Set by the caller near its deadline (RuntimeSession.wrapUp): the child's next tool call or turn ends its work. */
    let deadline: string | undefined;

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      bounded?.signal.throwIfAborted();
      // ~ in tool paths stays the real home: Pi's own file tools expand it with os.homedir(), and the checks must agree.
      const pathContext = toolPathContext(cwd, os.homedir(), agentDir, options);
      const checkChanges = new CheckChangeGuard(cwd, options.checkChanges);
      // Every tool's arguments get their shape repaired before Pi validates them (src/runtime/tool-repair.ts).
      const repair = new ToolArgumentRepair();
      const repairing = <D extends { name: string; parameters: unknown; prepareArguments?: (args: unknown) => unknown }>(definition: D): D =>
        ({ ...definition, prepareArguments: repair.hook(definition.name, definition.parameters, definition.prepareArguments) } as D);
      const toolRules = `Tool rules:\n${PI_TOOL_RULES.map((rule) => `- ${rule}`).join("\n")}`;
      const addendum = { full: [COMMAND_GUIDANCE, toolRules, SEARCH_GUIDANCE, AGENT_SHELL_GUIDANCE].join("\n\n"),
        lean: [LEAN_COMMAND_GUIDANCE, toolRules, LEAN_SEARCH_GUIDANCE, AGENT_SHELL_GUIDANCE].join("\n\n") };
      const extensionFactory = (pi: ExtensionAPI) => {
        // Tools may execute only after the entire response streams. Some providers also reuse a text block
        // across calls, so snapshot at toolcall_start, then bind the final call id at toolcall_end.
        const reasons = new Map<string, string>();
        const startingReasons = new Map<number, string>();
        let precedingText = "";
        pi.on("agent_start", () => { reasons.clear(); });
        pi.on("agent_end", () => { reasons.clear(); startingReasons.clear(); precedingText = ""; });
        pi.on("message_start", ({ message }) => {
          if (message.role === "assistant") { precedingText = ""; startingReasons.clear(); }
        });
        pi.on("message_update", ({ assistantMessageEvent: update }) => {
          if (update.type === "text_delta") precedingText = (precedingText + update.delta).slice(-65_536);
          else if (update.type === "toolcall_start") startingReasons.set(update.contentIndex,
            precedingText.split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "");
          else if (update.type === "toolcall_end") {
            reasons.set(update.toolCall.id, startingReasons.get(update.contentIndex) ?? "");
            startingReasons.delete(update.contentIndex);
          }
        });
        pi.on("tool_execution_end", ({ toolCallId }) => { reasons.delete(toolCallId); });
        // Project only Casper's wording, after Pi restores the prompt/tool state, for every model step.
        pi.on("context_with_system", (event, ctx) => ({ messages: projectGuidance(event.messages, ctx.model,
          (bounded?.guidance ?? options.guidance)?.(), tools.current(), { ...options, addendum }) }));
        // First, so a repair is tied to its call even when a later handler refuses the call.
        pi.on("tool_call", (event) => {
          repair.claim(event.toolName, event.toolCallId);
          // Before every path check, so they check the place the tool will open.
          const input = event.input as Record<string, unknown>;
          if (FILE_PATH_TOOLS.has(event.toolName) && typeof input.path === "string") input.path = shellTempPath(input.path);
        });
        // Runs after the runtime's own attribution, so Casper's identity replaces Pi's. With
        // CASPER_TELEMETRY=0 or telemetry: off there is none to add, and the runtime's is taken out too.
        pi.on("before_provider_headers", (event, ctx) => {
          if (isOpenRouterModel(ctx.model)) applyOpenRouterAttribution(event.headers);
          // A Claude plan sign-in names a Claude Code version; Anthropic refuses newer models to an old one.
          if (ctx.model?.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(ctx.model)) applyClaudeCodeVersion(event.headers);
        });
        if (bounded) pi.on("tool_call", (event) => {
          if (bounded.signal.aborted) {
            limitReason = "Subagent cancelled";
            return { block: true, reason: limitReason, terminate: true };
          }
          // The report turn is tool-free whichever budget ran out: the work is already spent.
          if (wrapUp) return { block: true, reason: limitReason ?? "Subagent budget exhausted", terminate: true };
          if (deadline) limitReason ??= deadline;
          if (deadline || ++toolCalls > bounded.maxToolCalls) {
            limitReason ??= `Stopped at its ${bounded.maxToolCalls}-tool-call limit`;
            // Before the report turn the child keeps the loop: cutting it off mid-investigation
            // returns nothing at all.
            return { block: true, reason: `${limitReason}; reply now with your findings and stop calling tools` };
          }
          // A builder's own gates run in the writable handler below.
          if (!readOnly) return;
          const pathReason = fileToolGate(event.toolName, event.input, pathContext);
          if (pathReason) return { block: true, reason: pathReason };
          const gateReason = readOnly.beforeToolGate?.(event.toolName, event.input, cwd);
          if (gateReason) return { block: true, reason: gateReason };
        });
        /** Allowed edits and writes outside the project, by tool call, for the receipt. */
        const outside = new Map<string, string>();
        if (!readOnly) pi.on("tool_call", async (event, ctx) => {
          // Keep Pi's native execution, output handling, and process-tree cleanup.
          // An omitted timeout stays omitted: casperBashOperations applies the default limit, and may move the command to the background.
          if (event.toolName === "bash" && typeof event.input.timeout === "number" && event.input.timeout > BASH_TIMEOUT_CAP_SECONDS) event.input.timeout = BASH_TIMEOUT_CAP_SECONDS;
          const agentReason = event.toolName === "powershell" && typeof event.input.command === "string" ? agentShellGuard.reason(event.input.command) : undefined;
          if (agentReason) return { block: true, reason: agentReason };
          const risky = event.toolName === "bash" && typeof event.input.command === "string" ? gitGuardReason(event.input.command) : undefined;
          if (risky) return { block: true, reason: risky };
          // Private files, git's own files and protected places, also where a link out of the project leads (see src/platform/project-paths.ts).
          const pathReason = fileToolGate(event.toolName, event.input, pathContext);
          if (pathReason) return { block: true, reason: pathReason };
          const gitInternals = (event.toolName === "bash" || event.toolName === "powershell") && typeof event.input.command === "string"
            ? gitInternalsCommand(event.input.command, cwd, pathContext.home) : undefined;
          if (gitInternals) return { block: true, reason: gitInternals };
          // ~/.ssh, ~/.aws ... named in a shell command: refused even with the sandbox off.
          const privateRead = (event.toolName === "bash" || event.toolName === "powershell") && typeof event.input.command === "string"
            ? privatePathCommand(event.input.command, pathContext) : undefined;
          if (privateRead) return { block: true, reason: privateRead };
          // Every tool, Casper's own and MCP tools too, so a plan turn can refuse anything that changes state.
          if (options.beforeToolGate) {
            const reason = options.beforeToolGate(event.toolName, event.input, cwd);
            if (reason) return { block: true, reason };
          }
          // An edit or write outside the project asks first (temp, caches and your allowWrite don't), after the
          // refusals above so a call refused anyway never asks.
          if ((event.toolName === "edit" || event.toolName === "write") && typeof event.input.path === "string" && options.shell?.outsideWrite) {
            const named = resolveToolPath(event.input.path, cwd, pathContext.home);
            const kind = classifyPath(named, pathContext, true);
            // A link out of the project is asked about where it leads.
            const absolute = kind === "linksOut" ? realpathLongest(named) : named;
            if (kind === "outside" || kind === "linksOut") {
              const reason = await options.shell.outsideWrite(absolute);
              if (reason) return { block: true, reason };
              outside.set(event.toolCallId, absolute);
            }
          }
          // Last, so a call refused above never waits on a question first.
          if (options.beforeToolWait) {
            const reason = await options.beforeToolWait(event.toolName, ctx.signal);
            if (reason) { outside.delete(event.toolCallId); return { block: true, reason, terminate: true }; }
          }
        });
        // The same read, grep, find or ls again with nothing changed: a note at the 3rd, skipped from the 5th. After the
        // gates above, since Pi stops at the first block: a skipped repeat still counts toward a subagent's limits and the spend pause.
        const loopGuard = new LoopGuard();
        pi.on("agent_start", () => loopGuard.reset());
        pi.on("tool_call", (event) => {
          const reason = loopGuard.before(event.toolCallId, event.toolName, event.input);
          if (reason) return { block: true, reason };
        });
        // After every refusal above: a refused call never waits. A picture the call would touch is finished first.
        const waitNotes = new Map<string, string[]>();
        if (options.beforeToolNotes) {
          pi.on("tool_call", async (event, ctx) => {
            const notes = await options.beforeToolNotes!(event.toolName, event.input, ctx.signal);
            if (notes.length) waitNotes.set(event.toolCallId, notes);
          });
          pi.on("tool_result", (event) => {
            const notes = waitNotes.get(event.toolCallId);
            waitNotes.delete(event.toolCallId);
            if (notes) return { content: [...event.content, ...notes.map((text) => ({ type: "text" as const, text }))] };
          });
        }
        if (!readOnly) pi.on("tool_result", (event) => {
          const absolute = outside.get(event.toolCallId);
          if (absolute === undefined) return;
          outside.delete(event.toolCallId);
          if (!event.isError) options.shell?.wroteOutside?.(absolute);
        });
        // The AI's bash: Casper's own operations (adapted from Pi's sandbox example), never a repo's .pi/sandbox.json.
        if (!readOnly) {
          const bash = createBashToolDefinition(cwd, {
            operations: casperBashOperations(options.shell, undefined, checkChanges, agentShellGuard),
            spawnHook: (context) => ({ ...context, env: withoutProviderKeys(context.env, options.shell?.keepEnv ?? []) }),
          });
          const execute: typeof bash.execute = (id, ...args) =>
            withToolReason(reasons.get(id) ?? "", () => bash.execute(id, ...args));
          pi.registerTool(repairing({ ...bash, parameters: withStepTitle(bash.parameters), execute }));
        }
        if (options.scrubToolOutput) pi.on("tool_result", async (event, ctx) => {
          if (!SCRUBBED_TOOLS.has(event.toolName)) return;
          const texts = event.content.flatMap((block) => block.type === "text" ? [block.text] : []);
          if (!texts.length) return;
          let scrubbed: Awaited<ReturnType<NonNullable<RuntimeStartOptions["scrubToolOutput"]>>>;
          // Pi passes the raw output on when a handler throws, so a failed check hides the output instead.
          try { scrubbed = await options.scrubToolOutput!(event.toolName, event.input, texts, ctx.signal); }
          catch { return { content: [{ type: "text" as const, text: SCRUB_FAILED_TEXT }] }; }
          if (!scrubbed) return;
          let index = 0;
          const content = event.content.map((block) => block.type === "text" ? { ...block, text: scrubbed.texts[index++] ?? "" } : block);
          return { content: scrubbed.note ? [...content, { type: "text" as const, text: scrubbed.note }] : content };
        });
        pi.on("tool_result", async (event, ctx) => {
          if (event.isError || (event.details && Reflect.get(event.details, "sessionOnlyCheck")) || !["edit", "write"].includes(event.toolName) || typeof event.input.path !== "string" || !options.afterFileEdit) return;
          const file = nativeEditPath(event.input.path);
          if (file === undefined) return;
          let text: string | undefined;
          try { text = await options.afterFileEdit(file, ctx.signal); }
          catch { text = "LSP diagnostics unavailable after edit; the file was written. Do not treat missing diagnostics as clean."; }
          if (text) return { content: [...event.content, { type: "text" as const, text }] };
        });
        // A write or edit that leaves "// ... existing code ..." where code was gets a note (src/runtime/elision.ts).
        const oldFiles = new Map<string, string | undefined>();
        pi.on("agent_start", () => oldFiles.clear());
        if (!readOnly) pi.on("tool_call", (event) => {
          if (event.toolName === "write" && typeof event.input.path === "string" && oldFiles.size < 64)
            oldFiles.set(event.toolCallId, readSmallText(resolveToolPath(event.input.path, cwd, pathContext.home)) ?? undefined);
        });
        if (!readOnly) pi.on("tool_result", (event) => {
          const oldFile = oldFiles.get(event.toolCallId);
          oldFiles.delete(event.toolCallId);
          if (event.isError || (event.details && Reflect.get(event.details, "sessionOnlyCheck"))) return;
          const texts = elisionTexts(event.toolName, event.input, oldFile);
          if (texts && newElisions(texts.before, texts.after).length) return { content: [...event.content, { type: "text" as const, text: ELISION_NOTE }] };
        });
        pi.on("tool_result", (event) => {
          const note = loopGuard.after(event.toolCallId, event.toolName, event.input,
            event.content.flatMap((block) => block.type === "text" ? [block.text] : []));
          if (note) return { content: [...event.content, { type: "text" as const, text: note }] };
        });
        pi.on("tool_result", (event) => {
          const note = repair.take(event.toolCallId);
          if (note) return { content: [...event.content, { type: "text" as const, text: note }] };
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
          prepareArguments: repair.hook(tool.name, tool.inputSchema, (args) => args as Record<string, unknown>),
          ...(tool.sequential ? { executionMode: "sequential" as const } : {}),
          execute: async (id, args, signal, _update, ctx) => {
            const result = await withToolReason(reasons.get(id) ?? "", () => tool.execute(args, signal, { withFileLocks }));
            if (result.isError) throw new Error(result.text);
            return { content: toolContent(result, Boolean(ctx?.model?.input?.includes("image"))), details: {} };
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
            } : bounded ? { noExtensions: true, noPromptTemplates: true, noThemes: true } : {}),
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
              COMMAND_GUIDANCE,
              toolRules,
              SEARCH_GUIDANCE,
              AGENT_SHELL_GUIDANCE,
            ],
          },
        });
        bounded?.signal.throwIfAborted();
        const created = await createAgentSessionFromServices({
          services, sessionManager, sessionStartEvent, model: modelOptions.model,
          // Pi's own file tools, made as Pi makes them, with the argument repair added.
          customTools: [
            createReadToolDefinition(cwd, { autoResizeImages: modelOptions.settingsManager.getImageAutoResize() }),
            ...guardedFileTools(cwd, checkChanges),
            createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd),
          ].map((definition) => repairing(definition) as unknown as ToolDefinition),
          ...(readOnly ? { tools: ["read", "grep", "find", "ls"] } : {}),
        });
        retryUpstreamErrors(created.session);
        if (bounded) {
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
            if (!limitReason && message.content.some((part) => part.type === "toolCall")) {
              limitReason = deadline ?? (turns >= bounded.maxTurns ? `Stopped at its ${bounded.maxTurns}-turn limit`
                : toolCalls >= bounded.maxToolCalls ? `Stopped at its ${bounded.maxToolCalls}-tool-call limit` : undefined);
            }
            if (bounded.signal.aborted) return { action: "end" };
            // A spent child gets exactly one tool-free turn to report what it already found, and is told so: a model
            // not told calls tools again, they are refused, and the caller receives an empty result.
            if (limitReason && bounded.reportTurn && !wrapUp) {
              wrapUp = true;
              created.session.agent.steer({ role: "user", content: [{ type: "text", text: reportNowText(limitReason) }], timestamp: Date.now() });
              return previous ?? undefined;
            }
            return limitReason ? { action: "end" } : previous ?? undefined;
          };
        }
        if (!readOnly) created.session.setActiveToolsByName([
          "read", "bash", "edit", "write", "grep", "find", "ls",
          ...tools.current().map((tool) => tool.name),
        ]);
        return { ...created, services, diagnostics: services.diagnostics };
      };
      return models.create(cwd, sessionManager, build, bounded && { ...(readOnly?.modelRole ? { modelRole: readOnly.modelRole } : {}),
        ...(readOnly?.keepEffort ? { keepEffort: true } : {}), ...(bounded.sessionModel ? { sessionModel: bounded.sessionModel } : {}), compact: !readOnlyTools });
    };

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: options.cwd,
      agentDir,
      sessionManager: bounded ? SessionManager.inMemory(options.cwd) : SessionManager.create(options.cwd),
    });
    this.wrapper = new PiRuntimeSession(this.runtime, tools, models, bounded ? { options: bounded, limitReason: () => limitReason, wrapUp: (reason) => { deadline ??= reason; } } : undefined,
      bounded ? (bounded.cache === "off" ? "off" : "short") : options.cache, bounded?.hideToolOutput ?? options.hideToolOutput, agentShellGuard);
    return this.wrapper;
  }

  async dispose(): Promise<void> {
    this.lifetime.abort();
    await this.wrapper?.abort();
    await this.authWork;
    await this.models?.close(); this.models = undefined; this.catalog = undefined;
    this.wrapper?.detach();
    this.wrapper = undefined;
    const runtime = this.runtime;
    this.runtime = undefined;
    await runtime?.dispose();
  }
}

/** A file's text for a +N -M count: undefined when absent (a new file), null when unreadable or over 1 MiB. */
function readSmallText(file: string): string | undefined | null {
  try {
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.size > 1024 * 1024) return null;
    return readFileSync(file, "utf8");
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null; }
}

/** Added to a finished command's output when what it started could not be confirmed stopped. */
export const CLEANUP_NOTE = "[The command finished, but Casper could not confirm that every process it started has stopped. Casper shows them to the person before the next task.]";

/**
 * Pi's own local bash execution with Casper's shell around it: a question first when no sandbox can run, the
 * sandbox's wrapper when one does, and the sandbox's refusal added to the output the AI reads ("[sandbox] blocked:
 * wanted to write /etc/hosts") so it stops retrying. Pi writes the full output of a long command to a temp file;
 * that file goes in a private folder of Casper's (os.tmpdir() is read at that moment), not the shared temp folder.
 * A command run without its own timeout gets the default limit; with slow commands on, one still running then moves
 * to the shell's background commands (same process, same sandbox wrap) and the call returns its output so far.
 * Such a command that stalls (no output and no CPU for a while, src/runtime/stalled-commands.ts) is ended, in the
 * foreground or the background, with the reason added to its output.
 */
export function casperBashOperations(shell: RuntimeShell | undefined, local: BashOperations = createOwnedBashOperations(), checkChanges?: CheckChangeGuard, agentGuard = new AgentShellGuard()): BashOperations {
  return {
    async exec(command, cwd, options) {
      const agentReason = agentGuard.reason(command);
      if (agentReason) throw new Error(agentReason);
      const checkReason = await checkChanges?.shellReason(command);
      if (checkReason) throw new Error(checkReason);
      const refused = await shell?.approve?.(command, options.signal);
      if (refused) throw new Error(refused);
      const logDir = process.platform === "win32" ? undefined : await shell?.logDir?.();
      const wrapped: Awaited<ReturnType<RuntimeShell["wrap"]>> = shell ? await shell.wrap(command, cwd) : { command };
      const background = options.timeout === undefined ? shell?.background?.() : undefined;
      const limit = options.timeout ?? background?.limitSeconds ?? DEFAULT_COMMAND_LIMIT_SECONDS;
      const startedAt = Date.now();
      let tail = "", seen = "", recent = "", stalled: string | undefined;
      /** Once in the background, its output goes there. */
      let moved: ((data: Buffer) => void) | undefined;
      // Not for a command given its own timeout, nor one on Casper's ssh login (the other machine's work can't be seen).
      const stallSeconds = options.timeout === undefined && !wrapped.ssh ? shell?.stallSeconds?.() : undefined;
      const pid = stallSeconds ? pidFile(logDir) : undefined;
      const watch = stallSeconds && pid ? watchStall({ seconds: stallSeconds, root: pid.root, onStall: () => {
        stalled = stalledMessage(command, recent, stallSeconds);
        stop.abort();
      } }) : undefined;
      const onData = (data: Buffer) => {
        if (wrapped.id || wrapped.ssh?.afterAuthFail) tail = (tail + data.toString("utf8")).slice(-16_384);
        if (watch) { watch.output(); recent = (recent + data.toString("utf8")).slice(-4_096); }
        if (moved) { moved(data); return; }
        if (background) seen = (seen + data.toString("utf8")).slice(-16_384);
        if (!logDir) { options.onData(data); return; }
        const previous = process.env.TMPDIR;
        process.env.TMPDIR = logDir;
        try { options.onData(data); }
        finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
      };
      // The turn's stop reaches the command only until it moves to the background.
      const stop = new AbortController();
      const forward = () => stop.abort();
      if (options.signal?.aborted) stop.abort();
      else options.signal?.addEventListener("abort", forward, { once: true });
      const run = (async () => {
        try {
          // The private ssh login's pointer goes to this one command, after the shell's environment was cleaned.
          const env = wrapped.ssh?.env || wrapped.env
            ? { ...(options.env ?? withoutProviderKeys(process.env, shell?.keepEnv ?? [])), ...wrapped.env, ...wrapped.ssh?.env } : options.env;
          let result: { exitCode: number | null };
          try {
            result = await local.exec(pid ? pid.run(wrapped.command) : wrapped.command, cwd, { ...options, signal: stop.signal, timeout: background ? undefined : limit, ...(env ? { env } : {}), onData });
          } catch (error) {
            if (error instanceof ProcessCleanupError) {
              shell?.onCleanupFailure?.(error);
              // A command that finished keeps its output and exit code; the processes it left are a note.
              if (error.exitCode === undefined || stalled) throw error;
              onData(Buffer.from(`\n${CLEANUP_NOTE}\n`));
              result = { exitCode: error.exitCode };
            } else {
              if (!stalled) throw error;
              watch?.stop();
              onData(Buffer.from(stalled));
              result = { exitCode: STALLED_EXIT_CODE };
            }
          }
          agentGuard.finished(command, result.exitCode);
          if (wrapped.id && result.exitCode !== 0 && shell?.refused) {
            const line = await shell.refused(wrapped.id, tail);
            if (line) onData(Buffer.from(`\n${line}\n`));
          }
          if (wrapped.ssh?.afterFail && result.exitCode !== 0) onData(Buffer.from(`\n${wrapped.ssh.afterFail}\n`));
          // Not only on a failure: `ssh host cmd; echo done` ends 0 although the login was refused.
          const refusedLogin = Boolean(wrapped.ssh?.afterAuthFail) && looksLikeRefusedLogin(tail);
          if (refusedLogin) onData(Buffer.from(`\n${wrapped.ssh!.afterAuthFail}\n`));
          // The remote command may fail after a login that worked; the AI still learns how it logged in.
          const loggedIn = refusedLogin ? undefined : wrapped.ssh?.afterSuccess?.();
          if (loggedIn) onData(Buffer.from(`\n${loggedIn}\n`));
          return result;
        } finally {
          watch?.stop();
          pid?.remove();
          options.signal?.removeEventListener("abort", forward);
          if (wrapped.id) shell?.finished?.(wrapped.id);
          await wrapped.ssh?.done?.().catch(() => {});
        }
      })();
      if (!background) return await run;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), limit * 1000); });
      const first = await Promise.race([run, late]).finally(() => clearTimeout(timer));
      if (first !== "late") return first;
      options.signal?.removeEventListener("abort", forward);
      const handed = options.signal?.aborted ? undefined
        : background.adopt({ command, startedAt, output: seen, done: run, stop: () => stop.abort(), ...(logDir ? { logDir } : {}) });
      if (!handed) {
        stop.abort();
        await run.catch(error => { if (error instanceof ProcessCleanupError) throw error; });
        if (options.signal?.aborted) throw new Error("aborted");
        onData(Buffer.from(`\n[Stopped at the limit: ${background.max} slow commands already run in the background.]\n`));
        throw new Error(`timeout:${limit}`);
      }
      onData(Buffer.from(`\n[Still running after ${limit} s, so it moved to the background as ${handed.id} (stdin closed). `
        + `Casper adds a note when it ends.${handed.log ? ` Its output goes on in ${handed.log}.` : ""} To stop it: the service tool (stop, service ${handed.id}) when you have it; the person can use /tasks.]\n`));
      moved = handed.write;
      return { exitCode: 0 };
    },
  };
}
