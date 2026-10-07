/** Typing while a task runs: lines the AI reads at its next step or that queue as the next request, commands that
 * run now, and the model and effort (/model, Shift+Tab, /effort). Moved from src/app.ts. */

import type { CasperApp } from "../app";
import { nextEffort } from "../tui/effort";
import { formatEffort, terminalText } from "../tui/format";
import { runTasksCommand } from "./background";
import { runsDuringWork } from "../tui/commands";
import { opened } from "./new-project";
import { updateFooter } from "./footer";
import { backgroundTasks } from "./task-tools";
import { handleSlashCommand } from "./command-loop";
import { ensureRuntime } from "./runtime-start";
import { askSideQuestion, sideQuestionsOn, sideQuestionText } from "./side-question";

/** After a task: lines the AI never read join the queue. A stopped task runs nothing more: its queued lines go
 * back into the prompt (the rich terminal) for you to send or clear. */
export function settleQueuedLines(app: CasperApp): void {
  let unsent: string[] = [];
  try { unsent = app.session?.takeUnsent?.() ?? []; } catch { /* nothing left to take */ }
  app.queuedLines.unshift(...unsent);
  // Lines the AI read are done with: only lines still waiting keep their record of what was pasted.
  for (const line of app.linePastes.keys()) if (!app.queuedLines.includes(line)) app.linePastes.delete(line);
  if (!app.queuedLines.length || !app.commandAbort?.signal.aborted || app.closing) return;
  const lines = app.queuedLines.splice(0);
  const count = `${lines.length} queued line${lines.length === 1 ? "" : "s"}`;
  if (app.terminal.restoreDraft(lines.join("\n"), takeLinePastes(app, lines))) app.output.write(`[cancel] Your ${count} ${lines.length === 1 ? "is" : "are"} back in the prompt; Enter sends ${lines.length === 1 ? "it" : "them"}.\n`);
  else app.output.write(`[cancel] Dropped your ${count}; type ${lines.length === 1 ? "it" : "them"} again to send.\n`);
}

/** What was pasted into `lines`, for lines going back into the prompt; their record here is done with. */
function takeLinePastes(app: CasperApp, lines: readonly string[]): string[] {
  const pasted = lines.flatMap(line => app.linePastes.get(line) ?? []);
  for (const line of lines) app.linePastes.delete(line);
  return pasted;
}

/** Enter while a task runs. Commands that only show something, and /effort, run now; other commands keep their
 * draft with the reason. Anything else goes to the AI: it reads the line at its next step, or, when it is not working
 * right now (checks, a receipt), the line is queued and runs as the next request. */
export function submitDuringWork(app: CasperApp, line: string, plain = false): true | string {
  if (app.closing) return "Casper is closing";
  // No task yet: Casper is still opening a folder or project. Nothing is loaded to show, so the line waits.
  if (!app.commandActive || !app.projectContext) return "draft kept · Enter again once Casper has opened the project";
  if (runsDuringWork(line)) {
    const effort = /^\/effort\s+(\S+)(?:\s+(--session))?$/.exec(line);
    if (effort) { void setEffortDuringWork(app, effort[1]!, !effort[2]); return true; }
    const model = /^\/model(?:\s+(.+))?$/.exec(line);
    if (model && line !== "/model roles") { void setModelDuringWork(app, (model[1] ?? "").trim()); return true; }
    const failed = (error: unknown) => { app.output.write(`[error] ${terminalText(error instanceof Error ? error.message : String(error))}\n`); };
    if (line === "/tasks") {
      void runTasksCommand({ tasks: () => backgroundTasks(app), write: text => app.output.write(text), canAsk: () => false,
        pick: async () => undefined, duringWork: true }).catch(failed);
      return true;
    }
    // A picker would sit in the way of any approval the task asks; the list prints instead.
    if (/^\/diff\s+list$/.test(line)) {
      void app.taskUndo.diff("list", undefined, true).catch(failed);
      return true;
    }
    void handleSlashCommand(app, line).catch(failed);
    return true;
  }
  if (line.startsWith("/")) return `${terminalText(line.split(/\s+/)[0]!)} waits until this task ends${plain ? "; type it again then" : " · draft kept"}`;
  const pasted = app.terminal.takeSubmittedPastes();
  // A side question gets its own answer now; the working AI never sees it.
  const side = sideQuestionsOn(app) ? sideQuestionText(line, pasted) : undefined;
  if (side !== undefined) { void askSideQuestion(app, side); return true; }
  // A line that runs later as a request keeps what was pasted into it, so its words count only where typed.
  if (pasted.length) app.linePastes.set(line, pasted);
  void steerOrQueue(app, line);
  return true;
}

export async function steerOrQueue(app: CasperApp, line: string): Promise<void> {
  let sent = false;
  try { sent = await app.session?.steer?.(line) ?? false; } catch { sent = false; }
  if (app.closing) return;
  if (sent) { app.output.write("  ↳ sent to Casper · it reads this at its next step\n"); return; }
  // The task ended while Casper asked the AI: nothing would run the queue now, so the line goes back in the prompt.
  if (!app.commandActive) {
    if (app.terminal.restoreDraft(line, takeLinePastes(app, [line]))) app.output.write("  ↳ the task had just ended · your line is back in the prompt\n");
    else app.output.write("  ↳ the task had just ended · type it again to send it\n");
    return;
  }
  app.queuedLines.push(line);
  const waiting = app.queuedLines.length;
  app.output.write(`  ↳ queued · runs when this task ends${waiting > 1 ? ` (${waiting} waiting)` : ""} · Esc stops the task and gives it back\n`);
}

