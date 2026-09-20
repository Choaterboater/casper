import { stripVTControlCharacters } from "node:util";
import type { RuntimeEvent, RuntimeStatus } from "../runtime/types";

/** Untrusted output cannot move the cursor, set a title, or conceal text with bidi controls. */
export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

/** Conservative display-only redaction, not a general secret detector. Never used for evidence. */
export function redactPreview(text: string): string {
  return terminalText(text)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/\b(Bearer|Basic)\s+[^\s'";]+/gi, "$1 <redacted>")
    .replace(/((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[\w-]*)["']?\s*(?:=|:|\s)\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;&]+)/gi, "$1<redacted>")
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,}|AKIA[A-Z0-9]{16})\b/g, "<redacted>");
}

export function paint(text: string, code: string, color: boolean): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** Line-oriented Markdown; fenced code stays literal. No links/escape codes are executed. */
export class MarkdownFormatter {
  private fence = false;
  constructor(private readonly color: boolean) {}
  reset(): void { this.fence = false; }
  line(source: string, commit = true): string {
    const text = terminalText(source);
    if (/^\s*```/.test(text)) {
      if (commit) this.fence = !this.fence;
      return paint(text, "2", this.color);
    }
    if (this.fence) return paint(text, "36", this.color);
    if (/^#{1,6}\s/.test(text)) return paint(text, "1;36", this.color);
    return text.replace(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g,
      (span) => paint(span, span.startsWith("`") ? "36" : "1", this.color));
  }
}

type ToolEvent = Extract<RuntimeEvent, { type: "tool_start" | "tool_end" }>;
export function formatToolActivity(event: ToolEvent, elapsedMs?: number): string {
  const target = event.input?.path ?? event.input?.command ?? event.input?.operation;
  const preview = target ? ` · ${redactPreview(target).replace(/\s+/g, " ").slice(0, 180)}` : "";
  const name = terminalText(event.toolName).slice(0, 80);
  if (event.type === "tool_start") return `• ${name}${preview} — running`;
  const elapsed = elapsedMs === undefined ? "" : ` · ${(elapsedMs / 1000).toFixed(1)}s`;
  // Native tool success is not a verifier pass or authoritative shell exit code.
  const status = event.isError ? "failed" : "completed";
  const detail = event.isError && event.output?.text
    ? `\n  ${redactPreview(event.output.text).replace(/\s+/g, " ").slice(0, 240)}${event.output.truncated ? " [truncated]" : ""}` : "";
  return `${event.isError ? "✗" : "✓"} ${name}${preview} — ${status}${elapsed}${detail}`;
}

export function formatRuntimeStatus(status?: RuntimeStatus): string {
  if (!status) return " model     not initialized · auth not checked (starts on /model or your first prompt; /login for setup)";
  const identity = status.provider && status.model ? `${status.provider} / ${status.model}` : "none selected";
  return ` model     ${terminalText(identity)}${status.thinkingLevel ? ` · reasoning ${terminalText(status.thinkingLevel)}` : ""}\n auth      ${status.auth === "configured" ? "credentials configured (not a connection test)" : status.auth === "missing" ? "credentials missing; use /login" : "unknown; use /login"}${status.selectionSource ? `\n selection ${status.selectionSource}${status.defaultModel ? ` · Casper default ${terminalText(status.defaultModel.provider)}/${terminalText(status.defaultModel.id)}` : " · no Casper default"}` : ""}${status.blocked ? `\n [model]   ${terminalText(status.blocked)}` : ""}`;
}
