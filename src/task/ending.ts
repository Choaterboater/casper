/**
 * How a task ended, read from the last words of the AI's last message: it asks you something, or it said what it does
 * next and stopped. Either way the task is not done, so a session shows one plain line instead of the receipt card
 * (whose verdict and numbered keys would read as a finished task, and as options to pick). Anything else is a task
 * that ended. Only the closing words count, so a question asked earlier in the message never does.
 */
import { taskOutcome, type ReceiptItem, type ReceiptView, type TaskResult } from "./result";

export type TaskEnding = "question" | "next";

const FENCE = /^\s*(?:```|~~~)/;
/** The model's open items: never options to pick from. */
const OPEN_ITEM = /^\s*(?:[-*+•]\s+)?(?:\*\*)?still not done:/i;
/** A line of a list: a bullet, a number or letter, or a checkbox some models still write. */
const LIST_ITEM = /^\s*(?:[-*+•]\s|\d{1,2}[.)]\s|[a-z][.)]\s|\[[ xX]\]\s)/;
/** A question that only closes a finished reply. */
const CLOSER = /^(?:(?:is there )?anything else\b|any (?:other |more |further )?questions\b|(?:does|did) (?:that|this) help\b)/i;
/** Words that ask the person to choose from the list under them ("Which one should I use:"). */
const CHOOSE = /\b(?:which|choose|pick|prefer|want me to|should I|shall I|would you like|do you want|let me know)\b/i;
/** Asked without a question mark: to reply, confirm or act, and say so. */
const REPLY = new RegExp([
  String.raw`\b(?:say|type|reply|send)\b.{0,60}\b(?:when|once)\b`,
  String.raw`\b(?:reply|answer) (?:with|yes|no)\b`,
  String.raw`\btell me (?:which|what|whether|when)\b`,
  String.raw`\b(?:tell me|let me know) if you(?:'d| would)? (?:like|want|prefer)\b`,
  String.raw`\blet me know (?:which|what|whether|when|once)\b`,
  String.raw`\blet me know if (?:I|we) should\b`,
  String.raw`^(?:please )?confirm\b`,
  String.raw`\bplease confirm\b`,
  String.raw`\bwaiting (?:for|on) (?:you|your)\b`,
  String.raw`\b(?:once|when) you(?:'ve| have|'re| are)\b.{0,80}\bI(?:'ll| will| can)\b`,
].join("|"), "i");
/** What the AI will do next, said as the last thing before it stopped. */
const NEXT = new RegExp([
  String.raw`^(?:next|now|then|after that|first|so),?\s+(?:I(?:'ll| will| am going to|'m going to)|let me)\b`,
  String.raw`^I(?:'ll| will) (?:now|next|then|go ahead|start|continue|proceed)\b`,
  String.raw`^I(?:'ll| will) (?:write|create|run|restart|install|set up|configure|update|add|fix|check|test|deploy|build|open|read|look|try|edit|change|apply)\b`,
  String.raw`^I'm (?:now |going to |about to )\w`,
  String.raw`^let me (?!know\b|be\b)\w`,
].join("|"), "i");

/** A sentence without the markdown, quotes and emoji around it. */
const bare = (text: string) => text.replace(/^[\s>*_#~`"'“‘(]+/, "").replace(/[\s*_~`'"”’»)\]\p{Extended_Pictographic}\uFE0F]+$/u, "");

/** "question" when the message's last words ask you something, "next" when they say what the AI does next; undefined
 * when it ended. Reads the last paragraph only, past a code block, the open items and a list of options under it. */
export function taskEnding(answer: string): TaskEnding | undefined {
  const lines = answer.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  const blank = (index: number) => !lines[index - 1]!.trim();
  const skipBlank = () => { while (end > 0 && blank(end)) end--; };
  skipBlank();
  // A command to run at the end: the words before it.
  if (end > 0 && FENCE.test(lines[end - 1]!)) {
    end--;
    while (end > 0 && !FENCE.test(lines[end - 1]!)) end--;
    end = Math.max(0, end - 1);
    skipBlank();
  }
  while (end > 0 && OPEN_ITEM.test(lines[end - 1]!)) { end--; skipBlank(); }
  // Options under the words: only those words can ask.
  let listed = false;
  while (end > 0 && LIST_ITEM.test(lines[end - 1]!)) { listed = true; end--; skipBlank(); }
  let start = end;
  while (start > 0 && !blank(start) && !LIST_ITEM.test(lines[start - 1]!) && !FENCE.test(lines[start - 1]!)) start--;
  const paragraph = lines.slice(start, end).map((line) => line.trim()).join(" ");
  const sentences = paragraph.split(/(?<=[.!?])\s+/).map(bare).filter(Boolean);
  const last = sentences.slice(-2);
  if (last.some((sentence) => sentence.endsWith("?") && !CLOSER.test(sentence))) return "question";
  if (listed) return CHOOSE.test(sentences.at(-1) ?? "") ? "question" : undefined;
  if (last.some((sentence) => REPLY.test(sentence))) return "question";
  if (last.some((sentence) => NEXT.test(sentence))) return "next";
  return undefined;
}

/** A sentence in a list item that asks: "…at a desk? That decides…", "…when you add the card?" ("Why?" in quotes doesn't). */
const ASKS = /\?[*_)"'”’\]]*(?:\s+[A-Z(*_"“]|\s*$)/;

