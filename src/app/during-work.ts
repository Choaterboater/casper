/** Typing while a task runs: lines the AI reads at its next step or that queue as the next request, commands that
 * run now, and the effort level (Shift+Tab, /effort). Moved from src/app.ts. */

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

/** After a task: lines the AI never read join the queue. A stopped task runs nothing more: its queued lines go
 * back into the prompt (the rich terminal) for you to send or clear. */
export function settleQueuedLines(app: CasperApp): void {
  let unsent: string[] = [];
  try { unsent = app.session?.takeUnsent?.() ?? []; } catch { /* nothing left to take */ }
  app.queuedLines.unshift(...unsent);
  if (!app.queuedLines.length || !app.commandAbort?.signal.aborted || app.closing) return;
  const lines = app.queuedLines.splice(0);
  const count = `${lines.length} queued line${lines.length === 1 ? "" : "s"}`;
  if (app.terminal.restoreDraft(lines.join("\n"))) app.output.write(`[cancel] Your ${count} ${lines.length === 1 ? "is" : "are"} back in the prompt; Enter sends ${lines.length === 1 ? "it" : "them"}.\n`);
  else app.output.write(`[cancel] Dropped your ${count}; type ${lines.length === 1 ? "it" : "them"} again to send.\n`);
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
  // A line that runs later as a request keeps what was pasted into it, so its words count only where typed.
  const pasted = app.terminal.takeSubmittedPastes();
  if (pasted.length) app.linePastes.set(line, pasted);
  void steerOrQueue(app, line);
  return true;
}

export async function steerOrQueue(app: CasperApp, line: string): Promise<void> {
  let sent = false;
  try { sent = await app.session?.steer?.(line) ?? false; } catch { sent = false; }
  if (app.closing) return;
  if (sent) { app.output.write("  ↳ sent to the AI · it reads this at its next step\n"); return; }
  // The task ended while Casper asked the AI: nothing would run the queue now, so the line goes back in the prompt.
  if (!app.commandActive) {
    if (app.terminal.restoreDraft(line)) app.output.write("  ↳ the task had just ended · your line is back in the prompt\n");
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
