import path from "node:path";
import { addLabHosts, labConfigPlace, parseLabFile } from "../network/lab-import";
import type { LabSettings } from "../network/spec";
import type { BrowserSession } from "../browser/session";
import type { ServiceManager, ServiceStatus } from "../services/manager";
import { runTasksCommand, type BackgroundTask } from "./background";
import type { DebugRequest, DebugSession } from "../debug/session";
import { formatSubagentReport, SubagentManager, type SubagentRole } from "../agents/manager";
import { formatReferenceResult, type ReferenceLibrary } from "../references/library";
import { ProjectMemory } from "../memory/store";
import { modelPreference } from "../tui/model-preference";
import { HELP_TEXT, FULL_HELP_TEXT, LOGIN_HELP, helpFor, unknownCommandMessage, wrapHelp } from "../tui/help";
import { formatTerminalJSON } from "../tui/json";
import { formatCacheHitRate, formatCostLong, formatCostShort, formatTokenSplit } from "../tui/usage";
import { effortChoices } from "../tui/effort";
import { pickEffort } from "../tui/effort-picker";
import { commandLabel, formatEffort, formatRuntimeStatus, redactPreview, terminalText, toolTarget } from "../tui/format";
import type { InteractiveTerminal } from "../tui/terminal";
import type { CapabilityBroker } from "../capabilities/broker";
import type { MCPManager, MCPStatus } from "../mcp/manager";
import { READ_ONLY_LOGIN_ENABLE_TEXT } from "../mcp/access";
import { ownSettingsNote, writesTitle, WRITES_OFF_MEANING } from "../mcp/presets";
import type { MCPConfiguration } from "../mcp/config";
import { addUserServer, DOCS_TOOL_NAMES, docsOnlyDefinition, docsPinned, isDocsOnlyDefinition, MCP_FILE_LABEL } from "../mcp/docs";
import { askForLogin, askToForgetLogin, askWhichLogin, type LoginHost } from "../mcp/network/ask-login";
import { getsLogins, isNetworkProduct } from "../mcp/network/logins";
import { networkSetupLine, runNetworkSetup, type SetupHost } from "../mcp/network/setup";
import type { Scrubber } from "../secrets/netconan";
import { defaultRunGit, runReferenceAdd } from "../references/catalog";
import { formatDuration } from "../mcp/clock";
import type { LSPManager } from "../lsp/manager";
import type { SkillRegistry } from "../skills/registry";
import type { ProjectContext } from "../project/context";
import type { ProjectInfo } from "../project/inspect";
import { CHECK_NAMES, type CheckName, type VerificationReport } from "../verify/evidence";
import { defaultVerifyNames } from "../verify/registry";
import { childProjectsWithTests } from "../project/child";
import type { ProjectModel } from "../project/model";
import type { VerificationTask } from "../verify/task";
import { artifactFilesystemSupported } from "../visualize/artifacts";
import { buildRepoGraph } from "../visualize/repo";
import { describeVisualization } from "../visualize/tools";
import { renderProjectSummary } from "../tui/banner";
import { LifecycleRegistry } from "./lifecycle";
import type { VisualizationRouter } from "../visualize/router";
import type { RuntimeAuthenticationResult, RuntimeAuthProvider, RuntimeSession, RuntimeTool, AgentRuntime } from "../runtime/types";
import { describeChecksPlan, type ChecksPlan } from "../verify/mode";
import { detectedMigrations, MIGRATIONS_CHECK } from "../verify/migrations-check";
import { detectedE2e, E2E_CHECK } from "../verify/e2e";
import { TOOL_CALL_LIMIT, type TaskObservations } from "../task/observations";
import { formatTaskResult, NO_CHECKS_FOUND, type TaskResult } from "../task/result";
import { UndoStore } from "../task/undo";
import { tildePath } from "../new/scaffold";
import { conversationLabel, matchConversation, recentTurnLines } from "../sessions/resume";
import { readFile, stat } from "node:fs/promises";
import type { SessionWorkspaceManager } from "../sessions/manager";
import { formatProjectContext } from "../project/context";
import { runSecurityReview, type SecurityAIReview, type SecurityReviewHost } from "./security-review";
import { sandboxReport, sandboxStatusLine } from "./sandbox";
import type { SessionYes } from "./session-yes";
import { webStatusLine } from "../web/tools";
import { readerStatusLine } from "./reader";
import type { ShellSandbox } from "../sandbox/manager";
import { allowKindsChoices, DOCS_COPY_CHOICES, SKILL_TRUST_CHOICES, LAB_IMPORT_CHOICES, MCP_ALLOW_KEEP_CHOICES, MCP_REMEMBER_CHOICES, MCP_WRITES_CHOICES } from "./safe-choices";
import { KIND_TEXT, RISKY_KINDS } from "../capabilities/kinds";

/** Output sink for the app; lives here so the command host stays import-cycle-free. */
export interface OutputWriter {
  write(text: string): void;
}

/** Everything the extracted slash-command handlers touch on the app. The app stays the
 * owner of all state; this interface makes the (wide) coupling explicit instead of private. */
export interface CommandHost {
  readonly output: OutputWriter;
  /** The session's shell sandbox (/sandbox, /status, /permissions). */
  readonly sandbox?: ShellSandbox;
  /** The saved default model and effort, for /status before the model starts. */
  savedModel(): Promise<string | undefined>;
  readonly terminal: InteractiveTerminal;
  readonly interactive: boolean;
  readonly closing: boolean;
  readonly subagents: SubagentManager;
  readonly lifecycle: LifecycleRegistry;
  readonly session?: RuntimeSession;
  /** The mode and checks this session uses after a change (shared with the banner and tasks). */
  checksPlan(context: ProjectContext): Promise<ChecksPlan>;
  /** The provider of the last successful /login, preferred when Casper picks a first model. */
  loginProvider?: RuntimeAuthProvider;
  /** False until a sign-in exists (the footer says how to start). */
  signedIn?: boolean;
  readonly observations: TaskObservations;
  readonly skillRegistry?: SkillRegistry;
  readonly projectContext?: ProjectContext;
  readonly mcp?: MCPManager;
  /** /lab import added hosts: the session's lab list from now on (it is also saved in ~/.casper/config.yaml). */
  setLab?(settings: LabSettings): void;
  /** Ends every allowed change kind and session answer (ctrl+o, /mcp writes off). True when any were in force. */
  endAllowances?(): boolean;
  /** The broker's per-server allowances, for /mcp allow. Only the user's typed command reaches it. */
  readonly allowances?: Pick<CapabilityBroker, "kindAllowed" | "sessionKinds" | "allowKind" | "allowAllOn" | "startAllowAll" | "endAllowancesFor">;
  /** Re-reads MCP configuration from disk for /mcp reload; omitted when MCP is unavailable. */
  readonly reloadMCPConfiguration?: () => Promise<MCPConfiguration>;
  readonly lsp?: LSPManager;
  readonly references?: ReferenceLibrary;
  /** Reads the reference files again after /references add, so the new source is searched with no restart. */
  reloadReferences?(): Promise<void>;
  /** The shared secret scrubber, for /secrets. */
  readonly scrubber: Scrubber;
  /** /secrets files on|off: scrub config files and config-looking command output (MCP results always). */
  scrubFiles: boolean;
  /** Runs git by argv for /references add (tests pass a stub). */
  readonly runGit?: (argv: string[], signal?: AbortSignal) => Promise<{ code: number | null }>;
  /** The home folder that holds ~/.casper. */
  homeDir(): string;
  readonly visualization?: VisualizationRouter;
  readonly inspectProjectFn: (cwd: string) => Promise<ProjectInfo>;
  commandAbort?: AbortController;
  runtimeTools: RuntimeTool[];
  /** Tools offered in this conversation; they stay offered until /clear or /resume. */
  readonly offeredTools: Set<string>;
  /** A new conversation: its first task picks the direct MCP tools afresh. */
  resetToolPicks(): void;
  memoryWork?: Promise<void>;
  visualizationWork?: Promise<void>;
  visualizationAbort?: AbortController;
  browser?: BrowserSession;
  services?: ServiceManager;
  debugSession?: DebugSession;
  lastTaskRequest?: string;
  ensureRuntime(): Promise<RuntimeSession>;
  acquireRuntime(): Promise<AgentRuntime>;
  ensureSessionWorkspace(): Promise<SessionWorkspaceManager>;
  stopDebugger(): Promise<void>;
  /** The host for /mcp setup network: the numbered approval box, the MCP manager, and the install seams. */
  networkSetupHost(): SetupHost;
  /** The host for /mcp login: the numbered approval box, the private prompt, and restarts through the MCP manager. */
  networkLoginHost(): LoginHost;
  /** One numbered answer from the user (never the model): the number picked, or undefined when nobody answered. */
  chooseAnswer(preview: string, question: string, choices: readonly string[], signal?: AbortSignal): Promise<string | undefined>;
  /** A yes/no approval box (1 No · 2 Yes, this once); nobody to ask is a No. */
  confirmYes(preview: string, question: string, signal?: AbortSignal): Promise<boolean>;
  /** Boxes that also offer "Yes, for this session" (the debugger's launch). */
  readonly sessionYes: SessionYes;
  /** One approval box from the user (never the model): the chosen label, or undefined when nobody answered. */
  approveChoice(preview: string, question: string, options: ReadonlyArray<string | { label: string; description?: string }>, signal?: AbortSignal): Promise<string | undefined>;
  git(args: string[]): Promise<string>;
  runVerification(checks: readonly CheckName[], repair: boolean, request?: string, task?: VerificationTask): Promise<VerificationReport>;
  activeWorkspaceRoot(): string;
  browserSession(): BrowserSession;
  serviceManager(): ServiceManager;
  updateFooter(): void;
  handleBranchCommand(prompt: string): Promise<void>;
  handleSwitchCommand(prompt: string): Promise<void>;
  getLastTaskResult(): TaskResult | undefined;
  /** Test seams for /security-review: fake tools and downloads. */
  readonly securitySeams?: Pick<SecurityReviewHost, "check" | "install">;
  /** The AI review after /security-review's tools (runs only after a numbered ask, or /security-review ai). */
  securityAI(): SecurityAIReview | undefined;
  /** `/verify add <name>`: save a ready-made check Casper found (never called without the user asking). */
  saveFoundCheck(name: string): Promise<void>;
  /** `/project <name>`: open a project folder here, or offer to make it (before the model starts). */
  openProjectCommand(name: string): Promise<void>;
  /** /tasks: what runs in the background now, each with its own stop. */
  backgroundTasks(): BackgroundTask[];
}

