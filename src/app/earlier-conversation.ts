/** The start's way back: a plain start in a folder's main session begins a new conversation, and when the folder has an
 * earlier one it offers one row, "Next: 1 Continue the Oct 21 conversation (…)". A lone 1 on the empty prompt runs
 * /continue, which opens what --continue would; anything typed starts the new conversation; Enter runs nothing. */

import type { CasperApp } from "../app";
import { conversationLabel } from "../sessions/resume";
import { buildNextRow } from "../tui/next-row";
import { SessionWorkspaceManager } from "../sessions/manager";

export const NEW_CONVERSATION_HINT = "Anything you type starts a new conversation.";

/** "Oct 21", or "today's" / "yesterday's" when it was. */
export function conversationDay(modified: string, now = new Date()): string {
  const day = new Date(modified);
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start(now) - start(day)) / 86_400_000);
  if (days === 0) return "today's";
  if (days === 1) return "yesterday's";
  return `${day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}${day.getFullYear() === now.getFullYear() ? "" : `, ${day.getFullYear()}`}`;
}

export async function offerEarlierConversation(app: CasperApp): Promise<void> {
  if (app.closing || !app.interactive || app.runConversation || app.queuedPrompt !== undefined || !app.projectContext) return;
  if (!app.savedConversations) return;
  const context = app.projectContext;
  try {
    // A /branch experiment folder reopens its own conversation: nothing to offer there. Read only: nothing is cached, and
    // no model starts, so a folder question or move before the first request is unchanged.
    const workspace = await SessionWorkspaceManager.open({ projectRoot: context.info.root, gitBranch: context.info.gitBranch,
      policy: context.policy.workspace, homeDir: app.sessionHomeDir });
    if (workspace.activeName !== "main") return;
    const saved = await app.savedConversations(context.info.root);
    const newest = saved.filter(item => item.messages !== 0).sort((a, b) => b.modified.localeCompare(a.modified))[0];
    // Too late once a request or command has started: the row is for the empty prompt at the start.
    if (!newest || app.closing || app.commandActive || app.session || app.projectContext !== context) return;
    const { title } = conversationLabel(newest);
    const messages = newest.messages === undefined ? "" : `${newest.messages} message${newest.messages === 1 ? "" : "s"}`;
    const note = [title, messages].filter(Boolean).join(" · ");
    app.terminal.offerNext(buildNextRow({ more: [{ label: `Continue the ${conversationDay(newest.modified)} conversation`, command: "/continue", ...(note ? { note } : {}) }],
      hint: NEW_CONVERSATION_HINT }));
  } catch { /* no row: a plain start still works */ }
}
