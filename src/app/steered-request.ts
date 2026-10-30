import type { CasperApp } from "../app";
import { showWaiting } from "./during-work";

const LATER = "Later instructions the user typed during this task, oldest first:";

function withLater(request: string, lines: readonly string[]): string {
  if (!lines.length) return request;
  return `${request}\n\n${LATER}\n${lines.map(line => `- ${line.replace(/\s*\n\s*/g, " ")}`).join("\n")}`;
}

/** The task's request as it now stands: what started it, then the lines the person typed during the task. Repair,
 * proof and acceptance rounds restate this, so a later instruction ("test the models and fix them") isn't lost. */
export function requestAsItStands(app: CasperApp, request: string): string {
  return withLater(request, app.steeredInTask);
}

/** Right before a task's first model turn: the turn's text with the lines typed before the model started (while
 * Casper set up a server or read the workspace) added, in the same form. From here on, lines are steered or queued. */
export function withLinesBeforeModel(app: CasperApp, text: string): string {
  app.beforeFirstModelTurn = false;
  const lines = app.linesBeforeModel.splice(0);
  if (lines.length) showWaiting(app);
  return withLater(text, lines);
}
