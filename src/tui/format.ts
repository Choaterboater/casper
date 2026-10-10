import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { RuntimeEvent, RuntimeStatus } from "../runtime/types";
import { roleCode, type ThemeRole } from "./theme";

/** Prompt gutter glyphs. Idle accepts input; busy keeps the same width so the box never shifts. */
export const PROMPT_GLYPH = "❯";
/** Each mark at the start of a line means one thing. `•`: running now (a step, Casper's own checks, the prompt
 * while Casper works). ✓ done, ✗ failed. */
export const BUSY_GLYPH = "•";
/** Did not run: a step Casper stopped or refused before it ran, a skipped check. */
export const NOT_RUN_GLYPH = "○";
/** A note: something to know that is neither done nor failed (not verified, not checked, a retry). */
export const NOTE_GLYPH = "–";

/** Controls, escapes and bidi overrides. Newlines and tabs are kept; a clean delta skips the sanitizer. */
const UNSAFE_TERMINAL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_TERMINAL_G = new RegExp(UNSAFE_TERMINAL.source, "gu");

/** U+FE0F asks for the emoji form of a text-default symbol (⚠️ ✔️ ➡️ 1️⃣). Terminals disagree on its width:
 * iTerm2 and xterm.js draw the pair in one cell, others in two, and Pi's layout counts two, so boxes and
 * tables around it drift a column per symbol. Without the selector the layout and every terminal agree
 * on one cell. Kept before U+200D, where it belongs to a joined emoji sequence. */
const EMOJI_PRESENTATION = /\uFE0F(?!\u200D)/g;

/** Every C0/C1 control (newline and tab too), every bidi control (the marks ALM, LRM and RLM as well as the embeddings,
 * overrides and isolates) and the line and paragraph separators: what one line of shown text may never hold. */
const LINE_UNSAFE = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
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
  // A carriage return is a line end (CRLF from Windows and ssh output, or a progress bar redrawing its line), not a
  // control to show as "\u{d}": CRLF is one line break and a lone CR is a line break too.
  if (text.includes("\r")) text = text.replace(/\r\n?/g, "\n");
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

const SECRET_WORD = String.raw`[\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[\w-]*`;
const NOT_COMMAND = String.raw`(?!(?:add|create|list|remove|delete|modify|show|get|set|info|generate|revoke)(?:\s|$))`;
const VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s;&'"][^\s;&]*)`;

function redactPart(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/\b(Bearer|Basic)\s+[^\s'";]+/gi, "$1 <redacted>")
    // `pveum user token add`, `token list`: a command word after "token" is not its value.
    // name=value or name: value.
    .replace(new RegExp(`((?:${SECRET_WORD})["']?\\s*[=:]\\s*)${NOT_COMMAND}${VALUE}`, "gi"), "$1<redacted>")
    // --password value, -token value. A plain word after the name ("Unexpected token u") is not a value.
    .replace(new RegExp(`((?<![\\w-])--?(?:${SECRET_WORD})\\s+)${NOT_COMMAND}${VALUE}`, "gi"), "$1<redacted>")
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{8,}|github_pat_[\w]{8,}|AKIA[A-Z0-9]{16})\b/g, "<redacted>");
}

