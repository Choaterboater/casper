/**
 * A task cut short (decision 108): Casper stopped (it crashed or was killed, the computer restarted, its window closed)
 * while the AI's last steps were running. Pi saves the AI's message with its tool calls before they run, and each
 * result only when it ends, so those steps have none. On the next request the model reads "No result provided" (an
 * error) for each, and may repeat a push or a migration that did run. A stop you made (Esc) is not cut short: Pi
 * records that turn as aborted. Nothing here calls a model.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { conversationRecord, type RecordEntry } from "./record";
import { lineText } from "../tui/format";
import { processAlive } from "../jobs/store";

/** A step with no result: its tool, and what it ran or touched ("git push origin main", "src/db.ts"). */
export interface UnansweredCall { tool: string; text: string }

/** The cut-short turn: its saved entry (one note an entry), its steps with no result, and the request it worked on. */
export interface CutShort { entry: string; calls: UnansweredCall[]; request?: string }

/** The saved entries this reads: Pi's session entries (others are passed over). */
export interface BranchEntry {
  type: string; id?: string; parentId?: string | null;
  message?: { role?: string; content?: unknown; stopReason?: string; toolCallId?: string };
}

/** The words Casper sends when you pick the start's "Go on with the task that was cut short": the note goes alone. */
export const CUT_SHORT_GO_ON = "Go on with the task that was cut short.";

const CALL_TEXT_MAX = 160;
const NOTE_CALLS = 8;

const oneLine = (text: string, max: number) => {
  const line = lineText(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What a call ran or touched, in one line: its command, path or address, or else its arguments. */
function callText(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const fields = args as Record<string, unknown>;
  const main = ["command", "cmd", "path", "file_path", "url", "name", "query"].map((key) => fields[key])
    .find((value): value is string => typeof value === "string" && value.trim() !== "");
  if (main !== undefined) return oneLine(main, CALL_TEXT_MAX);
  try { const text = JSON.stringify(args); return text === "{}" ? "" : oneLine(text, CALL_TEXT_MAX); } catch { return ""; }
}

function toolCalls(content: unknown): Array<{ id: string; name: string; arguments?: unknown }> {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is { type: "toolCall"; id: string; name: string; arguments?: unknown } =>
    Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "toolCall"
    && typeof (part as { id?: unknown }).id === "string" && typeof (part as { name?: unknown }).name === "string");
}

/** The conversation's branch (oldest first) ends on a turn cut short: the AI's last message asked for steps, some have
 * no result, and nothing came after them (no request, no answer). An aborted or failed message is not one: Esc stopped
 * it, or its steps never ran. */
export function cutShortTurn(branch: readonly BranchEntry[]): CutShort | undefined {
  const answered = new Set<string>();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    // A message Casper or an extension added starts a turn, as a request does.
    if (entry.type === "custom_message" || entry.type === "branch_summary") return undefined;
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "toolResult") { if (typeof message.toolCallId === "string") answered.add(message.toolCallId); continue; }
    if (message.role === "system") continue;
    if (message.role !== "assistant" || !entry.id) return undefined;
    if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
    const calls = toolCalls(message.content).filter((call) => !answered.has(call.id));
    if (!calls.length) return undefined;
    const request = conversationRecord(branch.slice(0, index) as RecordEntry[]).filter((item) => item.kind === "you").at(-1)?.text;
    return { entry: entry.id, calls: calls.map((call) => ({ tool: call.name, text: callText(call.arguments) })),
      ...(request?.trim() ? { request: request.trim() } : {}) };
  }
  return undefined;
}

/** The branch Pi opens a saved file on: from its last entry back through each one's parent. */
function branchOf(entries: readonly BranchEntry[]): BranchEntry[] {
  const listed = entries.filter((entry) => entry.type !== "session" && typeof entry.id === "string");
  const byId = new Map(listed.map((entry) => [entry.id!, entry]));
  const branch: BranchEntry[] = [];
  const seen = new Set<string>();
  for (let entry = listed.at(-1); entry && !seen.has(entry.id!); entry = entry.parentId ? byId.get(entry.parentId) : undefined) {
    seen.add(entry.id!);
    branch.push(entry);
  }
  return branch.reverse();
}

/** While a request runs, a small file beside its conversation holds the number of the Casper process running it. A
 * conversation another Casper is still working in looks just like one cut short (its steps are saved before they run),
 * so it is one only when no live process holds this mark: Casper closed without taking it away. */
export function runningMark(file: string): string { return `${file}.running`; }

/** Marks the conversation as being worked in by this process; the returned function takes the mark away. */
export function markRunning(file: string | undefined): () => void {
  if (!file) return () => {};
  const mark = runningMark(file);
  // The conversation's folder exists once Pi keeps it; a conversation it doesn't keep has no mark.
  try { writeFileSync(mark, String(process.pid), { mode: 0o600 }); } catch { return () => {}; }
  return () => { try { if (readFileSync(mark, "utf8").trim() === String(process.pid)) rmSync(mark, { force: true }); } catch { /* gone already */ } };
}

/** Another live Casper is working in this conversation now (its mark names a live process that isn't this one). */
export function runningElsewhere(file: string, alive = processAlive): boolean {
  let pid: number;
  try { pid = Number(readFileSync(runningMark(file), "utf8").trim()); } catch { return false; }
  return pid !== process.pid && alive(pid);
}

/** A saved conversation file's cut-short turn, read without starting a runtime; undefined when unreadable, or while
 * another Casper is working in it. */
export async function readCutShort(file: string): Promise<CutShort | undefined> {
  try {
    if (runningElsewhere(file)) return undefined;
    const entries = parseSessionEntries(await readFile(file, "utf8"));
    migrateSessionEntries(entries);
    return cutShortTurn(branchOf(entries as unknown as BranchEntry[]));
  } catch { return undefined; }
}

/** The note before the next request in a cut-short conversation, sent once. `alone`: it is the whole request (the
 * start's row), so it asks to go on. */
export function cutShortNote(cut: CutShort, alone = false): string {
  const one = cut.calls.length === 1;
  const shown = cut.calls.slice(0, NOTE_CALLS).map((call) => `- ${call.tool}${call.text ? `: ${call.text}` : ""}`);
  return [
    `Casper note: Casper closed while ${one ? "this step was" : "these steps were"} running (it crashed, was closed, or the computer restarted), so ${one ? "it has" : "they have"} no result:`,
    ...shown,
    ...(cut.calls.length > NOTE_CALLS ? [`- and ${cut.calls.length - NOTE_CALLS} more`] : []),
    `"No result provided" doesn't mean ${one ? "it" : "they"} failed: ${one ? "it" : "each"} may have run, or may still be running. Before you repeat a step that changes something (a push, a migration, a deploy, a write), check whether it already happened.`,
    ...(alone ? ["Then go on with the task."] : []),
  ].join("\n");
}

/** The tools that have no result, for a line on screen: "bash", "bash and write", "bash, edit and write". */
export function cutShortTools(cut: CutShort): string {
  const names = [...new Set(cut.calls.map((call) => oneLine(call.tool, 40)))];
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** The line /continue, /resume and --continue print when the conversation they open was cut short. */
export function cutShortLine(cut: CutShort): string {
  return `[session] Its last task was cut short while ${cutShortTools(cut)} ${cut.calls.length === 1 ? "was" : "were"} running; the AI checks before repeating a step.`;
}

/** The request the cut-short task worked on, for the start's row. */
export function cutShortPreview(cut: CutShort, max = 50): string | undefined {
  const text = cut.request ? oneLine(cut.request, max) : "";
  return /\p{L}/u.test(text) ? text : undefined;
}
