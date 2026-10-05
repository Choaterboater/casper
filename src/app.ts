import { execFile } from "node:child_process";
import type { DebugSession } from "./debug/session";
import { promisify } from "node:util";
import os from "node:os";
import { resolveEntry } from "./sandbox/policy";
import { riskyBaseline, riskyLinesIn } from "./network/risky-receipt";
import type { LabSettings } from "./network/spec";
import path from "node:path";
import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { hasSignIn, modelPreference } from "./tui/model-preference";
import { BrowserSession } from "./browser/session";
import { ServiceManager } from "./services/manager";
import { SmokeChecks } from "./services/smoke";
import { pageOpener, type DevServerNotice, type PageOpener } from "./services/page-checks";
import { InteractiveTerminal, type TerminalHost } from "./tui/terminal";
import type { PaneSetting } from "./tui/pane-setting";
import type { DisplayLevel } from "./tui/display";
import { formatRuntimeStartLine, formatRuntimeStatus, lineText, redactPreview, terminalText } from "./tui/format";
import { detectWebService, isDetectedWebService } from "./services/detect";
import { ProjectMemory, type TaskOutcome } from "./memory/store";
import { discoverReferenceConfiguration, type ReferenceConfiguration } from "./references/config";
import { formatReferenceResult, ReferenceLibrary } from "./references/library";
import { SubagentManager } from "./agents/manager";
import { discoverLSPConfiguration, type LSPConfiguration } from "./lsp/config";
import { LSPManager, type ConfirmRename } from "./lsp/manager";
import { SessionYes } from "./app/session-yes";
import { boundCapabilityResult } from "./capabilities/result";
import { discoverMCPConfiguration, type MCPConfiguration } from "./mcp/config";
import { MCPManager } from "./mcp/manager";
import { ConsentStore } from "./mcp/consent";
import { CapabilityBroker } from "./capabilities/broker";
import { Scrubber } from "./secrets/netconan";
import { hiddenSecretGate } from "./secrets/gate";
import { scrubToolOutput } from "./secrets/tool-output";
import type { Readable } from "node:stream";
import { formatProjectContext, loadProjectContext, type ProjectContext } from "./project/context";
import { findProjectCandidates, hasProjectSignals, inspectProject, type ProjectInfo } from "./project/inspect";
import { childProjectOf, type ChildProject } from "./project/child";
import type { AgentRuntime, RuntimeAuthProvider, RuntimeSession, RuntimeImage, RuntimeModelInfo, RuntimeStatus, RuntimeTool, RuntimeShell } from "./runtime/types";
import { SkillRegistry, formatSelectedSkills, skillRegistryOptions } from "./skills/registry";
import { classifyTask, formatTaskPrompt, underSpecifiedTarget } from "./task/classify";
import { answerClaimsBrowserPass, formatShortReceipt, undoPathsShown, formatTaskResult, type TaskResult, type TaskUsage } from "./task/result";
import { TaskObservations } from "./task/observations";
import { LifecycleRegistry } from "./app/lifecycle";
import { helperActivityLine, RuntimeEventView } from "./app/events";
import { diffSnapshots, snapshotFailureReason, snapshotTree, type TreeChanges } from "./task/changes";
import { renderBanner, wordmarkHeader } from "./tui/banner";
import type { CheckName, VerificationReport } from "./verify/evidence";
import { ProcessCleanupError } from "./platform/processes";
import { safeGitArgs } from "./platform/git";
import { VerifierRegistry } from "./verify/registry";
import { longerLimit, timedOutAfter, verifyAndRepair, type UnfinishedChoice } from "./verify/repair-loop";
import { ALREADY_FAILING_CHOICES, modelFailedChoices, NO, pictureChoices, PLAN_CHOICES, YES_ONCE, YES_SESSION, PLAN_QUESTION, REMEMBER_BIG_MODEL_CHOICES, REPAIR_LIMIT_STOP, spendChoices, unfinishedChoices, workFolderChoices } from "./app/safe-choices";
import { DEFAULT_SPEND_LIMITS, formatCost, formatFooterSpend, formatLimit, formatTokens, SPEND_STOP_REASON, SpendGuard, requestSpendLimit } from "./task/spend";
import { VerificationTask } from "./verify/task";
import { ChangeBaseline, changesCode, proofRepairPrompt, type ChangeProof } from "./verify/proof";
import { independentAcceptance } from "./verify/acceptance";
import { parseChecklist, parseReview, requirementsReviewPrompt, ROUND_MAX_TURNS, type RequirementsReview } from "./task/review";
import { extractChecklist, formatChecklistPrompt, normalizeCases } from "./task/checklist";
import { isOutside } from "./platform/inside";
import { autoDetectedChecks } from "./verify/migrations-check";
import type { NetworkToolContext } from "./verify/registry";
import { buildNextRow, type NextItem } from "./tui/next-row";
import { TaskUndo } from "./app/undo";
import { SuggestionController, SUGGESTION_COMMAND } from "./app/suggestions";
import { findFlow, formatFlowPrompt, loadFlowCatalog, type Flow, type FlowRule } from "./flows/catalog";
import { beforeWorkPanel, readBeforeWorkAnswer, suggestBeforeWork } from "./flows/suggest";
import { extractPlan, parsePlanLines, planEditorHeading, planEditorLines, planToolGate, type ParsedPlan } from "./flows/plan";
import { PROJECT_YAML, saveProjectCommand } from "./project/config-write";
import type { SecurityAIReview, SecurityReviewHost } from "./app/security-review";
import type { TaskClassification } from "./task/classify";
import { describeChecksPlan, hasChecks, planAutoChecks, resolveVerificationMode, type ChecksPlan, type VerificationMode } from "./verify/mode";
import { MermaidProvider } from "./visualize/mermaid";
import { MindMeshProvider } from "./visualize/mindmesh";
import { VisualizationRouter } from "./visualize/router";
import { assembleTaskTools } from "./app/capabilities";
import { attachImages, leadingImagePath, startsWithImageFile } from "./app/images";
import { lookPrompt, pageLook, SHOW_PAGES_CHOICES, SHOW_PAGES_QUESTION } from "./services/page-look";
import { DEFAULT_WEB } from "./config/load";
import { AGENT_DIR_ENV, casperAgentDir } from "./runtime/agent-store";
import { loginValuesFrom, WebLookup, webProvider, type WebLookupOptions } from "./web/lookup";
import { systemPromptAppend } from "./app/prompt";
import type { VisualizationProvider } from "./visualize/types";
import { SessionWorkspaceManager } from "./sessions/manager";
import { runSlashCommand, type OutputWriter } from "./app/commands";
import type { BackgroundTask } from "./app/background";
import { detectHostTerminal } from "./tui/host-terminal";
import { UsageError } from "./cli-args";
import { RuntimeEventMapper, sessionStartEvent, type CasperEvent } from "./app/json-events";
import { StepRail } from "./app/steps";
import { CASPER_VERSION } from "./version";
import type { Install } from "./update/command";
import { refreshUpdateCheck, updateChecksOff, updateNotice } from "./update/notice";
import { createSessionSandbox, outsideWritesReceipt, runtimeShell, sandboxReceipt, sandboxStartupNotes, sandboxStatusLine, type RunAllowances, type SandboxHost } from "./app/sandbox";
import { useSandbox, currentSandbox, type ShellSandbox, type ShellSandboxOptions } from "./sandbox/manager";
import { SandboxStore } from "./sandbox/store";
import { loginMissingAnswer, type LoginHost } from "./mcp/network/ask-login";
import { loginFile, type NetworkProduct } from "./mcp/network/logins";
import type { SetupHost } from "./mcp/network/setup";
import { newProjectFromQuestions, opened } from "./app/new-project";
import { runSettings } from "./app/settings";
import { runPreview } from "./services/preview";
import { editUserConfig } from "./config/user-write";
import { explainModelError } from "./runtime/model-errors";
import { tildePath, type NewProjectOptions, type NewProjectResult } from "./new/scaffold";
import { chooseAnswer, approveChoice, confirmCapability, confirmKind, answerServerQuestion, editGateReason, confirmYes, recordedApproval } from "./app/approvals";
import { networkSetupHost, offerNetworkServer, networkLoginHost, networkLoginFile, revertWrites, reportImports } from "./app/network-host";
import { updateFooter, nameConversation, phase, clearSteps, displayLevel, loadPaneSetting, askPaneOnce, paneCommand, detailsCommand, expandLastStep } from "./app/footer";
import { settleQueuedLines, submitDuringWork, cycleEffort } from "./app/during-work";
import { spendNote, spendGate } from "./app/spend-gate";
import { prepareCapabilities, browserSession, serviceManager, stopDebugger, backgroundTasks, planPages, pageNotesFor, pageRun, smokeRun, pagePaths } from "./app/task-tools";
import { ensureModel, retryModelFailure, bigModelReceipt, bigModelNotice, switchToBigModel, restoreModel, askBigModelRetry, type BigModelChoice, bigModelOf, imagesForModel, switchForPictures } from "./app/big-model";
import { newProjectFlowWithAbort, openProjectFolder, openProjectCommand, newProjectCommand, offerNewProject, childProjectOfTask, runChildChecks, offerWorkFolder } from "./app/workspace";
import { ensureSessionWorkspace, handleBranchCommand, handleSwitchCommand, rebindWorkspace } from "./app/session-branches";
import { runVerification, writeCheckResult, taskNetworkOptions, checksPlan, saveFoundCheck, projectAfterSetup } from "./app/verification";

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
  /** The install a session checks for a newer Casper (see src/update/notice.ts); unset, no line and no check. */
  updateCheck?: { install: Install; currentVersion: string };
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
  /** A fake uv and runner for the network server's install (tests). */
  networkSeams?: { install?: SetupHost["install"] };
  /** --no-sandbox: the shell sandbox is off for this run, and the receipt says so. */
  noSandbox?: boolean;
  /** --allow-host, --allow-write (absolute folders) and --allow-reach: allowed for this run without asking. */
  allow?: RunAllowances;
  /** Tests: the sandbox's engine, machine check or platform. */
  sandboxSeams?: Partial<ShellSandboxOptions>;
  /** Tests: the web lookups' transport, DNS, clock, provider or login keys. */
  webSeams?: Partial<WebLookupOptions>;
  /** The terminal Casper runs in (tmux, iTerm2). Read from the environment when Casper writes to its own stdout. */
  terminalHost?: TerminalHost;
}

