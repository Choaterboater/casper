import { execFile } from "node:child_process";
import type { DebugRequest, DebugSession } from "./debug/session";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { modelPreference } from "./tui/model-preference";
import { HELP_TEXT, FULL_HELP_TEXT, LOGIN_HELP } from "./tui/help";
import { BrowserSession } from "./browser/session";
import { ServiceManager } from "./services/manager";
import { SmokeChecks, type SmokeReport } from "./services/smoke";
import { serviceTool } from "./services/tool";
import { detectWebService, isDetectedWebService } from "./services/detect";
import { formatPagesNotChecked, formatSkippedPage, PageChecks, pageOpener, planPageCheck, type DevServerNotice, type PageCheckPlan, type PageOpener, type PageReport } from "./services/page-checks";
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
import { boundCapabilityResult, NotExecutedError } from "./capabilities/result";
import { discoverMCPConfiguration, type MCPConfiguration } from "./mcp/config";
import { MCPManager, type ServerQuestionHandler } from "./mcp/manager";
import { ConsentStore } from "./mcp/consent";
import { formatApproval, maskText, planLabel, TOO_LONG_TEXT, tooLongToShow } from "./capabilities/approval";
import { CapabilityBroker, type ConfirmCapability } from "./capabilities/broker";
import { Scrubber } from "./secrets/netconan";
import { hiddenSecretGate } from "./secrets/gate";
import { scrubToolOutput } from "./secrets/tool-output";
import type { Readable } from "node:stream";
import {
  formatProjectContext,
  loadProjectContext,
  type ProjectContext,
} from "./project/context";
import { findProjectCandidates, hasProjectSignals, inspectProject, type ProjectInfo } from "./project/inspect";
import { childProjectOf, type ChildProject } from "./project/child";
import type {
  AgentRuntime,
  RuntimeAuthProvider,
  RuntimeSession,
  RuntimeModelInfo,
  RuntimeTool,
} from "./runtime/types";
import { SkillRegistry, formatSelectedSkills, skillRegistryOptions } from "./skills/registry";
import { classifyTask, formatTaskPrompt, underSpecifiedTarget } from "./task/classify";
import { formatReceipt, liveCheckLine, formatTaskResult, type TaskResult, type TaskUsage } from "./task/result";
import { TaskObservations } from "./task/observations";
import { LifecycleRegistry } from "./app/lifecycle";
import { RuntimeEventView } from "./app/events";
import { diffSnapshots, snapshotFailureReason, snapshotTree, type TreeChanges } from "./task/changes";
import { renderBanner, renderProjectSummary, wordmarkHeader } from "./tui/banner";
import { CHECK_NAMES, type CheckName, formatDuration, formatVerificationReport, formatVerificationResult, type VerificationReport, type VerificationResult } from "./verify/evidence";
import { ProcessCleanupError } from "./platform/processes";
import { safeGitArgs } from "./platform/git";
import { VerifierRegistry } from "./verify/registry";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { longerLimit, timedOutAfter, verifyAndRepair, type UnfinishedChoice } from "./verify/repair-loop";
import { ALREADY_FAILING_CHOICES, modelFailedChoices, PLAN_CHOICES, PLAN_QUESTION, REMEMBER_BIG_MODEL_CHOICES, REPAIR_LIMIT_STOP, unfinishedChoices, workFolderChoices } from "./app/safe-choices";
import { VerificationTask } from "./verify/task";
import { ChangeBaseline, changesCode, proofRepairPrompt, type ChangeProof } from "./verify/proof";
import { independentAcceptance } from "./verify/acceptance";
import { parseChecklist, parseReview, requirementsReviewPrompt, ROUND_MAX_TURNS, type RequirementsReview } from "./task/review";
import { extractChecklist, formatChecklistPrompt, normalizeCases } from "./task/checklist";
import { checkCommands, isBuiltinCheck, labNamedChecks } from "./verify/named";
import { autoDetectedChecks } from "./verify/migrations-check";
import type { NetworkToolContext } from "./verify/registry";
import { buildNextRow, type NextItem } from "./tui/next-row";
import { TaskUndo, type TaskUndoStart } from "./app/undo";
import { SuggestionController, SUGGESTION_COMMAND } from "./app/suggestions";
import { findFlow, formatFlowPrompt, loadFlowCatalog, type Flow, type FlowRule } from "./flows/catalog";
import { beforeWorkPanel, readBeforeWorkAnswer, suggestBeforeWork } from "./flows/suggest";
import { extractPlan, formatBuildPrompt, parsePlanLines, planEditorHeading, planEditorLines, planToolGate, type ParsedPlan } from "./flows/plan";
import { PROJECT_YAML, saveNamedCheck, saveProjectCommand } from "./project/config-write";
import { askLabFailure, labCheckRunner } from "./app/lab-checks";
import type { SecurityAIReview, SecurityReviewHost } from "./app/security-review";
import type { TaskClassification } from "./task/classify";
import type { ProjectCommand } from "./project/model";
import { describeChecksPlan, manualChecks, planAutoChecks, resolveVerificationMode, selectedChecks, type ChecksPlan, type VerificationMode } from "./verify/mode";
import { measuredCheckTime, recordCheckTimings } from "./verify/timings";
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
import { runLogin, runSlashCommand, type OutputWriter } from "./app/commands";
import { NEW_USAGE, parseNewArgs, UsageError } from "./cli-args";
import { checkEvent, phaseEvent, RuntimeEventMapper, sessionStartEvent, type CasperEvent, type PhaseEvent } from "./app/json-events";
import { StepRail } from "./app/steps";
import { CASPER_VERSION } from "./version";
import { createSessionSandbox, runtimeShell, sandboxReceipt, sandboxStartupNotes, sandboxStatusLine, type SandboxHost } from "./app/sandbox";
import { useSandbox, currentSandbox, type ShellSandbox, type ShellSandboxOptions } from "./sandbox/manager";
import { SandboxStore } from "./sandbox/store";
import type { RuntimeShell } from "./runtime/types";
import { askBuildRequest, buildRequestNote, isEmptyFolder, newProjectFromQuestions, newProjectInEmptyFolder, offerMissingFolder, opened,
  type NewProjectFlow } from "./app/new-project";
import { listLines } from "./new/command";
import { tildePath, type NewProjectOptions, type NewProjectResult } from "./new/scaffold";

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
  /** The secret scrubber (Casper's rules, plus netconan when installed); tests pass their own. */
  scrubber?: Scrubber;
  /** Runs git for /references add, by argv only (tests pass a stub). */
  runGit?: (argv: string[], signal?: AbortSignal) => Promise<{ code: number | null }>;
  output?: OutputWriter;
  input?: Readable;
  /** This run's verification mode (`--verify` = auto, `--no-verify` = off), over configuration.
   * Unset: configuration, then the surface default (see resolveVerificationMode). */
  verificationMode?: VerificationMode;
  /** Show the detailed evidence receipt and per-check lines instead of the plain receipt. */
  verbose?: boolean;
  /** This run's model selector (`--model`), applied when the runtime starts; never saved. */
  model?: string;
  /** This run's reasoning effort (`--effort`); never remembered. */
  effort?: string;
  /** Machine-readable events (`--json`): the session, streamed text, tools and checks. */
  onEvent?: (event: CasperEvent) => void;
  /** Stop each model request after this many turns (`--max-turns`); the task is then incomplete. */
  maxTurns?: number;
  /** Continue the workspace's latest conversation, or the saved one whose ID starts with `resume`. */
  conversation?: { continue: true } | { resume: string };
  /** Configuration warnings found before the app existed (the CLI's environment checks), printed at
   * start with the project's [config] warnings on this app's output. */
  startupWarnings?: readonly string[];
  /** Embedder shorthand: true = "offer" (model-selected casper_check plus bounded repair),
   * false = "off". Ignored when verificationMode is set. */
  autoVerify?: boolean;
  /** `casper new` on a terminal: ask what is missing, build the project in ~/Projects and open Casper there. */
  newProject?: { template?: string; name?: string };
  /** Builds a new project (casper new, the new-project questions and /new); tests pass a fake. */
  createProject?: (options: NewProjectOptions) => Promise<NewProjectResult>;
  /** Opens pages for the page check: Chrome when installed, else HTTP only. Tests pass a fake. */
  pageOpener?: (options: { projectRoot: string; stateDirectory: string }) => Promise<PageOpener>;
  /** Where network checks find their tools (PATH), temp folders and home; tests point these at fakes. */
  networkTools?: NetworkToolContext;
  /** Fake security tools and downloads for /security-review (tests). */
  securitySeams?: Pick<SecurityReviewHost, "check" | "install">;
  /** --no-sandbox: the shell sandbox is off for this run, and the receipt says so. */
  noSandbox?: boolean;
  /** Tests: the sandbox's engine, machine check or platform. */
  sandboxSeams?: Partial<ShellSandboxOptions>;
}

/** The last choice of the home-folder and folder-of-projects question. */
const NEW_PROJECT_CHOICE = "New project";

const LOGIN_PROVIDERS = ["openai-codex", "github-copilot", "anthropic", "openrouter"] as const;

/** A model for one repair: the selector Casper switches with, and the name it shows. */
interface BigModelChoice {
  query: string;
  label: string;
  /** Picked for this one repair and not saved: Casper never calls it "your big model". */
  oneOff?: true;
}

export class CasperApp {
  /** The provider of the last successful /login, preferred when Casper picks a first model. */
  loginProvider?: RuntimeAuthProvider;
  /** The current task's stages for the footer. */
  private readonly steps = new StepRail();
  private readonly runtimeFactory: () => AgentRuntime | Promise<AgentRuntime>;
  readonly subagents: SubagentManager;
  readonly inspectProjectFn: (cwd: string) => Promise<ProjectInfo>;
  private readonly loadProjectContextFn: (project: ProjectInfo) => Promise<ProjectContext>;
  private readonly loadSkillRegistryFn: (context: ProjectContext) => Promise<SkillRegistry>;
  private readonly loadMCPConfigurationFn: (context: ProjectContext) => Promise<MCPConfiguration>;
  private readonly loadLSPConfigurationFn: (context: ProjectContext) => Promise<LSPConfiguration>;
  private readonly loadReferenceConfigurationFn: (context: ProjectContext) => Promise<ReferenceConfiguration>;
  browser?: BrowserSession;
  /** Managed services live for the session, not the task (docs/SERVICES.md). */
  services?: ServiceManager;
  debugSession?: DebugSession;
  references?: ReferenceLibrary;
  lsp?: LSPManager;
  visualization?: VisualizationRouter;
  visualizationAbort?: AbortController;
  visualizationWork?: Promise<void>;
  private readonly visualizationProviders: VisualizationProvider[];
  mcp?: MCPManager;
  private mcpConsent?: ConsentStore;
  /** Re-reads MCP configuration from disk for /mcp reload; set with the loaded workspace. */
  reloadMCPConfiguration?: () => Promise<MCPConfiguration>;
  private broker?: CapabilityBroker;
  /** One shared scrubber: MCP results always, config files and command output while scrubFiles is on. */
  readonly scrubber: Scrubber;
  /** /secrets files on|off: scrub native reads of config files and config-looking command output. */
  scrubFiles = true;
  readonly runGit?: CasperAppOptions["runGit"];
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
  private readonly verificationFlag?: VerificationMode;
  private readonly verbose: boolean;
  private readonly startupWarnings: readonly string[];
  private readonly runModel?: string;
  private readonly runEffort?: string;
  private runConversation?: CasperAppOptions["conversation"];
  private readonly maxTurns?: number;
  private readonly onEvent?: (event: CasperEvent) => void;
  private readonly eventMapper = new RuntimeEventMapper();
  /** The text of the response being streamed, and of the last response that had text. */
  private responseText = "";
  private lastAnswer = "";
  /** casper_check calls in flight: their results were requested by the model, not by Casper. */
  private modelCheckCalls = 0;
  /** Turns after which --max-turns stopped the current task's model request. */
  private taskTurnLimit?: number;
  private verificationAbort?: AbortController;
  private verificationWork?: Promise<VerificationReport>;
  /** Active repair evidence; sharing it does not grant managed-tool consent. */
  private verificationTask?: VerificationTask;
  private checkTask?: VerificationTask;
  /** This task's smoke checks (configured and model-recorded); run inside the task's verification. */
  private smokeTask?: SmokeChecks;
  /** This task's page check: set when its changes reach a page of a web project in auto mode. */
  private pageTask?: { context: ProjectContext; root: string; before: Map<string, string> };
  /** The page opener of the current task (one disposable browser per task), closed when the task ends. */
  private taskPageOpener?: PageOpener;
  private readonly pageOpenerFn: NonNullable<CasperAppOptions["pageOpener"]>;
  /** The dev-server lines are printed once per session. */
  private readonly pageNotice: DevServerNotice = { shown: false };
  /** What may have changed this task's code since it started: a check the model records after that has no
   * before-the-change baseline. `before` is the task's starting tree, compared only after a shell command. */
  private taskEdits?: { before?: Map<string, string>; edited: boolean; shell: boolean; turnEnded: boolean };
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
  /** Project folders the owner chose to stay out of at "The work is in ...": not asked again this session. */
  private readonly stayedOutOf = new Set<string>();
  /** Why the last workspace snapshot failed, for the task's receipt. */
  private snapshotFailure?: string;
  private taskRuntimeFailed = false;
  /** The files from before the current task's change, while it runs: tells a failure the change caused from one already there. */
  private taskBaseline?: { baseline: ChangeBaseline; root: string };
  private cleanupError?: ProcessCleanupError;
  private readonly blockOnCleanupFailure = () => {
    this.cleanupError = new ProcessCleanupError();
    this.commandAbort?.abort(); this.verificationAbort?.abort(); this.checkTask?.abort();
    void this.session?.abort().catch(() => {});
  };
  private savedModelDisplay?: string;
  private taskRuntimeCancelled = false;
  private lastTaskResult?: TaskResult;
  /** Tokens the AI security review spent in this command (no task to carry them). */
  private commandSpent?: TaskUsage;
  /** Undo, redo, /diff and saved receipts: a copy before and after each task. */
  private readonly taskUndo = ((app: CasperApp) => new TaskUndo({
    output: { write: (text) => app.output.write(text) },
    get terminal() { return app.terminal; },
    get interactive() { return app.interactive; },
    get liveSession() { return app.session; },
    get homeDir() { return app.sessionHomeDir ?? os.homedir(); },
    stateDirectory: () => app.projectContext?.stateDirectory,
    activeRoot: () => app.activeWorkspaceRoot(),
    reloadProject: async () => { if (app.projectContext) app.projectContext = await app.loadProjectContextFn(app.projectContext.info); },
    lastTask: () => app.lastTaskResult,
  }))(this);
  /** MCP servers this task changed things through (calls you approved that were not read-only). */
  private taskChangeServers = new Set<string>();
  /** What the row under an interactive receipt offers (Undo, Show diff, suggestions...). Each source says what
   * it offers for this task, or nothing; Undo and Show diff keep slots 1 and 2, the rest follow from 3. */
  readonly nextSteps: Array<(task: TaskResult) => { undo?: NextItem; diff?: NextItem; more?: NextItem[] } | undefined> = [];
  observations = new TaskObservations();
  memoryWork?: Promise<void>;
  private readonly newProjectRequest?: CasperAppOptions["newProject"];
  private readonly createProjectFn?: CasperAppOptions["createProject"];
  private readonly networkTools?: NetworkToolContext;
  readonly securitySeams?: Pick<SecurityReviewHost, "check" | "install">;
  /** `casper new` on a terminal: the exit code when no project was opened (1 when nothing was created). */
  newProjectExitCode?: number;
  /** The build-request question is asked at most once per session. */
  private newProjectOffered = false;
  /** This task already showed its one question before work (the new-project question): no checklist panel. */
  private beforeWorkAsked = false;
  /** The next repair runs on this model (the big model), then Casper switches back. */
  private repairOnBigModel?: BigModelChoice;
  /** The user said yes to one more try on the big model at the repair limit. */
  private bigModelGrant?: BigModelChoice;
  /** Repairs this task ran on the big model, for the receipt. */
  private bigModelUse?: { model: string; attempts: number; oneOff: boolean };
  /** The repair the current verification is on, for the question at the limit. */
  private repairsTried = 0;
  /** "repair.bigModelLastTry is on but no big model is set" is said once per session. */
  private bigModelNoticeShown = false;
  /** Suggested next steps on the receipt's row, their fading, and /suggestions. Other parts register rules here. */
  readonly suggestions = new SuggestionController((text) => { if (!this.closing) this.output.write(text); }, () => this.homeDir());
  /** A plan turn is running: every tool but reading is refused (see src/flows/plan.ts). */
  private planning = false;
  /** Flow warnings (a user's flow that could not be used) are said once. */
  private readonly flowWarnings = new Set<string>();
  /** The session's shell sandbox (src/sandbox): every shell path runs in it when it can run here. */
  sandbox?: ShellSandbox;
  private shell?: RuntimeShell & { close(): Promise<void> };
  private readonly noSandbox: boolean;
  private readonly sandboxSeams?: Partial<ShellSandboxOptions>;

