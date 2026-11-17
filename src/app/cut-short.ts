/** A task cut short (decision 108, src/sessions/cut-short.ts): the start's row and /jobs offer to go on with it, and the
 * first request sent in that conversation, however it was opened, carries one note about the steps with no result. */

import type { RuntimeConversation, RuntimeSession } from "../runtime/types";
import { CUT_SHORT_GO_ON, cutShortPreview, readCutShort, type CutShort } from "../sessions/cut-short";
import type { NextItem } from "../tui/next-row";
import { conversationDay } from "../sessions/resume";

/** Whether Casper notices a task cut short: `cut_short: off` in your config turns it off (/settings Tasks cut short). */
type Switch = { readonly projectContext?: { readonly cutShort?: boolean } | undefined };
const noticed = (app: Switch) => app.projectContext?.cutShort !== false;

/** The cut-short turn of the conversation now open: the request sent next carries its note, and /continue, /resume and
 * --continue say so. Undefined when it wasn't cut short, it is turned off, or the runtime can't tell. Once a request is
 * in the conversation after it, it isn't cut short any more, so the note goes once; a request that failed before it got
 * there (no sign-in, no key) leaves it cut short, and the next request carries the note. */
export function openCutShort(app: Switch, session: RuntimeSession): CutShort | undefined {
  if (!noticed(app)) return undefined;
  try { return session.cutShort?.(); } catch { return undefined; }
}

/** The saved conversation's cut-short turn, read from its file, or undefined (or turned off). */
export async function savedCutShort(app: Switch, conversation: RuntimeConversation | undefined): Promise<CutShort | undefined> {
  return noticed(app) && conversation?.file ? readCutShort(conversation.file) : undefined;
}

/** The row's key for it: "Go on with the task that was cut short (fix the login bug · today)". It runs /continue, then
 * sends the note alone as the request. */
export function goOnItem(cut: CutShort, conversation: Pick<RuntimeConversation, "modified">, now = new Date()): NextItem {
  const day = conversationDay(conversation.modified, now).replace(/'s$/, "");
  const preview = cutShortPreview(cut);
  return { label: "Go on with the task that was cut short", command: `/continue ${CUT_SHORT_GO_ON}`, note: preview ? `${preview} · ${day}` : day };
}
