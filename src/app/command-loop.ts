/** The prompt loop: read a line, run it as a local command or a model task, and stop work on Ctrl+C or Esc.
 * Moved from src/app.ts. */

import { checkPastedSecrets } from "./pasted-secrets";
import type { CasperApp } from "../app";
import os from "node:os";
import { modelPreference } from "../tui/model-preference";
import type { VerificationReport } from "../verify/evidence";
import { ProcessCleanupError } from "../platform/processes";
import { SUGGESTION_COMMAND } from "./suggestions";
import { runSlashCommand } from "./commands";
import { canonicalLine, findCommand } from "../tui/commands";
import { finishTaskCleanup } from "./cleanup";
import { commandProblem } from "../tui/help";
import { newProjectFromQuestions, opened } from "./new-project";
import { runSettings } from "./settings";
import { runPreview } from "../services/preview";
import { detectWebService, isDetectedWebService } from "../services/detect";
import { redactPreview, terminalText } from "../tui/format";
import { commandFileShown, loadUserCommands, userCommandRequest } from "./user-commands";
import { leadingImagePath, startsWithImageFile } from "./images";
import { serviceManager } from "./task-tools";
import { updateFooter, loadPaneSetting, askPaneOnce, paneCommand, detailsCommand } from "./footer";
import { holdBackSteered, settleQueuedLines } from "./during-work";
import { continueWords, EARLY_ONE_WAIT_MS, offerEarlierConversation } from "./earlier-conversation";
import { copyRequest, pasteBlocks } from "./copy-words";
import { newProjectFlowWithAbort, openProjectFolder, newProjectCommand, initialProjectRequest, openWorkspaceBeforeRuntime } from "./workspace";
import { rebindWorkspace } from "./session-branches";
import { runModelTask, runSuggestion } from "./task-run";
import { parseRequestWords, withoutTranscripts } from "./request-words";
import { runTypedCommand, typedRunRequest } from "./run-words";
import { askSideQuestion, BTW_USAGE, btwQuestion, sideQuestionsOn, sideQuestionText } from "./side-question";
import { applyWeb } from "./wiring";
import { typedDuringTask } from "../tui/give-way";
import { checkSignIn, ensureRuntime } from "./runtime-start";
import { handledHere, modelChangeRequest, namesModel } from "./model-words";
import { trustCommand } from "./folder-trust";
import { trustHandledHere, trustLine, trustRequest } from "./trust-words";
import { autoModeHandledHere, autoModeRequest, setAutoMode } from "./auto-mode";
import { exportHandledHere, exportRequest, exportWordsLine } from "./export-words";
import { stopAskingRequest } from "./stop-asking-words";
import { reloadProject } from "./project-file";
import { pagesCommand } from "./pages";
import { lookCommand, lookTyped } from "./look";
import { lookWords } from "../look/commands";
import { rewind } from "./rewind";
import { readPlan, recentPlans } from "../flows/plan-store";