  constructor(options: CasperAppOptions = {}) {
    const freshPiRuntime = async () => {
      const { PiRuntime } = await import("./runtime/pi");
      return new PiRuntime();
    };
    this.runtimeFactory = options.runtimeFactory ?? freshPiRuntime;
    this.pageOpenerFn = options.pageOpener ?? pageOpener;
    this.networkTools = options.networkTools;
    this.securitySeams = options.securitySeams;
    this.subagents = new SubagentManager({ runtimeFactory: async () => {
      if (this.workspaceTransition || this.workspaceNeedsRebind) throw new Error("Workspace transition is in progress; delegation is blocked");
      const child = await (options.subagentRuntimeFactory ?? freshPiRuntime)();
      if (child === this.runtime) throw new Error("The main runtime cannot be reused as a subagent");
      return child;
    },
    // A child's file reads reach a model too: same scrubbing, same /secrets files switch (device
    // configs only; .env, credential files and secret env values are always hidden).
    scrubToolOutput: (toolName, input, texts, signal) => scrubToolOutput(this.scrubber, toolName, input, texts, signal, { configs: this.scrubFiles }),
    });
    this.lifecycle.add({ name: "subagents", close: () => this.subagents.close() });
    this.inspectProjectFn = options.inspectProject ?? inspectProject;
    this.loadProjectContextFn = options.loadProjectContext ?? loadProjectContext;
    this.loadSkillRegistryFn = options.loadSkillRegistry ?? ((context) => SkillRegistry.discover(skillRegistryOptions(context)));
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
    // ctrl+o: MCP writes off everywhere, at once, even while work runs.
    this.terminal.setWritesRevert(() => this.revertWrites());
    // Tool calls live in the event view's Working box on a rich surface; the transcript gets plain writes.
    this.output = { write: (text) => { this.terminal.write(text); } };
    this.events = new RuntimeEventView(this.terminal, this.output, {
      updateFooter: () => this.updateFooter(),
      onToolEnd: event => {
        this.observations.observeToolEnd(event, this.projectContext?.model.commands);
        if (["bash", "edit", "write"].includes(event.toolName)) this.browser?.invalidate();
        // A shell command's files are unknown, so it marks every running service stale.
        if (event.toolName === "bash") { this.services?.markEdited(); if (this.taskEdits) this.taskEdits.shell = true; }
        // Successful native writes invalidate in afterFileEdit, before LSP awaits.
        // Failed writes may be partial; invalidate without claiming a completed edit.
        if (event.isError && ["edit", "write"].includes(event.toolName) && typeof event.input?.path === "string") {
          (this.checkTask ?? this.verificationTask)?.invalidateForEdit(event.input.path);
          this.services?.markEdited(event.input.path);
          if (this.taskEdits) this.taskEdits.edited = true;
        }
      },
      setTaskStop: (cancelled, failed) => { this.taskRuntimeCancelled = cancelled; this.taskRuntimeFailed = failed; },
      markRuntimeFailed: () => { this.taskRuntimeFailed = true; },
      turnLimitReached: turns => { this.taskTurnLimit = turns; },
      cancelled: () => this.commandAbort?.signal.aborted === true,
      projectRoot: () => this.projectContext ? this.activeWorkspaceRoot() : undefined,
    });
    this.verbose = options.verbose ?? false;
    this.startupWarnings = options.startupWarnings ?? [];
    this.runModel = options.model;
    this.runEffort = options.effort;
    this.runConversation = options.conversation;
    this.maxTurns = options.maxTurns;
    this.onEvent = options.onEvent;
    this.verificationFlag = options.verificationMode
      ?? (options.autoVerify === undefined ? undefined : options.autoVerify ? "offer" : "off");
    this.visualizationProviders = options.visualizationProviders ?? [new MermaidProvider(), new MindMeshProvider()];
    this.sessionHomeDir = options.sessionHomeDir;
    this.scrubber = options.scrubber ?? new Scrubber();
    this.runGit = options.runGit;
    this.newProjectRequest = options.newProject;
    this.createProjectFn = options.createProject;
    this.noSandbox = options.noSandbox ?? false;
    this.sandboxSeams = options.sandboxSeams;
  }

  /** What the sandbox asks through: Casper's own numbered question, only while someone can answer it. */
  private sandboxHost(): SandboxHost {
    return {
      canAsk: () => this.interactive && this.terminal.canAsk && !this.closing,
      pick: (question, options, signal) => this.terminal.pick(question, options, signal ?? this.commandAbort?.signal),
      write: (text) => { if (!this.closing) this.output.write(text); },
      planning: () => this.planning,
    };
  }

  /** The new-project questions go through Casper's own numbered question, on the rich or the plain terminal. */
  private newProjectFlow(): NewProjectFlow {
    return {
      pick: (question, options, signal) => this.terminal.pick(question, options, signal),
      write: (line) => { if (!this.closing) this.output.write(`${line}\n`); },
      homeDir: this.sessionHomeDir ?? os.homedir(),
      ...(this.createProjectFn ? { create: this.createProjectFn } : {}),
      ...(this.commandAbort ? { signal: this.commandAbort.signal } : {}),
    };
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
    // The shell sandbox for this session: the AI's bash, checks, services, dev servers and Casper's tool runs.
    // A workspace switch replaces it: the old one stops first (the sandbox runtime is one per process).
    await this.lifecycle.close("sandbox").catch(() => {});
    const host = this.sandboxHost();
    const sandbox = this.sandbox = createSessionSandbox(host, context, { root: () => this.activeWorkspaceRoot(), home: this.sessionHomeDir ?? os.homedir(),
      noSandbox: this.noSandbox, ...(this.sandboxSeams ? { seams: this.sandboxSeams } : {}) });
    this.shell = runtimeShell(host, sandbox, new SandboxStore(context.stateDirectory));
    useSandbox(sandbox);
    this.lifecycle.add({ name: "sandbox", close: async () => {
      if (currentSandbox() === sandbox) useSandbox(undefined);
      await this.shell?.close(); await sandbox.close();
    } });
    this.skillRegistry = registry;
    // Remembered approval (keyed hashes only). A damaged or missing file means Casper asks again.
    const consent = new ConsentStore(this.sessionHomeDir ?? os.homedir());
    await consent.load().catch(() => {});
    this.mcpConsent = consent;
    this.mcp = new MCPManager(mcpConfiguration, {
      consent,
      elicit: (question, signal) => this.answerServerQuestion(question, signal),
      onNote: (text) => { if (!this.closing) this.output.write(`${text}\n`); },
    });
    // Re-reads the same layered files the manager was built from; the manager diffs them.
    this.reloadMCPConfiguration = () => this.loadMCPConfigurationFn(context);
    this.lsp = new LSPManager(context.info.root, lspConfiguration);
    this.visualization = new VisualizationRouter({ providers: this.visualizationProviders, settings: context.visualize, workspaceRoot: context.info.root });
    // Every server starts with writes off; only the user turns them on (/mcp writes <name>).
    this.broker = new CapabilityBroker(this.mcp, (call, signal) => this.confirmCapability(call, signal), { writesGate: true, scrubber: this.scrubber });
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
    // The header picks art or text per width, so a later resize never wraps the art.
    const wordmark = this.interactive && this.terminal.rich;
    if (wordmark) this.terminal.writeTrusted(wordmarkHeader(this.terminal.color));
    // The shell line is always there in a session; a one-shot run shows it only when nothing holds its commands.
    const shell = this.sandbox && (this.interactive || !this.sandbox.on) ? sandboxStatusLine(this.sandbox) : undefined;
    this.output.write(renderBanner(context, { wordmark, interactive: this.interactive, ...(shell ? { shell } : {}),
      ...(this.interactive ? { checks: describeChecksPlan(await this.checksPlan(context)) } : {}) }));
    for (const note of sandboxStartupNotes(context.info.root)) this.output.write(`${note}\n`);
    // A returning user's saved default is known before the runtime starts; say so, not "not initialized".
    if (!this.session) this.savedModelDisplay = await modelPreference(this.sessionHomeDir ?? os.homedir());
    // --model names the model for this run: show it, not the saved default it overrides.
    const shown = this.runModel && !this.session ? `${terminalText(this.runModel)} for this run (--model)` : this.savedModelDisplay;
    this.output.write(`${formatRuntimeStatus(this.session?.getStatus?.(), shown)}\n`);
    for (const warning of [...this.startupWarnings, ...context.warnings ?? []]) this.output.write(`[config] ${terminalText(warning)}\n`);
    for (const diagnostic of referenceConfiguration.diagnostics) this.output.write(`[references] ${formatReferenceResult(diagnostic)}\n`);
    this.reportSkillWarnings();
    for (const diagnostic of mcp.diagnostics) this.output.write(`[mcp] ${terminalText(diagnostic)}\n`);
    if (this.interactive) await this.reportImports();
    for (const diagnostic of lspConfiguration.diagnostics) this.output.write(`[lsp] ${diagnostic}\n`);
    for (const diagnostic of visualization.diagnostics) this.output.write(`[visualize] ${diagnostic}\n`);
    if (this.interactive) this.output.write("\n");
    return project;
  }

  /** Next commands in a receipt are slash commands in a session, casper invocations otherwise. */
  private receiptSurface(): "interactive" | "one-shot" {
    return this.interactive ? "interactive" : "one-shot";
  }

