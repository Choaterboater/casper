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

/** Look commands, and the arguments that would make each one write, run or fetch something. */
const BASH_COMMANDS: Record<string, (args: string[]) => boolean> = {
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
    const [sub, ...rest] = args;
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

/** Whether Casper lets the model run this shell command while planning: every part must be a look
 * command on Casper's list, with none of the flags that write, run or fetch. */
export function isPlanningCommand(command: string, shell: "bash" | "powershell" = "bash"): boolean {
  if (command.length > 2000) return false;
  const parts = segments(command);
  if (!parts) return false;
  return parts.every(([name, ...args]) => {
    // PowerShell runs anything in brackets inside an argument, `gci (Remove-Item x)`, and @ splats.
    if (shell === "powershell") return POWERSHELL_COMMANDS.has(name.toLowerCase()) && !/[(){}[\]@]/.test(command);
    const check = Object.hasOwn(BASH_COMMANDS, name) ? BASH_COMMANDS[name] : undefined;
    return Boolean(check?.(args));
  });
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
    if (isPlanningCommand(command, toolName)) return undefined;
    return `${NOT_RUN}${PLANNING_BLOCKED}. While planning it runs only look commands such as ls, cat, grep and git log.`;
  }
  if (toolName === "edit" || toolName === "write") return `${NOT_RUN}${PLANNING_BLOCKED}.`;
  return `${NOT_RUN}${PLANNING_BLOCKED}. While planning it allows only read, grep, find, ls and web lookups, not ${toolName}.`;
}

/** A plan for a person first: a title, what they will see, plain steps and the cases to test. `details` (files,
 * functions, exact assertions) is for the build and shown only when asked for; `note` is the model's one line before
 * the plan (an unclear request, say); `notes` are the person's own, from the editor. Only steps and tests are always
 * there: an answer in the older "Plan:"/"Tests:" shape has nothing else. */
export interface ParsedPlan {
  steps: string[];
  tests: string[];
  title?: string;
  see?: string[];
  details?: string[];
  note?: string[];
  notes?: string[];
}

/** Tidy one step for the editor: no Markdown emphasis or code marks, one line, never cut: the user reads and edits
 * the whole step. (Pi's cleanStepText, without its 50-character cut.) */
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

const TEST_PREFIX = "Test: ";

/** The plan as editor lines: steps first, then one "Test: ..." line per case. */
export function planEditorLines(plan: ParsedPlan): string[] {
  return [...plan.steps, ...plan.tests.map((item) => `${TEST_PREFIX}${item}`)];
}

type PlanLine = { kind: "step" | "test"; text: string };

/** One editor line as a step or a case. Blank gives undefined; a leading "1." is removed. */
function readLine(line: string): PlanLine | undefined {
  const text = cleanLine(line);
  if (!text) return undefined;
  const test = /^tests?:\s*(.*)$/i.exec(text);
  if (test) return test[1]!.trim() ? { kind: "test", text: test[1]!.trim() } : undefined;
  const step = text.replace(/^(?:step\s*)?\d+[.):]\s*/i, "").trim();
  return step ? { kind: "step", text: step } : undefined;
}

/** The editor's lines back into steps and cases. Blank lines are dropped; a leading "1." is removed. */
export function parsePlanLines(lines: readonly string[]): ParsedPlan {
  const read = lines.map(readLine).filter((line): line is PlanLine => line !== undefined);
  return { steps: read.filter((line) => line.kind === "step").map((line) => line.text),
    tests: normalizeCases(read.filter((line) => line.kind === "test").map((line) => line.text)) };
}

/** What the person changed in the editor, in their words: lines added and removed, their notes, and the steps in
 * their new order when they moved any. */
export interface PlanEdit { added: string[]; removed: string[]; notes: string[]; order?: string[] }

/** Words typed after an unchanged line count as a note only after a separator: " - ", " -- ", " – ", " // ", " (",
 * " [" or " note". Anything else ("... before connecting and before saving") changes the line. */
