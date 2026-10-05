import { homedir } from "node:os";
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

/** Every C0/C1 control (newline and tab too) and bidi control: what one line of shown text may never hold. */
const LINE_UNSAFE = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
const LINE_UNSAFE_G = new RegExp(LINE_UNSAFE.source, "g");

/** One line of untrusted text (a receipt line, a label, a reason): each control or bidi character becomes a space,
 * so it cannot move the cursor, break the line or reorder what is shown. The one place this set is kept. */
export function lineText(text: string): string { return text.replace(LINE_UNSAFE_G, " "); }

/** True when text holds a character lineText would replace: not a plain one-line value. */
export function hasLineControls(text: string): boolean { return LINE_UNSAFE.test(text); }

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
  // "<secret hidden>", from Casper's own scrub, stays as it is: "secret hidden>" is not a secret's value.
  return terminalText(text).split(HIDDEN).map((part) => redactPart(part)).join(HIDDEN);
}

const HIDDEN = "<secret hidden>";
const HIDDEN_WORD = "<secret\u00a0hidden>";

function redactPart(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/\b(Bearer|Basic)\s+[^\s'";]+/gi, "$1 <redacted>")
    // `pveum user token add`, `token list`: a command word after "token" is not its value.
    .replace(/((?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[\w-]*)["']?\s*(?:=|:|\s)\s*)(?!(?:add|create|list|remove|delete|modify|show|get|set|info|generate|revoke)(?:\s|$))(?:"[^"\n]*"|'[^'\n]*'|[^\s;&'"][^\s;&]*)/gi, "$1<redacted>")
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

/** Shell wrappers that come before the program itself. */
const COMMAND_WRAPPERS = new Set(["sudo", "env", "time", "nohup", "exec", "command", "nice"]);
/** ssh, scp and sftp options that take a value, so the value is not taken for the host. */
const REMOTE_VALUE_FLAGS = new Set(["-p", "-P", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-E", "-e", "-m", "-O", "-Q", "-S", "-W", "-w"]);

/** A shell command as a short label: the program and what it acts on ("git status", "ssh root@lab",
 * "python3 -m pytest …"), at most `max` characters. Leading `cd dir &&` and `VAR=value` are left out;
 * a trailing "…" says more was cut. /output shows the whole command. */
export function commandLabel(command: string, max = 80): string {
  // A hidden secret is one word here, so "-p <secret hidden>" never leaves "hidden>" as the program.
  const text = command.replace(/\s+/g, " ").trim().replaceAll(HIDDEN, HIDDEN_WORD);
  const segments = text.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  if (!segments.length) return "";
  let index = 0;
  while (index < segments.length - 1 && /^(?:cd|pushd|export|set|source|\.)(?:\s|$)/.test(segments[index]!)) index++;
  const words = segments[index]!.split(" ").map(word => word.replace(/^["']|["']$/g, ""));
  let first = 0;
  for (;;) {
    while (first < words.length - 1 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[first]!) || COMMAND_WRAPPERS.has(words[first]!))) first++;
    // sshpass carries a password (-p) before the real program: skip it and its options, never show the value.
    if (words[first] !== "sshpass" || first >= words.length - 1) break;
    first++;
    while (first < words.length - 1 && words[first]!.startsWith("-")) first += /^-[pfdP]$/.test(words[first]!) ? 2 : 1;
  }
  const program = words[first]!.split("/").pop() || words[first]!;
  const rest = words.slice(first + 1);
  let used: number;
  let label: string;
  if (/^python[\d.]*$/.test(program) && rest[0] === "-m" && rest[1]) { label = `${program} -m ${rest[1]}`; used = 2; }
  else {
    const remote = ["ssh", "scp", "sftp"].includes(program);
    let at = 0;
    // A download names its address, wherever it sits among the options.
    const address = ["curl", "wget"].includes(program) ? rest.findIndex(word => /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) : -1;
    if (address >= 0) at = address;
    else while (at < rest.length && (rest[at]!.startsWith("-") || rest[at] === HIDDEN_WORD)) at += remote && REMOTE_VALUE_FLAGS.has(rest[at]!) ? 2 : 1;
    const target = rest[at];
    label = target ? `${program} ${target}` : program;
    used = target ? at + 1 : rest.length;
  }
  const more = used < rest.length || index < segments.length - 1;
  label = label.replaceAll(HIDDEN_WORD, HIDDEN);
  const chars = [...label];
  if (chars.length > max - 2) return `${chars.slice(0, max - 1).join("")}…`;
  return more ? `${label} …` : label;
}

/** Elapsed time worth showing: none under a second, "4.2s" under a minute, "3m05s" after. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 1000) return "";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, "0")}s`;
}

/** `root`: paths under it print relative to it; `home` (default the real one) shortens other paths to ~.
 * `width`: the line fits it. */
export interface ToolLineFit { root?: string; width?: number; home?: string }
/** docs.example.com/x for https://docs.example.com/x: the scheme says nothing a reader needs. */
function webAddress(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/^https?:\/\//i, "") : undefined;
}
/** Under the project: relative to it. Elsewhere under home: ~/... Otherwise as given. */
export function displayPath(value: string, fit: Pick<ToolLineFit, "root" | "home"> = {}): string {
  if (fit.root && value === fit.root) return ".";
  if (fit.root && value.startsWith(`${fit.root}/`)) return value.slice(fit.root.length + 1);
  const home = fit.home ?? homedir();
  if (home && home !== "/" && (value === home || value.startsWith(`${home}/`))) return `~${value.slice(home.length)}`;
  return value;
}
/** What a call acted on: grep/find's pattern (and folder), else the path, command, operation, check,
 * web address or search. `label` turns a shell command into its short label (see commandLabel). */
export function toolTarget(input: ToolEvent["input"], fit: ToolLineFit = {}, label?: (command: string) => string): string | undefined {
  const relative = (value: unknown) => typeof value === "string" ? displayPath(value, fit) : undefined;
  const command = typeof input?.command === "string" ? label ? label(input.command) : input.command : undefined;
  return typeof input?.pattern === "string"
    ? [input.pattern, relative(input.path)].filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ")
    : relative(input?.path) ?? command ?? input?.operation ?? input?.check ?? webAddress(input?.url) ?? input?.query;
}

/** `root`: paths under it print relative to it (others under home as ~/...). `width`: the first line fits it,
 * shortening the target from the front (a path keeps its file name), so a narrow terminal shows one row per
 * tool, not a wrapped path broken mid-word. A shell command shows as a short label (see commandLabel). */
export function formatToolActivity(event: ToolEvent, elapsedMs?: number, fit: ToolLineFit = {}): string {
  const target = toolTarget(event.input, fit, command => commandLabel(redactPreview(command)));
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
  if (event.type === "tool_start") return `• ${name}${line("", "")}`;
  const duration = formatDuration(elapsedMs);
  const elapsed = duration ? ` · ${duration}` : "";
  // Native tool success is not a verifier pass or authoritative shell exit code. The ✓ says it finished.
  const detail = event.isError && event.output?.text
    ? `\n  ${redactPreview(event.output.text).replace(/\s+/g, " ").slice(0, 240)}${event.output.truncated ? " [truncated]" : ""}` : "";
  // A casper_check skip never ran: neither ✓ nor ✗.
  if (!event.isError && event.toolName === "casper_check" && /[{,]"status":"skip"/.test(event.output?.text ?? "")) return `• ${name}${line(` — skipped${elapsed}`, elapsed)}`;
  const size = event.lines ? ` · +${event.lines.added} -${event.lines.removed}` : "";
  return `${event.isError ? "✗" : "✓"} ${name}${line(`${size}${event.isError ? " — failed" : ""}${elapsed}`, `${size}${elapsed}`)}${detail}`;
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