export async function runInteractive(app: CasperApp, cwd = process.cwd(), firstRequest?: string): Promise<void> {
  // Own the terminal before the banner so startup output is transcript, not
  // loose text a later redraw would drop.
  app.interactive = true;
  app.terminal.start();
  let workspace = cwd;
  if (firstRequest) app.queuedPrompt = firstRequest;
  const initialProject = firstRequest ? await initialProjectRequest(app, cwd, firstRequest) : undefined;
  const newProject = app.newProjectRequest ?? initialProject;
  if (newProject && (!app.projectContext || initialProject)) {
    // `casper new` on a terminal: the project first, then Casper opens there. Nothing built: no session.
    const result = await newProjectFlowWithAbort(app, (flow) => newProjectFromQuestions(flow, newProject, undefined, (text) => { app.queuedPrompt = text; }));
    if (!opened(result)) {
      if (!result && !app.closing) app.output.write("Nothing was created.\n");
      app.newProjectExitCode = result?.exitCode ?? 1;
      app.terminal.close();
      app.interactive = false;
      return;
    }
    workspace = result.dir;
    if (app.projectContext) await openWorkspaceBeforeRuntime(app, workspace);
  } else if (!app.projectContext) workspace = await openProjectFolder(app, cwd);
  if (!app.projectContext) {
    await app.start(workspace);
  }

  app.savedModelDisplay = await modelPreference(app.sessionHomeDir ?? os.homedir());
  await checkSignIn(app);
  await loadPaneSetting(app);
  updateFooter(app);
  // Looked up beside the prompt, not before it: the prompt never waits on the folder's saved conversations.
  const earlier = offerEarlierConversation(app);
  let firstLine = true;
  while (!app.closing) {
    app.cancelBeforeCommand = false;
    updateFooter(app);
    // A request typed at the empty-folder question runs first, as if typed at the prompt.
    const early = app.queuedPrompt;
    const queued = early ?? app.queuedLines.shift();
    app.queuedPrompt = undefined;
    // A queued line is a request of its own: the last receipt's row no longer applies. A line typed during work was
    // echoed (❯) on the rich terminal when it was typed, so only the plain terminal says it again as it runs.
    if (queued) { app.terminal.offerNext(undefined); if (early !== undefined || !app.terminal.rich) app.events.writePrompt(queued); }
    const line = queued ?? await app.terminal.readCommand();
    if (line === undefined) break;
    // What was pasted into the line: words Casper reads ("big model:") count only where the person typed.
    let pasted = queued === undefined ? app.terminal.takeSubmittedPastes() : app.linePastes.get(queued) ?? [];
    if (queued !== undefined) app.linePastes.delete(queued);
    if (app.cancelBeforeCommand) {
      app.output.write("[cancel] Stopped before it started; nothing ran.\n");
      continue;
    }
    let prompt = line.trim();

    if (!prompt) {
      continue;
    }
    // A lone 1 typed before the start's row showed is the row's key: wait a moment for the row, then run it.
    if (firstLine && queued === undefined && prompt === "1"
      && await Promise.race([earlier, Bun.sleep(EARLY_ONE_WAIT_MS).then(() => false)])) prompt = "/continue";
    // "continue session" as the first line, with the row offered: the same as 1. Only short lines that ask nothing else.
    else if (firstLine && queued === undefined && continueWords(prompt, pasted)
      && await Promise.race([earlier, Bun.sleep(EARLY_ONE_WAIT_MS).then(() => false)])) {
      app.output.write(`[session] "${terminalText(prompt)}" at the start: continuing that conversation, as 1 does.\n`);
      prompt = "/continue";
    }
    firstLine = false;

    // Only the command leaves: "exit" or "quit" typed without the "/" is a request like any other.
    if (prompt.startsWith("/") && findCommand(prompt)?.name === "exit") {
      break;
    }

    // A token in a pasted screen: asked about (1 Remove it · 2 Send anyway) before a model can read the line.
    if ((!prompt.startsWith("/") || /^\/btw\b/.test(prompt)) && pasted.length) {
      try { ({ line: prompt, pasted } = await checkPastedSecrets(app, prompt, pasted)); }
      catch { if (app.closing) break; continue; }
    }

    // A side question ("? what does ECONNRESET mean"): a separate answer, never part of the conversation.
    // /btw <question> is the same, and asks even with side questions off (it is typed on purpose).
    const side = btwQuestion(prompt) ?? (sideQuestionsOn(app) ? sideQuestionText(prompt, pasted) : undefined);
    if (side === "") { app.output.write(`${BTW_USAGE}\n`); continue; }
    if (side !== undefined) {
      await askSideQuestion(app, side);
      continue;
    }

    try {
      if (!prompt.startsWith("/")) await askPaneOnce(app);
      await handlePrompt(app, prompt, { pasted });
    }
    catch (error) {
      if (app.closing) break;
      app.events.ensureLineBreak();
      const message = error instanceof Error ? error.message : String(error);
      if (!app.commandAbort?.signal.aborted && app.events.lastError !== message) app.events.showError(message);
    }
    settleQueuedLines(app);
  }
  app.terminal.close();
  app.interactive = false;
}

