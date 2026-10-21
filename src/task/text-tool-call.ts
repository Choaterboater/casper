/**
 * A small model sometimes WRITES a tool call as its answer instead of making one: the whole answer is a JSON object
 * like {"name":"bash","arguments":{...}}, alone, in one fenced block, or inside <tool_call>...</tool_call>. Nothing ran.
 * Casper only recognises this to say so; it never runs the text and never asks the model again.
 */
const NAME_KEYS = ["name", "tool", "function"] as const;
const ARGUMENT_KEYS = ["arguments", "parameters", "input"] as const;

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The text inside the one wrapper (a single fenced block or a <tool_call> pair) that makes up the whole answer. */
function unwrap(answer: string): string {
  const text = answer.trim();
  const tag = /^<tool_call>([\s\S]*)<\/tool_call>$/i.exec(text);
  if (tag && !/<\/?tool_call>/i.test(tag[1]!)) return unwrapFence(tag[1]!.trim()) ?? tag[1]!.trim();
  return unwrapFence(text) ?? text;
}

function unwrapFence(text: string): string | undefined {
  const fence = /^(`{3,}|~{3,})[ \t]*[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n?\1[ \t]*$/.exec(text);
  return fence && !fence[2]!.includes(fence[1]!) ? fence[2]!.trim() : undefined;
}

/** A call: a name (name, tool, or function as a name or as an object with one) beside its arguments. */
function toolCallShaped(value: unknown): boolean {
  if (!plainObject(value)) return false;
  const nested = value.function;
  if (plainObject(nested)) return toolCallShaped(nested);
  const named = NAME_KEYS.some((key) => typeof value[key] === "string" && (value[key] as string).trim() !== "");
  if (!named) return false;
  return ARGUMENT_KEYS.some((key) => {
    const given = value[key];
    if (plainObject(given)) return true;
    if (key !== "arguments" || typeof given !== "string") return false;
    try { return plainObject(JSON.parse(given)); } catch { return false; }
  });
}

/** True only when the entire answer is a tool call written as text; prose with JSON or code in it is not. */
export function isToolCallAsText(answer: string): boolean {
  const body = unwrap(answer);
  if (!body.startsWith("{") || !body.endsWith("}")) return false;
  try { return toolCallShaped(JSON.parse(body)); } catch { return false; }
}

/** The one line shown under the answer. */
export const TOOL_CALL_AS_TEXT_LINE = "This model wrote a tool call as text instead of using it, so nothing was done. Try a model that supports tools (/model).";

const TAGS = ["<tool_call>", "</tool_call>"] as const;

/** A model's words as the terminal shows them: a <tool_call> tag it wrote as text (Qwen through Ollama, "…for.<tool_call>")
 * is left out, with what it wraps (an unclosed one: the rest of that answer). Only the screen; the answer as written is
 * kept for the check above, and nothing in it is run. A tag split across deltas waits for the next one. */
export class ToolCallTags {
  private pending = "";
  private inside = false;

  push(delta: string): string {
    let text = this.pending + delta;
    this.pending = "";
    let shown = "";
    for (;;) {
      const lower = text.toLowerCase();
      if (this.inside) {
        const end = lower.indexOf(TAGS[1]);
        if (end === -1) { this.pending = text.slice(text.length - partialTag(lower, [TAGS[1]])); return shown; }
        text = text.slice(end + TAGS[1].length);
        this.inside = false;
        continue;
      }
      const found = TAGS.map((tag) => lower.indexOf(tag)).filter((at) => at !== -1);
      if (!found.length) {
        const keep = partialTag(lower, TAGS);
        this.pending = text.slice(text.length - keep);
        return shown + text.slice(0, text.length - keep);
      }
      const at = Math.min(...found);
      shown += text.slice(0, at);
      const open = lower.startsWith(TAGS[0], at);
      this.inside = open;
      text = text.slice(at + (open ? TAGS[0] : TAGS[1]).length);
    }
  }

  /** The end of an answer: words held back for a tag that never came, and a fresh start for the next answer. */
  end(): string {
    const rest = this.inside ? "" : this.pending;
    this.pending = "";
    this.inside = false;
    return rest;
  }
}

/** How many characters at the end of `text` could begin one of `tags`. */
function partialTag(text: string, tags: readonly string[]): number {
  let longest = 0;
  for (const tag of tags) for (let size = Math.min(tag.length - 1, text.length); size > longest; size--) {
    if (text.endsWith(tag.slice(0, size))) { longest = size; break; }
  }
  return longest;
}
