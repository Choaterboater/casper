import readline from "node:readline";
import { ProjectMemory, type TaskOutcome } from "./memory/store";
import { formatSubagentReport, SubagentManager, type SubagentRole } from "./agents/manager";
import { discoverLSPConfiguration, type LSPConfiguration } from "./lsp/config";
import { LSPManager, type ConfirmRename } from "./lsp/manager";
import { lspTools } from "./lsp/tools";
import { boundCapabilityResult } from "./capabilities/result";
import { discoverMCPConfiguration, type MCPConfiguration } from "./mcp/config";
import { MCPManager } from "./mcp/manager";
import { CapabilityBroker, type ConfirmCapability } from "./capabilities/broker";
import type { Interface as ReadlineInterface } from "node:readline";
import type { Writable, Readable } from "node:stream";
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
import { formatTaskResult, type TaskResult, type ObservedCheck } from "./task/result";
import { boundObservationText } from "./runtime/observation";
import { renderBanner, renderProjectSummary } from "./tui/banner";
import type { ProjectCommand } from "./project/model";
import { CHECK_NAMES, formatVerificationReport, formatVerificationResult, type VerificationReport } from "./verify/evidence";
import { VerifierRegistry } from "./verify/registry";
import { verifyAndRepair } from "./verify/repair-loop";
import { VerificationTask } from "./verify/task";
import { MermaidProvider } from "./visualize/mermaid";
import { MindMeshProvider } from "./visualize/mindmesh";
import { buildRepoGraph } from "./visualize/repo";
import { VisualizationRouter } from "./visualize/router";
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
  private confirmationPending = false;
  private readonly output: OutputWriter;
  private readonly input: Readable;
  private runtime?: AgentRuntime;
  private runtimeStart?: Promise<RuntimeSession>;
  private session?: RuntimeSession;
  private closing = false;
  private closeWork?: Promise<void>;
  private unsubscribe?: () => void;
  private readline?: ReadlineInterface;
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
  private taskRuntimeCancelled = false;
  private lastTaskResult?: TaskResult;
  private readonly observedEdits = new Set<string>();
  private readonly observedChecks = new Map<ProjectCommand, ObservedCheck>();
  private possibleMutations = false;
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
    }));
    this.loadMCPConfigurationFn = options.loadMCPConfiguration ?? ((context) => discoverMCPConfiguration({
      projectRoot: context.info.root, profileName: context.profileName,
    }));
    this.loadLSPConfigurationFn = options.loadLSPConfiguration ?? ((context) => discoverLSPConfiguration({
      projectRoot: context.info.root, profileName: context.profileName,
    }));
    this.output = options.output ?? process.stdout;
    this.input = options.input ?? process.stdin;
    this.autoVerify = options.autoVerify ?? false;
    this.visualizationProviders = options.visualizationProviders ?? [new MermaidProvider(), new MindMeshProvider()];
    this.sessionHomeDir = options.sessionHomeDir;
  }

  async start(cwd = process.cwd()): Promise<ProjectInfo> {
    if (this.closing) throw new Error("Casper is closing");
    if (this.projectContext) return this.projectContext.info;
    const project = await this.inspectProjectFn(cwd);
    const context = await this.loadProjectContextFn(project);
    const registry = await this.loadSkillRegistryFn(context);
    const mcpConfiguration = await this.loadMCPConfigurationFn(context);
    const lspConfiguration = await this.loadLSPConfigurationFn(context);
    if (this.closing) throw new Error("Casper is closing");
    this.projectContext = context;
    this.skillRegistry = registry;
    this.mcp = new MCPManager(mcpConfiguration);
    this.lsp = new LSPManager(context.info.root, lspConfiguration);
    this.visualization = new VisualizationRouter({ providers: this.visualizationProviders, settings: context.visualize, workspaceRoot: context.info.root });
    this.broker = new CapabilityBroker(this.mcp, (call, signal) => this.confirmCapability(call, signal));
    this.output.write(renderBanner(context));
    this.output.write(` skills    ${this.skillRegistry.list().length} indexed (use /skills)\n\n`);
    this.output.write(" memory    explicit facts; task summaries recorded locally, acceptance unknown (use /memory)\n\n");
    this.reportSkillWarnings();
    this.output.write(` mcp       ${this.mcp.status().length} configured (disconnected; use /mcp)\n\n`);
    for (const diagnostic of this.mcp.diagnostics) this.output.write(`[mcp] ${diagnostic}\n`);
    this.output.write(` lsp       ${lspConfiguration.servers.length} configured (disconnected; use /lsp)\n\n`);
    for (const diagnostic of lspConfiguration.diagnostics) this.output.write(`[lsp] ${diagnostic}\n`);
    this.output.write(` visualize ${this.visualization.providerNames().join(", ")} (${context.visualize.outputDir ? "artifacts outside workspace" : "in-conversation only"}; use /visualize)\n\n`);
    for (const diagnostic of this.visualization.diagnostics) this.output.write(`[visualize] ${diagnostic}\n`);
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

    this.writePrompt(prompt);
    return this.handlePrompt(prompt);
  }

  async runInteractive(cwd = process.cwd()): Promise<void> {
    if (!this.projectContext) {
      await this.start(cwd);
    }

    this.readline = readline.createInterface({
      input: this.input,
      output: this.output as Writable,
    });

    const rl = this.readline;
    let inputClosed = false;
    rl.once("close", () => { inputClosed = true; });
    while (!this.closing && !inputClosed) {
      const line = await new Promise<string | undefined>((resolve) => {
        const finish = (value?: string) => { rl.removeListener("close", onClose); resolve(value); };
        const onClose = () => finish();
        rl.once("close", onClose);
        rl.question("> ", finish);
      });
      if (line === undefined) break;
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
        this.output.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closing = true;
    this.verificationAbort?.abort();
    this.checkTask?.abort();
    this.visualizationAbort?.abort();
    this.subagentsClose = this.subagents.close();
    this.mcpClose = this.broker?.close();
    this.lspClose = this.lsp?.close();
    this.readline?.close();
    this.closeWork = this.finishClose();
    return this.closeWork;
  }

  private async finishClose(): Promise<void> {
    // Startup may still be in flight when termination arrives. Drain it before
    // disposing, but leave a startup error with its original prompt caller.
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
        this.readline?.close();
        try { await this.runtime?.dispose(); }
        finally { await Promise.all([this.mcpClose, this.lspClose, this.subagentsClose]); }
      }
    }
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
        this.runtime = await this.runtimeFactory();
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
        return this.session;
      }).catch(async (error) => {
        if (!this.closing) {
          const failedRuntime = this.runtime;
          this.runtime = undefined;
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
    const transition = /^\/(?:branch|switch)(?:\s|$)/.test(prompt);
    if (transition && this.subagents.isBusy) throw new Error("Wait for active subagents before changing workspaces");
    this.lastTaskResult = undefined;
    this.observedEdits.clear();
    this.observedChecks.clear();
    this.possibleMutations = false;
    this.taskRuntimeFailed = false;
    this.taskRuntimeCancelled = false;
    this.commandActive = true;
    this.workspaceTransition = transition;
    try {
      if (this.workspaceNeedsRebind) await this.rebindWorkspace(this.activeWorkspaceRoot());
      return await this.handlePromptCommand(prompt);
    } finally {
      await this.checkTask?.close();
      this.checkTask = undefined;
      this.commandActive = false;
      this.workspaceTransition = false;
    }
  }

  private async handlePromptCommand(prompt: string): Promise<VerificationReport | undefined> {
    if (this.closing) return;
    if (/^\/memory(?:\s|$)/.test(prompt)) {
      this.memoryWork = this.handleMemoryCommand(prompt);
      try { await this.memoryWork; }
      finally { this.memoryWork = undefined; }
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
    const context = this.projectContext!;
    const classification = classifyTask(prompt);
    this.lastTaskRequest = prompt;
    const selected = await this.skillRegistry!.loadForTask(prompt, context.model, classification);
    this.reportSkillWarnings();
    if (selected.length) {
      this.output.write(` skills selected: ${selected.map(({ skill }) => skill.name).join(", ")}\n`);
    }
    const skillContext = formatSelectedSkills(selected);
    const memoryContext = await new ProjectMemory(context.stateDirectory).context();
    if (this.closing) return;
    if (this.autoVerify) this.checkTask = new VerificationTask(
      VerifierRegistry.forProject(context.model, context.verification.timeoutMs), this.activeWorkspaceRoot(),
      (result) => { this.ensureLineBreak(); this.output.write(`${formatVerificationResult(result)}\n`); },
    );
    await this.prepareCapabilities(prompt, classification.intent === "visualize");
    if (this.closing) return;
    const session = await this.ensureRuntime();
    if (this.closing) return;
    let verification: VerificationReport | undefined;
    try {
      await session.prompt([
        memoryContext,
        skillContext,
        formatTaskPrompt(prompt, classification, context.model),
      ].filter(Boolean).join("\n\n"));
      if (!this.closing && !this.taskRuntimeFailed && !this.checkTask?.signal.aborted && this.checkTask?.checks.length) {
        verification = await this.runVerification(this.checkTask.checks, true, prompt, this.checkTask);
      }
    } catch (error) {
      this.taskRuntimeFailed = true;
      throw error;
    } finally {
      const execution = this.closing || this.taskRuntimeCancelled || this.checkTask?.signal.aborted ? "cancelled" : this.taskRuntimeFailed ? "failed" : "completed";
      // Keep already-executed evidence on terminal error/cancellation, but never
      // launch another command or repair prompt after the task has stopped.
      if (!verification && this.checkTask?.checks.length) verification = {
        status: "blocked", reason: `Task ${execution}; no further checks or repair.`, repairAttempts: 0,
        results: await this.checkTask.refresh(), rounds: this.checkTask.rounds,
      };
      this.lastTaskResult = { execution, verification, observedEdits: [...this.observedEdits],
        observedChecks: [...this.observedChecks.values()], possibleMutations: this.possibleMutations };
      if (!this.closing) {
        this.ensureLineBreak();
        this.output.write(`${formatTaskResult(this.lastTaskResult)}\n`);
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

  private async runVerification(
    checks: readonly ProjectCommand[],
    repair: boolean,
    request = `Make the selected verification checks pass: ${checks.join(", ")}.`,
    task?: VerificationTask,
  ): Promise<VerificationReport> {
    const context = this.projectContext!;
    const controller = new AbortController();
    const evidence = task ?? new VerificationTask(
      VerifierRegistry.forProject(context.model, context.verification.timeoutMs), this.activeWorkspaceRoot(),
      (result) => { this.ensureLineBreak(); this.output.write(`${formatVerificationResult(result)}\n`); },
    );
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
            await session.prompt(prompt);
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
    await Promise.all([this.broker?.close(), this.lsp?.close()]);
  }

  private async runtimeForWorkspaceTransition(): Promise<RuntimeSession> {
    const session = await this.ensureRuntime();
    await this.revokeWorkspaceCapabilities();
    return session;
  }

  private async rebindWorkspace(cwd: string): Promise<void> {
    await this.revokeWorkspaceCapabilities();
    const project = await this.inspectProjectFn(cwd);
    const context = await this.loadProjectContextFn(project);
    const [registry, mcpConfiguration, lspConfiguration] = await Promise.all([
      this.loadSkillRegistryFn(context),
      this.loadMCPConfigurationFn(context),
      this.loadLSPConfigurationFn(context),
    ]);
    this.projectContext = context;
    this.skillRegistry = registry;
    this.mcp = new MCPManager(mcpConfiguration);
    this.lsp = new LSPManager(context.info.root, lspConfiguration);
    this.visualization = new VisualizationRouter({ providers: this.visualizationProviders, settings: context.visualize, workspaceRoot: context.info.root });
    this.broker = new CapabilityBroker(this.mcp, (call, signal) => this.confirmCapability(call, signal));
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

  private async prepareCapabilities(task: string, includeVisualization = false): Promise<void> {
    const nextTools = [
      ...await this.broker!.prepare(task),
      this.delegateTool(),
      ...(this.checkTask ? [this.checkTask.tool()] : []),
      ...lspTools(this.lsp!, this.confirmRename),
      ...(includeVisualization ? visualizationTools({ router: this.visualization!, projectRoot: this.activeWorkspaceRoot() }) : []),
    ];
    if (this.closing) return;
    if (this.session) {
      if ((nextTools.length || this.runtimeTools.length) && !this.session.setTools) throw new Error("Runtime does not support custom capabilities");
      this.session.setTools?.(nextTools);
    }
    this.runtimeTools = nextTools;
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
        `artifacts: ${router.settings.outputDir ?? "disabled (in-conversation only)"}`,
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
    if (!this.readline || this.confirmationPending || this.closing || signal?.aborted) return false;
    this.confirmationPending = true;
    this.ensureLineBreak();
    this.output.write(preview);
    try {
      return await new Promise<boolean>((resolve) => {
        const rl = this.readline!;
        const finish = (approved: boolean) => {
          signal?.removeEventListener("abort", cancel);
          rl.removeListener("close", cancel);
          resolve(approved);
        };
        const cancel = () => finish(false);
        signal?.addEventListener("abort", cancel, { once: true });
        rl.once("close", cancel);
        rl.question(question, { signal }, (answer) => finish(answer.trim() === "yes"));
      });
    } finally { this.confirmationPending = false; }
  }

  private async handleSkillsCommand(prompt: string): Promise<void> {
    const registry = this.skillRegistry!;
    const [, action, id, sha256, ...extra] = prompt.trim().split(/\s+/);
    try {
      if (!action) {
        const skills = registry.list();
        this.output.write(skills.length ? skills.map((skill) => [
          `${skill.id} [${skill.source}; ${skill.trust}${skill.disableModelInvocation ? "; manual-only" : ""}]`,
          `  ${JSON.stringify(skill.description)}`,
          `  ${skill.filePath}`,
        ].join("\n")).join("\n\n") + "\n" : "No skills discovered.\n");
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
    for (const warning of this.skillRegistry!.diagnostics) {
      if (this.reportedSkillWarnings.has(warning)) continue;
      this.reportedSkillWarnings.add(warning);
      this.output.write(`[skills] ${warning}\n`);
    }
  }

  private writePrompt(prompt: string): void {
    if (!this.endedWithNewline) {
      this.output.write("\n");
    }

    this.output.write(`> ${prompt}\n`);
    this.endedWithNewline = true;
  }

  private handleRuntimeEvent(event: RuntimeEvent): void {
    switch (event.type) {
      case "assistant_response_end":
        // Pi may retry a provider error inside prompt(); only the final response
        // determines the stop outcome. Thrown prompt errors are handled separately.
        this.taskRuntimeCancelled = event.stopReason === "aborted";
        this.taskRuntimeFailed = !["stop", "toolUse"].includes(event.stopReason);
        break;
      case "assistant_text_delta":
        this.output.write(event.delta);
        this.endedWithNewline = event.delta.endsWith("\n");
        break;
      case "tool_start":
        this.ensureLineBreak();
        this.output.write(`• ${event.toolName}\n`);
        this.endedWithNewline = true;
        break;
      case "tool_end":
        // A failure/abort can follow partial writes. A shell success need not have
        // written anything. Keep uncertainty separate from observed edit paths.
        if (["bash", "edit", "write"].includes(event.toolName) || (event.toolName === "lsp" && event.input?.operation === "rename")) this.possibleMutations = true;
        // Successful native writes invalidate in afterFileEdit, before LSP awaits.
        // Failed writes may be partial; invalidate without claiming a completed edit.
        if (event.isError && ["edit", "write"].includes(event.toolName) && typeof event.input?.path === "string") (this.checkTask ?? this.verificationTask)?.invalidateForEdit(event.input.path);
        if (event.toolName === "bash") this.observeRuntimeCheck(event);
        this.output.write(`${event.isError ? "✗" : "✓"} ${event.toolName}\n`);
        this.endedWithNewline = true;
        break;
      case "message_end":
        this.ensureLineBreak();
        break;
      case "error":
        this.taskRuntimeFailed = true;
        this.ensureLineBreak();
        this.output.write(`[error] ${event.message}\n`);
        this.endedWithNewline = true;
        break;
    }
  }

  private observeRuntimeCheck(event: Extract<RuntimeEvent, { type: "tool_end" }>): void {
    const command = event.input?.command;
    if (!command || Buffer.byteLength(command) > 8192) return;
    const name = CHECK_NAMES.find((candidate) => this.projectContext?.model.commands[candidate]?.trim() === command.trim());
    if (!name) return;
    const output = boundObservationText(event.output?.text ?? "");
    this.observedChecks.set(name, { name, command, toolStatus: event.isError ? "error" : "success",
      output: output.text, truncated: output.truncated || Boolean(event.output?.truncated) });
  }

  private observeEdit(path: string): void {
    (this.checkTask ?? this.verificationTask)?.invalidateForEdit(path);
    if (this.observedEdits.size < 32) this.observedEdits.add(path.slice(0, 512));
  }

  private ensureLineBreak(): void {
    if (!this.endedWithNewline) {
      this.output.write("\n");
      this.endedWithNewline = true;
    }
  }
}
