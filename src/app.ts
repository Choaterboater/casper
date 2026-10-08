import type { SideQuestionUsage } from "./app/side-question";
import { execFile } from "node:child_process";
import type { DebugSession } from "./debug/session";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { reloadProject } from "./app/project-file";
import type { LabSettings } from "./network/spec";
import { modelPreference } from "./tui/model-preference";
import { BrowserSession } from "./browser/session";
import { ServiceManager } from "./services/manager";
import { SmokeChecks } from "./services/smoke";
import { pageOpener, type DevServerNotice, type PageOpener } from "./services/page-checks";
import { InteractiveTerminal, type TerminalHost } from "./tui/terminal";
import type { PaneSetting } from "./tui/pane-setting";
import type { DisplayLevel } from "./tui/display";
import { formatRuntimeStatus, terminalText } from "./tui/format";
import { themeNote, useTheme } from "./tui/theme";
import { registerPackThemes } from "./packs/themes";
import { discoverReferenceConfiguration, type ReferenceConfiguration } from "./references/config";
import { formatReferenceResult, ReferenceLibrary } from "./references/library";
import { SubagentManager } from "./agents/manager";
import { discoverLSPConfiguration, type LSPConfiguration } from "./lsp/config";
import { LSPManager, type ConfirmRename } from "./lsp/manager";
import { SessionYes } from "./app/session-yes";
import { discoverMCPConfiguration, type MCPConfiguration } from "./mcp/config";
import { MCPManager } from "./mcp/manager";
import { ConsentStore } from "./mcp/consent";
import { CapabilityBroker } from "./capabilities/broker";
import { Scrubber } from "./secrets/netconan";
import { scrubToolOutput } from "./secrets/tool-output";
import type { Readable } from "node:stream";
import { loadProjectContext, type ProjectContext } from "./project/context";
import { inspectProject, type ProjectInfo } from "./project/inspect";
import type { ChildProject } from "./project/child";
import { forgetSshSecrets } from "./ssh/login";
import { useTelemetrySetting } from "./runtime/openrouter-attribution";
import type { AgentRuntime, RuntimeAuthProvider, RuntimeSession, RuntimeImage, RuntimeTool, RuntimeShell } from "./runtime/types";
import { SkillRegistry, skillRegistryOptions } from "./skills/registry";
import type { TaskResult, TaskUsage } from "./task/result";
import { TaskObservations } from "./task/observations";
import { pastedFolderParent, PastedImageFiles } from "./app/images";
import { LifecycleRegistry } from "./app/lifecycle";
import { helperActivityLine, RuntimeEventView } from "./app/events";
import { snapshotFailureReason, snapshotTree } from "./task/changes";
import { renderBanner, wordmarkHeader } from "./tui/banner";
import type { CheckName, VerificationReport } from "./verify/evidence";
import { ProcessCleanupError } from "./platform/processes";
import { safeGitArgs } from "./platform/git";
import { SpendGuard } from "./task/spend";
import { VerificationTask } from "./verify/task";
import { ChangeBaseline } from "./verify/proof";
import type { NetworkToolContext } from "./verify/registry";
import type { NextItem } from "./tui/next-row";
import { TaskUndo } from "./app/undo";
import type { BuilderSteer } from "./crew/auto";
import type { PartRecord } from "./crew/parts";
import { SuggestionController } from "./app/suggestions";
import type { SecurityAIReview, SecurityReviewHost } from "./app/security-review";
import type { RipgrepOptions, RipgrepResult } from "./security/ripgrep";
import type { ChecksPlan, VerificationMode } from "./verify/mode";
import { MermaidProvider } from "./visualize/mermaid";
import { MindMeshProvider } from "./visualize/mindmesh";
import { VisualizationRouter } from "./visualize/router";
import { WebLookup, type WebLookupOptions } from "./web/lookup";
import type { VisualizationProvider } from "./visualize/types";
import { SessionWorkspaceManager } from "./sessions/manager";
import type { OutputWriter } from "./app/commands";
import type { BackgroundTask } from "./app/background";
import { detectHostTerminal } from "./tui/host-terminal";
import { RuntimeEventMapper, type CasperEvent } from "./app/json-events";
import { StepRail } from "./app/steps";
import type { Install } from "./update/command";
import { sandboxReceipt, sandboxBannerLine, sandboxStartupNotes, sandboxStatusLine, type RunAllowances } from "./app/sandbox";
import type { ShellSandbox, ShellSandboxOptions } from "./sandbox/manager";
import type { LoginHost } from "./mcp/network/ask-login";
import type { NetworkProduct } from "./mcp/network/logins";
import type { SetupHost } from "./mcp/network/setup";
import type { NewProjectOptions, NewProjectResult } from "./new/scaffold";
import { chooseAnswer, approveChoice, confirmYes, recordedApproval } from "./app/approvals";
import { networkSetupHost, networkLoginHost, networkLoginFile, revertWrites, reportImports } from "./app/network-host";
import { updateFooter, displayLevel, expandLastStep } from "./app/footer";
import { submitDuringWork, cycleEffort } from "./app/during-work";
import { browserSession, serviceManager, stopDebugger, backgroundTasks } from "./app/task-tools";
import type { BigModelChoice } from "./app/big-model";
import { openProjectCommand, offerWorkFolder } from "./app/workspace";
import { ensureSessionWorkspace, handleBranchCommand, handleSwitchCommand } from "./app/session-branches";
import { setCheckProgress } from "./verify/progress";
import { runVerification, checksPlan, saveFoundCheck } from "./app/verification";
import { runInteractive, handlePrompt, handleSlashCommand, cancelCurrent, writePrompt } from "./app/command-loop";
import { loadWorkspace, reloadReferences, reloadSkills, projectPrivatePaths, reportSkillWarnings, bannerChecks, reportNewerCasper } from "./app/wiring";
import { acquireRuntime, ensureRuntime, checkSignIn, observeEdit } from "./app/runtime-start";

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
  /** /copy's clipboard (tests pass a fake). */
  copyText?: (text: string) => Promise<void>;
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
  /** Builds a new project (casper new, the new-project questions and /project new); tests pass a fake. */
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
  /** Finds ripgrep for this session, using the copy inside the release program, or fetching Casper's pinned copy when there is none. Only the real start passes
   * one, so no test ever reaches the network. */
  ripgrep?: (options: RipgrepOptions) => Promise<RipgrepResult>;
  /** The terminal Casper runs in (tmux, iTerm2). Read from the environment when Casper writes to its own stdout. */
  terminalHost?: TerminalHost;
}