const NOTE_AFTER = /^\s+(?:(?:--?|[–—]|\/\/)\s|[([]|note\b)/i;

function appendedNote(text: string): string {
  const bracketed = /^\s*[([]/.test(text);
  const words = text.replace(/^\s*(?:--?|[–—]|\/\/|[([])?\s*/, "").replace(/^note\b\s*[:\-–—]?\s*/i, "");
  return (bracketed ? words.replace(/[)\]]\s*$/, "") : words).trim();
}

/** The editor's lines read against the plan they started from. A "Note:" line, or words typed after a line that is
 * otherwise unchanged after a separator (" - this looks confusing"), is the person's note, not part of the step: the
 * step stays as it was. Steps only moved are a change too (`order`). Everything the plan
 * had besides steps and cases (title, what you'll see, details, earlier notes) is kept. */
export function readPlanEdit(plan: ParsedPlan, lines: readonly string[]): { plan: ParsedPlan; edit: PlanEdit } {
  const label = (line: PlanLine) => line.kind === "test" ? `${TEST_PREFIX}${line.text}` : line.text;
  const original = planEditorLines(plan).map(readLine).filter((line): line is PlanLine => line !== undefined);
  const unmatched = new Set(original.map((_, index) => index));
  const kept: PlanLine[] = [];
  const keptSteps: number[] = [];
  const edit: PlanEdit = { added: [], removed: [], notes: [] };
  const take = (match: (line: PlanLine) => boolean) => {
    const index = [...unmatched].find((at) => match(original[at]!));
    if (index !== undefined) unmatched.delete(index);
    return index === undefined ? undefined : original[index];
  };
  for (const raw of lines) {
    const note = /^\s*(?:[-*•]\s*)?note:\s*(.*)$/i.exec(lineText(raw));
    if (note) { if (note[1]!.trim()) edit.notes.push(cleanLine(note[1]!)); continue; }
    const line = readLine(raw);
    if (!line) continue;
    const same = take((was) => was.kind === line.kind && was.text === line.text);
    if (same) { kept.push(same); if (same.kind === "step") keptSteps.push(original.indexOf(same)); continue; }
    // "Add the test - this looks confusing to me": the step as it was, and a note.
    const grown = take((was) => was.kind === line.kind && line.text.startsWith(was.text) && NOTE_AFTER.test(line.text.slice(was.text.length)));
    const rest = grown ? appendedNote(line.text.slice(grown.text.length)) : "";
    if (grown && rest) { kept.push(grown); if (grown.kind === "step") keptSteps.push(original.indexOf(grown)); edit.notes.push(rest); continue; }
    if (grown) unmatched.add(original.indexOf(grown));
    kept.push(line);
    edit.added.push(label(line));
  }
  edit.removed = [...unmatched].sort((a, b) => a - b).map((index) => label(original[index]!));
  const steps = kept.filter((line) => line.kind === "step").map((line) => line.text);
  const tests = normalizeCases(kept.filter((line) => line.kind === "test").map((line) => line.text));
  // Steps the person only moved: the build follows the new order, so the screen says so.
  if (keptSteps.some((index, at) => at > 0 && index < keptSteps[at - 1]!)) edit.order = steps;
  const notes = [...plan.notes ?? [], ...edit.notes];
  return { plan: { ...plan, steps, tests, ...(notes.length ? { notes } : {}) }, edit };
}

/** What changed after the editor, for the screen, wrapped to the width: never the whole plan again. Undefined when
 * nothing changed. */
export function planEditRows(edit: PlanEdit, width: number): string[] | undefined {
  if (!edit.added.length && !edit.removed.length && !edit.notes.length && !edit.order) return undefined;
  return [
    ...(edit.added.length || edit.removed.length || edit.order ? ["Your changes:", ...edit.removed.flatMap((line) => hang("  - ", line, width)),
      ...edit.added.flatMap((line) => hang("  + ", line, width)),
      ...edit.order ? ["  The steps in their new order:", ...edit.order.flatMap((step, index) => hang(`    ${index + 1}. `, step, width))] : []] : []),
    ...edit.notes.flatMap((note) => hang("Your note: ", note, width)),
  ];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Text wrapped to the width under a marker ("1. "), later rows indented to line up with the first. Never cut. */
function hang(marker: string, text: string, width: number): string[] {
  const inner = Math.max(10, width - visibleWidth(marker));
  return wrapTextWithAnsi(text, inner).map((row, index) => `${index ? " ".repeat(visibleWidth(marker)) : marker}${row}`);
}

/** The plan screen for a person: the title, what they will see, the steps and one line about the tests. The cases
 * and the details are one key away (`more`: "Ctrl+T shows them" or the plain terminal's choice), or listed here in
 * full with `full` (a run that cannot ask). Wrapped to the width, never cut. */
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
  if (options.full) {
    rows.push(cases);
    for (const item of plan.tests) rows.push(...hang("  - ", item, width));
    if (plan.details?.length) { rows.push("", "Details"); for (const line of plan.details) rows.push(...hang("  ", line, width)); }
  } else {
    const hidden = [...plan.tests.length ? ["them"] : [], ...plan.details?.length ? ["the details"] : []].join(" and ");
    rows.push(...hang("", `${cases}${hidden && options.more ? ` · ${options.more.replace("{what}", hidden)}` : ""}`, width));
  }
  return rows;
}

/** The cases and the details as one text, for Ctrl+T or the plain terminal's "Show the details". */
export function planDetailsText(plan: ParsedPlan): string | undefined {
  const parts = [
    ...plan.tests.length ? [`Tests:\n${plan.tests.map((item) => `- ${item}`).join("\n")}`] : [],
    ...plan.details?.length ? [`Details:\n${plan.details.join("\n")}`] : [],
  ];
  return parts.length ? parts.join("\n\n") : undefined;
}

/** The editor heading and key hint for the plan. */
export function planEditorHeading(plan: ParsedPlan): { heading: string; hint: string } {
  return {
    heading: `Casper plan: ${plural(plan.steps.length, "step", "steps")}, ${plural(plan.tests.length, "case", "cases")} to test.`,
    hint: "Enter goes on to 1 Stop · 2 Build · edit lines · Esc stops without building",
  };
}

/** The plan as the build turn reads it: the steps the user accepted, then everything else the plan said (title,
 * what the user will see, their notes, and the details the screen kept one key away). The cases go separately. */
export function formatPlanBlock(plan: ParsedPlan): string {
  return [
    `Casper plan (the user read and accepted it). Follow these steps in order:\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
    ...plan.title ? [`Title: ${plan.title}`] : [],
    ...plan.see?.length ? [`What the user will see:\n${plan.see.join("\n")}`] : [],
    ...plan.notes?.length ? [`The user's notes on the plan (take each into account):\n${plan.notes.map((note) => `- ${note}`).join("\n")}`] : [],
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