/** A Casper session. Its code lives here and in the src/app/ modules (approvals, ...), which take the app as their
 * first argument: members without `private` may be read and set by those modules, not only by embedders. */
export class CasperApp {
  /** The provider of the last successful /login, preferred when Casper picks a first model. */
  loginProvider?: RuntimeAuthProvider;
  /** The current task's stages for the footer. */
  readonly steps = new StepRail();
  /** Browser actions and debugger launches you said "Yes, for this session" to. */
  readonly sessionYes = new SessionYes((preview, question, options, signal) => recordedApproval(this, preview, question, options, signal));
  private readonly runtimeFactory: () => AgentRuntime | Promise<AgentRuntime>;
  readonly subagents: SubagentManager;
  readonly inspectProjectFn: (cwd: string) => Promise<ProjectInfo>;
  readonly loadProjectContextFn: (project: ProjectInfo) => Promise<ProjectContext>;
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
  mcpConsent?: ConsentStore;
  /** Re-reads MCP configuration from disk for /mcp reload; set with the loaded workspace. */
  reloadMCPConfiguration?: () => Promise<MCPConfiguration>;
  broker?: CapabilityBroker;
  /** One shared scrubber: MCP results always, config files and command output while scrubFiles is on. */
  readonly scrubber: Scrubber;
  /** /secrets files on|off: scrub native reads of config files and config-looking command output. */
  scrubFiles = true;
  readonly runGit?: CasperAppOptions["runGit"];
  /** Owned-subsystem teardown bookkeeping: idempotent per subsystem, drained at close. */
  readonly lifecycle = new LifecycleRegistry();
  runtimeTools: RuntimeTool[] = [];
  /** Tools offered in this conversation. They stay offered, so the provider's prompt cache holds. */
  readonly offeredTools = new Set<string>();
  readonly terminal: InteractiveTerminal;
  interactive = false;
  /** beforeChanges gate state for the current task; a recorded ask attempt satisfies it. */
  editGateActive = false;
  asksThisTask = 0;
  private cancelBeforeCommand = false;
  commandAbort?: AbortController;
  /** Transcript-flow renderer for runtime events; owns the open tool/progress line state. */
  readonly events: RuntimeEventView;
  readonly output: OutputWriter;
  private readonly input: Readable;
  runtime?: AgentRuntime;
  runtimeLoad?: Promise<AgentRuntime>;
  runtimeStart?: Promise<RuntimeSession>;
  session?: RuntimeSession;
  /** A request typed at a startup question: the first request of the session. */
  queuedPrompt?: string;
  /** /pane on|off as saved; undefined until something was saved. */
  paneSetting?: PaneSetting;
  paneAsked = false;
  /** Lines typed during a task that the AI could not read then: each runs as the next request, in order. They live
   * here, never in the prompt editor, so no queued line can ever answer an approval box. */
  readonly queuedLines: string[] = [];
  /** /details for this session; unset follows display: in the config. */
  displayChoice?: DisplayLevel;
  closing = false;
  private closeWork?: Promise<void>;
  unsubscribe?: () => void;
  projectContext?: ProjectContext;
  skillRegistry?: SkillRegistry;
  private readonly reportedSkillWarnings = new Set<string>();
  readonly verificationFlag?: VerificationMode;
  readonly verbose: boolean;
  private readonly startupWarnings: readonly string[];
  private readonly updateCheck?: { install: Install; currentVersion: string };
  private readonly updateCheckAbort = new AbortController();
  readonly runModel?: string;
  private readonly runEffort?: string;
  runConversation?: CasperAppOptions["conversation"];
  readonly maxTurns?: number;
  readonly onEvent?: (event: CasperEvent) => void;
  private readonly eventMapper = new RuntimeEventMapper();
  /** The text of the response being streamed, and of the last response that had text. */
  private responseText = "";
  private lastAnswer = "";
  /** casper_check calls in flight: their results were requested by the model, not by Casper. */
  modelCheckCalls = 0;
  /** Turns after which --max-turns stopped the current task's model request. */
  taskTurnLimit?: number;
  /** The spend pause stopped the current task's model request: what it had used, and the limit. */
  taskSpendStop?: { spent: number; limit: number };
  /** This task's spend note and pause (src/task/spend.ts); a fresh one per task. */
  spendGuard?: SpendGuard;
  /** The spend question while it is open, so parallel tool calls wait on the one answer. */
  spendAsk?: Promise<string | undefined>;
  verificationAbort?: AbortController;
  verificationWork?: Promise<VerificationReport>;
  /** Active repair evidence; sharing it does not grant managed-tool consent. */
  verificationTask?: VerificationTask;
  checkTask?: VerificationTask;
  /** This task's smoke checks (configured and model-recorded); run inside the task's verification. */
  smokeTask?: SmokeChecks;
  /** This task's page check: set when its changes reach a page of a web project in auto mode. */
  pageTask?: { context: ProjectContext; root: string; before: Map<string, string> };
  /** The page opener of the current task (one disposable browser per task), closed when the task ends. */
  taskPageOpener?: PageOpener;
  readonly pageOpenerFn: NonNullable<CasperAppOptions["pageOpener"]>;
  /** The dev-server lines are printed once per session. */
  readonly pageNotice: DevServerNotice = { shown: false };
  /** What may have changed this task's code since it started: a check the model records after that has no
   * before-the-change baseline. `before` is the task's starting tree, compared only after a shell command. */
  private taskEdits?: { before?: Map<string, string>; edited: boolean; shell: boolean; turnEnded: boolean };
  readonly sessionHomeDir?: string;
  sessionWorkspace?: SessionWorkspaceManager;
  sessionWorkspaceStart?: Promise<SessionWorkspaceManager>;
  lastTaskRequest?: string;
  commandActive = false;
  /** What the session's earlier model tasks spent; the footer adds the current task to it. */
  spentBefore = { tokens: 0, cost: 0 };
  /** Shift+Tab steps already accepted. The prompt loop drains this before a request starts. */
  effortSteps = 0;
  effortCycle: Promise<void> = Promise.resolve();
  private workspaceTransition = false;
  workspaceNeedsRebind = false;
  /** Project folders the user chose to stay out of at "The work is in ...": not asked again this session. */
  readonly stayedOutOf = new Set<string>();
  /** Why the last workspace snapshot failed, for the task's receipt. */
  private snapshotFailure?: string;
  taskRuntimeFailed = false;
  /** The files from before the current task's change, while it runs: tells a failure the change caused from one already there. */
  taskBaseline?: { baseline: ChangeBaseline; root: string };
  private cleanupError?: ProcessCleanupError;
  readonly blockOnCleanupFailure = () => {
    this.cleanupError = new ProcessCleanupError();
    this.commandAbort?.abort(); this.verificationAbort?.abort(); this.checkTask?.abort();
    void this.session?.abort().catch(() => {});
  };
  savedModelDisplay?: string;
  /** False when no sign-in exists (no saved provider, no provider key): the banner and footer say how to start. */
  signedIn?: boolean;
  taskRuntimeCancelled = false;
  private lastTaskResult?: TaskResult;
  /** Tokens the AI security review spent in this command (no task to carry them). */
  private commandSpent?: TaskUsage;
  /** Undo, redo, /diff and saved receipts: a copy before and after each task. */
  readonly taskUndo = ((app: CasperApp) => new TaskUndo({
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
  taskChangeServers = new Set<string>();
  /** What the row under an interactive receipt offers (Undo, Show diff, suggestions...). Each source says what
   * it offers for this task, or nothing; Undo and Show diff keep slots 1 and 2, the rest follow from 3. */
  readonly nextSteps: Array<(task: TaskResult) => { undo?: NextItem; diff?: NextItem; more?: NextItem[] } | undefined> = [];
  observations = new TaskObservations();
  memoryWork?: Promise<void>;
  private readonly newProjectRequest?: CasperAppOptions["newProject"];
  readonly createProjectFn?: CasperAppOptions["createProject"];
  readonly networkTools?: NetworkToolContext;
  readonly securitySeams?: Pick<SecurityReviewHost, "check" | "install">;
  readonly networkSeams?: CasperAppOptions["networkSeams"];
  /** Setup is offered at most once a session, and an update asked about at most once. */
  networkSetupOffered = false;
  networkUpdateAsked = false;
  /** Network products the person said Not now to this session: the AI's next try doesn't ask again (/mcp login does). */
  readonly loginNotNow = new Set<NetworkProduct>();
  /** `casper new` on a terminal: the exit code when no project was opened (1 when nothing was created). */
  newProjectExitCode?: number;
  /** The build-request question is asked at most once per session. */
  newProjectOffered = false;
  /** This task already showed its one question before work (the new-project question): no checklist panel. */
  beforeWorkAsked = false;
  /** Receipts say the no-checks how-to once per session, and name a file undo can't put back once. */
  private checksHintShown = false;
  private readonly undoNamed = new Set<string>();
  /** The next repair runs on this model (the big model), then Casper switches back. */
  repairOnBigModel?: BigModelChoice;
  /** The user said yes to one more try on the big model at the repair limit. */
  bigModelGrant?: BigModelChoice;
  /** Repairs this task ran on the big model, for the receipt. */
  bigModelUse?: { model: string; attempts: number; oneOff: boolean };
  /** The repair the current verification is on, for the question at the limit. */
  repairsTried = 0;
  /** "repair.bigModelLastTry is on but no big model is set" is said once per session. */
  bigModelNoticeShown = false;
  /** Suggested next steps on the receipt's row, their fading, and /suggestions. Other parts register rules here. */
  readonly suggestions = new SuggestionController((text) => { if (!this.closing) this.output.write(text); }, () => this.homeDir());
  /** A plan turn is running: every tool but reading is refused (see src/flows/plan.ts). */
  private planning = false;
  /** Flow warnings (a user's flow that could not be used) are said once. */
  private readonly flowWarnings = new Set<string>();
  /** The session's shell sandbox (src/sandbox): every shell path runs in it when it can run here. */
  sandbox?: ShellSandbox;
  shell?: RuntimeShell & { close(): Promise<void> };
  private readonly noSandbox: boolean;
  private readonly allow?: RunAllowances;
  private readonly sandboxSeams?: Partial<ShellSandboxOptions>;
  /** web_search and web_fetch for this workspace; unset when web: off. */
  web?: WebLookup;
  private readonly webSeams?: Partial<WebLookupOptions>;

  constructor(options: CasperAppOptions = {}) {
    const freshPiRuntime = async () => {
      const { PiRuntime } = await import("./runtime/pi");
      return new PiRuntime({ homeDir: this.sessionHomeDir ?? os.homedir() });
    };
    this.runtimeFactory = options.runtimeFactory ?? freshPiRuntime;
    this.pageOpenerFn = options.pageOpener ?? pageOpener;
    this.networkTools = options.networkTools;
    this.securitySeams = options.securitySeams;
    this.networkSeams = options.networkSeams;
    this.subagents = new SubagentManager({ runtimeFactory: async () => {
      if (this.workspaceTransition || this.workspaceNeedsRebind) throw new Error("Workspace transition is in progress; delegation is blocked");
      const child = await (options.subagentRuntimeFactory ?? freshPiRuntime)();
      if (child === this.runtime) throw new Error("The main runtime cannot be reused as a subagent");
      return child;
    },
    // A child's file reads reach a model too: same scrubbing, same /secrets files switch (device
    // configs only; .env, credential files and secret env values are always hidden).
    scrubToolOutput: (toolName, input, texts, signal) => scrubToolOutput(this.scrubber, toolName, input, texts, signal, { configs: this.scrubFiles, networkLoginFile: networkLoginFile(this) }),
    cache: () => this.projectContext?.cache,
    privatePaths: () => this.projectPrivatePaths(),
    // Inside tmux or iTerm2 each helper's steps show in the view-only steps pane; nowhere else.
    onActivity: (activity) => this.terminal.logHelper(helperActivityLine(activity, this.projectContext ? this.activeWorkspaceRoot() : undefined)),
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
      profileName: context.profileName, ...(options.sessionHomeDir ? { homeDir: options.sessionHomeDir } : {}),
    }));
    this.input = options.input ?? process.stdin;
    // A real terminal (not an embedder's or a test's output) that is tmux or iTerm2: Casper fits itself to it.
    const detected = options.output === undefined ? detectHostTerminal() : undefined;
    const host = options.terminalHost ?? (detected && (detected.tmux || detected.iterm) ? { host: detected } : undefined);
    this.terminal = new InteractiveTerminal(this.input, options.output ?? process.stdout,
      () => this.cancelCurrent(), () => { if (this.commandActive && !this.closing) void this.close().catch(() => {}); }, host);
    this.terminal.setEffortCycle(() => cycleEffort(this));
    this.terminal.setBusySubmit((line, plain) => submitDuringWork(this, line, plain));
    // ctrl+o: MCP writes off everywhere, at once, even while work runs.
    this.terminal.setWritesRevert(() => revertWrites(this));
    // ctrl+t: the last step in full, even while work runs.
    this.terminal.setExpandLast(() => expandLastStep(this));
    // Tool calls live in the event view's Working box on a rich surface; the transcript gets plain writes.
    this.output = { write: (text) => { this.terminal.write(text); } };
    this.events = new RuntimeEventView(this.terminal, this.output, {
      updateFooter: () => updateFooter(this),
      display: () => displayLevel(this),
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
      homeDir: () => this.sessionHomeDir ?? os.homedir(),
    });
    this.verbose = options.verbose ?? false;
    this.startupWarnings = options.startupWarnings ?? [];
    this.updateCheck = options.updateCheck;
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
    this.allow = options.allow;
    this.sandboxSeams = options.sandboxSeams;
    this.webSeams = options.webSeams;
  }

  /** What the sandbox asks through: Casper's own numbered question, only while someone can answer it. */
  private sandboxHost(): SandboxHost {
    return {
      canAsk: () => this.interactive && this.terminal.canAsk && !this.closing,
      pick: (question, options, signal) => this.terminal.pick(question, options, signal ?? this.commandAbort?.signal),
      write: (text) => { if (!this.closing) this.output.write(text); },
      planning: () => this.planning,
      labHosts: () => this.projectContext?.lab?.hosts ?? [],
    };
  }

  /** Load all workspace metadata before publishing it. No connections or model startup. */
  async loadWorkspace(cwd: string) {
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
      noSandbox: this.noSandbox, ...(this.allow ? { allow: this.allow } : {}), ...(this.sandboxSeams ? { seams: this.sandboxSeams } : {}) });
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
      // Casper's network server starts with the logins saved in ~/.casper/network-logins.json.
      homeDir: this.sessionHomeDir ?? os.homedir(),
      elicit: (question, signal) => answerServerQuestion(this, question, signal),
      onNote: (text) => { if (!this.closing) this.output.write(`${text}\n`); },
    });
    // Re-reads the same layered files the manager was built from; the manager diffs them.
    this.reloadMCPConfiguration = () => this.loadMCPConfigurationFn(context);
    this.lsp = new LSPManager(context.info.root, lspConfiguration);
    this.visualization = new VisualizationRouter({ providers: this.visualizationProviders, settings: context.visualize, workspaceRoot: context.info.root });
    // Every server starts with writes off; only the user turns them on (/mcp writes <name>).
    this.broker = new CapabilityBroker(this.mcp, (call, signal) => confirmCapability(this, call, signal), { writesGate: true, scrubber: this.scrubber,
      onSessionCovered: (server, tool) => { if (!this.closing) this.output.write(`[approval] allowed (this session): ${terminalText(server)} · ${terminalText(tool)}\n`); },
      confirmKind: (ask, signal) => confirmKind(this, ask, signal),
      onAllowAll: (server, tool) => {
        this.taskChangeServers.add(server);
        if (!this.closing) this.output.write(`[approval] allowed (allow all): ${terminalText(server)} · ${terminalText(tool)}\n`);
      },
      onAllowAllStart: () => updateFooter(this),
      // A product with no login: the person is asked (never the AI); the AI gets one line back.
      onLoginMissing: (server, product, _signal, trouble) => loginMissingAnswer(networkLoginHost(this), server, product, trouble) });
    this.lifecycle.add({ name: "references", close: () => this.references!.close() });
    this.applyWeb(context);
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
      ...(this.interactive ? await this.bannerChecks(context) : {}) }));
    for (const note of sandboxStartupNotes(context.info.root)) this.output.write(`${note}\n`);
    // A returning user's saved default is known before the runtime starts; say so, not "not initialized".
    if (!this.session) this.savedModelDisplay = await modelPreference(this.sessionHomeDir ?? os.homedir());
    if (!this.session) await this.checkSignIn();
    // --model names the model for this run: show it, not the saved default it overrides.
    const shown = this.runModel && !this.session ? `${terminalText(this.runModel)} for this run (--model)` : this.savedModelDisplay;
    this.output.write(`${formatRuntimeStatus(this.session?.getStatus?.(), shown, this.signedIn, this.interactive && this.terminal.rich)}\n`);
    for (const warning of [...this.startupWarnings, ...context.warnings ?? []]) this.output.write(`[config] ${terminalText(warning)}\n`);
    for (const diagnostic of referenceConfiguration.diagnostics) this.output.write(`[references] ${formatReferenceResult(diagnostic)}\n`);
    this.reportSkillWarnings();
    for (const diagnostic of mcp.diagnostics) this.output.write(`[mcp] ${terminalText(diagnostic)}\n`);
    if (this.interactive) await reportImports(this);
    if (this.interactive) await this.reportNewerCasper(context);
    for (const diagnostic of lspConfiguration.diagnostics) this.output.write(`[lsp] ${diagnostic}\n`);
    for (const diagnostic of visualization.diagnostics) this.output.write(`[visualize] ${diagnostic}\n`);
    if (this.interactive) this.output.write("\n");
    return project;
  }

  /** Next commands in a receipt are slash commands in a session, casper invocations otherwise. */
  receiptSurface(): "interactive" | "one-shot" {
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
      return relative === "" || !isOutside(relative);
    });
    if (inside) return {};
    // cmd and Windows PowerShell never expand ~, so on Windows the command names the folder in full.
    return { folder: process.platform === "win32" ? root : tildePath(root, this.sessionHomeDir ?? os.homedir()) };
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

  async runInteractive(cwd = process.cwd()): Promise<void> {
    // Own the terminal before the banner so startup output is transcript, not
    // loose text a later redraw would drop.
    this.interactive = true;
    this.terminal.start();
    let workspace = cwd;
    if (!this.projectContext && this.newProjectRequest) {
      // `casper new` on a terminal: the project first, then Casper opens there. Nothing built: no session.
      const result = await newProjectFlowWithAbort(this, (flow) => newProjectFromQuestions(flow, this.newProjectRequest!, undefined, (text) => { this.queuedPrompt = text; }));
      if (!opened(result)) {
        if (!result && !this.closing) this.output.write("Nothing was created.\n");
        this.newProjectExitCode = result?.exitCode ?? 1;
        this.terminal.close();
        this.interactive = false;
        return;
      }
      workspace = result.dir;
    } else if (!this.projectContext) workspace = await openProjectFolder(this, cwd);
    if (!this.projectContext) {
      await this.start(workspace);
    }

    this.savedModelDisplay = await modelPreference(this.sessionHomeDir ?? os.homedir());
    await this.checkSignIn();
    await loadPaneSetting(this);
    updateFooter(this);
    while (!this.closing) {
      this.cancelBeforeCommand = false;
      updateFooter(this);
      // A request typed at the empty-folder question runs first, as if typed at the prompt.
      const queued = this.queuedPrompt ?? this.queuedLines.shift();
      this.queuedPrompt = undefined;
      // A queued line is a request of its own: the last receipt's row no longer applies.
      if (queued) { this.terminal.offerNext(undefined); this.events.writePrompt(queued); }
      const line = queued ?? await this.terminal.readCommand();
      if (line === undefined) break;
      if (this.cancelBeforeCommand) {
        this.output.write("[cancel] Stopped before it started; nothing ran.\n");
        continue;
      }
      const prompt = line.trim();

      if (!prompt) {
        continue;
      }

      if (prompt === "/quit" || prompt === "/exit") {
        break;
      }

      try {
        if (!prompt.startsWith("/")) await askPaneOnce(this);
        await this.handlePrompt(prompt);
      }
      catch (error) {
        if (this.closing) break;
        this.events.ensureLineBreak();
        const message = error instanceof Error ? error.message : String(error);
        if (!this.commandAbort?.signal.aborted && this.events.lastError !== message) this.events.showError(message);
      }
      settleQueuedLines(this);
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
    this.output.write("[cancel] Stopping. Changes made so far stay as they are.\n");
  }

  /** A session (never a one-shot run) says when a newer Casper is out, from the last check, then checks again in the
   * background at most once a day. Off with `updates: false`, CASPER_NO_UPDATE_CHECK=1 or CI. */
  private async reportNewerCasper(context: ProjectContext): Promise<void> {
    if (!this.updateCheck || context.updates === false || updateChecksOff(process.env)) return;
    const options = { ...this.updateCheck, stateDir: path.join(this.sessionHomeDir ?? os.homedir(), ".casper"), signal: this.updateCheckAbort.signal };
    const line = await updateNotice(options).catch(() => undefined);
    if (line) this.output.write(`[update] ${line}\n`);
    void refreshUpdateCheck(options);
  }

  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closing = true;
    this.updateCheckAbort.abort();
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
            ?? (toolName === "edit" || toolName === "write" ? editGateReason(this, toolName) : undefined),
          // At the spend pause the next tool call waits for the answer (Stop here is the Enter choice).
          beforeToolWait: (_toolName, signal) => spendGate(this, signal),
          // Config files and config-looking command output (/secrets files off stops these for this
          // session), plus .env, credential files and secret env values (always).
          scrubToolOutput: (toolName, input, texts, signal) => scrubToolOutput(this.scrubber, toolName, input, texts, signal, { configs: this.scrubFiles, networkLoginFile: networkLoginFile(this) }),
          ...(this.shell ? { shell: this.shell } : {}),
          ...(context.cache ? { cache: context.cache } : {}),
          // The project's sandbox.denyRead (GreenCLI lists its data and log folders there): the file tools refuse them too.
          privatePaths: this.projectPrivatePaths(),
        });
        const resumeNotice = await (await ensureSessionWorkspace(this)).resumeActive(this.session);
        if (resumeNotice) this.output.write(`[sessions] ${resumeNotice}\n`);
        await this.applyRunConversation(this.session);
        await this.applyRunSelection(this.session);
        this.unsubscribe = this.session.subscribe(event => {
          if (event.type === "tool_start" && event.toolName === "casper_check") this.modelCheckCalls++;
          if (event.type === "tool_end" && event.toolName === "casper_check") this.modelCheckCalls = Math.max(0, this.modelCheckCalls - 1);
          this.observations.observeUsage(event);
          if (event.type === "assistant_response_end") spendNote(this);
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
        updateFooter(this);
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
      if (this.interactive && session.getSessionInfo) await (await ensureSessionWorkspace(this)).rememberConversation(session);
    }
    this.output.write(`[session] Continuing conversation ${target}.\n`);
  }

  /** `--model`/`--effort` select for this conversation only (persist: false), before any request.
   * A selector or level the catalog rejects is a usage error; missing credentials are not. */
  private async applyRunSelection(session: RuntimeSession): Promise<void> {
    const flagError = (flag: string, error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return /^(?:Credential|Not signed in to|No key for)/.test(message) ? new Error(message) : new UsageError(`${flag}: ${message}`);
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
    if (!/^\/(?:help(?: \S.*)?|status|project|permissions|mcp|lsp|browser|debug|services|tasks|exit|quit|browser close|debug stop)$/.test(prompt)
      && !/^\/(?:mcp|lsp) disconnect\s/.test(prompt) && !/^\/(?:services|tasks) stop\s/.test(prompt) && !/^\/services logs\s/.test(prompt)) {
      if (this.cleanupError) throw this.cleanupError;
      this.browser?.assertCleanup(); this.mcp?.assertCleanup(); this.lsp?.assertCleanup(); this.services?.assertCleanup();
    }
    const transition = /^\/(?:branch|switch)(?:\s|$)/.test(prompt);
    if (transition && this.subagents.isBusy) throw new Error("Wait for active subagents before changing workspaces");
    // /receipt, /undo, /redo and /diff read the last task; every other command starts without it.
    if (!/^\/(?:receipt|undo|redo|diff)(?:\s|$)/.test(prompt)) this.lastTaskResult = undefined;
    this.taskRuntimeFailed = false;
    this.taskTurnLimit = undefined;
    this.taskSpendStop = undefined;
    this.events.clearError();
    this.taskRuntimeCancelled = false;
    this.commandActive = true;
    this.commandAbort = new AbortController();
    this.commandSpent = undefined;
    updateFooter(this);
    this.workspaceTransition = transition;
    let command = prompt.startsWith("/");
    try {
      // A Shift+Tab that arrived with this submit still applies; new presses see commandActive and wait.
      while (this.effortSteps > 0) await this.effortCycle;
      if (this.closing) return;
      if (this.workspaceNeedsRebind) await rebindWorkspace(this, this.activeWorkspaceRoot());
      // Whatever follows a receipt either picks one of its suggestions or leaves them (they fade when ignored).
      // Nothing on offer: no extra wait, so a close that arrives with this line still finds the command running.
      if (this.suggestions.pending) await this.suggestions.settle(prompt, this.projectContext);
      else this.suggestions.forgetChoice();
      // Pictures pasted into this line (Ctrl+V) go with it, or with nothing when it is a command.
      this.pastedImages = this.terminal.takePastedImages();
      // A picture file dropped into an empty prompt starts the line with "/": that is a request, not a command.
      // Commands go straight on (no wait, so a close that arrives with the line still finds the command running).
      if (command && leadingImagePath(prompt) !== undefined) command = !await startsWithImageFile(prompt, { cwd: this.activeWorkspaceRoot() });
      return await (command ? this.handleSlashCommand(prompt) : this.runModelTask(prompt));
    } catch (error) {
      if (error instanceof ProcessCleanupError) this.cleanupError = error;
      throw error;
    } finally {
      try {
        await this.checkTask?.close();
        if (!command) await this.browser?.close();
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
        updateFooter(this);
      }
    }
  }

  /** Local command dispatch moved to app/commands.ts; the app is the command host. */
  handleSlashCommand(prompt: string): Promise<VerificationReport | undefined> {
    if (/^\/pane(?:\s|$)/.test(prompt)) return paneCommand(this, prompt.slice(5).trim()).then(() => undefined);
    if (/^\/details(?:\s|$)/.test(prompt)) return detailsCommand(this, prompt.slice(8).trim()).then(() => undefined);
    if (prompt.trim() === "/settings") return this.settingsCommand().then(() => undefined);
    if (/^\/preview(?:\s|$)/.test(prompt)) return this.previewCommand(prompt.slice(8).trim()).then(() => undefined);
    if (/^\/new(?:\s|$)/.test(prompt)) return newProjectCommand(this, prompt.slice(4).trim()).then(() => undefined);
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

  /** After the receipt: "The work is in ~/Documents/sample-tools. 1 Stay here · 2 Switch there". Enter stays. A run
   * that can't ask says the command to use. */
  private async offerWorkFolder(child: ChildProject): Promise<void> { return offerWorkFolder(this, child); }

  /**
   * `/project <name>`: a project folder inside this one (typed as a path, or the name of one Casper finds two
   * levels down). Before the model starts Casper opens it; a name that isn't there offers "1 Stay in Documents ·
   * 2 Make <name> here" (Enter stays). Once the conversation has started its folder is fixed, so Casper says the
   * command to use instead.
   */
  async openProjectCommand(name: string): Promise<void> { return openProjectCommand(this, name); }

  /** Web lookups never ask: the checks in src/web/url.ts hold instead. Off only with your own setting (/settings). */
  private applyWeb(context: ProjectContext): void {
    this.web?.close();
    const web = context.web ?? DEFAULT_WEB;
    const loginFile = path.join(casperAgentDir(), "auth.json");
    this.web = web.enabled ? new WebLookup({ provider: webProvider(web, loginFile), loginValues: loginValuesFrom(loginFile), ...this.webSeams }) : undefined;
    const lookup = this.web;
    if (lookup) this.lifecycle.add({ name: "web", close: async () => lookup.close() });
  }

  /** /settings: the off switches by number; a change is written to ~/.casper/config.yaml and applies from now on. */
  private settingsCommand(): Promise<void> {
    return runSettings({
      output: this.output, homeDir: () => this.homeDir(), canAsk: this.interactive && this.terminal.canAsk,
      context: async () => this.projectContext,
      reload: async () => {
        const before = this.projectContext;
        if (!before) return;
        try { this.projectContext = await this.loadProjectContextFn(before.info); } catch { return; }
        this.applyWeb(this.projectContext);
        // A new default for the work shown replaces this session's /details choice.
        if (this.projectContext.display !== before.display) this.displayChoice = undefined;
      },
      ask: async (question, options, signal) => (await this.terminal.ask(question, options, false, signal))?.[0],
    }, this.commandAbort?.signal);
  }

  /** /preview [stop]: the web app on your network, and a public link only after a numbered yes. No model call. */
  private async previewCommand(args: string): Promise<void> {
    const context = this.projectContext;
    return runPreview({
      output: this.output, canAsk: this.interactive && this.terminal.canAsk,
      ask: async (question, options, signal) => (await this.terminal.ask(question, options, false, signal))?.[0],
      manager: () => this.serviceManager(),
      webService: async () => {
        const found = context ? await detectWebService(this.activeWorkspaceRoot(), { frameworks: context.model.frameworks,
          packageManager: context.model.packageManager, services: context.services ?? {} }).catch(() => undefined) : undefined;
        if (isDetectedWebService(found)) return { spec: found.spec, label: redactPreview(terminalText(found.label)).slice(0, 120) };
        return { reason: found?.reason ? `Can't start the web app: ${found.reason}` : "Casper found no web app here to preview. Ask Casper to build one, or to start yours." };
      },
    }, args, this.commandAbort?.signal);
  }

  /** The banner's checks line; none when there is nothing to check yet and checking is on (/status still says it). */
  private async bannerChecks(context: ProjectContext): Promise<{ checks?: string }> {
    const plan = await checksPlan(this, context);
    return plan.mode === "off" || hasChecks(plan) ? { checks: describeChecksPlan(plan) } : {};
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
    if (action.kind === "save-check") { await saveFoundCheck(this, action.name); return undefined; }
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
    // Pictures with the request: pasted ones and dropped image files are [image N] from here on (app/images.ts).
    const attached = await attachImages(prompt, { cwd: this.activeWorkspaceRoot(), pasted: this.pastedImages });
    this.pastedImages = undefined;
    for (const note of attached.notes) this.output.write(`[image] ${terminalText(note)}\n`);
    prompt = attached.text;
    // A flow the user picked, or /plan, is already this task's one choice before work: no other panel.
    this.beforeWorkAsked = Boolean(options.flow || options.planFirst);
    if (await offerNewProject(this, prompt) === "stop" || this.closing || this.commandAbort?.signal.aborted) return;
    await offerNetworkServer(this, prompt);
    if (this.closing || this.commandAbort?.signal.aborted) return;
    const previous = this.observations.spent();
    this.spentBefore = { tokens: this.spentBefore.tokens + previous.tokens, cost: this.spentBefore.cost + previous.cost };
    this.observations = new TaskObservations();
    // A limit said in the request ("keep it under $2") is this task's pause, whatever the config says.
    const said = requestSpendLimit(prompt);
    const limits = this.projectContext?.spend ?? DEFAULT_SPEND_LIMITS;
    this.spendGuard = new SpendGuard(said === undefined ? limits : { ...limits, pauseAt: said, ...(limits.noteAt !== undefined && limits.noteAt >= said ? { noteAt: undefined } : {}) });
    this.bigModelUse = undefined;
    this.taskChangeServers = new Set();
    let context = this.projectContext!;
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
    await stopDebugger(this);
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
    const verificationMode = (await checksPlan(this, context)).mode;
    if (verificationMode !== "off") this.checkTask = new VerificationTask(
      VerifierRegistry.forProject(context.model, context.verification.timeoutMs, this.blockOnCleanupFailure, taskNetworkOptions(this)), this.activeWorkspaceRoot(),
      (result) => writeCheckResult(this, result),
    );
    // Smoke checks are verification: they run only when Casper checks this task.
    const edits: NonNullable<CasperApp["taskEdits"]> = { edited: false, shell: false, turnEnded: false };
    this.taskEdits = edits;
    this.smokeTask = verificationMode !== "off" ? new SmokeChecks(context.smoke ?? [], () => serviceManager(this), () => this.changedSinceTaskStart(edits)) : undefined;
    await prepareCapabilities(this, prompt);
    if (this.closing || this.commandAbort?.signal.aborted) return;
    const session = await this.ensureRuntime();
    if (this.closing || this.commandAbort?.signal.aborted) return;
    if (!await ensureModel(this, session)) return;
    // The question comes now; a switch it picks happens only for the build turn, which is the turn that sees them.
    let { images, switchTo } = attached.images.length ? await imagesForModel(this, session, attached.images) : { images: [], switchTo: undefined };
    if (this.closing || this.commandAbort?.signal.aborted) return;
    nameConversation(this, session, prompt);
    updateFooter(this);
    bigModelNotice(this, session);
    clearSteps(this);
    const workspaceRoot = this.activeWorkspaceRoot();
    // Receipts describe the tree, not tool names: a read-only shell run is not a write. Undo's own copy is made
    // alongside, with the conversation's position (the plan turn and repairs are part of the task).
    this.snapshotFailure = undefined;
    const [before, undoStart] = await Promise.all([this.snapshotWorkspace(workspaceRoot, this.commandAbort?.signal),
      this.taskUndo.begin(workspaceRoot, session, this.commandAbort?.signal)]);
    edits.before = before;
    // The risky lines already in the project's config files, so the receipt lists only the ones this task adds.
    const riskyBefore = before ? await riskyBaseline(workspaceRoot, [...before.keys()]).catch(() => undefined) : undefined;
    let thrownError: string | undefined;
    // verification.checklist: the cases the request states, listed before the model starts, so it tests each one.
    // Unset, it is on for interactive code changes and off otherwise: questions, docs, refactors and one-shot runs.
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
    let pagesShown: number | undefined;
    let workFolder: ChildProject | undefined;
    let receiptShown = false;
    const flatten = (changes: TreeChanges) => [...changes.added, ...changes.modified, ...changes.removed].sort();
    // Automatic effort's classifier is a model call outside the conversation, so the task's usage
    // totals cannot include it: any classification (or an unreadable count) makes them unknown.
    const classifications = () => { try { return session.getUsage?.().effortClassification?.requests ?? 0; } catch { return undefined; } };
    const classifiedBefore = classifications();
    let visionBack: string | undefined;
    try {
      phase(this, "task", "start");
      try {
        if (switchTo) {
          visionBack = await switchForPictures(this, session, switchTo);
          if (!visionBack) images = [];
          if (this.closing || this.commandAbort?.signal.aborted) return;
        }
        await session.prompt([
          memoryContext,
          skillContext,
          formatTaskPrompt(prompt, classification, context.model, { verificationMode, proveChange: proving,
            reviewFollows: context.verification.review === true, afterContext: Boolean(memoryContext || skillContext) }),
          planBlock,
          checklist ? formatChecklistPrompt(checklist) : "",
          // A flow the user picked from the row: guidance for this one request.
          options.flow ? formatFlowPrompt(options.flow, prompt) : "",
        ].filter(Boolean).join("\n\n"), this.commandAbort?.signal, { request: prompt, maxTurns: this.maxTurns, ...(images.length ? { images } : {}) });
        await retryModelFailure(this, session, prompt);
      } finally {
        // A switch to a model that sees pictures was for this request's own turn; checks and repairs run on yours.
        if (visionBack && !this.closing) await restoreModel(this, session, visionBack);
      }
      phase(this, "task", "end");
      // Repair, review and proof rounds follow the change.
      edits.turnEnded = true;
      afterModel = before && !this.closing ? await this.snapshotWorkspace(workspaceRoot) : undefined;
      // A project the model just set up (package.json, pyproject.toml, Package.swift...) gets its checks now,
      // not on the next task: the checks known at the start were those of the folder before the change.
      if (verificationMode !== "off" && before && afterModel && !this.closing) {
        const refreshed = await projectAfterSetup(this, context, flatten(diffSnapshots(before, afterModel)));
        if (refreshed) {
          context = refreshed;
          // The same task keeps what the model's casper_check already recorded this turn; repair rounds rebuild
          // the model's tools (prepareCapabilities), so its casper_check offers the new checks.
          this.checkTask?.useRegistry(VerifierRegistry.forProject(context.model, context.verification.timeoutMs, this.blockOnCleanupFailure, taskNetworkOptions(this)));
        }
      }
      // A request cut short by --max-turns is unfinished work: checking it would only start repairs.
      const cancelled = this.closing || this.commandAbort?.signal.aborted || this.taskRuntimeCancelled || this.checkTask?.signal.aborted || this.taskTurnLimit !== undefined || this.taskSpendStop !== undefined;
      const stopped = cancelled || this.taskRuntimeFailed;
      // The model errored after editing: its edits are kept, so check them (no repair: the model just failed).
      if (!cancelled && this.taskRuntimeFailed && this.checkTask && verificationMode === "auto") {
        const edited = before && afterModel ? flatten(diffSnapshots(before, afterModel)) : undefined;
        const failedChecks = edited?.length ? planAutoChecks({ selected: context.verification.checks, commands: context.model.commands,
          scopes: context.model.verificationScopes, named: context.model.namedChecks, detected: autoDetectedChecks(context.model), changedPaths: edited }).run : [];
        if (failedChecks.length) {
          this.events.ensureLineBreak();
          this.output.write(`… Casper checking the edits the model made before it failed: ${failedChecks.join(", ")}\n`);
          verification = await runVerification(this, failedChecks, false, prompt, this.checkTask);
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
        const pagePlan = before && afterModel ? await planPages(this, context, pagePaths(diffSnapshots(before, afterModel))) : undefined;
        const pagesDue = Boolean(before && pagePlan && "service" in pagePlan && pagePlan.pages.open.length);
        this.pageTask = pagesDue ? { context, root: workspaceRoot, before: before! } : undefined;
        pageNotes = pagesDue ? undefined : pageNotesFor(this, pagePlan);
        // Fresh passes the model already recorded are reused, not rerun (VerificationTask).
        if (autoChecks.run.length || this.checkTask.checks.length || smokeDue || pagesDue) {
          const pending = [...new Set([...autoChecks.run, ...this.checkTask.checks]), ...(smokeDue ? ["smoke"] : []), ...(pagesDue ? ["pages"] : [])];
          this.events.ensureLineBreak();
          this.output.write(`… Casper checking: ${pending.join(", ")}\n`);
          verification = await runVerification(this, autoChecks.run, true, prompt, this.checkTask);
          // A model that sees pictures may look at the changed pages once (showPages); its fixes are checked again.
          ({ verification, shown: pagesShown } = await this.lookAtPages(session, prompt, autoChecks.run, verification, workspaceRoot));
          const changedCode = Boolean(before && afterModel && changesCode(diffSnapshots(before, afterModel)));
          if (verification.status === "pass" && !(proving && changedCode)) {
            proofSkipped = !verification.results.length && verification.pages && !verification.smoke?.checks.length
              ? verification.pages.pages.every((page) => page.consoleChecked) ? PAGES_ONLY_PROOF : PAGES_ANSWER_ONLY_PROOF
              : proofSkipReason({ intent: classification.intent, testCommand, snapshot: before !== undefined, changedCode,
                testsAddedNow: !testCommand && Boolean(context.model.commands.test?.trim()) });
          }
          if (proving && verification.status === "pass" && changedCode) {
            const initialReview = parseChecklist(this.lastAnswer);
            ({ verification, proof, review } = await this.finishChange({ baseline, baselineUnavailable, before: before!, root: workspaceRoot,
              command: testCommand!, request: prompt, checks: autoChecks.run, verification, session, initialReview }));
          }
          // Not tied to the proof: any code change whose checks pass (server tasks and configure requests too).
          const acceptanceMode = context.verification.acceptance;
          if ((acceptanceMode === true || acceptanceMode === "warn") && testCommand && changedCode && verification.status === "pass" && proof?.status !== "unproven"
            && !this.closing && !this.commandAbort?.signal.aborted && !this.taskRuntimeFailed && this.taskTurnLimit === undefined && this.taskSpendStop === undefined) {
            acceptance = await this.acceptChange({ session, before: before!, root: workspaceRoot, command: testCommand, request: prompt,
              mode: acceptanceMode === "warn" ? "warn" : "verdict" });
          }
        }
      } else if (!stopped && this.checkTask && (this.checkTask.checks.length || this.smokeTask?.recordedCount)) {
        verification = await runVerification(this, this.checkTask.checks, true, prompt, this.checkTask);
      }
      // The work landed in a project inside this folder (sample-tools in Documents): its own checks run for this receipt.
      if (!stopped && before && afterModel && !this.closing) {
        workFolder = await childProjectOfTask(this, context, flatten(diffSnapshots(before, afterModel)));
        if (workFolder && !verification && this.checkTask && verificationMode === "auto") {
          const child = await runChildChecks(this, workFolder, flatten(diffSnapshots(before, afterModel)));
          if (child) {
            verification = child;
            autoChecks = undefined;
            if (child.status === "pass") proofSkipped = `the checks ran in ${workFolder.relative}; Casper did not compare the tests with and without the change`;
          }
        }
      }
    } catch (error) {
      this.taskRuntimeFailed = true;
      thrownError = error instanceof Error ? error.message : String(error);
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
      const outsideWrites = outsideWritesReceipt(this.sandbox);
      // Dangerous lines in the config files this task changed (reload, shutdown …): a report, never a pass or a fail.
      const riskyLines = changedPaths && !this.closing ? await riskyLinesIn(workspaceRoot, changedPaths, riskyBefore).catch(() => []) : [];
      const services = !this.closing && this.services && !this.services.closed
        ? this.services.status().map(({ name, origin, state }) => ({ name, ...(origin ? { origin } : {}), state })) : [];
      const snapshotFailure = !changedPaths && this.snapshotFailure ? { reason: this.snapshotFailure,
        edited: observations.observedEdits.map((file) => { const relative = path.relative(workspaceRoot, path.resolve(workspaceRoot, file));
          return relative && !isOutside(relative) ? relative.split(path.sep).join("/") : file; }) } : undefined;
      const modelError = execution === "failed" ? explainModelError(this.events.lastError ?? thrownError ?? "")?.cause : undefined;
      this.lastTaskResult = { execution, ...(modelError ? { modelError } : {}), verification, ...observations, ...(snapshotFailure ? { snapshotFailure } : {}), ...(browser?.checks.length ? { browser, ...(browser.status !== "pass" && answerClaimsBrowserPass(this.lastAnswer) ? { browserClaimed: true } : {}) } : {}),
        ...(services.length ? { services } : {}), ...(riskyLines.length ? { riskyLines: [...riskyLines], ...(riskyLines.more ? { riskyMore: riskyLines.more } : {}) } : {}),
        // Smoke checks ran even without a configured command, so "no checks" no longer describes the task.
        verificationMode, ...(!flag && !configured && verificationMode === "auto" ? { verificationDefaulted: true as const } : {}),
        ...(autoChecks?.skipped && !verification?.smoke && !verification?.pages ? { autoSkipped: autoChecks.skipped } : {}),
        ...(pageNotes?.length && !verification?.pages ? { pageNotes } : {}), ...(pagesShown ? { pagesShown } : {}),
        ...(this.taskTurnLimit !== undefined ? { turnLimit: this.taskTurnLimit } : {}), ...(this.taskSpendStop ? { spendLimit: { ...this.taskSpendStop } } : {}), ...(proof ? { proof } : {}), ...(proofSkipped && !proof ? { proofSkipped } : {}), ...(review ? { review } : {}),
        ...(acceptance ? { acceptance } : {}), ...(checklist ? { checklist } : {}), ...bigModelReceipt(this),
        ...(changedWhilePlanning?.length ? { changedWhilePlanning } : {}), ...(this.sandbox ? { sandbox: sandboxReceipt(this.sandbox)! } : {}),
        ...outsideWrites };
      // The receipt is next: the steps fold and the Working box goes, even for a tool that ended late.
      this.events.reset();
      if (!this.closing) {
        this.terminal.endAssistant();
        this.events.ensureLineBreak();
        // A question that changed nothing and ran no tests gets no receipt, like a general one.
        const answeredOnly = changedPaths?.length === 0 && !this.lastTaskResult.testRunner;
        // A stop at --max-turns or at the spend limit is always said on a receipt.
        if ((classification.intent !== "general" && !answeredOnly) || execution !== "completed" || this.taskTurnLimit !== undefined || this.taskSpendStop !== undefined || verification || browser?.checks.length || observations.possibleMutations || observations.changedPaths?.length || observations.changedDuringChecks?.length || observations.observedEdits.length || observations.observedChecks.length
          || observations.remoteChanges?.length || observations.remoteNotRun?.length || observations.secretInCommand) {
          // The second copy and the saved receipt; the change summary lists only this task's files.
          const { stat } = await this.taskUndo.finish(undoStart, { request: prompt, task: this.lastTaskResult, session, servers: [...this.taskChangeServers] });
          const task = this.lastTaskResult;
          // The short receipt gets the colored result edge on the rich terminal; --verbose's full form stays plain.
          const receipt = this.verbose ? formatTaskResult(task) : formatShortReceipt(task, { surface: this.receiptSurface(), ...this.receiptFolder(workspaceRoot),
            ...(this.checksHintShown ? { checksHintShown: true as const } : {}), undoNamed: this.undoNamed });
          if (this.verbose) this.output.write(`${receipt}\n`); else this.terminal.writeResult(`${receipt}\n`);
          if (!this.verbose) {
            if (task.autoSkipped === "no-checks" && !task.verification && !task.observedChecks?.length && task.execution === "completed") this.checksHintShown = true;
            // Only the files the receipt printed: ones past its limit are named on a later one.
            for (const shown of undoPathsShown(task, this.undoNamed)) this.undoNamed.add(shown);
          }
          // The per-file table stays behind Diff and --verbose; the receipt already says how many files changed.
          if (this.verbose && stat.trim()) this.output.write(stat.endsWith("\n") ? stat : `${stat}\n`);
          if (this.interactive) await this.offerNextSteps(this.lastTaskResult, prompt, classification);
          receiptShown = true;
        }
      }
      clearSteps(this);
      await this.recordTaskOutcome({ task: prompt, skills: selected.map(({ skill }) => skill.id),
        modelStatus: execution, verification });
      // Last, once this folder has the task's outcome: the offer may move Casper to the project the work is in.
      if (workFolder && receiptShown && !this.closing) await offerWorkFolder(this, workFolder);
    }
    return verification;
  }

  /** verification.checklist: one separate model call lists the cases the request states and the task prompt asks
   * for one test per case. Nothing is printed before work unless the call failed or the list was cut; the user
   * edits the cases only by choosing to on the plan-first panel. Its usage joins the task's. A failed call is one
   * line on the transcript and the task goes on without a checklist. */
  private async makeChecklist(complete: NonNullable<RuntimeSession["complete"]>, request: string,
    options: { edit?: false; cases?: string[] } = {}): Promise<string[] | undefined> {
    let result: { cases: string[]; dropped: number } | { error: string };
    if (options.cases) result = { cases: options.cases, dropped: 0 };
    else {
      phase(this, "checklist", "start");
      try {
        const made = await extractChecklist({ complete, request, signal: this.commandAbort?.signal });
        this.observations.recordModelCall(made.usage);
        result = made;
      } catch (error) {
        // The call may have reached the provider: its usage is unknown.
        this.observations.recordUntrackedModelUse();
        result = { error: `the checklist call failed: ${error instanceof Error ? error.message : String(error)}` };
      } finally { phase(this, "checklist", "end"); }
    }
    if (this.closing || this.commandAbort?.signal.aborted) return undefined;
    if ("error" in result) {
      this.events.ensureLineBreak();
      this.output.write(`• Checklist not made: ${lineText(result.error)}\n`);
      this.steps.skip("checklist"); this.terminal.setSteps(this.steps.text());
      return undefined;
    }
    // Nothing testable in the request (a question, say): no checklist, and no line about it.
    if (!result.cases.length) {
      this.steps.skip("checklist"); this.terminal.setSteps(this.steps.text());
      return undefined;
    }
    // Listed for the plan-first panel, which offers editing them.
    if (options.edit === false) return result.cases;
    // Made quietly: the cases are not printed before work. The receipt names one only when it is not met, and
    // /receipt lists them all. A list cut short still says so.
    if (!options.cases) {
      if (result.dropped) { this.events.ensureLineBreak(); this.output.write(`• Checklist kept ${result.cases.length} cases; ${result.dropped} more ${result.dropped === 1 ? "was" : "were"} left out\n`); }
      return result.cases;
    }
    // "Edit the cases first" on the plan-first panel: the user corrects the list before the model sees it.
    // Enter keeps the editor's lines, Esc (or deleting every line) starts without one, Ctrl+C cancels the task.
    const count = (n: number) => `${n} ${n === 1 ? "case" : "cases"}`;
    this.events.ensureLineBreak();
    const answer = await this.terminal.editLines(`Casper checklist: ${count(result.cases.length)} from your request. The model writes one test per case.`,
      "Enter starts with these · edit, add or delete lines · Esc starts without a checklist", result.cases, this.commandAbort?.signal);
    if (this.closing || this.commandAbort?.signal.aborted) return undefined;
    const kept = answer ? normalizeCases(answer) : [];
    if (!kept.length) {
      this.output.write("[checklist] skipped; the task starts without one\n");
      this.steps.skip("checklist"); this.terminal.setSteps(this.steps.text());
      return undefined;
    }
    return kept;
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
    phase(this, "acceptance", "start");
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
    } finally { phase(this, "acceptance", "end"); }
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
    const stopped = () => this.closing || Boolean(this.commandAbort?.signal.aborted) || this.taskRuntimeFailed || this.taskTurnLimit !== undefined || this.taskSpendStop !== undefined;
    const max = context.repair.maxAttempts;
    let verification = input.verification;
    // The review is opt-in (verification.review: true): pinned benchmarks showed no first-time-right gain
    // for 40% of the wall time. With it on, the first turn is not asked for a checklist; with it off
    // (the default), the first turn asks for one and only the first answer's own, if any, is kept.
    const initialReview = input.initialReview;
    if (context.verification.review !== true) {
      if (verification.status !== "pass" || stopped()) return { verification, review: initialReview };
      phase(this, "proof", "start");
      const result = await this.proveChange({ ...input, verification });
      phase(this, "proof", "end");
      return { ...result, review: initialReview };
    }
    this.events.ensureLineBreak();
    phase(this, "review", "start");
    this.output.write("↻ review: checking the work against every requirement\n");
    this.lastAnswer = "";
    const unreviewed = await this.snapshotWorkspace(input.root);
    await prepareCapabilities(this, input.request);
    const cutOff = await this.promptRound(input.session, requirementsReviewPrompt(input.request), input.request);
    if (stopped()) return { verification };
    if (cutOff) this.output.write(`↻ review: stopped at its ${ROUND_MAX_TURNS}-turn budget\n`);
    const review: RequirementsReview = { ...(parseReview(this.lastAnswer) ?? { missing: true as const }), ...(cutOff ? { incomplete: true as const } : {}) };
    // Checks rerun only when the review edited (or the tree cannot be compared); failures get the remaining repairs.
    const after = unreviewed && await this.snapshotWorkspace(input.root);
    const edited = !unreviewed || !after || [...Object.values(diffSnapshots(unreviewed, after))].some((paths) => paths.length);
    if (edited) {
      const reviewed = await runVerification(this, input.checks, true, input.request, this.checkTask, Math.max(0, max - verification.repairAttempts));
      verification = { ...reviewed, repairAttempts: verification.repairAttempts + reviewed.repairAttempts };
    }
    phase(this, "review", "end");
    if (verification.status !== "pass" || stopped()) return { verification, review };
    phase(this, "proof", "start");
    const result = await this.proveChange({ ...input, verification });
    phase(this, "proof", "end");
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
    const stopped = () => this.closing || Boolean(this.commandAbort?.signal.aborted) || this.taskRuntimeFailed || this.taskTurnLimit !== undefined || this.taskSpendStop !== undefined;
    const max = context.repair.maxAttempts;
    if (proof?.status !== "unproven" || verification.repairAttempts >= max || stopped()) return { verification, proof };
    const attempt = verification.repairAttempts + 1;
    this.output.write(`↻ repair ${attempt}/${max}: add a test that fails without the change\n`);
    await prepareCapabilities(this, input.request);
    // A round cut off by its own budget needs no mark: the checks and the comparison below decide.
    await this.promptRound(input.session, proofRepairPrompt(input.request, proof), input.request);
    if (stopped()) return { verification: { ...verification, repairAttempts: attempt }, proof };
    const again = await runVerification(this, input.checks, true, input.request, this.checkTask, max - attempt);
    verification = { ...again, repairAttempts: attempt + again.repairAttempts };
    if (verification.status === "pass" && !stopped()) proof = await compare();
    return { verification, proof };
  }

  /**
   * The page look: after a UI change whose checks pass, a model that sees pictures is shown the page screenshots once
   * (showPages: ask once a session, on, off), so it can fix what loads but looks wrong. When it edits, the checks
   * run again with the repairs left. Never a check itself. `shown` is how many pictures it was shown.
   */
  private async lookAtPages(session: RuntimeSession, request: string, checks: readonly CheckName[], verification: VerificationReport,
    root: string): Promise<{ verification: VerificationReport; shown?: number }> {
    const stopped = () => this.closing || Boolean(this.commandAbort?.signal.aborted) || this.taskRuntimeFailed || this.taskTurnLimit !== undefined || this.taskSpendStop !== undefined;
    if (verification.status !== "pass" || !verification.pages?.pages.some((page) => page.screenshots) || stopped()) return { verification };
    let sees: boolean | undefined;
    try { sees = session.getStatus?.()?.images; } catch { sees = undefined; }
    if (sees !== true || !await this.showPagesAllowed()) return { verification };
    const look = await pageLook(verification.pages.pages);
    if (!look || stopped()) return { verification };
    this.events.ensureLineBreak();
    this.output.write(`↻ look: the AI looks at ${look.images.length} screenshot${look.images.length === 1 ? "" : "s"} of ${look.shown.map((page) => terminalText(page.path)).join(", ")}\n`);
    const before = await this.snapshotWorkspace(root);
    await prepareCapabilities(this, request);
    await this.promptRound(session, lookPrompt(request, look), request, look.images);
    if (stopped()) return { verification, shown: look.images.length };
    const after = before && await this.snapshotWorkspace(root);
    const edited = !before || !after || [...Object.values(diffSnapshots(before, after))].some((paths) => paths.length);
    if (!edited) return { verification, shown: look.images.length };
    const max = this.projectContext!.repair.maxAttempts;
    const again = await runVerification(this, checks, true, request, this.checkTask, Math.max(0, max - verification.repairAttempts));
    return { verification: { ...again, repairAttempts: verification.repairAttempts + again.repairAttempts }, shown: look.images.length };
  }

  /** showPages: on or off as set; ask (the default) asks once a session, and only a person answers it (1 No). */
  private async showPagesAllowed(): Promise<boolean> {
    const setting = this.projectContext?.showPages ?? "ask";
    if (setting !== "ask") return setting === "on";
    if (this.showPagesAnswer !== undefined) return this.showPagesAnswer;
    if (!this.interactive || !this.terminal.canAsk) return false;
    this.events.ensureLineBreak();
    const picked = await this.terminal.pick(SHOW_PAGES_QUESTION, [...SHOW_PAGES_CHOICES], this.commandAbort?.signal);
    if (this.commandAbort?.signal.aborted) return false;
    this.showPagesAnswer = picked === SHOW_PAGES_CHOICES[1].label;
    return this.showPagesAnswer;
  }

  /** A round after the task turn (review, proof repair) with its own ROUND_MAX_TURNS budget. A --max-turns
   * at or below it wins and stays the task's stop (taskTurnLimit, exit 2). The round's own budget ending it
   * is not the task's stop: Casper goes on with the checks and the proof. True when that budget ended it. */
  private async promptRound(session: RuntimeSession, text: string, request: string, images?: RuntimeImage[]): Promise<boolean> {
    const roundBudget = this.maxTurns === undefined || ROUND_MAX_TURNS < this.maxTurns;
    await session.prompt(text, this.commandAbort?.signal, { request, maxTurns: roundBudget ? ROUND_MAX_TURNS : this.maxTurns, ...(images?.length ? { images } : {}) });
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
    request?: string,
    task?: VerificationTask,
    /** Repairs left for this task; defaults to the project's repair budget. */
    maxAttempts?: number,
  ): Promise<VerificationReport> { return runVerification(this, checks, repair, request, task, maxAttempts); }

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
      scrub: (toolName, input, texts, signal) => scrubToolOutput(this.scrubber, toolName, input, texts, signal, { configs: true, networkLoginFile: networkLoginFile(this) }),
    };
  }

  /** `/verify add <name>` or a picked suggestion: save a check Casper found in .casper/project.yaml, then use it. */
  async saveFoundCheck(name: string): Promise<void> { return saveFoundCheck(this, name); }

  /** The mode and checks this session uses after a change; the banner, /status and every task share it. */
  async checksPlan(context: ProjectContext): Promise<ChecksPlan> { return checksPlan(this, context); }

  /** A provider hiccup Pi does not retry (an empty response) ends a run for no reason of the task's: try once
   * more on its own, then, in the terminal, ask. Sign-in, quota and context errors, and errors Pi already
   * retried within its budget, are not retried again. */
  homeDir(): string { return this.sessionHomeDir ?? os.homedir(); }

  async savedModel(): Promise<string | undefined> { return modelPreference(this.sessionHomeDir ?? os.homedir()); }

  /** Whether any sign-in exists yet, for the banner and footer only. */
  private async checkSignIn(): Promise<void> {
    const agentDir = this.sessionHomeDir ? path.join(this.sessionHomeDir, ".casper", "agent")
      : process.env[AGENT_DIR_ENV] && process.env[AGENT_DIR_ENV] !== "undefined" ? process.env[AGENT_DIR_ENV]! : casperAgentDir();
    this.signedIn = await hasSignIn(agentDir);
  }

  async ensureSessionWorkspace(): Promise<SessionWorkspaceManager> { return ensureSessionWorkspace(this); }

  async handleBranchCommand(prompt: string): Promise<void> { return handleBranchCommand(this, prompt); }

  async handleSwitchCommand(prompt: string): Promise<void> { return handleSwitchCommand(this, prompt); }

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
  async snapshotWorkspace(root: string, signal?: AbortSignal): Promise<Map<string, string> | undefined> {
    try { return await snapshotTree(root, signal); }
    catch (error) {
      // Kept for the receipt: "Changes unknown: this folder has over 20,000 files; open a project folder".
      if (!signal?.aborted) this.snapshotFailure = snapshotFailureReason(error);
      return undefined;
    }
  }

  /** This session's answer to "Show the AI the pages?" (showPages: ask); asked once. */
  private showPagesAnswer?: boolean;

  /** Pictures pasted into the line being handled; runModelTask takes them. */
  private pastedImages?: Map<number, RuntimeImage>;

  /** Looked up once: the answer decides whether the browser tool is there from the first turn. */
  browserInstalled?: Promise<boolean>;

  resetToolPicks(): void {
    this.broker?.resetPicks();
  }

  async stopDebugger(): Promise<void> { return stopDebugger(this); }

  browserSession(): BrowserSession { return browserSession(this); }

  /** /tasks: dev servers, the browser, the debugger, helpers and checks that run now, each with its own stop. */
  backgroundTasks(): BackgroundTask[] { return backgroundTasks(this); }

  /** The session's service manager, created on first use for the active workspace's declared services. */
  serviceManager(): ServiceManager { return serviceManager(this); }

  /** The delegate tool carries the per-task dispatch budget, so it is rebuilt only at task
   * boundaries (a new request, or an explicit /verify repair task) — never for repair rounds
   * of the current task. */
  delegateToolForTask?: RuntimeTool;

  /** A rename is a normal edit inside the project: no box, like the AI's other edits (undo covers it). */
  confirmRename: ConfirmRename = async () => true;

  /** Approvals and server questions are shown one at a time, so two boxes never race for one answer. */
  approvalQueue: Promise<unknown> = Promise.resolve();

  /** The project's sandbox.denyRead as absolute paths, resolved like the shell sandbox does (from the session's folder). */
  private projectPrivatePaths(): string[] {
    if (!this.projectContext) return [];
    const root = this.activeWorkspaceRoot();
    return (this.projectContext.sandbox?.project.denyRead ?? []).map((entry) => resolveEntry(entry, root, this.sessionHomeDir ?? os.homedir()));
  }

  /** The broker's per-server allowances, for /mcp allow (the user's own command). */
  get allowances(): CapabilityBroker | undefined { return this.broker; }

  /** /lab import added hosts: this session uses the new lab list at once (it is saved in ~/.casper/config.yaml too). */
  setLab(settings: LabSettings): void {
    if (this.projectContext) this.projectContext = { ...this.projectContext, lab: settings };
  }

  /** Ends every allowed change kind and session answer, on every server. */
  endAllowances(): boolean { return this.broker?.endAllowances() ?? false; }

  /** ctrl+o: writes off for every server at once, and every allowed kind and session answer ended. Returns whether
   * any of those were in force. */
  private revertWrites(): boolean { return revertWrites(this); }

  /**
   * The network server's setup host: questions in the numbered approval box (only the person, never the AI's ask tool),
   * and connecting goes through the same manager as /mcp connect.
   */
  networkSetupHost(): SetupHost { return networkSetupHost(this); }

  /** After /references add: the reference files read again; the next task's search tool uses them, and the old
   * library (and any tool that captured it) is closed. */
  async reloadReferences(): Promise<void> {
    if (!this.projectContext || this.closing) return;
    const configuration = await this.loadReferenceConfigurationFn(this.projectContext);
    if (this.closing) return;
    const old = this.references;
    this.references = new ReferenceLibrary(configuration);
    await old?.close();
  }

  /**
   * The network server's login host: the question in the numbered approval box and the values in the private prompt (only the
   * person, never the AI's ask tool), both in the approval queue; the restart after a save goes through the manager.
   */
  networkLoginHost(): LoginHost { return networkLoginHost(this); }

  /** One numbered answer from the user (never the model), in the same one-at-a-time queue as approvals. */
  chooseAnswer(preview: string, question: string, choices: readonly string[], signal?: AbortSignal): Promise<string | undefined> { return chooseAnswer(this, preview, question, choices, signal); }

  /** One approval box from the user (never the model), in the same one-at-a-time queue as approvals: the chosen
   * label, or undefined when nobody answered. */
  approveChoice(preview: string, question: string, options: ReadonlyArray<string | { label: string; description?: string }>, signal?: AbortSignal): Promise<string | undefined> { return approveChoice(this, preview, question, options, signal); }

  /** A yes/no approval box: 1 No · 2 Yes, this once. Nobody to ask is a No. */
  async confirmYes(preview: string, question: string, signal?: AbortSignal): Promise<boolean> { return confirmYes(this, preview, question, signal); }

  private reportSkillWarnings(): void {
    const warnings = this.skillRegistry!.diagnostics.filter((warning) => !this.reportedSkillWarnings.has(warning));
    if (!warnings.length) return;
    for (const warning of warnings) this.reportedSkillWarnings.add(warning);
    this.output.write(`[skills] ${warnings.length} new warning${warnings.length === 1 ? "" : "s"}; use /skills diagnostics\n`);
  }

  private writePrompt(prompt: string): void {
    this.events.writePrompt(prompt);
  }

  updateFooter(): void { updateFooter(this); }

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

export function proofSkipReason(options: { intent: string; testCommand?: string; snapshot: boolean; changedCode: boolean; testsAddedNow?: boolean }): string {
  if (options.intent === "refactor") return "a refactor should not change behavior, so no test is expected to fail without it";
  if (["document", "inspect", "visualize", "configure"].includes(options.intent)) return `Casper does not compare ${options.intent} requests with and without the change`;
  if (!options.testCommand && options.testsAddedNow) return "the tests came with this change, so there is no version without it to compare with";
  if (!options.testCommand) return 'there are no tests yet to compare with; say "add tests"';
  if (!options.snapshot) return "Casper could not record the workspace before the change";
  if (!options.changedCode) return "only non-code files changed";
  return "Casper did not compare the tests with and without the change";
}
