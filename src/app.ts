import { execFile } from "node:child_process";
import type { DebugRequest, DebugSession } from "./debug/session";
import { promisify } from "node:util";
import os from "node:os";
import { modelPreference } from "./tui/model-preference";
import { HELP_TEXT, FULL_HELP_TEXT, LOGIN_HELP } from "./tui/help";
import { BrowserSession } from "./browser/session";
import { browserTool } from "./browser/tools";
import { formatTerminalJSON } from "./tui/json";
import { InteractiveTerminal } from "./tui/terminal";
import { pickEffort } from "./tui/effort-picker";
import { formatRuntimeStatus, formatToolActivity, redactPreview, terminalText } from "./tui/format";
import { ProjectMemory, type TaskOutcome } from "./memory/store";
import { discoverReferenceConfiguration, type ReferenceConfiguration } from "./references/config";
import { formatReferenceResult, ReferenceLibrary } from "./references/library";
import { formatSubagentReport, SubagentManager, type SubagentRole } from "./agents/manager";
import { discoverLSPConfiguration, type LSPConfiguration } from "./lsp/config";
import { LSPManager, type ConfirmRename } from "./lsp/manager";
import { lspTools } from "./lsp/tools";
import { boundCapabilityResult } from "./capabilities/result";
import { discoverMCPConfiguration, type MCPConfiguration } from "./mcp/config";
import { MCPManager } from "./mcp/manager";
import { CapabilityBroker, type ConfirmCapability } from "./capabilities/broker";
import type { Readable } from "node:stream";
import {
  formatProjectContext,
  loadProjectContext,
  type ProjectContext,
} from "./project/context";
import { inspectProject, type ProjectInfo } from "./project/inspect";
import type {
  AgentRuntime,
  RuntimeEvent,
  RuntimeSession,
  RuntimeTool,
} from "./runtime/types";
import { SkillRegistry, formatSelectedSkills } from "./skills/registry";
import { classifyTask, formatTaskPrompt } from "./task/classify";
import { formatTaskResult, type TaskResult } from "./task/result";
import { TaskObservations } from "./task/observations";
import { diffSnapshots, snapshotTree, type TreeChanges } from "./task/changes";
import { renderBanner, renderProjectSummary } from "./tui/banner";
import type { ProjectCommand } from "./project/model";
import { CHECK_NAMES, formatVerificationReport, formatVerificationResult, type VerificationReport } from "./verify/evidence";
import { ProcessCleanupError } from "./platform/processes";
import { VerifierRegistry } from "./verify/registry";
import { verifyAndRepair } from "./verify/repair-loop";
import { VerificationTask } from "./verify/task";
import { MermaidProvider } from "./visualize/mermaid";
import { MindMeshProvider } from "./visualize/mindmesh";
import { buildRepoGraph } from "./visualize/repo";
import { VisualizationRouter } from "./visualize/router";
import { artifactFilesystemSupported } from "./visualize/artifacts";
import { describeVisualization, visualizationTools } from "./visualize/tools";
import type { VisualizationProvider } from "./visualize/types";
import { SessionWorkspaceManager, type ReturnAction } from "./sessions/manager";

export interface OutputWriter {
  write(text: string): void;
}

export interface CasperAppOptions {
  runtimeFactory?: () => AgentRuntime | Promise<AgentRuntime>;
  /** Fresh child runtime per invocation; must implement startReadOnly. Never reuse the main runtime. */
  subagentRuntimeFactory?: () => AgentRuntime | Promise<AgentRuntime>;
  inspectProject?: (cwd: string) => Promise<ProjectInfo>;
  loadProjectContext?: (project: ProjectInfo) => Promise<ProjectContext>;
  loadSkillRegistry?: (context: ProjectContext) => Promise<SkillRegistry>;
  loadMCPConfiguration?: (context: ProjectContext) => Promise<MCPConfiguration>;
  loadLSPConfiguration?: (context: ProjectContext) => Promise<LSPConfiguration>;
  loadReferenceConfiguration?: (context: ProjectContext) => Promise<ReferenceConfiguration>;
  /** Override the built-in Mermaid/MindMesh providers (tests, extensions). */
  visualizationProviders?: VisualizationProvider[];
  /** Override ~/.casper for named-session/worktree state (primarily tests/embedders). */
  sessionHomeDir?: string;
  output?: OutputWriter;
  input?: Readable;
  /** Opt in to model-selected casper_check calls and bounded post-task repair. */
  autoVerify?: boolean;
}

const DEFAULT_SYSTEM_PROMPT_APPEND = [
  "You are Casper, a coding companion running through a thin runtime adapter.",
  "Be concise.",
  "Use available tools when needed to inspect, edit, and run code in the current repository.",
].join("\n");

export class CasperApp {
  private readonly runtimeFactory: () => AgentRuntime | Promise<AgentRuntime>;
  private readonly subagents: SubagentManager;
  private subagentsClose?: Promise<void>;
  private readonly inspectProjectFn: (cwd: string) => Promise<ProjectInfo>;
  private readonly loadProjectContextFn: (project: ProjectInfo) => Promise<ProjectContext>;
  private readonly loadSkillRegistryFn: (context: ProjectContext) => Promise<SkillRegistry>;
  private readonly loadMCPConfigurationFn: (context: ProjectContext) => Promise<MCPConfiguration>;
  private readonly loadLSPConfigurationFn: (context: ProjectContext) => Promise<LSPConfiguration>;
  private readonly loadReferenceConfigurationFn: (context: ProjectContext) => Promise<ReferenceConfiguration>;
  private browser?: BrowserSession;
  private browserClose?: Promise<void>;
  private debugSession?: DebugSession;
  private debugClose?: Promise<void>;
  private references?: ReferenceLibrary;
  private referencesClose?: Promise<void>;
  private lsp?: LSPManager;
  private lspClose?: Promise<void>;
  private visualization?: VisualizationRouter;
  private visualizationAbort?: AbortController;
  private visualizationWork?: Promise<void>;
  private readonly visualizationProviders: VisualizationProvider[];
  private mcp?: MCPManager;
  private broker?: CapabilityBroker;
  private runtimeTools: RuntimeTool[] = [];
  private mcpClose?: Promise<void>;
  private readonly terminal: InteractiveTerminal;
  private interactive = false;
  private cancelBeforeCommand = false;
  private commandAbort?: AbortController;
  private readonly toolStarted = new Map<string, number>();
  private readonly output: OutputWriter;
  private readonly input: Readable;
  private runtime?: AgentRuntime;
  private runtimeLoad?: Promise<AgentRuntime>;
  private runtimeStart?: Promise<RuntimeSession>;
  private session?: RuntimeSession;
  private closing = false;
  private closeWork?: Promise<void>;
  private unsubscribe?: () => void;
  private projectContext?: ProjectContext;
  private skillRegistry?: SkillRegistry;
  private readonly reportedSkillWarnings = new Set<string>();
  private endedWithNewline = true;
  private readonly autoVerify: boolean;
  private verificationAbort?: AbortController;
  private verificationWork?: Promise<VerificationReport>;
  /** Active repair evidence; sharing it does not grant managed-tool consent. */
  private verificationTask?: VerificationTask;
  private checkTask?: VerificationTask;
  private readonly sessionHomeDir?: string;
  private sessionWorkspace?: SessionWorkspaceManager;
  private sessionWorkspaceStart?: Promise<SessionWorkspaceManager>;
  private lastTaskRequest?: string;
  private commandActive = false;
  private workspaceTransition = false;
  private workspaceNeedsRebind = false;
  private taskRuntimeFailed = false;
  private displayedError?: string;
  private cleanupError?: ProcessCleanupError;
  private readonly blockOnCleanupFailure = () => {
    this.cleanupError = new ProcessCleanupError();
    this.commandAbort?.abort(); this.verificationAbort?.abort(); this.checkTask?.abort();
    void this.session?.abort().catch(() => {});
  };
  private savedModelDisplay?: string;
  private taskRuntimeCancelled = false;
  private lastTaskResult?: TaskResult;
  private observations = new TaskObservations();
  private memoryWork?: Promise<void>;