/** `typed`: the line came from the person at the prompt (with what was pasted into it), so its words are read. */
export async function handlePrompt(app: CasperApp, prompt: string, typed?: { pasted: readonly string[] }): Promise<VerificationReport | undefined> {
  if (app.closing) return;
  if (app.commandActive) throw new Error("Another command is active; wait for active subagents or workspace transition");
  // Bare /branch only lists them.
  const transition = /^\/(?:branch\s+\S|switch(?:\s|$))/.test(prompt);
  if (transition && app.subagents.isBusy) throw new Error("Wait for active subagents before changing workspaces");
  // /receipt, /undo, /redo and /diff read the last task; every other command starts without it.
  if (!/^\/(?:receipt|undo|redo|diff)(?:\s|$)/.test(prompt)) app.lastTaskResult = undefined;
  const retainedTaskResult = app.lastTaskResult;
  app.taskRuntimeFailed = false;
  app.taskTurnLimit = undefined;
  app.taskSpendStop = undefined;
  app.events.clearError();
  app.taskRuntimeCancelled = false;
  app.commandActive = true;
  app.commandAbort = new AbortController();
  app.commandSpent = undefined;
  updateFooter(app);
  app.workspaceTransition = transition;
  let command = prompt.startsWith("/");
  let report: VerificationReport | undefined;
  app.cleanupReports = [];
  try {
    // Reserve the command first so an updater still checking cannot begin an install. An install already in
    // progress finishes before any task/check begins; it never restarts or reloads this process.
    if (app.updateWork) await app.updateWork;
    if (app.cleanupError) { app.cleanupRecovery.queue(app.cleanupError); app.cleanupError = undefined; }
    for (const source of [app.browser, app.mcp, app.lsp, app.services]) {
      if (source) app.cleanupRecovery.preflight(source);
    }
    if (app.cleanupRecovery.hasPending) await app.cleanupRecovery.resolve(app);
    // A Shift+Tab that arrived with this submit still applies; new presses see commandActive and wait.
    while (app.effortSteps > 0) await app.effortCycle;
    if (app.closing) return;
    if (app.workspaceNeedsRebind) await rebindWorkspace(app, app.activeWorkspaceRoot());
    // Whatever follows a receipt either picks one of its suggestions or leaves them (they fade when ignored).
    // Nothing on offer: no extra wait, so a close that arrives with this line still finds the command running.
    if (app.suggestions.pending) await app.suggestions.settle(prompt, app.projectContext);
    else app.suggestions.forgetChoice();
    // Pictures pasted into this line (Ctrl+V) go with it, or with nothing when it is a command.
    // A queued line typed during work brings the pictures pasted into it.
    const kept = app.lineImages.get(prompt);
    app.lineImages.delete(prompt);
    app.pastedImages = kept ?? app.terminal.takePastedImages();
    // A picture file dropped into an empty prompt starts the line with "/": that is a request, not a command.
    // Commands go straight on (no wait, so a close that arrives with the line still finds the command running).
    if (command && leadingImagePath(prompt) !== undefined) command = !await startsWithImageFile(prompt, { cwd: app.activeWorkspaceRoot() });
    // One of your own commands (a Markdown file in ~/.casper/commands): its text, with your words in it, is the request.
    const mine = command ? userCommandRequest(prompt, loadUserCommands(app.homeDir())) : undefined;
    if (mine) {
      // A file with nothing after its frontmatter would start a task with no request.
      if (!mine.text.trim()) throw new Error(`/${mine.command.name} has no text to send: ${commandFileShown(mine.command.file, app.homeDir())} is empty after its frontmatter.`);
      command = false;
      app.output.write(`[command] /${terminalText(mine.command.name)} sends ${terminalText(commandFileShown(mine.command.file, app.homeDir()))}.\n`);
      return report = await runModelTask(app, mine.text);
    }
    if (command) return report = await handleSlashCommand(app, prompt);
    // "!sudo apt update" or "let me run sudo apt update": the person's own command, in Casper's terminal now, no box
    // (src/app/run-words.ts). Only typed; a paste is an ordinary request.
    const own = typed && !app.pastedImages?.size ? typedRunRequest(prompt, typed.pasted, app.activeWorkspaceRoot()) : undefined;
    if (own) { command = true; await runTypedCommand(app, own); return report; }
    // "change model to opus 5.5": Casper changes it as /model would, with no model call (src/app/model-words.ts).
    const target = typed && !app.pastedImages?.size ? modelChangeRequest(prompt, typed.pasted) : undefined;
    if (target && await namesModel(await ensureRuntime(app), target)) {
      app.output.write(handledHere(target));
      return report = await handleSlashCommand(app, `/model ${target}`);
    }
    // "export this session to the desktop": /export, as if typed, with no model call (src/app/export-words.ts).
    const exported = typed && !app.pastedImages?.size ? exportRequest(prompt, typed.pasted) : undefined;
    if (exported) {
      const line = await exportWordsLine(app, exported);
      app.output.write(exportHandledHere(line));
      return report = await handleSlashCommand(app, line);
    }
    // "stop asking": the /permissions all box, as if typed, with no model call (src/app/stop-asking-words.ts).
    if (typed && !app.pastedImages?.size && stopAskingRequest(prompt, typed.pasted)) {
      app.output.write("[permissions] Handled here, no model call: /permissions all does the same.\n");
      return report = await handleSlashCommand(app, "/permissions all");
    }
    // "auto mode off" or "auto mode on": saved as /settings would, with no model call (src/app/auto-mode.ts).
    const auto = typed && !app.pastedImages?.size ? autoModeRequest(prompt, typed.pasted) : undefined;
    if (auto) {
      app.output.write(autoModeHandledHere(auto));
      await setAutoMode(app, auto === "on");
      return report;
    }
    // "trust this folder" or "stop trusting this folder": /trust, as if typed, with no model call (src/app/trust-words.ts).
    const trust = typed && !app.pastedImages?.size ? trustRequest(prompt, typed.pasted) : undefined;
    if (trust) {
      app.output.write(trustHandledHere(trustLine(trust)));
      return report = await handleSlashCommand(app, trustLine(trust));
    }
    // "copy that", "copy the prompt": /copy of the last answer's block, as if typed, with no model call (src/app/copy-words.ts).
    const copy = typed && !app.pastedImages?.size ? copyRequest(prompt, typed.pasted) : undefined;
    if (copy) {
      const blocks = pasteBlocks(app.lastAnswer).length;
      if (blocks > 1) { app.output.write(`[copy] The last answer has ${blocks} blocks: /copy 1 to /copy ${blocks} copies one, /copy all of it.\n`); return report; }
      const line = blocks === 1 ? "/copy 1" : "/copy";
      app.output.write(`[copy] Handled here, no model call: ${line} does the same.\n`);
      return report = await handleSlashCommand(app, line);
    }
    // "look adapt", typed without the slash: /look adapt (src/look/commands.ts lookWords). Only a line typed here; when
    // /look can't run, the line goes on to the AI below.
    const look = typed && !app.pastedImages?.size ? lookWords(prompt, typed.pasted) : undefined;
    const looked = look ? await lookTyped(app, look) : undefined;
    if (looked) return report = looked.report;
    const words = typed ? parseRequestWords(prompt, typed.pasted) : undefined;
    const asked = typed ? withoutTranscripts(prompt, typed.pasted) : undefined;
    return report = await runModelTask(app, words?.text ?? prompt, { ...(words ? { words } : {}), ...(asked !== undefined ? { asked } : {}),
      ...(typed ? { pasted: typed.pasted } : {}),
      ...(app.planMode ? { planFirst: true } : {}) });
  } catch (error) {
    if (error instanceof ProcessCleanupError) app.cleanupRecovery.queue(error);
    else throw error;
  } finally {
    try {
      await finishTaskCleanup(app, !command);
    } finally {
      // Recovery belongs to this command, not a historical task it only read or restored.
      if (app.cleanupReports.length && (!retainedTaskResult || app.lastTaskResult !== retainedTaskResult)) {
        app.lastTaskResult ??= { execution: "completed", ...(report ? { verification: report } : {}) };
        app.lastTaskResult.cleanup = [...app.cleanupReports];
      }
      // With the task's checks: the service tool must not record into them from a later, non-task prompt.
      app.checkTask = undefined;
      app.smokeTask = undefined;
      app.pageTask = undefined;
      app.taskEdits = undefined;
      app.commandActive = false;
      app.workspaceTransition = false;
      updateFooter(app);
    }
  }
}

