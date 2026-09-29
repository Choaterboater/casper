import { stripVTControlCharacters } from "node:util";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { RuntimeEvent, RuntimeStatus } from "../runtime/types";

/** Prompt gutter glyphs. Idle accepts input; busy keeps the same width so the box never shifts. */
export const PROMPT_GLYPH = "❯";
export const BUSY_GLYPH = "…";

/** Controls, escapes and bidi overrides. Newlines and tabs are kept; a clean delta skips the sanitizer. */
const UNSAFE_TERMINAL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_TERMINAL_G = new RegExp(UNSAFE_TERMINAL.source, "gu");

/** U+FE0F asks for the emoji form of a text-default symbol (⚠️ ✔️ ➡️ 1️⃣). Terminals disagree on its width:
 * iTerm2 and xterm.js draw the pair in one cell, others in two, and Pi's layout counts two, so boxes and
 * tables around it drift a column per symbol. Without the selector the layout and every terminal agree
 * on one cell. Kept before U+200D, where it belongs to a joined emoji sequence. */
const EMOJI_PRESENTATION = /\uFE0F(?!\u200D)/g;

/** Control-bearing text: C0/C1 controls other than newline and tab, or a bidi override. */
export function hasTerminalControls(text: string): boolean { return UNSAFE_TERMINAL.test(text); }

/** Untrusted output cannot move the cursor, set a title, conceal text with bidi controls or throw off
 * the layout's cell count. */
