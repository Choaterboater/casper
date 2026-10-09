/** The prompt loop: read a line, run it as a local command or a model task, and stop work on Ctrl+C or Esc.
 * Moved from src/app.ts. */

import type { CasperApp } from "../app";
import os from "node:os";
import { modelPreference } from "../tui/model-preference";
import type { VerificationReport } from "../verify/evidence";
import { ProcessCleanupError } from "../platform/processes";
import { SUGGESTION_COMMAND } from "./suggestions";
import { runSlashCommand } from "./commands";
import { canonicalLine, findCommand, runsAfterCleanupError } from "../tui/commands";
import { commandProblem } from "../tui/help";
import { newProjectFromQuestions, opened } from "./new-project";
import { runSettings } from "./settings";
import { runPreview } from "../services/preview";
import { detectWebService, isDetectedWebService } from "../services/detect";
import { redactPreview, terminalText } from "../tui/format";
import { leadingImagePath, startsWithImageFile } from "./images";
import { serviceManager } from "./task-tools";
import { updateFooter, loadPaneSetting, askPaneOnce, paneCommand, detailsCommand } from "./footer";
import { settleQueuedLines } from "./during-work";
import { newProjectFlowWithAbort, openProjectFolder, newProjectCommand } from "./workspace";
import { rebindWorkspace } from "./session-branches";
import { runModelTask, runSuggestion } from "./task-run";
import { parseRequestWords } from "./request-words";
import { askSideQuestion, BTW_USAGE, btwQuestion, sideQuestionsOn, sideQuestionText } from "./side-question";
import { applyWeb } from "./wiring";
import { typedDuringTask } from "../tui/give-way";
import { checkSignIn, ensureRuntime } from "./runtime-start";
import { handledHere, modelChangeRequest, namesModel } from "./model-words";
import { reloadProject } from "./project-file";

