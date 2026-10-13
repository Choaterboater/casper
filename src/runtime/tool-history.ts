import type { Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

export const TOOL_HISTORY_ENTRY = "casper.tool-history";
export const TOOL_HISTORY_KEEP_TURNS = 4;
export const TOOL_HISTORY_CHECKPOINT_TURNS = 8;
export const TOOL_HISTORY_MIN_CHARS = 8_000;
/** A checkpoint rebuilds the cache from its first stub, which only pays back over many later requests. So hiding
 * waits for real weight: hideable output of 20% of the window (and eight new rounds), or a prompt past 60% of it
 * (with 5% hideable), where hiding also puts off compaction. Either way it hides at least as much as the rebuild
 * re-reads after the first stub, so one checkpoint takes several reads at once. Short tasks never pay a rebuild. */
export const TOOL_HISTORY_HIDE_SHARE = 0.2;
export const TOOL_HISTORY_FULL_SHARE = 0.6;
export const TOOL_HISTORY_FULL_HIDE_SHARE = 0.05;
const DEFAULT_WINDOW = 128_000;
const IMAGE_TOKENS = 1_200;
const tokensOf = (message: Message) => Math.ceil(textOf(message).length / 4)
  + (typeof message.content === "string" ? 0 : message.content.filter((part) => part.type === "image").length * IMAGE_TOKENS);
export interface ToolHistoryWindow { contextWindow?: number }

interface Mask { key: string; text: string; imagesOnly: boolean }
export interface ToolHistoryCheckpoint { turns: number; epoch: string; masks: Mask[] }
const keyOf = (message: ToolResultMessage) => `${message.toolCallId}:${message.timestamp}`;
const textOf = (message: Message): string => typeof message.content === "string" ? message.content
  : message.content.map((part) => part.type === "text" ? part.text : part.type === "thinking" ? part.thinking
    : part.type === "toolCall" ? JSON.stringify(part.arguments) : "").join("\n");
const oneLine = (text: string) => text.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").slice(0, 160);

/** A provider-only projection. The transcript, tool calls, errors and user pictures are never changed.
 * Each checkpoint records only new masks; replaying the branch restores the same bytes, even with hiding off.
 * A checkpoint invalidates the cache once from its first changed result, not on every subsequent request. */
export class ToolHistory {
  private turns = 0;
  private epoch?: string;
  private readonly masks = new Map<string, Mask>();

  restore(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const record = data as Partial<ToolHistoryCheckpoint>;
    if (!Number.isSafeInteger(record.turns) || record.turns! < 0 || !Array.isArray(record.masks)) return;
    this.turns = record.turns!;
    this.epoch = typeof record.epoch === "string" ? record.epoch : undefined;
    for (const mask of record.masks) {
      if (mask && typeof mask.key === "string" && typeof mask.text === "string" && mask.text.length <= 512
        && typeof mask.imagesOnly === "boolean" && !this.masks.has(mask.key)) this.masks.set(mask.key, mask);
    }
  }

  project(messages: Message[], enabled = true, window: ToolHistoryWindow = {}): { messages: Message[]; checkpoint?: ToolHistoryCheckpoint } {
    const assistants = messages.flatMap((message, index) => message.role === "assistant" ? [index] : []);
    const turns = assistants.length;
    const first = messages[assistants[0]!] as Extract<Message, { role: "assistant" }> | undefined;
    const epoch = first ? JSON.stringify([first.timestamp, first.responseId ?? "", first.content.find((part) => part.type === "toolCall")?.id ?? ""]) : "";
    let checkpoint: ToolHistoryCheckpoint | undefined;
    // Persist the epoch reset too: Pi restores this projection afresh before every provider request.
    if (turns < this.turns || (this.epoch !== undefined && epoch !== this.epoch)) {
      this.turns = 0;
      checkpoint = { turns: 0, epoch, masks: [] };
    }
    this.epoch = epoch;
    if (enabled && turns > TOOL_HISTORY_KEEP_TURNS) {
      const boundary = assistants[turns - TOOL_HISTORY_KEEP_TURNS]!;
      let latestUser = -1;
      for (let index = messages.length - 1; index >= 0; index--) if (messages[index]!.role === "user") { latestUser = index; break; }
      const references = messages.filter((message, index) => (index >= boundary || index === latestUser)
        && (message.role === "user" || message.role === "assistant")).map(textOf).join("\n");
      const calls = new Map<string, ToolCall>();
      const masks: Mask[] = [];
      let hideable = 0;
      let first = -1;
      for (const [index, message] of messages.slice(0, boundary).entries()) {
        if (message.role === "assistant") {
          for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, part);
          continue;
        }
        if (message.role !== "toolResult" || message.isError || this.masks.has(keyOf(message))) continue;
        const call = calls.get(message.toolCallId);
        if (!call || !eligible(message) || referenced(message, call, references)) continue;
        const imagesOnly = message.toolName === "browser" && call.arguments.action !== "screenshot";
        const target = typeof call.arguments.path === "string" ? call.arguments.path
          : typeof call.arguments.command === "string" ? call.arguments.command
            : typeof call.arguments.action === "string" ? call.arguments.action : "";
        const recall = message.toolName === "bash" || message.toolName === "powershell" ? "re-run only if safe to see it" : "re-run to see it";
        const mask = { key: keyOf(message), imagesOnly,
          text: `[${imagesOnly ? "screenshots" : "output"} of ${oneLine(message.toolName)}${target ? ` ${oneLine(target)}` : ""} hidden, ${recall}]` };
        masks.push(mask);
        if (first < 0) first = index;
        hideable += imagesOnly ? message.content.filter((part) => part.type === "image").length * IMAGE_TOKENS : tokensOf(message);
      }
      const size = window.contextWindow && window.contextWindow > 0 ? window.contextWindow : DEFAULT_WINDOW;
      const weighty = turns >= this.turns + TOOL_HISTORY_CHECKPOINT_TURNS && hideable >= size * TOOL_HISTORY_HIDE_SHARE;
      const full = hideable >= size * TOOL_HISTORY_FULL_HIDE_SHARE
        && promptTokens(this.apply(messages)) >= size * TOOL_HISTORY_FULL_SHARE;
      const rebuilt = () => this.apply(messages, new Map([...this.masks, ...masks.map((mask) => [mask.key, mask] as const)]))
        .slice(first + 1).reduce((sum, message) => sum + tokensOf(message), 0);
      if (masks.length && (weighty || full) && hideable >= rebuilt()) {
        for (const mask of masks) this.masks.set(mask.key, mask);
        checkpoint = { turns, epoch, masks };
        this.turns = turns;
      }
    }
    return { messages: this.apply(messages), ...(checkpoint ? { checkpoint } : {}) };
  }

  private apply(messages: Message[], masks = this.masks): Message[] {
    return messages.map((message) => {
      if (message.role !== "toolResult") return message;
      const mask = masks.get(keyOf(message));
      if (!mask) return message;
      return { ...message, content: [...(mask.imagesOnly ? message.content.filter((part) => part.type !== "image") : []),
        { type: "text" as const, text: mask.text }] };
    });
  }
}