  constructor(options: CasperAppOptions = {}) {
    const freshPiRuntime = async () => {
      const { PiRuntime } = await import("./runtime/pi");
      return new PiRuntime();
    };
    this.runtimeFactory = options.runtimeFactory ?? freshPiRuntime;
    this.subagents = new SubagentManager({ runtimeFactory: async () => {
      if (this.workspaceTransition || this.workspaceNeedsRebind) throw new Error("Workspace transition is in progress; delegation is blocked");
      const child = await (options.subagentRuntimeFactory ?? freshPiRuntime)();
      if (child === this.runtime) throw new Error("The main runtime cannot be reused as a subagent");
      return child;
    } });
    this.inspectProjectFn = options.inspectProject ?? inspectProject;
    this.loadProjectContextFn = options.loadProjectContext ?? loadProjectContext;
    this.loadSkillRegistryFn = options.loadSkillRegistry ?? ((context) => SkillRegistry.discover({
      projectRoot: context.info.root,
      maxActive: context.skills.maxActive,
      imports: context.skills.imports,
    }));
    this.loadMCPConfigurationFn = options.loadMCPConfiguration ?? ((context) => discoverMCPConfiguration({
      projectRoot: context.info.root, profileName: context.profileName,
    }));
    this.loadLSPConfigurationFn = options.loadLSPConfiguration ?? ((context) => discoverLSPConfiguration({
      projectRoot: context.info.root, profileName: context.profileName,
    }));
    this.loadReferenceConfigurationFn = options.loadReferenceConfiguration ?? ((context) => discoverReferenceConfiguration({
      profileName: context.profileName,
    }));
    this.input = options.input ?? process.stdin;
    this.terminal = new InteractiveTerminal(this.input, options.output ?? process.stdout,
      () => this.cancelCurrent(), () => { if (this.commandActive && !this.closing) void this.close(); });
    this.output = { write: (text) => this.terminal.write(text) };
    this.autoVerify = options.autoVerify ?? false;
    this.visualizationProviders = options.visualizationProviders ?? [new MermaidProvider(), new MindMeshProvider()];
    this.sessionHomeDir = options.sessionHomeDir;
  }

  /** Load all workspace metadata before publishing it. No connections or model startup. */
  private async loadWorkspace(cwd: string) {
    const project = await this.inspectProjectFn(cwd);
    const context = await this.loadProjectContextFn(project);
    const [registry, mcpConfiguration, lspConfiguration, referenceConfiguration] = await Promise.all([
      this.loadSkillRegistryFn(context),
      this.loadMCPConfigurationFn(context),
      this.loadLSPConfigurationFn(context),
      this.loadReferenceConfigurationFn(context),
    ]);
    if (this.closing) throw new Error("Casper is closing");
    this.references = new ReferenceLibrary(referenceConfiguration);
    this.projectContext = context;
    this.skillRegistry = registry;
    this.mcp = new MCPManager(mcpConfiguration);
    this.lsp = new LSPManager(context.info.root, lspConfiguration);
    this.visualization = new VisualizationRouter({ providers: this.visualizationProviders, settings: context.visualize, workspaceRoot: context.info.root });
    this.broker = new CapabilityBroker(this.mcp, (call, signal) => this.confirmCapability(call, signal));
    return { project, context, registry, mcp: this.mcp, visualization: this.visualization, lspConfiguration, referenceConfiguration };
  }

  async start(cwd = process.cwd()): Promise<ProjectInfo> {
    if (this.closing) throw new Error("Casper is closing");
    if (this.projectContext) return this.projectContext.info;
    const { project, context, mcp, visualization, lspConfiguration, referenceConfiguration } = await this.loadWorkspace(cwd);
    if (this.closing) throw new Error("Casper is closing");
    this.output.write(renderBanner(context));
    this.output.write(`${formatRuntimeStatus(this.session?.getStatus?.())}\n`);
    for (const diagnostic of referenceConfiguration.diagnostics) this.output.write(`[references] ${formatReferenceResult(diagnostic)}\n`);
    this.reportSkillWarnings();
    for (const diagnostic of mcp.diagnostics) this.output.write(`[mcp] ${diagnostic}\n`);
    for (const diagnostic of lspConfiguration.diagnostics) this.output.write(`[lsp] ${diagnostic}\n`);
    for (const diagnostic of visualization.diagnostics) this.output.write(`[visualize] ${diagnostic}\n`);
    return project;
  }

  /** Last normal coding/chat request; local commands clear it. Not acceptance evidence. */
  getLastTaskResult(): TaskResult | undefined {
    return this.lastTaskResult ? structuredClone(this.lastTaskResult) : undefined;
  }

  async runOnce(prompt: string, cwd = process.cwd()): Promise<VerificationReport | undefined> {
    if (!this.projectContext) {
      await this.start(cwd);
    }

    this.writePrompt(/^\s*\/login(?:\s|$)/.test(prompt) ? "/login" : prompt);
    return this.handlePrompt(prompt.trim());
  }

  async runInteractive(cwd = process.cwd()): Promise<void> {
    // Own the terminal before the banner so startup output is transcript, not
    // loose text a later redraw would drop.
    this.interactive = true;
    this.terminal.start();
    if (!this.projectContext) {
      await this.start(cwd);
    }

    this.savedModelDisplay = await modelPreference(this.sessionHomeDir ?? os.homedir());
    this.updateFooter();
    while (!this.closing) {
      this.cancelBeforeCommand = false;
      this.updateFooter();
      const line = await this.terminal.readCommand();
      if (line === undefined) break;
      if (this.cancelBeforeCommand) {
        this.output.write("[cancel] Request cancelled before startup.\n");
        continue;
      }
      const prompt = line.trim();

      if (!prompt) {
        continue;
      }

      if (prompt === "/quit" || prompt === "/exit") {
        break;
      }

      try { await this.handlePrompt(prompt); }
      catch (error) {
        if (this.closing) break;
        this.ensureLineBreak();
        const message = error instanceof Error ? error.message : String(error);
        if (!this.commandAbort?.signal.aborted && this.displayedError !== message) this.output.write(`[error] ${message}\n`);
      }
    }
    this.terminal.close();
    this.interactive = false;
  }

  /** OS SIGINT and terminal Ctrl-C share cancellation, without disposing the session. */
  interrupt(): boolean {
    if (!this.interactive) return false;
    this.terminal.interrupt();
    return true;
  }

