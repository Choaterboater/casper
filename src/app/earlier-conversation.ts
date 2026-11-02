/** The start's way back: a plain start in a folder's main session begins a new conversation, and when the folder has an
 * earlier one it offers one row, "Next: 1 Continue the Oct 21 conversation (…) · 2 Saved pages (12)", after what a walk-away job left. A lone 1 on the empty prompt runs
 * /continue, which opens what --continue would, even when typed before the row shows, and so does a first line that only
 * asks to go back ("continue session", continueWords); anything else typed starts the new conversation; Enter runs nothing. */

import type { CasperApp } from "../app";
import { conversationLabel, requestOf } from "../sessions/resume";
import { pagesDirectory, savedPages } from "../pages/store";
import type { RuntimeConversation } from "../runtime/types";
import { buildNextRow, type NextItem } from "../tui/next-row";
import { SessionWorkspaceManager } from "../sessions/manager";
import { jobRowItems, jobWorkingHere } from "./jobs";

export const NEW_CONVERSATION_HINT = "Anything you type starts a new conversation, unless it refers back to this one (\"run it again\").";

/** The start's offer to continue: which conversation, in the row's words, and whether it is today's or yesterday's (only
 * then does a request that refers back go to it on its own). */
export interface EarlierOffer { day: string; title?: string; recent: boolean }
/** The start's row as shown: what its key 1 runs, and the conversation it offers to continue, if any. */
export interface StartRow { first: string; continues?: EarlierOffer }

/** "Oct 21", or "today's" / "yesterday's" when it was. */
export function conversationDay(modified: string, now = new Date()): string {
  const day = new Date(modified);
  const start = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((start(now) - start(day)) / 86_400_000);
  if (days === 0) return "today's";
  if (days === 1) return "yesterday's";
  return `${day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}${day.getFullYear() === now.getFullYear() ? "" : `, ${day.getFullYear()}`}`;
}

/** The row's words: "Continue today's conversation", "Continue the Oct 21 conversation". */
export function continueLabel(modified: string, now = new Date()): string {
  const day = conversationDay(modified, now);
  return day.endsWith("'s") ? `Continue ${day} conversation` : `Continue the ${day} conversation`;
}

/** The start's row: "1 Continue …" when this folder has an earlier conversation, then "Saved pages (N)" when any folder
 * has pages (/pages lists them). The row once shown, so a lone 1 typed before it shows waits for it and runs its key 1. */
export async function offerEarlierConversation(app: CasperApp): Promise<StartRow | undefined> {
  if (app.closing || !app.interactive || app.runConversation || app.queuedPrompt !== undefined || !app.projectContext) return undefined;
  const context = app.projectContext;
  const [found, pages, jobs, working] = await Promise.all([newestConversation(app), savedPageCount(app), jobRowItems(app).catch(() => []),
    jobWorkingHere(app).catch(() => false)]);
  // A job still working here is writing its conversation: no second Casper continues it until the job ends.
  const newest = working ? undefined : found;
  // Too late once a request or command has started: the row is for the empty prompt at the start.
  if ((!newest && !pages && !jobs.length) || app.closing || app.commandActive || app.session || app.projectContext !== context) return undefined;
  // A walk-away job's result or question comes first (decision 51).
  const more: NextItem[] = [...jobs];
  if (newest) {
    const title = rowTitle(newest);
    const messages = newest.messages === undefined ? "" : `${newest.messages} message${newest.messages === 1 ? "" : "s"}`;
    const note = [title, messages].filter(Boolean).join(", ");
    more.push({ label: continueLabel(newest.modified), command: "/continue", ...(note ? { note } : {}) });
  }
  if (pages) more.push({ label: "Saved pages", command: "/pages", note: String(pages) });
  app.terminal.offerNext(buildNextRow({ more, ...(newest ? { hint: NEW_CONVERSATION_HINT } : {}) }));
  const first = more[0]!.command;
  if (!newest || jobs.length) return { first };
  const day = conversationDay(newest.modified);
  const title = rowTitle(newest);
  return { first, continues: { day: day.endsWith("'s") ? day : `the ${day}`, ...(title ? { title } : {}), recent: day.endsWith("'s") } };
}

/** The conversation's title for the row, or undefined when it has none worth showing: no name and no first request, or
 * one with no words in it (a stray "1"). */
