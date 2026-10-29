/**
 * The whole conversation as saved, for /export: every message on the conversation's branch, including those a
 * compaction took out of the AI's context, with the compaction marked where it happened. Each message Casper sends
 * the AI is recorded as the person's (with their exact words) or Casper's own (a repair, review or proof round), so
 * the export never shows Casper's prompts as "You". Conversations saved before that record existed are read by
 * the openings Casper's own prompts had.
 */

import type { ConversationItem } from "../runtime/types";
import { STEERED_LINE_ENTRY, steeredAt } from "../runtime/steered-lines";
import { requestOf } from "./resume";

/** The record, just after a message Casper sent the AI, of who wrote it. It names the message by its time, as the
 * record of a line typed during work does. */
export const CASPER_SAID_ENTRY = "casper.said";

type Said = { by: "you"; words: string } | { by: "casper" };

/** What the record holds: the message's time, and the person's own words, or nothing when Casper wrote it. */
export function saidBy(at: number, typed?: string): { at: number } & Said {
  return typed === undefined ? { at, by: "casper" } : { at, by: "you", words: typed };
}

/** The saved entries this reads (Pi's session entries; others are passed over). */
export type RecordEntry =
  | { type: "message"; message: { role: string; content?: unknown; timestamp?: number } }
  | { type: "custom"; customType: string; data?: unknown }
  | { type: "compaction"; summary: string }
  | { type: string };

// Openings of the prompts Casper wrote itself, as saved before authorship was recorded.
const OPENINGS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [/^(?:Same failure as the last round:[^\n]*\n)?Casper (verification repair \d+\/\d+|browser replay repair \d+\/\d+|proof repair|requirements review|page look)\./, (match) => match[1]!],
  [/^Casper: you stopped (?:with work still open|before the work was done)\./, () => "keep going"],
  [/^Your last response failed with a provider error\./, () => "retry after a provider error"],
];
const PLAN_QUESTION = "The user is reviewing this plan and asks a question about it.";

/** What a prompt Casper wrote itself was for ("verification repair 1/3"), or undefined for anything else. */
export function casperPromptLabel(text: string): string | undefined {
  for (const [opening, label] of OPENINGS) {
    const match = opening.exec(text);
    if (match) return label(match);
  }
  return undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
    && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("\n");
}

function said(data: unknown): ({ at: number } & Said) | undefined {
  const at = steeredAt(data);
  if (at === undefined) return undefined;
  const record = data as { by?: unknown; words?: unknown };
  if (record.by === "casper") return { at, by: "casper" };
  return record.by === "you" && typeof record.words === "string" ? { at, by: "you", words: record.words } : undefined;
}

/** A user-role message without a record: the person's words (a plan question's question, a task's request), or
 * Casper's own prompt when it opens as one did. */
function unrecorded(text: string): ConversationItem {
  const label = casperPromptLabel(text);
  if (label) return { kind: "casper", label, text };
  if (text.startsWith(PLAN_QUESTION)) {
    const at = text.lastIndexOf("\n\nQuestion: ");
    if (at !== -1) return { kind: "you", text: text.slice(at + "\n\nQuestion: ".length).trim() };
  }
  return { kind: "you", text: requestOf(text) };
}

/** The conversation from its saved entries, oldest first. */
export function conversationRecord(entries: readonly RecordEntry[]): ConversationItem[] {
  const steered = new Set<number>();
  const authors = new Map<number, Said>();
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const { customType, data } = entry as { customType: string; data?: unknown };
    const at = steeredAt(data);
    if (customType === STEERED_LINE_ENTRY && at !== undefined) steered.add(at);
    const record = customType === CASPER_SAID_ENTRY ? said(data) : undefined;
    if (record) authors.set(record.at, record);
  }
  const items: ConversationItem[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") {
      items.push({ kind: "compaction", summary: (entry as { summary: string }).summary.trim() });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = (entry as { message: { role: string; content?: unknown; timestamp?: number } }).message;
    const text = textOf(message.content);
    if (message.role === "assistant") { if (text.trim()) items.push({ kind: "answer", text: text.trim() }); continue; }
    if (message.role !== "user") continue;
    if (!text.trim()) continue;
    // A line typed during work is the person's, word for word.
    if (message.timestamp !== undefined && steered.has(message.timestamp)) { items.push({ kind: "you", text: text.trim() }); continue; }
    const by = message.timestamp === undefined ? undefined : authors.get(message.timestamp);
    if (by?.by === "you") items.push({ kind: "you", text: by.words.trim() });
    else if (by?.by === "casper") items.push({ kind: "casper", label: casperPromptLabel(text) ?? "a prompt", text: text.trim() });
    else items.push(unrecorded(text));
  }
  return items;
}