  /** A one-shot run in another folder (`--cd`): its undo command names that folder. */
  private receiptFolder(root: string): { folder?: string } {
    if (this.interactive) return {};
    // The working folder is always a real path; the project may be named through a link (macOS's /var).
    let real = root;
    try { real = realpathSync(root); } catch { /* gone: compare as named */ }
    const inside = [root, real].some((base) => {
      const relative = path.relative(base, process.cwd());
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    return inside ? {} : { folder: tildePath(root, this.sessionHomeDir ?? os.homedir()) };
  }

  /** Last normal coding/chat request; local commands other than /receipt clear it. Not acceptance evidence. */
  /** Whether the session's shell sandbox holds its commands and checks, for a receipt with no task. */
  sandboxReceipt(): TaskResult["sandbox"] | undefined { return sandboxReceipt(this.sandbox); }

  /** What a command outside a task spent on the model this run (the AI security review), for the receipt. */
  commandUsage(): TaskUsage | undefined { return this.commandSpent ? { ...this.commandSpent } : undefined; }

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

  /** Interactive startup from the home directory, or from a folder that only holds projects (not a
   * project itself and not inside a git repository), asks which project to open — a launch from ~
   * silently made the whole home directory the workspace, and tasks then scanned all of it. A typed
   * path is validated and must stay inside the launch folder; Esc/empty keeps it. Without a rich
   * surface the question cannot render, so the launch folder is stated plainly. */
  private async openProjectFolder(cwd: string): Promise<string> {
    const home = this.sessionHomeDir ?? os.homedir();
    const fromHome = path.resolve(cwd) === path.resolve(home);
    let candidates: string[] | undefined;
    if (!fromHome) {
      if (await hasProjectSignals(cwd) || (await inspectProject(cwd)).isGit) return cwd;
      candidates = await findProjectCandidates(cwd, { homeDir: home });
      // An empty folder: one numbered question, on either terminal, offers to start a project right here.
      // Piped input can't answer it, so a pipe gets the command instead.
      // A resumed conversation already belongs to this folder: no question.
      if (!candidates.length && !this.runConversation && await isEmptyFolder(cwd)) {
        if (!this.terminal.canAsk) { this.output.write("[folder] This folder is empty. To start a new project in ~/Projects: casper new\n"); return cwd; }
        const result = await this.newProjectFlowWithAbort((flow) => newProjectInEmptyFolder(flow, cwd));
        if (opened(result)) return result.dir;
        // "Not now" means this folder: a later build request doesn't ask again.
        this.newProjectOffered = true;
        return cwd;
      }
      if (!candidates.length) return cwd;
    }
    if (!this.terminal.rich) {
      // The CLI takes no folder argument (`casper <path>` is a prompt), so only restarting works.
      this.output.write(fromHome ? `[folder] Opened in your home directory; restart from a project folder: cd ~/Projects/myapp && casper\n`
        : `[folder] This folder holds several projects; restart from one of them: cd ${terminalText(path.relative(cwd, candidates![0]!))} && casper\n`);
      this.output.write("[folder] To start a new project instead: casper new\n");
      return cwd;
    }
    candidates ??= await findProjectCandidates(cwd, { homeDir: home });
    const base = fromHome ? home : cwd;
    const folderLabel = (folder: string) => fromHome
      ? folder === home ? "~" : `~${folder.slice(home.length)}`
      : folder === cwd ? "." : path.relative(cwd, folder);
    // Messages name the folder: "staying in Documents", never "staying in .".
    const folderName = fromHome ? "your home folder" : path.basename(cwd) || cwd;
    const byLabel = new Map<string, string>(candidates.map(candidate => [folderLabel(candidate), candidate]));
    const answer = await this.terminal.ask(
      fromHome ? "Opened from your home folder. Work in which project?" : "This folder holds several projects. Work in which one?",
      // The projects lead, so Enter opens the first; staying put is the last choice.
      [
        ...candidates.slice(0, 6).map(candidate => ({ label: folderLabel(candidate) })),
        { label: folderLabel(cwd), description: fromHome ? "stay in the home folder" : ` stay in ${path.basename(cwd)}` },
        { label: NEW_PROJECT_CHOICE, description: fromHome ? "start one in ~/Projects" : ` start one in ${path.basename(cwd)}` },
      ],
      false,
    );
    const choice = answer?.[0]?.trim();
    if (!choice) return cwd; // Esc, empty, or the plain-line fallback keeps the launch folder.
    if (choice === NEW_PROJECT_CHOICE) {
      const result = await this.newProjectFlowWithAbort((flow) => newProjectFromQuestions(flow, {}, fromHome ? undefined : cwd));
      return opened(result) ? result.dir : cwd;
    }
    const resolved = byLabel.get(choice) ?? path.resolve(cwd, choice.replace(/^~(?=\/|$)/, home));
    const relative = path.relative(path.resolve(base), path.resolve(resolved));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      this.output.write(`[folder] ${terminalText(choice)} is outside ${fromHome ? "your home directory" : "the folder you opened"}; staying in ${folderName}.\n`);
      return cwd;
    }
    const info = await stat(resolved).catch(() => undefined);
    if (!info) {
      // A name that isn't there: offer to make it (Enter stays). From home it goes in ~/Projects, like /new.
      const result = await this.newProjectFlowWithAbort((flow) => offerMissingFolder(flow, terminalText(choice), fromHome ? undefined : cwd,
        folderName, fromHome ? "in ~/Projects" : "here"));
      return opened(result) ? result.dir : cwd;
    }
    if (!info.isDirectory()) {
      this.output.write(`[folder] ${terminalText(choice)} is not a folder; staying in ${folderName}.\n`);
      return cwd;
    }
    return resolved;
  }

  /** Startup questions run before any command, so they get their own cancel (Ctrl+C, close). */
  private async newProjectFlowWithAbort<T>(work: (flow: NewProjectFlow) => Promise<T>): Promise<T> {
    const outer = { active: this.commandActive, abort: this.commandAbort };
    this.commandActive = true;
    this.commandAbort = outer.abort ?? new AbortController();
    try { return await work(this.newProjectFlow()); }
    finally { this.commandActive = outer.active; this.commandAbort = outer.abort; }
  }

  async runInteractive(cwd = process.cwd()): Promise<void> {
    // Own the terminal before the banner so startup output is transcript, not
    // loose text a later redraw would drop.
    this.interactive = true;
    this.terminal.start();
    let workspace = cwd;
    if (!this.projectContext && this.newProjectRequest) {
      // `casper new` on a terminal: the project first, then Casper opens there. Nothing built: no session.
      const result = await this.newProjectFlowWithAbort((flow) => newProjectFromQuestions(flow, this.newProjectRequest!));
      if (!opened(result)) {
        if (!result && !this.closing) this.output.write("Nothing was created.\n");
        this.newProjectExitCode = result?.exitCode ?? 1;
        this.terminal.close();
        this.interactive = false;
        return;
      }
      workspace = result.dir;
    } else if (!this.projectContext) workspace = await this.openProjectFolder(cwd);
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

  /** The row under the receipt: numbered, plain, and never waited on. A source that throws offers nothing. */
  private async offerNextSteps(task: TaskResult, request?: string, classification?: TaskClassification): Promise<void> {
    let undo: NextItem | undefined, diff: NextItem | undefined;
    const more: NextItem[] = [];
    for (const source of this.nextSteps) {
      let offered;
      try { offered = source(task); } catch { continue; }
      undo ??= offered?.undo; diff ??= offered?.diff;
      more.push(...offered?.more ?? []);
    }
    // Suggested flows follow the other steps; nothing about them waits or asks.
    let hint: string | undefined;
    if (request !== undefined && classification && this.projectContext) {
      const suggested = await this.suggestions.items({ context: this.projectContext, task, request, classification,
        interactive: this.interactive, taken: more.length }).catch(() => ({ items: [] as NextItem[], hint: undefined }));
      more.push(...suggested.items);
      hint = suggested.hint;
    }
    if (this.closing) return;
    // Undo and Show diff of this task, unless a source offered its own.
    const own = this.taskUndo.nextItems(task);
    undo ??= own.undo; diff ??= own.diff;
    this.terminal.offerNext(buildNextRow({ undo, diff, more, ...(hint ? { hint } : {}) }));
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
          // A plan turn refuses every tool but reading, whatever the tool says about itself.
          beforeToolGate: (toolName, input) => (this.planning ? planToolGate(toolName, input) : undefined)
            ?? hiddenSecretGate(toolName, input)
            ?? (toolName === "edit" || toolName === "write" ? this.editGateReason(toolName) : undefined),
          // Config files and config-looking command output (/secrets files off stops these for this
          // session), plus .env, credential files and secret env values (always).
          scrubToolOutput: (toolName, input, texts, signal) => scrubToolOutput(this.scrubber, toolName, input, texts, signal, { configs: this.scrubFiles }),
          ...(this.shell ? { shell: this.shell } : {}),
        });
        const resumeNotice = await (await this.ensureSessionWorkspace()).resumeActive(this.session);
        if (resumeNotice) this.output.write(`[sessions] ${resumeNotice}\n`);
        await this.applyRunConversation(this.session);
        await this.applyRunSelection(this.session);
        this.unsubscribe = this.session.subscribe(event => {
          if (event.type === "tool_start" && event.toolName === "casper_check") this.modelCheckCalls++;
          if (event.type === "tool_end" && event.toolName === "casper_check") this.modelCheckCalls = Math.max(0, this.modelCheckCalls - 1);
          this.observations.observeUsage(event);
          if (event.type === "assistant_response_start") this.responseText = "";
          else if (event.type === "assistant_text_delta") this.responseText = (this.responseText + event.delta).slice(-65_536);
          else if (event.type === "assistant_response_end" && this.responseText.trim()) this.lastAnswer = this.responseText;
          this.events.handle(event);
          if (this.onEvent) for (const mapped of this.eventMapper.map(event)) this.onEvent(mapped);
        });
        if (this.onEvent) {
          let conversation: string | undefined;
          try { conversation = this.session.getSessionInfo?.().sessionId; } catch { /* no persistence: no ID */ }
          this.onEvent(sessionStartEvent({ casper: CASPER_VERSION, cwd: context.info.root, session: conversation, status: this.session.getStatus?.() }));
        }
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

  /** `--continue`/`--resume` pick a saved conversation of this workspace before the first request.
   * Applied once: a later runtime restart keeps whatever conversation is active by then. Like
   * /resume, an interactive session binds its named session to the conversation; a one-shot run
   * does not, so it never changes what later runs open. */
  private async applyRunConversation(session: RuntimeSession): Promise<void> {
    const request = this.runConversation;
    if (!request) return;
    const flag = "resume" in request ? "--resume" : "--continue";
    if (!session.listConversations || !session.resumeConversation) throw new UsageError(`${flag}: this runtime does not support saved conversations.`);
    // A new conversation is not listed until its first response is saved; a restored one is.
    const saved = await session.listConversations();
    let target: string | undefined;
    if ("resume" in request) {
      const matches = saved.filter((conversation) => conversation.id.startsWith(request.resume));
      if (!matches.length) throw new UsageError(`--resume: no saved conversation in this workspace starts with "${request.resume}". Run casper /resume to list them.`);
      if (matches.length > 1) throw new UsageError(`--resume: "${request.resume}" matches ${matches.length} conversations; give more of the ID.`);
      target = matches[0]!.id;
    } else target = [...saved].sort((a, b) => b.modified.localeCompare(a.modified))[0]?.id;
    this.runConversation = undefined;
    if (!target) { this.output.write("[session] No earlier conversation in this workspace; starting a new one.\n"); return; }
    let current: string | undefined;
    try { current = session.getSessionInfo?.().sessionId; } catch { /* no persistence */ }
    if (target !== current) {
      await session.resumeConversation(target, { keepUnwritten: false });
      if (this.interactive && session.getSessionInfo) await (await this.ensureSessionWorkspace()).rememberConversation(session);
    }
    this.output.write(`[session] Continuing conversation ${target}.\n`);
  }

  /** `--model`/`--effort` select for this conversation only (persist: false), before any request.
   * A selector or level the catalog rejects is a usage error; missing credentials are not. */
  private async applyRunSelection(session: RuntimeSession): Promise<void> {
    const flagError = (flag: string, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return /^Credential/.test(message) ? new Error(message) : new UsageError(`${flag}: ${message}`);
    };
    if (this.runModel) {
      if (!session.selectModel) throw new UsageError("--model: this runtime does not support model selection.");
      let selected: boolean;
      try { selected = (await session.selectModel({ query: this.runModel, persist: false })).selected; }
      catch (error) { throw flagError("--model", error); }
      if (!selected) throw new UsageError(`--model: Unknown model "${this.runModel}". Run casper /model to list models.`);
    }
    if (this.runEffort) {
      if (!session.setEffort) throw new UsageError("--effort: this runtime does not support effort controls.");
      try { await session.setEffort(this.runEffort, false); }
      catch (error) { throw flagError("--effort", error); }
    }
  }

  private async handlePrompt(prompt: string): Promise<VerificationReport | undefined> {
    if (this.closing) return;
    if (this.commandActive) throw new Error("Another command is active; wait for active subagents or workspace transition");
    // Keep local status/help and cleanup available, but never forget an uncertain
    // tree just because its originating command or model tool has finished.
    if (!/^\/(?:help(?: all)?|status|project|permissions|mcp|lsp|browser|debug|services|exit|quit|browser close|debug stop)$/.test(prompt)
      && !/^\/(?:mcp|lsp) disconnect\s/.test(prompt) && !/^\/services (?:logs|stop)\s/.test(prompt)) {
      if (this.cleanupError) throw this.cleanupError;
      this.browser?.assertCleanup(); this.mcp?.assertCleanup(); this.lsp?.assertCleanup(); this.services?.assertCleanup();
    }
    const transition = /^\/(?:branch|switch)(?:\s|$)/.test(prompt);
    if (transition && this.subagents.isBusy) throw new Error("Wait for active subagents before changing workspaces");
    // /receipt, /undo, /redo and /diff read the last task; every other command starts without it.
    if (!/^\/(?:receipt|undo|redo|diff)(?:\s|$)/.test(prompt)) this.lastTaskResult = undefined;
    this.taskRuntimeFailed = false;
    this.taskTurnLimit = undefined;
    this.events.clearError();
    this.taskRuntimeCancelled = false;
    this.commandActive = true;
    this.commandAbort = new AbortController();
    this.commandSpent = undefined;
    this.updateFooter();
    this.workspaceTransition = transition;
    try {
      // A Shift+Tab that arrived with this submit still applies; new presses see commandActive and wait.
      while (this.effortSteps > 0) await this.effortCycle;
      if (this.closing) return;
      if (this.workspaceNeedsRebind) await this.rebindWorkspace(this.activeWorkspaceRoot());
      // Whatever follows a receipt either picks one of its suggestions or leaves them (they fade when ignored).
      // Nothing on offer: no extra wait, so a close that arrives with this line still finds the command running.
      if (this.suggestions.pending) await this.suggestions.settle(prompt, this.projectContext);
      else this.suggestions.forgetChoice();
      return await (prompt.startsWith("/") ? this.handleSlashCommand(prompt) : this.runModelTask(prompt));
    } catch (error) {
      if (error instanceof ProcessCleanupError) this.cleanupError = error;
      throw error;
    } finally {
      try {
        await this.checkTask?.close();
        if (!prompt.startsWith("/")) await this.browser?.close();
        const opener = this.taskPageOpener;
        this.taskPageOpener = undefined;
        await opener?.close().catch(() => {});
      } catch (error) {
        if (error instanceof ProcessCleanupError) this.cleanupError = error;
        throw error;
      } finally {
        // With the task's checks: the service tool must not record into them from a later, non-task prompt.
        this.checkTask = undefined;
        this.smokeTask = undefined;
        this.pageTask = undefined;
        this.taskEdits = undefined;
        this.commandActive = false;
        this.workspaceTransition = false;
        this.updateFooter();
      }
    }
  }

  /** Local command dispatch moved to app/commands.ts; the app is the command host. */
  private handleSlashCommand(prompt: string): Promise<VerificationReport | undefined> {
    if (/^\/new(?:\s|$)/.test(prompt)) return this.newProjectCommand(prompt.slice(4).trim()).then(() => undefined);
    if (/^\/suggestions(?:\s|$)/.test(prompt)) {
      return this.suggestions.command(prompt.slice(12).trim(), this.projectContext).then((text) => { this.output.write(text); return undefined; });
    }
    if (prompt.startsWith(`${SUGGESTION_COMMAND} `) || prompt === SUGGESTION_COMMAND) return this.runSuggestion(prompt.slice(SUGGESTION_COMMAND.length).trim());
    const undoCommand = /^\/(undo|redo|diff|receipt)(?:\s+(.*))?$/.exec(prompt);
    if (undoCommand) return this.undoCommand(undoCommand[1] as "undo" | "redo" | "diff" | "receipt", (undoCommand[2] ?? "").trim());
    if (/^\/plan(?:\s|$)/.test(prompt)) {
      const request = prompt.slice(5).trim();
      if (!request) { this.output.write("Usage: /plan <request>. The model plans first; nothing is built until you choose Build.\n"); return Promise.resolve(undefined); }
      return this.runModelTask(request, { planFirst: true });
    }
    return runSlashCommand(this, prompt);
  }

  /** /undo, /redo, /diff and /receipt. With no task in this folder yet, /diff shows git's view and /receipt the
   * session's last task, as before. */
  private async undoCommand(command: "undo" | "redo" | "diff" | "receipt", argument: string): Promise<undefined> {
    const signal = this.commandAbort?.signal;
    if (command === "undo" || command === "redo") {
      await this.taskUndo[command](argument, signal);
      // A one-shot run's receipt (--json) names the files undo or redo changed; nothing checked them.
      if (!this.interactive && this.taskUndo.lastRestored.length) this.lastTaskResult = { execution: "completed", changedPaths: [...this.taskUndo.lastRestored] };
    }
    else if (command === "diff") { if (!(await this.taskUndo.diff(argument, signal))) await runSlashCommand(this, "/diff"); }
    else if (!argument && this.lastTaskResult) await runSlashCommand(this, "/receipt");
    else if (!(await this.taskUndo.receipt(argument))) await runSlashCommand(this, "/receipt");
    return undefined;
  }

  /** The one project folder inside the open folder that holds every file this task changed, when the open folder
   * is not a project itself (Documents, not a repository). */
  private async childProjectOfTask(context: ProjectContext, changed: readonly string[]): Promise<ChildProject | undefined> {
    const root = context.info.root;
    if (!changed.length || context.info.isGit || await hasProjectSignals(root)) return undefined;
    return childProjectOf(root, changed, this.sessionHomeDir ?? os.homedir()).catch(() => undefined);
  }

  /** That project's own detected checks (python -m unittest, pytest, bun test ...), run once in its folder, in the
   * shell sandbox like every check, for this task's receipt. No repair: the conversation's folder is this one.
   * Undefined when the child has no check for these files. */
  private async runChildChecks(child: ChildProject, changed: readonly string[]): Promise<VerificationReport | undefined> {
    const prefix = `${child.relative}/`;
    const inside = changed.filter((file) => file.split(path.sep).join("/").startsWith(prefix)).map((file) => file.split(path.sep).join("/").slice(prefix.length));
    const plan = planAutoChecks({ commands: child.model.commands, scopes: child.model.verificationScopes, changedPaths: inside });
    if (!plan.run.length) return undefined;
    const label = `checks from ${child.relative}`;
    this.events.ensureLineBreak();
    this.output.write(`… Casper checking: ${plan.run.join(", ")} (${terminalText(label)})\n`);
    const registry = VerifierRegistry.forProject(child.model, this.projectContext!.verification.timeoutMs, this.blockOnCleanupFailure, this.networkOptions());
    this.phase("checks", "start");
    try {
      const results: VerificationResult[] = [];
      await registry.run(plan.run, { ...(this.commandAbort ? { signal: this.commandAbort.signal } : {}),
        onResult: (result) => { const labelled = { ...result, label }; results.push(labelled); this.writeCheckResult(labelled); } });
      const status = results.some((result) => result.status === "fail") ? "fail" as const
        : results.length && results.every((result) => result.status === "pass") ? "pass" as const : "incomplete" as const;
      return { status, repairAttempts: 0, rounds: [results], results };
    } finally { this.phase("checks", "end"); }
  }

  /** After the receipt: "The work is in ~/Documents/mist-tools. 1 Stay here · 2 Switch there". Enter stays. A run
   * that can't ask says the command to use. */
  private async offerWorkFolder(child: ChildProject): Promise<void> {
    const home = this.sessionHomeDir ?? os.homedir();
    const display = terminalText(tildePath(child.dir, home));
    if (!this.interactive || !this.terminal.canAsk) {
      this.output.write(`[folder] The work is in ${display}. To work there: cd ${display} && casper\n`);
      return;
    }
    // Asked once per folder: after "Stay here", later tasks in the same project don't ask again this session.
    if (this.stayedOutOf.has(child.dir)) return;
    const choices = workFolderChoices(terminalText(path.basename(this.activeWorkspaceRoot())), terminalText(child.relative));
    const picked = await this.terminal.pick(`The work is in ${display}.`, choices, this.commandAbort?.signal);
    if (this.closing) return;
    if (picked?.trim() !== choices[1]!.label) { this.stayedOutOf.add(child.dir); return; }
    await this.moveWorkspace(child.dir);
  }

  /** Moves Casper to another folder. Before the model starts it just opens it. After, the conversation here ends
   * (it stays in /resume in this folder) and the next request starts a new one there. */
  private async moveWorkspace(dir: string): Promise<void> {
    if (!this.canMoveWorkspace()) {
      if (this.subagents.isBusy) { this.output.write("[folder] Helpers are still working; nothing moved.\n"); return; }
      await this.revokeWorkspaceCapabilities();
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      const runtime = this.runtime;
      this.session = undefined;
      this.runtimeStart = undefined;
      this.runtimeLoad = undefined;
      this.runtime = undefined;
      this.sessionWorkspace = undefined;
      this.runConversation = undefined;
      await runtime?.dispose().catch(() => {});
      await this.openWorkspaceBeforeRuntime(dir);
      this.output.write("[folder] Your next request starts a new conversation there; the one here stays in /resume in the old folder.\n");
      return;
    }
    await this.openWorkspaceBeforeRuntime(dir);
  }

  /** The workspace can move only before the model starts: the conversation's folder is fixed once it exists. */
  private canMoveWorkspace(): boolean {
    return !this.session && !this.runtimeStart && !this.sessionWorkspace && !this.sessionWorkspaceStart && !this.runConversation
      && !this.runtimeTools.length;
  }

  /** Opens a new project's folder as the workspace before any model runtime exists, so the conversation starts there. */
  private async openWorkspaceBeforeRuntime(dir: string): Promise<void> {
    await this.revokeWorkspaceCapabilities();
    const { context } = await this.loadWorkspace(dir);
    this.workspaceNeedsRebind = false;
    this.output.write(`[folder] Working in ${terminalText(tildePath(context.info.root, this.sessionHomeDir ?? os.homedir()))}\n`);
    this.updateFooter();
  }

  /**
   * `/project <name>`: a project folder inside this one (typed as a path, or the name of one Casper finds two
   * levels down). Before the model starts Casper opens it; a name that isn't there offers "1 Stay in Documents ·
   * 2 Make <name> here" (Enter stays). Once the conversation has started its folder is fixed, so Casper says the
   * command to use instead.
   */
  async openProjectCommand(name: string): Promise<void> {
    const root = this.activeWorkspaceRoot();
    const home = this.sessionHomeDir ?? os.homedir();
    const folder = path.basename(root) || root;
    const typed = terminalText(name);
    const inside = (dir: string) => { const relative = path.relative(root, dir); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); };
    const direct = path.resolve(root, name.replace(/^~(?=\/|$)/, home));
    let target: string | undefined;
    if (inside(direct) && (await stat(direct).catch(() => undefined))?.isDirectory()) target = direct;
    else {
      const wanted = name.toLowerCase().replace(/\/+$/, "");
      target = (await findProjectCandidates(root, { homeDir: home })).find((dir) => inside(dir)
        && (path.basename(dir).toLowerCase() === wanted || path.relative(root, dir).split(path.sep).join("/").toLowerCase() === wanted));
    }
    if (target && !this.canMoveWorkspace()) {
      const display = terminalText(tildePath(target, home));
      this.output.write(`[folder] This conversation stays in ${terminalText(folder)}. To work in ${terminalText(path.basename(target))}: cd ${display} && casper\n`);
      return;
    }
    if (target) { await this.openWorkspaceBeforeRuntime(target); return; }
    if (!this.canMoveWorkspace() || !this.interactive || !this.terminal.canAsk) {
      this.output.write(`[folder] ${typed} isn't a folder in ${terminalText(folder)}. To start it as a new project: ${this.interactive ? "/new" : "casper new"} ${typed}\n`);
      return;
    }
    const result = await offerMissingFolder(this.newProjectFlow(), typed, root, terminalText(folder));
    if (this.closing || !opened(result) || this.commandAbort?.signal.aborted) return;
    await this.openWorkspaceBeforeRuntime(result.dir);
  }

