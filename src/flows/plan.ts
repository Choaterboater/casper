/**
 * The plan-first flow: what the model may use while it plans, and how its plan becomes the build prompt.
 *
 * Adapted from the Pi coding agent's plan-mode example (MIT, @earendil-works/pi-coding-agent 0.87.0,
 * examples/extensions/plan-mode/utils.ts): the idea of an allowlist of look commands (isSafeCommand) and
 * the "Plan:" numbered-list parsing (extractTodoItems, cleanStepText). Casper's list is stricter: every
 * part of a pipeline or command list must be on it, and redirects, substitutions, variables and the
 * flags that make a look command write or run something are refused.
 *
 * This is an allowlist, not a sandbox. Casper never calls the plan turn read-only; it says it blocks the
 * changes it can see, and the snapshot taken around the plan turn reports any file that changed anyway.
 */
import os from "node:os";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { remoteTargets } from "../sandbox/remote";
import { formatChecklistPrompt } from "../task/checklist";
import { lineText } from "../tui/format";

/** Pi's built-in tools that only look at files, and the web lookups, which only read. Every other tool
 * (edit, write, MCP tools, services, the browser, delegation...) is blocked while planning, whatever it
 * says about itself. */
export const PLANNING_TOOLS = new Set(["read", "grep", "find", "ls", "web_search", "web_fetch"]);

/** Casper's own refusals start with this, so the screen says "— not run" and the receipt does not count them as failed. */
const NOT_RUN = "Not run: ";

export const PLANNING_BLOCKED = "Planning only: Casper blocks file changes until you choose Build";

/** Split one command line into words, honouring simple quotes. Undefined for anything Casper will not
 * read with confidence (escapes, unbalanced quotes). */
function words(segment: string): string[] | undefined {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === "\\") return undefined;
    if (/\s/.test(char)) {
      if (started) { result.push(current); current = ""; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) return undefined;
  if (started) result.push(current);
  return result;
}

const flag = (word: string, ...names: string[]) => names.some((name) => word === name || word.startsWith(`${name}=`));
/** A short-option word (`-uo`, `-Hx`) that holds any of these letters: most tools accept options bunched together. */
const short = (word: string, letters: string) => /^-[^-]/.test(word) && [...word.slice(1)].some((letter) => letters.includes(letter));
/** git's words after any leading `-C <dir>` pairs, which only pick the repository; `-c` (a setting) is not skipped. */
function gitWords(args: string[]): string[] {
  let at = 0;
  while (args[at] === "-C" && args[at + 1] !== undefined) at += 2;
  return args.slice(at);
}

