/** Opening a workspace: the project, its skills, the shell sandbox, MCP servers with their approval broker, LSP,
 * references, web lookups and the startup notes. No connection or model starts here. Moved from src/app.ts. */

import type { CasperApp } from "../app";
import os from "node:os";
import { resolveEntry } from "../sandbox/policy";
import path from "node:path";
import { terminalText } from "../tui/format";
import { ReferenceLibrary } from "../references/library";
import { LSPManager } from "../lsp/manager";
import { MCPManager } from "../mcp/manager";
import { ConsentStore } from "../mcp/consent";
import { CapabilityBroker } from "../capabilities/broker";
import type { ProjectContext } from "../project/context";
import { describeChecksPlan, hasChecks } from "../verify/mode";
import { VisualizationRouter } from "../visualize/router";
import { DEFAULT_WEB } from "../config/load";
import { casperAgentDir } from "../runtime/agent-store";
import { loginValuesFrom, WebLookup, webProvider } from "../web/lookup";
import { refreshUpdateCheck, updateChecksOff, updateNotice } from "../update/notice";
import { createSessionSandbox, runtimeShell, type SandboxHost } from "./sandbox";
import { forgetSshSecrets } from "../ssh/login";
import { withLoginDisplay } from "../tui/login";
import { NO, YES_ONCE, YES_SESSION } from "./safe-choices";
import { useSandbox, currentSandbox } from "../sandbox/manager";
import { SandboxStore } from "../sandbox/store";
import { loginMissingAnswer } from "../mcp/network/ask-login";
import { loginFile } from "../mcp/network/logins";
import { confirmCapability, confirmKind, answerServerQuestion, oneAtATime } from "./approvals";
import { networkLoginHost, ownSecretValues } from "./network-host";
import { updateFooter } from "./footer";
import { checksPlan } from "./verification";
import { mcpServerSandbox } from "../mcp/sandbox";
import { trustProjectFile } from "./project-file";
import { addToPath, keepEngineFromFetchingRipgrep } from "../security/ripgrep";

/** What the sandbox asks through: Casper's own numbered question, only while someone can answer it. Its questions
 * wait their turn in the approval queue, so two at once are both asked and a question nobody saw is never a No. */
export function sandboxHost(app: CasperApp): SandboxHost {
  return {
    canAsk: () => app.interactive && app.terminal.canAsk && !app.closing,
    pick: (question, options, signal, settings) => {
      const stop = signal ?? app.commandAbort?.signal;
      return oneAtATime(app, async () => app.closing ? undefined : app.terminal.pick(question, options, stop, settings?.record ? { record: settings.record } : {}));
    },
    write: (text) => { if (!app.closing) app.output.write(text); },
    planning: () => app.planning,
    // Only while a person can answer: a one-shot or --json run never stops asking this way (it refuses, or takes --no-sandbox).
    stopAsking: () => app.stopAsking && app.interactive && app.terminal.canAsk && !app.closing,
    labHosts: () => app.projectContext?.lab?.hosts ?? [],
    // ssh asks for a password: Casper's own numbered question, then its own hidden box (never "The AI asks"). Both in
    // the one turn of the approval queue, so nothing slips in between.
    ssh: {
      canTypePrivately: () => app.interactive && app.terminal.canAsk && !app.closing && !!app.terminal.exclusiveHost(),
      write: (text) => { if (!app.closing) app.output.write(text); },
      ask: ({ question, label, canKeep }, signal) => oneAtATime(app, async () => {
        if (app.closing) return undefined;
        const answer = await app.terminal.pick(question, [
          { label: NO, description: "ssh gets no password and the login fails" },
          { label: YES_ONCE, description: "type it now; Casper forgets it when this connection ends" },
          ...(canKeep ? [{ label: YES_SESSION, description: "type it now; Casper keeps it in memory for this login until you quit" }] : []),
        ], signal);
        if (answer === undefined) return undefined;
        if (answer !== YES_ONCE && answer !== YES_SESSION) return "no" as const;
        const picker = app.terminal.exclusiveHost();
        if (!picker) return undefined;
        const secret = await picker.run((io) => withLoginDisplay(io, signal, (display) => display.privateInput(label, undefined, {
          title: "Enter ssh password", password: true,
          hint: "It goes to ssh only. The AI never sees it, and Casper never saves it." }))).catch(() => undefined);
        // Esc or Ctrl+C in the hidden box is a No.
        return secret === undefined ? "no" as const : { secret, keep: answer === YES_SESSION ? "session" as const : "once" as const };
      }),
    },
  };
}

