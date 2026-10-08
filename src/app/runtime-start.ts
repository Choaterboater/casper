/** Starting the model runtime: one adapter for sign-in and the session, the conversation from --continue or
 * --resume, the --model and --effort of this run, and what each file edit tells the checks. Moved from src/app.ts. */

import { rememberTool } from "./side-question";
import type { CasperApp } from "../app";
import path from "node:path";
import { hasSignIn } from "../tui/model-preference";
import { formatRuntimeStartLine } from "../tui/format";
import { boundCapabilityResult } from "../capabilities/result";
import { hiddenSecretGate } from "../secrets/gate";
import { fileChangeTool } from "../runtime/observation";
import { scrubToolOutput } from "../secrets/tool-output";
import type { AgentRuntime, RuntimeSession, RuntimeShell } from "../runtime/types";
import { planToolGate } from "../flows/plan";
import { AGENT_DIR_ENV, casperAgentDir } from "../runtime/agent-store";
import { systemPromptAppend } from "./prompt";
import { UsageError } from "../cli-args";
import { sessionStartEvent } from "./json-events";
import { CASPER_VERSION } from "../version";
import { editGateReason } from "./approvals";
import { networkLoginFile } from "./network-host";
import { updateFooter } from "./footer";
import { spendNote, spendGate } from "./spend-gate";
import { ensureSessionWorkspace } from "./session-branches";
import { projectPrivatePaths } from "./wiring";

/** One adapter-construction owner, shared by auth and session startup. */
export function acquireRuntime(app: CasperApp): Promise<AgentRuntime> {
  if (!app.runtimeLoad) app.runtimeLoad = Promise.resolve().then(async () => {
    if (app.closing) throw new Error("Casper is closing");
    app.runtime = await app.runtimeFactory();
    if (app.closing) throw new Error("Casper is closing");
    return app.runtime;
  }).catch((error) => { if (!app.closing) app.runtimeLoad = undefined; throw error; });
  return app.runtimeLoad;
}

export async function ensureRuntime(app: CasperApp): Promise<RuntimeSession> {
  if (app.closing) throw new Error("Casper is closing");
  if (app.session) return app.session;
  if (!app.runtimeStart) {
    const context = app.projectContext!;
    // Record the whole load/start operation before invoking the factory, so
    // close() also drains a lazy SDK import and prevents post-shutdown start.
    app.runtimeStart = Promise.resolve().then(async () => {
      if (app.closing) throw new Error("Casper is closing");
      app.runtime = await acquireRuntime(app);
      if (app.closing) throw new Error("Casper is closing");
      app.session = await app.runtime.start({
        cwd: context.info.root,
        tools: app.runtimeTools,
        afterFileEdit: async (file, signal) => {
          observeEdit(app, file);
          const reports = await app.lsp!.afterEdit(file, signal);
          if (!reports.length) return undefined;
          // Diagnostics quote source, so they get the same scrub as the lsp tool's own results.
          const json = JSON.stringify(boundCapabilityResult(reports));
          const scrubbed = await scrubToolOutput(app.scrubber, "lsp", {}, [json], signal, { networkLoginFile: networkLoginFile(app) });
          return `LSP diagnostics after edit: ${scrubbed?.texts[0] ?? json}${scrubbed?.note ? ` (${scrubbed.note})` : ""}\nRepair new errors before continuing; unavailable or unversioned reports are not proof of a clean file.`;
        },
        systemPromptAppend: systemPromptAppend(context),
        // A plan turn refuses every tool but reading, whatever the tool says about itself.
        beforeToolGate: (toolName, input) => (app.planning ? planToolGate(toolName, input) : undefined)
          ?? hiddenSecretGate(toolName, input)
          ?? ((changes) => changes ? editGateReason(app, changes) : undefined)(fileChangeTool(toolName, input)),
        // At the spend pause the next tool call waits for the answer (Stop here is the Enter choice).
        beforeToolWait: (_toolName, signal) => spendGate(app, signal),
        // Config files and config-looking command output (/secrets files off stops these for this
        // session), plus .env, credential files and secret env values (always).
        scrubToolOutput: (toolName, input, texts, signal) => scrubToolOutput(app.scrubber, toolName, input, texts, signal, { configs: app.scrubFiles, networkLoginFile: networkLoginFile(app) }),
        // The conversation outlives a workspace rebind, so it holds a facade that follows the current shell.
        ...(app.shell ? { shell: currentShell(app) } : {}),
        ...(context.cache ? { cache: context.cache } : {}),
        // The project's sandbox.denyRead (GreenCLI lists its data and log folders there): the file tools refuse them too.
        privatePaths: projectPrivatePaths(app),
        currentPrivatePaths: () => projectPrivatePaths(app),
      });
      // An interactive start reopens the conversation its named session holds (/clear, /resume and /branch keep it).
      // A one-shot run starts its own: only --continue and --resume pick a saved conversation for it.
      if (app.interactive) {
        const resumeNotice = await (await ensureSessionWorkspace(app)).resumeActive(app.session);
        if (resumeNotice) app.output.write(`[sessions] ${resumeNotice}\n`);
      }
      await applyRunConversation(app, app.session);
      await applyRunSelection(app, app.session);
      app.unsubscribe = app.session.subscribe(event => {
        if (event.type === "tool_start") rememberTool(app, event.toolName);
        if (event.type === "tool_start" && event.toolName === "casper_check") app.modelCheckCalls++;
        if (event.type === "tool_end" && event.toolName === "casper_check") app.modelCheckCalls = Math.max(0, app.modelCheckCalls - 1);
        app.observations.observeUsage(event);
        if (event.type === "assistant_response_end") spendNote(app);
        if (event.type === "assistant_response_start") app.responseText = "";
        else if (event.type === "assistant_text_delta") app.responseText = (app.responseText + event.delta).slice(-65_536);
        else if (event.type === "assistant_response_end" && app.responseText.trim()) app.lastAnswer = app.responseText;
        app.events.handle(event);
        if (app.onEvent) for (const mapped of app.eventMapper.map(event)) app.onEvent(mapped);
      });
      if (app.onEvent) {
        let conversation: string | undefined;
        try { conversation = app.session.getSessionInfo?.().sessionId; } catch { /* no persistence: no ID */ }
        app.onEvent(sessionStartEvent({ casper: CASPER_VERSION, cwd: context.info.root, session: conversation, status: app.session.getStatus?.() }));
      }
      const status = app.session.getStatus?.() ?? { auth: "unknown" as const };
      if (!status.blocked) app.output.write(`${formatRuntimeStartLine(status)}\n`);
      updateFooter(app);
      return app.session;
    }).catch(async (error) => {
      if (!app.closing) {
        const failedRuntime = app.runtime;
        app.runtime = undefined;
        app.runtimeLoad = undefined;
        app.session = undefined;
        await failedRuntime?.dispose().catch(() => {});
      }
      throw error;
    }).finally(() => {
      if (!app.session) app.runtimeStart = undefined;
    });
  }
  return app.runtimeStart;
}

