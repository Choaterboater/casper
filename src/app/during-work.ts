/** Typing while a task runs: lines the AI reads at its next step or that queue as the next request, commands that
 * run now, side questions, and the model and effort (/model, Shift+Tab, /effort). Moved from src/app.ts. */

import type { CasperApp } from "../app";
import { effortProblem, nextEffort } from "../tui/effort";
import { formatEffort, terminalText } from "../tui/format";
import { runTasksCommand } from "./background";
import { canonicalLine, runsDuringWork, sessionFlag } from "../tui/commands";
import { commandProblem } from "../tui/help";
import { leadingImagePath } from "./images";
import { opened } from "./new-project";
import { updateFooter } from "./footer";
import { backgroundTasks } from "./task-tools";
import { handleSlashCommand } from "./command-loop";
import { runMCPListDuringWork, runPermissionsDuringWork } from "./commands";
import { ensureRuntime } from "./runtime-start";
import { askSideQuestion, BTW_USAGE, btwQuestion, sideQuestionsOn, sideQuestionText } from "./side-question";
import { duringTask } from "../tui/give-way";

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

/** Enter while a task runs. A command runs now, with whatever follows it, except the few that would change the
 * task's conversation, workspace or files, or start model work of their own: those keep their draft with the reason.
 * Its pickers and questions give way to the task's (src/tui/give-way.ts). Anything else goes to the AI: it reads the
 * line at its next step, or, when it is not working right now (checks, a receipt), the line is queued and runs as the
 * next request. */
export function submitDuringWork(app: CasperApp, line: string, plain = false): true | string {
  if (app.closing) return "Casper is closing";
  // No task yet: Casper is still opening a folder or project. Nothing is loaded to show, so the line waits.
  if (!app.commandActive || !app.projectContext) return "draft kept · Enter again once Casper has opened the project";
  if (line.startsWith("/") && leadingImagePath(line) === undefined) {
    // A command Casper doesn't know, or words one doesn't take: said now, as when idle, not after the task.
    const problem = commandProblem(line);
    if (problem) { app.output.write(`[error] ${terminalText(problem)}\n`); return true; }
  }
  if (runsDuringWork(line)) { duringTask(() => runCommandDuringWork(app, canonicalLine(line))); return true; }
  if (line.startsWith("/")) return `${terminalText(line.split(/\s+/)[0]!)} waits until this task ends${plain ? "; type it again then" : " · draft kept · Esc stops the task"}`;
  const pasted = app.terminal.takeSubmittedPastes();
  // A side question gets its own answer now; the working AI never sees it.
  const side = sideQuestionsOn(app) ? sideQuestionText(line, pasted) : undefined;
  if (side !== undefined) { void askSideQuestion(app, side); return true; }
  // A line that runs later as a request keeps what was pasted into it, so its words count only where typed.
  if (pasted.length) app.linePastes.set(line, pasted);
  void steerOrQueue(app, line);
  return true;
}

/** One command typed during a task (an alias already spelled as its command). Its outcome and errors are written as
 * they come; the task goes on. */
function runCommandDuringWork(app: CasperApp, line: string): void {
  // /exit stops the task and leaves, as Ctrl+C twice does: nothing waits for the task to end first.
  if (line === "/exit") { app.output.write("[exit] Stopping this task and leaving Casper.\n"); void app.close().catch(() => {}); return; }
  const btw = btwQuestion(line);
  if (btw !== undefined) { if (btw) void askSideQuestion(app, btw); else app.output.write(`${BTW_USAGE}\n`); return; }
  const effort = /^\/effort\s+(.+)$/.exec(line);
  if (effort) { const { rest, session } = sessionFlag(effort[1]!); void setEffortDuringWork(app, rest, !session); return; }
  // The picker or one model; /model roles, role and big go to the command (they never change the model in use).
  const model = /^\/model(?:\s+(.+))?$/.exec(line);
  if (model && !/^(?:roles?|big)(?:\s|$)/.test((model[1] ?? "").trim())) { void setModelDuringWork(app, (model[1] ?? "").trim()); return; }
  const failed = (error: unknown) => { app.output.write(`[error] ${terminalText(error instanceof Error ? error.message : String(error))}\n`); };
  // /doctor only reports during a task: its fixes ask after the task, so its questions never queue up behind the task's.
  if (line === "/doctor") {
    void import("../doctor/session").then(({ runDoctorInSession }) => runDoctorInSession(app, true)).catch(failed);
    return;
  }
  if (line === "/tasks") {
    void runTasksCommand({ tasks: () => backgroundTasks(app), write: text => app.output.write(text), canAsk: () => false,
      pick: async () => undefined, duringWork: true }).catch(failed);
    return;
  }
  // The list prints instead of a picker, so a long look never sits in front of the task's next box.
  if (/^\/diff\s+list$/.test(line)) { void app.taskUndo.diff("list", undefined, true).catch(failed); return; }
  if (line === "/mcp") { void runMCPListDuringWork(app).catch(failed); return; }
  // /permissions shows its screen without the stop-asking box, which would stand in front of the task's own boxes.
  if (line === "/permissions" || line === "/permissions details") { void runPermissionsDuringWork(app, line).catch(failed); return; }
  void handleSlashCommand(app, line).catch(failed);
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
    const problem = effortProblem(level, session.getStatus?.());
    if (problem) throw new Error(problem);
    const updated = await session.setEffort(level, persist);
    app.output.write(`[effort] ${formatEffort(updated, true) ?? level} from the model's next step${persist ? "; saved" : " (this conversation)"}\n`);
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
    const { rest: query, session: sessionOnly } = sessionFlag(argument);
    const before = session.getStatus?.().provider;
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
    // One line; it names where the context goes only when that is a different provider.
    const moved = result.status.provider !== before ? ` · this conversation's context goes to ${terminalText(result.status.provider ?? "its provider")}` : "";
    app.output.write(`[model] ${terminalText(label)} from the model's next step${result.savedDefault ? "; saved" : " (this conversation)"}${moved}\n`);
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
  if (app.commandActive) app.output.write(`[effort] ${formatEffort(saved, true) ?? level} from the model's next step; saved\n`);
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