export async function runInteractive(app: CasperApp, cwd = process.cwd()): Promise<void> {
  // Own the terminal before the banner so startup output is transcript, not
  // loose text a later redraw would drop.
  app.interactive = true;
  app.terminal.start();
  let workspace = cwd;
  if (!app.projectContext && app.newProjectRequest) {
    // `casper new` on a terminal: the project first, then Casper opens there. Nothing built: no session.
    const result = await newProjectFlowWithAbort(app, (flow) => newProjectFromQuestions(flow, app.newProjectRequest!, undefined, (text) => { app.queuedPrompt = text; }));
    if (!opened(result)) {
      if (!result && !app.closing) app.output.write("Nothing was created.\n");
      app.newProjectExitCode = result?.exitCode ?? 1;
      app.terminal.close();
      app.interactive = false;
      return;
    }
    workspace = result.dir;
  } else if (!app.projectContext) workspace = await openProjectFolder(app, cwd);
  if (!app.projectContext) {
    await app.start(workspace);
  }

  app.savedModelDisplay = await modelPreference(app.sessionHomeDir ?? os.homedir());
  await checkSignIn(app);
  await loadPaneSetting(app);
  updateFooter(app);
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
    const pasted = queued === undefined ? app.terminal.takeSubmittedPastes() : app.linePastes.get(queued) ?? [];
    if (queued !== undefined) app.linePastes.delete(queued);
    if (app.cancelBeforeCommand) {
      app.output.write("[cancel] Stopped before it started; nothing ran.\n");
      continue;
    }
    const prompt = line.trim();

    if (!prompt) {
      continue;
    }

    // Only the command leaves: "exit" or "quit" typed without the "/" is a request like any other.
    if (prompt.startsWith("/") && findCommand(prompt)?.name === "exit") {
      break;
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
  // Keep what only shows something, /doctor and cleanup available, but never forget an uncertain
  // tree just because its originating command or model tool has finished.
  if (!runsAfterCleanupError(prompt)) {
    if (app.cleanupError) throw app.cleanupError;
    app.browser?.assertCleanup(); app.mcp?.assertCleanup(); app.lsp?.assertCleanup(); app.services?.assertCleanup();
  }
  // Bare /branch only lists them.
  const transition = /^\/(?:branch\s+\S|switch(?:\s|$))/.test(prompt);
  if (transition && app.subagents.isBusy) throw new Error("Wait for active subagents before changing workspaces");
  // /receipt, /undo, /redo and /diff read the last task; every other command starts without it.
  if (!/^\/(?:receipt|undo|redo|diff)(?:\s|$)/.test(prompt)) app.lastTaskResult = undefined;
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
  try {
    // A Shift+Tab that arrived with this submit still applies; new presses see commandActive and wait.
    while (app.effortSteps > 0) await app.effortCycle;
    if (app.closing) return;
    if (app.workspaceNeedsRebind) await rebindWorkspace(app, app.activeWorkspaceRoot());
    // Whatever follows a receipt either picks one of its suggestions or leaves them (they fade when ignored).
    // Nothing on offer: no extra wait, so a close that arrives with this line still finds the command running.
    if (app.suggestions.pending) await app.suggestions.settle(prompt, app.projectContext);
    else app.suggestions.forgetChoice();
    // Pictures pasted into this line (Ctrl+V) go with it, or with nothing when it is a command.
    app.pastedImages = app.terminal.takePastedImages();
    // A picture file dropped into an empty prompt starts the line with "/": that is a request, not a command.
    // Commands go straight on (no wait, so a close that arrives with the line still finds the command running).
    if (command && leadingImagePath(prompt) !== undefined) command = !await startsWithImageFile(prompt, { cwd: app.activeWorkspaceRoot() });
    if (command) return await handleSlashCommand(app, prompt);
    // "change model to opus 5.5": Casper changes it as /model would, with no model call (src/app/model-words.ts).
    const target = typed && !app.pastedImages?.size ? modelChangeRequest(prompt, typed.pasted) : undefined;
    if (target && await namesModel(await ensureRuntime(app), target)) {
      app.output.write(handledHere(target));
      return await handleSlashCommand(app, `/model ${target}`);
    }
    const words = typed ? parseRequestWords(prompt, typed.pasted) : undefined;
    return await runModelTask(app, words?.text ?? prompt, words ? { words } : {});
  } catch (error) {
    if (error instanceof ProcessCleanupError) app.cleanupError = error;
    throw error;
  } finally {
    try {
      await app.checkTask?.close();
      if (!command) await app.browser?.close();
      const opener = app.taskPageOpener;
      app.taskPageOpener = undefined;
      await opener?.close().catch(() => {});
    } catch (error) {
      if (error instanceof ProcessCleanupError) app.cleanupError = error;
      // A cleanup that failed wins over the request's own result: the next command must not start on it.
      // oxlint-disable-next-line no-unsafe-finally
      throw error;
    } finally {
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
  if (/^\/details(?:\s|$)/.test(prompt)) return detailsCommand(app, prompt.slice(8).trim()).then(() => undefined);
  if (prompt.trim() === "/settings") return settingsCommand(app).then(() => undefined);
  if (prompt.trim() === "/theme") return settingsCommand(app, "Theme").then(() => undefined);
  if (/^\/preview(?:\s|$)/.test(prompt)) return previewCommand(app, prompt.slice(8).trim()).then(() => undefined);
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
  if (/^\/plan(?:\s|$)/.test(prompt)) {
    const request = prompt.slice(5).trim();
    if (!request) { app.output.write("Type /plan and then what you want, for example /plan add a --verbose flag to the CLI; the model plans first and nothing is built until you choose Build.\n"); return Promise.resolve(undefined); }
    return runModelTask(app, request, { planFirst: true });
  }
  return runSlashCommand(app, prompt);
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

/** /settings: the off switches by number; a change is written to ~/.casper/config.yaml and applies from now on.
 * `only` (/theme): that one row's question. */
export function settingsCommand(app: CasperApp, only?: string): Promise<void> {
  return runSettings({
    output: app.output, homeDir: () => app.homeDir(), canAsk: app.interactive && app.terminal.canAsk, duringTask: typedDuringTask(),
    context: async () => app.projectContext, mcp: () => app.mcp,
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
