import { execFile } from "node:child_process";
import type { DebugRequest, DebugSession } from "./debug/session";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { modelPreference } from "./tui/model-preference";
import { HELP_TEXT, FULL_HELP_TEXT, LOGIN_HELP } from "./tui/help";
import { BrowserSession } from "./browser/session";
import { formatTerminalJSON } from "./tui/json";
import { InteractiveTerminal } from "./tui/terminal";
import { askTool } from "./tui/ask";
import { pickEffort } from "./tui/effort-picker";
import { nextEffort } from "./tui/effort";
import { formatEffort, formatRuntimeStartLine, formatRuntimeStatus, formatToolActivity, redactPreview, terminalText } from "./tui/format";
import { ProjectMemory, type TaskOutcome } from "./memory/store";
import { discoverReferenceConfiguration, type ReferenceConfiguration } from "./references/config";
import { formatReferenceResult, ReferenceLibrary } from "./references/library";
import { formatSubagentReport, SubagentManager, type SubagentRole } from "./agents/manager";
import { discoverLSPConfiguration, type LSPConfiguration } from "./lsp/config";
import { LSPManager, type ConfirmRename } from "./lsp/manager";
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
import { findProjectCandidates, inspectProject, type ProjectInfo } from "./project/inspect";
import type {
  AgentRuntime,
  RuntimeSession,
  RuntimeTool,
} from "./runtime/types";
import { SkillRegistry, formatSelectedSkills } from "./skills/registry";
import { classifyTask, formatTaskPrompt, underSpecifiedTarget } from "./task/classify";
import { formatTaskResult, type TaskResult } from "./task/result";
import { TaskObservations } from "./task/observations";
import { LifecycleRegistry } from "./app/lifecycle";
import { RuntimeEventView } from "./app/events";
import { diffSnapshots, snapshotTree, type TreeChanges } from "./task/changes";
import { WORDMARK_COLUMNS, renderBanner, renderProjectSummary, renderWordmark } from "./tui/banner";
import type { ProjectCommand } from "./project/model";
import { CHECK_NAMES, formatVerificationReport, formatVerificationResult, type VerificationReport, type VerificationResult } from "./verify/evidence";
import { ProcessCleanupError } from "./platform/processes";
import { VerifierRegistry } from "./verify/registry";
import { verifyAndRepair } from "./verify/repair-loop";
import { VerificationTask } from "./verify/task";
import { MermaidProvider } from "./visualize/mermaid";
import { MindMeshProvider } from "./visualize/mindmesh";
import { buildRepoGraph } from "./visualize/repo";
import { VisualizationRouter } from "./visualize/router";
import { artifactFilesystemSupported } from "./visualize/artifacts";
import { describeVisualization } from "./visualize/tools";
import { assembleTaskTools } from "./app/capabilities";
import { systemPromptAppend } from "./app/prompt";
import type { VisualizationProvider } from "./visualize/types";
import { SessionWorkspaceManager, type ReturnAction } from "./sessions/manager";
import { runSlashCommand, type OutputWriter } from "./app/commands";

export type { OutputWriter } from "./app/commands";

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