/** Local command dispatch moved to app/commands.ts; the app is the command host. */
export function handleSlashCommand(app: CasperApp, typed: string): Promise<VerificationReport | undefined> {
  // One table (src/tui/commands.ts) knows every command and which take words after the name.
  const problem = commandProblem(typed);
  if (problem) return Promise.reject(new Error(problem));
  // The handlers below match command names: an alias (/cost, /config, /new) runs as its command.
  const prompt = canonicalLine(typed);
  if (/^\/pane(?:\s|$)/.test(prompt)) return paneCommand(app, prompt.slice(5).trim()).then(() => undefined);
  if (/^\/trust(?:\s|$)/.test(prompt)) return trustCommand(app, prompt.slice(6).trim()).then(() => undefined);
  if (/^\/details(?:\s|$)/.test(prompt)) return detailsCommand(app, prompt.slice(8).trim()).then(() => undefined);
  if (/^\/settings(?:\s|$)/.test(prompt)) return settingsCommand(app, prompt.slice(9).trim() || undefined).then(() => undefined);
  if (prompt.trim() === "/theme") return settingsCommand(app, "Theme").then(() => undefined);
  if (/^\/pages(?:\s|$)/.test(prompt)) return pagesCommand(app, prompt.slice(6).trim()).then(() => undefined);
  if (/^\/preview(?:\s|$)/.test(prompt)) return previewCommand(app, prompt.slice(8).trim()).then(() => undefined);
  if (/^\/look(?:\s|$)/.test(prompt)) return lookCommand(app, prompt.slice(5).trim());
  const newProject = /^\/project\s+new(?:\s+([\s\S]*))?$/.exec(prompt.trim());
  if (newProject) return newProjectCommand(app, (newProject[1] ?? "").trim()).then(() => undefined);
  if (/^\/suggestions(?:\s|$)/.test(prompt)) {
    return app.suggestions.command(prompt.slice(12).trim(), app.projectContext).then((text) => { app.output.write(text); return undefined; });
  }
  const btw = btwQuestion(prompt);
  if (btw !== undefined) { if (btw) return askSideQuestion(app, btw).then(() => undefined); app.output.write(`${BTW_USAGE}\n`); return Promise.resolve(undefined); }
  if (prompt.startsWith(`${SUGGESTION_COMMAND} `) || prompt === SUGGESTION_COMMAND) return runSuggestion(app, prompt.slice(SUGGESTION_COMMAND.length).trim());
  const undoCommand = /^\/(undo|redo|diff|receipt)(?:\s+(.*))?$/.exec(prompt);
  if (undoCommand) return runUndoCommand(app, undoCommand[1] as "undo" | "redo" | "diff" | "receipt", (undoCommand[2] ?? "").trim());
  if (/^\/rewind(?:\s|$)/.test(prompt)) {
    return rewind({ output: app.output, terminal: app.terminal, interactive: app.interactive, liveSession: app.session, taskUndo: app.taskUndo },
      prompt.slice(7).trim(), app.commandAbort?.signal).then(() => undefined);
  }
  if (/^\/plan(?:\s|$)/.test(prompt)) {
    const request = prompt.slice(5).trim();
    if (!request) return reopenPlan(app);
    // `/plan on` keeps planning on for every request until `/plan off`; the footer says PLAN while it is.
    if (request === "on" || request === "off") {
      app.planMode = request === "on";
      app.output.write(app.planMode ? "[plan] Plan mode on: every request gets a plan first. /plan off ends it.\n" : "[plan] Plan mode off.\n");
      updateFooter(app);
      return Promise.resolve(undefined);
    }
    return runModelTask(app, request, { planFirst: true });
  }
  return runSlashCommand(app, prompt);
}