/** /effort <level> during a task: the model's next step uses it; the step already running keeps its level. */
export async function setEffortDuringWork(app: CasperApp, level: string, persist: boolean): Promise<void> {
  try {
    const session = app.session;
    if (!session?.setEffort) throw new Error("effort controls unavailable");
    const updated = await session.setEffort(level, persist);
    app.output.write(`[effort] ${formatEffort(updated) ?? level} from the model's next step${persist ? "; saved" : " (this conversation)"}\n`);
    updateFooter(app);
  } catch (error) { app.output.write(`[error] ${terminalText(error instanceof Error ? error.message : String(error))}\n`); }
}

/** /model during a task: the picker, or `/model [--session] <provider/id>`. The model's next step uses it; the step
 * already running keeps its model. An approval or question that arrives closes the picker first; the picker also closes
 * when the model's work ends (nothing would take the next step). */
export async function setModelDuringWork(app: CasperApp, argument: string): Promise<void> {
  const yielded = new AbortController();
  let watch: ReturnType<typeof setInterval> | undefined;
  const closed = Promise.withResolvers<void>();
  const handle = { close: () => { yielded.abort(); return closed.promise; } };
  try {
    const session = app.session;
    if (!session?.selectModel) throw new Error("model selection unavailable");
    const sessionOnly = /^--session(?:\s|$)/.test(argument);
    const query = (sessionOnly ? argument.slice(9) : argument).trim();
    const picker = query ? undefined : app.terminal.exclusiveHost({ onYield: () => yielded.abort() });
    if (!query && !picker) { app.output.write("[model] The picker needs the full terminal; type /model <provider/id>.\n"); return; }
    if (picker) app.openModelPicker = handle;
    if (picker) watch = setInterval(() => { if (!app.commandActive || !session.getState().isStreaming) yielded.abort(); }, 200);
    const signal = app.commandAbort ? AbortSignal.any([yielded.signal, app.commandAbort.signal]) : yielded.signal;
    const result = await session.selectModel({ ...(query ? { query } : {}), persist: !sessionOnly, signal, ...(picker ? { picker } : {}) });
    if (!result.selected) {
      app.output.write(result.models ? `[model] No model ${terminalText(query)}; model unchanged. /model lists them when this task ends.\n` : "[model] Model unchanged.\n");
      return;
    }
    const label = `${result.status.provider}/${result.status.model}`;
    app.output.write(`[model] ${terminalText(label)} from the model's next step${result.savedDefault ? "; saved" : " (this conversation)"}\n`);
    app.output.write(`[model] The model's next step sends this conversation's context to ${terminalText(result.status.provider ?? "its provider")}.\n`);
    updateFooter(app);
  } catch (error) {
    if (yielded.signal.aborted) app.output.write("[model] Model unchanged.\n");
    else app.output.write(`[error] ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
  } finally {
    if (watch) clearInterval(watch);
    if (app.openModelPicker === handle) app.openModelPicker = undefined;
    closed.resolve();
  }
}

/** Shift+Tab. A held key walks the ring; the level the presses stop at is saved once, like `/effort`. During a task
 * the model's next step uses it. */
export function cycleEffort(app: CasperApp): void {
  if (app.closing) return;
  if (app.effortSteps >= 12) return;
  app.effortSteps++;
  app.effortCycle = app.effortCycle.then(async () => {
    try {
      if (!app.closing) await applyEffortCycle(app);
      // What you pick sticks, like /effort: the level the presses stop at is saved once.
      if (!app.closing && app.effortSteps === 1) await saveCycledEffort(app);
    }
    catch (error) {
      if (!app.closing) app.terminal.flashNote(error instanceof Error ? error.message : String(error));
    } finally { app.effortSteps--; }
  });
}

export async function saveCycledEffort(app: CasperApp): Promise<void> {
  const session = app.session;
  const level = session?.getStatus?.().configuredEffort;
  if (!session?.setEffort || !level) return;
  const saved = await session.setEffort(level, true);
  // During a task the footer shows its stages, not notes: say it in the transcript instead.
  if (app.commandActive) app.output.write(`[effort] ${formatEffort(saved) ?? level} from the model's next step; saved\n`);
  else app.terminal.flashNote(`effort ${formatEffort(saved) ?? level} · saved`);
  updateFooter(app);
}

export async function applyEffortCycle(app: CasperApp): Promise<void> {
  const session = await ensureRuntime(app);
  if (app.closing) return;
  if (!session.setEffort || !session.getStatus) {
    app.terminal.flashNote("effort controls unavailable");
    return;
  }
  const status = session.getStatus();
  if (!status.model) {
    app.terminal.flashNote("no model · use /model");
    return;
  }
  const current = status.configuredEffort ?? status.thinkingLevel;
  const next = nextEffort(current, status.availableThinkingLevels);
  if (!next || next === current) {
    app.terminal.flashNote("no other effort on this model");
    return;
  }
  const updated = await session.setEffort(next, false);
  const shown = formatEffort(updated) ?? next;
  if (!app.commandActive) app.terminal.flashNote(`effort ${shown} · session`);
  updateFooter(app);
}