  /** /new [name] | /new <template> <name> | /new --list: the same local build as `casper new`, no model. */
  private async newProjectCommand(args: string): Promise<void> {
    const words = args ? args.split(/\s+/) : [];
    const usage = NEW_USAGE.replace(/casper new/g, "/new");
    const command = parseNewArgs(words);
    if (!command) { this.output.write(`${usage}\n`); return; }
    if (command.list) { this.output.write(`${listLines().join("\n")}\n`); return; }
    if ((!this.interactive || !this.terminal.canAsk) && (!command.template || !command.name)) {
      this.output.write(`/new needs a template and a name when Casper can't ask. ${usage}\n`);
      return;
    }
    const result = await newProjectFromQuestions(this.newProjectFlow(), command);
    if (this.closing) return;
    if (!result) { this.output.write("Nothing was created.\n"); return; }
    if (!opened(result) || this.commandAbort?.signal.aborted) return;
    if (this.canMoveWorkspace()) { await this.openWorkspaceBeforeRuntime(result.dir); return; }
    this.output.write(`[folder] This conversation stays in ${terminalText(tildePath(this.activeWorkspaceRoot(), this.sessionHomeDir ?? os.homedir()))}. `
      + `Open the new project with: cd ${terminalText(result.displayDir)} && casper\n`);
  }

  /**
   * A build request outside a project, before the model starts: one numbered question, zero tokens.
   * Yes (2) builds the project and opens it, so the conversation and its checks start there. Use this folder
   * (1, Enter) or Esc changes nothing. One-shot and --json runs can't ask: they keep the folder and say so.
   * "stop" when the project could not be built: nothing goes to the model.
   */
  private async offerNewProject(prompt: string): Promise<"stop" | undefined> {
    if (this.newProjectOffered || !this.canMoveWorkspace()) return undefined;
    const context = this.projectContext!;
    if (context.info.isGit || await hasProjectSignals(context.info.root)) return undefined;
    if (!this.interactive || !this.terminal.canAsk) {
      const note = buildRequestNote(prompt);
      if (note) { this.newProjectOffered = true; this.output.write(`${note}\n`); }
      return undefined;
    }
    const answer = await askBuildRequest(this.newProjectFlow(), prompt);
    if (!answer) return undefined;
    this.newProjectOffered = true;
    this.beforeWorkAsked = true;
    if (this.closing || this.commandAbort?.signal.aborted) return "stop";
    if ("keep" in answer) return undefined;
    if ("stopped" in answer) { this.output.write("Nothing was sent to the model.\n"); return "stop"; }
    await this.openWorkspaceBeforeRuntime(answer.result.dir);
    return undefined;
  }

  /** A bundled flow, or the user's own trusted replacement. Warnings about a user flow are said once. */
  private async flow(rule: FlowRule): Promise<Flow | undefined> {
    const catalog = await loadFlowCatalog(this.skillRegistry).catch(() => undefined);
    for (const warning of catalog?.warnings ?? []) {
      if (this.flowWarnings.has(warning)) continue;
      this.flowWarnings.add(warning);
      this.output.write(`${terminalText(warning)}\n`);
    }
    return catalog ? findFlow(catalog, rule) : undefined;
  }