/** A Casper session. This class holds the session's state and its public methods; the work itself lives in the
 * src/app/ modules, which take the app as their first argument: wiring (opening a workspace), runtime-start,
 * command-loop, task-run, verification, big-model, task-tools, workspace, session-branches, approvals,
 * network-host, during-work, spend-gate and footer. Members without `private` may be read and set by those
 * modules, not only by embedders. */
export class CasperApp {
  /** The provider of the last successful /login, preferred when Casper picks a first model. */
  loginProvider?: RuntimeAuthProvider;
  /** The current task's stages for the footer. */
  readonly steps = new StepRail();
  /** Browser actions and debugger launches you said "Yes, for this session" to. */
  readonly sessionYes = new SessionYes((preview, question, options, signal) => recordedApproval(this, preview, question, options, signal));
  readonly runtimeFactory: () => AgentRuntime | Promise<AgentRuntime>;
  readonly subagents: SubagentManager;
  readonly ripgrep?: (options: RipgrepOptions) => Promise<RipgrepResult>;
  readonly inspectProjectFn: (cwd: string) => Promise<ProjectInfo>;
  readonly loadProjectContextFn: (project: ProjectInfo) => Promise<ProjectContext>;
  readonly loadSkillRegistryFn: (context: ProjectContext) => Promise<SkillRegistry>;
  readonly loadMCPConfigurationFn: (context: ProjectContext) => Promise<MCPConfiguration>;
  readonly loadLSPConfigurationFn: (context: ProjectContext) => Promise<LSPConfiguration>;
  readonly loadReferenceConfigurationFn: (context: ProjectContext) => Promise<ReferenceConfiguration>;
  browser?: BrowserSession;
  /** Managed services live for the session, not the task (docs/SERVICES.md). */
  services?: ServiceManager;
  debugSession?: DebugSession;
  references?: ReferenceLibrary;
  lsp?: LSPManager;
  visualization?: VisualizationRouter;
  visualizationAbort?: AbortController;
  visualizationWork?: Promise<void>;
  readonly visualizationProviders: VisualizationProvider[];
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
  readonly copyText?: CasperAppOptions["copyText"];
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
  /** What was pasted into a line typed during work, by the line, until it runs (words count only where typed). */
  readonly linePastes = new Map<string, readonly string[]>();
  /** What side questions (`? …`) cost this session; shown in /usage, never in the conversation's totals. */
  readonly sideQuestions: SideQuestionUsage = { requests: 0, tokens: 0, estimatedCost: 0, unknown: false };
  /** An idle side question while it waits for its answer (Esc stops it). */
  sideAbort?: AbortController;
  /** The tool names the AI used lately, for a side question's short summary. */
  recentTools: string[] = [];
  /** /details for this session; unset follows display: in the config. */
  displayChoice?: DisplayLevel;
  closing = false;
  private closeWork?: Promise<void>;
  unsubscribe?: () => void;
  projectContext?: ProjectContext;
  skillRegistry?: SkillRegistry;
  readonly reportedSkillWarnings = new Set<string>();
  readonly verificationFlag?: VerificationMode;
  readonly verbose: boolean;
  private readonly startupWarnings: readonly string[];
  readonly updateCheck?: { install: Install; currentVersion: string };
  readonly updateCheckAbort = new AbortController();
  readonly runModel?: string;
  readonly runEffort?: string;
  runConversation?: CasperAppOptions["conversation"];
  readonly maxTurns?: number;
  readonly onEvent?: (event: CasperEvent) => void;
  readonly eventMapper = new RuntimeEventMapper();
  /** The text of the response being streamed, and of the last response that had text. */
  responseText = "";
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
  /** Last normal coding/chat request; local commands other than /receipt clear it. Not acceptance evidence. */
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
  /** The last model task's result, kept after a new command starts (casper_session reads it during the next task). */
  lastFinishedTask?: TaskResult;
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
    reloadProject: async () => { await reloadProject(app); },
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
  /** When each pull request's failed checks were last re-run through the github tool: one re-run per 10 minutes. */
  readonly githubReruns = new Map<string, number>();
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
  /** The /model picker opened during a task: `close` shuts it (nothing chosen) and waits until it is gone. */
  openModelPicker?: { close(): Promise<void> };
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
  readonly noSandbox: boolean;
  /** `/permissions all`: the shell's own questions (a command, a host, a write outside the project, another machine) are
   * answered "Yes, for this session" without showing them. Memory only: never saved, off at start, set only by the
   * person's typed command and numbered answer (src/app/permissions.ts). */
  stopAsking = false;
  readonly allow?: RunAllowances;
  readonly sandboxSeams?: Partial<ShellSandboxOptions>;
  /** web_search and web_fetch for this workspace; unset when web: off. */
  web?: WebLookup;
  readonly webSeams?: Partial<WebLookupOptions>;

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
    privatePaths: () => projectPrivatePaths(this),
    // Inside tmux or iTerm2 each helper's steps show in the view-only steps pane; nowhere else.
    onActivity: (activity) => {
      if (activity.kind !== "usage") this.terminal.logHelper(helperActivityLine(activity, this.projectContext ? this.activeWorkspaceRoot() : undefined));
      // The footer counts running builders and what they have spent so far.
      if (activity.run.role === "builder" && activity.kind !== "tool") { updateFooter(this); if (this.commandActive) this.events.refreshBuilders(); }
    },
    });
    this.lifecycle.add({ name: "subagents", close: () => this.subagents.close() });
    // telemetry: off in your config (/settings) stops Casper's name going to OpenRouter, from the next request.
    const stopTelemetry = useTelemetrySetting(() => this.projectContext?.telemetry);
    this.lifecycle.add({ name: "pasted-pictures", close: () => this.pastedImageFiles.remove() });
    this.lifecycle.add({ name: "telemetry", close: async () => stopTelemetry() });
    // Passwords typed for ssh this session (memory only) are forgotten with the session.
    this.lifecycle.add({ name: "ssh-secrets", close: async () => forgetSshSecrets() });
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
      builderGoals: () => this.subagents.runs().filter(run => run.role === "builder").map(run => run.goal),
      reviewerCount: () => this.subagents.runs().filter(run => run.role === "reviewer").length,
      display: () => displayLevel(this),
      announceLongChecks: () => this.onEvent === undefined,
      onToolEnd: event => {
        this.observations.observeToolEnd(event, this.projectContext?.model.commands);
        if (["bash", "edit", "write"].includes(event.toolName)) this.browser?.invalidate();
        // A shell command's files are unknown, so it marks every running service stale.
        if (event.toolName === "bash" || event.toolName === "powershell") { this.services?.markEdited(); if (this.taskEdits) this.taskEdits.shell = true; }
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
    // Checks Casper runs itself tell the Working box how they go (see verify/progress.ts).
    const releaseCheckProgress = setCheckProgress(name => this.events.watchCheck(name));
    this.lifecycle.add({ name: "check-progress", close: async () => { releaseCheckProgress(); } });
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
    this.copyText = options.copyText;
    this.newProjectRequest = options.newProject;
    this.createProjectFn = options.createProject;
    this.noSandbox = options.noSandbox ?? false;
    this.allow = options.allow;
    this.sandboxSeams = options.sandboxSeams;
    this.webSeams = options.webSeams;
    this.ripgrep = options.ripgrep;
  }

  async start(cwd = process.cwd()): Promise<ProjectInfo> {
    if (this.closing) throw new Error("Casper is closing");
    if (this.projectContext) return this.projectContext.info;
    const { project, context, mcp, visualization, lspConfiguration, referenceConfiguration } = await loadWorkspace(this, cwd);
    if (this.closing) throw new Error("Casper is closing");
    // Your colours from the first line on; a name Casper has no theme for uses default and is named with the [config] lines.
    // The themes of the packs you added (packs on, files as you saw them) are on the list first, so theme: finds them.
    const packThemeNotes = await registerPackThemes(this.homeDir(), context.packs !== false);
    useTheme(context.theme);
    const themeNoted = themeNote(context.theme);
    // The wordmark is for a person at a rich terminal; one-shot and piped output keep the text banner.
    // The header picks art or text per width, so a later resize never wraps the art.
    const wordmark = this.interactive && this.terminal.rich;
    if (wordmark) this.terminal.writeTrusted(wordmarkHeader(this.terminal.color));
    // The shell line is always there in a session; a one-shot run shows it only when nothing holds its commands.
    const shell = this.sandbox && (this.interactive || !this.sandbox.on) ? sandboxBannerLine(this.sandbox) : undefined;
    // A returning user's saved default is known before the runtime starts; say so, not "not initialized".
    if (!this.session) this.savedModelDisplay = await modelPreference(this.sessionHomeDir ?? os.homedir());
    if (!this.session) await checkSignIn(this);
    // --model names the model for this run: show it, not the saved default it overrides. It comes before the hint.
    const shown = this.runModel && !this.session ? `${terminalText(this.runModel)} for this run (--model)` : this.savedModelDisplay;
    const model = formatRuntimeStatus(this.session?.getStatus?.(), shown, this.signedIn, this.interactive && this.terminal.rich);
    this.output.write(renderBanner(context, { wordmark, interactive: this.interactive, ...(shell ? { shell } : {}), model,
      ...(this.interactive ? await bannerChecks(this, context) : {}) }));
    for (const note of sandboxStartupNotes(context.info.root)) this.output.write(`${note}\n`);
    for (const warning of [...this.startupWarnings, ...context.warnings ?? [], ...(themeNoted ? [themeNoted] : [])]) this.output.write(`[config] ${terminalText(warning)}\n`);
    for (const note of packThemeNotes) this.output.write(`[pack] ${terminalText(note)}\n`);
    for (const diagnostic of referenceConfiguration.diagnostics) this.output.write(`[references] ${formatReferenceResult(diagnostic)}\n`);
    reportSkillWarnings(this);
    for (const diagnostic of mcp.diagnostics) this.output.write(`[mcp] ${terminalText(diagnostic)}\n`);
    if (this.interactive) await reportImports(this);
    if (this.interactive) await reportNewerCasper(this, context);
    for (const diagnostic of lspConfiguration.diagnostics) this.output.write(`[lsp] ${diagnostic}\n`);
    for (const diagnostic of visualization.diagnostics) this.output.write(`[visualize] ${diagnostic}\n`);
    if (this.interactive) this.output.write("\n");
    return project;
  }

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
  acquireRuntime(): Promise<AgentRuntime> { return acquireRuntime(this); }

  async ensureRuntime(): Promise<RuntimeSession> { return ensureRuntime(this); }

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
        const session = await ensureRuntime(this);
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

  homeDir(): string { return this.sessionHomeDir ?? os.homedir(); }

  async savedModel(): Promise<string | undefined> { return modelPreference(this.sessionHomeDir ?? os.homedir()); }

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
    // During a task: files listed at its start, and files its own tools wrote, are listed even when git ignores them.
    const edited = this.observations.edited().map((file) => path.relative(root, path.resolve(root, file)).split(path.sep).join("/"));
    try { return await snapshotTree(root, signal, { include: [...this.snapshotBase?.keys() ?? [], ...edited] }); }
    catch (error) {
      // Kept for the receipt: "Changes unknown: this folder has over 20,000 files; open a project folder".
      if (!signal?.aborted) this.snapshotFailure = snapshotFailureReason(error);
      return undefined;
    }
  }

  /** The versions of .casper/project.yaml this session may read again (see src/app/project-file.ts). */
  trustedProjectFiles = new Set<string>();

  /** The current task's first snapshot: its files stay listed while they exist, even once git ignores them. */
  snapshotBase?: Map<string, string>;

  /** This session's answer to "Show the AI the pages?" (showPages: ask); asked once. */
  showPagesAnswer?: boolean;

  /** Pictures pasted into the line being handled; runModelTask takes them. */
  pastedImages?: Map<number, RuntimeImage>;
  /** Those pictures as files in a private folder (temp; ~/.casper on Windows), so the model has a path; deleted when
   * the session closes. */
  readonly pastedImageFiles = new PastedImageFiles(() => pastedFolderParent(process.platform, this.homeDir()));

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
  /** The parts builders landed this task (src/crew/parts.ts); lives and ends with the task's delegate tool. */
  crewParts?: PartRecord;
  /** What this request's words say about builders ("in parallel", "by yourself"); set at each task's start. */
  builderSteer?: BuilderSteer;
  /** Why the AI can't start builders in this workspace now (src/crew/auto.ts); unset when it can. */
  buildersOff?: string;

  /** A rename is a normal edit inside the project: no box, like the AI's other edits (undo covers it). It is noted
   * like one, so dev servers, checks and the receipt see it. */
  confirmRename: ConfirmRename = async (preview) => {
    for (const file of preview.files) observeEdit(this, path.resolve(this.activeWorkspaceRoot(), file.path));
    return true;
  };

  /** Approvals and server questions are shown one at a time, so two boxes never race for one answer. */
  approvalQueue: Promise<unknown> = Promise.resolve();

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
  async reloadReferences(): Promise<void> { return reloadReferences(this); }

  /** After /pack add or /pack remove: skills indexed again, so the change counts from the next request. */
  async reloadSkills(): Promise<void> { return reloadSkills(this); }

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

  updateFooter(): void { updateFooter(this); }
}

export { PAGES_ANSWER_ONLY_PROOF, PAGES_ONLY_PROOF, proofSkipReason } from "./app/task-run";
