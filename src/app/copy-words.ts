/**
 * Copying what the AI wrote to paste: a command, a config, or a prompt to give another tool later. A mouse copy of a
 * quote took its "│" gutter along ("│ Upgrade my…" pasted into Casper); /copy took only code blocks. Now /copy n numbers
 * the answer's code and quote blocks together, the words "copy that" or "copy the prompt" copy its block with no model
 * call, and when the answer is mostly one such block the row under it offers to copy it (free). Only your key or your
 * words copy; nothing is copied on its own.
 */
import type { NextItem } from "../tui/next-row";

export interface PasteBlock { kind: "code" | "quote"; text: string; language?: string }

const FENCE = /^ {0,3}(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm;

/** The answer's code and quote blocks, in order: a fence's code as written, a quote's lines without their "> ". */
export function pasteBlocks(text: string): PasteBlock[] {
  const found: Array<PasteBlock & { at: number }> = [];
  const fences: Array<[number, number]> = [];
  for (const match of text.matchAll(FENCE)) {
    const language = match[2]!.trim().split(/\s+/)[0] || undefined;
    found.push({ kind: "code", text: match[3]!.replace(/\n$/, ""), ...(language ? { language } : {}), at: match.index });
    fences.push([match.index, match.index + match[0].length]);
  }
  // A run of lines that start with ">" outside any fence is one quote.
  let offset = 0;
  let quote: { at: number; lines: string[] } | undefined;
  const flush = () => { if (quote) found.push({ kind: "quote", text: quote.lines.join("\n").trim(), at: quote.at }); quote = undefined; };
  for (const line of text.split("\n")) {
    const inFence = fences.some(([start, end]) => offset >= start && offset < end);
    const quoted = !inFence && /^ {0,3}>/.test(line);
    if (quoted) { quote ??= { at: offset, lines: [] }; quote.lines.push(line.replace(/^ {0,3}> ?/, "")); }
    else flush();
    offset += line.length + 1;
  }
  flush();
  return found.filter((block) => block.text).sort((a, b) => a.at - b.at).map(({ at: _at, ...block }) => block);
}

/** The block an answer is mostly made of, meant for pasting: its only block, holding more words than the prose around it. */
export function mainBlock(answer: string): PasteBlock | undefined {
  const blocks = pasteBlocks(answer);
  if (blocks.length !== 1) return undefined;
  const block = blocks[0]!;
  const prose = answer.replace(FENCE, "").split("\n").filter((line) => !/^ {0,3}>/.test(line)).join(" ").replace(/\s+/g, " ").trim();
  return block.text.length >= Math.max(20, prose.length) ? block : undefined;
}

const SHELLS = /^(?:sh|bash|zsh|shell|console|powershell|pwsh|cmd|bat|fish)$/i;

/** "Copy the prompt", "Copy the command", "Copy the code": what the block is. */
export function copyLabel(block: PasteBlock): string {
  if (block.kind === "quote") return "Copy the prompt";
  return block.language && SHELLS.test(block.language) ? "Copy the command" : "Copy the code";
}

/** The row's step when the answer is mostly one block to paste. */
export function copyStep(answer: string): NextItem | undefined {
  const block = mainBlock(answer);
  return block ? { label: copyLabel(block), command: "/copy 1", note: "free" } : undefined;
}

const COPY_WORDS = /^(?:(?:please|pls|ok|okay|casper)[,\s]+)*copy\s+(?:that|it|this|the\s+(?:prompt|command|code|block|quote|snippet|config))(?:\s+for\s+me)?(?:\s+to\s+(?:the\s+)?clipboard)?$/i;

/** "/copy 1" when a typed line only asks to copy the answer's block ("copy that", "copy the prompt"); undefined otherwise.
 * A line with anything pasted never counts. */
export function copyRequest(line: string, pasted: readonly string[] = []): string | undefined {
  if (pasted.some(Boolean) || line.length > 60 || /[\r\n]/.test(line.trim())) return undefined;
  return COPY_WORDS.test(line.trim().replace(/\s*[.!]+$/, "")) ? "/copy 1" : undefined;
}
