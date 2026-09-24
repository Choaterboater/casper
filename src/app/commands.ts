import type { BrowserSession } from "../browser/session";
import type { DebugRequest, DebugSession } from "../debug/session";
import { formatSubagentReport, SubagentManager, type SubagentRole } from "../agents/manager";
import { formatReferenceResult, type ReferenceLibrary } from "../references/library";
import { ProjectMemory } from "../memory/store";
import { modelPreference } from "../tui/model-preference";
import { HELP_TEXT, FULL_HELP_TEXT, LOGIN_HELP } from "../tui/help";
import { formatTerminalJSON } from "../tui/json";
import { effortChoices } from "../tui/effort";
import { pickEffort } from "../tui/effort-picker";
import { formatEffort, formatRuntimeStatus, redactPreview, terminalText } from "../tui/format";
import type { InteractiveTerminal } from "../tui/terminal";
import type { CapabilityBroker } from "../capabilities/broker";
import type { MCPManager } from "../mcp/manager";
import type { MCPConfiguration } from "../mcp/config";
import type { LSPManager } from "../lsp/manager";
import type { SkillRegistry } from "../skills/registry";
import type { ProjectContext } from "../project/context";
import type { ProjectInfo } from "../project/inspect";
import type { ProjectCommand } from "../project/model";
import { CHECK_NAMES, type VerificationReport } from "../verify/evidence";
import type { VerificationTask } from "../verify/task";
import { artifactFilesystemSupported } from "../visualize/artifacts";
import { buildRepoGraph } from "../visualize/repo";
import { describeVisualization } from "../visualize/tools";
import { renderProjectSummary } from "../tui/banner";
import { LifecycleRegistry } from "./lifecycle";
import type { VisualizationRouter } from "../visualize/router";
import type { RuntimeSession, RuntimeTool, AgentRuntime } from "../runtime/types";
import type { TaskObservations } from "../task/observations";
import type { SessionWorkspaceManager } from "../sessions/manager";
import { formatProjectContext } from "../project/context";

/** Output sink for the app; lives here so the command host stays import-cycle-free. */
export interface OutputWriter {
  write(text: string): void;
}

/** Everything the extracted slash-command handlers touch on the app. The app stays the
 * owner of all state; this interface makes the (wide) coupling explicit instead of private. */
export interface CommandHost {
  readonly output: OutputWriter;
  readonly terminal: InteractiveTerminal;
  readonly interactive: boolean;
  readonly closing: boolean;
  readonly subagents: SubagentManager;
  readonly lifecycle: LifecycleRegistry;
  readonly session?: RuntimeSession;
  readonly observations: TaskObservations;
  readonly skillRegistry?: SkillRegistry;
  readonly projectContext?: ProjectContext;
  readonly mcp?: MCPManager;
  /** Re-reads MCP configuration from disk for /mcp reload; omitted when MCP is unavailable. */
  readonly reloadMCPConfiguration?: () => Promise<MCPConfiguration>;
  readonly lsp?: LSPManager;
  readonly references?: ReferenceLibrary;
  readonly visualization?: VisualizationRouter;
  readonly inspectProjectFn: (cwd: string) => Promise<ProjectInfo>;
  commandAbort?: AbortController;
  runtimeTools: RuntimeTool[];
  memoryWork?: Promise<void>;
  visualizationWork?: Promise<void>;
  visualizationAbort?: AbortController;
  browser?: BrowserSession;
  debugSession?: DebugSession;
  lastTaskRequest?: string;
  ensureRuntime(): Promise<RuntimeSession>;
  acquireRuntime(): Promise<AgentRuntime>;
  ensureSessionWorkspace(): Promise<SessionWorkspaceManager>;
  stopDebugger(): Promise<void>;
  confirmExact(preview: string, question: string, signal?: AbortSignal): Promise<boolean>;
  git(args: string[]): Promise<string>;
  runVerification(checks: readonly ProjectCommand[], repair: boolean, request?: string, task?: VerificationTask): Promise<VerificationReport>;
  activeWorkspaceRoot(): string;
  browserSession(): BrowserSession;
  updateFooter(): void;
  handleBranchCommand(prompt: string): Promise<void>;
  handleSwitchCommand(prompt: string): Promise<void>;
}

