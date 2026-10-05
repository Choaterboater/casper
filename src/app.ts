import { execFile } from "node:child_process";
import type { DebugSession } from "./debug/session";
import { promisify } from "node:util";
import os from "node:os";
import { resolveEntry } from "./sandbox/policy";
import type { LabSettings } from "./network/spec";
import path from "node:path";
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
import { snapshotFailureReason, snapshotTree } from "./task/changes";
import { renderBanner, wordmarkHeader } from "./tui/banner";
import type { CheckName, VerificationReport } from "./verify/evidence";
import { ProcessCleanupError } from "./platform/processes";
import { safeGitArgs } from "./platform/git";
import { VerifierRegistry } from "./verify/registry";
import { longerLimit, timedOutAfter, verifyAndRepair, type UnfinishedChoice } from "./verify/repair-loop";
import { ALREADY_FAILING_CHOICES, modelFailedChoices, NO, pictureChoices, PLAN_CHOICES, YES_ONCE, YES_SESSION, PLAN_QUESTION, REMEMBER_BIG_MODEL_CHOICES, REPAIR_LIMIT_STOP, spendChoices, unfinishedChoices, workFolderChoices } from "./app/safe-choices";
import { DEFAULT_SPEND_LIMITS, formatCost, formatFooterSpend, formatLimit, formatTokens, SPEND_STOP_REASON, SpendGuard, requestSpendLimit } from "./task/spend";
import { VerificationTask } from "./verify/task";
import { ChangeBaseline } from "./verify/proof";
import type { NetworkToolContext } from "./verify/registry";
import type { NextItem } from "./tui/next-row";
import { TaskUndo } from "./app/undo";
import { SuggestionController } from "./app/suggestions";
import type { Flow } from "./flows/catalog";
import { planToolGate } from "./flows/plan";
import type { SecurityAIReview, SecurityReviewHost } from "./app/security-review";
import { describeChecksPlan, hasChecks, resolveVerificationMode, type ChecksPlan, type VerificationMode } from "./verify/mode";
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
import type { OutputWriter } from "./app/commands";
import type { BackgroundTask } from "./app/background";
import { detectHostTerminal } from "./tui/host-terminal";
import { UsageError } from "./cli-args";
import { RuntimeEventMapper, sessionStartEvent, type CasperEvent } from "./app/json-events";
import { StepRail } from "./app/steps";
import { CASPER_VERSION } from "./version";
import type { Install } from "./update/command";
import { refreshUpdateCheck, updateChecksOff, updateNotice } from "./update/notice";
import { createSessionSandbox, runtimeShell, sandboxReceipt, sandboxStartupNotes, sandboxStatusLine, type RunAllowances, type SandboxHost } from "./app/sandbox";
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
import { networkSetupHost, networkLoginHost, networkLoginFile, revertWrites, reportImports } from "./app/network-host";
import { updateFooter, displayLevel, expandLastStep } from "./app/footer";
import { submitDuringWork, cycleEffort } from "./app/during-work";
import { spendNote, spendGate } from "./app/spend-gate";
import { prepareCapabilities, browserSession, serviceManager, stopDebugger, backgroundTasks, planPages, pageNotesFor, pageRun, smokeRun, pagePaths } from "./app/task-tools";
import { ensureModel, retryModelFailure, bigModelReceipt, bigModelNotice, switchToBigModel, restoreModel, askBigModelRetry, type BigModelChoice, bigModelOf, imagesForModel, switchForPictures } from "./app/big-model";
import { newProjectFlowWithAbort, openProjectFolder, openProjectCommand, newProjectCommand, offerNewProject, childProjectOfTask, runChildChecks, offerWorkFolder } from "./app/workspace";
import { ensureSessionWorkspace, handleBranchCommand, handleSwitchCommand, rebindWorkspace } from "./app/session-branches";
import { runVerification, checksPlan, saveFoundCheck } from "./app/verification";
import { PAGES_ONLY_PROOF, PAGES_ANSWER_ONLY_PROOF, proofSkipReason } from "./app/task-run";
import { runInteractive, handlePrompt, handleSlashCommand, cancelCurrent, writePrompt } from "./app/command-loop";

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
  cancelBeforeCommand = false;
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
  lastAnswer = "";
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
  taskEdits?: { before?: Map<string, string>; edited: boolean; shell: boolean; turnEnded: boolean };
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
  workspaceTransition = false;
  workspaceNeedsRebind = false;
  /** Project folders the user chose to stay out of at "The work is in ...": not asked again this session. */
  readonly stayedOutOf = new Set<string>();
  /** Why the last workspace snapshot failed, for the task's receipt. */
  snapshotFailure?: string;
  taskRuntimeFailed = false;
  /** The files from before the current task's change, while it runs: tells a failure the change caused from one already there. */
  taskBaseline?: { baseline: ChangeBaseline; root: string };
  cleanupError?: ProcessCleanupError;
  readonly blockOnCleanupFailure = () => {
    this.cleanupError = new ProcessCleanupError();
    this.commandAbort?.abort(); this.verificationAbort?.abort(); this.checkTask?.abort();
    void this.session?.abort().catch(() => {});
  };
  savedModelDisplay?: string;
  /** False when no sign-in exists (no saved provider, no provider key): the banner and footer say how to start. */
  signedIn?: boolean;
  taskRuntimeCancelled = false;
  lastTaskResult?: TaskResult;
  /** Tokens the AI security review spent in this command (no task to carry them). */
  commandSpent?: TaskUsage;
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
  readonly newProjectRequest?: CasperAppOptions["newProject"];
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
  checksHintShown = false;
  readonly undoNamed = new Set<string>();
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
  planning = false;
  /** Flow warnings (a user's flow that could not be used) are said once. */
  readonly flowWarnings = new Set<string>();
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
      () => cancelCurrent(this), () => { if (this.commandActive && !this.closing) void this.close().catch(() => {}); }, host);
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

    writePrompt(this, /^\s*\/login(?:\s|$)/.test(prompt) ? "/login" : prompt);
    return handlePrompt(this, prompt.trim());
  }

  async runInteractive(cwd = process.cwd()): Promise<void> { return runInteractive(this, cwd); }

  /** OS SIGINT and terminal Ctrl-C share cancellation, without disposing the session. */
  interrupt(): boolean {
    if (!this.interactive) return false;
    this.terminal.interrupt();
    return true;
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

  /** Local command dispatch moved to app/commands.ts; the app is the command host. */
  handleSlashCommand(prompt: string): Promise<VerificationReport | undefined> { return handleSlashCommand(this, prompt); }

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
  applyWeb(context: ProjectContext): void {
    this.web?.close();
    const web = context.web ?? DEFAULT_WEB;
    const loginFile = path.join(casperAgentDir(), "auth.json");
    this.web = web.enabled ? new WebLookup({ provider: webProvider(web, loginFile), loginValues: loginValuesFrom(loginFile), ...this.webSeams }) : undefined;
    const lookup = this.web;
    if (lookup) this.lifecycle.add({ name: "web", close: async () => lookup.close() });
  }

  /** The banner's checks line; none when there is nothing to check yet and checking is on (/status still says it). */
  private async bannerChecks(context: ProjectContext): Promise<{ checks?: string }> {
    const plan = await checksPlan(this, context);
    return plan.mode === "off" || hasChecks(plan) ? { checks: describeChecksPlan(plan) } : {};
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
  async checkSignIn(): Promise<void> {
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
  showPagesAnswer?: boolean;

  /** Pictures pasted into the line being handled; runModelTask takes them. */
  pastedImages?: Map<number, RuntimeImage>;

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

  reportSkillWarnings(): void {
    const warnings = this.skillRegistry!.diagnostics.filter((warning) => !this.reportedSkillWarnings.has(warning));
    if (!warnings.length) return;
    for (const warning of warnings) this.reportedSkillWarnings.add(warning);
    this.output.write(`[skills] ${warnings.length} new warning${warnings.length === 1 ? "" : "s"}; use /skills diagnostics\n`);
  }

  updateFooter(): void { updateFooter(this); }

  private observeEdit(path: string): void {
    if (this.taskEdits) this.taskEdits.edited = true;
    this.browser?.invalidate();
    this.services?.markEdited(path);
    (this.checkTask ?? this.verificationTask)?.invalidateForEdit(path);
    this.observations.recordEdit(path);
  }
}

export { PAGES_ANSWER_ONLY_PROOF, PAGES_ONLY_PROOF, proofSkipReason } from "./app/task-run";