/** Load all workspace metadata before publishing it. No connections or model startup. */
export async function loadWorkspace(app: CasperApp, cwd: string) {
  const project = await app.inspectProjectFn(cwd);
  const context = await app.loadProjectContextFn(project);
  const [registry, mcpConfiguration, lspConfiguration, referenceConfiguration] = await Promise.all([
    app.loadSkillRegistryFn(context),
    app.loadMCPConfigurationFn(context),
    app.loadLSPConfigurationFn(context),
    app.loadReferenceConfigurationFn(context),
  ]);
  if (app.closing) throw new Error("Casper is closing");
  app.references = new ReferenceLibrary(referenceConfiguration, { secretValues: () => ownSecretValues(app) });
  app.projectContext = context;
  trustProjectFile(app, context);
  // The shell sandbox for this session: the AI's bash, checks, services, dev servers and Casper's tool runs.
  // A workspace switch replaces it: the old one stops first (the sandbox runtime is one per process).
  await app.lifecycle.close("sandbox").catch(() => {});
  // ripgrep: the sandbox (Linux) and the AI's grep tool need it. One on your PATH is used; otherwise the copy inside the
  // release program is unpacked (no download), or Casper's pinned copy is fetched once (tools.downloads: off stops only that). The copy goes at the end of PATH for the grep tool.
  const ripgrep = await app.ripgrep?.({ homeDir: app.sessionHomeDir ?? os.homedir(), agentDir: casperAgentDir(), downloads: context.toolDownloads !== false,
    write: (text) => { if (!app.closing) app.output.write(text); } }).catch(() => undefined);
  if (ripgrep && (ripgrep.source === "pinned" || ripgrep.source === "embedded" || ripgrep.source === "installed")) addToPath(process.env, path.dirname(ripgrep.path));
  // No usable ripgrep: the engine's grep tool must not fetch its own unchecked copy (see keepEngineFromFetchingRipgrep).
  if (app.ripgrep) {
    const note = keepEngineFromFetchingRipgrep(process.env, ripgrep);
    if (note && !app.closing) app.output.write(note);
  }
  const host = sandboxHost(app);
  const sandbox = app.sandbox = createSessionSandbox(host, context, { root: () => app.activeWorkspaceRoot(), home: app.sessionHomeDir ?? os.homedir(),
    noSandbox: app.noSandbox, ...(app.allow ? { allow: app.allow } : {}), ...(app.sandboxSeams ? { seams: app.sandboxSeams } : {}),
    // Off unless your config turns it on, where a person can answer the AI shell's questions. A one-shot or --json
    // run can't ask, so it keeps the sandbox where one runs, as before.
    offByDefault: app.interactive });
  app.shell = runtimeShell(host, sandbox, new SandboxStore(context.stateDirectory), { on: () => app.projectContext?.sshLogin !== false });
  useSandbox(sandbox);
  app.lifecycle.add({ name: "sandbox", close: async () => {
    if (currentSandbox() === sandbox) useSandbox(undefined);
    await app.shell?.close(); await sandbox.close();
  } });
  app.skillRegistry = registry;
  // Remembered approval (keyed hashes only). A damaged or missing file means Casper asks again.
  const consent = new ConsentStore(app.sessionHomeDir ?? os.homedir());
  await consent.load().catch(() => {});
  app.mcpConsent = consent;
  app.mcp = new MCPManager(mcpConfiguration, {
    consent,
    // Casper's network server starts with the logins saved in ~/.casper/network-logins.json.
    homeDir: app.sessionHomeDir ?? os.homedir(),
    elicit: (question, signal) => answerServerQuestion(app, question, signal),
    onNote: (text) => { if (!app.closing) app.output.write(`${text}\n`); },
    sandbox: mcpServerSandbox(app.sessionHomeDir ?? os.homedir(), sandbox, () => [app.activeWorkspaceRoot()], (line) => { if (!app.closing) app.output.write(`${line}\n`); }),
  });
  // Re-reads the same layered files the manager was built from; the manager diffs them.
  app.reloadMCPConfiguration = () => app.loadMCPConfigurationFn(context);
  app.lsp = new LSPManager(context.info.root, lspConfiguration);
  app.visualization = new VisualizationRouter({ providers: app.visualizationProviders, settings: context.visualize, workspaceRoot: context.info.root });
  // Every server starts with writes off; only the user turns them on (/mcp writes <name>).
  app.broker = new CapabilityBroker(app.mcp, (call, signal) => confirmCapability(app, call, signal), { writesGate: true, scrubber: app.scrubber,
    secretValues: () => ownSecretValues(app),
    onSessionCovered: (server, tool) => { if (!app.closing) app.output.write(`[approval] allowed (this session): ${terminalText(server)} · ${terminalText(tool)}\n`); },
    // An MCP change is treated like a shell command: it may change the project's files (or a service's), so later
    // checks are not "before the change", services restart, and the tree is compared to tell.
    onChangeCall: (server) => {
      app.taskChangeServers.add(server);
      app.services?.markEdited();
      if (app.taskEdits) app.taskEdits.shell = true;
      app.observations.recordChangeCall();
    },
    confirmKind: (ask, signal) => confirmKind(app, ask, signal),
    onAllowAll: (server, tool) => {
      app.taskChangeServers.add(server);
      if (!app.closing) app.output.write(`[approval] allowed (allow all): ${terminalText(server)} · ${terminalText(tool)}\n`);
    },
    onAllowAllStart: () => updateFooter(app),
    // A product with no login: the person is asked (never the AI); the AI gets one line back.
    onLoginMissing: (server, product, _signal, trouble) => loginMissingAnswer(networkLoginHost(app), server, product, trouble) });
  app.lifecycle.add({ name: "references", close: () => app.references!.close() });
  applyWeb(app, context);
  app.lifecycle.add({ name: "mcp", close: () => app.broker!.close() });
  app.lifecycle.add({ name: "lsp", close: () => app.lsp!.close() });
  return { project, context, registry, mcp: app.mcp, visualization: app.visualization, lspConfiguration, referenceConfiguration };
}