export function paint(text: string, code: string, color: boolean): string {
  return color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** Text in a role's colour from the theme in use (src/tui/theme.ts), after `style` (bold is "1"). A role in the
 * terminal's own text colour with no style adds nothing. The theme is read on each call, so a change shows at once. */
export function tint(text: string, role: ThemeRole, color: boolean, style?: string): string {
  const code = roleCode(role);
  const codes = style && code ? `${style};${code}` : style || code;
  return codes ? paint(text, codes, color) : text;
}

/** Assistant Markdown theme: accent for structure, muted and border for the rest. With color off every function is identity. */
export function markdownTheme(color: boolean): MarkdownTheme {
  const style = (code: string) => (text: string) => paint(text, code, color);
  const role = (name: ThemeRole, bold?: string) => (text: string) => tint(text, name, color, bold);
  const accent = role("accent");
  const muted = role("muted");
  const border = role("border");
  return {
    heading: role("accent", "1"), link: accent, linkUrl: muted, code: accent, codeBlock: accent, codeBlockBorder: border, codeBlockIndent: "",
    quote: muted, quoteBorder: border, hr: border, listBullet: accent,
    bold: style("1"), italic: style("3"), strikethrough: style("9"), underline: style("4"),
  };
}

type ToolEvent = Extract<RuntimeEvent, { type: "tool_start" | "tool_end" }>;

/** Shell wrappers that come before the program itself, each with its options that take a value ("sudo -u root",
 * "nice -n 10"): the wrapper's options and their values are not taken for the program. */
const COMMAND_WRAPPERS = new Map([["sudo", /^-[ugChDpUrtRT]$/], ["env", /^-[uCSP]$/], ["time", /^-[of]$/], ["nohup", /^$/],
  ["exec", /^-a$/], ["command", /^$/], ["nice", /^-n$/]]);
/** ssh, scp and sftp options that take a value, so the value is not taken for the host. */
const REMOTE_VALUE_FLAGS = new Set(["-p", "-P", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-E", "-e", "-m", "-O", "-Q", "-S", "-W", "-w"]);

/** Commands of a script that only set things up, print a heading or leave a loop: a label names the programs that do the work. */
const SETUP_COMMAND = /^(?:cd|pushd|popd|export|set|unset|source|\.|echo|printf|true|false|:|break|continue|[A-Za-z_][A-Za-z0-9_]*=\S*|\d*[<>]\S*)(?:\s|$)/;
/** Shell words that open or close a loop or test: the command after one is what runs. */
const SHELL_KEYWORD = /^(?:do|then|else|elif|if|while|until|!|\{)(?:\s+|$)/;
const SHELL_HEADER = /^(?:for|select|case|done|fi|esac|\}|function)(?:\s|$)|^[A-Za-z_][A-Za-z0-9_]*\s*\(\)/;

/** One command of a script: its text before any pipe, and a heredoc's body line count when it reads one. */
interface ScriptCommand { text: string; heredoc?: number }

/** Spaces, tabs and line ends; never the no-break space inside a hidden secret's word. */
const SPACES = /[ \t\n\r\f\v]+/g;

/** A script split into its commands at newlines, `;`, `&&`, `||` and subshell brackets, outside quotes and `$(…)`.
 * A heredoc's body is counted, not split. A pipeline keeps only its first program. */
function scriptCommands(script: string): ScriptCommand[] {
  const commands: ScriptCommand[] = [];
  const lines = script.replace(/\r\n?/g, "\n").split("\n");
  let current = "";
  let piped = false;
  let heredoc: { end: string; dash: boolean } | undefined;
  // Quotes and `$(…)` may run over several lines.
  let quote: "'" | "\"" | undefined;
  let depth = 0;
  const add = (text: string) => { if (!piped) current += text; };
  const push = (body?: number) => {
    let text = current.replace(SPACES, " ").trim();
    while (SHELL_KEYWORD.test(text)) text = text.replace(SHELL_KEYWORD, "");
    if (text && !SHELL_HEADER.test(text)) commands.push(body === undefined ? { text } : { text, heredoc: body });
    current = ""; piped = false;
  };
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    for (let at = 0; at < line.length; at++) {
      const char = line[at]!;
      if (quote) {
        if (char === "\\" && quote === "\"") { add(char + (line[at + 1] ?? "")); at++; continue; }
        if (char === quote) quote = undefined;
        add(char);
        continue;
      }
      if (char === "\\") { add(char + (line[at + 1] ?? "")); at++; continue; }
      if (char === "'" || char === "\"") { quote = char; add(char); continue; }
      if (depth > 0) {
        if (char === "(") depth++;
        if (char === ")") depth--;
        add(char);
        continue;
      }
      if (char === "#" && (at === 0 || /\s/.test(line[at - 1]!))) break;
      // `$(…)` stays inside its command; a bare `(…)` or `{ …; }` subshell is split like the rest of the script.
      if (char === "(" && line[at - 1] === "$") { depth++; add(char); continue; }
      if (char === "(" || char === ")") { push(); continue; }
      const two = line.slice(at, at + 2);
      if (two === "&&" || two === "||") { push(); at++; continue; }
      if (char === ";") { push(); continue; }
      if (char === "|") { piped = true; continue; }
      const here = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line.slice(at));
      if (here) { heredoc = { end: here[3]!, dash: here[1] === "-" }; add("<<HEREDOC"); at += here[0].length - 1; continue; }
      add(char);
    }
    // An open quote or `$(`, or a line ending in a backslash, carries on to the next line.
    if (quote || depth > 0) { add(" "); continue; }
    if (/(?<!\\)\\$/.test(current)) { current = `${current.slice(0, -1)} `; continue; }
    if (heredoc) {
      const { end, dash } = heredoc;
      heredoc = undefined;
      let body = 0;
      while (row + 1 < lines.length && (dash ? lines[row + 1]!.trim() : lines[row + 1]) !== end) { row++; body++; }
      if (row + 1 < lines.length) row++;
      push(body);
      continue;
    }
    push();
  }
  push();
  return commands;
}

/** A shell command as a short label: the program and what it acts on ("git status", "ssh root@lab",
 * "python3 -m pytest …"), at most `max` characters. Leading `cd dir &&` and `VAR=value` are left out;
 * a trailing "…" says more was cut. A script of several commands names its programs ("git status, git log, bun test"),
 * leaving out `cd`, `export`, `echo` headings, loop words and comments; a heredoc script reads "python3 script (12 lines)".
 * /output shows the whole command. */
export function commandLabel(command: string, max = 80): string {
  if (/[\n;&|<()]/.test(command)) {
    // A hidden secret is one word here, so "-p <secret hidden>" never leaves "hidden>" as the program.
    const commands = scriptCommands(command.replaceAll(HIDDEN, HIDDEN_WORD))
      .filter(entry => !SETUP_COMMAND.test(entry.text) || entry.heredoc !== undefined);
    if (commands.length > 1 || commands.some(entry => entry.heredoc !== undefined)) {
      const labels = [...new Set(commands.map(entry => {
        if (entry.heredoc === undefined) return singleLabel([entry.text], max, false);
        const lines = `(${entry.heredoc} ${entry.heredoc === 1 ? "line" : "lines"})`;
        const write = /^cat\b[^>]*>\s*(\S+)/.exec(entry.text.replace("<<HEREDOC", ""));
        if (write) return `write ${write[1]!.replace(/^["']|["']$/g, "")} ${lines}`;
        const program = singleLabel([entry.text.replace(/\s*<<HEREDOC.*$/, "")], max, false).split(" ")[0] || "script";
        return `${program} script ${lines}`;
      }).filter(Boolean))];
      return fitLabels(labels, max).replaceAll(HIDDEN_WORD, HIDDEN);
    }
    // One program among headings and set-up, or inside a loop or subshell: that program, not the script's first word.
    if (commands.length === 1) {
      const label = singleLabel([commands[0]!.text], max, true);
      const wrapped = /^(?:for|while|until|if|case|select)\s|^[({]/.test(command.trim()) && !label.endsWith("…");
      return (wrapped ? fitLabels([`${label} …`], max) : label).replaceAll(HIDDEN_WORD, HIDDEN);
    }
  }
  const text = command.replace(/\s+/g, " ").trim().replaceAll(HIDDEN, HIDDEN_WORD);
  return singleLabel(text.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean), max, true).replaceAll(HIDDEN_WORD, HIDDEN);
}

/** "git status, git log, bun test", or as many as fit with "+N more", in at most `max` characters. */
function fitLabels(labels: readonly string[], max: number): string {
  for (let shown = labels.length; shown > 0; shown--) {
    const more = labels.length - shown;
    const text = `${labels.slice(0, shown).join(", ")}${more ? ` +${more} more` : ""}`;
    if ([...text].length <= max) return text;
  }
  const first = [...labels[0] ?? ""];
  return first.length > max ? `${first.slice(0, max - 1).join("")}…` : first.join("");
}

/** A command (its `&&`, `;` and `|` parts) as its label. `more`: say "…" when words or commands were cut. */
function singleLabel(segments: readonly string[], max: number, more: boolean): string {
  if (!segments.length) return "";
  let index = 0;
  while (index < segments.length - 1 && /^(?:cd|pushd|export|set|source|\.)(?:\s|$)/.test(segments[index]!)) index++;
  // Shell words: quotes and an escaped space keep a space inside one word ("Google Chrome.app"). Only the ASCII space
  // splits, so a hidden secret's word (with its no-break space) stays one word. A backslash escapes only a space or a
  // quote; anywhere else, a pair (\\server) included, it is kept as typed: PowerShell paths use it (src\app.ts).
  const words = (segments[index]!.match(/(?:"[^"]*"?|'[^']*'?|\\[ "'\\]|[^ "'\\]+|\\)+/g) ?? [""])
    .map(word => word.replace(/"([^"]*)"?|'([^']*)'?|\\([ "'])|\\\\/g, (pair, double?: string, single?: string, escaped?: string) => double ?? single ?? escaped ?? pair));
  let first = 0;
  let wrapper = 0;
  for (;;) {
    while (first < words.length - 1 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[first]!) || COMMAND_WRAPPERS.has(words[first]!))) {
      const valued = COMMAND_WRAPPERS.get(words[first]!);
      if (valued) wrapper = first;
      first++;
      if (valued) while (first < words.length && words[first]!.startsWith("-")) first += valued.test(words[first]!) ? 2 : 1;
    }
    // sshpass carries a password (-p) before the real program: skip it and its options, never show the value.
    if (words[first] !== "sshpass" || first >= words.length - 1) break;
    wrapper = first++;
    while (first < words.length && words[first]!.startsWith("-")) first += /^-[pfdP]$/.test(words[first]!) ? 2 : 1;
  }
  // Only options after a wrapper ("sudo -u root", "sudo -E"): no program follows, so the label is the wrapper alone.
  const bare = first >= words.length;
  if (bare) first = wrapper;
  // A program or target with a space is quoted, so `grep "foo bar"` does not read as `grep foo bar`.
  const quoted = (word: string) => !word.includes(" ") ? word : word.includes("\"") ? `'${word}'` : `"${word}"`;
  const program = quoted(words[first]!.split("/").pop() || words[first]!);
  const rest = bare ? [] : words.slice(first + 1);
  let used: number;
  let label: string;
  if (/^python[\d.]*$/.test(program) && rest[0] === "-m" && rest[1]) { label = `${program} -m ${rest[1]}`; used = 2; }
  // Inline code is no target: "python3 -c", "node -e".
  else if (/^(?:python[\d.]*|bash|sh|zsh|node|bun|deno|perl|ruby)$/.test(program) && /^-[ce]$/.test(rest[0] ?? "")) { label = `${program} ${rest[0]}`; used = 2; }
  else {
    const remote = ["ssh", "scp", "sftp"].includes(program);
    let at = 0;
    // A download names its address, wherever it sits among the options.
    const address = ["curl", "wget"].includes(program) ? rest.findIndex(word => /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) : -1;
    if (address >= 0) at = address;
    else while (at < rest.length && (rest[at]!.startsWith("-") || rest[at] === HIDDEN_WORD)) at += remote && REMOTE_VALUE_FLAGS.has(rest[at]!) ? 2 : 1;
    const target = rest[at];
    label = target ? `${program} ${quoted(target)}` : program;
    used = target ? at + 1 : rest.length;
  }
  const cut = more && (used < rest.length || index < segments.length - 1);
  // The hidden-secret word is as long as its shown form, so the count is the same.
  const chars = [...label];
  if (chars.length > max - 2) return `${chars.slice(0, max - 1).join("")}…`;
  return cut ? `${label} …` : label;
}

