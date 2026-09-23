import { stripVTControlCharacters } from "node:util";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { RuntimeEvent, RuntimeStatus } from "../runtime/types";

/** Prompt gutter glyphs. Idle accepts input; busy keeps the same width so the box never shifts. */
export const PROMPT_GLYPH = "❯";
export const BUSY_GLYPH = "…";

/** Controls, escapes and bidi overrides. Newlines and tabs are kept; a clean delta skips the sanitizer. */
const UNSAFE_TERMINAL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_TERMINAL_G = new RegExp(UNSAFE_TERMINAL.source, "gu");

/** Untrusted output cannot move the cursor, set a title, or conceal text with bidi controls. */
export function terminalText(text: string): string {
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
export function formatToolActivity(event: ToolEvent, elapsedMs?: number): string {
  // grep/find carry the pattern; otherwise the path, command, operation or check name is the target.
  const target = typeof event.input?.pattern === "string"
    ? [event.input.pattern, event.input.path].filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ")
    : event.input?.path ?? event.input?.command ?? event.input?.operation ?? event.input?.check;
  const preview = target ? ` · ${redactPreview(String(target)).replace(/\s+/g, " ").slice(0, 180)}` : "";
  const name = terminalText(event.toolName).slice(0, 80);
  if (event.type === "tool_start") return `• ${name}${preview} — running`;
  const elapsed = elapsedMs === undefined ? "" : ` · ${(elapsedMs / 1000).toFixed(1)}s`;
  // Native tool success is not a verifier pass or authoritative shell exit code.
  const status = event.isError ? "failed" : "completed";
  const detail = event.isError && event.output?.text
    ? `\n  ${redactPreview(event.output.text).replace(/\s+/g, " ").slice(0, 240)}${event.output.truncated ? " [truncated]" : ""}` : "";
  return `${event.isError ? "✗" : "✓"} ${name}${preview} — ${status}${elapsed}${detail}`;
}

/** `auto` effort is Casper's setting; the level after the arrow is what the classifier chose (or the
 * provisional level before the first request). A role tells where the model came from. */
export function formatEffort(status: RuntimeStatus): string | undefined {
  if (status.configuredEffort === "auto") {
    const state = status.autoEffort?.state;
    return `auto → ${status.thinkingLevel ? terminalText(status.thinkingLevel) : "—"}${state && state !== "classified" ? ` (${state})` : ""}`;
  }
  return status.thinkingLevel ? terminalText(status.thinkingLevel) : undefined;
}

export function formatRuntimeStatus(status?: RuntimeStatus): string {
  if (!status) return " model     not initialized (starts on your first prompt or /model)\n auth      not checked (/login to set up a provider)";
  const identity = status.provider && status.model ? `${status.provider} / ${status.model}` : "none selected";
  const effort = formatEffort(status);
  const role = status.modelRole ? ` · role ${terminalText(status.modelRole)}` : "";
  return ` model     ${terminalText(identity)}${effort ? ` · reasoning ${effort}` : ""}${role}\n auth      ${status.auth === "configured" ? "credentials configured (not a connection test)" : status.auth === "missing" ? "credentials missing; use /login" : "unknown; use /login"}${status.selectionSource ? `\n selection ${status.selectionSource}${status.defaultModel ? ` · Casper default ${terminalText(status.defaultModel.provider)}/${terminalText(status.defaultModel.id)}` : " · no Casper default"}` : ""}${status.blocked ? `\n [model]   ${terminalText(status.blocked)}` : ""}`;
}

/** One transcript line when the runtime starts on first use; /status keeps the labeled block. */
export function formatRuntimeStartLine(status: RuntimeStatus): string {
  const identity = status.provider && status.model ? `${terminalText(status.provider)}/${terminalText(status.model)}` : "no model selected (/model)";
  // /status carries the "not a connection test" qualifier; this line stays short enough for one row.
  const auth = status.auth === "configured" ? "credentials configured" : status.auth === "missing" ? "credentials missing (/login)" : "credentials unknown (/login)";
  const effort = formatEffort(status);
  return `[model] ${identity}${effort ? ` · ${effort}` : ""} · ${auth}`;
}
