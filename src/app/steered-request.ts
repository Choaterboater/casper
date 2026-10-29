import type { CasperApp } from "../app";

/** The task's request as it now stands: what started it, then the lines the person typed during the task. Repair,
 * proof and acceptance rounds restate this, so a later instruction ("test the models and fix them") isn't lost. */
export function requestAsItStands(app: CasperApp, request: string): string {
  if (!app.steeredInTask.length) return request;
  return `${request}\n\nLater instructions the user typed during this task, oldest first:\n${app.steeredInTask.map(line => `- ${line.replace(/\s*\n\s*/g, " ")}`).join("\n")}`;
}