/** The one way Casper says how long: "0.4s" and "4.2s" under 10 s, then whole seconds ("14s"), "1m05s" or "2m",
 * and "1h02m" or "3h". A clock that ticks once a second shows whole seconds (formatElapsed). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 9_950) return `${Number((ms / 1000).toFixed(1))}s`;
  // 9.96 s reads "10s", never "9s" after "9.9s".
  const seconds = Math.max(10, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}h${String(minutes % 60).padStart(2, "0")}m` : `${hours}h`;
}

/** A running clock in whole seconds, so it never flickers tenths: "3s", "14s", "1m05s". */
export function formatElapsed(ms: number): string {
  return formatDuration(Number.isFinite(ms) ? Math.floor(Math.max(0, ms) / 1000) * 1000 : 0);
}

/** Tokens: "950", "48.2k", "312k", "8.1M". The footer adds "tok"; /status and /usage say which tokens. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 99_950) return `${Number((tokens / 1000).toFixed(1))}k`;
  if (tokens < 999_500) return `${Math.round(tokens / 1000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Dollars: "$0.004", "$0.31", "$5.02", "$123". */
export function formatCost(dollars: number): string {
  if (dollars > 0 && dollars < 0.01) return `$${dollars.toFixed(3)}`;
  if (dollars >= 100) return `$${Math.round(dollars)}`;
  return `$${dollars.toFixed(2)}`;
}