export async function runSlashCommand(host: CommandHost, prompt: string): Promise<VerificationReport | undefined> {
    if (host.closing) return;
    if (prompt === "/help" || prompt === "/help all") {
      host.output.write(prompt === "/help" ? HELP_TEXT : FULL_HELP_TEXT);
      return;
    }
    if (/^\/login(?:\s|$)/.test(prompt)) {
      const argument = prompt.slice(6).trim();
      const provider = (["openai-codex", "github-copilot", "anthropic", "openrouter"] as const).find(id => id === argument);
      if (argument && !provider) {
        host.output.write("Usage: /login [openai-codex|github-copilot|anthropic|openrouter]\n"); return;
      }
      const picker = host.interactive ? host.terminal.exclusiveHost() : undefined;
      if (!picker) { host.output.write(LOGIN_HELP); return; }
      if (host.subagents.isBusy) throw new Error("Wait for active subagents before login.");
      try {
        const runtime = await host.acquireRuntime();
        host.commandAbort?.signal.throwIfAborted();
        if (!runtime.authenticate) { host.output.write("[login] This runtime does not support login.\n"); return; }
        const result = await runtime.authenticate({ provider,
          terminalHost: picker, signal: host.commandAbort?.signal });
        if (result.status === "saved") host.output.write("[login] Credential saved. Local auth refreshed; typed API keys were verified with the provider; no model call was made. Model and defaults unchanged. Use /model to choose a model.\n");
        else if (result.status === "saved-needs-refresh") host.output.write("[login] Credential saved, but local auth needs refresh. Restart Casper; do not repeat login blindly.\n");
        else if ("effect" in result && result.effect === "unknown") host.output.write("[login] Login ended; credential save outcome unknown. Restart and inspect local auth before retrying.\n");
        else if (result.status === "cancelled") host.output.write("[login] Cancelled; no credential saved.\n");
        else host.output.write(result.reason === "destination"
          ? "[login] Unsafe credential destination. Requires a private, owner-held regular file in real directories; no permissions were repaired.\n"
          : "[login] Login unavailable or failed. No credential saved. Disable PI_TUI_WRITE_LOG if set. Check provider eligibility and loopback callback availability; no automatic method fallback.\n");
      } catch { host.output.write("[login] Login could not complete. No provider diagnostics are displayed.\n"); }
      return;
    }
    if (/^\/model(?:\s|$)/.test(prompt)) {
      if (host.subagents.isBusy) throw new Error("Wait for active subagents before changing models.");
      const session = await host.ensureRuntime();
      host.commandAbort?.signal.throwIfAborted();
      const argument = prompt.slice(6).trim();
      if (/^(?:roles|role)(?:\s|$)/.test(argument)) {
        const args = argument.split(/\s+/);
        let roles: Record<string, string>;
        if (args[0] === "roles" && args.length === 1) {
          if (!session.getModelRoles) throw new Error("This runtime does not support model roles.");
          roles = session.getModelRoles();
        } else if (args[0] === "role" && args.length === 3 && ["fast", "build", "reason", "review"].includes(args[1]!)) {
          if (!session.setModelRole) throw new Error("This runtime does not support model roles.");
          roles = await session.setModelRole(args[1]!, args[2] === "clear" ? undefined : args[2]);
        } else throw new Error("Usage: /model roles or /model role <fast|build|reason|review> <selector|clear>");
        host.output.write(`${["fast", "build", "reason", "review"].map(role => ` ${role.padEnd(9)} ${roles[role] ?? "not configured"}`).join("\n")}\n[model] Role mappings are saved globally; the current model is unchanged. Use /model @role[:effort] to select a configured role.\n`);
        return;
      }
      if (!session.selectModel) throw new Error("This runtime does not support model selection.");
      const sessionOnly = /^--session(?:\s|$)/.test(argument);
      const result = await session.selectModel({ query: (sessionOnly ? argument.slice(9).trim() : argument) || undefined,
        persist: !sessionOnly, signal: host.commandAbort?.signal,
        picker: host.interactive ? host.terminal.modelPickerHost() : undefined });
      // A cancelled picker changes nothing; the status block was already shown at startup.
      if (!result.selected && !result.models) { host.output.write("[model] Selection cancelled; model unchanged.\n"); return; }
      host.output.write(`${formatRuntimeStatus(result.status)}\n`);
      if (result.selected) host.output.write(result.savedDefault
        ? "[model] Selected and saved as the Casper default for new conversations. Shared Pi settings unchanged.\n"
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
        const picker = host.interactive ? host.terminal.exclusiveHost() : undefined;
        if (picker && session.setEffort && status?.model) {
          const levels = effortChoices(status.availableThinkingLevels);
          choice = await picker.mount(view => pickEffort(view, levels, status.configuredEffort ?? status.thinkingLevel, host.commandAbort?.signal));
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
    if (prompt === "/permissions") {
      host.output.write("Permissions: native read/edit/write/bash tools execute within the requested coding task; no OS sandbox or universal shell approval gate.\nMCP, workspace transitions, debugger launch and consequential browser operations have their own exact approvals.\nNo SAFE/YOLO or read-only mode is implied. /verify may execute project scripts.\n");
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
        host.output.write(`Usage: ${usage ? formatTerminalJSON(usage.tokens) : "unavailable"}\nCost: ${usage?.estimatedCost === undefined ? "unavailable" : `$${usage.estimatedCost.toFixed(4)} SDK/catalog estimate`}; not a bill or a subscription charge.\n`);
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
      const id = prompt.slice(7).trim();
      if (prompt === "/resume") {
        if (!session.listConversations) throw new Error("This runtime does not support conversation listing. Use /tree and /switch for named workspaces.");
        const saved = await session.listConversations();
        host.output.write(saved.length ? saved.map(item => `${item.id}  ${item.name ?? "(unnamed)"}  ${item.modified}`).join("\n") + "\n" : "No saved conversations in this workspace.\n");
        host.output.write("Use /resume <exact-id>; /tree and /switch manage named workspaces.\n");
        return;
      }
      await host.browser?.close(); host.browser = undefined;
      await host.stopDebugger(); host.debugSession = undefined;
      if (prompt === "/clear") {
        if (!session.clearConversation) throw new Error("This runtime does not support fresh conversations.");
        await session.clearConversation();
      } else {
        if (!session.resumeConversation) throw new Error("This runtime does not support conversation resume.");
        await session.resumeConversation(id);
      }
      host.lastTaskRequest = undefined;
      await (await host.ensureSessionWorkspace()).rememberConversation(session);
      host.output.write(`[session] ${prompt === "/clear" ? "Fresh conversation started" : "Conversation resumed"}; workspace files unchanged. Previous conversations remain available through /resume.\n`);
      host.output.write(`${formatRuntimeStatus(session.getStatus?.())}\n`);
      return;
    }
    if (prompt === "/diff") {
      if (!host.projectContext!.info.isGit) { host.output.write("[diff] Not a Git repository; nothing to compare.\n"); return; }
      const status = await host.git(["status", "--short"]);
      const diff = await host.git(["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
      host.output.write("");
      host.terminal.writePanel("git status --short", status.trim() ? status : "(clean)");
      if (diff.trim()) host.terminal.writePanel("git diff HEAD", diff, { diff: true });
      host.output.write(`[diff] Tracked changes against HEAD${diff.trim() ? "" : ": none"}; untracked files are listed by name only. Output limited to 64 KiB per command.\n`);
      return;
    }
    if (/^\/output(?:\s|$)/.test(prompt)) {
      const argument = prompt.slice(7).trim();
      const recency = argument ? Number(argument) : 1;
      const retained = host.observations.retainedOutputs;
      if (!retained) throw new Error("No tool output retained; /output shows tool calls from the last model task.");
      const entry = Number.isInteger(recency) ? host.observations.toolOutput(recency) : undefined;
      if (!entry) throw new Error(`Usage: /output [n] with n from 1 (most recent) to ${retained} (retained tool call${retained === 1 ? "" : "s"}).`);
      const target = entry.target === undefined ? "" : ` · ${redactPreview(entry.target).replace(/\s+/g, " ").slice(0, 180)}`;
      host.output.write("");
      host.terminal.writePanel(`[output] ${terminalText(entry.toolName).slice(0, 80)}${target} · ${entry.status}${entry.truncated ? " · truncated by runtime" : ""}`, entry.text || "(no output text)", { tone: entry.status === "error" ? "error" : "muted" });
      return;
    }
    if (prompt === "/status") {
      const info = await host.inspectProjectFn(host.activeWorkspaceRoot());
      host.projectContext!.info.gitBranch = info.gitBranch; host.projectContext!.info.isGit = info.isGit;
      host.output.write(`${renderProjectSummary(host.projectContext!)}\n`);
      host.output.write(`${formatRuntimeStatus(host.session ? host.session.getStatus?.() ?? { auth: "unknown" } : undefined)}\n`);
      host.output.write(` skills    ${host.skillRegistry!.list().length} indexed; imports: ${host.projectContext!.skills.imports?.join(", ") || "none"} (/skills diagnostics)\n`);
      host.output.write(` mcp       ${host.mcp!.status().length} configured (/mcp for connection status)\n`);
      host.output.write(` lsp       ${host.lsp!.status().length} configured (/lsp for connection status)\n`);
      host.output.write(` browser   ${host.browser?.status().state ?? "idle"}; disposable local browser (/browser)\n`);
      host.output.write(` debugger  ${host.debugSession?.status().state ?? "idle"}; explicit local DAP (/debug)\n`);
      const usage = host.session?.getUsage?.();
      host.output.write(` context   ${usage?.context?.percent == null ? "—" : `${usage.context.percent.toFixed(1)}%~`} · ${usage?.tokens.total ?? "—"} session tokens (/context, /usage)\n`);
      host.output.write(" policy    native coding tools enabled; not sandboxed (/permissions)\n verify    explicit scoped checks only; completion is not verification (/verify)\n");
      host.output.write(` visualize ${host.visualization!.providerNames().join(", ")} (/visualize)\n`);
      host.output.write(" memory    explicit facts and local task summaries (/memory)\n references read-only local sources (/references)\n");
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
    if (prompt === "/project") {
      host.output.write(`${renderProjectSummary(host.projectContext!)}\n`);
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
    if (/^\/verify(?:\s|$)/.test(prompt)) {
      const args = prompt.trim().split(/\s+/).slice(1);
      const repair = args[0] === "repair";
      if (repair) args.shift();
      if (args.some((arg) => !CHECK_NAMES.some((name) => name === arg))) {
        throw new Error("Usage: /verify [repair] [typecheck|lint|test|build ...]");
      }
      return host.runVerification(args.length ? args as ProjectCommand[] : CHECK_NAMES, repair);
    }
    throw new Error(`Unknown command ${JSON.stringify(prompt.split(/\s+/)[0])}. Type /help for local commands.`);
  }

async function handleMemoryCommand(host: CommandHost, prompt: string): Promise<void> {
    const memory = new ProjectMemory(host.projectContext!.stateDirectory);
    const [, action, ...args] = prompt.trim().split(/\s+/);
    let result: unknown;
    if (!action) {
      const facts = await memory.facts();
      if (!facts.length) { host.output.write("[memory] No remembered facts. /memory remember <fact> adds one; /memory outcomes lists task summaries.\n"); return; }
      result = facts;
    }
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
    host.output.write(`[memory] ${serialized}\n`);
  }

async function handleReferencesCommand(host: CommandHost, prompt: string): Promise<void> {
    if (prompt.trim() === "/references") {
      const listing = host.references!.list();
      if (!listing.sources.length && !listing.diagnostics.length) { host.output.write("[references] No reference sources configured (~/.casper/references.yaml or the profile's references.yaml).\n"); return; }
      host.output.write(`[references] ${formatReferenceResult(listing)}\n`);
      return;
    }
    const match = prompt.match(/^\/references\s+search\s+(\S+)\s+([\s\S]+)$/);
    if (!match) throw new Error("Usage: /references | /references search <source-id|*> <literal query>");
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
        confirm: (preview, signal) => host.confirmExact(`Debugger execution confirmation:\n${preview}\nAdapter and debuggee execute code; not sandboxed. Debug values may contain secrets.\n`, "Launch this exact debugger target? Type yes: ", signal),
      });
      const debug = host.debugSession;
      host.lifecycle.add({ name: "debug", close: () => debug.close() });
    }
    const result = request ? await host.debugSession.run(request, host.commandAbort?.signal)
      : { ...host.debugSession.status(), targets: await host.debugSession.targets() };
    host.output.write(`${formatTerminalJSON(result)}\n`);
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

async function handleLSPCommand(host: CommandHost, prompt: string): Promise<void> {
    const [, action, name, ...extra] = prompt.trim().split(/\s+/);
    if (action && (!name || extra.length || !["connect", "disconnect"].includes(action))) {
      throw new Error("Usage: /lsp | /lsp connect <name> | /lsp disconnect <name>");
    }
    if (action === "connect") await host.lsp!.connect(name!);
    if (action === "disconnect") await host.lsp!.disconnect(name!);
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
    });
    if (!host.closing) host.output.write(formatSubagentReport(result));
    if (result.status !== "completed") throw new Error(`Delegation ${result.status}; see the bounded report above`);
  }

async function handleMCPCommand(host: CommandHost, prompt: string): Promise<void> {
    const [, action, name, ...extra] = prompt.trim().split(/\s+/);
    const usage = "Usage: /mcp | /mcp connect <name> | /mcp disconnect <name> | /mcp reload";
    if (action === "reload") {
      if (name || extra.length) throw new Error(usage);
      if (!host.reloadMCPConfiguration) throw new Error("MCP configuration cannot be re-read in this session");
      const diff = await host.mcp!.reload(await host.reloadMCPConfiguration());
      host.output.write(`[mcp] reloaded: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed\n`);
      for (const diagnostic of host.mcp!.diagnostics) host.output.write(`[mcp] ${diagnostic}\n`);
      // A changed command/URL is a different program; consent never carries over silently.
      if (diff.changed.length) host.output.write(`[mcp] consent revoked for ${diff.changed.join(", ")}; reconnect with /mcp connect <name>\n`);
    } else if (action && (!name || extra.length || !["connect", "disconnect"].includes(action))) {
      throw new Error(usage);
    }
    if (action === "connect") await host.mcp!.connect(name!);
    if (action === "disconnect") await host.mcp!.disconnect(name!);
    const statuses = host.mcp!.status();
    host.output.write(statuses.length ? statuses.map((status) => [
      `${status.name} [${status.transport}; ${status.state}] ${status.toolCount} tools`,
      `  source: ${status.source}`,
      ...(status.error ? [`  ${status.error}`] : []),
    ].join("\n")).join("\n") + "\n" : "No MCP servers configured.\n");
    if (action === "connect" && statuses.find((status) => status.name === name)?.state !== "ready") {
      throw new Error("MCP connection failed; no tools exposed");
    }
  }


async function handleSkillsCommand(host: CommandHost, prompt: string): Promise<void> {
    const registry = host.skillRegistry!;
    const [, action, id, sha256, ...extra] = prompt.trim().split(/\s+/);
    try {
      if (!action) {
        const skills = registry.list();
        host.output.write(`${skills.length} indexed; imports: ${host.projectContext!.skills.imports?.join(", ") || "none"}\n`);
        host.output.write(skills.length ? skills.map((skill) => [
          `${skill.id} [${skill.source}; ${skill.trust}${skill.disableModelInvocation ? "; manual-only" : ""}]`,
          `  ${JSON.stringify(skill.description)}`,
          `  ${skill.filePath}`,
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
          `After reviewing: /skills trust ${id} ${inspected.sha256}`,
          "",
        ].join("\n"));
      } else if (action === "trust" && id && sha256 && !extra.length) {
        await registry.trust(id, sha256);
        host.output.write(`Trusted reviewed content for ${id}.\n`);
      } else if (action === "block" && id && !sha256) {
        await registry.block(id);
        host.output.write(`Blocked ${id} for future prompts.\n`);
      } else {
        host.output.write("Usage: /skills | /skills inspect <id> | /skills trust <id> <sha256> | /skills block <id>\n");
      }
    } catch (error) {
      host.output.write(`[skills] ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
