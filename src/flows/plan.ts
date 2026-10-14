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
import { formatChecklistPrompt, normalizeCases } from "../task/checklist";
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

/** A plan for a person first: a title, what they will see, plain steps and the cases to test. `details` (files,
 * functions, exact assertions) is for the build and shown only when asked for; `note` is the model's one line before
 * the plan (an unclear request, say). Only steps and tests are always
 * there: an answer in the older "Plan:"/"Tests:" shape has nothing else. */
export interface ParsedPlan {
  steps: string[];
  tests: string[];
  title?: string;
  see?: string[];
  details?: string[];
  note?: string[];
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

const HEADER = (name: string) => `^\\s*(?:#{1,6}\\s*)?\\*{0,2}(?:${name}):?\\*{0,2}:?\\s*$`;
const SEE = "What you(?:'|’| wi)ll see";
/** "What you'll see:" alone on its line, or with its first words after the colon (captured). */
const SEE_HEADER = `^[ \\t]*(?:#{1,6}[ \\t]*)?\\*{0,2}${SEE}(?:\\*{0,2}:\\*{0,2}[ \\t]*(\\S.*)|:?\\*{0,2}:?[ \\t]*)$`;
/** The headers of the plan's own sections: where the newer sections end, whatever lines they hold. */
const KNOWN = new RegExp(`${HEADER("Steps|Plan|Tests|Details")}|${SEE_HEADER}`, "im");
/** Any "Name:" header line: where "Plan:" and "Tests:" end, as they always have. */
const ANY = new RegExp(`${HEADER("[A-Z][A-Za-z ]{1,30}")}|${SEE_HEADER}`, "m");
const TITLE = /^[ \t]*(?:#{1,6}[ \t]*)?\*{0,2}Title:?\*{0,2}:?[ \t]*(\S.*)$/im;

/** Where a section is in the answer: from its header to the next header, its lines, and words written after the
 * header's colon. */
type Span = { start: number; end: number; body: string; inline?: string };

function section(message: string, header: RegExp, end: "any" | "known"): Span | undefined {
  const match = header.exec(message);
  if (!match) return undefined;
  const from = match.index + match[0].length;
  const rest = message.slice(from);
  // The newer sections end only at one of the plan's own headers, so a "Files:" line in Details or a "CASPER:" line
  // in a mock-up stays in.
  const next = (end === "known" ? KNOWN : ANY).exec(rest);
  const to = next ? from + next.index : message.length;
  return { start: match.index, end: to, body: message.slice(from, to), ...(match[1] ? { inline: match[1] } : {}) };
}

/** A section's lines as written (a mock-up keeps its spacing), without code fences and the blank lines around them. */
function blockLines(text: string | undefined): string[] | undefined {
  if (text === undefined) return undefined;
  const lines = text.split(/\r?\n/).filter((line) => !/^\s*```/.test(line)).map((line) => lineText(line).trimEnd());
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.length ? lines : undefined;
}

/** The plan in the model's answer: "Title:", "What you'll see:", the numbered "Steps:" (or "Plan:"), the "Tests:"
 * cases and "Details:". Missing sections give empty lists or nothing; an answer with only "Plan:" and "Tests:" reads
 * as it always has. A few plain lines before the first section are the model's note; anything longer, and anything
 * outside the plan's sections (a "Risks:" after the tests, say), goes with the details, so nothing it wrote is lost. */
export function extractPlan(message: string): ParsedPlan {
  const plan = section(message, new RegExp(HEADER("Plan|Steps"), "im"), "any");
  const tests = section(message, new RegExp(HEADER("Tests"), "im"), "any");
  const steps = [...(plan?.body ?? "").matchAll(/^\s*\d+[.)]\s+(.+)$/gm)]
    .map((match) => cleanLine(match[1]!))
    .filter((text) => text.length > 3);
  const cases = [...(tests?.body ?? "").matchAll(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/gm)]
    .map((match) => cleanLine(match[1]!))
    .filter((text) => text.length > 3);
  const titleLine = TITLE.exec(message);
  const title = titleLine ? cleanLine(titleLine[1]!) : undefined;
  const seen = section(message, new RegExp(SEE_HEADER, "im"), "known");
  const seeLines = [...seen?.inline ? [cleanLine(seen.inline)] : [], ...blockLines(seen?.body) ?? []];
  const see = seeLines.length ? seeLines : undefined;
  const written = section(message, new RegExp(HEADER("Details"), "im"), "known");
  const first = KNOWN.exec(message);
  const lead = first ? message.slice(0, first.index).replace(TITLE, "") : "";
  const before = blockLines(lead);
  const short = before !== undefined && before.length <= 3 && !/^\s*```/m.test(lead);
  // What lies outside every section, the title line and the lead.
  const spans = [plan, tests, seen, written, ...first ? [{ start: 0, end: first.index }] : [],
    ...titleLine ? [{ start: titleLine.index, end: titleLine.index + titleLine[0].length }] : []]
    .filter((span): span is { start: number; end: number } => span !== undefined).sort((a, b) => a.start - b.start);
  const outside: string[] = [];
  let at = 0;
  for (const span of spans) {
    if (span.start > at) outside.push(...blockLines(message.slice(at, span.start)) ?? []);
    at = Math.max(at, span.end);
  }
  if (first && at < message.length) outside.push(...blockLines(message.slice(at)) ?? []);
  const details = [...(before && !short ? before : []), ...(blockLines(written?.body) ?? []), ...outside];
  return { steps, tests: normalizeCases(cases),
    ...(title ? { title } : {}), ...(see ? { see } : {}), ...(short ? { note: before!.map(cleanLine).filter(Boolean) } : {}),
    ...(details.length ? { details } : {}) };
}

/** A change request, with the whole current plan and its visible numbering. The flow and original request are
 * sent alongside this. Rewriting is still planning, not acceptance or permission to build. */
export function formatPlanChangePrompt(plan: ParsedPlan, change: string): string {
  return [
    "Rewrite the current plan to apply the user's change. Keep unaffected requirements. Return the whole revised plan in the same shape, not a diff or commentary. Do not build.",
    `User's change: ${change}`,
    "Current plan:",
    ...plan.title ? [`Title: ${plan.title}`] : [],
    ...plan.see?.length ? [`What you'll see:\n${plan.see.join("\n")}`] : [],
    `Steps:\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
    `Tests:\n${plan.tests.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
    ...plan.details?.length ? [`Details:\n${plan.details.join("\n")}`] : [],
  ].join("\n\n");
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Text wrapped to the width under a marker ("1. "), later rows indented to line up with the first. Never cut. */
function hang(marker: string, text: string, width: number): string[] {
  const inner = Math.max(10, width - visibleWidth(marker));
  return wrapTextWithAnsi(text, inner).map((row, index) => `${index ? " ".repeat(visibleWidth(marker)) : marker}${row}`);
}

/** The plan screen: title, what they will see, numbered steps and numbered cases. Only the build details stay
 * one key away (`more`), or are listed with `full` in a run that cannot ask. Wrapped, never cut. */
export function planScreenRows(plan: ParsedPlan, width: number, options: { more?: string; full?: boolean } = {}): string[] {
  const rows: string[] = [...hang("", `Casper plan${plan.title ? ` · ${plan.title}` : ""}`, width)];
  for (const line of plan.note ?? []) rows.push(...hang("  ", line, width));
  if (plan.see?.length) {
    rows.push("", "What you'll see");
    for (const line of plan.see) rows.push(...hang("  ", line, width));
  }
  rows.push("", "Steps");
  plan.steps.forEach((step, index) => rows.push(...hang(`  ${index + 1}. `, step, width)));
  rows.push("");
  const cases = plan.tests.length ? `Tests: ${plural(plan.tests.length, "case", "cases")}` : "Tests: none listed";
  rows.push(cases);
  plan.tests.forEach((item, index) => rows.push(...hang(`  ${index + 1}. `, item, width)));
  if (plan.details?.length) {
    rows.push("");
    if (options.full) { rows.push("Details"); for (const line of plan.details) rows.push(...hang("  ", line, width)); }
    else if (options.more) rows.push(...hang("", options.more, width));
  }
  return rows;
}

/** The build details for Ctrl+T or the plain terminal's "Show the details". Cases already appear on the screen. */
export function planDetailsText(plan: ParsedPlan): string | undefined {
  return plan.details?.length ? `Details:\n${plan.details.join("\n")}` : undefined;
}

/** The plan as the build turn reads it: the steps the user accepted, then everything else the plan said (title,
 * what the user will see, and the details the screen kept one key away). The cases go separately. */
export function formatPlanBlock(plan: ParsedPlan): string {
  return [
    `Casper plan (the user read and accepted it). Follow these steps in order:\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
    ...plan.title ? [`Title: ${plan.title}`] : [],
    ...plan.see?.length ? [`What the user will see:\n${plan.see.join("\n")}`] : [],
    ...plan.details?.length ? [`Details from your plan (where they differ from the steps above, the steps win):\n${plan.details.join("\n")}`] : [],
  ].join("\n\n");
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
