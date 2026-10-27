/** After a /look report: the fixes it named, for /look fix and the Next row's "Fix all of it" (docs/BROWSER.md). A
 * real session critiqued a page, then typed the fix commands the critique named one at a time. */

import type { CasperApp } from "../app";
import { lookFixesNamed, lookNames, lookWhere } from "../look/commands";
import { changedSoFar, closingListAsks, type TaskEnding } from "../task/ending";
import type { NextItem } from "../tui/next-row";

/** After a task in a conversation that has looked at a page: when the task changed nothing (a report, or your reply to
 * one) and its answer names fixing /look commands for the issues ("`/look adapt`"), they are kept for /look fix. The
 * Next row's step, in a session, only when that answer ended asking nothing: a number typed under the AI's question,
 * or under its list of questions, would read as an answer (docs/TERMINAL_UX.md, Suggested next steps). */
export function noteLookFixes(app: CasperApp, ending: TaskEnding | undefined): NextItem | undefined {
  const task = app.lastTaskResult, page = app.lookPage;
  if (!page || task?.execution !== "completed" || changedSoFar(task)) return undefined;
  const commands = lookFixesNamed(app.lastAnswer);
  if (!commands.length) return undefined;
  app.lookFixes = { commands, page };
  if (!app.interactive || ending || app.toolAfterAnswer || closingListAsks(app.lastAnswer)) return undefined;
  return { label: "Fix all of it", command: "/look fix", note: "uses tokens", why: `/look ${lookNames(commands)} on ${lookWhere(page)}, in one task` };
}
