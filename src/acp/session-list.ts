// session/list (decision 114): the conversations saved for a folder, as /resume lists them, answered by the router
// (src/acp/server.ts) from the files on disk. No session process starts, no model is called and nothing is written.

import type { RuntimeConversation } from "../runtime/types";
import { conversationLabel, requestOf } from "../sessions/resume";
import { RpcFailure, RPC, type Json } from "./rpc";
import { hider, titleShown } from "./updates";

/** How many conversations one session/list reply holds; `nextCursor` asks for the next ones. */
export const LIST_PAGE = 50;

export interface ListSource {
  /** The conversations saved where a session opened in `folder` keeps them (its project's top folder). */
  saved(folder: string): Promise<RuntimeConversation[]>;
  /** Casper's own secret values, read again for each list: never in a title. */
  secrets(): readonly string[];
  pageSize?: number;
}

interface Position { m: string; i: string }

/** Newest first; the same moment by ID, so every conversation has one place. */
const order = (a: RuntimeConversation, b: RuntimeConversation) => b.modified.localeCompare(a.modified) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The opaque cursor: where the last page ended (the time and ID of its last conversation), never words or a path. */
export function cursorAfter(item: RuntimeConversation): string {
  return Buffer.from(JSON.stringify({ m: item.modified, i: item.id } satisfies Position)).toString("base64url");
}

function positionOf(cursor: unknown): Position | undefined {
  if (cursor === undefined || cursor === null) return undefined;
  if (typeof cursor === "string") {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<Position>;
      if (typeof parsed?.m === "string" && typeof parsed.i === "string") return { m: parsed.m, i: parsed.i };
    } catch { /* refused below */ }
  }
  throw new RpcFailure(RPC.invalidParams, "cursor must be a nextCursor from an earlier session/list reply");
}

/** The chat title an app shows: the conversation's name, or its first request, as /resume shows it; none for neither.
 * Hidden as a session's own title is (titleShown). */
function titleOf(item: RuntimeConversation, values: readonly string[]): string | null {
  if (!item.name?.trim() && !requestOf(item.firstMessage ?? "")) return null;
  return titleShown(conversationLabel(item).title, hider(() => values), values);
}

/**
 * One page of `folder`'s saved conversations as ACP's SessionInfo, newest first: `{sessionId, cwd, title, updatedAt}`,
 * `cwd` being `folder`, where a session/load opens it. A conversation with no messages (a session opened and never
 * used) is left out. A conversation saved or changed between pages keeps its place by time, so a page never repeats
 * one the app already has.
 */
export async function listSessions(folder: string, cursor: unknown, source: ListSource): Promise<Json> {
  const after = positionOf(cursor);
  const saved = (await source.saved(folder)).filter((item) => item.messages !== 0).sort(order);
  const start = after ? saved.findIndex((item) => order(item, { id: after.i, modified: after.m }) > 0) : 0;
  const size = source.pageSize ?? LIST_PAGE;
  const page = start === -1 ? [] : saved.slice(start, start + size);
  let values: readonly string[] = [];
  try { values = [...source.secrets()].sort((a, b) => b.length - a.length); } catch { values = []; }
  const sessions = page.map((item) => ({ sessionId: item.id, cwd: folder, title: titleOf(item, values), updatedAt: item.modified }));
  const more = start !== -1 && start + size < saved.length;
  return { sessions, ...(more ? { nextCursor: cursorAfter(page.at(-1)!) } : {}) };
}
