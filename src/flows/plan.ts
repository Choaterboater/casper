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
import { formatChecklistPrompt, normalizeCases } from "../task/checklist";

/** Pi's built-in tools that only look at files. Every other tool (edit, write, MCP tools, services,
 * the browser, delegation...) is blocked while planning, whatever it says about itself. */
export const PLANNING_TOOLS = new Set(["read", "grep", "find", "ls"]);

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
    if (shell === "powershell") return POWERSHELL_COMMANDS.has(name!.toLowerCase()) && !/[(){}[\]@]/.test(command);
    const check = Object.hasOwn(BASH_COMMANDS, name!) ? BASH_COMMANDS[name!] : undefined;
    return Boolean(check?.(args));
  });
}

/** ssh that only runs something on the other machine: no local log file (-E), no options (-o LocalCommand ...). */
const sshOnly = (args: string[]) => !args.some((arg) => flag(arg, "-E", "-o") || short(arg, "EoFSMN"));

/** Whether a shell command leaves this machine's files alone, so by itself it can't make the task's changes
 * unknown: every part is a look command (ls, cat, grep, find, git log ...) or ssh to another machine, which the
 * receipt reports on its own line. The same strict reading as the plan turn's list. */
export function leavesLocalFilesAlone(command: string): boolean {
  if (command.length > 2000) return false;
  const parts = segments(command);
  if (!parts) return false;
  return parts.every(([name, ...args]) => name === "ssh" ? sshOnly(args)
    : Boolean((Object.hasOwn(BASH_COMMANDS, name!) ? BASH_COMMANDS[name!] : undefined)?.(args)));
}

/** The gate for a plan turn, for every tool call. Undefined lets the call run; a reason blocks it. */
export function planToolGate(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (PLANNING_TOOLS.has(toolName)) return undefined;
  if (toolName === "bash" || toolName === "powershell") {
    const command = typeof input?.command === "string" ? input.command : "";
    if (isPlanningCommand(command, toolName)) return undefined;
    return `${PLANNING_BLOCKED}. While planning it runs only look commands such as ls, cat, grep and git log.`;
  }
  if (toolName === "edit" || toolName === "write") return `${PLANNING_BLOCKED}.`;
  return `${PLANNING_BLOCKED}. While planning it allows only read, grep, find and ls, not ${toolName}.`;
}

export interface ParsedPlan {
  steps: string[];
  tests: string[];
}

/** Tidy one step for the editor: no Markdown emphasis or code marks, one line. (Pi's cleanStepText,
 * without its 50-character cut: the user reads and edits the whole step.) */
function cleanLine(text: string): string {
  const cleaned = text
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 300 ? `${cleaned.slice(0, 297)}...` : cleaned;
}

function section(message: string, name: string): string | undefined {
  const header = new RegExp(`^\\s*(?:#{1,6}\\s*)?\\*{0,2}${name}:?\\*{0,2}:?\\s*$`, "im").exec(message);
  if (!header) return undefined;
  const rest = message.slice(header.index + header[0].length);
  // The section ends at the next "Name:" header line.
  const next = /^\s*(?:#{1,6}\s*)?\*{0,2}[A-Z][A-Za-z ]{1,30}:?\*{0,2}:?\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** The "Plan:" numbered steps and the "Tests:" cases of the model's answer. Missing sections give empty lists. */
export function extractPlan(message: string): ParsedPlan {
  const plan = section(message, "Plan") ?? "";
  const tests = section(message, "Tests") ?? "";
  const steps = [...plan.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)]
    .map((match) => cleanLine(match[1]!))
    .filter((text) => text.length > 3);
  const cases = [...tests.matchAll(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/gm)]
    .map((match) => cleanLine(match[1]!))
    .filter((text) => text.length > 3);
  return { steps, tests: normalizeCases(cases) };
}

const TEST_PREFIX = "Test: ";

/** The plan as editor lines: steps first, then one "Test: ..." line per case. */
export function planEditorLines(plan: ParsedPlan): string[] {
  return [...plan.steps, ...plan.tests.map((item) => `${TEST_PREFIX}${item}`)];
}

/** The editor's lines back into steps and cases. Blank lines are dropped; a leading "1." is removed. */
export function parsePlanLines(lines: readonly string[]): ParsedPlan {
  const steps: string[] = [];
  const tests: string[] = [];
  for (const line of lines) {
    const text = cleanLine(line);
    if (!text) continue;
    const test = /^tests?:\s*(.*)$/i.exec(text);
    if (test) { if (test[1]!.trim()) tests.push(test[1]!.trim()); continue; }
    const step = text.replace(/^(?:step\s*)?\d+[.):]\s*/i, "").trim();
    if (step) steps.push(step);
  }
  return { steps, tests: normalizeCases(tests) };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The editor heading and key hint for the plan. */
export function planEditorHeading(plan: ParsedPlan): { heading: string; hint: string } {
  return {
    heading: `Casper plan: ${plural(plan.steps.length, "step", "steps")}, ${plural(plan.tests.length, "case", "cases")} to test.`,
    hint: "Enter goes on to 1 Stop · 2 Build · edit lines · Esc stops without building",
  };
}

/** The build turn's prompt: the request, the steps the user accepted and the cases to test. This
 * replaces the separate checklist call. */
export function formatBuildPrompt(request: string, plan: ParsedPlan): string {
  return [
    request,
    "",
    `Casper plan (the user read and accepted it). Follow these steps in order:\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
    ...(plan.tests.length ? ["", formatChecklistPrompt(plan.tests)] : []),
  ].join("\n");
}