/** The first, safe choice of the /resume picker. */
export const STAY_HERE = "Stay in this conversation";

export const VERIFY_USAGE = "Usage: /verify [repair] [typecheck|lint|test|build|<named check> ...] | /verify add <found check>";

export async function runSlashCommand(host: CommandHost, prompt: string): Promise<VerificationReport | undefined> {
    if (host.closing) return;
    if (/^\/help(?:\s|$)/.test(prompt)) {
      const word = prompt.slice(5).trim();
      // Laid out for this terminal's width; piped output gets the text unchanged.
      host.output.write(wrapHelp(!word ? HELP_TEXT : word === "all" ? FULL_HELP_TEXT : helpFor(word), host.interactive ? host.terminal.columns : undefined));
      return;
    }
    if (/^\/login(?:\s|$)/.test(prompt)) {
      const argument = prompt.slice(6).trim();
      const provider = (["openai-codex", "github-copilot", "anthropic", "openrouter"] as const).find(id => id === argument);
      if (argument && !provider) {
        host.output.write("Usage: /login [openai-codex|github-copilot|anthropic|openrouter]\n"); return;
      }
      await runLogin(host, provider);
      return;
    }
    if (/^\/model(?:\s|$)/.test(prompt)) {
      if (host.subagents.isBusy) throw new Error("Wait for active subagents before changing models.");
      const session = await host.ensureRuntime();
      host.commandAbort?.signal.throwIfAborted();
      // /model big <selector|clear> is plain words for the reason role: the model Casper offers when repairs run out.
      const argument = prompt.slice(6).trim().replace(/^big(?=\s|$)/, "role reason");
      if (/^(?:roles|role)(?:\s|$)/.test(argument)) {
        const args = argument.split(/\s+/);
        let roles: Record<string, string>;
        if (args[0] === "roles" && args.length === 1) {
          if (!session.getModelRoles) throw new Error("This runtime does not support model roles.");
          roles = session.getModelRoles();
        } else if (args[0] === "role" && args.length === 3 && ["fast", "build", "reason", "review"].includes(args[1]!)) {
          if (!session.setModelRole) throw new Error("This runtime does not support model roles.");
          roles = await session.setModelRole(args[1]!, args[2] === "clear" ? undefined : args[2]);
        } else throw new Error("Usage: /model roles, /model big <selector|clear> or /model role <fast|build|reason|review> <selector|clear>");
        host.output.write(`${["fast", "build", "reason", "review"].map(role => ` ${role.padEnd(9)} ${roles[role] ?? "not configured"}${role === "reason" ? " (your big model)" : ""}`).join("\n")}\n[model] Role mappings are saved globally; the current model is unchanged. Use /model @role[:effort] to select a configured role.\n`);
        return;
      }
      if (!session.selectModel) throw new Error("This runtime does not support model selection.");
      const sessionOnly = /^--session(?:\s|$)/.test(argument);
      // Nothing signed in: an empty picker helps no one, so /model opens sign-in (which then picks a model).
      if (host.interactive && host.terminal.rich && !argument.replace(/^--session/, "").trim()) {
        const available = await session.selectModel({ signal: host.commandAbort?.signal }).catch(() => undefined);
        if (available?.models && !available.models.length) {
          host.output.write("[model] Not signed in yet. Pick a way to sign in; Esc cancels.\n");
          await runLogin(host);
          return;
        }
      }
      const result = await session.selectModel({ query: (sessionOnly ? argument.slice(9).trim() : argument) || undefined,
        persist: !sessionOnly, signal: host.commandAbort?.signal,
        picker: host.interactive ? host.terminal.modelPickerHost() : undefined });
      // A cancelled picker changes nothing; the status block was already shown at startup.
      if (!result.selected && !result.models) { host.output.write("[model] Selection cancelled; model unchanged.\n"); return; }
      host.output.write(`${formatRuntimeStatus(result.status)}\n`);
      if (result.selected) host.output.write(result.savedDefault
        ? "[model] Selected and saved as the Casper default for new conversations.\n"
        : "[model] Selected for this conversation only; startup default unchanged.\n");
      if (result.selected) host.output.write(`[model] The next request sends this conversation's context to ${result.status.provider}.\n`);
      if (result.models) {
        host.output.write(result.models.length ? result.models.map((model) => `  ${model.provider}/${model.id}`).join("\n") + "\n" : "No models with configured credentials. Use /login to configure a supported provider.\n");
        host.output.write("Use /model <provider/model-id> to select. Selection does not send a prompt.\n");
      }
      return;
    }
    if (/^\/effort(?:\s|$)/.test(prompt)) {
      if (host.subagents.isBusy) throw new Error("Wait for active subagents before changing effort.");
      const session = await host.ensureRuntime();
      const args = prompt.split(/\s+/).slice(1);
      if (args.length > 2 || (args.length === 2 && args[1] !== "--session") || args[0]?.startsWith("-")) throw new Error("Usage: /effort <auto|level> [--session]");
      let choice = args[0] ? { level: args[0], persist: args[1] !== "--session" } : undefined;
      const status = session.getStatus?.();
      if (!choice) {
        // During a task an approval or question can arrive while the picker is open: the picker gives way to it.
        const yielded = new AbortController();
        const picker = host.interactive ? host.terminal.exclusiveHost({ onYield: () => yielded.abort() }) : undefined;
        if (picker && session.setEffort && status?.model) {
          const levels = effortChoices(status.availableThinkingLevels);
          const signal = host.commandAbort ? AbortSignal.any([yielded.signal, host.commandAbort.signal]) : yielded.signal;
          choice = await picker.mount(view => pickEffort(view, levels, status.configuredEffort ?? status.thinkingLevel, signal));
          if (!choice) return;
        } else if (!status?.model) { host.output.write("Effort: no model selected. Use /model first; levels depend on the model.\n"); return; }
        else {
          host.output.write(`Effort: ${status.configuredEffort === "auto" ? `auto (currently ${status.thinkingLevel ?? "unset"})` : status.thinkingLevel ?? "unavailable"}. Choices: ${effortChoices(status.availableThinkingLevels).join(", ")}\nUse /effort <auto|level> [--session]. Shift+Tab cycles on a rich terminal (this conversation only). A fixed level disables automatic classification.\n`);
          return;
        }
      }
      if (!session.setEffort) throw new Error("This runtime does not support effort controls.");
      host.output.write(`${formatRuntimeStatus(await session.setEffort(choice.level, choice.persist))}\n`);
      host.updateFooter();
      return;
    }
    if (prompt === "/doctor") { await (await import("../doctor/session")).runDoctorInSession(host); return; }
    if (prompt === "/permissions") {
      host.output.write(`${permissionsText(host.sandbox)}\n`);
      return;
    }
    if (prompt === "/lab" || prompt.startsWith("/lab ")) {
      await handleLabCommand(host, prompt);
      return;
    }
    if (prompt === "/sandbox" || prompt.startsWith("/sandbox ")) {
      const sandbox = host.sandbox;
      if (!sandbox) throw new Error("The shell sandbox starts with the project.");
      const forget = /^\/sandbox\s+forget\s+(\S+)\s*$/.exec(prompt);
      if (forget) {
        const found = await sandbox.forget(forget[1]!);
        host.output.write(found ? `Forgot ${terminalText(forget[1]!)}: shell commands and ssh ask before reaching it again.\n` : `${terminalText(forget[1]!)} was not remembered for this project.\n`);
        return;
      }
      if (prompt.trim() !== "/sandbox") throw new Error("Use /sandbox or /sandbox forget <host>.");
      await sandbox.loadRemembered();
      host.output.write(sandboxReport(sandbox, host.activeWorkspaceRoot(), await sandbox.store?.reachHosts() ?? []));
      return;
    }
    if (prompt === "/context" || prompt === "/usage") {
      const session = await host.ensureRuntime();
      const usage = session.getUsage?.();
      const context = usage?.context;
      if (prompt === "/context") {
        host.output.write(`Context: ${context?.tokens == null ? "unavailable" : `${context.tokens} / ${context.contextWindow} tokens (estimate; ${context.percent?.toFixed(1) ?? "?"}%)`}\n`);
        host.output.write(`Messages: ${usage?.messages ?? "unavailable"}; indexed skills: ${host.skillRegistry!.list().length}; Casper custom tools: ${host.runtimeTools.length}.\nPer-file/skill/tool token attribution is unavailable. /compact sends a model request.\n`);
      } else {
        host.output.write(`Usage: ${usage ? `${formatTokenSplit(usage.tokens)} (${formatTerminalJSON(usage.tokens)})` : "unavailable"}\nCache: ${usage ? formatCacheHitRate(usage.tokens) : "unavailable"}\nCost: ${usage ? formatCostLong(usage, session.getStatus?.()) : "unavailable"}; covers all models used this session; not a bill or a subscription charge.\n`);
        const classifier = usage?.effortClassification;
        if (classifier) host.output.write(`Auto-effort classifier (separate, since session load): ${classifier.requests} request(s); tokens ${formatTerminalJSON(classifier.tokens)}; cost ${classifier.estimatedCost === undefined ? "unknown" : `$${classifier.estimatedCost.toFixed(4)} estimate`}. Failed requests may consume unreported tokens; not included in conversation totals.\n`);
      }
      return;
    }
    if (/^\/compact(?:\s|$)/.test(prompt)) {
      if (host.subagents.isBusy) throw new Error("Wait for active subagents before compacting.");
      const session = await host.ensureRuntime();
      if (!session.compact) throw new Error("This runtime does not support compaction.");
      host.output.write("[context] Compacting with the selected model; workspace files unchanged.\n");
      await session.compact(prompt.slice(8).trim() || undefined, host.commandAbort?.signal);
      host.output.write("[context] Conversation compacted; context usage may remain unavailable until the next response.\n");
      return;
    }
    if (prompt === "/clear" || /^\/resume(?:\s|$)/.test(prompt)) {
      if (host.subagents.isBusy) throw new Error("Wait for active subagents before changing conversations.");
      const session = await host.ensureRuntime();
      let id = prompt.slice(7).trim();
      let title: string | undefined;
      if (prompt !== "/clear") {
        if (!session.listConversations) {
          if (!id) throw new Error("This runtime does not support conversation listing. Use /tree and /switch for named workspaces.");
        } else {
          let current: string | undefined;
          try { current = session.getSessionInfo?.().sessionId; } catch { current = undefined; }
          const saved = (await session.listConversations()).filter(item => item.id !== current);
          if (id) { const match = matchConversation(saved, id); id = match.id; title = conversationLabel(match).title; }
          else if (!saved.length) { host.output.write("No other saved conversations in this folder.\n"); return; }
          else if (host.interactive && host.terminal.canAsk) {
            // A numbered picker, newest first; 1 stays here. Older ones are still there by ID.
            const shown = saved.slice(0, 8).map(item => ({ item, ...conversationLabel(item) }));
            const seen = new Set<string>();
            const options = shown.map(entry => {
              const label = seen.has(entry.title) ? `${entry.title} (${entry.item.id.slice(0, 8)})` : entry.title;
              seen.add(entry.title);
              return { label, description: entry.detail };
            });
            if (saved.length > shown.length) host.output.write(`${saved.length - shown.length} older conversation(s) not shown: /resume <id> opens one.\n`);
            const picked = await host.terminal.pick("Resume which conversation?",
              [{ label: STAY_HERE, description: "nothing changes" }, ...options], host.commandAbort?.signal);
            const index = options.findIndex(option => option.label === picked);
            if (index === -1) { host.output.write("[session] Staying in this conversation.\n"); return; }
            id = shown[index]!.item.id; title = shown[index]!.title;
          } else {
            host.output.write(saved.map(item => { const label = conversationLabel(item); return `${item.id}  ${label.title} · ${label.detail}`; }).join("\n") + "\n");
            host.output.write("Use /resume <id> (its first few characters are enough); /tree and /switch manage named workspaces.\n");
            return;
          }
        }
      }
      await host.browser?.close(); host.browser = undefined;
      // Services belong to the conversation that started them.
      await host.services?.close(); host.services = undefined;
      await host.stopDebugger(); host.debugSession = undefined;
      host.offeredTools.clear();
      host.resetToolPicks();
      if (prompt === "/clear") {
        if (!session.clearConversation) throw new Error("This runtime does not support fresh conversations.");
        await session.clearConversation();
      } else {
        if (!session.resumeConversation) throw new Error("This runtime does not support conversation resume.");
        await session.resumeConversation(id);
      }
      host.lastTaskRequest = undefined;
      await (await host.ensureSessionWorkspace()).rememberConversation(session);
      host.output.write(prompt === "/clear"
        ? "[session] New conversation. Your files are not changed; /resume brings the last one back.\n"
        : `[session] Back in ${title ? `"${terminalText(title)}"` : "that conversation"}. Your files are not changed; /resume lists the others.\n`);
      host.output.write(`${formatRuntimeStatus(session.getStatus?.())}\n`);
      const turns = prompt === "/clear" ? [] : recentTurnLines(session.recentTurns?.(12) ?? []);
      if (turns.length) host.output.write(`Last turns:\n${turns.map(line => terminalText(line)).join("\n")}\n`);
      return;
    }
    if (prompt === "/diff") {
      if (!host.projectContext!.info.isGit) { host.output.write("[diff] Not a Git repository; nothing to compare.\n"); return; }
      const status = await host.git(["status", "--short"]);
      const hasCommit = await host.git(["rev-parse", "--verify", "-q", "HEAD"]).then(() => true, () => false);
      if (!hasCommit) {
        host.terminal.writePanel("git status --short", status.trim() ? status : "(clean)");
        host.output.write("[diff] No commits yet, so there is nothing to compare with; files are listed by name only.\n");
        return;
      }
      const diff = await host.git(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
      host.output.write("");
      host.terminal.writePanel("git status --short", status.trim() ? status : "(clean)");
      if (diff.trim()) host.terminal.writePanel("git diff HEAD", diff, { diff: true });
      host.output.write(`[diff] Tracked changes against HEAD${diff.trim() ? "" : ": none"}; untracked files are listed by name only. Output limited to 64 KiB per command.\n`);
      return;
    }
    if (prompt === "/receipt") {
      const task = host.getLastTaskResult();
      if (!task) throw new Error("No task receipt yet; /receipt shows the detailed receipt of the last model task.");
      host.output.write(`${formatTaskResult(task)}\n`);
      return;
    }
    if (/^\/output(?:\s|$)/.test(prompt)) {
      const argument = prompt.slice(7).trim();
      const recency = argument ? Number(argument) : 1;
      const retained = host.observations.retainedOutputs;
      if (!retained) throw new Error("No tool output retained; /output shows tool calls from the last model task.");
      if (argument === "all") {
        // Every call on its own line: the folded step summary ("✓ 14 edits · 6 commands") leaves them out.
        const calls = host.observations.toolCalls;
        const fit = { root: host.activeWorkspaceRoot(), home: host.homeDir() };
        host.output.write(`[output] ${calls.length} tool call${calls.length === 1 ? "" : "s"} in the last task, oldest first${calls.length >= TOOL_CALL_LIMIT ? " (the first ones only)" : ""}:\n`);
        host.output.write(`${calls.map(call => {
          const kept = toolTarget(call.input, fit);
          const target = kept === undefined ? "" : ` ${redactPreview(kept).replace(/\s+/g, " ").slice(0, 180)}`;
          return `${call.status === "error" ? "✗" : "✓"} ${terminalText(call.toolName)}${target}`;
        }).join("\n")}\n`);
        return;
      }
      const entry = Number.isInteger(recency) ? host.observations.toolOutput(recency) : undefined;
      if (!entry) throw new Error(`Usage: /output [n|all] with n from 1 (most recent) to ${retained} (retained tool call${retained === 1 ? "" : "s"}).`);
      // A command's tool line is a short label; here the whole command comes first, secrets hidden.
      const command = entry.command === undefined ? undefined : redactPreview(entry.command);
      const shown = command === undefined ? entry.target : commandLabel(command);
      const target = shown === undefined ? "" : ` · ${redactPreview(shown).replace(/\s+/g, " ").slice(0, 180)}`;
      const body = entry.text || "(no output text)";
      host.output.write("");
      host.terminal.writePanel(`[output] ${terminalText(entry.toolName).slice(0, 80)}${target} · ${entry.status}${entry.truncated ? " · truncated by runtime" : ""}`,
        command === undefined ? body : `$ ${command}\n${body}`, { tone: entry.status === "error" ? "error" : "muted" });
      return;
    }
    if (prompt === "/status") {
      const info = await host.inspectProjectFn(host.activeWorkspaceRoot());
      host.projectContext!.info.gitBranch = info.gitBranch; host.projectContext!.info.isGit = info.isGit;
      host.output.write(`${renderProjectSummary(host.projectContext!)}\n`);
      host.output.write(`${formatRuntimeStatus(host.session ? host.session.getStatus?.() ?? { auth: "unknown" } : undefined, host.session ? undefined : await host.savedModel())}\n`);
      host.output.write(` skills    ${skillCountLine(host)}; imports: ${host.projectContext!.skills.imports?.join(", ") || "none"} (/skills diagnostics)\n`);
      host.output.write(` mcp       ${host.mcp!.status().length} configured (/mcp for connection status)\n`);
      host.output.write(` lsp       ${host.lsp!.status().length} configured (/lsp for connection status)\n`);
      host.output.write(` browser   ${host.browser?.status().state ?? "idle"}; disposable local browser (/browser)\n`);
      host.output.write(` web       ${webStatusLine(host.projectContext!.web)}\n`);
      host.output.write(` reader    ${readerStatusLine(host.projectContext!.reader)}\n`);
      const services = host.services?.status() ?? [];
      host.output.write(` services  ${Object.keys(host.projectContext!.services ?? {}).length} declared, ${services.filter(service => service.state === "ready").length} running (/services)\n`);
      host.output.write(` debugger  ${host.debugSession?.status().state ?? "idle"}; explicit local DAP (/debug)\n`);
      const usage = host.session?.getUsage?.();
      const cost = usage && formatCostShort(usage, host.session?.getStatus?.());
      host.output.write(` context   ${usage?.context?.percent == null ? "—" : `${usage.context.percent.toFixed(1)}%~`} · ${usage ? `${formatTokenSplit(usage.tokens)}${cost ? ` · ${cost}` : ""}` : "— tokens"} (/context, /usage)\n`);
      host.output.write(" policy    native coding tools enabled (/permissions)\n");
      host.output.write(` shell     ${host.sandbox ? sandboxStatusLine(host.sandbox) : "not started"}\n`);
      host.output.write(` checks    ${describeChecksPlan(await host.checksPlan(host.projectContext!))}\n`);
      host.output.write(` visualize ${host.visualization!.providerNames().join(", ")} (/visualize)\n`);
      host.output.write(" memory    explicit facts and local task summaries (/memory)\n references read-only local sources (/references)\n");
      host.output.write(` undo      ${await undoCopiesLine(host.projectContext!.stateDirectory, host.homeDir())}\n`);
      return;
    }
    if (prompt === "/exit" || prompt === "/quit") return;
    if (/^\/debug(?:\s|$)/.test(prompt)) {
      await handleDebugCommand(host, prompt);
      return;
    }
    if (/^\/browser(?:\s|$)/.test(prompt)) {
      await handleBrowserCommand(host, prompt);
      return;
    }
    if (/^\/services(?:\s|$)/.test(prompt)) {
      await handleServicesCommand(host, prompt);
      return;
    }
    if (/^\/tasks(?:\s|$)/.test(prompt)) {
      await runTasksCommand({ tasks: () => host.backgroundTasks(), write: text => host.output.write(text),
        canAsk: () => host.interactive && host.terminal.canAsk && !host.closing,
        pick: (question, options, signal) => host.terminal.pick(question, options, signal),
        ...(host.commandAbort ? { signal: host.commandAbort.signal } : {}) }, prompt.slice(6));
      return;
    }
    if (/^\/memory(?:\s|$)/.test(prompt)) {
      host.memoryWork = handleMemoryCommand(host, prompt);
      try { await host.memoryWork; }
      finally { host.memoryWork = undefined; }
      return;
    }
    if (/^\/references(?:\s|$)/.test(prompt)) {
      await handleReferencesCommand(host, prompt);
      return;
    }
    if (/^\/secrets(?:\s|$)/.test(prompt)) {
      await handleSecretsCommand(host, prompt);
      return;
    }
    if (prompt === "/project") {
      host.output.write(`${renderProjectSummary(host.projectContext!)}\n`);
      return;
    }
    if (/^\/project\s+\S/.test(prompt)) {
      await host.openProjectCommand(prompt.replace(/^\/project\s+/, "").trim());
      return;
    }
    if (/^\/tree(?:\s|$)/.test(prompt)) {
      if (prompt !== "/tree") throw new Error("Usage: /tree");
      host.output.write((await host.ensureSessionWorkspace()).renderTree());
      return;
    }
    if (/^\/branch(?:\s|$)/.test(prompt)) {
      await host.handleBranchCommand(prompt);
      return;
    }
    if (/^\/switch(?:\s|$)/.test(prompt)) {
      await host.handleSwitchCommand(prompt);
      return;
    }
    if (/^\/delegate(?:\s|$)/.test(prompt)) {
      await host.stopDebugger();
      await handleDelegateCommand(host, prompt);
      return;
    }
    if (/^\/lsp(?:\s|$)/.test(prompt)) {
      await handleLSPCommand(host, prompt);
      return;
    }
    if (/^\/visualize(?:\s|$)/.test(prompt)) {
      host.visualizationWork = handleVisualizeCommand(host, prompt);
      try { await host.visualizationWork; }
      finally { host.visualizationWork = undefined; }
      return;
    }
    if (/^\/mcp(?:\s|$)/.test(prompt)) {
      await handleMCPCommand(host, prompt);
      return;
    }
    if (/^\/skills(?:\s|$)/.test(prompt)) {
      await handleSkillsCommand(host, prompt);
      return;
    }
    if (/^\/security-review(?:\s|$)/.test(prompt)) {
      // The security tools first, with no model call. Every question is numbered; a run that cannot ask downloads,
      // approves and spends nothing. The AI review after them runs only after its own ask (or /security-review ai).
      const ai = host.securityAI();
      await runSecurityReview({
        root: host.activeWorkspaceRoot(), homeDir: host.homeDir(),
        write: (text) => { if (!host.closing) host.output.write(text); },
        canAsk: () => host.interactive && host.terminal.canAsk && !host.closing,
        pick: (question, options, signal) => host.terminal.pick(question, options, signal),
        ...(host.commandAbort ? { signal: host.commandAbort.signal } : {}),
        ...host.securitySeams,
        ...(ai ? { ai } : {}),
      }, prompt.trim().split(/\s+/).slice(1));
      return;
    }
    if (/^\/verify(?:\s|$)/.test(prompt)) {
      const args = prompt.trim().split(/\s+/).slice(1);
      // `/verify add <name>`: the user saves a ready-made check Casper found. Casper never adds one by itself.
      if (args[0] === "add") {
        if (args.length !== 2 || !host.projectContext) throw new Error(VERIFY_USAGE);
        await host.saveFoundCheck(args[1]!);
        return;
      }
      const repair = args[0] === "repair";
      if (repair) args.shift();
      const named = host.projectContext?.model.namedChecks ?? {};
      const found = host.projectContext?.model.foundChecks ?? {};
      const detected = [...(host.projectContext && detectedMigrations(host.projectContext.model) ? [MIGRATIONS_CHECK] : []),
        ...(host.projectContext && detectedE2e(host.projectContext.model) ? [E2E_CHECK] : [])];
      const unsaved = args.find((arg) => Object.hasOwn(found, arg) && !Object.hasOwn(named, arg));
      if (unsaved) {
        host.output.write(`[verify] ${unsaved} is a check Casper found but you have not saved, so it does not run. /verify add ${unsaved} saves it in .casper/project.yaml.\n`);
        return;
      }
      if (args.some((arg) => !CHECK_NAMES.some((name) => name === arg) && !Object.hasOwn(named, arg) && !detected.includes(arg))) {
        throw new Error(VERIFY_USAGE);
      }
      if (!args.length && host.projectContext) {
        const note = await noChecksNote(host.projectContext.model, host.activeWorkspaceRoot(), host.homeDir());
        // Nothing to run is not "Incomplete": one plain line, and where the tests are when a folder inside has some.
        // Nothing ran, so a script's exit code still says "not every check ran" (2), as before; only the words changed.
        if (note) { host.output.write(note); return { status: "incomplete", repairAttempts: 0, rounds: [], results: [], reason: NO_CHECKS_FOUND }; }
        // A Python project with only tests: one line says what isn't there, and the verdict is about what ran,
        // not "Incomplete" and a "has no command" line for each of typecheck, lint and build.
        const { run, missing } = verifyPlan(host.projectContext.model);
        if (missing.length) {
          host.output.write(`[verify] No ${plainList(missing, "or")} command here, so Casper runs ${plainList(run, "and")}.\n`);
          return host.runVerification(run, repair);
        }
      }
      return host.runVerification(args.length ? args : host.projectContext ? defaultVerifyNames(host.projectContext.model) : CHECK_NAMES, repair);
    }
    throw new Error(unknownCommandMessage(prompt.split(/\s+/)[0]!));
  }

async function handleMemoryCommand(host: CommandHost, prompt: string): Promise<void> {
    const memory = new ProjectMemory(host.projectContext!.stateDirectory);
    const [, action, ...args] = prompt.trim().split(/\s+/);
    let result: unknown;
    if (!action) {
      const facts = await memory.facts();
      if (!facts.length) { host.output.write("[memory] No remembered facts. /memory remember <fact> adds one; /memory outcomes lists task summaries.\n"); return; }
      host.output.write(`[memory] ${facts.length} remembered ${facts.length === 1 ? "fact" : "facts"} (/memory forget <id> removes one):\n`);
      for (const fact of facts) host.output.write(`  ${fact.id}  ${terminalText(fact.text)}\n`);
      return;
    }
    else if (action === "remember" && args.length) {
      const fact = await memory.remember(prompt.replace(/^\/memory\s+remember\s+/, ""));
      host.output.write(`[memory] Remembered: ${terminalText(fact.text)}. Casper gives it to the model in this project. /memory forget ${fact.id} removes it.\n`);
      return;
    }
    else if (action === "forget" && args.length === 1) { await memory.forget(args[0]!); host.output.write(`[memory] Forgot ${terminalText(args[0]!)}.\n`); return; }
    else if (action === "outcomes" && !args.length) result = (await memory.outcomes()).map((entry) => ({
      id: entry.id, task: entry.task.slice(0, 256), modelStatus: entry.modelStatus,
      verification: entry.verification, verificationMeaning: entry.verificationMeaning ?? "legacy", coverage: entry.coverage,
      checks: entry.checks, repairAttempts: entry.repairAttempts, accepted: entry.accepted,
    }));
    else if (action === "accept" && args.length === 2 && ["yes", "no"].includes(args[1]!)) {
      await memory.acceptOutcome(args[0]!, args[1] === "yes"); result = "Human acceptance recorded (not verification evidence)";
    } else throw new Error("Usage: /memory | /memory remember <fact> | /memory forget <id> | /memory outcomes | /memory accept <outcome-id> <yes|no>");
    const serialized = JSON.stringify(result, null, 2).replace(/[\u202a-\u202e\u2066-\u2069]/gu, (char) => `\\u${char.codePointAt(0)!.toString(16)}`);
    host.output.write(`[memory] ${serialized}\n`);
  }

async function handleReferencesCommand(host: CommandHost, prompt: string): Promise<void> {
    if (prompt.trim() === "/references") {
      const listing = host.references!.list();
      if (!listing.sources.length && !listing.diagnostics.length) { host.output.write("[references] None yet. /references add lists repos.\n"); return; }
      host.output.write(`[references] ${formatReferenceResult(listing)}\n`);
      return;
    }
    const add = prompt.trim().match(/^\/references\s+add(?:\s+(\S+))?(?:\s+(\S+))?$/);
    if (add) {
      const signal = host.commandAbort?.signal;
      await runReferenceAdd(add[1], add[2], host.homeDir(), {
        print: (line) => { if (!host.closing) host.output.write(`${terminalText(line)}\n`); },
        // Only the user's own 2 downloads anything; one-shot runs never do.
        choose: (preview, question, choices) => host.chooseAnswer(preview, question, choices, signal),
        runGit: (argv) => (host.runGit ?? defaultRunGit)(argv, signal),
        ...(host.reloadReferences ? { reload: () => host.reloadReferences!() } : {}),
      });
      return;
    }
    const match = prompt.match(/^\/references\s+search\s+(\S+)\s+([\s\S]+)$/);
    if (!match) throw new Error("Usage: /references | /references search <source-id|*> <literal query> | /references add [name] [release]");
    const result = await host.references!.search({ query: match[2]!, ...(match[1] === "*" ? {} : { source: match[1]! }) });
    if (!host.closing) host.output.write(`[references] ${formatReferenceResult(result)}\n`);
  }

async function handleDebugCommand(host: CommandHost, prompt: string): Promise<void> {
    const argument = prompt.slice(6).trim();
    const [action, ...args] = argument.split(/\s+/);
    if (action === "stop" && !args.length) {
      await host.debugSession?.close();
      host.output.write(`${formatTerminalJSON(host.debugSession?.status() ?? { state: "idle" })}\n`); return;
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
    if (host.subagents.isBusy) throw new Error("Wait for active subagents before using the debugger");
    if (!host.debugSession || (request?.action === "start" && ["closed", "failed"].includes(host.debugSession.status().state))) {
      await host.stopDebugger();
      const { DebugSession } = await import("../debug/session");
      host.commandAbort?.signal.throwIfAborted();
      if (host.closing) return;
      host.debugSession = new DebugSession({ projectRoot: host.activeWorkspaceRoot(),
        confirm: (preview, signal) => host.sessionYes.approve(`debug:${preview}`, `Debugger launch:\n${preview}\nThe adapter and the program run code, not sandboxed. Debug values may contain secrets.\n`,
          "Launch this debugger target?", signal),
      });
      const debug = host.debugSession;
      host.lifecycle.add({ name: "debug", close: () => debug.close() });
    }
    if (request) host.output.write(`[debug] ${debugProgressMessage(request)}\n`);
    const result = request ? await host.debugSession.run(request, host.commandAbort?.signal)
      : { ...host.debugSession.status(), targets: await host.debugSession.targets() };
    host.output.write(`${formatTerminalJSON(result)}\n`);
  }

function debugProgressMessage(request: DebugRequest): string {
    if (request.action === "start") return `Starting ${request.target}; approval may be required, then Casper waits for adapter initialization and the first stop.`;
    if (request.action === "continue") return `Continuing thread ${request.threadId}; waiting for the debugger to acknowledge resume.`;
    if (request.action === "breakpoints") return `Updating breakpoints for ${request.path || "source"}.`;
    if (request.action === "threads") return "Listing debugger threads.";
    if (request.action === "stack") return `Reading stack for thread ${request.threadId}.`;
    if (request.action === "scopes") return "Reading scopes for the selected frame.";
    return "Reading variables for the selected scope.";
  }

async function handleBrowserCommand(host: CommandHost, prompt: string): Promise<void> {
    const [, action, ...args] = prompt.split(/\s+/);
    if (!action) { host.output.write(`${formatTerminalJSON(host.browser?.status() ?? { state: "idle" })}\n`); return; }
    if (action === "close" && !args.length) { await host.browser?.close(); host.output.write("[browser] Closed owned browser; saved screenshots retained.\n"); return; }
    if (action === "open" && args.length === 1) {
      const result = await host.browserSession().run({ action, url: args[0] }, host.commandAbort?.signal);
      host.output.write(`${formatTerminalJSON(result)}\n`); return;
    }
    if (["inspect", "diagnostics", "screenshot"].includes(action) && !args.length) {
      host.output.write(`${formatTerminalJSON(await host.browserSession().run({ action }, host.commandAbort?.signal))}\n`); return;
    }
    throw new Error("Usage: /browser | /browser open <url> | /browser inspect|diagnostics|screenshot|close");
  }

/** One line per service, plus a crash's or failed start's reason and log tail. */
export function formatServiceStatus(services: readonly ServiceStatus[]): string {
  if (!services.length) return "[services] No services declared. Declare them under services: in .casper/project.yaml (docs/SERVICES.md).\n";
  return `[services]\n${services.map(service => {
    const detail = service.state === "ready" || service.state === "starting" ? `${service.origin ?? ""}  pid ${service.pid ?? "?"}${service.stale ? " · stale (restarts before next use)" : ""}`
      : service.state === "crashed" ? `exit code ${service.exit?.code ?? service.exit?.signal ?? "unknown"}`
      : service.state === "failed" ? service.error ?? "startup failed" : service.command;
    const cleanup = service.cleanup ? "\n  process cleanup unconfirmed; inspect its processes before starting more work" : "";
    const tail = service.tail ? `\n${service.tail.split("\n").map(line => `  | ${line}`).join("\n")}` : "";
    return `${service.name}  ${service.state}  ${detail}${cleanup}${tail}`;
  }).join("\n")}\n`;
}

/** Local control of declared services: no model call and no runtime start. */
async function handleServicesCommand(host: CommandHost, prompt: string): Promise<void> {
    const [, action, name, ...extra] = prompt.trim().split(/\s+/);
    const usage = "Usage: /services | /services logs <name> | /services start|restart|stop <name>";
    if (!action) { host.output.write(formatServiceStatus((host.services ?? host.serviceManager()).status())); return; }
    if (!name || extra.length || !["logs", "start", "restart", "stop"].includes(action)) throw new Error(usage);
    const manager = host.serviceManager();
    if (action === "logs") {
      const { text, truncated } = manager.logs(name, { lines: 60 });
      host.output.write("");
      host.terminal.writePanel(`[services] ${name} log${truncated ? " (recent lines)" : ""}`, text || "(no output)");
      return;
    }
    if (action === "stop") {
      host.output.write(await manager.stop(name) ? `[services] Stopped ${name}.\n` : `[services] ${name} is not running.\n`);
      return;
    }
    if (!manager.names().includes(name)) throw new Error(`No service named ${JSON.stringify(name)}; declared: ${manager.names().join(", ") || "none"} (.casper/project.yaml services)`);
    host.output.write(`[services] ${action === "start" ? "Starting" : "Restarting"} ${name}; waiting for readiness (Ctrl+C cancels the startup).\n`);
    const signal = host.commandAbort?.signal ?? new AbortController().signal;
    if (action === "restart") { host.output.write(formatServiceStatus([await manager.restart(name, signal)])); return; }
    // start means "make it usable": a stale or crashed service is restarted, as before the model's next use.
    const before = manager.status().find(service => service.name === name);
    const { restarted } = await manager.ensureFresh(name, signal);
    if (restarted) host.output.write(`[services] Restarted ${name}: ${before?.state === "crashed" ? "it had crashed" : before?.stale ? "edits made it stale" : "it stopped answering"}.\n`);
    host.output.write(formatServiceStatus(manager.status().filter(service => service.name === name)));
  }

/**
 * A project file can define, or replace by name, a server the user trusts. A --mcp/--lsp flag,
 * script or one-shot run cannot review that, so they authorize only user/profile definitions;
 * a project definition connects only after an interactive exact confirmation of its origin.
 */
async function approveProjectDefinition(host: CommandHost, kind: "mcp" | "lsp",
  name: string, review: { source: string; shadows?: string; preview: string } | undefined): Promise<boolean> {
  if (!review) return true;
  const label = kind.toUpperCase();
  if (!host.interactive) {
    throw new Error(`${label} server ${JSON.stringify(name)} is defined by project file ${terminalText(review.source)}`
      + `${review.shadows ? `, replacing your definition in ${terminalText(review.shadows)}` : ""}. `
      + `--${kind} and non-interactive runs connect only user or profile definitions; review it with an interactive /${kind} connect ${name}`);
  }
  const approved = await host.confirmYes(terminalText(review.preview), `Connect this project-defined ${label} server?`, host.commandAbort?.signal);
  if (!approved) host.output.write(`[${kind}] Connection not approved.\n`);
  return approved;
}

async function handleLSPCommand(host: CommandHost, prompt: string): Promise<void> {
    const [, action, name, ...extra] = prompt.trim().split(/\s+/);
    if (action && (!name || extra.length || !["connect", "disconnect"].includes(action))) {
      throw new Error("Usage: /lsp | /lsp connect <name> | /lsp disconnect <name>");
    }
    if (action === "connect" && await approveProjectDefinition(host, "lsp", name, host.lsp!.review(name))) await host.lsp!.connect(name);
    if (action === "disconnect") await host.lsp!.disconnect(name);
    const statuses = host.lsp!.status();
    host.output.write(statuses.length ? statuses.map((entry) => `${entry.name} [${entry.state}]\n  source: ${entry.source}`).join("\n") + "\n" : "No LSP servers configured.\n");
  }

async function handleVisualizeCommand(host: CommandHost, prompt: string): Promise<void> {
    const [, action, scope, ...extra] = prompt.trim().split(/\s+/);
    if (action && (action !== "repo" || extra.length)) throw new Error("Usage: /visualize | /visualize repo [directory]");
    const router = host.visualization!;
    if (!action) {
      host.output.write([
        `providers: ${router.providerNames().join(", ")}`,
        `artifacts: ${!router.settings.outputDir ? "disabled (in-conversation only)" : artifactFilesystemSupported ? router.settings.outputDir : "in-conversation only (artifact files need macOS or Linux)"}`,
        "Visualization is read-only and never modifies the workspace.",
        "",
      ].join("\n"));
      return;
    }
    const controller = new AbortController();
    host.visualizationAbort = controller;
    try {
      const repo = await buildRepoGraph({ root: host.activeWorkspaceRoot(), scope, signal: controller.signal });
      const rendered = await router.render(repo.graph, controller.signal);
      const description = describeVisualization(rendered, [`Scanned ${repo.filesScanned} files at ${repo.granularity} granularity.`, ...repo.notes]);
      host.output.write(`${rendered.primary.content}\n`);
      for (const note of [...(description.notes as string[]), ...rendered.primary.lossiness]) host.output.write(`[visualize] ${note}\n`);
      for (const artifact of rendered.artifacts) host.output.write(`[visualize] wrote ${artifact.path} (${artifact.bytes} bytes)\n`);
    } finally { host.visualizationAbort = undefined; }
  }

async function handleDelegateCommand(host: CommandHost, prompt: string): Promise<void> {
    const match = prompt.match(/^\/delegate\s+(explorer|reviewer)\s+([\s\S]+)$/);
    if (!match) throw new Error("Usage: /delegate <explorer|reviewer> <goal>");
    const [, role, goal] = match;
    const result = await host.subagents.run({
      role: role as SubagentRole,
      goal,
      signal: host.commandAbort?.signal,
      cwd: host.activeWorkspaceRoot(),
      projectContext: formatProjectContext(host.projectContext!),
      reportTurn: true,
    });
    if (!host.closing) host.output.write(formatSubagentReport(result));
    if (result.status !== "completed") throw new Error(`Delegation ${result.status}; see the bounded report above`);
  }

const MCP_USAGE = "Usage: /mcp | /mcp setup network | /mcp login [mist|central|clearpass] [forget] | /mcp connect <name> | /mcp disconnect <name> | /mcp reload | /mcp writes <name> | /mcp writes off | /mcp allow <name> [off] | /mcp forget <name> | /mcp junos-show <name> on|off | /mcp docs";
/** What "writes off" means, said once under the list: the server runs pinned and every change asks. */
const WRITES_OFF_TEXT = `${WRITES_OFF_MEANING} Answer 2 or 3 in the change box to allow it, or /mcp writes <name> to turn writes on now.`;

async function handleMCPCommand(host: CommandHost, prompt: string): Promise<void> {
    const [, action, name, ...extra] = prompt.trim().split(/\s+/);
    const mcp = host.mcp!;
    if (action === "reload") {
      if (name || extra.length) throw new Error(MCP_USAGE);
      if (!host.reloadMCPConfiguration) throw new Error("MCP configuration cannot be re-read in this session");
      const diff = await mcp.reload(await host.reloadMCPConfiguration());
      host.output.write(`[mcp] reloaded: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed\n`);
      for (const diagnostic of mcp.diagnostics) host.output.write(`[mcp] ${terminalText(diagnostic)}\n`);
      // A changed command/URL is a different program; consent never carries over silently.
      if (diff.revoked.length) host.output.write(`[mcp] consent revoked for ${diff.revoked.join(", ")}; reconnect with /mcp connect <name>\n`);
      host.updateFooter();
    } else if (action === "writes") {
      if (!name || extra.length) throw new Error(MCP_USAGE);
      await handleMCPWrites(host, name);
      return;
    } else if (action === "allow") {
      if (!name || extra.length > 1 || (extra.length === 1 && extra[0] !== "off")) throw new Error(MCP_USAGE);
      await handleMCPAllow(host, name, extra[0] === "off");
      return;
    } else if (action === "setup") {
      if (name !== "network" || extra.length) throw new Error(MCP_USAGE);
      // Only the person types this; the AI has no way to run a slash command.
      await runNetworkSetup(host.networkSetupHost(), { explicit: true });
      host.updateFooter();
      return;
    } else if (action === "login") {
      if ((name && !isNetworkProduct(name)) || extra.length > 1 || (extra.length === 1 && extra[0] !== "forget")) throw new Error(MCP_USAGE);
      // Only the person types this; the AI has no way to run a slash command.
      const login = host.networkLoginHost();
      // Casper's network server (its own entry, or one you added that runs casper-network-mcp), if there is one.
      const server = mcp.status().map((status) => status.name).find((server) => getsLogins(mcp.definition(server)));
      if (!name || !isNetworkProduct(name)) await askWhichLogin(login, server, (product) => askForLogin(login, server, product, { explicit: true }));
      else if (extra[0] === "forget") await askToForgetLogin(login, server, name);
      else await askForLogin(login, server, name, { explicit: true });
      host.updateFooter();
      return;
    } else if (action === "docs") {
      if (name) throw new Error(MCP_USAGE);
      await handleMCPDocs(host);
      return;
    } else if (action === "forget") {
      if (!name || extra.length) throw new Error(MCP_USAGE);
      host.output.write(await mcp.forget(name)
        ? `[mcp] Forgot ${name}. Casper asks again before it connects next time.\n`
        : `[mcp] ${name} was not remembered.\n`);
      return;
    } else if (action === "junos-show") {
      if (!name || extra.length !== 1 || !["on", "off"].includes(extra[0]!)) throw new Error(MCP_USAGE);
      // Only the user types this; the model has no way to run a slash command.
      mcp.setShowOptIn(name, extra[0] === "on");
      host.output.write(extra[0] === "on"
        ? `[mcp] Plain show commands on ${name} run without asking.\n`
        : `[mcp] Show commands on ${name} ask you again.\n`);
      return;
    } else if (action && (!name || extra.length || !["connect", "disconnect"].includes(action))) {
      throw new Error(MCP_USAGE);
    }
    if (action === "connect" && !await approveProjectDefinition(host, "mcp", name, mcp.review(name))) return;
    if (action === "connect") await mcp.connect(name);
    if (action === "disconnect") await mcp.disconnect(name);
    const statuses = mcp.status();
    host.output.write(statuses.length ? statuses.map((status) => [
      `${status.name} [${status.transport}; ${status.state}] ${status.toolCount} tools${status.importedFrom ? ` · from ${status.importedFrom}` : ""}`
        + `${status.preset ? ` · preset: ${status.preset.id}` : ""} · writes ${status.writes}${status.state === "ready" ? ` · ${status.access}` : ""}`,
      `  source: ${status.source}`,
      `  limits: start ${formatDuration(status.limits.connectS * 1000)} · call ${formatDuration(status.limits.callS * 1000)}`,
      ...approvalLines(status),
      ...(status.preset?.lines ?? []).map((line) => `  ${terminalText(line)}`),
      ...(status.showOptIn ? ["  Plain show commands run without asking (/mcp junos-show " + status.name + " off)."] : []),
      // The server just asked for says why in the error below, once.
      ...(status.error && !(action === "connect" && status.name === name) ? [`  ${terminalText(status.error)}`] : []),
      // Already redacted by the manager (known secrets and token shapes); shown to you, never to the model.
      ...(status.serverOutput?.length ? ["  Last lines from the server:", ...status.serverOutput.map((line) => `    | ${terminalText(line)}`)] : []),
    ].join("\n")).join("\n") + `\n${statuses.some((status) => status.writes === "off") ? `${WRITES_OFF_TEXT}\n` : ""}` : "No MCP servers configured.\n");
    if (!action) {
      const network = host.networkSetupHost();
      const line = await networkSetupLine(network.homeDir, await network.configured());
      if (line) host.output.write(`${line}\n`);
    }
    const asked = action === "connect" ? statuses.find((status) => status.name === name) : undefined;
    if (asked && asked.state !== "ready") throw new Error(`${name} did not start${asked.error ? `: ${terminalText(asked.error)}` : "."}`);
    if (action === "connect") await offerRemember(host, name);
  }

/** /secrets and /secrets files on|off. Only the user types these; the model can't run slash commands. */
async function handleSecretsCommand(host: CommandHost, prompt: string): Promise<void> {
  const args = prompt.trim().split(/\s+/).slice(1);
  if (!args.length) { host.output.write(`${await host.scrubber.statusText(host.scrubFiles)}\n`); return; }
  if (args.length !== 2 || args[0] !== "files" || !["on", "off"].includes(args[1]!)) throw new Error("Usage: /secrets | /secrets files on|off");
  host.scrubFiles = args[1] === "on";
  host.output.write(host.scrubFiles ? "Device configs in files and command output: on.\n" : "Device configs in files and command output: off for this session. MCP results, .env and credential files are still scrubbed.\n");
}

/**
 * /mcp docs: the docs servers Casper keeps in front of the model, and an offer to add a docs-only
 * copy of an hpe-networking-mcp router (rag.py only, no credentials) to ~/.casper/mcp.json.
 */
async function handleMCPDocs(host: CommandHost): Promise<void> {
  const mcp = host.mcp!;
  const tools = new Map(mcp.catalog().map((entry) => [entry.server, entry.tools]));
  const docs: string[] = [];
  let docsOnly: string | undefined;
  let copyFrom: { name: string; entry: NonNullable<ReturnType<typeof docsOnlyDefinition>> } | undefined;
  for (const status of mcp.status()) {
    const definition = mcp.definition(status.name);
    const list = tools.get(status.name) ?? [];
    if (docsPinned(definition, mcp.policy(status.name).match, list)) {
      docs.push(`${status.name} (${DOCS_TOOL_NAMES.filter((tool) => list.some((entry) => entry.name === tool)).join(", ")})`);
    }
    if (isDocsOnlyDefinition(definition)) docsOnly ??= status.name;
    const entry = docsOnlyDefinition(definition);
    if (entry && !copyFrom) copyFrom = { name: status.name, entry };
  }
  host.output.write(`Docs servers: ${docs.length ? docs.join(", ") : "none connected"}. ${docsOnly ? `Docs-only server: ${docsOnly}.` : "No docs-only server yet."}\n`);
  if (docsOnly) return;
  if (!copyFrom) { host.output.write("No hpe-networking-mcp router (tool_router.py) that Casper can copy. A router started with extra settings (like --env-file) is not copied; add a docs-only server to ~/.casper/mcp.json yourself.\n"); return; }
  if (!host.interactive) { host.output.write("Run /mcp docs in an interactive session to add a docs-only copy.\n"); return; }
  const name = `${copyFrom.name}-docs`;
  const { entry } = copyFrom;
  const preview = [
    `Will add ${name} to ${MCP_FILE_LABEL}:`,
    `  runs: ${terminalText([entry.command, ...entry.args].join(" "))}`,
    `  env: ${Object.keys(entry.env).join(", ") || "none"} (no credentials, no device settings)`,
    "It only answers docs questions. Casper passes it no passwords.",
    "",
  ].join("\n");
  if (await host.approveChoice(preview, "Add a docs-only copy (no passwords, no device access)?", DOCS_COPY_CHOICES, host.commandAbort?.signal) !== DOCS_COPY_CHOICES[1]) {
    host.output.write("Nothing added.\n");
    return;
  }
  try { await addUserServer(host.homeDir(), name, entry); }
  catch (error) { host.output.write(`${error instanceof Error ? terminalText(error.message) : "Nothing added."}\n`); return; }
  host.output.write(`Added ${name} to ${MCP_FILE_LABEL}. Run /mcp reload, then /mcp connect ${name}.\n`);
}

/** Plain lines about approval: not approved yet, changed since, or remembered. */
function approvalLines(status: MCPStatus): string[] {
  if (status.consent === "changed" && !status.approved) return [`  Changed since you approved it. Run /mcp connect ${status.name}.`];
  if (status.consent === "remembered" && status.approved) return ["  Remembered: connects on its own, with writes off."];
  if (status.importedFrom && !status.approved && status.state === "disconnected") {
    return [`  Found in ${status.importedFrom}. Not approved yet · /mcp connect ${status.name}`];
  }
  return [];
}

/** After you connect your own or an imported server, offer to remember it (writes stay off). No is 1,
 * so a habitual 1 never remembers a server. */
async function offerRemember(host: CommandHost, name: string): Promise<void> {
  const status = host.mcp!.status().find((entry) => entry.name === name);
  if (!host.interactive || !status || status.scope === "project" || status.consent === "remembered") return;
  const block = host.mcp!.rememberBlock(name);
  if (block) { host.output.write(`[mcp] ${terminalText(block)}\n`); return; }
  const answer = await host.approveChoice("Next time it connects on its own, with writes off. Every change still asks you.\n",
    `Remember ${terminalText(name)}?`, MCP_REMEMBER_CHOICES, host.commandAbort?.signal);
  if (answer !== MCP_REMEMBER_CHOICES[1]) { host.output.write(`[mcp] Not remembered. ${name} is connected for this session only.\n`); return; }
  const result = await host.mcp!.remember(name);
  host.output.write(result.remembered
    ? `[mcp] Remembered ${name}. It connects on its own next time, with writes off. /mcp forget ${name} undoes this.\n`
    : `[mcp] ${terminalText(result.reason)}\n`);
}

/**
 * /mcp writes <name> and /mcp writes off. Turning writes on takes two steps that only you can do:
 * this command, then "2" in the box (1 keeps writes off). The model's ask tool never reaches this box.
 */
async function handleMCPWrites(host: CommandHost, name: string): Promise<void> {
  const mcp = host.mcp!;
  if (name === "off") {
    const ended = host.endAllowances?.() ?? false;
    const on = mcp.writesOn();
    if (!on.length) {
      host.output.write(ended ? "[mcp] Allowed change kinds ended. Every change asks you again.\n" : "[mcp] Writes are already off for every server.\n");
      if (ended) host.updateFooter();
      return;
    }
    await Promise.all(on.map((server) => mcp.setWrites(server, false)));
    for (const server of on) host.output.write(`[mcp] Writes off for ${server}. Every change asks you again.\n`);
    host.updateFooter();
    return;
  }
  if (!host.interactive) throw new Error("Writes can only be turned on in an interactive session.");
  const status = mcp.status().find((entry) => entry.name === name);
  if (!status) throw new Error("Unknown MCP server; use /mcp to list definitions");
  if (status.writes === "on") { host.output.write(`[mcp] Writes are already on for ${name}. ${host.terminal.rich ? "ctrl+o" : "/mcp writes off"} turns them off.\n`); return; }
  if (status.access === "login: read-only (checked)") { host.output.write(`[mcp] ${READ_ONLY_LOGIN_ENABLE_TEXT}\n`); return; }
  const policy = mcp.policy(name);
  const answer = await host.approveChoice("", terminalText(writesTitle(name, policy.match)), MCP_WRITES_CHOICES, host.commandAbort?.signal);
  if (answer !== MCP_WRITES_CHOICES[1]) { host.output.write(`[mcp] Writes stay off for ${name}.\n`); return; }
  await mcp.setWrites(name, true);
  host.output.write(`[mcp] Writes on for ${name}. Each change still asks you. ${host.terminal.rich ? "ctrl+o" : "/mcp writes off"} turns writes off.\n`);
  const note = ownSettingsNote(mcp.definition(name), policy.match);
  if (note) host.output.write(`[mcp] ${terminalText(note)}\n`);
  host.updateFooter();
}


/**
 * /mcp allow <name>: which risky change kinds (firmware, delete, admin) this server may make, picked from a numbered
 * list, never a config file. 1 keeps the defaults. A kind is allowed for this session or remembered (keyed to the
 * server's definition, like a remembered server); "everything" is this session only. Every change still shows its box,
 * except under "everything". /mcp allow <name> off goes back to the defaults.
 */
async function handleMCPAllow(host: CommandHost, name: string, off: boolean): Promise<void> {
  const mcp = host.mcp!;
  const allowances = host.allowances;
  const status = mcp.status().find((entry) => entry.name === name);
  if (!status) throw new Error("Unknown MCP server; use /mcp to list definitions");
  if (!allowances) throw new Error("Change kinds can't be allowed in this session.");
  if (off) {
    await mcp.forgetKinds(name);
    allowances.endAllowancesFor(name);
    host.output.write(`[mcp] Change kinds on ${name} are back to the defaults.\n`);
    host.updateFooter();
    return;
  }
  if (!host.interactive) throw new Error("Change kinds can only be allowed in an interactive session.");
  if (status.access === "login: read-only (checked)") { host.output.write(`[mcp] ${READ_ONLY_LOGIN_ENABLE_TEXT}\n`); return; }
  const product = mcp.productLabel(name);
  const remembered = mcp.rememberedKinds(name);
  const session = allowances.sessionKinds(name).filter((kind) => !remembered.includes(kind));
  const now = [...remembered.map((kind) => `${KIND_TEXT[kind]} (remembered)`), ...session.map((kind) => `${KIND_TEXT[kind]} (this session)`)];
  if (allowances.allowAllOn(name)) now.push("everything, no asking (this session)");
  const labels = allowKindsChoices();
  const answer = await host.approveChoice([
    `${terminalText(product)} change kinds. Firmware changes, deletes and admin changes are off by default; every change still asks you.`,
    `  Allowed now: ${now.length ? now.join(", ") : "none"}`,
  ].join("\n") + "\n", `Which change kinds may ${terminalText(product)} make?`, labels, host.commandAbort?.signal);
  const picked = answer === undefined ? 0 : labels.indexOf(answer);
  if (picked < 1) { host.output.write(`[mcp] ${name} keeps the defaults.\n`); return; }
  if (picked === labels.length - 1) {
    allowances.startAllowAll(name);
    host.output.write(`[mcp] Yes to everything on ${name} this session: no change there asks you. ${host.terminal.rich ? "ctrl+o" : "/mcp writes off"} ends it.\n`);
    host.updateFooter();
    return;
  }
  const kinds = picked === labels.length - 2 ? [...RISKY_KINDS] : [RISKY_KINDS[picked - 1]!];
  const words = kinds.length > 1 ? "All change kinds" : KIND_TEXT[kinds[0]!];
  // Project servers and unpinned runners can't be remembered: this session only, without asking.
  const block = mcp.rememberBlock(name);
  const keep = block ? undefined : await host.approveChoice("", "For how long?", MCP_ALLOW_KEEP_CHOICES, host.commandAbort?.signal);
  // Cancelled (ctrl+c, closing): nothing is allowed.
  if (!block && keep === undefined) { host.output.write(`[mcp] ${name} keeps the defaults.\n`); return; }
  for (const kind of kinds) allowances.allowKind(name, kind);
  if (keep === MCP_ALLOW_KEEP_CHOICES[1]) {
    const result = await mcp.rememberKinds(name, kinds);
    if (result.remembered) {
      host.output.write(`[mcp] ${words} allowed on ${name}, remembered. /mcp allow ${name} off undoes this.\n`);
      return;
    }
    host.output.write(`[mcp] ${terminalText(result.reason)}\n`);
  }
  host.output.write(`[mcp] ${words} allowed on ${name} for this session.\n`);
}

/**
 * /lab shows your lab list; /lab import <file> adds devices to it from a file (GreenCLI's export of lab-tagged hosts,
 * or one host per line). The list only marks devices as lab: any device may be checked, after your answer.
 */
async function handleLabCommand(host: CommandHost, prompt: string): Promise<void> {
  const current = host.projectContext?.lab?.hosts ?? [];
  const profile = host.projectContext?.labProfile;
  const place = labConfigPlace(profile);
  const match = /^\/lab\s+import\s+(.+?)\s*$/.exec(prompt);
  const store = host.sandbox?.store;
  if (prompt.trim() === "/lab") {
    const ssh = current.length && store ? (await store.labReach()
      ? "ssh and scp to them don't ask first (/lab ssh off turns that off).\n" : "ssh and scp to them ask first (/lab ssh on stops that).\n") : "";
    host.output.write(`Lab devices: ${current.length ? current.map(terminalText).join(", ") : "none"}${current.length ? ` (from ${place})` : ""}\n`
      + "They only mark devices as lab: any device can be checked, after your answer. /lab import <file> adds more.\n" + ssh);
    return;
  }
  const ssh = /^\/lab\s+ssh\s+(on|off)\s*$/.exec(prompt);
  if (ssh) {
    if (!store) throw new Error("The shell sandbox starts with the project.");
    // Only you type this; kept for this project in ~/.casper.
    await store.setLabReach(ssh[1] === "on");
    host.output.write(ssh[1] === "on" ? "[lab] ssh and scp to lab devices don't ask first.\n" : "[lab] ssh and scp to lab devices ask first again.\n");
    return;
  }
  if (!match) throw new Error("Use /lab, /lab import <file> or /lab ssh on|off.");
  if (!host.interactive) throw new Error("/lab import asks you first; run it in an interactive session.");
  const given = match[1]!.replace(/^["']|["']$/g, "");
  const file = given === "~" || given.startsWith("~/") ? path.join(host.homeDir(), given.slice(2)) : path.resolve(host.activeWorkspaceRoot(), given);
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 256 * 1024) throw new Error("not a plain file under 256 KB");
    text = await readFile(file, "utf8");
  } catch (error) { throw new Error(`Can't read ${terminalText(given)}: ${error instanceof Error ? error.message : String(error)}`); }
  let hosts: string[];
  try { hosts = parseLabFile(text); } catch (error) { throw new Error(`${terminalText(given)}: ${error instanceof Error ? error.message : String(error)}`); }
  const known = new Set(current.map((entry) => entry.toLowerCase()));
  const fresh = hosts.filter((entry) => !known.has(entry.toLowerCase()));
  if (!fresh.length) { host.output.write(`[lab] All ${hosts.length} are already in your lab list.\n`); return; }
  const shown = fresh.slice(0, 20).map(terminalText).join(", ") + (fresh.length > 20 ? ` and ${fresh.length - 20} more` : "");
  const devices = `${fresh.length} ${fresh.length === 1 ? "device" : "devices"}`;
  const answer = await host.approveChoice("", `Add ${devices} to your lab list (${place})? ${shown}`, LAB_IMPORT_CHOICES, host.commandAbort?.signal);
  if (answer !== LAB_IMPORT_CHOICES[1]) { host.output.write("[lab] Nothing added.\n"); return; }
  const result = await addLabHosts(host.homeDir(), fresh, profile);
  host.setLab?.({ hosts: [...current, ...result.added] });
  const added = `${result.added.length} ${result.added.length === 1 ? "device" : "devices"}`;
  host.output.write(result.added.length
    ? `[lab] Added ${added} to ${place}: ${result.added.slice(0, 20).map(terminalText).join(", ")}${result.added.length > 20 ? ` and ${result.added.length - 20} more` : ""}. Device checks no longer call them "not marked lab".\n`
    : `[lab] They were already in ${place}.\n`);
}

/** "8 indexed (6 bundled)", or "2 indexed; bundled: off" when skills.bundled is false. */
function skillCountLine(host: CommandHost): string {
  const skills = host.skillRegistry!.list();
  const bundled = skills.filter((skill) => skill.source === "bundled").length;
  if (host.projectContext!.skills.bundled === false) return `${skills.length} indexed; bundled: off`;
  return `${skills.length} indexed${bundled ? ` (${bundled} bundled)` : ""}`;
}

async function handleSkillsCommand(host: CommandHost, prompt: string): Promise<void> {
    const registry = host.skillRegistry!;
    const [, action, id, sha256, ...extra] = prompt.trim().split(/\s+/);
    try {
      if (!action) {
        const skills = registry.list();
        host.output.write(`${skillCountLine(host)}; imports: ${host.projectContext!.skills.imports?.join(", ") || "none"}\n`);
        host.output.write(skills.length ? skills.map((skill) => [
          `${skill.id} [${skill.source}; ${skill.trust}${skill.disableModelInvocation ? "; manual-only" : ""}]`,
          `  ${JSON.stringify(skill.description)}`,
          `  ${skill.source === "bundled" ? `${skill.filePath.replace(/^bundled:/, "")} (inside Casper; /settings turns them off)` : skill.filePath}`,
        ].join("\n")).join("\n\n") + "\n" : "No skills discovered.\n");
      } else if (action === "diagnostics" && !id) {
        host.output.write(registry.diagnostics.length ? registry.diagnostics.join("\n") + "\n" : "No skill warnings.\n");
      } else if (action === "inspect" && id && !sha256) {
        const inspected = await registry.inspect(id);
        host.output.write([
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
          inspected.skill.source === "bundled"
            ? `Bundled with Casper and trusted. /skills block ${id} stops it; /settings turns them all off.`
            : `After reviewing: /skills trust ${id}${host.interactive ? "" : ` ${inspected.sha256}`}`,
          "",
        ].join("\n"));
      } else if (action === "trust" && id && sha256 && !extra.length) {
        await registry.trust(id, sha256);
        host.output.write(`Trusted reviewed content for ${id}.\n`);
      } else if (action === "trust" && id && !sha256 && host.interactive) {
        // Shows exactly what you trust, then 1 No · 2 Trust it: the fingerprint of what was shown, not a copied one.
        const inspected = await registry.inspect(id);
        const name = inspected.skill.id.replace(/@[a-f0-9]+$/, "");
        const preview = [`Skill: ${inspected.skill.id}`, `File: ${inspected.skill.filePath}`, inspected.body, `SHA256: ${inspected.sha256}`, ""].join("\n");
        if (await host.approveChoice(terminalText(preview), `Trust ${terminalText(name)} as shown?`, SKILL_TRUST_CHOICES, host.commandAbort?.signal) !== SKILL_TRUST_CHOICES[1]) {
          host.output.write("[skills] Not trusted.\n");
          return;
        }
        await registry.trust(id, inspected.sha256);
        host.output.write(`Trusted reviewed content for ${inspected.skill.id}.\n`);
      } else if (action === "block" && id && !sha256) {
        await registry.block(id);
        host.output.write(`Blocked ${id} for future prompts.\n`);
      } else {
        host.output.write("Usage: /skills | /skills inspect <id> | /skills trust <id> | /skills block <id>\n");
      }
    } catch (error) {
      host.output.write(`[skills] ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

/** A failed sign-in in plain words: the reason Casper has (never provider text) and the next step. */
export function loginFailureText(result: Extract<RuntimeAuthenticationResult, { status: "failed" }>): string {
  const detail = result.detail ? terminalText(result.detail) : undefined;
  if (result.reason === "destination") return `[login] Can't save the key${detail ? `: ${detail}` : ""}. Nothing was changed.\n`;
  if (detail === "CASPER_TUI_WRITE_LOG is set") return "[login] Sign-in is off while CASPER_TUI_WRITE_LOG is set. Unset it, then type /login.\n";
  return detail ? `[login] Sign-in failed: ${detail}. Nothing was saved. Type /login to try again.\n`
    : "[login] Sign-in didn't finish. Nothing was saved. Type /login to try again.\n";
}

/** The sign-in flow behind /login, also opened by Casper itself when no model can run. After a saved
 * credential, a model is picked only when none is set yet (never replacing a choice). True when a
 * credential was saved and refreshed. */
/** `list`: Casper opened sign-in by itself, so the numbered list shows even for a provider with one way. */
export async function runLogin(host: CommandHost, provider?: RuntimeAuthProvider, list = false): Promise<boolean> {
  const picker = host.interactive ? host.terminal.exclusiveHost() : undefined;
  if (!picker) { host.output.write(LOGIN_HELP); return false; }
  if (host.subagents.isBusy) throw new Error("Wait for active subagents before login.");
  try {
    const runtime = await host.acquireRuntime();
    host.commandAbort?.signal.throwIfAborted();
    if (!runtime.authenticate) { host.output.write("[login] This runtime does not support login.\n"); return false; }
    const result = await runtime.authenticate({ provider, ...(list ? { list } : {}),
      terminalHost: picker, signal: host.commandAbort?.signal });
    if (result.status === "saved") {
      // Login never starts a conversation: with none open yet, the first request picks the model.
      host.loginProvider = provider;
      host.signedIn = true;
      const picked = host.session ? await host.session.selectDefaultModel?.({ provider, signal: host.commandAbort?.signal }).catch(() => undefined) : undefined;
      if (picked?.selected) {
        host.output.write(`[login] Credential saved and verified; no model call was made. Casper picked ${picked.status.provider}/${picked.status.model} and saved it as your default. Use /model to choose another.\n`);
        host.updateFooter();
      } else host.output.write(`[login] Credential saved. Local auth refreshed; typed API keys were verified with the provider; no model call was made. ${host.session
        ? "Model and defaults unchanged. Use /model to choose a model." : "If no model is set yet, Casper picks one for this provider on your first request; /model chooses another."}\n`);
      return true;
    }
    if (result.status === "saved-needs-refresh") host.output.write("[login] Credential saved, but local auth needs refresh. Restart Casper; do not repeat login blindly.\n");
    else if ("effect" in result && result.effect === "unknown") host.output.write("[login] Login ended; credential save outcome unknown. Restart and inspect local auth before retrying.\n");
    else if (result.status === "cancelled") host.output.write("[login] Cancelled; no credential saved.\n");
    else host.output.write(loginFailureText(result));
  } catch { host.output.write("[login] Sign-in didn't finish. Nothing was saved. Type /login to try again.\n"); }
  return false;
}

/** /status: how much disk the undo copies take, and where (no copy is made to find out). */
async function undoCopiesLine(stateDirectory: string, home: string): Promise<string> {
  const store = new UndoStore({ stateDirectory, root: stateDirectory });
  const there = await stat(store.gitDir).then(() => true, () => false);
  const bytes = there ? await store.size() : undefined;
  if (bytes === undefined) return "no copies yet (a copy is made before each task; /undo, /diff)";
  const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `copies of recent tasks take ${size} in ${terminalText(tildePath(store.gitDir, home))} (/undo, /diff)`;
}

/** /permissions: what Casper enforces, from the state it is in now. */
export function permissionsText(sandbox: ShellSandbox | undefined): string {
  const shell = sandbox?.on
    ? "Shell commands and checks run in a sandbox: they can write only in this project, temp and package caches (other folders ask), can't read your private folders, and reach only listed hosts (others ask). They don't see your AI provider keys. MCP servers, language servers, the debugger and the browser are not in the sandbox."
    : `Shell commands and checks are not sandboxed here (${sandbox?.failure ?? sandbox?.state.reason ?? "no sandbox"}): they run with your permissions, files and network, without your AI provider keys.${sandbox?.asksFirst ? " Casper asks before each shell command the AI runs, except plain reads like ls or git status." : ""}`;
  return [
    shell,
    `The AI's file tools (read, edit, write, grep, find, ls) stay out of private places and git's own files and never follow a link out of the project. ${sandbox && !sandbox.asksOutsideWrites
      ? "With the sandbox off, an edit or write outside the project doesn't ask." : "An edit or write outside the project asks first (temp and caches don't; --no-sandbox turns this off)."}`,
    "Web lookups (web_search, web_fetch) read public pages without asking. Private and local addresses, other ports, and a search or address holding a secret are refused; what comes back has its secrets hidden. /settings turns them off.",
    "The untrusted-text reader (casper_read_untrusted) reads a file, a read-only command or an MCP tool through a separate model call with no tools; the AI gets only JSON that matches its schema, never the text. It changes nothing; an MCP tool keeps its own approval. /settings turns it off.",
    "MCP, workspace transitions, debugger launch and consequential browser operations have their own exact approvals. The AI can't approve anything for you.",
    "No SAFE/YOLO or read-only mode is implied. /verify and /services may execute project scripts (the declared checks and service commands). See docs/SECURITY.md.",
  ].join("\n");
}

/** What plain `/verify` runs: every named check, and each of typecheck, lint, test and build that has a command. */
export function verifyPlan(model: ProjectModel): { run: CheckName[]; missing: CheckName[] } {
  const names = defaultVerifyNames(model);
  const missing = names.filter((name) => (CHECK_NAMES as readonly string[]).includes(name) && !model.commands[name as keyof ProjectModel["commands"]]?.trim());
  return { run: names.filter((name) => !missing.includes(name)), missing };
}

/** "typecheck, lint or build" / "test and build". */
function plainList(names: readonly string[], joiner: "or" | "and"): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${joiner} ${names.at(-1)}`;
}

/** "/verify" when the folder has no check at all: "No checks found in Documents." and, when folders inside have
 * tests, "Tests found in sample-tools: /project sample-tools". Undefined when something can run. */
export async function noChecksNote(model: ProjectModel, root: string, homeDir: string): Promise<string | undefined> {
  const names = defaultVerifyNames(model);
  const runnable = names.some((name) => !(CHECK_NAMES as readonly string[]).includes(name) || model.commands[name as keyof ProjectModel["commands"]]?.trim());
  if (runnable) return undefined;
  const folder = path.basename(root) || root;
  const children = await childProjectsWithTests(root, homeDir).catch(() => []);
  if (!children.length) return `[verify] No tests in ${folder} yet. Say "add tests" and Casper writes some.\n`;
  const lines = [`No checks found in ${folder}.`];
  for (const child of children) lines.push(`Tests found in ${child.relative}: /project ${child.relative}`);
  return `[verify] ${lines.join(" ")}\n`;
}
