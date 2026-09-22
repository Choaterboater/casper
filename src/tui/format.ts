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

/** Style status labels, never infer verification from a tool's completion. */
export function styleOutput(text: string, color: boolean): string {
  return terminalText(text).split("\n").map(line => {
    const code = /^(?:\[error\]|Tool failed:)/.test(line) ? "31"
      : /^(?:Tool running:|\[(?:warning|cancel[^\]]*|input|skills)\])/.test(line) ? "33"
      : /^Tool completed:/.test(line) ? "36"
      : /^CASPER/.test(line) ? "1;36" : undefined;
    return code ? paint(line, code, color) : line;
  }).join("\n");
}

type ToolEvent = Extract<RuntimeEvent, { type: "tool_start" | "tool_end" }>;
  const actions: Record<string, string> = {
    read: "Read file", write: "Write file", edit: "Edit file", bash: "Run command",
    grep: "Search file contents", find: "Find files", ls: "List directory",
    list_capabilities: "List available capabilities", call_capability: "Call capability",
  };
export function formatToolActivity(event: ToolEvent, elapsedMs?: number): string {
  const action = Object.hasOwn(actions, event.toolName) ? actions[event.toolName] : `Run tool ${terminalText(event.toolName)}`;
  const target = event.input?.path ?? event.input?.command ?? event.input?.operation;
  const elapsed = elapsedMs === undefined ? "" : ` · ${(elapsedMs / 1000).toFixed(1)}s`;
  // Native tool completion is neither a verifier pass nor a shell exit code.
  const state = event.type === "tool_start" ? "running" : event.isError ? "failed" : "completed";
  const lines = [`Tool ${state}: ${action}${event.type === "tool_end" ? elapsed : ""}`];
  if (target) lines.push(`  Target: ${redactPreview(target)}`);
  if (event.type === "tool_end" && event.isError && event.output) {
    if (event.output.text) lines.push(`  Error: ${redactPreview(event.output.text)}`);
    if (event.output.truncated) lines.push("  [truncated] Tool output is incomplete.");
  }
  return lines.join("\n");
}

export function formatRuntimeStatus(status?: RuntimeStatus): string {
  if (!status) return "Model: not initialized · choose /model or send a message\nAuth: not checked · /login to set up credentials";
  const identity = status.provider && status.model ? `${status.provider} / ${status.model}` : "none selected";
  return [
    `Model: ${terminalText(identity)}${status.thinkingLevel && status.configuredEffort !== "auto" ? ` · reasoning ${terminalText(status.thinkingLevel)}` : ""}`,
    ...(status.modelRole ? [`Role: ${terminalText(status.modelRole)}`] : []),
    ...(status.configuredEffort === "auto" ? [
      `Effort: auto · actual ${terminalText(status.thinkingLevel ?? "unavailable")}`,
      `Auto classification: ${status.autoEffort?.state === "classified" ? "classified for the current request"
        : status.autoEffort?.state === "fallback" ? "fallback · classification failed or timed out; retained supported effort"
        : status.autoEffort?.state === "unavailable" ? "unavailable · automatic effort cannot be applied"
        : "pending · awaiting the next request"}${status.autoEffort?.classifier ? ` · classifier ${terminalText(status.autoEffort.classifier)}` : ""}`,
    ] : []),
    `Auth: ${status.auth === "configured" ? "credentials configured (not a connection test)" : status.auth === "missing" ? "credentials missing · use /login" : "unknown · use /login"}`,
    ...(status.selectionSource ? [`Selection: ${terminalText(status.selectionSource)}${status.defaultModel ? ` · Casper default ${terminalText(status.defaultModel.provider)}/${terminalText(status.defaultModel.id)}` : " · no Casper default"}`] : []),
    ...(status.blocked ? [`Unavailable: ${terminalText(status.blocked)}`] : []),
  ].join("\n");
}