export class CasperApp {
  private readonly runtimeFactory: () => AgentRuntime | Promise<AgentRuntime>;
  readonly subagents: SubagentManager;
  readonly inspectProjectFn: (cwd: string) => Promise<ProjectInfo>;
  private readonly loadProjectContextFn: (project: ProjectInfo) => Promise<ProjectContext>;
  private readonly loadSkillRegistryFn: (context: ProjectContext) => Promise<SkillRegistry>;
  private readonly loadMCPConfigurationFn: (context: ProjectContext) => Promise<MCPConfiguration>;
  private readonly loadLSPConfigurationFn: (context: ProjectContext) => Promise<LSPConfiguration>;
  private readonly loadReferenceConfigurationFn: (context: ProjectContext) => Promise<ReferenceConfiguration>;
  browser?: BrowserSession;
  debugSession?: DebugSession;
  references?: ReferenceLibrary;
  lsp?: LSPManager;
  visualization?: VisualizationRouter;
  visualizationAbort?: AbortController;
  visualizationWork?: Promise<void>;
  private readonly visualizationProviders: VisualizationProvider[];
  mcp?: MCPManager;
  private broker?: CapabilityBroker;
  /** Owned-subsystem teardown bookkeeping: idempotent per subsystem, drained at close. */
  readonly lifecycle = new LifecycleRegistry();
  runtimeTools: RuntimeTool[] = [];
  readonly terminal: InteractiveTerminal;
  interactive = false;
  /** beforeChanges gate state for the current task; a recorded ask attempt satisfies it. */
  private editGateActive = false;
  private asksThisTask = 0;
  private cancelBeforeCommand = false;
  commandAbort?: AbortController;
  /** Transcript-flow renderer for runtime events; owns the open tool/progress line state. */
  private readonly events: RuntimeEventView;
  readonly output: OutputWriter;
  private readonly input: Readable;
  private runtime?: AgentRuntime;
  private runtimeLoad?: Promise<AgentRuntime>;
  private runtimeStart?: Promise<RuntimeSession>;
  session?: RuntimeSession;
  closing = false;
  private closeWork?: Promise<void>;
  private unsubscribe?: () => void;
  projectContext?: ProjectContext;
  skillRegistry?: SkillRegistry;
  private readonly reportedSkillWarnings = new Set<string>();
  private readonly autoVerify: boolean;
  private verificationAbort?: AbortController;
  private verificationWork?: Promise<VerificationReport>;
  /** Active repair evidence; sharing it does not grant managed-tool consent. */
  private verificationTask?: VerificationTask;
  private checkTask?: VerificationTask;
  private readonly sessionHomeDir?: string;
  private sessionWorkspace?: SessionWorkspaceManager;
  private sessionWorkspaceStart?: Promise<SessionWorkspaceManager>;
  lastTaskRequest?: string;
  private commandActive = false;
  /** Shift+Tab steps already accepted. The prompt loop drains this before a request starts. */
  private effortSteps = 0;
  private effortCycle: Promise<void> = Promise.resolve();
  private workspaceTransition = false;
  private workspaceNeedsRebind = false;
  private taskRuntimeFailed = false;
  private cleanupError?: ProcessCleanupError;
  private readonly blockOnCleanupFailure = () => {
    this.cleanupError = new ProcessCleanupError();
    this.commandAbort?.abort(); this.verificationAbort?.abort(); this.checkTask?.abort();
    void this.session?.abort().catch(() => {});
  };
  private savedModelDisplay?: string;
  private taskRuntimeCancelled = false;
  private lastTaskResult?: TaskResult;
  observations = new TaskObservations();
  memoryWork?: Promise<void>;

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
    this.lifecycle.add({ name: "subagents", close: () => this.subagents.close() });
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
      () => this.cancelCurrent(), () => { if (this.commandActive && !this.closing) void this.close().catch(() => {}); });
    this.terminal.setEffortCycle(() => this.cycleEffort());
    // A tool's "running" line is left open on a rich surface so its completion can redraw it in
    // place (`\r`); any other output first commits that line, so nothing appends to it. The boxed
    // activity status stays out of the transcript and is cleared as streamed text arrives.
    // The open-line state lives in the event view; every write consults it first.
    this.output = { write: (text) => {
      this.events.beforeWrite(text);
      this.terminal.write(text);
    } };
    this.events = new RuntimeEventView(this.terminal, this.output, {
      updateFooter: () => this.updateFooter(),
      onToolEnd: event => {
        this.observations.observeToolEnd(event, this.projectContext?.model.commands);
        if (["bash", "edit", "write"].includes(event.toolName)) this.browser?.invalidate();
        // Successful native writes invalidate in afterFileEdit, before LSP awaits.
        // Failed writes may be partial; invalidate without claiming a completed edit.
        if (event.isError && ["edit", "write"].includes(event.toolName) && typeof event.input?.path === "string") (this.checkTask ?? this.verificationTask)?.invalidateForEdit(event.input.path);
      },
      setTaskStop: (cancelled, failed) => { this.taskRuntimeCancelled = cancelled; this.taskRuntimeFailed = failed; },
      markRuntimeFailed: () => { this.taskRuntimeFailed = true; },
    });
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
    this.lifecycle.add({ name: "references", close: () => this.references!.close() });
    this.lifecycle.add({ name: "mcp", close: () => this.broker!.close() });
    this.lifecycle.add({ name: "lsp", close: () => this.lsp!.close() });
    return { project, context, registry, mcp: this.mcp, visualization: this.visualization, lspConfiguration, referenceConfiguration };
  }

  async start(cwd = process.cwd()): Promise<ProjectInfo> {
    if (this.closing) throw new Error("Casper is closing");
    if (this.projectContext) return this.projectContext.info;
    const { project, context, mcp, visualization, lspConfiguration, referenceConfiguration } = await this.loadWorkspace(cwd);
    if (this.closing) throw new Error("Casper is closing");
    // The wordmark is for a person at a rich terminal; one-shot and piped output keep the text banner.
    const wordmark = this.interactive && this.terminal.rich && (this.terminal.columns ?? 0) >= WORDMARK_COLUMNS;
    if (wordmark) this.terminal.writeTrusted(`\n${renderWordmark(this.terminal.color)}\n`);
    this.output.write(renderBanner(context, { wordmark, interactive: this.interactive }));
    this.output.write(`${formatRuntimeStatus(this.session?.getStatus?.())}\n`);
    for (const diagnostic of referenceConfiguration.diagnostics) this.output.write(`[references] ${formatReferenceResult(diagnostic)}\n`);
    this.reportSkillWarnings();
    for (const diagnostic of mcp.diagnostics) this.output.write(`[mcp] ${diagnostic}\n`);
    for (const diagnostic of lspConfiguration.diagnostics) this.output.write(`[lsp] ${diagnostic}\n`);
    for (const diagnostic of visualization.diagnostics) this.output.write(`[visualize] ${diagnostic}\n`);
    if (this.interactive) this.output.write("\n");
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

  /** Interactive startup from the home directory asks which project folder to open — a launch
   * from ~ silently made the whole home directory the workspace (banner "project <user>"), and
   * tasks then scanned all of it. A typed path is validated; Esc/empty keeps the home folder.
   * Without a rich surface the question cannot render, so the launch folder is stated plainly. */
  private async openProjectFolder(cwd: string): Promise<string> {
    const home = this.sessionHomeDir ?? os.homedir();
    if (path.resolve(cwd) !== path.resolve(home)) return cwd;
    if (!this.terminal.rich) {
      this.output.write(`[folder] Opened in your home directory; cd to a project and restart, or pass a path: casper ~/Projects/myapp\n`);
      return cwd;
    }
    const candidates = await findProjectCandidates(cwd, { homeDir: home });
    const folderLabel = (folder: string) => folder === home ? "~" : `~${folder.slice(home.length)}`;
    const byLabel = new Map<string, string>(candidates.map(candidate => [folderLabel(candidate), candidate]));
    const answer = await this.terminal.ask(
      "Opened from your home folder. Work in which project?",
      [
        { label: folderLabel(cwd), description: "stay in the home folder" },
        ...candidates.slice(0, 6).map(candidate => ({ label: folderLabel(candidate) })),
      ],
      false,
    );
    const choice = answer?.[0]?.trim();
    if (!choice) return cwd; // Esc, empty, or the plain-line fallback keeps the launch folder.
    const resolved = byLabel.get(choice) ?? path.resolve(cwd, choice.replace(/^~(?=\/|$)/, home));
    if (!path.resolve(resolved).startsWith(path.resolve(home)) && path.resolve(resolved) !== path.resolve(home)) {
      this.output.write(`[folder] ${terminalText(choice)} is outside your home directory; staying in ${folderLabel(cwd)}.\n`);
      return cwd;
    }
    try {
      if (!(await stat(resolved)).isDirectory()) throw new Error("not a directory");
    } catch {
      this.output.write(`[folder] ${terminalText(choice)} is not a directory; staying in ${folderLabel(cwd)}.\n`);
      return cwd;
    }
    return resolved;
  }

  async runInteractive(cwd = process.cwd()): Promise<void> {
    // Own the terminal before the banner so startup output is transcript, not
    // loose text a later redraw would drop.
    this.interactive = true;
    this.terminal.start();
    let workspace = cwd;
    if (!this.projectContext) workspace = await this.openProjectFolder(cwd);
    if (!this.projectContext) {
      await this.start(workspace);
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
        this.events.ensureLineBreak();
        const message = error instanceof Error ? error.message : String(error);
        if (!this.commandAbort?.signal.aborted && this.events.lastError !== message) this.output.write(`[error] ${message}\n`);
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
    void this.lifecycle.close("debug").catch(() => {});
    void this.lifecycle.close("browser").catch(() => {});
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
    // Owned subsystems close concurrently while runtime/verification drain. Observe early
    // rejections now; finishClose still awaits and propagates their results.
    for (const work of this.lifecycle.closeAll()) void work.catch(() => {});
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
        finally { await this.lifecycle.drain(); }
      }
    }
  }

  /** One adapter-construction owner, shared by auth and session startup. */
  acquireRuntime(): Promise<AgentRuntime> {
    if (!this.runtimeLoad) this.runtimeLoad = Promise.resolve().then(async () => {
      if (this.closing) throw new Error("Casper is closing");
      this.runtime = await this.runtimeFactory();
      if (this.closing) throw new Error("Casper is closing");
      return this.runtime;
    }).catch((error) => { if (!this.closing) this.runtimeLoad = undefined; throw error; });
    return this.runtimeLoad;
  }

  async ensureRuntime(): Promise<RuntimeSession> {
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
          systemPromptAppend: systemPromptAppend(context),
          beforeToolGate: toolName => this.editGateReason(toolName),
        });
        await (await this.ensureSessionWorkspace()).resumeActive(this.session);
        this.unsubscribe = this.session.subscribe(event => this.events.handle(event));
        const status = this.session.getStatus?.() ?? { auth: "unknown" as const };
        if (!status.blocked) this.output.write(`${formatRuntimeStartLine(status)}\n`);
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
    this.events.clearError();
    this.taskRuntimeCancelled = false;
    this.commandActive = true;
    this.commandAbort = new AbortController();
    this.updateFooter();
    this.workspaceTransition = transition;
    try {
      // A Shift+Tab that arrived with this submit still applies; new presses see commandActive and wait.
      while (this.effortSteps > 0) await this.effortCycle;
      if (this.closing) return;
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

  /** Local command dispatch moved to app/commands.ts; the app is the command host. */
  private handleSlashCommand(prompt: string): Promise<VerificationReport | undefined> {
    return runSlashCommand(this, prompt);
  }

  private async runModelTask(prompt: string): Promise<VerificationReport | undefined> {
    if (this.closing) return;
    this.observations = new TaskObservations();
    const context = this.projectContext!;
    const classification = classifyTask(prompt);
    // beforeChanges policy: under-specified implement/configure work must see one recorded
    // ask attempt before the first edit. Interactive sessions only — one-shot cannot ask,
    // so denying edits there would only deadlock the task.
    this.asksThisTask = 0;
    // A new request gets a fresh delegation budget (the budget belongs to the parent task).
    this.delegateToolForTask = undefined;
    this.editGateActive = this.interactive && this.terminal.rich
      && context.policy.behavior.askQuestions === "beforeChanges"
      && (classification.intent === "implement" || classification.intent === "configure")
      && underSpecifiedTarget(prompt);
    // Debug values and active debuggees do not silently become model-task context.
    await this.stopDebugger();
    // A finished task's immutable evidence belongs to its receipt, not the next prompt.
    if (this.browser?.status().state === "closed") this.browser = undefined;
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
      (result) => this.writeCheckResult(result),
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
      ].filter(Boolean).join("\n\n"), this.commandAbort?.signal, { request: prompt });
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
        this.events.ensureLineBreak();
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



  async runVerification(
    checks: readonly ProjectCommand[],
    repair: boolean,
    request = `Make the selected verification checks pass: ${checks.join(", ")}.`,
    task?: VerificationTask,
  ): Promise<VerificationReport> {
    const context = this.projectContext!;
    const controller = new AbortController();
    // A standalone verification task (/verify, branch checks) owns its objective; post-task
    // verification passes `task` and continues the parent request's delegation budget.
    if (!task) this.delegateToolForTask = undefined;
    const evidence = task ?? new VerificationTask(
      VerifierRegistry.forProject(context.model, context.verification.timeoutMs, this.blockOnCleanupFailure), this.activeWorkspaceRoot(),
      (result) => this.writeCheckResult(result),
    );
    const cancel = () => controller.abort();
    this.commandAbort?.signal.addEventListener("abort", cancel, { once: true });
    if (this.commandAbort?.signal.aborted) cancel();
    this.verificationAbort = controller;
    this.verificationTask = evidence;
    this.events.ensureLineBreak();
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
            await session.prompt(prompt, controller.signal, { request });
            if (this.taskRuntimeFailed && !this.taskRuntimeCancelled) throw new Error("Repair model stopped unsuccessfully; changes retained.");
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

  async ensureSessionWorkspace(): Promise<SessionWorkspaceManager> {
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

  async handleBranchCommand(prompt: string): Promise<void> {
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

  async handleSwitchCommand(prompt: string): Promise<void> {
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

  activeWorkspaceRoot(): string {
    return this.session?.getState().cwd ?? this.projectContext!.info.root;
  }

  /** Bounded read-only git query in the active workspace; oversized output is marked, not silently cut. */
  async git(args: string[]): Promise<string> {
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
    const nextTools = await assembleTaskTools(task, includeVisualization, {
      broker: this.broker!, delegate: this.delegateTool(), ask: this.askTool(),
      check: this.checkTask?.tool(), lsp: this.lsp!, confirmRename: this.confirmRename,
      references: this.references!, visualization: this.visualization!, projectRoot: this.activeWorkspaceRoot(),
      browserReady: this.browser?.status().state === "ready", browser: () => this.browserSession(),
      browserSignal: this.commandAbort?.signal,
    });
    if (this.closing) return;
    if (this.session) {
      if ((nextTools.length || this.runtimeTools.length) && !this.session.setTools) throw new Error("Runtime does not support custom capabilities");
      this.session.setTools?.(nextTools);
    }
    this.runtimeTools = nextTools;
  }

  async stopDebugger(): Promise<void> {
    await this.debugSession?.close();
    if (this.debugSession?.status().ownedProcessCleanup === "unknown") {
      throw new Error("Debugger process cleanup is unconfirmed. Inspect /debug and owned processes before starting more work; restarting does not prove cleanup.");
    }
  }


  browserSession(): BrowserSession {
    if (!this.browser || this.browser.status().state === "closed") this.browser = new BrowserSession({
      projectRoot: this.activeWorkspaceRoot(), stateDirectory: this.projectContext!.stateDirectory,
      confirm: (request, signal) => this.confirmExact(`Browser action:\n${formatTerminalJSON(request)}\n`, "Allow this exact action? Type yes: ", signal),
    });
    // Capture the instance: the field is cleared after explicit closes (revoke, /clear),
    // but the registered close must still close the session it was registered for.
    const session = this.browser;
    this.lifecycle.add({ name: "browser", close: () => session.close() });
    return this.browser;
  }




  /** The delegate tool carries the per-task dispatch budget, so it is rebuilt only at task
   * boundaries (a new request, or an explicit /verify repair task) — never for repair rounds
   * of the current task. */
  private delegateToolForTask?: RuntimeTool;

  private delegateTool(): RuntimeTool {
    this.delegateToolForTask ??= this.subagents.createTool(() => ({
      cwd: this.activeWorkspaceRoot(),
      projectContext: formatProjectContext(this.projectContext!),
    }));
    return this.delegateToolForTask;
  }


  private confirmRename: ConfirmRename = async (preview, signal) => {
    const text = JSON.stringify(preview);
    if (Buffer.byteLength(text) > 16_384) return false;
    return this.confirmExact(`LSP rename confirmation (exact edits; zero-based UTF-16):\n${text}\n`, "Apply this exact rename? Type yes: ", signal);
  };

  /** One inline result line per check; a failed check also boxes the tail of its output, since that is
   * what a person reads next. Passing checks stay quiet (their output remains in the evidence). */
  private writeCheckResult(result: VerificationResult): void {
    this.events.ensureLineBreak();
    this.output.write(`${formatVerificationResult(result)}\n`);
    if (result.status !== "fail") return;
    for (const [stream, text] of [["stderr", result.stderr], ["stdout", result.stdout]] as const) {
      if (!text.trim()) continue;
      const lines = text.replace(/\n$/, "").split("\n");
      const shown = lines.length > 40 ? [`… ${lines.length - 40} earlier line(s) omitted; the full output stays in the check evidence`, ...lines.slice(-40)] : lines;
      this.terminal.writePanel(`${result.name}: ${stream}`, redactPreview(shown.join("\n")), { tone: "error" });
    }
  }

  private confirmCapability: ConfirmCapability = async (call, signal) => {
    const args = JSON.stringify(call.arguments);
    // Never approve truncated arguments or implicitly accept in one-shot mode.
    if (Buffer.byteLength(args) > 4096) return false;
    return this.confirmExact(`MCP confirmation: ${JSON.stringify(call.capability.id)} [${call.capability.safety}]\nArguments: ${args}\n`, "Allow this exact external call? Type yes: ", signal);
  };

  /** beforeChanges gate: deny native edit/write until one ask attempt is recorded. */
  private editGateReason(toolName: string): string | undefined {
    if (!this.editGateActive || this.asksThisTask > 0) return undefined;
    return `askQuestions is set to beforeChanges and this request looks under-specified: call the ask tool once (concrete options plus Other) before using ${toolName}. If the human skips the question, state your assumptions in the reply and continue.`;
  }

  /** Structured clarification channel: rich surface required, command abort raced, receipt recorded. */
  private askTool(): RuntimeTool {
    return askTool({
      available: () => this.interactive && this.terminal.rich && !this.closing,
      ask: (question, options, multi, signal) => {
        const signals = [signal, this.commandAbort?.signal].filter((value): value is AbortSignal => Boolean(value));
        return this.terminal.ask(question, options, multi, signals.length ? AbortSignal.any(signals) : undefined);
      },
      record: answer => {
        this.asksThisTask++;
        if (!this.closing) this.output.write(`[ask] ${answer}\n`);
      },
    });
  }

  async confirmExact(preview: string, question: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.interactive || this.closing || signal?.aborted || this.commandAbort?.signal.aborted) return false;
    const signals = [signal, this.commandAbort?.signal].filter((value): value is AbortSignal => Boolean(value));
    this.output.write("");
    const approved = await this.terminal.confirm(preview, question, signals.length ? AbortSignal.any(signals) : undefined);
    // The answer itself is never echoed (it is a fresh keystroke, not a draft); record the outcome.
    if (!this.closing) this.output.write(`[approval] ${approved ? "allowed" : "denied"}\n`);
    return approved;
  }


  private reportSkillWarnings(): void {
    const warnings = this.skillRegistry!.diagnostics.filter((warning) => !this.reportedSkillWarnings.has(warning));
    if (!warnings.length) return;
    for (const warning of warnings) this.reportedSkillWarnings.add(warning);
    this.output.write(`[skills] ${warnings.length} new warning${warnings.length === 1 ? "" : "s"}; use /skills diagnostics\n`);
  }

  private writePrompt(prompt: string): void {
    this.events.writePrompt(prompt);
  }

  /** Shift+Tab. Session-only: a held key walks the ring, and saving stays on `/effort`. */
  private cycleEffort(): void {
    if (this.closing) return;
    if (this.commandActive || this.subagents.isBusy) {
      this.terminal.flashNote("effort unchanged · wait until idle");
      return;
    }
    if (this.effortSteps >= 12) return;
    this.effortSteps++;
    this.effortCycle = this.effortCycle.then(async () => {
      try { if (!this.closing) await this.applyEffortCycle(); }
      catch (error) {
        if (!this.closing) this.terminal.flashNote(error instanceof Error ? error.message : String(error));
      } finally { this.effortSteps--; }
    });
  }

  private async applyEffortCycle(): Promise<void> {
    const session = await this.ensureRuntime();
    if (this.closing) return;
    if (!session.setEffort || !session.getStatus) {
      this.terminal.flashNote("effort controls unavailable");
      return;
    }
    const status = session.getStatus();
    if (!status.model) {
      this.terminal.flashNote("no model · use /model");
      return;
    }
    const current = status.configuredEffort ?? status.thinkingLevel;
    const next = nextEffort(current, status.availableThinkingLevels);
    if (!next || next === current) {
      this.terminal.flashNote("no other effort on this model");
      return;
    }
    const updated = await session.setEffort(next, false);
    const shown = formatEffort(updated) ?? next;
    this.terminal.flashNote(`effort ${shown} · session`);
    this.updateFooter();
  }

  updateFooter(): void {
    if (!this.projectContext) return;
    try {
      const project = this.projectContext.info;
      const status = this.session?.getStatus?.();
      const usage = this.session?.getUsage?.();
      const percent = usage?.context?.percent;
      const effort = (status && formatEffort(status)) ?? "effort —";
      const model = status?.model ? `${status.provider}/${status.model} · ${effort}`
        : this.session ? "no model selected · /model" : this.savedModelDisplay ?? "model not initialized · /model";
      this.terminal.setStatus(`${project.name}/${project.gitBranch ?? "no git"} │ ${model} │ ctx ${percent == null ? "—" : `${percent.toFixed(0)}%~`}${usage ? ` │ ${usage.tokens.total} tok` : ""}${usage?.estimatedCost === undefined ? "" : ` │ $${usage.estimatedCost.toFixed(3)} est`} │ ${this.commandActive ? "working" : "idle"}`, project.root);
    } catch { this.terminal.setStatus("Session status unavailable · /status", this.projectContext.info.root); }
  }

  private observeEdit(path: string): void {
    this.browser?.invalidate();
    (this.checkTask ?? this.verificationTask)?.invalidateForEdit(path);
    this.observations.recordEdit(path);
  }
}