async function reopenPlan(app: CasperApp): Promise<VerificationReport | undefined> {
  let plans;
  try { plans = await recentPlans(app.activeWorkspaceRoot()); }
  catch { app.output.write("[plan] Could not read recent plans.\n"); return; }
  if (!plans.length) {
    app.output.write("Type /plan and then what you want, for example /plan add a --verbose flag to the CLI; the model plans first and nothing is built until you choose Build.\n"); return;
  }
  app.output.write("Recent plans\n");
  if (!app.interactive || !app.terminal.canAsk) {
    plans.forEach((saved, i) => app.output.write(`${i + 1}. ${terminalText(saved.plan.title ?? saved.request)} · ${terminalText(saved.file.split(/[\\/]/).at(-1)!)}\n`));
    return;
  }
  const choice = await app.terminal.pick("Reopen a plan?", [{ label: "Stop", description: "nothing is built" }, ...plans.map((saved, i) => ({ label: `${i + 1}. ${saved.plan.title ?? saved.request}`, description: saved.file.split(/[\\/]/).at(-1) }))], app.commandAbort?.signal);
  const picked = plans.find((saved, i) => choice === `${i + 1}. ${saved.plan.title ?? saved.request}`);
  if (picked) {
    try {
      const current = await readPlan(app.activeWorkspaceRoot(), picked.file);
      return runModelTask(app, current.request, { planFirst: true, savedPlan: current });
    } catch { app.output.write("[plan] Could not reopen the saved plan; nothing was built.\n"); }
  }
}