  private cancelCurrent(): void {
    if (!this.commandActive) { this.cancelBeforeCommand = true; return; }
    if (this.commandAbort?.signal.aborted) return;
    this.commandAbort?.abort();
    this.taskRuntimeCancelled = true;
    this.debugClose = this.debugSession?.close();
    void this.debugClose?.catch(() => {});
    this.browserClose = this.browser?.close();
    void this.browserClose?.catch(() => {});
    this.verificationAbort?.abort(); this.checkTask?.abort(); this.visualizationAbort?.abort();
    void this.session?.abort().catch(() => {});
    this.terminal.endAssistant();
    this.output.write("[cancel] Cancelling active work; changes already made are retained.\n");
  }

  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closing = true;
    this.commandAbort?.abort();
    this.verificationAbort?.abort();
    this.checkTask?.abort();
    this.visualizationAbort?.abort();
    this.subagentsClose = this.subagents.close();
    this.mcpClose = this.broker?.close();
    this.lspClose = this.lsp?.close();
    this.referencesClose = this.references?.close();
    this.debugClose = this.debugSession?.close();
    this.browserClose = this.browser?.close();
    // These close concurrently while runtime/verification drain. Observe early
    // rejections now; finishClose still awaits and propagates their results.
    for (const work of [this.mcpClose, this.lspClose, this.referencesClose, this.debugClose, this.browserClose]) void work?.catch(() => {});
    this.terminal.close();
    this.closeWork = this.finishClose();
    return this.closeWork;
  }

  private async finishClose(): Promise<void> {
    // Startup may still be in flight when termination arrives. Drain it before
    // disposing, but leave a startup error with its original prompt caller.
    await this.runtimeLoad?.catch(() => {});
    await this.runtimeStart?.catch(() => {});
    try {
      await this.session?.abort();
    } finally {
      try {
        await this.visualizationWork?.catch(() => {});
        await this.verificationWork;
        await this.checkTask?.close();
        await this.memoryWork;
      } finally {
        this.unsubscribe?.();
        this.terminal.close();
        try { await this.runtime?.dispose(); }
        finally { await Promise.all([this.mcpClose, this.lspClose, this.subagentsClose, this.referencesClose, this.browserClose, this.debugClose]); }
      }
    }
  }

  /** One adapter-construction owner, shared by auth and session startup. */
  private acquireRuntime(): Promise<AgentRuntime> {
    if (!this.runtimeLoad) this.runtimeLoad = Promise.resolve().then(async () => {
      if (this.closing) throw new Error("Casper is closing");
      this.runtime = await this.runtimeFactory();
      if (this.closing) throw new Error("Casper is closing");
      return this.runtime;
    }).catch((error) => { if (!this.closing) this.runtimeLoad = undefined; throw error; });
    return this.runtimeLoad;
  }

  private async ensureRuntime(): Promise<RuntimeSession> {
    if (this.closing) throw new Error("Casper is closing");
    if (this.session) return this.session;
    if (!this.runtimeStart) {
      const context = this.projectContext!;
      // Record the whole load/start operation before invoking the factory, so
      // close() also drains a lazy SDK import and prevents post-shutdown start.
      this.runtimeStart = Promise.resolve().then(async () => {
        if (this.closing) throw new Error("Casper is closing");
        this.runtime = await this.acquireRuntime();
        if (this.closing) throw new Error("Casper is closing");
        this.session = await this.runtime.start({
          cwd: context.info.root,
          tools: this.runtimeTools,
          afterFileEdit: async (file, signal) => {
            this.observeEdit(file);
            const reports = await this.lsp!.afterEdit(file, signal);
            return reports.length ? `LSP diagnostics after edit: ${JSON.stringify(boundCapabilityResult(reports))}\nRepair new errors before continuing; unavailable or unversioned reports are not proof of a clean file.` : undefined;
          },
          systemPromptAppend: [DEFAULT_SYSTEM_PROMPT_APPEND, formatProjectContext(context)].join("\n\n"),
        });
        await (await this.ensureSessionWorkspace()).resumeActive(this.session);
        this.unsubscribe = this.session.subscribe((event) => this.handleRuntimeEvent(event));
        const status = this.session.getStatus?.() ?? { auth: "unknown" as const };
        if (!status.blocked) this.output.write(`${formatRuntimeStatus(status)}\n`);
        this.updateFooter();
        return this.session;
      }).catch(async (error) => {
        if (!this.closing) {
          const failedRuntime = this.runtime;
          this.runtime = undefined;
          this.runtimeLoad = undefined;
          this.session = undefined;
          await failedRuntime?.dispose().catch(() => {});
        }
        throw error;
      }).finally(() => {
        if (!this.session) this.runtimeStart = undefined;
      });
    }
    return this.runtimeStart;
  }

  private async handlePrompt(prompt: string): Promise<VerificationReport | undefined> {
    if (this.closing) return;
    if (this.commandActive) throw new Error("Another command is active; wait for active subagents or workspace transition");
    // Keep local status/help and cleanup available, but never forget an uncertain
    // tree just because its originating command or model tool has finished.
    if (!/^\/(?:help(?: all)?|status|project|permissions|mcp|lsp|browser|debug|exit|quit|browser close|debug stop)$/.test(prompt)
      && !/^\/(?:mcp|lsp) disconnect\s/.test(prompt)) {
      if (this.cleanupError) throw this.cleanupError;
      this.browser?.assertCleanup(); this.mcp?.assertCleanup(); this.lsp?.assertCleanup();
    }
    const transition = /^\/(?:branch|switch)(?:\s|$)/.test(prompt);
    if (transition && this.subagents.isBusy) throw new Error("Wait for active subagents before changing workspaces");
    this.lastTaskResult = undefined;
    this.taskRuntimeFailed = false;
    this.displayedError = undefined;
    this.taskRuntimeCancelled = false;
    this.commandActive = true;
    this.commandAbort = new AbortController();
    this.updateFooter();
    this.workspaceTransition = transition;
    try {
      if (this.workspaceNeedsRebind) await this.rebindWorkspace(this.activeWorkspaceRoot());
      return await (prompt.startsWith("/") ? this.handleSlashCommand(prompt) : this.runModelTask(prompt));
    } catch (error) {
      if (error instanceof ProcessCleanupError) this.cleanupError = error;
      throw error;
    } finally {
      try {
        await this.checkTask?.close();
        if (!prompt.startsWith("/")) await this.browser?.close();
      } catch (error) {
        if (error instanceof ProcessCleanupError) this.cleanupError = error;
        throw error;
      } finally {
        this.checkTask = undefined;
        this.commandActive = false;
        this.workspaceTransition = false;
        this.updateFooter();
      }
    }
  }

  private async handleSlashCommand(prompt: string): Promise<VerificationReport | undefined> {
    if (this.closing) return;
    if (prompt === "/help" || prompt === "/help all") {
      this.output.write(prompt === "/help" ? HELP_TEXT : FULL_HELP_TEXT);
      return;
    }
    if (/^\/login(?:\s|$)/.test(prompt)) {
      const argument = prompt.slice(6).trim();
      const provider = (["openai-codex", "github-copilot", "anthropic", "openrouter"] as const).find(id => id === argument);
      if (argument && !provider) {
        this.output.write("Usage: /login [openai-codex|github-copilot|anthropic|openrouter]\n"); return;
      }
      const host = this.interactive ? this.terminal.exclusiveHost() : undefined;
      if (!host) { this.output.write(LOGIN_HELP); return; }
      if (this.subagents.isBusy) throw new Error("Wait for active subagents before login.");
      try {
        const runtime = await this.acquireRuntime();
        this.commandAbort?.signal.throwIfAborted();
        if (!runtime.authenticate) { this.output.write("[login] This runtime does not support login.\n"); return; }
        const result = await runtime.authenticate({ provider,
          terminalHost: host, signal: this.commandAbort?.signal });
        if (result.status === "saved") this.output.write("[login] Credential saved. Local auth refreshed; not a connection test. Model and defaults unchanged. Use /model to choose a model.\n");
        else if (result.status === "saved-needs-refresh") this.output.write("[login] Credential saved, but local auth needs refresh. Restart Casper; do not repeat login blindly.\n");
        else if ("effect" in result && result.effect === "unknown") this.output.write("[login] Login ended; credential save outcome unknown. Restart and inspect local auth before retrying.\n");
        else if (result.status === "cancelled") this.output.write("[login] Cancelled; no credential saved.\n");
        else this.output.write(result.reason === "destination"
          ? "[login] Unsafe credential destination. Requires a private, owner-held regular file in real directories; no permissions were repaired.\n"
          : "[login] Login unavailable or failed. No credential saved. Disable PI_TUI_WRITE_LOG if set. Check provider eligibility and loopback callback availability; no automatic method fallback.\n");
      } catch { this.output.write("[login] Login could not complete. No provider diagnostics are displayed.\n"); }
      return;
    }
    if (/^\/model(?:\s|$)/.test(prompt)) {
      if (this.subagents.isBusy) throw new Error("Wait for active subagents before changing models.");
      const session = await this.ensureRuntime();
      this.commandAbort?.signal.throwIfAborted();
      if (!session.selectModel) throw new Error("This runtime does not support model selection.");
      const argument = prompt.slice(6).trim();
      const sessionOnly = /^--session(?:\s|$)/.test(argument);
      const result = await session.selectModel({ query: (sessionOnly ? argument.slice(9).trim() : argument) || undefined,
        persist: !sessionOnly, signal: this.commandAbort?.signal,
        picker: this.interactive ? this.terminal.modelPickerHost() : undefined });
      // A cancelled picker changes nothing; the status block was already shown at startup.
      if (!result.selected && !result.models) { this.output.write("[model] Selection cancelled; model unchanged.\n"); return; }
      this.output.write(`${formatRuntimeStatus(result.status)}\n`);
      if (result.selected) this.output.write(result.savedDefault
        ? "[model] Selected and saved as the Casper default for new conversations. Shared Pi settings unchanged.\n"
        : "[model] Selected for this conversation only; startup default unchanged.\n");
      if (result.selected) this.output.write(`[model] The next request sends this conversation's context to ${result.status.provider}.\n`);
      if (result.models) {
        this.output.write(result.models.length ? result.models.map((model) => `  ${model.provider}/${model.id}`).join("\n") + "\n" : "No models with configured credentials. Use /login to configure a supported provider.\n");
        this.output.write("Use /model <provider/model-id> to select. Selection does not send a prompt.\n");
      }
      return;
    }
    if (/^\/effort(?:\s|$)/.test(prompt)) {
      if (this.subagents.isBusy) throw new Error("Wait for active subagents before changing effort.");
      const session = await this.ensureRuntime();
      const args = prompt.split(/\s+/).slice(1);
      if (!args.length) {
        const status = session.getStatus?.();
        const host = this.interactive ? this.terminal.exclusiveHost() : undefined;
        if (host && session.setEffort && status?.availableThinkingLevels?.length) {
          const selected = await host.mount(view => pickEffort(view, status.availableThinkingLevels!, status.thinkingLevel, this.commandAbort?.signal));
          if (selected) this.output.write(`${formatRuntimeStatus(await session.setEffort(selected.level, selected.persist))}\n`);
        } else this.output.write(`Effort: ${status?.thinkingLevel ?? "unavailable"}. Supported: ${status?.availableThinkingLevels?.join(", ") || "unavailable"}\nUse /effort <level> [--session].\n`);
      } else {
        if (args.length > 2 || (args.length === 2 && args[1] !== "--session")) throw new Error("Usage: /effort <level> [--session]");
        if (!session.setEffort) throw new Error("This runtime does not support effort controls.");
        this.output.write(`${formatRuntimeStatus(await session.setEffort(args[0]!, args[1] !== "--session"))}\n`);
      }
      return;
    }
    if (prompt === "/permissions") {
      this.output.write("Permissions: native read/edit/write/bash tools execute within the requested coding task; no OS sandbox or universal shell approval gate.\nMCP, workspace transitions, debugger launch and consequential browser operations have their own exact approvals.\nNo SAFE/YOLO or read-only mode is implied. /verify may execute project scripts.\n");
      return;
    }
    if (prompt === "/context" || prompt === "/usage") {
      const session = await this.ensureRuntime();
      const usage = session.getUsage?.();
      const context = usage?.context;
      if (prompt === "/context") {
        this.output.write(`Context: ${context?.tokens == null ? "unavailable" : `${context.tokens} / ${context.contextWindow} tokens (estimate; ${context.percent?.toFixed(1) ?? "?"}%)`}\n`);
        this.output.write(`Messages: ${usage?.messages ?? "unavailable"}; indexed skills: ${this.skillRegistry!.list().length}; Casper custom tools: ${this.runtimeTools.length}.\nPer-file/skill/tool token attribution is unavailable. /compact sends a model request.\n`);
      } else this.output.write(`Usage: ${usage ? formatTerminalJSON(usage.tokens) : "unavailable"}\nCost: ${usage?.estimatedCost === undefined ? "unavailable" : `$${usage.estimatedCost.toFixed(4)} SDK/catalog estimate`}; not a bill or a subscription charge.\n`);
      return;
    }
    if (/^\/compact(?:\s|$)/.test(prompt)) {
      if (this.subagents.isBusy) throw new Error("Wait for active subagents before compacting.");
      const session = await this.ensureRuntime();
      if (!session.compact) throw new Error("This runtime does not support compaction.");
      this.output.write("[context] Compacting with the selected model; workspace files unchanged.\n");
      await session.compact(prompt.slice(8).trim() || undefined, this.commandAbort?.signal);
      this.output.write("[context] Conversation compacted; context usage may remain unavailable until the next response.\n");
      return;
    }
    if (prompt === "/clear" || /^\/resume(?:\s|$)/.test(prompt)) {
      if (this.subagents.isBusy) throw new Error("Wait for active subagents before changing conversations.");
      const session = await this.ensureRuntime();
      const id = prompt.slice(7).trim();
      if (prompt === "/resume") {
        if (!session.listConversations) throw new Error("This runtime does not support conversation listing. Use /tree and /switch for named workspaces.");
        const saved = await session.listConversations();
        this.output.write(saved.length ? saved.map(item => `${item.id}  ${item.name ?? "(unnamed)"}  ${item.modified}`).join("\n") + "\n" : "No saved conversations in this workspace.\n");
        this.output.write("Use /resume <exact-id>; /tree and /switch manage named workspaces.\n");
        return;
      }
      await this.browser?.close(); this.browser = undefined;
      await this.stopDebugger(); this.debugSession = undefined;
      if (prompt === "/clear") {
        if (!session.clearConversation) throw new Error("This runtime does not support fresh conversations.");
        await session.clearConversation();
      } else {
        if (!session.resumeConversation) throw new Error("This runtime does not support conversation resume.");
        await session.resumeConversation(id);
      }
      this.lastTaskRequest = undefined;
      await (await this.ensureSessionWorkspace()).rememberConversation(session);
      this.output.write(`[session] ${prompt === "/clear" ? "Fresh conversation started" : "Conversation resumed"}; workspace files unchanged. Previous conversations remain available through /resume.\n`);
      this.output.write(`${formatRuntimeStatus(session.getStatus?.())}\n`);
      return;
    }
    if (prompt === "/diff") {
      this.output.write(await this.git(["status", "--short"]));
      this.output.write(await this.git(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"]));
      this.output.write("[diff] Tracked changes against HEAD; untracked files listed above, contents not included. Output limited to 64 KiB per command.\n");
      return;
    }
    if (/^\/output(?:\s|$)/.test(prompt)) {
      const argument = prompt.slice(7).trim();
      const recency = argument ? Number(argument) : 1;
      const retained = this.observations.retainedOutputs;
      if (!retained) throw new Error("No tool output retained; /output shows tool calls from the last model task.");
      const entry = Number.isInteger(recency) ? this.observations.toolOutput(recency) : undefined;
      if (!entry) throw new Error(`Usage: /output [n] with n from 1 (most recent) to ${retained} (retained tool call${retained === 1 ? "" : "s"}).`);
      const target = entry.target === undefined ? "" : ` · ${redactPreview(entry.target).replace(/\s+/g, " ").slice(0, 180)}`;
      this.output.write(`[output] ${terminalText(entry.toolName).slice(0, 80)}${target} · ${entry.status}${entry.truncated ? " · truncated by runtime" : ""}\n`);
      this.output.write(entry.text ? `${terminalText(entry.text)}\n` : "(no output text)\n");
      return;
    }
    if (prompt === "/status") {
      const info = await this.inspectProjectFn(this.activeWorkspaceRoot());
      this.projectContext!.info.gitBranch = info.gitBranch;
      this.output.write(`${renderProjectSummary(this.projectContext!)}\n`);
      this.output.write(`${formatRuntimeStatus(this.session ? this.session.getStatus?.() ?? { auth: "unknown" } : undefined)}\n`);
      this.output.write(` skills    ${this.skillRegistry!.list().length} indexed; imports: ${this.projectContext!.skills.imports?.join(", ") || "none"} (/skills diagnostics)\n`);
      this.output.write(` mcp       ${this.mcp!.status().length} configured (/mcp for connection status)\n`);
      this.output.write(` lsp       ${this.lsp!.status().length} configured (/lsp for connection status)\n`);
      this.output.write(` browser   ${this.browser?.status().state ?? "idle"}; disposable local browser (/browser)\n`);
      this.output.write(` debugger  ${this.debugSession?.status().state ?? "idle"}; explicit local DAP (/debug)\n`);
      const usage = this.session?.getUsage?.();
      this.output.write(` context   ${usage?.context?.percent == null ? "unavailable" : `${usage.context.percent.toFixed(1)}% (estimate)`}; ${usage?.tokens.total ?? "unavailable"} session tokens (/context, /usage)\n`);
      this.output.write(" policy    native coding tools enabled; not sandboxed (/permissions). Verification requires explicit scoped checks (/verify).\n");
      this.output.write(` visualize ${this.visualization!.providerNames().join(", ")} (/visualize)\n`);
      this.output.write(" memory    explicit facts and local task summaries; acceptance unknown until recorded (/memory)\n references read-only local sources (/references)\n");
      return;
    }
    if (prompt === "/exit" || prompt === "/quit") return;
    if (/^\/debug(?:\s|$)/.test(prompt)) {
      await this.handleDebugCommand(prompt);
      return;
    }
    if (/^\/browser(?:\s|$)/.test(prompt)) {
      await this.handleBrowserCommand(prompt);
      return;
    }
    if (/^\/memory(?:\s|$)/.test(prompt)) {
      this.memoryWork = this.handleMemoryCommand(prompt);
      try { await this.memoryWork; }
      finally { this.memoryWork = undefined; }
      return;
    }
    if (/^\/references(?:\s|$)/.test(prompt)) {
      await this.handleReferencesCommand(prompt);
      return;
    }
    if (prompt === "/project") {
      this.output.write(`${renderProjectSummary(this.projectContext!)}\n`);
      return;
    }
    if (/^\/tree(?:\s|$)/.test(prompt)) {
      if (prompt !== "/tree") throw new Error("Usage: /tree");
      this.output.write((await this.ensureSessionWorkspace()).renderTree());
      return;
    }
    if (/^\/branch(?:\s|$)/.test(prompt)) {
      await this.handleBranchCommand(prompt);
      return;
    }
    if (/^\/switch(?:\s|$)/.test(prompt)) {
      await this.handleSwitchCommand(prompt);
      return;
    }
    if (/^\/delegate(?:\s|$)/.test(prompt)) {
      await this.stopDebugger();
      await this.handleDelegateCommand(prompt);
      return;
    }
    if (/^\/lsp(?:\s|$)/.test(prompt)) {
      await this.handleLSPCommand(prompt);
      return;
    }
    if (/^\/visualize(?:\s|$)/.test(prompt)) {
      this.visualizationWork = this.handleVisualizeCommand(prompt);
      try { await this.visualizationWork; }
      finally { this.visualizationWork = undefined; }
      return;
    }
    if (/^\/mcp(?:\s|$)/.test(prompt)) {
      await this.handleMCPCommand(prompt);
      return;
    }
    if (/^\/skills(?:\s|$)/.test(prompt)) {
      await this.handleSkillsCommand(prompt);
      return;
    }
    if (/^\/verify(?:\s|$)/.test(prompt)) {
      const args = prompt.trim().split(/\s+/).slice(1);
      const repair = args[0] === "repair";
      if (repair) args.shift();
      if (args.some((arg) => !CHECK_NAMES.some((name) => name === arg))) {
        throw new Error("Usage: /verify [repair] [typecheck|lint|test|build ...]");
      }
      return this.runVerification(args.length ? args as ProjectCommand[] : CHECK_NAMES, repair);
    }
    throw new Error(`Unknown command ${JSON.stringify(prompt.split(/\s+/)[0])}. Type /help for local commands.`);
  }

  private async runModelTask(prompt: string): Promise<VerificationReport | undefined> {
    if (this.closing) return;
    this.observations = new TaskObservations();
    // Debug values and active debuggees do not silently become model-task context.
    await this.stopDebugger();
    // A finished task's immutable evidence belongs to its receipt, not the next prompt.
    if (this.browser?.status().state === "closed") this.browser = undefined;
    const context = this.projectContext!;
    const classification = classifyTask(prompt);
    this.lastTaskRequest = prompt;
    const selected = await this.skillRegistry!.loadForTask(prompt, context.model, classification);
    this.reportSkillWarnings();
    if (selected.length) {
      this.output.write(` skills selected: ${selected.map(({ skill }) => skill.name).join(", ")}\n`);
    }
    const skillContext = formatSelectedSkills(selected);
    let memoryContext = "";
    try {
      memoryContext = await new ProjectMemory(context.stateDirectory).context();
    } catch {
      // Facts are optional guidance. Keep explicit memory operations fail-closed,
      // and never echo possibly sensitive file contents or paths from read errors.
      if (!this.closing) this.output.write("[memory] Facts unavailable (invalid or unreadable state); continuing without them. Preserve and inspect memory.jsonl before manual repair.\n");
    }
    if (this.closing || this.commandAbort?.signal.aborted) return;
    if (this.autoVerify) this.checkTask = new VerificationTask(
      VerifierRegistry.forProject(context.model, context.verification.timeoutMs, this.blockOnCleanupFailure), this.activeWorkspaceRoot(),
      (result) => { this.ensureLineBreak(); this.output.write(`${formatVerificationResult(result)}\n`); },
    );
    await this.prepareCapabilities(prompt, classification.intent === "visualize");
    if (this.closing || this.commandAbort?.signal.aborted) return;
    const session = await this.ensureRuntime();
    if (this.closing || this.commandAbort?.signal.aborted) return;
    const workspaceRoot = this.activeWorkspaceRoot();
    // Receipts describe the tree, not tool names: a read-only shell run is not a write.
    const before = await this.snapshotWorkspace(workspaceRoot, this.commandAbort?.signal);
    let afterModel: Map<string, string> | undefined;
    let verification: VerificationReport | undefined;
    try {
      await session.prompt([
        memoryContext,
        skillContext,
        formatTaskPrompt(prompt, classification, context.model),
      ].filter(Boolean).join("\n\n"), this.commandAbort?.signal);
      afterModel = before && !this.closing ? await this.snapshotWorkspace(workspaceRoot) : undefined;
      if (!this.closing && !this.commandAbort?.signal.aborted && !this.taskRuntimeFailed && !this.checkTask?.signal.aborted && this.checkTask?.checks.length) {
        verification = await this.runVerification(this.checkTask.checks, true, prompt, this.checkTask);
      }
    } catch (error) {
      this.taskRuntimeFailed = true;
      throw error;
    } finally {
      const execution = this.closing || this.commandAbort?.signal.aborted || this.taskRuntimeCancelled || this.checkTask?.signal.aborted ? "cancelled" : this.taskRuntimeFailed ? "failed" : "completed";
      // Keep already-executed evidence on terminal error/cancellation, but never
      // launch another command or repair prompt after the task has stopped.
      if (!verification && this.checkTask?.checks.length) verification = {
        status: "blocked", reason: `Task ${execution}; no further checks or repair.`, repairAttempts: 0,
        results: await this.checkTask.refresh(), rounds: this.checkTask.rounds,
      };
      // The model turn and the verification/repair round are measured separately so check
      // scripts and repair edits are never attributed to the request itself.
      afterModel ??= before && !this.closing ? await this.snapshotWorkspace(workspaceRoot) : undefined;
      const afterChecks = verification && afterModel && !this.closing ? await this.snapshotWorkspace(workspaceRoot) : afterModel;
      const flatten = (changes: TreeChanges) => [...changes.added, ...changes.modified, ...changes.removed].sort();
      const changedPaths = before && afterModel ? flatten(diffSnapshots(before, afterModel)) : undefined;
      const changedDuringChecks = afterModel && afterChecks && afterChecks !== afterModel ? flatten(diffSnapshots(afterModel, afterChecks)) : [];
      const observations = this.observations.snapshot(changedPaths, changedDuringChecks);
      const browser = !this.closing && this.browser ? await this.browser.report() : undefined;
      this.lastTaskResult = { execution, verification, ...observations, ...(browser?.checks.length ? { browser } : {}) };
      if (!this.closing) {
        this.terminal.endAssistant();
        this.ensureLineBreak();
        if (classification.intent !== "general" || execution !== "completed" || verification || browser?.checks.length || observations.possibleMutations || observations.changedPaths?.length || observations.changedDuringChecks?.length || observations.observedEdits.length || observations.observedChecks.length) {
          this.output.write(`${formatTaskResult(this.lastTaskResult)}\n`);
          if (observations.changedPaths?.length || observations.changedDuringChecks?.length) this.output.write(await this.diffStat());
        }
      }
      await this.recordTaskOutcome({ task: prompt, skills: selected.map(({ skill }) => skill.id),
        modelStatus: execution, verification });
    }
    return verification;
  }

  private async recordTaskOutcome(input: { task: string; skills: string[]; modelStatus: TaskOutcome["modelStatus"]; verification?: VerificationReport }): Promise<void> {
    // Shutdown is not a completed task. Never launch a late persistence operation.
    if (this.closing) return;
    this.memoryWork = new ProjectMemory(this.projectContext!.stateDirectory).recordOutcome(input).then(() => {}, () => {
      this.output.write("[memory] Task outcome was not recorded (invalid, locked, full, or unavailable state); no acceptance inferred.\n");
    });
    try { await this.memoryWork; }
    finally { this.memoryWork = undefined; }
  }

  private async handleMemoryCommand(prompt: string): Promise<void> {
    const memory = new ProjectMemory(this.projectContext!.stateDirectory);
    const [, action, ...args] = prompt.trim().split(/\s+/);
    let result: unknown;
    if (!action) result = await memory.facts();
    else if (action === "remember" && args.length) result = await memory.remember(prompt.replace(/^\/memory\s+remember\s+/, ""));
    else if (action === "forget" && args.length === 1) { await memory.forget(args[0]!); result = "Fact forgotten"; }
    else if (action === "outcomes" && !args.length) result = (await memory.outcomes()).map((entry) => ({
      id: entry.id, task: entry.task.slice(0, 256), modelStatus: entry.modelStatus,
      verification: entry.verification, verificationMeaning: entry.verificationMeaning ?? "legacy", coverage: entry.coverage,
      checks: entry.checks, repairAttempts: entry.repairAttempts, accepted: entry.accepted,
    }));
    else if (action === "accept" && args.length === 2 && ["yes", "no"].includes(args[1]!)) {
      await memory.acceptOutcome(args[0]!, args[1] === "yes"); result = "Human acceptance recorded (not verification evidence)";
    } else throw new Error("Usage: /memory | /memory remember <fact> | /memory forget <id> | /memory outcomes | /memory accept <outcome-id> <yes|no>");
    const serialized = JSON.stringify(result, null, 2).replace(/[\u202a-\u202e\u2066-\u2069]/gu, (char) => `\\u${char.codePointAt(0)!.toString(16)}`);
    this.output.write(`[memory] ${serialized}\n`);
  }

  private async handleReferencesCommand(prompt: string): Promise<void> {
    if (prompt.trim() === "/references") {
      this.output.write(`[references] ${formatReferenceResult(this.references!.list())}\n`);
      return;
    }
    const match = prompt.match(/^\/references\s+search\s+(\S+)\s+([\s\S]+)$/);
    if (!match) throw new Error("Usage: /references | /references search <source-id|*> <literal query>");
    const result = await this.references!.search({ query: match[2]!, ...(match[1] === "*" ? {} : { source: match[1]! }) });
    if (!this.closing) this.output.write(`[references] ${formatReferenceResult(result)}\n`);
  }

  private async runVerification(
    checks: readonly ProjectCommand[],
    repair: boolean,
    request = `Make the selected verification checks pass: ${checks.join(", ")}.`,
    task?: VerificationTask,
  ): Promise<VerificationReport> {
    const context = this.projectContext!;
    const controller = new AbortController();
    const evidence = task ?? new VerificationTask(
      VerifierRegistry.forProject(context.model, context.verification.timeoutMs, this.blockOnCleanupFailure), this.activeWorkspaceRoot(),
      (result) => { this.ensureLineBreak(); this.output.write(`${formatVerificationResult(result)}\n`); },
    );
    const cancel = () => controller.abort();
    this.commandAbort?.signal.addEventListener("abort", cancel, { once: true });
    if (this.commandAbort?.signal.aborted) cancel();
    this.verificationAbort = controller;
    this.verificationTask = evidence;
    this.ensureLineBreak();
    try {
      this.verificationWork = verifyAndRepair({
        task: evidence,
        checks,
        cwd: this.activeWorkspaceRoot(),
        request,
        constraints: [context.rules.profile, context.rules.project, ...context.model.conventions].filter(Boolean).join("\n"),
        maxAttempts: context.repair.maxAttempts,
        signal: controller.signal,
        repair: repair ? async (prompt) => {
          await this.prepareCapabilities(request);
          const session = await this.ensureRuntime();
          if (!controller.signal.aborted) {
            await session.prompt(prompt, controller.signal);
            if (this.taskRuntimeFailed) throw new Error("Repair model stopped unsuccessfully; changes retained.");
          }
        } : undefined,
        onRepair: (attempt, max) => { this.output.write(`↻ repair ${attempt}/${max}\n`); },
      });
      const report = await this.verificationWork;
      this.output.write(`${formatVerificationReport(report)}\n`);
      return report;
    } finally {
      if (!task) await evidence.close();
      this.commandAbort?.signal.removeEventListener("abort", cancel);
      this.verificationTask = undefined;
      this.verificationAbort = undefined;
      this.verificationWork = undefined;
    }
  }

  private async ensureSessionWorkspace(): Promise<SessionWorkspaceManager> {
    if (this.sessionWorkspace) return this.sessionWorkspace;
    if (!this.sessionWorkspaceStart) {
      const context = this.projectContext!;
      this.sessionWorkspaceStart = SessionWorkspaceManager.open({
        projectRoot: context.info.root,
        gitBranch: context.info.gitBranch,
        policy: context.policy.workspace,
        homeDir: this.sessionHomeDir,
      }).then((manager) => {
        this.sessionWorkspace = manager;
        return manager;
      }).finally(() => { this.sessionWorkspaceStart = undefined; });
    }
    return this.sessionWorkspaceStart;
  }

  private async handleBranchCommand(prompt: string): Promise<void> {
    if (this.subagents.isBusy) throw new Error("Wait for active subagents before changing workspaces");
    const [, name, ...extra] = prompt.trim().split(/\s+/);
    if (!name || extra.length) throw new Error("Usage: /branch <name>");
    const manager = await this.ensureSessionWorkspace();
    const context = [
      `Casper named session branch: ${name}`,
      `Parent session branch: ${manager.activeName}`,
      this.lastTaskRequest ? `Latest task contract request: ${this.lastTaskRequest}` : "No task request has been submitted in this process.",
      formatProjectContext(this.projectContext!),
    ].join("\n\n");
    const transition = await manager.branch(name, {
      getRuntime: () => this.runtimeForWorkspaceTransition(),
      confirm: (preview, question) => this.confirmExact(preview, question),
      context,
    });
    if (!transition) {
      this.output.write("[sessions] Branch creation not approved.\n");
      return;
    }
    await this.rebindWorkspace(transition.workspacePath);
    this.output.write(`[sessions] active ${transition.name} · ${transition.workspacePath}\n`);
  }

  private async handleSwitchCommand(prompt: string): Promise<void> {
    if (this.subagents.isBusy) throw new Error("Wait for active subagents before changing workspaces");
    const [, name, action, ...extra] = prompt.trim().split(/\s+/);
    if (!name || extra.length || (action !== undefined && action !== "apply" && action !== "discard")) {
      throw new Error("Usage: /switch <branch> | /switch main <apply|discard>");
    }
    const manager = await this.ensureSessionWorkspace();
    let transition;
    if (action !== undefined) {
      if (name !== "main") throw new Error("Apply/discard is only valid when returning to main");
      transition = await manager.returnToMain(action as ReturnAction, {
        getRuntime: () => this.runtimeForWorkspaceTransition(),
        confirm: (preview, question) => this.confirmExact(preview, question),
        verify: async () => (await this.runVerification(
          CHECK_NAMES,
          false,
          `Verify session branch ${manager.activeName} before returning to main.`,
        )).status,
      });
    } else {
      transition = await manager.switch(name, {
        getRuntime: () => this.runtimeForWorkspaceTransition(),
        confirm: (preview, question) => this.confirmExact(preview, question),
      });
    }
    if (!transition) {
      this.output.write("[sessions] Switch not approved.\n");
      return;
    }
    await this.rebindWorkspace(transition.workspacePath);
    this.output.write(`[sessions] active ${transition.name} · ${transition.workspacePath}\n`);
    if (transition.preservedPath) this.output.write(`[sessions] Candidate files retained for recovery: ${JSON.stringify(transition.preservedPath)}\n`);
    if (transition.cleanupWarning) {
      this.output.write(`[sessions] Return did not complete cleanly; review the session tree and repository state: ${transition.cleanupWarning}\n`);
    }
  }

  private async revokeWorkspaceCapabilities(): Promise<void> {
    this.workspaceNeedsRebind = true;
    if (this.runtimeTools.length && !this.session?.setTools) throw new Error("Runtime cannot revoke workspace capabilities");
    this.session?.setTools?.([]);
    this.runtimeTools = [];
    await Promise.all([this.broker?.close(), this.lsp?.close(), this.references?.close(), this.browser?.close(), this.stopDebugger()]);
    this.browser = undefined;
    this.debugSession = undefined;
  }

  private async runtimeForWorkspaceTransition(): Promise<RuntimeSession> {
    const session = await this.ensureRuntime();
    await this.revokeWorkspaceCapabilities();
    return session;
  }

  private async rebindWorkspace(cwd: string): Promise<void> {
    await this.revokeWorkspaceCapabilities();
    const { context } = await this.loadWorkspace(cwd);
    if (this.closing) throw new Error("Casper is closing");
    this.runtimeTools = [];
    this.session?.setTools?.([]);
    await this.session?.appendContext?.([
      "Casper switched the active workspace for this named session branch.",
      formatProjectContext(context),
    ].join("\n\n"));
    this.workspaceNeedsRebind = false;
    this.output.write(`[sessions] workspace context rebound to ${context.info.root}; MCP/LSP connections require fresh explicit consent.\n`);
  }

  private activeWorkspaceRoot(): string {
    return this.session?.getState().cwd ?? this.projectContext!.info.root;
  }

  /** Bounded read-only git query in the active workspace; oversized output is marked, not silently cut. */
  private async git(args: string[]): Promise<string> {
    try { return (await promisify(execFile)("git", ["--no-pager", ...args], {
      cwd: this.activeWorkspaceRoot(), timeout: 5000, maxBuffer: 64 * 1024,
    })).stdout; }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && "stdout" in error && typeof error.stdout === "string")
        return error.stdout.slice(0, 64 * 1024) + "\n[diff truncated at display limit]\n";
      throw error;
    }
  }

  /** Tracked changes against HEAD after a task that changed files; silent outside a git history. */
  private async diffStat(): Promise<string> {
    try { return await this.git(["diff", "--stat", "--no-ext-diff", "--no-textconv", "HEAD", "--"]); }
    catch { return ""; }
  }

  /** Undefined when the tree is too large, unreadable or the task was cancelled mid-walk. */
  private async snapshotWorkspace(root: string, signal?: AbortSignal): Promise<Map<string, string> | undefined> {
    try { return await snapshotTree(root, signal); }
    catch { return undefined; }
  }

  private async prepareCapabilities(task: string, includeVisualization = false): Promise<void> {
    const nextTools = [
      ...await this.broker!.prepare(task),
      this.delegateTool(),
      ...(this.checkTask ? [this.checkTask.tool()] : []),
      ...lspTools(this.lsp!, this.confirmRename),
      ...this.references!.tools(),
      ...(/https?:\/\/|\b(browser|website|webpage|frontend|layout|responsive|overflow|css|puppeteer|playwright)\b/i.test(task) || this.browser?.status().state === "ready"
        ? [browserTool(this.browserSession(), this.commandAbort?.signal)] : []),
      ...(includeVisualization ? visualizationTools({ router: this.visualization!, projectRoot: this.activeWorkspaceRoot() }) : []),
    ];
    if (this.closing) return;
    if (this.session) {
      if ((nextTools.length || this.runtimeTools.length) && !this.session.setTools) throw new Error("Runtime does not support custom capabilities");
      this.session.setTools?.(nextTools);
    }
    this.runtimeTools = nextTools;
  }

  private async stopDebugger(): Promise<void> {
    await this.debugSession?.close();
    if (this.debugSession?.status().ownedProcessCleanup === "unknown") {
      throw new Error("Debugger process cleanup is unconfirmed. Inspect /debug and owned processes before starting more work; restarting does not prove cleanup.");
    }
  }

  private async handleDebugCommand(prompt: string): Promise<void> {
    const argument = prompt.slice(6).trim();
    const [action, ...args] = argument.split(/\s+/);
    if (action === "stop" && !args.length) {
      await this.debugSession?.close();
      this.output.write(`${formatTerminalJSON(this.debugSession?.status() ?? { state: "idle" })}\n`); return;
    }
    let request: DebugRequest | undefined;
    if (action === "start" && args.length === 1 && /^[\w-]{1,64}$/.test(args[0])) request = { action: "start", target: args[0] };
    else if (action === "threads" && !args.length) request = { action: "threads" };
    else if ((action === "stack" || action === "continue") && args.length === 1 && /^\d{1,10}$/.test(args[0])) request = { action, threadId: Number(args[0]) };
    else if (action === "scopes" && args.length === 1) request = { action, frame: args[0] };
    else if (action === "variables" && args.length === 1) request = { action, reference: args[0] };
    else if (action === "breakpoints") {
      const match = argument.slice(action.length).trim().match(/^(.+) (clear|[1-9]\d*(?:,[1-9]\d*)*)$/);
      if (match) request = { action, path: match[1], lines: match[2] === "clear" ? [] : match[2].split(",").map(Number) };
    }
    if (action && !request) throw new Error("Usage: /debug | start <target> | breakpoints <path> <line,line|clear> | threads | stack <thread> | scopes <frame> | variables <handle> | continue <thread> | stop");
    if (this.subagents.isBusy) throw new Error("Wait for active subagents before using the debugger");
    if (!this.debugSession || (request?.action === "start" && ["closed", "failed"].includes(this.debugSession.status().state))) {
      await this.stopDebugger();
      const { DebugSession } = await import("./debug/session");
      this.commandAbort?.signal.throwIfAborted();
      if (this.closing) return;
      this.debugSession = new DebugSession({ projectRoot: this.activeWorkspaceRoot(),
        confirm: (preview, signal) => this.confirmExact(`Debugger execution confirmation:\n${preview}\nAdapter and debuggee execute code; not sandboxed. Debug values may contain secrets.\n`, "Launch this exact debugger target? Type yes: ", signal),
      });
    }
    const result = request ? await this.debugSession.run(request, this.commandAbort?.signal)
      : { ...this.debugSession.status(), targets: await this.debugSession.targets() };
    this.output.write(`${formatTerminalJSON(result)}\n`);
  }

  private browserSession(): BrowserSession {
    if (!this.browser || this.browser.status().state === "closed") this.browser = new BrowserSession({
      projectRoot: this.activeWorkspaceRoot(), stateDirectory: this.projectContext!.stateDirectory,
      confirm: (request, signal) => this.confirmExact(`Browser action:\n${formatTerminalJSON(request)}\n`, "Allow this exact action? Type yes: ", signal),
    });
    return this.browser;
  }

  private async handleBrowserCommand(prompt: string): Promise<void> {
    const [, action, ...args] = prompt.split(/\s+/);
    if (!action) { this.output.write(`${formatTerminalJSON(this.browser?.status() ?? { state: "idle" })}\n`); return; }
    if (action === "close" && !args.length) { await this.browser?.close(); this.output.write("[browser] Closed owned browser; saved screenshots retained.\n"); return; }
    if (action === "open" && args.length === 1) {
      const result = await this.browserSession().run({ action, url: args[0] }, this.commandAbort?.signal);
      this.output.write(`${formatTerminalJSON(result)}\n`); return;
    }
    if (["inspect", "diagnostics", "screenshot"].includes(action) && !args.length) {
      this.output.write(`${formatTerminalJSON(await this.browserSession().run({ action }, this.commandAbort?.signal))}\n`); return;
    }
    throw new Error("Usage: /browser | /browser open <url> | /browser inspect|diagnostics|screenshot|close");
  }

  private async handleLSPCommand(prompt: string): Promise<void> {
    const [, action, name, ...extra] = prompt.trim().split(/\s+/);
    if (action && (!name || extra.length || !["connect", "disconnect"].includes(action))) {
      throw new Error("Usage: /lsp | /lsp connect <name> | /lsp disconnect <name>");
    }
    if (action === "connect") await this.lsp!.connect(name!);
    if (action === "disconnect") await this.lsp!.disconnect(name!);
    const statuses = this.lsp!.status();
    this.output.write(statuses.length ? statuses.map((entry) => `${entry.name} [${entry.state}]\n  source: ${entry.source}`).join("\n") + "\n" : "No LSP servers configured.\n");
  }

  private async handleVisualizeCommand(prompt: string): Promise<void> {
    const [, action, scope, ...extra] = prompt.trim().split(/\s+/);
    if (action && (action !== "repo" || extra.length)) throw new Error("Usage: /visualize | /visualize repo [directory]");
    const router = this.visualization!;
    if (!action) {
      this.output.write([
        `providers: ${router.providerNames().join(", ")}`,
        `artifacts: ${!router.settings.outputDir ? "disabled (in-conversation only)" : artifactFilesystemSupported ? router.settings.outputDir : "in-conversation only (artifact files need macOS or Linux)"}`,
        "Visualization is read-only and never modifies the workspace.",
        "",
      ].join("\n"));
      return;
    }
    const controller = new AbortController();
    this.visualizationAbort = controller;
    try {
      const repo = await buildRepoGraph({ root: this.activeWorkspaceRoot(), scope, signal: controller.signal });
      const rendered = await router.render(repo.graph, controller.signal);
      const description = describeVisualization(rendered, [`Scanned ${repo.filesScanned} files at ${repo.granularity} granularity.`, ...repo.notes]);
      this.output.write(`${rendered.primary.content}\n`);
      for (const note of [...(description.notes as string[]), ...rendered.primary.lossiness]) this.output.write(`[visualize] ${note}\n`);
      for (const artifact of rendered.artifacts) this.output.write(`[visualize] wrote ${artifact.path} (${artifact.bytes} bytes)\n`);
    } finally { this.visualizationAbort = undefined; }
  }

  private delegateTool(): RuntimeTool {
    return this.subagents.createTool(() => ({
      cwd: this.activeWorkspaceRoot(),
      projectContext: formatProjectContext(this.projectContext!),
    }));
  }

  private async handleDelegateCommand(prompt: string): Promise<void> {
    const match = prompt.match(/^\/delegate\s+(explorer|reviewer)\s+([\s\S]+)$/);
    if (!match) throw new Error("Usage: /delegate <explorer|reviewer> <goal>");
    const [, role, goal] = match;
    const result = await this.subagents.run({
      role: role as SubagentRole,
      goal,
      signal: this.commandAbort?.signal,
      cwd: this.activeWorkspaceRoot(),
      projectContext: formatProjectContext(this.projectContext!),
    });
    if (!this.closing) this.output.write(formatSubagentReport(result));
    if (result.status !== "completed") throw new Error(`Delegation ${result.status}; see the bounded report above`);
  }

  private confirmRename: ConfirmRename = async (preview, signal) => {
    const text = JSON.stringify(preview);
    if (Buffer.byteLength(text) > 16_384) return false;
    return this.confirmExact(`LSP rename confirmation (exact edits; zero-based UTF-16):\n${text}\n`, "Apply this exact rename? Type yes: ", signal);
  };

  private async handleMCPCommand(prompt: string): Promise<void> {
    const [, action, name, ...extra] = prompt.trim().split(/\s+/);
    if (action && (!name || extra.length || !["connect", "disconnect"].includes(action))) {
      throw new Error("Usage: /mcp | /mcp connect <name> | /mcp disconnect <name>");
    }
    if (action === "connect") await this.mcp!.connect(name!);
    if (action === "disconnect") await this.mcp!.disconnect(name!);
    const statuses = this.mcp!.status();
    this.output.write(statuses.length ? statuses.map((status) => [
      `${status.name} [${status.transport}; ${status.state}] ${status.toolCount} tools`,
      `  source: ${status.source}`,
      ...(status.error ? [`  ${status.error}`] : []),
    ].join("\n")).join("\n") + "\n" : "No MCP servers configured.\n");
    if (action === "connect" && statuses.find((status) => status.name === name)?.state !== "ready") {
      throw new Error("MCP connection failed; no tools exposed");
    }
  }

  private confirmCapability: ConfirmCapability = async (call, signal) => {
    const args = JSON.stringify(call.arguments);
    // Never approve truncated arguments or implicitly accept in one-shot mode.
    if (Buffer.byteLength(args) > 4096) return false;
    return this.confirmExact(`MCP confirmation: ${JSON.stringify(call.capability.id)} [${call.capability.safety}]\nArguments: ${args}\n`, "Allow this exact external call? Type yes: ", signal);
  };

  private async confirmExact(preview: string, question: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.interactive || this.closing || signal?.aborted || this.commandAbort?.signal.aborted) return false;
    const signals = [signal, this.commandAbort?.signal].filter((value): value is AbortSignal => Boolean(value));
    return this.terminal.confirm(preview, question, signals.length ? AbortSignal.any(signals) : undefined);
  }

  private async handleSkillsCommand(prompt: string): Promise<void> {
    const registry = this.skillRegistry!;
    const [, action, id, sha256, ...extra] = prompt.trim().split(/\s+/);
    try {
      if (!action) {
        const skills = registry.list();
        this.output.write(`${skills.length} indexed; imports: ${this.projectContext!.skills.imports?.join(", ") || "none"}\n`);
        this.output.write(skills.length ? skills.map((skill) => [
          `${skill.id} [${skill.source}; ${skill.trust}${skill.disableModelInvocation ? "; manual-only" : ""}]`,
          `  ${JSON.stringify(skill.description)}`,
          `  ${skill.filePath}`,
        ].join("\n")).join("\n\n") + "\n" : "No skills discovered.\n");
      } else if (action === "diagnostics" && !id) {
        this.output.write(registry.diagnostics.length ? registry.diagnostics.join("\n") + "\n" : "No skill warnings.\n");
      } else if (action === "inspect" && id && !sha256) {
        const inspected = await registry.inspect(id);
        this.output.write([
          `Skill: ${inspected.skill.id}`,
          `File: ${inspected.skill.filePath}`,
          `Source: ${inspected.skill.source}; trust: ${inspected.skill.trust}`,
          `Metadata: ${JSON.stringify({
            ...inspected.skill.extra,
            tags: inspected.skill.tags,
            stacks: inspected.skill.stacks,
            intents: inspected.skill.intents,
          })}`,
          inspected.body,
          `SHA256: ${inspected.sha256}`,
          `After reviewing: /skills trust ${id} ${inspected.sha256}`,
          "",
        ].join("\n"));
      } else if (action === "trust" && id && sha256 && !extra.length) {
        await registry.trust(id, sha256);
        this.output.write(`Trusted reviewed content for ${id}.\n`);
      } else if (action === "block" && id && !sha256) {
        await registry.block(id);
        this.output.write(`Blocked ${id} for future prompts.\n`);
      } else {
        this.output.write("Usage: /skills | /skills inspect <id> | /skills trust <id> <sha256> | /skills block <id>\n");
      }
    } catch (error) {
      this.output.write(`[skills] ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private reportSkillWarnings(): void {
    const warnings = this.skillRegistry!.diagnostics.filter((warning) => !this.reportedSkillWarnings.has(warning));
    if (!warnings.length) return;
    for (const warning of warnings) this.reportedSkillWarnings.add(warning);
    this.output.write(`[skills] ${warnings.length} new warning${warnings.length === 1 ? "" : "s"}; use /skills diagnostics\n`);
  }

  private writePrompt(prompt: string): void {
    if (!this.endedWithNewline) {
      this.output.write("\n");
    }

    this.output.write(`> ${prompt}\n`);
    this.endedWithNewline = true;
  }

  private updateFooter(): void {
    if (!this.projectContext) return;
    try {
      const project = this.projectContext.info;
      const status = this.session?.getStatus?.();
      const usage = this.session?.getUsage?.();
      const percent = usage?.context?.percent;
      const model = status?.model ? `${status.provider}/${status.model} · ${status.thinkingLevel ?? "effort —"}` : this.savedModelDisplay ?? "model not initialized · /model";
      this.terminal.setStatus(`${project.name}/${project.gitBranch ?? "no git"} │ ${model} │ ctx ${percent == null ? "—" : `${percent.toFixed(0)}%~`}${usage ? ` │ ${usage.tokens.total} tok` : ""}${usage?.estimatedCost === undefined ? "" : ` │ $${usage.estimatedCost.toFixed(3)} est`} │ ${this.commandActive ? "working" : "idle"}`, project.root);
    } catch { this.terminal.setStatus("Session status unavailable · /status", this.projectContext.info.root); }
  }

  private handleRuntimeEvent(event: RuntimeEvent): void {
    if (event.type !== "assistant_text_delta") this.updateFooter();
    switch (event.type) {
      case "assistant_response_end":
        this.terminal.endAssistant();
        // Pi may retry a provider error inside prompt(); only the final response
        // determines the stop outcome. Thrown prompt errors are handled separately.
        this.taskRuntimeCancelled = event.stopReason === "aborted";
        this.taskRuntimeFailed = !["stop", "toolUse"].includes(event.stopReason);
        break;
      case "assistant_text_delta":
        this.terminal.assistant(event.delta);
        this.endedWithNewline = true;
        break;
      case "tool_start":
        this.terminal.endAssistant();
        this.ensureLineBreak();
        if (event.toolCallId) this.toolStarted.set(event.toolCallId, performance.now());
        this.output.write(`${formatToolActivity(event)}\n`);
        this.endedWithNewline = true;
        break;
      case "tool_end":
        this.observations.observeToolEnd(event, this.projectContext?.model.commands);
        if (["bash", "edit", "write"].includes(event.toolName)) this.browser?.invalidate();
        // Successful native writes invalidate in afterFileEdit, before LSP awaits.
        // Failed writes may be partial; invalidate without claiming a completed edit.
        if (event.isError && ["edit", "write"].includes(event.toolName) && typeof event.input?.path === "string") (this.checkTask ?? this.verificationTask)?.invalidateForEdit(event.input.path);
        this.terminal.endAssistant();
        const started = event.toolCallId ? this.toolStarted.get(event.toolCallId) : undefined;
        if (event.toolCallId) this.toolStarted.delete(event.toolCallId);
        this.output.write(`${formatToolActivity(event, started === undefined ? undefined : performance.now() - started)}\n`);
        this.endedWithNewline = true;
        break;
      case "message_end":
        this.terminal.endAssistant();
        this.toolStarted.clear();
        this.ensureLineBreak();
        break;
      case "error":
        this.taskRuntimeFailed = true;
        this.terminal.endAssistant();
        this.ensureLineBreak();
        if (this.displayedError !== event.message) this.output.write(`[error] ${event.message}\n`);
        this.displayedError = event.message;
        this.endedWithNewline = true;
        break;
    }
  }

  private observeEdit(path: string): void {
    this.browser?.invalidate();
    (this.checkTask ?? this.verificationTask)?.invalidateForEdit(path);
    this.observations.recordEdit(path);
  }

  private ensureLineBreak(): void {
    if (!this.endedWithNewline) {
      this.output.write("\n");
      this.endedWithNewline = true;
    }
  }
}