/** A running step shows its elapsed time only once it has run this long. */
export const RUNNING_ELAPSED_AFTER_MS = 10_000;

/** " · 4m12s" for a step still running after 10 s; "" before that. */
export function runningElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < RUNNING_ELAPSED_AFTER_MS) return "";
  return ` · ${formatElapsed(ms)}`;
}

/** The last non-empty line of a command's output so far: control characters stripped, secrets redacted,
 * cut to `max` characters. "" when there is nothing to show. */
export function lastOutputLine(text: string, max: number): string {
  const lines = redactPreview(text.replace(/\r(?!\n)/g, "\n")).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/\s+/g, " ").trim();
    if (!line) continue;
    // By code points, so the cut never splits an emoji or other surrogate pair.
    const points = Array.from(line);
    return points.length > max ? `${points.slice(0, Math.max(0, max - 1)).join("")}…` : line;
  }
  return "";
}

/** Every path under `home` written as ~/…, so a box shows what it says without the person's folder names. */
export function shortenHome(text: string, home: string = homedir()): string {
  if (!home || home === "/") return text;
  return text.split(`${home}/`).join("~/").replace(new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w.-])`, "g"), "~");
}

/** What a failed step printed last, for its box: the last `max` lines that hold anything, each as it was (only the end
 * trimmed), with secrets redacted, control characters shown safely and the home folder as ~. `earlier`: how many
 * more lines came before them. */
export function failureLines(text: string, options: { max?: number; home?: string } = {}): { lines: string[]; earlier: number } {
  const all = shortenHome(redactPreview(text.replace(/\r(?!\n)/g, "\n")), options.home).split("\n")
    .map(line => line.replace(/\t/g, "  ").trimEnd()).filter(line => line.trim());
  const max = Math.max(1, options.max ?? 6);
  return { lines: all.slice(-max), earlier: Math.max(0, all.length - max) };
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
  // Narrow: the ✓/•/✗/○ already says the state, so the words go before the target is cut short.
  const line = (full: string, compact: string) => !text || [...text].length <= room(full) || room(compact) < 4 ? `${shorten(full)}${full}` : `${shorten(compact)}${compact}`;
  if (event.type === "tool_start") return `${BUSY_GLYPH} ${name}${line("", "")}`;
  // Under a second is not worth showing.
  const elapsed = elapsedMs !== undefined && elapsedMs >= 1000 ? ` · ${formatDuration(elapsedMs)}` : "";
  // Native tool success is not a verifier pass or authoritative shell exit code. The ✓ says it finished.
  const detail = event.isError && event.output?.text
    ? `\n  ${redactPreview(event.output.text).replace(/\s+/g, " ").slice(0, 240)}${event.output.truncated ? " [truncated]" : ""}` : "";
  // A casper_check skip never ran: neither ✓ nor ✗.
  if (!event.isError && event.toolName === "casper_check" && /[{,]"status":"skip"/.test(event.output?.text ?? "")) return `${NOT_RUN_GLYPH} ${name}${line(` — skipped${elapsed}`, elapsed)}`;
  const size = event.lines ? ` · +${event.lines.added} -${event.lines.removed}` : "";
  return `${event.isError ? "✗" : "✓"} ${name}${line(`${size}${event.isError ? " — failed" : ""}${elapsed}`, `${size}${elapsed}`)}${detail}`;
}

/** `auto` effort is Casper's setting; the level after the arrow is what the classifier chose (or the
 * provisional level before the next request). A role tells where the model came from. `short` (the footer, a line
 * said during work) leaves out the "for now" note. */
export function formatEffort(status: RuntimeStatus, short = false): string | undefined {
  if (status.configuredEffort === "auto") {
    const state = status.autoEffort?.state;
    // "pending" is before the next request (the first, or the next after auto was chosen), when Casper picks its level.
    const note = state === "pending" ? short ? "" : " for now; your next request picks the level" : state && state !== "classified" ? ` (${state})` : "";
    return `auto → ${status.thinkingLevel ? terminalText(status.thinkingLevel) : "—"}${note}`;
  }
  return status.thinkingLevel ? terminalText(status.thinkingLevel) : undefined;
}

/** Before the runtime starts, `saved` is the advisory saved-default display (modelPreference);
 * credentials are not read then, so auth is only promised for startup. */
/** The footer's model part when no model is set yet: not signed in at all, or signed in with the model picked
 * on the first request. `canSignIn` false (a plain terminal or a script, where sign-in can't open) names the
 * step that works there. */
export function noModelFooter(signedIn: boolean | undefined, canSignIn = true): string {
  if (signedIn !== false) return "model picked on your first request · /model";
  return canSignIn ? "not signed in · type a request to sign in" : "not signed in · run casper in a terminal and type /login";
}

/** The banner's model line before the model starts (one line), or /status's labeled block. `signedIn` false:
 * no saved sign-in or provider key was found. */
export function formatRuntimeStatus(status?: RuntimeStatus, saved?: string, signedIn?: boolean, canSignIn = true): string {
  if (!status && saved) return ` model     ${terminalText(saved)} (starts on your first request; /model to change)`;
  if (!status) return signedIn === false ? ` model     ${noModelFooter(false, canSignIn)}` : " model     none yet · your first request picks one (/model to choose)";
  const identity = status.provider && status.model ? `${status.provider}/${status.model}` : "none selected";
  const effort = formatEffort(status);
  const role = status.modelRole ? ` · role ${terminalText(status.modelRole)}` : "";
  return ` model     ${terminalText(identity)}${effort ? ` · effort ${effort}` : ""}${role}\n auth      ${status.auth === "configured" ? "credentials configured (not a connection test)" : status.auth === "missing" ? "credentials missing; use /login" : "unknown; use /login"}${status.selectionSource ? `\n selection ${status.selectionSource}${status.defaultModel ? ` · Casper default ${terminalText(status.defaultModel.provider)}/${terminalText(status.defaultModel.id)}` : " · no Casper default"}` : ""}${status.blocked ? `\n [model]   ${terminalText(status.blocked)}` : ""}`;
}

/** The one short line when the runtime starts on first use, or undefined when it would only repeat the banner (`shown`:
 * the model line the banner printed, "fixture/demo · effort auto"). Credentials are said only when they are not set
 * up; /status keeps the labeled block. Automatic effort is "effort auto" until the request picks a level. */
export function formatRuntimeStartLine(status: RuntimeStatus, shown?: string): string | undefined {
  const identity = status.provider && status.model ? `${terminalText(status.provider)}/${terminalText(status.model)}` : "no model selected (/model)";
  const auth = status.auth === "configured" ? "" : status.auth === "missing" ? " · credentials missing (/login)" : " · credentials unknown (/login)";
  const effort = status.configuredEffort === "auto" ? "auto" : status.thinkingLevel ? terminalText(status.thinkingLevel) : undefined;
  const line = `${identity}${effort ? ` · effort ${effort}` : ""}`;
  if (!auth && shown !== undefined && (shown === line || shown === identity)) return undefined;
  return `[model] ${line}${auth}`;
}