export function terminalText(text: string): string {
  if (text.includes("\uFE0F")) text = text.replace(EMOJI_PRESENTATION, "");
  if (!UNSAFE_TERMINAL.test(text)) return text;
  UNSAFE_TERMINAL_G.lastIndex = 0;
  return stripVTControlCharacters(text).replace(UNSAFE_TERMINAL_G,
    (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

/** Conservative display-only redaction, not a general secret detector. Never used for evidence. */
export function redactPreview(text: string): string {
  return terminalText(text)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/\b(Bearer|Basic)\s+[^\s'";]+/gi, "$1 <redacted>")
    .replace(/((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[\w-]*)["']?\s*(?:=|:|\s)\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;&]+)/gi, "$1<redacted>")
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,}|AKIA[A-Z0-9]{16})\b/g, "<redacted>");
}

export function paint(text: string, code: string, color: boolean): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** Assistant Markdown theme: accent for structure, dim for borders. With color off every function is identity. */
export function markdownTheme(color: boolean): MarkdownTheme {
  const style = (code: string) => (text: string) => paint(text, code, color);
  const accent = style("36");
  const dim = style("2");
  return {
    heading: style("1;36"), link: accent, linkUrl: dim, code: accent, codeBlock: accent, codeBlockBorder: dim, codeBlockIndent: "",
    quote: dim, quoteBorder: dim, hr: dim, listBullet: accent,
    bold: style("1"), italic: style("3"), strikethrough: style("9"), underline: style("4"),
  };
}

type ToolEvent = Extract<RuntimeEvent, { type: "tool_start" | "tool_end" }>;
/** `root`: paths under it print relative to it. `width`: the first line fits it, shortening the target
 * from the front (a path keeps its file name), so a narrow terminal shows one row per tool, not a wrapped
 * path broken mid-word. */
export function formatToolActivity(event: ToolEvent, elapsedMs?: number, fit: { root?: string; width?: number } = {}): string {
  const relative = (value: unknown) => typeof value === "string" && fit.root && value.startsWith(`${fit.root}/`) ? value.slice(fit.root.length + 1) : value;
  // grep/find carry the pattern; otherwise the path, command, operation or check name is the target.
  const target = typeof event.input?.pattern === "string"
    ? [event.input.pattern, relative(event.input.path)].filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ")
    : relative(event.input?.path) ?? event.input?.command ?? event.input?.operation ?? event.input?.check;
  const text = target ? redactPreview(String(target)).replace(/\s+/g, " ").slice(0, 180) : "";
  const name = terminalText(event.toolName).slice(0, 80);
  // A path keeps its end (the file name); a command or pattern keeps its start.
  const isPath = typeof event.input?.pattern !== "string" && typeof event.input?.path === "string";
  const room = (rest: string) => fit.width === undefined ? Infinity : fit.width - 1 - [...`✓ ${name} · `].length - [...rest].length;
  const shorten = (rest: string) => {
    if (!text) return "";
    const chars = [...text], space = Math.max(4, room(rest));
    return ` · ${chars.length <= space ? text : isPath ? `…${chars.slice(chars.length - space + 1).join("")}` : `${chars.slice(0, space - 1).join("")}…`}`;
  };
  // Narrow: the ✓/•/✗ already says the state, so the words go before the target is cut short.
  const line = (full: string, compact: string) => !text || [...text].length <= room(full) || room(compact) < 4 ? `${shorten(full)}${full}` : `${shorten(compact)}${compact}`;
  if (event.type === "tool_start") return `• ${name}${line(" — running", "")}`;
  const elapsed = elapsedMs === undefined ? "" : ` · ${(elapsedMs / 1000).toFixed(1)}s`;
  // Native tool success is not a verifier pass or authoritative shell exit code.
  const status = event.isError ? "failed" : "completed";
  const detail = event.isError && event.output?.text
    ? `\n  ${redactPreview(event.output.text).replace(/\s+/g, " ").slice(0, 240)}${event.output.truncated ? " [truncated]" : ""}` : "";
  const size = event.lines ? ` · +${event.lines.added} -${event.lines.removed}` : "";
  return `${event.isError ? "✗" : "✓"} ${name}${line(`${size} — ${status}${elapsed}`, `${size}${elapsed}`)}${detail}`;
}

/** `auto` effort is Casper's setting; the level after the arrow is what the classifier chose (or the
 * provisional level before the first request). A role tells where the model came from. */
export function formatEffort(status: RuntimeStatus): string | undefined {
  if (status.configuredEffort === "auto") {
    const state = status.autoEffort?.state;
    // "pending" is before the first request, when Casper picks the level for that request.
    const note = state === "pending" ? " for now; your first request picks the level" : state && state !== "classified" ? ` (${state})` : "";
    return `auto → ${status.thinkingLevel ? terminalText(status.thinkingLevel) : "—"}${note}`;
  }
  return status.thinkingLevel ? terminalText(status.thinkingLevel) : undefined;
}

/** Before the runtime starts, `saved` is the advisory saved-default display (modelPreference);
 * credentials are not read then, so auth is only promised for startup. */
export function formatRuntimeStatus(status?: RuntimeStatus, saved?: string): string {
  if (!status && saved) return ` model     ${terminalText(saved)} (starts on your first prompt; /model to change)\n auth      checked when the model starts`;
  if (!status) return " model     none saved yet (/model picks one, or your first prompt offers sign-in)\n auth      checked when the model starts (/login adds a provider)";
  const identity = status.provider && status.model ? `${status.provider} / ${status.model}` : "none selected";
  const effort = formatEffort(status);
  const role = status.modelRole ? ` · role ${terminalText(status.modelRole)}` : "";
  return ` model     ${terminalText(identity)}${effort ? ` · effort ${effort}` : ""}${role}\n auth      ${status.auth === "configured" ? "credentials configured (not a connection test)" : status.auth === "missing" ? "credentials missing; use /login" : "unknown; use /login"}${status.selectionSource ? `\n selection ${status.selectionSource}${status.defaultModel ? ` · Casper default ${terminalText(status.defaultModel.provider)}/${terminalText(status.defaultModel.id)}` : " · no Casper default"}` : ""}${status.blocked ? `\n [model]   ${terminalText(status.blocked)}` : ""}`;
}

/** One transcript line when the runtime starts on first use; /status keeps the labeled block. */
export function formatRuntimeStartLine(status: RuntimeStatus): string {
  const identity = status.provider && status.model ? `${terminalText(status.provider)}/${terminalText(status.model)}` : "no model selected (/model)";
  // /status carries the "not a connection test" qualifier; this line stays short enough for one row.
  const auth = status.auth === "configured" ? "credentials configured" : status.auth === "missing" ? "credentials missing (/login)" : "credentials unknown (/login)";
  const effort = formatEffort(status);
  return `[model] ${identity}${effort ? ` · ${effort}` : ""} · ${auth}`;
}