/** Web lookups never ask: the checks in src/web/url.ts hold instead. Off only with your own setting (/settings).
 * `keepOld`: a running task's tools still use the old lookup; it closes with the session instead of now. */
export function applyWeb(app: CasperApp, context: ProjectContext, options: { keepOld?: boolean } = {}): void {
  if (!options.keepOld) app.web?.close();
  const web = context.web ?? DEFAULT_WEB;
  const loginFile = path.join(casperAgentDir(), "auth.json");
  app.web = web.enabled ? new WebLookup({ provider: webProvider(web, loginFile), loginValues: loginValuesFrom(loginFile), ...app.webSeams }) : undefined;
  const lookup = app.web;
  if (lookup) app.lifecycle.add({ name: "web", close: async () => lookup.close() });
}

/** After /references add: the reference files read again; the next task's search tool uses them, and the old
 * library (and any tool that captured it) is closed. */
export async function reloadReferences(app: CasperApp): Promise<void> {
  if (!app.projectContext || app.closing) return;
  const configuration = await app.loadReferenceConfigurationFn(app.projectContext);
  if (app.closing) return;
  const old = app.references;
  app.references = new ReferenceLibrary(configuration, { secretValues: () => ownSecretValues(app) });
  await old?.close();
}

/** Skills indexed again from the same settings, after /pack add or /pack remove. */
export async function reloadSkills(app: CasperApp): Promise<void> {
  if (!app.projectContext || app.closing) return;
  const registry = await app.loadSkillRegistryFn(app.projectContext);
  if (!app.closing) app.skillRegistry = registry;
}

/** The project's sandbox.denyRead as absolute paths, resolved like the shell sandbox does (from the session's folder). */
export function projectPrivatePaths(app: CasperApp): string[] {
  if (!app.projectContext) return [];
  const root = app.activeWorkspaceRoot();
  return (app.projectContext.sandbox?.project.denyRead ?? []).map((entry) => resolveEntry(entry, root, app.sessionHomeDir ?? os.homedir()));
}

export function reportSkillWarnings(app: CasperApp): void {
  const warnings = app.skillRegistry!.diagnostics.filter((warning) => !app.reportedSkillWarnings.has(warning));
  if (!warnings.length) return;
  for (const warning of warnings) app.reportedSkillWarnings.add(warning);
  app.output.write(`[skills] ${warnings.length} new warning${warnings.length === 1 ? "" : "s"}; use /skills diagnostics\n`);
}

/** The banner's checks line; none when there is nothing to check yet and checking is on (/status still says it). */
export async function bannerChecks(app: CasperApp, context: ProjectContext): Promise<{ checks?: string }> {
  const plan = await checksPlan(app, context);
  return plan.mode === "off" || hasChecks(plan) ? { checks: describeChecksPlan(plan) } : {};
}

/** A session (never a one-shot run) says when a newer Casper is out, from the last check, then checks again in the
 * background at most once a day. Off with `updates: false`, CASPER_NO_UPDATE_CHECK=1 or CI. */
export async function reportNewerCasper(app: CasperApp, context: ProjectContext): Promise<void> {
  if (!app.updateCheck || context.updates === false || updateChecksOff(process.env)) return;
  const options = { ...app.updateCheck, stateDir: path.join(app.sessionHomeDir ?? os.homedir(), ".casper"), signal: app.updateCheckAbort.signal };
  const line = await updateNotice(options).catch(() => undefined);
  if (line) app.output.write(`[update] ${line}\n`);
  void refreshUpdateCheck(options);
}
