import type { RuntimeConversation } from "../runtime/types";
import { lineText } from "../tui/format";

/** The conversation `id` names: the exact ID, or the one ID that starts with it. Throws in plain words otherwise. */
export function matchConversation<T extends { id: string }>(saved: readonly T[], id: string): T {
  const exact = saved.find(item => item.id === id);
  if (exact) return exact;
  const matches = saved.filter(item => item.id.startsWith(id));
  if (matches.length === 1) return matches[0]!;
  if (!id || !matches.length) throw new Error(`No saved conversation starts with ${id || "that"} here. /resume lists them.`);
  throw new Error(`${id} matches ${matches.length} conversations; type more of its ID. /resume lists them.`);
}

/** The user's own words in a message Casper sent the model: the request after "User request:", or the text itself. */
export function requestOf(text: string): string {
  const marker = text.lastIndexOf("User request:\n");
  const words = marker === -1 ? text : text.slice(marker + "User request:\n".length);
  return words.split("\n\n")[0]!.trim();
}

/** "3h ago", "3 days ago", "just now". */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return "some time ago";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const oneLine = (text: string, max: number) => {
  const line = lineText(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** One saved conversation in plain words: its title (or first request) and "3h ago · 12 messages". */
export function conversationLabel(item: RuntimeConversation, now = Date.now()): { title: string; detail: string } {
  const title = oneLine(item.name || requestOf(item.firstMessage ?? "") || "(no messages yet)", 60);
  const count = item.messages === undefined ? "" : ` · ${item.messages} message${item.messages === 1 ? "" : "s"}`;
  return { title, detail: `${ago(item.modified, now)}${count}` };
}

/** The last few turns of a resumed conversation, as short lines: "you  fix the login bug" and "AI   I changed …". */
export function recentTurnLines(turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }>, count = 4): string[] {
  const shown = turns.map(turn => turn.role === "user"
    ? { who: "you", text: oneLine(requestOf(turn.text), 100) }
    : { who: "AI ", text: oneLine(turn.text.split("\n").filter(Boolean).slice(0, 2).join(" "), 160) })
    .filter(turn => turn.text);
  return shown.slice(-count).map(turn => `  ${turn.who}  ${turn.text}`);
}
