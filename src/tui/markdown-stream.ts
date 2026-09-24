import { type Component, Markdown, type MarkdownTheme, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { PANEL_MAX_COLUMNS, renderPanel } from "./presentation";

const INDENTED_CODE = /^(?: {4}|\t)/;
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})/;
const LIST_ITEM = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
/** Zero-width markers from StreamingMarkdown's theme wrapper: a border line's fence text follows
 * FENCE_BORDER_TAG, and each code line is CODE_LINE_TAG alone (its text is kept aside). Whatever
 * precedes a marker is the container prefix (list indent, quote border). */
const FENCE_BORDER_TAG = "\u0000\u0001\u0000";
const CODE_LINE_TAG = "\u0000\u0002\u0000";

/**
 * Index after the last `\n\n` whose following block cannot change how the prefix renders.
 * Streaming appends only re-parse after this point. A width change still renders the whole source.
 * Returns 0 when nothing is safe to reuse (open fence or math, indented-code continuation,
 * an unresolved reference link, or no completed block yet).
 */
export function stablePrefixEnd(text: string): number {
  if (!text.includes("\n\n")) return 0;
  const lines = text.split("\n");
  const realEnd = lines.length - (text.endsWith("\n") ? 1 : 0);
  let offset = 0;
  let fence: string | undefined;
  let math: "dollar" | "bracket" | undefined;
  let last = 0;
  let list = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const nextReal = index + 1 < realEnd;
    if (!fence && !math) {
      if (LIST_ITEM.test(line)) list = true;
      else if (/^[^\s]/.test(line) && index > 0 && lines[index - 1] === "") list = false;
    }
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
    } else if (math) {
      if (closesMath(line, math)) math = undefined;
    } else if (!singleLineMath(line)) {
      const opened = FENCE_OPEN.exec(line);
      if (opened) fence = opened[2]!;
      else if (/^ {0,3}\$\$/.test(line)) math = "dollar";
      else if (/^ {0,3}\\\[/.test(line)) math = "bracket";
    }
    if (!fence && !math && line === "" && nextReal) {
      const next = lines[index + 1]!;
      const previous = previousContent(lines, index);
      // A blank line between two indented lines is inside one code block. Splitting it
      // renders two fences. Any other completed break is stable once the next line is known.
      // An indented line after a break inside a list continues the open item (a nested fence or
      // paragraph), so the list is not complete yet.
      const continuesItem = list && /^[ \t]/.test(next);
      if (!continuesItem && !(previous !== undefined && INDENTED_CODE.test(previous) && INDENTED_CODE.test(next))) last = offset + 1;
    }
    if (index + 1 < lines.length) offset += line.length + 1;
  }
  return last > 0 && !hasUnresolvedRef(text.slice(0, last)) ? last : 0;
}

/** CommonMark: a closing fence is a run of the opening character at least as long as the opener. */
function closesFence(line: string, marker: string): boolean {
  const length = marker.length;
  return new RegExp(`^ {0,3}\\${marker[0]}{${length},}\\s*$`).test(line);
}

function singleLineMath(line: string): boolean {
  return /^ {0,3}\$\$.*\$\$\s*$/.test(line) || /^ {0,3}\\\[.*\\\]\s*$/.test(line);
}

function closesMath(line: string, kind: "dollar" | "bracket"): boolean {
  return kind === "dollar" ? line.includes("$$") : line.includes("\\]");
}

function previousContent(lines: string[], index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor--) if (lines[cursor]) return lines[cursor];
  return undefined;
}

/** A later definition can restyle an earlier reference. Those prefixes stay on the full render.
 * Brackets inside fenced code are not references and must not disable the cache. */