/** Look commands, and the arguments that would make each one write, run or fetch something. */
const BASH_COMMANDS: Record<string, (args: string[]) => boolean> = {
  // cd changes no file, and each shell call starts afresh, so `cd dir && ls` only looks.
  cd: (args) => args.length <= 1,
  cat: () => true, head: () => true, tail: () => true, wc: () => true, stat: () => true,
  // file -C compiles a magic file and writes it.
  file: (args) => !args.some((arg) => flag(arg, "--compile") || short(arg, "C")),
  du: () => true, df: () => true, pwd: () => true, ls: () => true, which: () => true, type: () => true,
  uname: () => true, whoami: () => true, date: (args) => !args.some((arg) => flag(arg, "--set") || short(arg, "s")),
  echo: () => true, printf: (args) => !args.includes("-v"), diff: () => true, basename: () => true,
  dirname: () => true, realpath: () => true, readlink: () => true, nl: () => true, cut: () => true,
  tr: () => true, column: () => true, jq: () => true, eza: () => true,
  // bat runs the pager it is given.
  bat: (args) => !args.some((arg) => flag(arg, "--pager", "--paging")),
  grep: () => true, egrep: () => true, fgrep: () => true,
  // --pre and --hostname-bin run a program.
  rg: (args) => !args.some((arg) => flag(arg, "--pre", "--pre-glob", "--hostname-bin")),
  fd: (args) => !args.some((arg) => flag(arg, "--exec", "--exec-batch") || short(arg, "xX")),
  // tree -o writes its output to a file, and -R writes a 00Tree.html into every folder.
  tree: (args) => !args.some((arg) => short(arg, "oR")),
  sort: (args) => !args.some((arg) => short(arg, "o") || flag(arg, "--output", "--compress-program")),
  // uniq writes its second file argument.
  uniq: (args) => args.filter((arg) => !arg.startsWith("-")).length <= 1,
  find: (args) => !args.some((arg) => ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(arg)),
  // Only printing a line range or a pattern's lines: sed scripts can also write (w) and run (e) things.
  // Nothing after the script may be an option: `sed -n 1p -i f` rewrites f.
  sed: (args) => args[0] === "-n" && args.length >= 2 && /^(?:\d+(?:,\d+)?|\$|\/[^/]*\/)p$/.test(args[1]!)
    && !args.slice(2).some((arg) => arg.startsWith("-")),
  git: (args) => {
    const [sub, ...rest] = gitWords(args);
    const noOutput = !rest.some((arg) => flag(arg, "--output", "--open-files-in-pager", "--ext-diff", "--textconv") || /^-O/.test(arg));
    switch (sub) {
      case "status": case "log": case "diff": case "show": case "ls-files": case "ls-tree": case "rev-parse":
      case "blame": case "grep": case "shortlog": case "describe":
        return noOutput;
      case "branch": return rest.every((arg) => ["-a", "-r", "-v", "-vv", "-l", "--list", "--all", "--show-current"].includes(arg));
      case "remote": return rest.every((arg) => arg === "-v");
      case "config": return rest[0] === "--get" && rest.length === 2;
      default: return false;
    }
  },
};

const POWERSHELL_COMMANDS = new Set(["get-childitem", "gci", "dir", "ls", "get-content", "gc", "cat", "type",
  "select-string", "sls", "get-location", "pwd", "test-path", "get-item", "resolve-path", "measure-object"]);