/** /undo, /redo, /diff and /receipt. With no task in this folder yet, /diff shows git's view and /receipt the
 * session's last task, as before. */
export async function runUndoCommand(app: CasperApp, command: "undo" | "redo" | "diff" | "receipt", argument: string): Promise<undefined> {
  const signal = app.commandAbort?.signal;
  if (command === "undo" || command === "redo") {
    await app.taskUndo[command](argument, signal);
    // A one-shot run's receipt (--json) names the files undo or redo changed; nothing checked them.
    if (!app.interactive && app.taskUndo.lastRestored.length) app.lastTaskResult = { execution: "completed", changedPaths: [...app.taskUndo.lastRestored] };
  }
  else if (command === "diff") { if (!(await app.taskUndo.diff(argument, signal))) await runSlashCommand(app, "/diff"); }
  else if (!argument && app.lastTaskResult) await runSlashCommand(app, "/receipt");
  else if (!(await app.taskUndo.receipt(argument))) await runSlashCommand(app, "/receipt");
  return undefined;
}

/** /settings: grouped switches; a change is written to ~/.casper/config.yaml and applies from now on.
 * `only` (/theme): that one row's question. */
export function settingsCommand(app: CasperApp, only?: string): Promise<void> {
  return runSettings({
    output: app.output, homeDir: () => app.homeDir(), canAsk: app.interactive && app.terminal.canAsk, duringTask: typedDuringTask(),
    context: async () => app.projectContext, mcp: () => app.mcp, picker: () => app.terminal.exclusiveHost(),
    reload: async () => {
      const before = app.projectContext;
      if (!before) return;
      try { await reloadProject(app, { own: true }); } catch { return; }
      if (!app.projectContext) return;
      // Web lookups are made again only when their settings changed. A running task's web tools keep the old lookup
      // (it closes when Casper quits), so changing the theme mid-task never stops the task's web lookups.
      if (JSON.stringify(app.projectContext.web) !== JSON.stringify(before.web)) applyWeb(app, app.projectContext, { keepOld: typedDuringTask() });
      // A new default for the work shown replaces this session's /details choice.
      if (app.projectContext.display !== before.display) app.displayChoice = undefined;
    },
    ask: (question, options, signal) => app.terminal.pick(question, options, signal),
  }, app.commandAbort?.signal, only);
}

/** /preview [stop]: the web app on your network, and a public link only after a numbered yes. No model call. */
export async function previewCommand(app: CasperApp, args: string): Promise<void> {
  const context = app.projectContext;
  return runPreview({
    output: app.output, canAsk: app.interactive && app.terminal.canAsk,
    ask: (question, options, signal) => app.terminal.pick(question, options, signal),
    manager: () => serviceManager(app),
    webService: async () => {
      const found = context ? await detectWebService(app.activeWorkspaceRoot(), { frameworks: context.model.frameworks,
        packageManager: context.model.packageManager, services: context.services ?? {} }).catch(() => undefined) : undefined;
      if (isDetectedWebService(found)) return { spec: found.spec, label: redactPreview(terminalText(found.label)).slice(0, 120) };
      return { reason: found?.reason ? `Can't start the web app: ${found.reason}` : "Casper found no web app here to preview. Ask Casper to build one, or to start yours." };
    },
  }, args, app.commandAbort?.signal);
}

export function cancelCurrent(app: CasperApp): void {
  if (!app.commandActive && app.sideAbort) { app.sideAbort.abort(); return; }
  if (!app.commandActive) { app.cancelBeforeCommand = true; return; }
  if (app.commandAbort?.signal.aborted) return;
  // First, before any tool or request is aborted: an aborted step would add a waiting line to the conversation.
  holdBackSteered(app);
  app.commandAbort?.abort();
  app.taskRuntimeCancelled = true;
  void app.lifecycle.close("debug").catch(() => {});
  void app.lifecycle.close("browser").catch(() => {});
  app.verificationAbort?.abort(); app.checkTask?.abort(); app.visualizationAbort?.abort();
  void app.session?.abort().catch(() => {});
  app.terminal.endAssistant();
  app.output.write("[cancel] Stopping. Changes made so far stay as they are.\n");
}

export function writePrompt(app: CasperApp, prompt: string): void {
  app.events.writePrompt(prompt);
}