/** `--continue`/`--resume` pick a saved conversation of this workspace before the first request.
 * Applied once: a later runtime restart keeps whatever conversation is active by then. Like
 * /resume, an interactive session binds its named session to the conversation; a one-shot run
 * does not, so it never changes what later runs open. */
export async function applyRunConversation(app: CasperApp, session: RuntimeSession): Promise<void> {
  const request = app.runConversation;
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
  app.runConversation = undefined;
  if (!target) { app.output.write("[session] No earlier conversation in this workspace; starting a new one.\n"); return; }
  let current: string | undefined;
  try { current = session.getSessionInfo?.().sessionId; } catch { /* no persistence */ }
  if (target !== current) {
    await session.resumeConversation(target, { keepUnwritten: false });
    if (app.interactive && session.getSessionInfo) await (await ensureSessionWorkspace(app)).rememberConversation(session);
  }
  app.output.write(`[session] Continuing conversation ${target}.\n`);
}

/** `--model`/`--effort` select for this conversation only (persist: false), before any request.
 * A selector or level the catalog rejects is a usage error; missing credentials are not. */
export async function applyRunSelection(app: CasperApp, session: RuntimeSession): Promise<void> {
  const flagError = (flag: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return /^(?:Credential|Not signed in to|No key for|\S+ at \S+ needs an apiKey line)/.test(message) ? new Error(message) : new UsageError(`${flag}: ${message}`);
  };
  if (app.runModel) {
    if (!session.selectModel) throw new UsageError("--model: this runtime does not support model selection.");
    let selected: boolean;
    try { selected = (await session.selectModel({ query: app.runModel, persist: false })).selected; }
    catch (error) { throw flagError("--model", error); }
    if (!selected) throw new UsageError(`--model: Unknown model "${app.runModel}". Run casper /model to list models.`);
  }
  if (app.runEffort) {
    if (!session.setEffort) throw new UsageError("--effort: this runtime does not support effort controls.");
    try { await session.setEffort(app.runEffort, false); }
    catch (error) { throw flagError("--effort", error); }
  }
}

export function observeEdit(app: CasperApp, path: string): void {
  if (app.taskEdits) app.taskEdits.edited = true;
  app.browser?.invalidate();
  app.services?.markEdited(path);
  (app.checkTask ?? app.verificationTask)?.invalidateForEdit(path);
  app.observations.recordEdit(path);
}

/** Whether any sign-in exists yet, for the banner and footer only. */
export async function checkSignIn(app: CasperApp): Promise<void> {
  app.signedIn = await hasSignIn(appAgentDir(app));
}

/** Casper's state folder for this session: its login and saved conversations. */
export function appAgentDir(app: CasperApp): string {
  return app.sessionHomeDir ? path.join(app.sessionHomeDir, ".casper", "agent")
    : process.env[AGENT_DIR_ENV] && process.env[AGENT_DIR_ENV] !== "undefined" ? process.env[AGENT_DIR_ENV]! : casperAgentDir();
}

/** A shell for the conversation that always forwards to the app's current shell: after /branch or /switch the
 * workspace gets a new sandbox, and the old one (closed) must not be the one a running conversation keeps using. */
export function currentShell(app: CasperApp): RuntimeShell {
  // The shell that wrapped a command gets its finished/refused, even if a switch replaced app.shell meanwhile.
  const wrappedBy = new Map<string, RuntimeShell>();
  return {
    get keepEnv() { return app.shell?.keepEnv ?? []; },
    wrap: async (command, cwd) => {
      const shell = app.shell;
      if (!shell) return { command };
      const wrapped = await shell.wrap(command, cwd);
      if (wrapped.id) wrappedBy.set(wrapped.id, shell);
      return wrapped;
    },
    finished: (id) => { const shell = wrappedBy.get(id); wrappedBy.delete(id); shell?.finished?.(id); },
    // refused() is followed by finished() for the same command, so only finished() forgets which shell wrapped it.
    refused: async (id, output) => wrappedBy.get(id)?.refused?.(id, output),
    approve: async (command, signal, options) => app.shell?.approve?.(command, signal, options),
    outsideWrite: async (absolute) => app.shell?.outsideWrite?.(absolute),
    wroteOutside: (absolute) => app.shell?.wroteOutside?.(absolute),
    logDir: async () => app.shell?.logDir?.(),
  };
}