function segments(command: string): string[][] | undefined {
  // Discard the two harmless stderr forms first; any other redirect, substitution, variable, background
  // job, here-document or line break is refused.
  const text = command.replace(/\s2>\s*\/dev\/null\b/g, " ").replace(/\s2>&1\b/g, " ");
  if (!text.trim() || /[`$<>\n\r]/.test(text) || /(^|[^&])&(?!&)/.test(text)) return undefined;
  const parts = text.split(/&&|\|\||;|\|/);
  const result: string[][] = [];
  for (const part of parts) {
    const split = words(part.trim());
    if (!split?.length) return undefined;
    result.push(split);
  }
  return result;
}

/** The first part of a shell command that is not a look command on Casper's list, as its words; [] when the
 * command can't be read as one short line of parts; undefined when every part is a look command. */
function refusedPart(command: string, shell: "bash" | "powershell"): string[] | undefined {
  const parts = command.length > 2000 ? undefined : segments(command);
  if (!parts) return [];
  return parts.find(([name, ...args]) => {
    // PowerShell runs anything in brackets inside an argument, `gci (Remove-Item x)`, and @ splats.
    if (shell === "powershell") return !POWERSHELL_COMMANDS.has(name.toLowerCase()) || /[(){}[\]@]/.test(command);
    const check = Object.hasOwn(BASH_COMMANDS, name) ? BASH_COMMANDS[name] : undefined;
    return !check?.(args);
  });
}

/** Whether Casper lets the model run this shell command while planning: every part must be a look
 * command on Casper's list, with none of the flags that write, run or fetch. */
export function isPlanningCommand(command: string, shell: "bash" | "powershell" = "bash"): boolean {
  return refusedPart(command, shell) === undefined;
}

/** ssh that only runs something on the other machine: no local log file (-E), no options (-o LocalCommand ...). */
const sshOnly = (args: string[]) => !args.some((arg) => flag(arg, "-E", "-o") || short(arg, "EoFSMN"));

/** Whether a shell command leaves this machine's files alone, so by itself it can't make the task's changes
 * unknown: every part is a look command (ls, cat, grep, find, git log ...) or ssh to another machine, which the
 * receipt reports on its own line. The same strict reading as the plan turn's list. */
export function leavesLocalFilesAlone(command: string, home = os.homedir()): boolean {
  if (command.length > 2000) return false;
  const parts = segments(command);
  if (!parts) return false;
  const lookOnly = parts.every(([name, ...args]) => name === "ssh" ? sshOnly(args)
    : Boolean((Object.hasOwn(BASH_COMMANDS, name) ? BASH_COMMANDS[name] : undefined)?.(args)));
  // ssh 127.0.0.1 (or localhost, or an alias for this machine) runs its command on this machine's files.
  return lookOnly && !(parts.some(([name]) => name === "ssh") && remoteTargets(command, home).some((target) => isThisMachine(target.host)));
}

/** localhost, 127.x.x.x, ::1, 0.0.0.0 or this machine's own name. */
function isThisMachine(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const own = os.hostname().toLowerCase();
  return /^(?:localhost(?:\.localdomain)?|127(?:\.\d{1,3}){0,3}|0(?:\.0){0,3}|::1|::ffff:127(?:\.\d{1,3}){3}|0:0:0:0:0:0:0:1)$/.test(bare)
    || bare.endsWith(".localhost") || (own !== "" && (bare === own || bare === own.split(".")[0] || bare === `${own.split(".")[0]}.local`));
}

/** The gate for a plan turn, for every tool call. Undefined lets the call run; a reason blocks it. */
export function planToolGate(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (PLANNING_TOOLS.has(toolName)) return undefined;
  if (toolName === "bash" || toolName === "powershell") {
    const command = typeof input?.command === "string" ? input.command : "";
    const part = refusedPart(command, toolName);
    if (!part) return undefined;
    // Name the part that was refused: the step label on screen may leave it out (it drops set-up words such as cd).
    // The screen shows 240 characters of the refusal, so the reason stays short.
    const [name = "", ...args] = part;
    const powershell = toolName === "powershell";
    const listed = powershell ? POWERSHELL_COMMANDS.has(name.toLowerCase()) : Object.hasOwn(BASH_COMMANDS, name);
    const sub = name === "git" ? gitWords(args)[0] : undefined;
    const why = !part.length ? "It must be one line with no redirects, $, backticks, backslashes or lone &."
      // A listed PowerShell command is refused only for brackets or @ somewhere in the line.
      : powershell && listed ? "Brackets and @ can run commands in PowerShell, so they are refused."
      : name ? `${lineText(`${name}${sub ? ` ${sub}` : ""}`)}${listed ? " with these options" : ""} is not one.` : "";
    return `${NOT_RUN}${PLANNING_BLOCKED}. While planning it runs only look commands such as ls, cat, grep and git log.${why ? ` ${why}` : ""}`;
  }
  if (toolName === "edit" || toolName === "write") return `${NOT_RUN}${PLANNING_BLOCKED}.`;
  return `${NOT_RUN}${PLANNING_BLOCKED}. While planning it allows only read, grep, find, ls and web lookups, not ${toolName}.`;
}

/** A person-facing plan. Designed specs need no implementation steps; `tests` also holds "Done means".
 * The optional blocks keep their lines (including mock-ups). Legacy Plan/Tests answers still work.
 * `details` holds implementation notes, hidden on the screen unless requested. */
export interface ParsedPlan {
  steps: string[];
  tests: string[];
  title?: string;
  see?: string[];
  /** Fenced What you'll see art, kept separate from its prose across save/edit/build. */
  mockup?: string[];
  details?: string[];
  note?: string[];
  goal?: string[];
  found?: string[];
  openQuestions?: string[];
  screens?: string[];
  data?: string[];
  look?: string[];
  firstVersion?: string[];
  later?: string[];
}

/** Tidy one step: no Markdown emphasis or code marks, one line, never cut.
 * (Pi's cleanStepText, without its 50-character cut.) */
function cleanLine(text: string): string {
  return lineText(text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1"))
    .replace(/\s+/g, " ")
    .trim();
}

type BlockKey = Exclude<keyof ParsedPlan, "title" | "steps" | "tests" | "mockup">;
type SectionKey = keyof ParsedPlan;

/** One vocabulary for parsing, editing and display. Unknown headings inside a mock-up or Details stay put. */
const BLOCKS: readonly [BlockKey, string][] = [
  ["goal", "Goal"], ["found", "What I found"], ["openQuestions", "Open questions"],
  ["screens", "Screens"], ["data", "Data"], ["look", "Look"],
  ["firstVersion", "First version"], ["later", "Later"], ["see", "What you'll see"],
];
const HEADINGS: readonly [SectionKey, string][] = [
  ["title", "Title"], ...BLOCKS, ["steps", "Steps"], ["steps", "Plan"],
  ["tests", "Done means"], ["tests", "Tests"], ["details", "Details"], ["note", "Note"],
  ["found", "Found"], ["look", "Look and feel"], ["see", "What you’ll see"], ["see", "What you will see"],
];

/** Markdown hashes/emphasis are optional; a body may follow the colon on the same line. */
function planHeader(line: string): { key: SectionKey; inline: string } | undefined {
  const text = line.trim().replace(/^#{1,6}\s*/, "").replace(/\s+#+\s*$/, "")
    .replace(/^\*{1,2}|^_{1,2}/, "");
  for (const [key, heading] of HEADINGS) {
    if (text.slice(0, heading.length).toLowerCase() !== heading.toLowerCase()) continue;
    const rest = text.slice(heading.length).replace(/^(?:\*{1,2}|_{1,2})/, "");
    if (rest && !/^\s*:/.test(rest) && rest.trim() !== "" && !(key === "title" && /^\s+/.test(rest))) continue;
    return { key, inline: rest.replace(/^\s*:?\s*(?:\*{1,2}|_{1,2})?\s*/, "") };
  }
  return undefined;
}

/** A section's lines as written (a mock-up keeps its spacing), without surrounding blank lines. */
function blockLines(text: string | undefined): string[] | undefined {
  if (text === undefined) return undefined;
  const lines = text.split(/\r?\n/).map((line) => lineText(line).trimEnd());
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.length ? lines : undefined;
}

/** List markers start items; wrapped lines continue them (including Markdown's lazy, unindented
 * continuation). After a blank line, only indented text continues a list item. Other prose stands alone.
 * Keep the whole requirement here; checklist storage limits do not belong to the accepted plan. */
function planItems(lines: readonly string[]): string[] {
  const items: string[] = [];
  let listIndent: number | undefined;
  let separated = false;
  for (const line of lines) {
    if (!line.trim()) { separated = true; continue; }
    const marker = /^(\s*)(?:[-*+•]|\d+[.)])\s+(.+)$/.exec(line);
    const indent = /^\s*/.exec(line)![0].length;
    if (!marker && listIndent !== undefined && (!separated || indent > listIndent)) {
      items[items.length - 1] += ` ${line}`;
    } else {
      items.push(marker ? marker[2]! : line);
      listIndent = marker ? indent : undefined;
    }
    separated = false;
  }
  return items.map(cleanLine).filter(Boolean);
}

/** Join Markdown bullet continuations without losing their marker. Prose keeps its original lines. */
function blockItems(lines: readonly string[]): string[] {
  const items: string[] = [];
  let bullet = false;
  for (const line of lines) {
    if (!line.trim()) { bullet = false; continue; }
    if (/^\s*(?:[-*+•]|\d+[.)])\s+/.test(line)) { items.push(line); bullet = true; }
    else if (bullet) items[items.length - 1] += ` ${line.trim()}`;
    else items.push(line);
  }
  return items;
}

/** Questions must actually ask something. Keep statements as facts, also for hand-edited/older plans. */
function questionsOnly(plan: ParsedPlan): ParsedPlan {
  if (!plan.openQuestions?.length) return plan;
  const items = blockItems(plan.openQuestions).flatMap(line => {
    const marker = /^\s*(?:[-*+•]|\d+[.)])\s+/.exec(line)?.[0] ?? "";
    // A question's explanatory continuation is not itself an unresolved question.
    return line.slice(marker.length).split(/(?<=[?？])\s+|(?<=[?？]["'”’)])\s+/u).map(part => marker + part);
  });
  const questions = items.filter(line => /[?？]["'”’)]*$/.test(cleanLine(line)));
  const facts = items.filter(line => !questions.includes(line));
  const { openQuestions: _questions, ...rest } = plan;
  return { ...rest, ...(facts.length ? { found: [...plan.found ?? [], ...facts] } : {}),
    ...(questions.length ? { openQuestions: questions } : {}) };
}

/** Read both designed specs and older Plan/Tests answers. Fenced mock-ups keep their spacing and
 * cannot introduce sections. Unknown sections after legacy lists are retained as implementation details. */
export function extractPlan(message: string): ParsedPlan {
  // Some models wrap the entire answer as Markdown, rather than fencing just a diagram.
  const wrapper = /^\s*(`{3,}|~{3,})(?:markdown|md)?[ \t]*\r?\n([\s\S]*)\r?\n\1[ \t]*\s*$/i.exec(message);
  if (wrapper) message = wrapper[2]!;
  const blocks: Partial<Record<SectionKey, string[]>> = {};
  const lead: string[] = [];
  let current: SectionKey | undefined;
  let found = false;
  let fence: { char: string; length: number } | undefined;
  let leadFence = false;
  for (const line of message.split(/\r?\n/)) {
    const mark = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark && (!fence || (mark[1]![0] === fence.char && mark[1]!.length >= fence.length && !mark[2]!.trim()))) {
      if (!found) leadFence = true;
      if (!fence && current === "see" && blocks.mockup?.length) blocks.mockup.push("");
      fence = fence ? undefined : { char: mark[1]![0]!, length: mark[1]!.length };
      continue;
    }
    const header = !fence ? planHeader(line) : undefined;
    if (header) {
      found = true;
      current = header.key;
      const lines = blocks[current] ??= [];
      // A repeated section/alias starts fresh prose, not a continuation of its previous list.
      if ((current === "steps" || current === "tests") && lines.length) lines.push("");
      if (header.inline) lines.push(header.inline);
      continue;
    }
    // Preserve the older lists' boundary at an unknown "Risks:" heading, without swallowing it.
    if (!fence && (current === "steps" || current === "tests")
      && /^\s*(?:#{1,6}\s*)?\*{0,2}[A-Z][A-Za-z ]{1,30}(?::\*{0,2}|\*{1,2}:)\s*$/.test(line)) current = "details";
    if (current) (blocks[current === "see" && fence ? "mockup" : current] ??= []).push(line);
    else lead.push(line);
  }
  if (!found) return { steps: [], tests: [] };
  const result: ParsedPlan = { steps: [], tests: [] };
  for (const [key, lines] of Object.entries(blocks) as [SectionKey, string[]][]) {
    const body = blockLines(lines.join("\n"));
    if (!body) continue;
    if (key === "title") result.title = cleanLine(body.join(" "));
    else if (key === "steps" || key === "tests") result[key] = planItems(body);
    else result[key] = body;
  }
  const before = blockLines(lead.join("\n"));
  if (before) {
    const key = before.length <= 3 && !leadFence ? "note" : "details";
    result[key] = [...(key === "note" ? before.map(cleanLine) : before), ...result[key] ?? []];
  }
  return questionsOnly(result);
}

/** A designed spec is useful without a numbered implementation recipe. Goal/facts alone aren't a spec. */
export function isSpecPlan(plan: ParsedPlan): boolean {
  return [plan.screens, plan.data, plan.look, plan.firstVersion, plan.later]
    .some((lines) => lines?.some((line) => line.trim()));
}

/** Lossless, editable section text shared by save, revise and build. Empty sections are omitted. */
export function planMarkdown(plan: ParsedPlan): string {
  plan = questionsOnly(plan);
  const sections: string[] = [];
  if (plan.title) sections.push(`Title: ${plan.title}`);
  const block = (heading: string, lines: string[] | undefined) => {
    if (!lines?.some((line) => line.trim())) return;
    // Protect literal headers in diagrams/notes when saving and parsing again.
    const needsFence = lines.some((line) => planHeader(line) || /^\s*(?:`{3,}|~{3,})/.test(line));
    const fence = "~".repeat(Math.max(3, ...lines.map((line) => (/^\s*(~+)/.exec(line)?.[1]?.length ?? 0) + 1)));
    sections.push(`${heading}:\n${needsFence ? `${fence}\n` : ""}${lines.join("\n")}${needsFence ? `\n${fence}` : ""}`);
  };
  block("Note", plan.note);
  for (const [key, heading] of BLOCKS) {
    const before = sections.length;
    block(heading, plan[key]);
    if (key === "see" && plan.mockup?.length) {
      const fence = "~".repeat(Math.max(3, ...plan.mockup.map(line => (/^\s*(~+)/.exec(line)?.[1]?.length ?? 0) + 1)));
      const art = `${fence}\n${plan.mockup.join("\n")}\n${fence}`;
      if (sections.length > before) sections[sections.length - 1] += `\n\n${art}`;
      else sections.push(`${heading}:\n${art}`);
    }
  }
  if (plan.steps.length) sections.push(`Steps:\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`);
  if (plan.tests.length) sections.push(`Done means:\n${plan.tests.map((item, index) => `${index + 1}. ${item}`).join("\n")}`);
  block("Details", plan.details);
  return sections.join("\n\n");
}

/** A change request, with the whole current plan and its visible numbering. The flow and original request are
 * sent alongside this. Rewriting is still planning, not acceptance or permission to build. */
export function formatPlanChangePrompt(plan: ParsedPlan, change: string): string {
  return [
    "Rewrite the current plan to apply the user's change. Keep unaffected requirements. Return the whole revised plan in the same shape, not a diff or commentary. Do not build.",
    `User's change: ${change}`,
    "Current plan:",
    planMarkdown(plan),
    "Keep Done means / Tests as concrete checklist cases: handle every case and write one test per case that asserts exactly that case.",
  ].join("\n\n");
}

/** Text wrapped under a marker, with continuation rows aligned. Even unbroken words are wrapped, never cut. */
function hang(marker: string, text: string, width: number): string[] {
  // At tiny widths, content takes precedence over indentation and list markers.
  if (visibleWidth(marker) > width - 2) marker = "";
  const inner = Math.max(1, width - visibleWidth(marker));
  return wrapTextWithAnsi(text, inner).map((row, index) => `${index ? " ".repeat(visibleWidth(marker)) : marker}${row}`);
}

const FILE_PATH = /(?:[\w.@()[\]$-]+[\\/])+[\w.@()[\]$/-]+(?::\d+(?::\d+)?)?|\b[\w.-]+\.(?:[cm]?[jt]sx?|py|md|json|ya?ml|toml|css|html|vue|svelte|rs|go|java|rb|sh)\b|\b(?:Dockerfile|Makefile)\b/g;

export interface PlanScreenOptions {
  more?: string;
  full?: boolean;
  framed?: boolean;
  accent?: (text: string) => string;
  dim?: (text: string) => string;
}

/** The same sections in plain and framed terminals. Only implementation Details stay one key away.
 * A frame is at most 80 cells wide, with breathing room inside; no centering or terminal state required. */
export function planScreenRows(plan: ParsedPlan, width: number, options: PlanScreenOptions = {}): string[] {
  plan = questionsOnly(plan);
  const available = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
  const framed = Boolean(options.framed && available >= 6);
  const outer = framed ? Math.min(80, available) : available;
  const gutter = outer >= 10 ? "  " : "";
  const inner = framed ? outer - 2 - gutter.length * 2 : outer;
  const accent = options.accent ?? ((text: string) => text);
  const dim = options.dim ?? ((text: string) => text);
  // Sanitize model content before trusted theme functions add ANSI codes. Keep mock-up spacing.
  const body = (text: string) => lineText(text).replace(/`([^`]+)`/g, "$1")
    .replace(FILE_PATH, (path) => {
      const name = path.replace(/[.,]+$/, "");
      return dim(name) + path.slice(name.length);
    });
  const title = `Plan${plan.title ? ` · ${cleanLine(plan.title)}` : ""}`;
  const titleRows = hang("", accent(title), framed ? Math.max(1, outer - 6) : inner);
  const rows: string[] = framed ? [] : [...hang("", accent(`Casper ${title.toLowerCase().startsWith("plan") ? "plan" + title.slice(4) : title}`), inner)];
  if (framed && titleRows.length > 1) rows.push(...titleRows);
  for (const line of plan.note ?? []) rows.push(...hang("  ", body(line), inner));
  const add = (heading: string, lines: string[] | undefined, numbered = false) => {
    if (!lines?.some((line) => line.trim())) return;
    if (rows.length) rows.push("");
    rows.push(...hang("", accent(heading), inner));
    (numbered ? lines.filter(line => line.trim()) : blockItems(lines)).forEach((line, index) => {
      const bullet = !numbered ? /^(\s*(?:[-*+•]|\d+[.)])\s+)(.*)$/.exec(line) : null;
      rows.push(...hang(numbered ? `  ${index + 1}. ` : `  ${bullet?.[1] ?? ""}`, body(bullet?.[2] ?? line), inner));
    });
  };
  const addSee = () => {
    // Older saved plans did not retain fences. Recognisable art still gets the same inner box.
    const legacy = !plan.mockup ? plan.see?.findIndex(line => /^\s*[┌╭│└╰|]|^\s{2,}\S|^\s*\[[^\]]+\]/.test(line)) ?? -1 : -1;
    const prose = legacy >= 0 ? plan.see!.slice(0, legacy) : plan.see;
    const art = plan.mockup ?? (legacy >= 0 ? plan.see!.slice(legacy) : undefined);
    add("What you'll see", prose);
    if (!art?.length) return;
    if (!prose?.some(line => line.trim())) {
      if (rows.length) rows.push("");
      rows.push(...hang("", accent("What you'll see"), inner));
    }
    const artWidth = Math.max(...art.map(line => visibleWidth(lineText(line))));
    const enclosed = /^\s*[┌╭]─+[┐╮]\s*$/.test(art[0]!) && /^\s*[└╰]─+[┘╯]\s*$/.test(art.at(-1)!)
      && art.every(line => visibleWidth(line) === artWidth);
    if (enclosed && artWidth <= inner - 2) { rows.push(...art.map(line => dim(`  ${lineText(line)}`))); return; }
    const boxWidth = Math.min(artWidth + 4, inner - 2);
    if (boxWidth < 5) { for (const line of art) rows.push(...hang("  ", dim(lineText(line)), inner)); return; }
    const contents = art.flatMap(line => wrapTextWithAnsi(lineText(line), boxWidth - 4));
    rows.push(dim(`  ┌${"─".repeat(boxWidth - 2)}┐`));
    rows.push(...contents.map(line => dim(`  │ ${line}${" ".repeat(Math.max(0, boxWidth - 4 - visibleWidth(line)))} │`)));
    rows.push(dim(`  └${"─".repeat(boxWidth - 2)}┘`));
  };
  for (const [key, heading] of BLOCKS) {
    if (key === "see") addSee();
    else if (key !== "openQuestions") add(heading, plan[key]);
  }
  if (plan.steps.length) {
    if (rows.length) rows.push("");
    rows.push(...hang("", accent("Steps"), inner));
    plan.steps.forEach((step, index) => {
      const text = cleanLine(step);
      const paths = [...text.matchAll(FILE_PATH)];
      const last = paths.at(-1);
      const main = last && /^\s*[.,;)]?$/.test(text.slice(last.index! + last[0].length)) ? last : paths[0];
      const marker = `  ${index + 1}. `;
      if (!main) { rows.push(...hang(marker, body(text), inner)); return; }
      const file = main[0].replace(/[.,]+$/, "");
      const label = `${text.slice(0, main.index)}${text.slice(main.index! + main[0].length)}`
        .replace(/\s*[—–|:-]\s*$/, "").replace(/\b(?:in|to|from|at)\s*$/, "").replace(/\s+/g, " ").trim();
      const column = inner - visibleWidth(file) - 2;
      if (column - visibleWidth(marker) >= Math.min(20, visibleWidth(label))) {
        const left = hang(marker, body(label), column);
        rows.push(...left.map((row, line) => line ? row : `${row}${" ".repeat(Math.max(2, inner - visibleWidth(row) - visibleWidth(file)))}${dim(file)}`));
      } else {
        rows.push(...hang(marker, body(label), inner));
        for (const row of wrapTextWithAnsi(file, Math.max(1, inner - 2))) rows.push(`${" ".repeat(Math.max(0, inner - visibleWidth(row)))}${dim(row)}`);
      }
    });
  }
  add("Done means", plan.tests, true);
  add("Open questions", plan.openQuestions);
  if (options.full) add("Details", plan.details);
  if (options.more && !framed && !options.full) rows.push("", ...hang("", dim(lineText(options.more)), inner));
  if (!framed) return rows;
  // Paint each edge separately: title/body/dim resets must not leave the frame uncoloured.
  const edge = (left: string, right: string, text = "") => `${accent(`${left}─`)}${text}${accent(`${"─".repeat(Math.max(0, outer - 3 - visibleWidth(text)))}${right}`)}`;
  const footer = dim(" Ctrl+T details · Ctrl+G edit ");
  if (options.more && visibleWidth(footer) > outer - 4) rows.push("", ...hang("", footer.trim(), inner));
  const side = accent("│");
  const blank = `${side}${" ".repeat(outer - 2)}${side}`;
  return [edge("╭", "╮", titleRows.length === 1 ? ` ${titleRows[0]} ` : ""), blank,
    ...rows.map((row) => `${side}${gutter}${row}${" ".repeat(Math.max(0, inner - visibleWidth(row)))}${gutter}${side}`),
    blank, options.more && visibleWidth(footer) <= outer - 4
      ? `${accent(`╰${"─".repeat(outer - 3 - visibleWidth(footer))}`)}${footer}${accent("─╯")}` : edge("╰", "╯")];
}

/** The build details for Ctrl+T or the plain terminal's "Show the details". Cases already appear on the screen. */
export function planDetailsText(plan: ParsedPlan): string | undefined {
  return plan.details?.length ? `Details:\n${plan.details.join("\n")}` : undefined;
}

/** The accepted spec, facts, unresolved questions and scope all reach the build, not only its steps. */
export function formatPlanBlock(plan: ParsedPlan): string {
  plan = questionsOnly(plan);
  const prefix = "Casper plan (the user read and accepted it).";
  return [
    plan.steps.length ? `${prefix} Follow these steps in order:\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`
      : `${prefix} Build the first version described below.`,
    planMarkdown({ ...plan, steps: [] }),
    "Keep the first version in scope; Later is not part of this build. Treat What I found as established facts and Open questions as unresolved, not decisions. The accepted requirements take precedence over implementation Details.",
    ...plan.tests.length ? ["Handle every Done means / Tests case and write one test per case that asserts exactly that case."] : [],
  ].filter(Boolean).join("\n\n");
}

/** The build turn's prompt: the request, the plan the user accepted and the cases to test. This
 * replaces the separate checklist call. */
export function formatBuildPrompt(request: string, plan: ParsedPlan): string {
  return [
    request,
    "",
    formatPlanBlock(plan),
    ...(plan.tests.length ? ["", formatChecklistPrompt(plan.tests)] : []),
  ].join("\n");
}