/** What the next request would send: the last reply's reported prompt plus what came after it, as Pi counts it
 * for compaction; an estimate from characters (the leading system message included) when no usage was reported. */
function promptTokens(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") continue;
    const usage = message.usage;
    const reported = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    if (reported > 0) return reported + messages.slice(index + 1).reduce((sum, next) => sum + tokensOf(next), 0);
    break;
  }
  return messages.reduce((sum, message) => sum + tokensOf(message), 0);
}

function eligible(message: ToolResultMessage): boolean {
  if (message.toolName === "browser") return message.content.some((part) => part.type === "image");
  if (!["read", "bash", "powershell"].includes(message.toolName)) return false;
  if (message.toolName !== "read" && /\b(?:fail(?:ed|ure)?|error|timed? out|aborted|killed|stopped|exited with code|unfinished|running in (?:the )?background|still running|moved to (?:the )?background)\b/i.test(textOf(message))) return false;
  return message.content.some((part) => part.type === "image") || textOf(message).length >= TOOL_HISTORY_MIN_CHARS;
}

/** Conservative observable references, not a claim to read the model's mind: keep names, quoted lines,
 * source identifiers and vague references to earlier output. Hidden results stay hidden; a fresh read recalls them. */
function referenced(message: ToolResultMessage, call: ToolCall, references: string): boolean {
  if (/\b(?:previous|earlier|above|that|this|last)\s+(?:tool\s+)?(?:output|result|read|command|screenshot|image)\b/i.test(references)) return true;
  if (references.includes(message.toolCallId)) return true;
  for (const name of [call.arguments.path, call.arguments.command]) if (typeof name === "string" && name.length > 0) {
    if (references.includes(name)) return true;
    const basename = name.split(/[\\/]/).at(-1)!;
    if (basename.length >= 4 && references.includes(basename)) return true;
  }
  if (message.content.some((part) => part.type === "image") && /\b(?:screenshot|image|picture|layout|visual)\b/i.test(references)) return true;
  const output = textOf(message);
  if (output.split("\n").some((line) => line.trim().length >= 24 && references.includes(line.trim()))) return true;
  const words = new Set(references.match(/\b[A-Za-z_$][\w$]{5,}\b/g) ?? []);
  return (output.match(/\b[A-Za-z_$][\w$]{5,}\b/g) ?? []).some((word) =>
    (/[a-z][A-Z]|_|[A-Za-z]\d/.test(word) || /^[A-Z\d]+$/.test(word)) && words.has(word));
}
