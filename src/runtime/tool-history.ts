import type { JsonObject, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

export const TOOL_HISTORY_ENTRY = "casper.tool-history";
export const TOOL_HISTORY_KEEP_TURNS = 4;
export const TOOL_HISTORY_CHECKPOINT_TURNS = 8;
export const TOOL_HISTORY_MIN_CHARS = 8_000;
/** A file body the AI sent (write content, edit text, a `cat > file <<EOF` body) is on disk, so a smaller one may go. */
export const TOOL_HISTORY_MIN_BODY_CHARS = 2_000;
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
export interface ToolHistoryWindow {
  contextWindow?: number;
  /** Casper itself starts this round (repair, review, proof, finish checks): hide without waiting for the
   * fifth-of-the-window or 60%-full mark, if at least 5% of the window goes and it outweighs the rebuild. */
  followUp?: boolean;
}

interface Mask { key: string; text: string; imagesOnly: boolean }
export interface ToolHistoryCheckpoint { turns: number; epoch: string; masks: Mask[] }
const keyOf = (message: ToolResultMessage) => `${message.toolCallId}:${message.timestamp}`;
/** Body masks key the call in its assistant message; results never start with this prefix. */
const bodyKeyOf = (call: ToolCall, timestamp: number) => `body:${call.id}:${timestamp}`;
const textOf = (message: Message): string => typeof message.content === "string" ? message.content
  : message.content.map((part) => part.type === "text" ? part.text : part.type === "thinking" ? part.thinking
    : part.type === "toolCall" ? JSON.stringify(part.arguments) : "").join("\n");
const stringsOf = (value: unknown): string => typeof value === "string" ? value
  : value && typeof value === "object" ? Object.values(value).map(stringsOf).join("\n") : "";
const oneLine = (text: string) => text.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").slice(0, 160);

/** A provider-only projection. The transcript, errors and user pictures are never changed; an old tool call
 * keeps its tool and path and only loses a file body the file on disk holds.
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
      // Recent tool calls unescaped too, so an edit quoting a line of an old body is seen as a reference to it.
      const bodyReferences = `${references}\n${messages.slice(boundary).flatMap((message) => message.role === "assistant"
        ? message.content.flatMap((part) => part.type === "toolCall" ? [stringsOf(part.arguments)] : []) : []).join("\n")}`;
      const calls = new Map<string, { call: ToolCall; index: number; timestamp: number }>();
      const masks: Mask[] = [];
      let hideable = 0;
      let first = -1;
      for (const [index, message] of messages.slice(0, boundary).entries()) {
        if (message.role === "assistant") {
          for (const part of message.content) if (part.type === "toolCall") calls.set(part.id, { call: part, index, timestamp: message.timestamp });
          continue;
        }
        if (message.role !== "toolResult" || message.isError) continue;
        const sent = calls.get(message.toolCallId);
        if (!sent) continue;
        const { call } = sent;
        const body = fileBody(call);
        const bodyKey = bodyKeyOf(call, sent.timestamp);
        if (body && body.text.length >= TOOL_HISTORY_MIN_BODY_CHARS && !this.masks.has(bodyKey) && !bodyReferenced(call, body, bodyReferences)) {
          const mask = { key: bodyKey, imagesOnly: false, text: body.stub };
          const saved = JSON.stringify(call.arguments).length - JSON.stringify(stubArguments(call, mask.text)).length;
          if (saved > 0) {
            masks.push(mask);
            hideable += Math.ceil(saved / 4);
            if (first < 0 || sent.index < first) first = sent.index;
          }
        }
        if (this.masks.has(keyOf(message)) || !eligible(message) || referenced(message, call, references)) continue;
        const imagesOnly = message.toolName === "browser" && call.arguments.action !== "screenshot";
        const target = typeof call.arguments.path === "string" ? call.arguments.path
          : typeof call.arguments.command === "string" ? call.arguments.command
            : typeof call.arguments.action === "string" ? call.arguments.action : "";
        const recall = message.toolName === "bash" || message.toolName === "powershell" ? "re-run only if safe to see it" : "re-run to see it";
        const mask = { key: keyOf(message), imagesOnly,
          text: `[${imagesOnly ? "screenshots" : "output"} of ${oneLine(message.toolName)}${target ? ` ${oneLine(target)}` : ""} hidden, ${recall}]` };
        masks.push(mask);
        if (first < 0 || index < first) first = index;
        hideable += imagesOnly ? message.content.filter((part) => part.type === "image").length * IMAGE_TOKENS : tokensOf(message);
      }
      const size = window.contextWindow && window.contextWindow > 0 ? window.contextWindow : DEFAULT_WINDOW;
      const weighty = turns >= this.turns + TOOL_HISTORY_CHECKPOINT_TURNS && hideable >= size * TOOL_HISTORY_HIDE_SHARE;
      const full = hideable >= size * TOOL_HISTORY_FULL_HIDE_SHARE
        && promptTokens(this.apply(messages)) >= size * TOOL_HISTORY_FULL_SHARE;
      const followUp = window.followUp === true && hideable >= size * TOOL_HISTORY_FULL_HIDE_SHARE;
      const rebuilt = () => this.apply(messages, new Map([...this.masks, ...masks.map((mask) => [mask.key, mask] as const)]))
        .slice(first + 1).reduce((sum, message) => sum + tokensOf(message), 0);
      if (masks.length && (weighty || full || followUp) && hideable >= rebuilt()) {
        for (const mask of masks) this.masks.set(mask.key, mask);
        checkpoint = { turns, epoch, masks };
        this.turns = turns;
      }
    }
    return { messages: this.apply(messages), ...(checkpoint ? { checkpoint } : {}) };
  }

  private apply(messages: Message[], masks = this.masks): Message[] {
    return messages.map((message) => {
      if (message.role === "assistant") {
        if (!message.content.some((part) => part.type === "toolCall" && masks.has(bodyKeyOf(part, message.timestamp)))) return message;
        return { ...message, content: message.content.map((part) => {
          const mask = part.type === "toolCall" ? masks.get(bodyKeyOf(part, message.timestamp)) : undefined;
          return part.type === "toolCall" && mask ? { ...part, arguments: stubArguments(part, mask.text) } : part;
        }) };
      }
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

interface FileBody { path: string; text: string; stub: string }
const HEREDOC_START = /^(?:[^\n<]*?(?:&&|;)\s*)?cat\s+(?:>>?\s*["']?([^\s'";&|<>]+)["']?\s+<<-?\s*(["']?)(\w+)\2|<<-?\s*(["']?)(\w+)\4\s+>>?\s*["']?([^\s'";&|<>]+)["']?)\s*$/;
const lineCount = (text: string) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** The file body a successful call left on disk: write content, edit text, or the body of one `cat > file <<EOF`
 * command (the command line and its closing line stay). Anything else is not a file body. A stub copied back into
 * a file is caught as a placeholder (src/runtime/elision.ts). */
function fileBody(call: ToolCall): FileBody | undefined {
  const args = call.arguments;
  const path = typeof args.path === "string" ? args.path : "";
  if (call.name === "write" && path && typeof args.content === "string") {
    return { path, text: args.content, stub: `[content of write ${oneLine(path)} (${lineCount(args.content)} lines) hidden, read the file before editing it]` };
  }
  if (call.name === "edit" && path) {
    const edits = typeof args.edits === "string" ? [args.edits] : Array.isArray(args.edits) ? args.edits : [];
    const parts = [...edits, ...(typeof args.oldText === "string" || typeof args.newText === "string" ? [args] : [])];
    const text = parts.map((edit) => typeof edit === "string" ? edit : edit && typeof edit === "object"
      ? ["oldText", "newText"].map((key) => { const value = Reflect.get(edit, key); return typeof value === "string" ? value : ""; }).join("\n") : "").join("\n");
    const count = typeof args.edits === "string" ? "the" : String(parts.length);
    return { path, text, stub: `[text of ${count} ${parts.length === 1 ? "replacement" : "replacements"} in edit ${oneLine(path)} hidden, read the file before editing it]` };
  }
  if (call.name === "bash" && typeof args.command === "string") {
    const heredoc = heredocBody(args.command);
    if (heredoc) return { path: heredoc.path, text: heredoc.body, stub: `[content of ${oneLine(heredoc.path)} (${lineCount(heredoc.body)} lines) hidden, read the file before editing it]` };
  }
  return undefined;
}

function heredocBody(command: string): { path: string; head: string; body: string; tail: string } | undefined {
  const lines = command.replace(/\s+$/, "").split("\n");
  const start = HEREDOC_START.exec(lines[0]!);
  if (!start || lines.length < 3) return undefined;
  const path = start[1] ?? start[6]!;
  const delimiter = start[3] ?? start[5]!;
  const tail = lines.at(-1)!;
  const body = lines.slice(1, -1);
  if (tail.trim() !== delimiter || body.some((line) => line.trim() === delimiter)) return undefined;
  return { path, head: lines[0]!, body: body.join("\n"), tail };
}

function stubArguments(call: ToolCall, stub: string): JsonObject {
  const args = call.arguments;
  if (call.name === "write") return { ...args, content: stub };
  if (call.name === "edit") {
    const { oldText: _oldText, newText: _newText, ...rest } = args;
    return { ...rest, edits: [{ oldText: "[hidden]", newText: stub }] };
  }
  const heredoc = typeof args.command === "string" ? heredocBody(args.command) : undefined;
  return heredoc ? { ...args, command: `${heredoc.head}\n${stub}\n${heredoc.tail}` } : args;
}

/** A body stays while the latest rounds name its file, quote one of its lines, or point back at an earlier write;
 * shared library words are not a reference, because the file on disk can always be read again. */
function bodyReferenced(call: ToolCall, body: FileBody, references: string): boolean {
  if (/\b(?:previous|earlier|above|last|original|old)\s+(?:write|edit|version|contents?|body)\b/i.test(references)) return true;
  if (references.includes(call.id) || references.includes(body.path)) return true;
  const basename = body.path.split(/[\\/]/).at(-1)!;
  if (basename.length >= 4 && references.includes(basename)) return true;
  return body.text.split("\n").some((line) => line.trim().length >= 24 && references.includes(line.trim()));
}