/** The message ends with a list that asks the person things ("1. Do you mostly use this on a phone…?"), so a number
 * typed next would read as an answer. taskEnding reads only the words above a closing list, as options to choose from;
 * this reads the list itself. */
export function closingListAsks(answer: string): boolean {
  const lines = answer.replace(/\r\n?/g, "\n").split("\n");
  let asks = false;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    // An item, or a line that carries one on under it.
    if (!LIST_ITEM.test(line) && !/^\s+\S/.test(line)) break;
    if (ASKS.test(line)) asks = true;
  }
  return asks;
}

/** What this task changed, for "so far": its files, or that it changed something else (outside, another machine). */
export function changedSoFar(task: TaskResult): string | undefined {
  const files = new Set([...task.changedPaths ?? [], ...task.changedDuringChecks ?? []]).size;
  if (files) return `${files} ${files === 1 ? "file" : "files"} changed so far`;
  return task.outsideWrites?.length || task.outsideChanges?.length || task.published?.length || task.remoteChanges?.length || (!task.changedPaths && task.possibleMutations) ? "changes so far" : undefined;
}

/** The line a session shows instead of the card: the AI waits for your answer, or paused after saying what it does
 * next. It names where the changes so far are, since the card that ends the work comes later. */
export function endingLine(ending: TaskEnding, task: TaskResult): string {
  const head = ending === "question" ? "? Waiting for your answer" : "Paused — the AI said what it does next; say go, or tell it what to change";
  const changes = changedSoFar(task);
  return changes ? `${head} · ${task.receipt ? `/receipt ${task.receipt}` : "/receipt"} shows the ${changes}` : head;
}

/** A result the card must never hide behind the line: a failure, a stop, work that did not finish, a secret Casper
 * saw, or a risky config line (you would answer the AI without having seen it). */
export function mustStand(task: TaskResult): boolean {
  return ["failed", "cancelled", "incomplete"].includes(taskOutcome(task.verification, task))
    || Boolean(task.secretInCommand || task.secretInFiles?.length || task.riskyLines?.length);
}

/** The card would only say that nothing changed: no check ran, nothing changed here, outside or on another machine,
 * the branch stayed, and nothing needs you. The AI's message is then the whole result. */
export function quietReceipt(view: ReceiptView, task: TaskResult): boolean {
  return view.verdict?.status === "No files changed" && !task.branchMoved && !task.branchChangesUnknown
    && view.items.every((item) => item.section === "notes");
}

/** The card that ends the work, naming what changed before your answers, when the AI asked or paused first. */
export function withEarlierChanges(view: ReceiptView, held: readonly TaskResult[]): ReceiptView {
  if (!held.length) return view;
  const files = new Set(held.flatMap((task) => [...task.changedPaths ?? [], ...task.changedDuringChecks ?? []])).size;
  const receipts = held.flatMap((task) => task.receipt ? [`/receipt ${task.receipt}`] : []);
  const what = files ? `${files} ${files === 1 ? "file" : "files"}` : "other changes";
  const detail = `${what}${receipts.length ? ` (${receipts.join(", ")})` : ""}`;
  const item: ReceiptItem = { line: `– Also changed before your ${held.length === 1 ? "answer" : "answers"}: ${detail}`, section: "changed", kind: "changed",
    status: "Also changed before your answer", detail };
  const after = view.items.map((entry) => entry.section).lastIndexOf("changed");
  const at = after >= 0 ? after + 1 : view.items.findIndex((entry) => entry.section === "undo" || entry.section === "next");
  const items = [...view.items];
  items.splice(at < 0 ? items.length : at, 0, item);
  return { ...view, items };
}