  /** `/suggestion <id>`: the key under a receipt that picked a suggestion. Only one on offer right then runs. */
  private async runSuggestion(id: string): Promise<VerificationReport | undefined> {
    const picked = this.suggestions.take(id);
    if (!picked) {
      this.output.write("[suggestions] That suggestion is not on offer now. Suggestions are picked by their number right after a receipt.\n");
      return undefined;
    }
    const { action } = picked.choice;
    if (action.kind === "remember-command") {
      const context = this.projectContext!;
      try {
        const written = await saveProjectCommand(context.info.root, action.name, action.command);
        // The write is undoable: its own receipt holds the file's text before and after.
        const saved = await this.taskUndo.recordSetting(context.info.root, `Remember ${action.command} as this project's ${action.name} command`,
          { file: PROJECT_YAML, line: written.line, before: written.before, after: written.after }).catch(() => undefined);
        this.output.write(`[project] Saved ${terminalText(written.line)} in ${PROJECT_YAML}${saved ? `. /undo ${saved} takes it back` : ""}\n`);
        if (saved && this.interactive) this.terminal.offerNext(buildNextRow({ undo: { label: "Undo", command: `/undo ${saved}` } }));
        // The next task checks with it.
        try { this.projectContext = await this.loadProjectContextFn(context.info); }
        catch (error) { this.output.write(`[project] ${PROJECT_YAML} could not be read again (${terminalText(error instanceof Error ? error.message : String(error))}); restart Casper to use it.\n`); }
      } catch (error) {
        this.output.write(`[project] Not saved: ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
      }
      return undefined;
    }
    if (action.kind === "save-check") { await this.saveFoundCheck(action.name); return undefined; }
    if (action.kind === "run") {
      const text = await action.run();
      if (text && !this.closing) this.output.write(`${terminalText(text)}\n`);
      return undefined;
    }
    const flow = await this.flow(action.flow);
    if (!flow) { this.output.write(`[suggestions] The ${action.flow} flow could not be loaded.\n`); return undefined; }
    const request = action.flow === "prove-fix"
      ? `Add a test that proves this bug stays fixed: the test must fail without the fix and pass with it. The fix was for: ${picked.request}`
      : picked.request;
    return this.runModelTask(request, { flow });
  }

  /**
   * The plan turn of plan first. The model reads and answers with "Plan:" steps and "Tests:" cases; every tool but
   * reading is refused meanwhile. The user edits the plan (rich terminal), then both terminals ask Stop or Build; a run
   * that cannot ask stops after showing the plan. "stop" when nothing is to be built.
   */
  private async runPlanTurn(session: RuntimeSession, request: string, cases: readonly string[] | undefined, root: string):
    Promise<{ plan: ParsedPlan; changed?: string[] } | "stop"> {
    const signal = this.commandAbort?.signal;
    const flow = await this.flow("plan-first");
    if (!flow) { this.output.write("[plan] The plan-first flow could not be loaded; nothing was built.\n"); return "stop"; }
    this.events.ensureLineBreak();
    this.output.write("… Casper planning first: the model reads and writes a plan; Casper blocks the file changes it can see until you choose Build\n");
    const before = await this.snapshotWorkspace(root, signal);
    this.lastAnswer = "";
    this.planning = true;
    try {
      await session.prompt([
        formatFlowPrompt(flow, request),
        ...(cases?.length ? [`Cases the user listed (put each under Tests:):\n${cases.map((item) => `- ${item}`).join("\n")}`] : []),
      ].join("\n\n"), signal, { request, maxTurns: this.maxTurns });
    } finally { this.planning = false; }
    if (this.closing || signal?.aborted || this.taskRuntimeCancelled) return "stop";
    // Casper blocks what it can see; anything that changed anyway is named, never hidden.
    const after = before && !this.closing ? await this.snapshotWorkspace(root) : undefined;
    const diff = before && after ? diffSnapshots(before, after) : undefined;
    const changed = diff ? [...diff.added, ...diff.modified, ...diff.removed].sort() : undefined;
    if (changed?.length) this.output.write(`• Changed while planning: ${changed.map((file) => terminalText(file)).join(", ")}\n`);
    if (this.taskRuntimeFailed) { this.output.write("[plan] The model failed while planning; nothing was built.\n"); return "stop"; }
    const parsed = extractPlan(this.lastAnswer);
    if (!parsed.steps.length) {
      this.output.write("[plan] The answer had no numbered Plan: steps, so nothing was built. Ask again, or send the request without /plan.\n");
      return "stop";
    }
    let plan: ParsedPlan = { steps: parsed.steps, tests: parsed.tests.length ? parsed.tests : normalizeCases([...(cases ?? [])]) };
    const { heading, hint } = planEditorHeading(plan);
    this.events.ensureLineBreak();
    let edited = false;
    if (this.interactive && this.terminal.rich) {
      const lines = await this.terminal.editLines(heading, hint, planEditorLines(plan), signal);
      if (this.closing || signal?.aborted) return "stop";
      const kept = lines ? parsePlanLines(lines) : undefined;
      if (!kept?.steps.length) { this.output.write("[plan] Stopped without building.\n"); return "stop"; }
      edited = planEditorLines(kept).join("\n") !== planEditorLines(plan).join("\n");
      plan = kept;
    } else {
      this.output.write(`${heading}\n${planEditorLines(plan).map((line) => `  ${terminalText(line)}`).join("\n")}\n`);
      if (!this.interactive || !this.terminal.canAsk) {
        this.output.write("[plan] This run can't ask you to build, so Casper stopped after the plan. Nothing was built.\n");
        return "stop";
      }
    }
    // Both terminals ask after the plan, Stop first, so Enter (also the editor's Enter) never starts a build that
    // uses tokens.
    const answer = await this.terminal.pick(PLAN_QUESTION, PLAN_CHOICES.map((choice) => ({ ...choice })), signal);
    if (answer !== "Build" || this.closing || signal?.aborted) { this.output.write("[plan] Stopped without building.\n"); return "stop"; }
    this.output.write(`Casper plan (${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"}, ${plan.tests.length} ${plan.tests.length === 1 ? "case" : "cases"}${edited ? ", edited by you" : ""}):\n`
      + `${plan.steps.map((step, index) => `  ${index + 1}. ${terminalText(step)}\n`).join("")}${plan.tests.map((item) => `  - ${terminalText(item)}\n`).join("")}`);
    return { plan, ...(changed?.length ? { changed } : {}) };
  }

  private async runModelTask(prompt: string, options: { flow?: Flow; planFirst?: boolean } = {}): Promise<VerificationReport | undefined> {
    if (this.closing) return;
    // A flow the user picked, or /plan, is already this task's one choice before work: no other panel.
    this.beforeWorkAsked = Boolean(options.flow || options.planFirst);
    if (await this.offerNewProject(prompt) === "stop" || this.closing || this.commandAbort?.signal.aborted) return;
    this.observations = new TaskObservations();
    this.bigModelUse = undefined;
    this.taskChangeServers = new Set();
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
    const flag = this.verificationFlag;
    const configured = context.verification.mode;
    const verificationMode = (await this.checksPlan(context)).mode;
    if (verificationMode !== "off") this.checkTask = new VerificationTask(
      VerifierRegistry.forProject(context.model, context.verification.timeoutMs, this.blockOnCleanupFailure, this.networkOptions()), this.activeWorkspaceRoot(),
      (result) => this.writeCheckResult(result),
    );
    // Smoke checks are verification: they run only when Casper checks this task.
    const edits: NonNullable<CasperApp["taskEdits"]> = { edited: false, shell: false, turnEnded: false };
    this.taskEdits = edits;
    this.smokeTask = verificationMode !== "off" ? new SmokeChecks(context.smoke ?? [], () => this.serviceManager(), () => this.changedSinceTaskStart(edits)) : undefined;
    await this.prepareCapabilities(prompt, classification.intent === "visualize");
    if (this.closing || this.commandAbort?.signal.aborted) return;
    const session = await this.ensureRuntime();
    if (this.closing || this.commandAbort?.signal.aborted) return;
    if (!await this.ensureModel(session)) return;
    this.bigModelNotice(session);
    this.clearSteps();
    const workspaceRoot = this.activeWorkspaceRoot();
    // Receipts describe the tree, not tool names: a read-only shell run is not a write. Undo's own copy is made
    // alongside, with the conversation's position (the plan turn and repairs are part of the task).
    this.snapshotFailure = undefined;
    const [before, undoStart] = await Promise.all([this.snapshotWorkspace(workspaceRoot, this.commandAbort?.signal),
      this.taskUndo.begin(workspaceRoot, session, this.commandAbort?.signal)]);
    edits.before = before;
    // verification.checklist: the cases the request states, listed before the model starts, so it tests each one.
    // Unset, it is on for interactive code changes (the user sees and can edit or skip the list) and off
    // otherwise: questions, docs, refactors and one-shot runs.
    // At most one question before work: after the new-project question there is no checklist panel.
    const checklistOn = !this.beforeWorkAsked && (context.verification.checklist
      ?? (this.interactive && ["implement", "fix", "test"].includes(classification.intent)));
    const complete = checklistOn ? session.complete?.bind(session) : undefined;
    // Plan first: suggested for a build request with several asks, as one numbered choice folded into the
    // checklist panel, so there is still one panel before work. /plan chooses it directly.
    const planOffer = !this.beforeWorkAsked && this.terminal.canAsk ? suggestBeforeWork(prompt, classification, { interactive: this.interactive }) : undefined;
    const planState = planOffer ? await this.suggestions.state(context) : undefined;
    let planFirst = options.planFirst === true;
    let checklist: string[] | undefined;
    if (planOffer && planState?.visible(planOffer.id)) {
      const listed = complete ? await this.makeChecklist(complete, prompt, { edit: false }) : undefined;
      if (this.closing || this.commandAbort?.signal.aborted) return;
      const panel = beforeWorkPanel(planOffer, listed ?? []);
      // Editing needs the rich editor; the plain terminal offers the other two.
      if (!this.terminal.rich) panel.options = panel.options.filter((option) => option.choice !== "edit");
      this.events.ensureLineBreak();
      const picked = await this.terminal.pick(panel.question, panel.options.map(({ label, description }) => ({ label, description })), this.commandAbort?.signal);
      if (this.closing || this.commandAbort?.signal.aborted) return;
      const answer = readBeforeWorkAnswer(panel, picked === undefined ? undefined : [picked]);
      if (answer.kind === "plan-first") { planFirst = true; await planState.recordChosen(planOffer.id).catch(() => {}); }
      else await planState.recordIgnored([planOffer.id]).catch(() => {});
      if (answer.kind === "edit") checklist = await this.makeChecklist(complete!, prompt, { cases: listed });
      else {
        const cases = normalizeCases([...(listed ?? []), ...(answer.kind === "typed" ? [answer.text] : [])]);
        checklist = cases.length ? cases : undefined;
        if (checklist && answer.kind !== "plan-first") this.output.write(`Casper checklist (${checklist.length} ${checklist.length === 1 ? "case" : "cases"}${answer.kind === "typed" ? ", one added by you" : " from your request"}):\n${checklist.map((item) => `  - ${item}\n`).join("")}`);
      }
      if (this.closing || this.commandAbort?.signal.aborted) return;
    } else if (!planFirst) checklist = complete ? await this.makeChecklist(complete, prompt) : undefined;
    if (this.closing || this.commandAbort?.signal.aborted) return;
    // The plan turn: the model reads and writes a plan and the cases to test; the user edits it, then builds.
    let planBlock = "";
    let changedWhilePlanning: string[] | undefined;
    if (planFirst) {
      const planned = await this.runPlanTurn(session, prompt, checklist, workspaceRoot);
      if (planned === "stop" || this.closing || this.commandAbort?.signal.aborted) return;
      changedWhilePlanning = planned.changed;
      checklist = planned.plan.tests.length ? planned.plan.tests : undefined;
      planBlock = `Casper plan (the user read and accepted it). Follow these steps in order:\n${planned.plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`;
    }
    // A code change in auto mode is reviewed and proven: the tests must fail without it. Only requests
    // that are clearly not behavior changes are exempt; the keyword intent is too coarse to decide more
    // ("add X; you may add new test files" reads as intent "test"), so the work itself decides later.
    // The workspace as it is now is what "without the change" means.
    const testCommand = context.model.commands.test?.trim();
    const proving = verificationMode === "auto" && Boolean(testCommand) && before !== undefined
      && !["refactor", "document", "inspect", "visualize", "configure"].includes(classification.intent);
    let baseline: ChangeBaseline | undefined;
    let baselineUnavailable: string | undefined;
    if (proving) {
      try { baseline = await ChangeBaseline.capture(workspaceRoot, { signal: this.commandAbort?.signal }); this.taskBaseline = { baseline, root: workspaceRoot }; }
      catch (error) {
        if (this.commandAbort?.signal.aborted) return;
        baselineUnavailable = `Casper could not copy the workspace to compare: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    let proof: ChangeProof | undefined;
    let proofSkipped: string | undefined;
    let review: RequirementsReview | undefined;
    let acceptance: TaskResult["acceptance"];
    let afterModel: Map<string, string> | undefined;
    let verification: VerificationReport | undefined;
    let autoChecks: ReturnType<typeof planAutoChecks> | undefined;
    let pageNotes: string[] | undefined;
    let workFolder: ChildProject | undefined;
    let receiptShown = false;
    const flatten = (changes: TreeChanges) => [...changes.added, ...changes.modified, ...changes.removed].sort();
    // Automatic effort's classifier is a model call outside the conversation, so the task's usage
    // totals cannot include it: any classification (or an unreadable count) makes them unknown.
    const classifications = () => { try { return session.getUsage?.().effortClassification?.requests ?? 0; } catch { return undefined; } };
    const classifiedBefore = classifications();
    try {
      this.phase("task", "start");
      await session.prompt([
        memoryContext,
        skillContext,
        formatTaskPrompt(prompt, classification, context.model, { verificationMode, proveChange: proving,
          reviewFollows: context.verification.review === true, afterContext: Boolean(memoryContext || skillContext) }),
        planBlock,
        checklist ? formatChecklistPrompt(checklist) : "",
        // A flow the user picked from the row: guidance for this one request.
        options.flow ? formatFlowPrompt(options.flow, prompt) : "",
      ].filter(Boolean).join("\n\n"), this.commandAbort?.signal, { request: prompt, maxTurns: this.maxTurns });
      await this.retryModelFailure(session, prompt);
      this.phase("task", "end");
      // Repair, review and proof rounds follow the change.
      edits.turnEnded = true;
      afterModel = before && !this.closing ? await this.snapshotWorkspace(workspaceRoot) : undefined;
      // A request cut short by --max-turns is unfinished work: checking it would only start repairs.
      const cancelled = this.closing || this.commandAbort?.signal.aborted || this.taskRuntimeCancelled || this.checkTask?.signal.aborted || this.taskTurnLimit !== undefined;
      const stopped = cancelled || this.taskRuntimeFailed;
      // The model errored after editing: its edits are kept, so check them (no repair: the model just failed).
      if (!cancelled && this.taskRuntimeFailed && this.checkTask && verificationMode === "auto") {
        const edited = before && afterModel ? flatten(diffSnapshots(before, afterModel)) : undefined;
        const failedChecks = edited?.length ? planAutoChecks({ selected: context.verification.checks, commands: context.model.commands,
          scopes: context.model.verificationScopes, named: context.model.namedChecks, detected: autoDetectedChecks(context.model), changedPaths: edited }).run : [];
        if (failedChecks.length) {
          this.events.ensureLineBreak();
          this.output.write(`… Casper checking the edits the model made before it failed: ${failedChecks.join(", ")}\n`);
          verification = await this.runVerification(failedChecks, false, prompt, this.checkTask);
        }
      }
      if (!stopped && this.checkTask && verificationMode === "auto") {
        const changedByModel = before && afterModel ? flatten(diffSnapshots(before, afterModel)) : undefined;
        autoChecks = planAutoChecks({
          selected: context.verification.checks, commands: context.model.commands, scopes: context.model.verificationScopes,
          named: context.model.namedChecks, detected: autoDetectedChecks(context.model), changedPaths: changedByModel,
        });
        // Configured smoke checks run after a change; checks the model recorded always run.
        const smokeDue = Boolean(this.smokeTask?.recordedCount || (this.smokeTask?.size && autoChecks.skipped !== "no-changes"));
        // Pages are opened when the project facts say so (a web project, changed files that reach a page), never the prompt.
        // A removed page is not opened: only files that exist now can reach a page.
        const pagePlan = before && afterModel ? await this.planPages(context, pagePaths(diffSnapshots(before, afterModel))) : undefined;
        const pagesDue = Boolean(before && pagePlan && "service" in pagePlan && pagePlan.pages.open.length);
        this.pageTask = pagesDue ? { context, root: workspaceRoot, before: before! } : undefined;
        pageNotes = pagesDue ? undefined : this.pageNotes(pagePlan);
        // Fresh passes the model already recorded are reused, not rerun (VerificationTask).
        if (autoChecks.run.length || this.checkTask.checks.length || smokeDue || pagesDue) {
          const pending = [...new Set([...autoChecks.run, ...this.checkTask.checks]), ...(smokeDue ? ["smoke"] : []), ...(pagesDue ? ["pages"] : [])];
          this.events.ensureLineBreak();
          this.output.write(`… Casper checking: ${pending.join(", ")}\n`);
          verification = await this.runVerification(autoChecks.run, true, prompt, this.checkTask);
          const changedCode = Boolean(before && afterModel && changesCode(diffSnapshots(before, afterModel)));
          if (verification.status === "pass" && !(proving && changedCode)) {
            proofSkipped = !verification.results.length && verification.pages && !verification.smoke?.checks.length
              ? verification.pages.pages.every((page) => page.consoleChecked) ? PAGES_ONLY_PROOF : PAGES_ANSWER_ONLY_PROOF
              : proofSkipReason({ intent: classification.intent, testCommand, snapshot: before !== undefined, changedCode });
          }
          if (proving && verification.status === "pass" && changedCode) {
            const initialReview = parseChecklist(this.lastAnswer);
            ({ verification, proof, review } = await this.finishChange({ baseline, baselineUnavailable, before: before!, root: workspaceRoot,
              command: testCommand!, request: prompt, checks: autoChecks.run, verification, session, initialReview }));
          }
          // Not tied to the proof: any code change whose checks pass (server tasks and configure requests too).
          const acceptanceMode = context.verification.acceptance;
          if ((acceptanceMode === true || acceptanceMode === "warn") && testCommand && changedCode && verification.status === "pass" && proof?.status !== "unproven"
            && !this.closing && !this.commandAbort?.signal.aborted && !this.taskRuntimeFailed && this.taskTurnLimit === undefined) {
            acceptance = await this.acceptChange({ session, before: before!, root: workspaceRoot, command: testCommand, request: prompt,
              mode: acceptanceMode === "warn" ? "warn" : "verdict" });
          }
        }
      } else if (!stopped && this.checkTask && (this.checkTask.checks.length || this.smokeTask?.recordedCount)) {
        verification = await this.runVerification(this.checkTask.checks, true, prompt, this.checkTask);
      }
      // The work landed in a project inside this folder (mist-tools in Documents): its own checks run for this receipt.
      if (!stopped && before && afterModel && !this.closing) {
        workFolder = await this.childProjectOfTask(context, flatten(diffSnapshots(before, afterModel)));
        if (workFolder && !verification && this.checkTask && verificationMode === "auto") {
          const child = await this.runChildChecks(workFolder, flatten(diffSnapshots(before, afterModel)));
          if (child) {
            verification = child;
            autoChecks = undefined;
            if (child.status === "pass") proofSkipped = `the checks ran in ${workFolder.relative}; Casper did not compare the tests with and without the change`;
          }
        }
      }
    } catch (error) {
      this.taskRuntimeFailed = true;
      throw error;
    } finally {
      this.taskBaseline = undefined;
      await baseline?.dispose();
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
      const changedPaths = before && afterModel ? flatten(diffSnapshots(before, afterModel)) : undefined;
      const changedDuringChecks = afterModel && afterChecks && afterChecks !== afterModel ? flatten(diffSnapshots(afterModel, afterChecks)) : [];
      const classifiedAfter = classifications();
      if (classifiedBefore === undefined || classifiedAfter !== classifiedBefore) this.observations.recordUntrackedModelUse();
      const observations = this.observations.snapshot(changedPaths, changedDuringChecks);
      const browser = !this.closing && this.browser ? await this.browser.report() : undefined;
      const services = !this.closing && this.services && !this.services.closed
        ? this.services.status().map(({ name, origin, state }) => ({ name, ...(origin ? { origin } : {}), state })) : [];
      const snapshotFailure = !changedPaths && this.snapshotFailure ? { reason: this.snapshotFailure,
        edited: observations.observedEdits.map((file) => { const relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, file));
          return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : file; }) } : undefined;
      this.lastTaskResult = { execution, verification, ...observations, ...(snapshotFailure ? { snapshotFailure } : {}), ...(browser?.checks.length ? { browser } : {}),
        ...(services.length ? { services } : {}),
        // Smoke checks ran even without a configured command, so "no checks" no longer describes the task.
        verificationMode, ...(!flag && !configured && verificationMode === "auto" ? { verificationDefaulted: true as const } : {}),
        ...(autoChecks?.skipped && !verification?.smoke && !verification?.pages ? { autoSkipped: autoChecks.skipped } : {}),
        ...(pageNotes?.length && !verification?.pages ? { pageNotes } : {}),
        ...(this.taskTurnLimit !== undefined ? { turnLimit: this.taskTurnLimit } : {}), ...(proof ? { proof } : {}), ...(proofSkipped && !proof ? { proofSkipped } : {}), ...(review ? { review } : {}),
        ...(acceptance ? { acceptance } : {}), ...(checklist ? { checklist } : {}), ...this.bigModelReceipt(),
        ...(changedWhilePlanning?.length ? { changedWhilePlanning } : {}), ...(this.sandbox ? { sandbox: sandboxReceipt(this.sandbox)! } : {}) };
      // The receipt is next: the steps fold and the Working box goes, even for a tool that ended late.
      this.events.reset();
      if (!this.closing) {
        this.terminal.endAssistant();
        this.events.ensureLineBreak();
        if (classification.intent !== "general" || execution !== "completed" || verification || browser?.checks.length || observations.possibleMutations || observations.changedPaths?.length || observations.changedDuringChecks?.length || observations.observedEdits.length || observations.observedChecks.length
          || observations.remoteChanges?.length || observations.secretInCommand) {
          // The second copy and the saved receipt; the change summary lists only this task's files.
          const { stat } = await this.taskUndo.finish(undoStart, { request: prompt, task: this.lastTaskResult, session, servers: [...this.taskChangeServers] });
          this.output.write(`${this.verbose ? formatTaskResult(this.lastTaskResult) : formatReceipt(this.lastTaskResult, { surface: this.receiptSurface(), ...this.receiptFolder(workspaceRoot) })}\n`);
          if (stat.trim()) this.output.write(stat.endsWith("\n") ? stat : `${stat}\n`);
          if (this.interactive) await this.offerNextSteps(this.lastTaskResult, prompt, classification);
          receiptShown = true;
        }
      }
      this.clearSteps();
      await this.recordTaskOutcome({ task: prompt, skills: selected.map(({ skill }) => skill.id),
        modelStatus: execution, verification });
      // Last, once this folder has the task's outcome: the offer may move Casper to the project the work is in.
      if (workFolder && receiptShown && !this.closing) await this.offerWorkFolder(workFolder);
    }
    return verification;
  }

  /** verification.checklist: one separate model call lists the cases the request states; an interactive
   * user may edit them first; Casper prints them and the task prompt asks for one test per case. Its
   * usage joins the task's. A failed call is one line on the transcript and the task goes on without a checklist. */
  private async makeChecklist(complete: NonNullable<RuntimeSession["complete"]>, request: string,
    options: { edit?: false; cases?: string[] } = {}): Promise<string[] | undefined> {
    let result: { cases: string[]; dropped: number } | { error: string };
    if (options.cases) result = { cases: options.cases, dropped: 0 };
    else {
      this.phase("checklist", "start");
      try {
        const made = await extractChecklist({ complete, request, signal: this.commandAbort?.signal });
        this.observations.recordModelCall(made.usage);
        result = made;
      } catch (error) {
        // The call may have reached the provider: its usage is unknown.
        this.observations.recordUntrackedModelUse();
        result = { error: `the checklist call failed: ${error instanceof Error ? error.message : String(error)}` };
      } finally { this.phase("checklist", "end"); }
    }
    if (this.closing || this.commandAbort?.signal.aborted) return undefined;
    this.events.ensureLineBreak();
    if ("error" in result) {
      this.output.write(`• Checklist not made: ${result.error.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")}\n`);
      this.steps.skip("checklist"); this.terminal.setSteps(this.steps.text());
      return undefined;
    }
    // Listed for the plan-first panel, which shows the cases itself.
    if (options.edit === false) return result.cases.length ? result.cases : undefined;
    let cases = result.cases;
    let edited = false;
    const count = (n: number) => `${n} ${n === 1 ? "case" : "cases"}`;
    const leftOut = result.dropped ? `${result.dropped} more ${result.dropped === 1 ? "was" : "were"} left out` : "";
    // Interactive: the user corrects the list before the model sees it. Enter keeps the editor's lines,
    // Esc (or deleting every line) starts without one, Ctrl+C cancels the task.
    if (this.interactive && this.terminal.rich) {
      const answer = await this.terminal.editLines(`Casper checklist: ${count(cases.length)} from your request${leftOut ? ` (${leftOut})` : ""}. The model writes one test per case.`,
        "Enter starts with these · edit, add or delete lines · Esc starts without a checklist", cases, this.commandAbort?.signal);
      if (this.closing || this.commandAbort?.signal.aborted) return undefined;
      const kept = answer ? normalizeCases(answer) : [];
      if (!kept.length) {
        this.output.write("[checklist] skipped; the task starts without one\n");
        this.steps.skip("checklist"); this.terminal.setSteps(this.steps.text());
        return undefined;
      }
      edited = kept.join("\n") !== cases.join("\n");
      cases = kept;
    }
    this.output.write(`Casper checklist (${count(cases.length)}${edited ? ", edited by you" : ` from your request${leftOut ? `; ${leftOut}` : ""}`}):\n${cases.map((item) => `  - ${item}\n`).join("")}`);
    return cases;
  }

  /** verification.acceptance: tests written from the request alone by a separate model call, run once
   * against the change and removed. Signal only: no repair, nothing kept; its usage joins the task's. */
  private async acceptChange(input: { session: RuntimeSession; before: Map<string, string>; root: string; command: string; request: string;
    mode: NonNullable<TaskResult["acceptance"]>["mode"] }): Promise<TaskResult["acceptance"]> {
    const { mode } = input;
    const complete = input.session.complete?.bind(input.session);
    if (!complete) return { status: "error", reason: "this runtime cannot make a separate model call", mode };
    const now = await this.snapshotWorkspace(input.root);
    if (!now) return { status: "error", reason: "Casper could not compare the workspace", mode };
    this.events.ensureLineBreak();
    this.output.write("… Casper checking the change against tests written from the request alone\n");
    this.phase("acceptance", "start");
    try {
      const { usage, ...result } = await independentAcceptance({ complete, request: input.request, root: input.root, changes: diffSnapshots(input.before, now),
        files: now, testCommand: input.command, timeoutMs: this.projectContext!.verification.timeoutMs, signal: this.commandAbort?.signal });
      this.observations.recordModelCall(usage);
      return { ...result, mode };
    } catch (error) {
      if (this.commandAbort?.signal.aborted) throw error;
      // The call may have reached the provider: its usage is unknown.
      this.observations.recordUntrackedModelUse();
      return { status: "error", reason: `the acceptance check failed: ${error instanceof Error ? error.message : String(error)}`, mode };
    } finally { this.phase("acceptance", "end"); }
  }

  /** After the checks pass on a fix or feature: with verification.review: true, one requirements-review
   * round (the model checks every stated requirement, fixes gaps and reports them) and the checks again;
   * then the proof. */
  private async finishChange(input: {
    baseline?: ChangeBaseline; baselineUnavailable?: string; before: Map<string, string>; root: string; command: string;
    request: string; checks: readonly CheckName[]; verification: VerificationReport; session: RuntimeSession;
    initialReview?: { done: string[]; open: string[] };
  }): Promise<{ verification: VerificationReport; proof?: ChangeProof; review?: RequirementsReview }> {
    const context = this.projectContext!;
    const stopped = () => this.closing || Boolean(this.commandAbort?.signal.aborted) || this.taskRuntimeFailed || this.taskTurnLimit !== undefined;
    const max = context.repair.maxAttempts;
    let verification = input.verification;
    // The review is opt-in (verification.review: true): pinned benchmarks showed no first-time-right gain
    // for 40% of the wall time. With it on, the first turn is not asked for a checklist; with it off
    // (the default), the first turn asks for one and only the first answer's own, if any, is kept.
    const initialReview = input.initialReview;
    if (context.verification.review !== true) {
      if (verification.status !== "pass" || stopped()) return { verification, review: initialReview };
      this.phase("proof", "start");
      const result = await this.proveChange({ ...input, verification });
      this.phase("proof", "end");
      return { ...result, review: initialReview };
    }
    this.events.ensureLineBreak();
    this.phase("review", "start");
    this.output.write("↻ review: checking the work against every requirement\n");
    this.lastAnswer = "";
    const unreviewed = await this.snapshotWorkspace(input.root);
    await this.prepareCapabilities(input.request);
    const cutOff = await this.promptRound(input.session, requirementsReviewPrompt(input.request), input.request);
    if (stopped()) return { verification };
    if (cutOff) this.output.write(`↻ review: stopped at its ${ROUND_MAX_TURNS}-turn budget\n`);
    const review: RequirementsReview = { ...(parseReview(this.lastAnswer) ?? { missing: true as const }), ...(cutOff ? { incomplete: true as const } : {}) };
    // Checks rerun only when the review edited (or the tree cannot be compared); failures get the remaining repairs.
    const after = unreviewed && await this.snapshotWorkspace(input.root);
    const edited = !unreviewed || !after || [...Object.values(diffSnapshots(unreviewed, after))].some((paths) => paths.length);
    if (edited) {
      const reviewed = await this.runVerification(input.checks, true, input.request, this.checkTask, Math.max(0, max - verification.repairAttempts));
      verification = { ...reviewed, repairAttempts: verification.repairAttempts + reviewed.repairAttempts };
    }
    this.phase("review", "end");
    if (verification.status !== "pass" || stopped()) return { verification, review };
    this.phase("proof", "start");
    const result = await this.proveChange({ ...input, verification });
    this.phase("proof", "end");
    return { ...result, review };
  }

  /** Compare the tests with and without the change. An unproven change gets one repair round,
   * within the repair budget, to add a test that fails without it; checks and comparison rerun. */
  private async proveChange(input: {
    baseline?: ChangeBaseline; baselineUnavailable?: string; before: Map<string, string>; root: string; command: string;
    request: string; checks: readonly CheckName[]; verification: VerificationReport; session: RuntimeSession;
  }): Promise<{ verification: VerificationReport; proof?: ChangeProof }> {
    const context = this.projectContext!;
    const compare = async (): Promise<ChangeProof | undefined> => {
      const now = await this.snapshotWorkspace(input.root);
      if (!now) return { status: "unavailable", check: "test", reason: "Casper could not compare the workspace" };
      const changes = diffSnapshots(input.before, now);
      if (!input.baseline) {
        return changes.added.length || changes.modified.length || changes.removed.length
          ? { status: "unavailable", check: "test", reason: input.baselineUnavailable ?? "Casper could not copy the workspace" } : undefined;
      }
      this.events.ensureLineBreak();
      this.output.write("… Casper checking that the tests fail without the change\n");
      return input.baseline.prove({ root: input.root, changes, check: "test", command: input.command,
        timeoutMs: context.verification.timeoutMs, signal: this.commandAbort?.signal, onCleanupFailure: this.blockOnCleanupFailure });
    };
    let verification = input.verification;
    let proof = await compare();
    const stopped = () => this.closing || Boolean(this.commandAbort?.signal.aborted) || this.taskRuntimeFailed || this.taskTurnLimit !== undefined;
    const max = context.repair.maxAttempts;
    if (proof?.status !== "unproven" || verification.repairAttempts >= max || stopped()) return { verification, proof };
    const attempt = verification.repairAttempts + 1;
    this.output.write(`↻ repair ${attempt}/${max}: add a test that fails without the change\n`);
    await this.prepareCapabilities(input.request);
    // A round cut off by its own budget needs no mark: the checks and the comparison below decide.
    await this.promptRound(input.session, proofRepairPrompt(input.request, proof), input.request);
    if (stopped()) return { verification: { ...verification, repairAttempts: attempt }, proof };
    const again = await this.runVerification(input.checks, true, input.request, this.checkTask, max - attempt);
    verification = { ...again, repairAttempts: attempt + again.repairAttempts };
    if (verification.status === "pass" && !stopped()) proof = await compare();
    return { verification, proof };
  }

  /** A round after the task turn (review, proof repair) with its own ROUND_MAX_TURNS budget. A --max-turns
   * at or below it wins and stays the task's stop (taskTurnLimit, exit 2). The round's own budget ending it
   * is not the task's stop: Casper goes on with the checks and the proof. True when that budget ended it. */
  private async promptRound(session: RuntimeSession, text: string, request: string): Promise<boolean> {
    const roundBudget = this.maxTurns === undefined || ROUND_MAX_TURNS < this.maxTurns;
    await session.prompt(text, this.commandAbort?.signal, { request, maxTurns: roundBudget ? ROUND_MAX_TURNS : this.maxTurns });
    if (!roundBudget || this.taskTurnLimit === undefined) return false;
    this.taskTurnLimit = undefined;
    return true;
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
    checks: readonly CheckName[],
    repair: boolean,
    request = `Make the selected verification checks pass: ${checks.join(", ")}.`,
    task?: VerificationTask,
    /** Repairs left for this task; defaults to the project's repair budget. */
    maxAttempts?: number,
  ): Promise<VerificationReport> {
    const context = this.projectContext!;
    const controller = new AbortController();
    // A standalone verification task (/verify, branch checks) owns its objective; post-task
    // verification passes `task` and continues the parent request's delegation budget.
    if (!task) this.delegateToolForTask = undefined;
    // Lab checks start only here, from the user's own /verify <name>, and only after a person answers.
    const evidence = task ?? new VerificationTask(
      VerifierRegistry.forProject(context.model, context.verification.timeoutMs, this.blockOnCleanupFailure, { ...this.networkOptions(), runLab: labCheckRunner({
        canAsk: () => this.interactive && this.terminal.canAsk && !this.closing, pick: (question, options, signal) => this.terminal.pick(question, options, signal),
        write: (text) => { if (!this.closing) this.output.write(text); }, stateDirectory: context.stateDirectory, ...(context.lab ? { lab: context.lab } : {}),
        ...(this.networkTools ? { network: this.networkTools } : {}) }) }), this.activeWorkspaceRoot(),
      (result) => this.writeCheckResult(result),
    );
    // /verify <lab check> alone: a failure asks before any repair (Stop first); nothing touches the lab again on its own.
    const labOnly = !task && checks.length > 0 && checks.every((name) => context.model.namedChecks?.[name]?.kind === "lab");
    const cancel = () => controller.abort();
    this.commandAbort?.signal.addEventListener("abort", cancel, { once: true });
    if (this.commandAbort?.signal.aborted) cancel();
    this.verificationAbort = controller;
    this.verificationTask = evidence;
    this.repairOnBigModel = undefined;
    this.bigModelGrant = undefined;
    if (!task) this.bigModelUse = undefined;
    this.events.ensureLineBreak();
    this.phase("checks", "start");
    try {
      this.verificationWork = verifyAndRepair({
        task: evidence,
        checks,
        cwd: this.activeWorkspaceRoot(),
        request,
        constraints: [context.rules.profile, context.rules.project, ...context.model.conventions].filter(Boolean).join("\n"),
        maxAttempts: maxAttempts ?? context.repair.maxAttempts,
        signal: controller.signal,
        repair: repair || labOnly ? async (prompt) => {
          await this.prepareCapabilities(request);
          const session = await this.ensureRuntime();
          // This try runs on the big model: the user chose it at the repair limit, or set repair.bigModelLastTry.
          const big = this.repairOnBigModel;
          this.repairOnBigModel = undefined;
          if (controller.signal.aborted) return;
          const back = big ? await this.switchToBigModel(session, big) : undefined;
          if (big && !back) this.output.write(`[model] Casper could not switch to your big model ${terminalText(big.label)}; this repair runs on the current model.\n`);
          this.phase("repair", "start");
          try { await session.prompt(prompt, controller.signal, { request, maxTurns: this.maxTurns }); }
          finally {
            this.phase("repair", "end");
            if (back) await this.restoreModel(session, back);
          }
          if (back && big) {
            this.bigModelUse = { model: big.label, attempts: (this.bigModelUse?.attempts ?? 0) + 1,
              oneOff: Boolean(big.oneOff) && (this.bigModelUse?.oneOff ?? true) };
          }
          if (this.taskRuntimeFailed && !this.taskRuntimeCancelled) throw new Error("Repair model stopped unsuccessfully; changes retained.");
          return back && big ? { model: big.label } : undefined;
        } : undefined,
        onRepair: (attempt, max) => {
          this.repairsTried = attempt;
          // The granted extra try, or the last one with repair.bigModelLastTry on, runs on the big model.
          const granted = this.bigModelGrant;
          this.bigModelGrant = undefined;
          const setting = attempt === max && context.repair.bigModelLastTry === true && this.session ? this.bigModel(this.session) : undefined;
          this.repairOnBigModel = granted ?? (setting ? { query: "@reason", label: setting.label } : undefined);
          const on = this.repairOnBigModel;
          this.output.write(`↻ repair ${attempt}/${max}${on ? ` on ${on.oneOff ? "" : "your big model "}${terminalText(on.label)}` : ""}\n`);
        },
        // Out of tries: one numbered offer to try once more on the big model. Only a person answers it; one-shot
        // and --json runs never get it, so they never spend on a bigger model on their own.
        onRepairLimit: repair && this.interactive && this.terminal.canAsk ? (failures, signal) => this.askBigModelRetry(failures, signal) : undefined,
        onLabFailure: (repair || labOnly) && this.interactive && this.terminal.canAsk
          ? (failures, signal) => askLabFailure({ pick: (question, options, answerSignal) => this.terminal.pick(question, options, answerSignal) }, failures, signal) : undefined,
        // A check that was already failing before the change is not the change's doing: say so, and ask before paying to fix it.
        beforeRepair: repair && task && task === this.checkTask && this.taskBaseline ? (failures, signal) => this.repairPreexisting(failures, signal) : undefined,
        // Only a person can say whether a check that did not finish is worth a paid repair.
        onUnfinished: this.interactive && this.terminal.rich ? (unfinished, signal) => this.askUnfinished(unfinished, context.verification.timeoutMs, signal) : undefined,
        // The task's smoke checks join its own verification (repairs and review reruns), never a standalone /verify.
        smoke: task && task === this.checkTask && this.smokeTask?.size ? this.smokeRun(this.smokeTask) : undefined,
        // So do its page checks: planned again from every change since the task started, after each repair too.
        pages: task && task === this.checkTask && this.pageTask ? this.pageRun(this.pageTask) : undefined,
      });
      const report = await this.verificationWork;
      await recordCheckTimings(context.stateDirectory, report.rounds.flat());
      // A model task's receipt summarizes its checks; a standalone run gets its own summary.
      if (this.verbose) this.output.write(`${formatVerificationReport(report)}\n`);
      else if (!task) this.output.write(`${formatReceipt({ execution: "completed", verification: report, ...this.bigModelReceipt(),
        ...(this.sandbox ? { sandbox: sandboxReceipt(this.sandbox)! } : {}) },
        { surface: this.receiptSurface() })}\n`);
      return report;
    } finally {
      this.phase("checks", "end");
      if (!task) { await evidence.close(); this.clearSteps(); }
      this.commandAbort?.signal.removeEventListener("abort", cancel);
      this.verificationTask = undefined;
      this.verificationAbort = undefined;
      this.verificationWork = undefined;
    }
  }

  /** A stage of the work starts or ends: a JSON phase event for scripts, and the footer's step rail. */
  private phase(phase: PhaseEvent["phase"], state: PhaseEvent["state"]): void {
    this.onEvent?.(phaseEvent(phase, state));
    this.steps.update(phase, state);
    this.terminal.setSteps(this.steps.text());
  }

  private clearSteps(): void {
    this.steps.clear();
    this.terminal.setSteps(undefined);
  }

  private networkOptions(): { network?: NetworkToolContext } {
    return this.networkTools ? { network: this.networkTools } : {};
  }

  /**
   * The AI review after /security-review's tools: the review model's name and price (starting the session costs
   * nothing), one bounded read-only child, and the full scrubber whatever /secrets files says. The model never
   * reaches this: it is not a tool.
   */
  securityAI(): SecurityAIReview {
    return {
      model: async () => {
        const session = await this.ensureRuntime();
        const status = session.getStatus?.();
        if (status?.auth === "missing" || status?.blocked) throw new Error("no model is signed in");
        let review: string | undefined;
        try { review = session.getModelRoles?.().review; } catch { review = undefined; }
        const current = status?.provider && status.model ? `${status.provider}/${status.model}` : status?.model;
        const selector = review ?? current;
        if (!selector) throw new Error("no model is set");
        let info;
        try { info = session.describeModel?.(selector); } catch { info = undefined; }
        return { name: `${info ? `${info.provider}/${info.id}` : selector}${review ? " (your review model)" : ""}`,
          ...(info?.inputCostPerMillion ? { inputCostPerMillion: info.inputCostPerMillion } : {}) };
      },
      run: async (options) => {
        const result = await this.subagents.reviewSecurity(options);
        // Tokens spent outside a task still reach the receipt (`casper --json "/security-review ai"`).
        this.commandSpent = { turns: result.turns ?? 0, tokens: result.usage?.tokens ?? null, estimatedCost: result.usage?.estimatedCost ?? null };
        return result;
      },
      scrub: (toolName, input, texts, signal) => scrubToolOutput(this.scrubber, toolName, input, texts, signal, { configs: true }),
    };
  }

  /** `/verify add <name>` or a picked suggestion: save a check Casper found in .casper/project.yaml, then use it. */
  async saveFoundCheck(name: string): Promise<void> {
    const context = this.projectContext!;
    const spec = context.model.foundChecks?.[name];
    if (!spec && context.model.namedChecks?.[name]) {
      this.output.write(`[project] ${terminalText(name)} is already saved in ${PROJECT_YAML}; /verify ${terminalText(name)} runs it.\n`);
      return;
    }
    if (!spec) {
      const found = Object.keys(context.model.foundChecks ?? {});
      this.output.write(`[project] ${terminalText(name)} is not a check Casper found here.${found.length ? ` Found: ${found.join(", ")}.` : ""}\n`);
      return;
    }
    try {
      const written = await saveNamedCheck(context.info.root, name, spec);
      this.output.write(`[project] Saved ${terminalText(written.line)} in ${PROJECT_YAML}\n`);
      try { this.projectContext = await this.loadProjectContextFn(context.info); }
      catch (error) { this.output.write(`[project] ${PROJECT_YAML} could not be read again (${terminalText(error instanceof Error ? error.message : String(error))}); restart Casper to use it.\n`); }
    } catch (error) {
      this.output.write(`[project] Not saved: ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
    }
  }

  /** The mode and checks this session uses after a change; the banner, /status and every task share it. */
  async checksPlan(context: ProjectContext): Promise<ChecksPlan> {
    const flag = this.verificationFlag;
    const configured = context.verification.mode;
    const checks = selectedChecks(context.verification.checks, context.model.commands, context.model.namedChecks,
      autoDetectedChecks(context.model).map((check) => check.name));
    const measuredMs = flag || configured || !this.interactive ? undefined : await measuredCheckTime(context.stateDirectory, checks, checkCommands(context.model));
    const mode = resolveVerificationMode({ flag, configured, interactive: this.interactive, measuredMs });
    const manual = manualChecks(checks, context.model.namedChecks);
    const lab = labNamedChecks(context.model.namedChecks);
    const found = Object.keys(context.model.foundChecks ?? {});
    // The dev server is named before it first runs, since it runs the project's own code.
    const web = mode === "auto" && context.pages !== "off" ? await detectWebService(this.activeWorkspaceRoot(), { frameworks: context.model.frameworks,
      packageManager: context.model.packageManager, services: context.services ?? {} }).catch(() => undefined) : undefined;
    return { mode, checks, ...(mode === "offer" && measuredMs !== undefined ? { slow: true } : {}), ...(manual.length ? { manual } : {}),
      ...(lab.length ? { lab } : {}), ...(found.length ? { found } : {}),
      ...(isDetectedWebService(web) ? { pages: redactPreview(terminalText(web.label)).slice(0, 120) } : {}) };
  }

  /** Before a request runs: with no model, pick one for a signed-in provider, or open sign-in (then pick);
   * with the model's credentials missing, open sign-in for that provider. Never a fake "model failed"
   * receipt: when no model can run, the terminal says why and nothing starts; scripts get an error. */
  private async ensureModel(session: RuntimeSession): Promise<boolean> {
    const status = session.getStatus?.();
    if (!status?.blocked) return true;
    const signal = this.commandAbort?.signal;
    const canSignIn = this.interactive && this.terminal.rich;
    const pickDefault = async (): Promise<boolean> => {
      const picked = await session.selectDefaultModel?.({ provider: this.loginProvider, signal }).catch(() => undefined);
      if (!picked?.selected) return false;
      this.output.write(`[model] Casper picked ${picked.status.provider}/${picked.status.model} for your signed-in provider and saved it as your default. Use /model to choose another.\n`);
      this.updateFooter();
      return true;
    };
    if (!status.provider) {
      if (await pickDefault()) return true;
      if (canSignIn && !signal?.aborted) {
        this.output.write("[model] No model yet. Sign in to a provider to start; Esc cancels.\n");
        if (await runLogin(this) && await pickDefault()) return true;
      }
    } else if (status.auth === "missing" && canSignIn && !signal?.aborted) {
      const provider = LOGIN_PROVIDERS.find((id) => id === status.provider);
      if (provider) {
        this.output.write(`[model] Credentials missing for ${provider}. Sign in to continue; Esc cancels.\n`);
        if (await runLogin(this, provider) && !session.getStatus?.().blocked) return true;
      }
    }
    const blocked = session.getStatus?.().blocked;
    if (!blocked) return true;
    if (!this.interactive) throw new Error(blocked);
    this.output.write(`[model] ${blocked}\n`);
    return false;
  }

  /** Before the first repair: run each failing check on the files from before the change. One that failed there
   * too was already broken; the terminal asks whether to pay for a fix (Esc leaves it), scripts go on repairing. */
  private async repairPreexisting(failures: VerificationResult[], signal: AbortSignal): Promise<boolean> {
    const held = this.taskBaseline;
    const context = this.projectContext;
    if (!held || !context) return true;
    const names = failures.map((failure) => failure.name).filter((name): name is ProjectCommand => isBuiltinCheck(name) && Boolean(context.model.commands[name]?.trim()));
    if (!names.length) return true;
    this.events.ensureLineBreak();
    this.output.write(`… Casper checking whether ${names.join(", ")} failed before this change too\n`);
    const before: string[] = [];
    for (const name of names) {
      const result = await held.baseline.before({ root: held.root, check: name, command: context.model.commands[name]!.trim(),
        timeoutMs: this.verificationTask?.limit(name) ?? context.verification.timeoutMs, signal });
      if (result === "fail") before.push(name);
    }
    if (!before.length || signal.aborted) return true;
    const which = before.join(", ");
    this.output.write(`• ${which} was already failing before this change (Casper ran it on the files from before)\n`);
    if (!this.interactive || !this.terminal.rich) return true;
    // Leave it comes first, so Enter never starts a repair that uses tokens.
    const answer = await this.terminal.ask(`${which} was already failing before this change. Fix it anyway?`,
      ALREADY_FAILING_CHOICES.map((choice) => ({ ...choice })), false, signal);
    return answer?.[0] === "Fix it anyway";
  }

  /** A provider hiccup Pi does not retry (an empty response) ends a run for no reason of the task's: try once
   * more on its own, then, in the terminal, ask. Sign-in, quota and context errors, and errors Pi already
   * retried within its budget, are not retried again. */
  homeDir(): string { return this.sessionHomeDir ?? os.homedir(); }

  async savedModel(): Promise<string | undefined> { return modelPreference(this.sessionHomeDir ?? os.homedir()); }

  private async retryModelFailure(session: RuntimeSession, request: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const error = this.events.lastError ?? "";
      if (!this.taskRuntimeFailed || this.taskRuntimeCancelled || this.closing || this.commandAbort?.signal.aborted || this.taskTurnLimit !== undefined) return;
      // Only a provider that answered with nothing; Pi already retried what it counts as transient,
      // within the user's retry budget, so never go past that.
      if (!/empty (?:response|completion|message|content)|no (?:content|response|output) (?:was )?returned|returned no (?:content|output)/i.test(error)) return;
      if (isRetryableAssistantError({ stopReason: "error", errorMessage: error } as Parameters<typeof isRetryableAssistantError>[0])) return;
      let retry = attempt === 1;
      let big: { label: string } | undefined;
      if (!retry && this.interactive && this.terminal.rich && attempt <= 4) {
        this.events.ensureLineBreak();
        const bigModel = this.bigModel(session);
        // Stop comes first, so Enter never spends more tokens.
        const answer = await this.terminal.ask("The model failed again. What now?",
          modelFailedChoices(bigModel ? terminalText(bigModel.label) : undefined), false, this.commandAbort?.signal);
        if (bigModel && answer?.[0] === "Retry with your big model") big = bigModel;
        retry = answer?.[0] === "Retry" || Boolean(big);
      }
      if (!retry) return;
      this.events.ensureLineBreak();
      const back = big ? await this.switchToBigModel(session, { query: "@reason", label: big.label }) : undefined;
      this.output.write(`[model] ${attempt === 1 ? "The model failed; trying once more." : back ? `Trying again on your big model ${terminalText(big!.label)}.`
        : big ? `Casper could not switch to your big model ${terminalText(big.label)}; trying again on the current model.` : "Trying again."}\n`);
      this.taskRuntimeFailed = false;
      try {
        await session.prompt("Your last response failed with a provider error. Continue the task from where you stopped.",
          this.commandAbort?.signal, { request, maxTurns: this.maxTurns });
      } finally { if (back) await this.restoreModel(session, back); }
    }
  }

  /** The receipt's big-model part: which model ran repairs, and how many. */
  private bigModelReceipt(): Pick<TaskResult, "bigModel"> {
    const use = this.bigModelUse;
    return use ? { bigModel: { model: use.model, attempts: use.attempts, ...(use.oneOff ? { oneOff: true as const } : {}) } } : {};
  }

  /** repair.bigModelLastTry without a big model does nothing; say so once per session. */
  private bigModelNotice(session: RuntimeSession): void {
    if (this.bigModelNoticeShown || this.projectContext?.repair.bigModelLastTry !== true) return;
    this.bigModelNoticeShown = true;
    let role: string | undefined;
    try { role = session.getModelRoles?.().reason?.trim(); } catch { role = undefined; }
    if (!role) this.output.write("[model] repair.bigModelLastTry is on but no big model is set. Use /model big <provider/model>.\n");
  }

  /** The user's big model (the reason role), when one is set, the catalog knows it, and it is not the model in
   * use now. Reading it makes no model call. */
  private bigModel(session: RuntimeSession): { label: string; info?: RuntimeModelInfo } | undefined {
    let role: string | undefined;
    try { role = session.getModelRoles?.().reason?.trim(); } catch { return undefined; }
    if (!role || !session.selectModel) return undefined;
    let info: RuntimeModelInfo | undefined;
    if (session.describeModel) {
      try { info = session.describeModel("@reason"); } catch { info = undefined; }
      if (!info) return undefined;
    }
    const label = info ? `${info.provider}/${info.id}` : role.replace(/:[a-z]+$/, "");
    const status = session.getStatus?.();
    if (status?.provider && status.model && `${status.provider}/${status.model}` === label) return undefined;
    return { label, ...(info ? { info } : {}) };
  }

  /** Switch this conversation to the big model for one step; the model to go back to, or undefined when the
   * switch did not happen. Nothing is saved as a default. */
  private async switchToBigModel(session: RuntimeSession, big: BigModelChoice): Promise<string | undefined> {
    const status = session.getStatus?.();
    const back = status?.provider && status.model ? `${status.provider}/${status.model}` : undefined;
    if (!back || !session.selectModel) return undefined;
    try {
      const result = await session.selectModel({ query: big.query, persist: false });
      if (!result.selected) return undefined;
    } catch { return undefined; }
    this.updateFooter();
    return back;
  }

  /** Back to the model the user was on, with its own effort. */
  private async restoreModel(session: RuntimeSession, back: string): Promise<void> {
    try {
      await session.selectModel!({ query: back, persist: false });
      if (!this.closing) this.output.write(`[model] Back on ${terminalText(back)} for your next request.\n`);
    } catch (error) {
      if (!this.closing) this.output.write(`[model] Casper could not switch back to ${terminalText(back)} (${terminalText(error instanceof Error ? error.message : String(error))}); /model ${terminalText(back)} switches back.\n`);
    }
    this.updateFooter();
  }

  /** What a big-model try costs, in plain words: "about 48k tokens, at least ≈ $0.72". Only the conversation it
   * reads is counted, so the price is a lower bound; without a price only the tokens are named. */
  private bigModelCost(session: RuntimeSession, info?: RuntimeModelInfo): { words: string; fits: boolean } {
    let tokens: number | null | undefined;
    try { tokens = session.getUsage?.().context?.tokens; } catch { tokens = undefined; }
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return { words: "uses tokens", fits: true };
    const fits = !info?.contextWindow || tokens < info.contextWindow;
    const count = tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
    const price = info?.inputCostPerMillion ? tokens * info.inputCostPerMillion / 1e6 : undefined;
    return { fits, words: `about ${count} tokens${price !== undefined ? `, at least ≈ $${price < 0.01 ? price.toFixed(4) : price.toFixed(2)}` : ""}` };
  }

  /**
   * The repair limit is reached and checks still fail: one numbered question. The free answer comes first, so a
   * stray Enter never spends; Esc is the same as Stop. With no big model set, a rich terminal can pick one and
   * remember it. The extra tries granted (1 or 0).
   */
  private async askBigModelRetry(failures: VerificationResult[], signal: AbortSignal): Promise<number> {
    const session = this.session;
    if (!session?.selectModel || this.closing || signal.aborted) return 0;
    const names = [...new Set(failures.map((failure) => failure.name))].join(", ") || "the checks";
    const tried = this.repairsTried;
    const question = `${names} still ${failures.length > 1 ? "fail" : "fails"} after ${tried} ${tried === 1 ? "repair" : "repairs"}. What now?`;
    const stop = { ...REPAIR_LIMIT_STOP };
    const big = this.bigModel(session);
    let hasRole = false;
    try { hasRole = Boolean(session.getModelRoles?.().reason?.trim()); } catch { hasRole = false; }
    if (!big && hasRole) return 0; // You are already on your big model.
    const picker = !big ? this.terminal.modelPickerHost() : undefined;
    if (!big && !picker) {
      this.events.ensureLineBreak();
      this.output.write("• /model big <provider/model> sets a big model Casper can offer when repairs run out\n");
      return 0;
    }
    const cost = big ? this.bigModelCost(session, big.info) : undefined;
    if (big && cost && !cost.fits) {
      this.events.ensureLineBreak();
      this.output.write(`• Your big model ${terminalText(big.label)} can't hold this conversation (${cost.words}), so it was not offered\n`);
      return 0;
    }
    const retry = big
      ? { label: "Retry with your big model", description: `${terminalText(big.label)} reads this conversation (${cost!.words}), then tries 1 more fix` }
      : { label: "Retry with a bigger model", description: "pick one (uses tokens); Casper can remember it as your big model" };
    this.events.ensureLineBreak();
    const answer = await this.terminal.pick(question, [stop, retry], signal);
    if (answer !== retry.label || signal.aborted || this.closing) return 0;
    if (big) { this.bigModelGrant = { query: "@reason", label: big.label }; return 1; }
    // No big model yet: the picker selects one for this conversation only, then Casper goes back until the repair.
    const status = session.getStatus?.();
    const back = status?.provider && status.model ? `${status.provider}/${status.model}` : undefined;
    let picked: string | undefined;
    try {
      const result = await session.selectModel({ picker, persist: false, signal });
      if (result.selected && result.status.provider && result.status.model) picked = `${result.status.provider}/${result.status.model}`;
    } catch { picked = undefined; }
    if (back && picked && picked !== back) {
      try { await session.selectModel({ query: back, persist: false }); } catch { /* the repair switch reports it */ }
    }
    this.updateFooter();
    if (!picked || picked === back || signal.aborted) return 0;
    // The same size check as for a saved big model: a model that can't hold the conversation is not tried.
    let pickedInfo: RuntimeModelInfo | undefined;
    try { pickedInfo = session.describeModel?.(picked); } catch { pickedInfo = undefined; }
    const pickedCost = this.bigModelCost(session, pickedInfo);
    if (!pickedCost.fits) {
      this.events.ensureLineBreak();
      this.output.write(`• ${terminalText(picked)} can't hold this conversation (${pickedCost.words}), so Casper stopped here\n`);
      return 0;
    }
    const remember = await this.terminal.pick(`Use ${terminalText(picked)} as your big model from now on?`,
      REMEMBER_BIG_MODEL_CHOICES.map((choice) => ({ ...choice })), signal);
    if (remember === "Yes" && session.setModelRole) {
      try {
        await session.setModelRole("reason", picked);
        this.output.write(`[model] Saved ${terminalText(picked)} as your big model.\n`);
      } catch (error) {
        this.output.write(`[model] Could not save your big model: ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
      }
    }
    this.bigModelGrant = { query: picked, label: picked, ...(remember === "Yes" ? {} : { oneOff: true as const }) };
    return 1;
  }

  /** "test timed out after 10m. 1 Stop · 2 Retry · 3 Fix it anyway · 4 Allow more time". Stop comes first, so Enter
   * never runs anything or starts a repair; Esc is the same as Stop. */
  private async askUnfinished(unfinished: VerificationResult[], timeoutMs: number, signal: AbortSignal): Promise<UnfinishedChoice | undefined> {
    // The limit the run actually had: after "Allow more time" it is the longer one, not the configured one.
    const limit = (result: VerificationResult) => timedOutAfter(result) ?? timeoutMs;
    const what = unfinished.map((result) => result.ended === "timeout"
      ? `${result.name} timed out after ${formatDuration(limit(result))}` : `${result.name} could not start`).join(", ");
    // More time: four times the limit the run just had (at least a minute, at most an hour), as often as it is chosen.
    const had = Math.max(0, ...unfinished.filter((result) => result.ended === "timeout").map(limit));
    const longer = longerLimit(had);
    const options = unfinishedChoices(had, longer);
    this.events.ensureLineBreak();
    const answer = await this.terminal.ask(`${what}. Casper did not try to fix it. What now?`,
      options.map(({ label, description }) => ({ label, description })), false, signal);
    return options.find((option) => option.label === answer?.[0])?.choice;
  }

  /** The page check for these changed files, from project facts only: undefined when this is not a web project,
   * pages are off, or no change reaches a page; a reason when the dev server can't be started (a missing install). */
  private async planPages(context: ProjectContext, changedPaths: readonly string[] | undefined): Promise<PageCheckPlan | undefined> {
    if (!changedPaths?.length || context.pages === "off") return undefined;
    try {
      return await planPageCheck(this.activeWorkspaceRoot(), { frameworks: context.model.frameworks, packageManager: context.model.packageManager,
        services: context.services ?? {} }, changedPaths, context.pages);
    } catch { return undefined; }
  }

  /** The receipt lines for pages that were not opened: why the dev server can't start, or pages that need a value. */
  private pageNotes(plan: PageCheckPlan | undefined): string[] | undefined {
    if (!plan) return undefined;
    if ("reason" in plan) return [formatPagesNotChecked(plan.reason)];
    return plan.pages.skipped.length ? plan.pages.skipped.map(formatSkippedPage) : undefined;
  }

  /** One page check against the dev server, timed as the `pages` phase. The pages are planned again from every
   * change since the task started, so a repair's edits count. Cancellation is reported by the loop. */
  private pageRun(task: NonNullable<CasperApp["pageTask"]>): (signal: AbortSignal) => Promise<PageReport | undefined> {
    return async (signal) => {
      const now = await this.snapshotWorkspace(task.root, signal);
      const plan = now ? await this.planPages(task.context, pagePaths(diffSnapshots(task.before, now))) : undefined;
      if (signal.aborted || !plan || !("service" in plan) || !plan.pages.open.length) return undefined;
      this.phase("pages", "start");
      try {
        this.taskPageOpener ??= await this.pageOpenerFn({ projectRoot: task.root, stateDirectory: task.context.stateDirectory });
        this.events.ensureLineBreak();
        const checks = new PageChecks(() => this.serviceManager(), plan.service, this.taskPageOpener, plan.pages,
          { announce: (line) => { if (!this.closing) this.output.write(`${terminalText(line)}\n`); }, notice: this.pageNotice });
        return await checks.run(signal);
      } catch (error) {
        if (signal.aborted) return undefined;
        const { name, label, spec } = plan.service;
        return { status: "incomplete", pages: [], skipped: plan.pages.skipped, server: { name, label, command: spec.command },
          reason: `Casper could not open the pages: ${redactPreview(error instanceof Error ? error.message : String(error)).slice(0, 300)}` };
      } finally { this.phase("pages", "end"); }
    };
  }

  /** One smoke run against fresh services, timed as the `smoke` phase. Cancellation is reported by the loop. */
  private smokeRun(smoke: SmokeChecks): (signal: AbortSignal) => Promise<SmokeReport> {
    return async (signal) => {
      this.phase("smoke", "start");
      try { return await smoke.run(signal); }
      catch (error) {
        if (signal.aborted) return { status: "incomplete", checks: [] };
        throw error;
      } finally { this.phase("smoke", "end"); }
    };
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
    await Promise.all([this.broker?.close(), this.lsp?.close(), this.references?.close(), this.browser?.close(), this.services?.close(), this.stopDebugger()]);
    this.browser = undefined;
    this.services = undefined;
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
    try { return (await promisify(execFile)("git", safeGitArgs(["--no-pager", ...args]), {
      cwd: this.activeWorkspaceRoot(), timeout: 5000, maxBuffer: 64 * 1024,
    })).stdout; }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && "stdout" in error && typeof error.stdout === "string")
        return error.stdout.slice(0, 64 * 1024) + "\n[diff truncated at display limit]\n";
      throw error;
    }
  }

  /** Undefined when the tree is too large, unreadable or the task was cancelled mid-walk. */
  private async snapshotWorkspace(root: string, signal?: AbortSignal): Promise<Map<string, string> | undefined> {
    try { return await snapshotTree(root, signal); }
    catch (error) {
      // Kept for the receipt: "Changes unknown: this folder has over 20,000 files; open a project folder".
      if (!signal?.aborted) this.snapshotFailure = snapshotFailureReason(error);
      return undefined;
    }
  }

  private async prepareCapabilities(task: string, includeVisualization = false): Promise<void> {
    const nextTools = await assembleTaskTools(task, includeVisualization, {
      broker: this.broker!, delegate: this.delegateTool(), ask: this.askTool(),
      check: this.checkTask?.tool(), lsp: this.lsp!, confirmRename: this.confirmRename,
      references: this.references!, visualization: this.visualization!, projectRoot: this.activeWorkspaceRoot(),
      browserReady: this.browser?.status().state === "ready", browser: () => this.browserSession(),
      browserSignal: this.commandAbort?.signal,
      services: { declared: Object.keys(this.projectContext?.services ?? {}).length > 0, live: this.services?.live({ detected: false }) ?? false },
      serviceTool: () => serviceTool(() => this.serviceManager(), this.commandAbort?.signal, () => this.smokeTask,
        this.shell?.approve ? (command, signal) => this.shell!.approve!(command, signal) : undefined),
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




  /** The session's service manager, created on first use for the active workspace's declared services. */
  serviceManager(): ServiceManager {
    if (!this.services || this.services.closed) {
      const services = this.services = new ServiceManager({ projectRoot: this.activeWorkspaceRoot(), services: this.projectContext!.services ?? {} });
      this.lifecycle.add({ name: "services", close: () => services.close() });
    }
    return this.services;
  }

  /** The delegate tool carries the per-task dispatch budget, so it is rebuilt only at task
   * boundaries (a new request, or an explicit /verify repair task) — never for repair rounds
   * of the current task. */
  private delegateToolForTask?: RuntimeTool;

  private delegateTool(): RuntimeTool {
    // The child's usage joins the current task's totals (observations are replaced per task).
    this.delegateToolForTask ??= this.subagents.createTool(() => ({
      cwd: this.activeWorkspaceRoot(),
      projectContext: formatProjectContext(this.projectContext!),
    }), (usage) => this.observations.recordDelegatedUsage(usage));
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
    this.onEvent?.(checkEvent(result, this.modelCheckCalls > 0 ? "casper_check" : "casper"));
    this.events.ensureLineBreak();
    // Each check Casper runs shows as it finishes; verbose output keeps the per-run evidence line
    // instead. A check the model ran with casper_check already has its tool line.
    if (this.verbose) this.output.write(`${formatVerificationResult(result)}\n`);
    else if (this.modelCheckCalls === 0) this.output.write(`${liveCheckLine(result)}\n`);
    if (result.status !== "fail") return;
    for (const [stream, text] of [["stderr", result.stderr], ["stdout", result.stdout]] as const) {
      if (!text.trim()) continue;
      const lines = text.replace(/\n$/, "").split("\n");
      const shown = lines.length > 40 ? [`… ${lines.length - 40} earlier line(s) omitted; the full output stays in the check evidence`, ...lines.slice(-40)] : lines;
      this.terminal.writePanel(`${result.name}: ${stream}`, redactPreview(shown.join("\n")), { tone: "error" });
    }
  }

  /** Approvals and server questions are shown one at a time, so two boxes never race for one answer. */
  private approvalQueue: Promise<unknown> = Promise.resolve();
  private oneAtATime<T>(work: () => Promise<T>): Promise<T> {
    const next = this.approvalQueue.then(work, work);
    this.approvalQueue = next.catch(() => {});
    return next;
  }

  /** Once per new set of imported servers: say where they were found. Interactive sessions only. */
  private async reportImports(): Promise<void> {
    const imported = this.mcp?.status().filter((status) => status.importedFrom && status.scope === "imported") ?? [];
    const names = imported.map((status) => status.name);
    if (!this.mcpConsent?.importSetIsNew(names)) return;
    const places = [...new Set(imported.map((status) => (status.importedFrom ?? "").replace(/ \(this project\)$/, "")))];
    const where = places.length > 1 ? `${places.slice(0, -1).join(", ")} and ${places.at(-1)}` : places[0];
    this.output.write(`[mcp] Found ${names.length} server${names.length === 1 ? "" : "s"} in ${where}. Run /mcp to see them.\n`);
    await this.mcpConsent.markImportSet(names).catch(() => {});
  }

  /** ctrl+o: writes off for every server at once. Returns whether any were on. */
  private revertWrites(): boolean {
    const on = this.mcp?.writesOn() ?? [];
    if (!on.length || this.closing) return false;
    // The gate flips at once; servers restart with their pins once their running calls finish.
    for (const server of on) void this.mcp!.setWrites(server, false).catch(() => {});
    for (const server of on) this.output.write(`[mcp] Writes off for ${server}. Write tools are hidden again.\n`);
    this.updateFooter();
    return true;
  }

  /** One exact typed answer from the user, in the same one-at-a-time queue as approvals. */
  chooseAnswer(preview: string, question: string, choices: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
    return this.oneAtATime(() => this.chooseExact(preview, question, choices, signal));
  }

  private approvalStopped(signal?: AbortSignal): boolean {
    return this.closing || Boolean(signal?.aborted) || Boolean(this.commandAbort?.signal.aborted);
  }

  /**
   * The approval box for one MCP call: the real tool, EXECUTE or preview, secrets hidden, an AI-set
   * confirm flagged, and the last preview. Only the user's typed answer counts; the model's ask tool
   * never reaches this prompt. Nobody asked (one-shot, too long, closing) is never "you said no".
   */
  private confirmCapability: ConfirmCapability = async (call, signal) => {
    const header = `MCP · ${call.plan.server} · ${call.plan.tool}  [${planLabel(call.plan)}]`;
    if (tooLongToShow(call.arguments)) {
      if (this.interactive && !this.closing) this.output.write(`${terminalText(header)}\n${TOO_LONG_TEXT}\n`);
      throw new NotExecutedError("arguments too long to show you for approval");
    }
    if (!this.interactive) throw new NotExecutedError("needs your approval, and this run cannot ask");
    return this.oneAtATime(async () => {
      if (this.approvalStopped(signal)) throw new NotExecutedError("cancelled");
      const box = formatApproval(call.plan, call.lastPreview);
      const answer = await this.chooseExact(box.preview, box.question, box.choices, signal);
      if (answer === undefined && this.approvalStopped(signal)) throw new NotExecutedError("cancelled");
      const result = answer === "yes" ? "yes" : answer === "p" && box.choices.includes("p") ? "preview" : "no";
      // A call you allowed that can change things: undo can't reach it, and /undo says so.
      if (result === "yes" && planLabel(call.plan) !== "read") this.taskChangeServers.add(call.plan.server);
      if (!this.closing) this.output.write(`[approval] ${result === "yes" ? "allowed" : result === "preview" ? "preview first" : "denied"}\n`);
      return result;
    });
  };

  /**
   * A server asked about the call the user approved (MCP elicitation). Only the user answers, in the
   * same kind of box; one-shot runs and a closing Casper decline without asking.
   */
  private answerServerQuestion: ServerQuestionHandler = async (question, signal) => {
    if (!this.interactive || this.closing) return { action: "decline" };
    return this.oneAtATime(async () => {
      if (this.approvalStopped(signal)) return { action: "cancel" as const };
      const shown = (text: string) => maskText(text).replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, " ");
      const options = question.options?.map(shown) ?? [];
      // A choice Casper would have to hide or change can't be offered as typed.
      if (question.kind === "choice" && options.some((option, index) => option !== question.options![index])) {
        if (!this.closing) this.output.write(`[mcp] ${terminalText(question.server)} asked a question Casper can only answer yes/no; declined.\n`);
        return { action: "decline" as const };
      }
      // Secrets are hidden before the message is cut, so a cut never shows part of one.
      const message = shown(question.message);
      const cut = message.length > 4000 ? `${message.slice(0, 4000)} … (more not shown)` : message;
      const preview = `${shown(question.server)} asks about the ${shown(question.realTool)} call you approved:\n  ${cut}\n`;
      const choices = question.kind === "boolean" ? ["yes"] : options;
      const prompt = question.kind === "boolean" ? "Answer? Type yes: " : `Answer? Type one of ${options.join(", ")}: `;
      const answer = await this.chooseExact(preview, prompt, choices, signal);
      if (answer === undefined) {
        if (!this.closing) this.output.write("[server question] no\n");
        return { action: "cancel" as const };
      }
      const accepted = answer !== "no" || choices.includes("no");
      if (!this.closing) this.output.write(`[server question] ${accepted ? answer : "no"}\n`);
      if (!accepted) return { action: "decline" as const };
      return { action: "accept" as const, value: question.kind === "boolean" ? true : answer };
    });
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
        // Commit the open `• ask — running` line first, so the recorded question starts on its own line.
        this.output.write("");
        // "ai": the question is labelled "The AI asks:", so it never looks like Casper's own approval.
        return this.terminal.ask(question, options, multi, signals.length ? AbortSignal.any(signals) : undefined, "ai");
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

  /** One exact typed answer from the user (undefined when nobody could answer). The caller records it. */
  private async chooseExact(preview: string, question: string, choices: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
    if (!this.interactive || this.approvalStopped(signal)) return undefined;
    const signals = [signal, this.commandAbort?.signal].filter((value): value is AbortSignal => Boolean(value));
    this.output.write("");
    return this.terminal.choose(preview, question, choices, signals.length ? AbortSignal.any(signals) : undefined);
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

  /** Shift+Tab. A held key walks the ring; the level the presses stop at is saved once, like `/effort`. */
  private cycleEffort(): void {
    if (this.closing) return;
    if (this.commandActive || this.subagents.isBusy) {
      this.terminal.flashNote("effort unchanged · wait until idle");
      return;
    }
    if (this.effortSteps >= 12) return;
    this.effortSteps++;
    this.effortCycle = this.effortCycle.then(async () => {
      try {
        if (!this.closing) await this.applyEffortCycle();
        // What you pick sticks, like /effort: the level the presses stop at is saved once.
        if (!this.closing && this.effortSteps === 1) await this.saveCycledEffort();
      }
      catch (error) {
        if (!this.closing) this.terminal.flashNote(error instanceof Error ? error.message : String(error));
      } finally { this.effortSteps--; }
    });
  }

  private async saveCycledEffort(): Promise<void> {
    const session = this.session;
    const level = session?.getStatus?.().configuredEffort;
    if (!session?.setEffort || !level) return;
    const saved = await session.setEffort(level, true);
    this.terminal.flashNote(`effort ${formatEffort(saved) ?? level} · saved`);
    this.updateFooter();
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
    const writes = this.mcp?.writesOn() ?? [];
    this.terminal.setBadge(writes.length ? `WRITES: ${writes.join(", ")} · ${this.terminal.rich ? "ctrl+o" : "/mcp writes off"}` : undefined);
    try {
      const project = this.projectContext.info;
      const status = this.session?.getStatus?.();
      const usage = this.session?.getUsage?.();
      const percent = usage?.context?.percent;
      const effort = (status && formatEffort(status)) ?? "effort —";
      const model = status?.model ? `${status.provider}/${status.model} · ${effort}`
        : this.session ? "no model selected · /model" : (this.runModel ? `${terminalText(this.runModel)} (--model)` : this.savedModelDisplay) ?? "model not initialized · /model";
      this.terminal.setStatus(`${project.name}/${project.gitBranch ?? "no git"} │ ${model} │ ctx ${percent == null ? "—" : `${percent.toFixed(0)}%~`}${usage ? ` │ ${usage.tokens.total} tok` : ""}${usage?.estimatedCost === undefined ? "" : ` │ $${usage.estimatedCost.toFixed(3)} est`} │ ${this.commandActive ? "working" : "idle"}`, project.root);
    } catch { this.terminal.setStatus("Session status unavailable · /status", this.projectContext.info.root); }
  }

  /** Whether the task's code may differ from its start. A shell command's effect is unknown, so the tree is
   * compared to the start; an uncomparable tree counts as changed. */
  private async changedSinceTaskStart(edits: NonNullable<CasperApp["taskEdits"]>): Promise<boolean> {
    if (edits.edited || edits.turnEnded) return true;
    if (!edits.shell) return false;
    const now = edits.before && await this.snapshotWorkspace(this.activeWorkspaceRoot());
    return !now || Object.values(diffSnapshots(edits.before!, now)).some((paths) => paths.length > 0);
  }

  private observeEdit(path: string): void {
    if (this.taskEdits) this.taskEdits.edited = true;
    this.browser?.invalidate();
    this.services?.markEdited(path);
    (this.checkTask ?? this.verificationTask)?.invalidateForEdit(path);
    this.observations.recordEdit(path);
  }
}

/** Why a change whose checks passed was not compared with and without it, in plain words for the receipt. */
/** The verdict's reason when only page checks passed: they show the pages load, not that the change works. */
export const PAGES_ONLY_PROOF = "pages load, but no test fails without the change";
/** The same without Chrome: a page that answers over HTTP may still fail once its scripts run. */
export const PAGES_ANSWER_ONLY_PROOF = "pages answer, but their console was not checked and no test fails without the change";

/** The files a page check plans from: added and changed ones (a removed page is not opened). */
function pagePaths(changes: TreeChanges): string[] { return [...changes.added, ...changes.modified].sort(); }

export function proofSkipReason(options: { intent: string; testCommand?: string; snapshot: boolean; changedCode: boolean }): string {
  if (options.intent === "refactor") return "a refactor should not change behavior, so no test is expected to fail without it";
  if (["document", "inspect", "visualize", "configure"].includes(options.intent)) return `Casper does not compare ${options.intent} requests with and without the change`;
  if (!options.testCommand) return "there is no test command to compare with; add verify.test to .casper/project.yaml";
  if (!options.snapshot) return "Casper could not record the workspace before the change";
  if (!options.changedCode) return "only non-code files changed";
  return "Casper did not compare the tests with and without the change";
}