function rowTitle(item: RuntimeConversation): string | undefined {
  if (!item.name?.trim() && !requestOf(item.firstMessage ?? "")) return undefined;
  const { title } = conversationLabel(item);
  return /\p{L}/u.test(title) ? title : undefined;
}

/** This folder's newest earlier conversation with messages, or undefined (none, a /branch folder, or unreadable). */
async function newestConversation(app: CasperApp): Promise<RuntimeConversation | undefined> {
  if (!app.savedConversations) return undefined;
  const context = app.projectContext!;
  try {
    // A /branch experiment folder reopens its own conversation: nothing to offer there. Read only: nothing is cached, and
    // no model starts, so a folder question or move before the first request is unchanged.
    const workspace = await SessionWorkspaceManager.open({ projectRoot: context.info.root, gitBranch: context.info.gitBranch,
      policy: context.policy.workspace, homeDir: app.sessionHomeDir });
    if (workspace.activeName !== "main") return undefined;
    const saved = await app.savedConversations(context.info.root);
    return saved.filter(item => item.messages !== 0).sort((a, b) => b.modified.localeCompare(a.modified))[0];
  } catch { return undefined; /* no row: a plain start still works */ }
}

/** How many pages are saved, in every folder. Read only: no page server starts. */
async function savedPageCount(app: CasperApp): Promise<number> {
  try { return (await savedPages(app.homeDir(), pagesDirectory(app.homeDir(), app.projectContext!.stateDirectory))).length; }
  catch { return 0; }
}

/** How long a lone 1 typed before the row shows waits for it. */
export const EARLY_ONE_WAIT_MS = 3_000;

const WHICH = String.raw`(?:\s+(?:the|my|our|that))?(?:\s+(?:last|previous|earlier|prior|old|yesterday'?s))?`;
const SESSION = String.raw`\s+(?:session|conversation|chat)`;
/** A first line that only asks to go back to the last conversation: "continue", "continue session", "resume my last
 * session", "pick up where we left off". Short, typed (not pasted), and nothing else in it: "continue the refactor" or
 * "continue session and fix the bug" is a request. Asked only at the start, while the continue row is offered; later in
 * a conversation "continue" means keep going. */
const BACK = new RegExp(String.raw`^(?:please\s+)?(?:(?:continue|resume)${WHICH}(?:${SESSION})?|(?:go\s+back\s+to|back\s+to|reopen|open)${WHICH}${SESSION}`
  + String.raw`|(?:let'?s\s+)?pick\s+up\s+where\s+(?:we|i|you)\s+left\s+off)\s*[.!]*$`, "i");
export function continueWords(line: string, pasted: readonly string[] = []): boolean {
  const text = line.trim();
  return !pasted.some(Boolean) && text.length <= 60 && !/[\r\n]/.test(text) && BACK.test(text);
}

/** Words that do again what was done before, or a short "fix it", "run that": they mean the last conversation's work. */
const AGAIN = /\b(?:re-?\s?run|re-?do|re-?try|again|repeat|same\s+(?:as\s+before|thing|again)|as\s+before|one\s+more\s+time|like\s+last\s+time)\b/i;
const DO_TO_THAT = /^(?:please\s+)?(?:run|fix|finish|do|check|try|test|show|open|start|launch|stop|restart|build|ship|deploy|publish|push|commit|undo|continue|redo)\s+(?:it|that|those|them|this)\b/i;
/** A short first line, typed, that refers back to earlier work ("re run test", "do that again", "fix it"): while today's
 * or yesterday's conversation is offered, it is continued and the line sent there (decision 42, amended). */
export function refersBack(line: string, pasted: readonly string[] = []): boolean {
  const text = line.trim();
  if (pasted.some(Boolean) || /[\r\n?]/.test(text) || text.length > 60 || text.split(/\s+/).length > 8) return false;
  return AGAIN.test(text) || DO_TO_THAT.test(text);
}

/** "run test", "test", "run the lint": a short line that only names one of the project's checks. Undefined otherwise. */
export function checkWordsOnly(line: string, checks: readonly string[]): string | undefined {
  const words = line.trim().toLowerCase().replace(/[.!]+$/, "").split(/\s+/).filter((word) => !["run", "the", "a", "please", "now"].includes(word));
  return words.length === 1 && checks.includes(words[0]!) ? words[0] : undefined;
}