function hasUnresolvedRef(prefix: string): boolean {
  const prose = proseOutsideFences(prefix).replace(/`[^`\n]+`/g, "");
  const defined = new Set<string>();
  for (const match of prose.matchAll(/^ {0,3}\[([^\]]+)\]:[ \t]*\S/gm)) defined.add(match[1]!.toLowerCase());
  for (const match of prose.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
    if (!defined.has((match[2] || match[1]!).toLowerCase())) return true;
  }
  for (const match of prose.matchAll(/(^|[^!\w])\[([^\]\n]+)\](?![(\[])/g)) {
    if (!defined.has(match[2]!.toLowerCase())) return true;
  }
  return false;
}

function proseOutsideFences(prefix: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of prefix.split("\n")) {
    if (fence) { if (closesFence(line, fence)) fence = undefined; continue; }
    const opened = FENCE_OPEN.exec(line);
    if (opened) { fence = opened[2]!; continue; }
    kept.push(line);
  }
  return kept.join("\n");
}

/** Pi drops a trailing blank after some blocks and keeps it after others. Put the separator back. */
export function joinRendered(prefix: string[], suffix: string[]): string[] {
  if (!suffix.length) return prefix;
  if (prefix.length && prefix[prefix.length - 1] !== "" && suffix[0] !== "") return [...prefix, "", ...suffix];
  return [...prefix, ...suffix];
}

interface Cache {
  width: number;
  source: string;
  lines: string[];
  prefixEnd: number;
  prefixLines: string[];
}

/** Assistant Markdown that re-parses only the open tail. Output matches a full render; width changes do too. */
export class StreamingMarkdown implements Component {
  private source = "";
  private cache?: Cache;
  private readonly full: Markdown;
  private readonly scratch: Markdown;
  /** Styled code lines of the current render, in the order Pi emitted their CODE_LINE_TAGs. */
  private codeLines: string[] = [];

  constructor(private readonly color: boolean, theme: MarkdownTheme) {
    // Pi-tui renders code content verbatim, so rendered lines cannot distinguish a content
    // line starting with ``` from a real border (nested fences). Tag border lines; the tag
    // is consumed by boxFences and never reaches rendered output. Code lines become a
    // zero-width tag so Pi never wraps them; boxFences wraps the kept text once, at the
    // panel's inner width.
    const tagged: MarkdownTheme = {
      ...theme,
      codeBlockBorder: (text) => `${FENCE_BORDER_TAG}${theme.codeBlockBorder(text)}`,
      codeBlock: (text) => { this.codeLines.push(theme.codeBlock(text)); return CODE_LINE_TAG; },
    };
    this.full = new Markdown("", 0, 0, tagged);
    this.scratch = new Markdown("", 0, 0, tagged);
  }

  setText(text: string): void { this.source = text; }
  invalidate(): void { this.cache = undefined; this.full.invalidate(); this.scratch.invalidate(); }

  render(width: number): string[] {
    const text = this.source;
    const cached = this.cache;
    if (cached && cached.width === width && cached.source === text) return cached.lines;
    const extended = cached && cached.width === width && cached.prefixEnd > 0 && text.startsWith(cached.source);
    const prefixEnd = extended && !text.slice(cached.source.length).includes("\n\n")
      ? cached.prefixEnd
      : stablePrefixEnd(text);
    if (extended && prefixEnd >= cached.prefixEnd && text.startsWith(cached.source.slice(0, cached.prefixEnd))) {
      // Prefix lines are seeded on the first append after a full render, not during it, so a
      // width change stays one parse. Later appends reuse them.
      const prefixLines = !cached.prefixLines.length
        ? this.renderSlice(text.slice(0, prefixEnd), width)
        : prefixEnd === cached.prefixEnd
          ? cached.prefixLines
          : joinRendered(cached.prefixLines, this.renderSlice(text.slice(cached.prefixEnd, prefixEnd), width));
      const lines = joinRendered(prefixLines, this.renderSlice(text.slice(prefixEnd), width));
      this.cache = { width, source: text, lines, prefixEnd, prefixLines };
      return lines;
    }
    const lines = this.renderSlice(text, width);
    this.cache = { width, source: text, lines, prefixEnd: stablePrefixEnd(text), prefixLines: [] };
    return lines;
  }

  private renderSlice(text: string, width: number): string[] {
    if (!text) return [];
    const markdown = text === this.source ? this.full : this.scratch;
    markdown.setText(text);
    this.codeLines = [];
    const rendered = markdown.render(width).map(line => line.replace(/ +$/, ""));
    return boxFences(rendered, this.codeLines, width, this.color);
  }
}

/** Replaces each tagged fence with a panel. The panel sits after the container prefix Pi put in
 * front of the fence (list indent, `│ ` quote border), so the title is the bare info string and
 * the body is the source code, wrapped once. */
function boxFences(lines: string[], code: readonly string[], width: number, color: boolean): string[] {
  const out: string[] = [];
  let next = 0;
  let body: string[] = [];
  let title: string | undefined;
  let head = "";
  let margin: string | undefined;
  const prefix = (raw: string, at: number) => {
    const text = raw.slice(0, at);
    // A container style opened before the marker (quote italics) must not tint the border.
    return color && text.includes("\x1b") ? `${text}\x1b[0m` : text;
  };
  const flush = (closing: string) => {
    const rest = margin ?? closing;
    const panel = renderPanel(title || "code", body, Math.min(width - visibleWidth(head), PANEL_MAX_COLUMNS), color, "muted");
    out.push(...panel.map((row, index) => `${index ? rest : head}${row}`));
    body = [];
    title = undefined;
    margin = undefined;
  };
  for (const line of lines) {
    const border = line.indexOf(FENCE_BORDER_TAG);
    if (border >= 0) {
      if (title === undefined) {
        // Opening border: Pi writes ``` plus the language, whatever the source fence was.
        title = stripVTControlCharacters(line.slice(border + FENCE_BORDER_TAG.length)).replace(/^`+/, "").trim();
        head = prefix(line, border);
      } else flush(prefix(line, border));
      continue;
    }
    const tagged = line.indexOf(CODE_LINE_TAG);
    if (title === undefined) { if (tagged < 0) out.push(line); continue; }
    // Untagged rows inside a fence are Pi wrap artefacts of a prefix wider than the column.
    if (tagged < 0) continue;
    margin ??= prefix(line, tagged);
    body.push(code[next++] ?? "");
  }
  if (title !== undefined) flush(margin ?? head);
  return out;
}
