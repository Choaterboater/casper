import { stripVTControlCharacters } from "node:util";
import type { ProjectCommand } from "../project/model";
import type { ToolObservationInput } from "../runtime/observation";
import type { RuntimeEvent } from "../runtime/types";

type ToolEnd = Extract<RuntimeEvent, { type: "tool_end" }>;
export type RecoveryKind = "timeout" | "service" | "conflict" | "test-first";

/** Display names, not evidence: the verifier's ids and results are never changed. */
export const CHECK_NAMES: Record<ProjectCommand, string> = { test: "tests", lint: "lint", typecheck: "typecheck", build: "build" };
export function checkName(name: string): string { return Object.hasOwn(CHECK_NAMES, name) ? CHECK_NAMES[name as ProjectCommand] : name; }
const CHECK_GUESSES: ReadonlyArray<[RegExp, ProjectCommand]> = [
  [/^(?:(?:bun|npm|pnpm|yarn) (?:run )?test\b|(?:python[\d.]* -m )?pytest\b|cargo test\b|go test\b)/, "test"],
  [/^(?:(?:bun|npm|pnpm|yarn) (?:run )?lint\b|(?:bunx |npx )?(?:oxlint|eslint)\b|ruff check\b|cargo clippy\b)/, "lint"],
  [/^(?:(?:bun|npm|pnpm|yarn) (?:run )?typecheck\b|(?:bunx |npx )?tsc\b|mypy\b|pyright\b)/, "typecheck"],
  [/^(?:(?:bun|npm|pnpm|yarn) (?:run )?build\b|cargo build\b|go build\b)/, "build"],
];
export function commandCheck(command: string, commands: Partial<Record<ProjectCommand, string>> = {}): ProjectCommand | undefined {
  const text = command.replace(/\s+/g, " ").trim().replace(/^(?:cd \S+ && )+/, "");
  for (const [name, own] of Object.entries(commands) as Array<[ProjectCommand, string | undefined]>) {
    const wanted = own?.replace(/\s+/g, " ").trim();
    if (wanted && (text === wanted || text.startsWith(`${wanted} `))) return name;
  }
  return CHECK_GUESSES.find(([pattern]) => pattern.test(text))?.[1];
}

/** Only explicit test-file arguments count; no made-up count for a directory or glob. */
export function testFileCount(command: string): number {
  return new Set((command.match(/(?:"[^"]*"|'[^']*'|[^\s;&|]+)/g) ?? [])
    .map(word => word.replace(/^["']|["']$/g, ""))
    .filter(word => !/[*?$]/.test(word) && /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)test_[^/]+\.py|_test\.(?:py|go)|\.Tests\.ps1)$/.test(word))).size;
}
export function runningCheck(input: ToolObservationInput | undefined, commands?: Partial<Record<ProjectCommand, string>>): string | undefined {
  const name = input?.check ? checkName(input.check) : input?.command ? commandCheck(input.command, commands) : undefined;
  if (!name) return undefined;
  const label = checkName(name);
  const count = label === "tests" && input?.command ? testFileCount(input.command) : 0;
  return `Running ${label}${count ? ` (${count} ${count === 1 ? "file" : "files"})` : ""}`;
}

export function emptyLookup(tool: string, text: string): boolean {
  return ["grep", "find", "ls"].includes(tool) && /^(?:No matches found|No files found matching pattern|\(empty directory\))\.?$/i.test(text.trim());
}

/** Programs whose exit 1 is their answer, not a failure, and the note that says it. */
const EXIT_ANSWERS: Record<string, string> = {
  grep: "nothing found", egrep: "nothing found", fgrep: "nothing found", rg: "nothing found", ag: "nothing found", ack: "nothing found",
  findstr: "nothing found", diff: "files differ", cmp: "files differ", test: "false", "[": "false", "[[": "false",
  which: "not installed", where: "not installed", type: "not installed", pgrep: "no process found",
};
/** Notes that are a finished command's answer: a retry that ends with one has finished. */
const ANSWER_NOTES = new Set([...Object.values(EXIT_ANSWERS), "changes found"]);
/** PowerShell aliases with another meaning (Where-Object, Get-Content, Compare-Object) and words only bash has. */
const NOT_POWERSHELL = new Set(["where", "type", "diff", "test", "[", "[[", "command"]);
/** An exit 1 that printed one of these is a real error, not an answer. */
const EXIT_ERRORS = /No such file|Permission denied|Access is denied|invalid option|unrecognized option|illegal option|unknown option|Is a directory|cannot open/i;

/** A one-line shell command as its simple commands (quotes taken off, redirections such as `2>/dev/null` left out) and
 * the operator after each. Undefined for what a plain reading can't follow: `$(…)`, backticks, a subshell, a heredoc,
 * a background `&`, an open quote, a line break. */
function shellCommands(line: string): Array<{ words: string[]; op?: string }> | undefined {
  const commands: Array<{ words: string[]; op?: string }> = [];
  let words: string[] = [];
  let word: string | undefined;
  let target = false;
  const end = () => {
    if (word !== undefined) { if (target) target = false; else words.push(word); }
    word = undefined;
  };
  const close = (op?: string) => {
    end();
    if (target || !words.length) return false;
    commands.push({ words, ...(op ? { op } : {}) });
    words = [];
    return true;
  };
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!;
    if (char === "'") {
      const shut = line.indexOf("'", at + 1);
      if (shut < 0) return undefined;
      word = (word ?? "") + line.slice(at + 1, shut);
      at = shut;
      continue;
    }
    if (char === "\"") {
      let text = "";
      for (at++; at < line.length && line[at] !== "\""; at++) {
        if (line[at] === "`" || line.startsWith("$(", at)) return undefined;
        if (line[at] === "\\" && /["\\$`]/.test(line[at + 1] ?? "")) at++;
        text += line[at];
      }
      if (at >= line.length) return undefined;
      word = (word ?? "") + text;
      continue;
    }
    if (char === "\\") {
      if (at + 1 >= line.length || /[\r\n]/.test(line[at + 1]!)) return undefined;
      word = (word ?? "") + line[++at];
      continue;
    }
    if (/[`()\r\n]/.test(char) || line.startsWith("$(", at)) return undefined;
    if (char === " " || char === "\t") { end(); continue; }
    const two = line.slice(at, at + 2);
    if (two === "&&" || two === "||") { if (!close(two)) return undefined; at++; continue; }
    if (char === ";" || char === "|") { if (!close(char)) return undefined; continue; }
    if (char === ">" || char === "<" || two === "&>") {
      // A descriptor number just before it (`2>`) is part of the redirection, not a word.
      if (word !== undefined && !/^\d+$/.test(word)) end(); else word = undefined;
      if (target || line.startsWith("<<", at)) return undefined;
      if (char === "&") at++;
      if (line[at + 1] === ">") at++;
      const copy = /^&(?:\d+|-)/.exec(line.slice(at + 1));
      if (copy) at += copy[0].length; else target = true;
      continue;
    }
    if (char === "&") return undefined;
    word = (word ?? "") + char;
  }
  end();
  if (target) return undefined;
  if (words.length) commands.push({ words });
  else if (commands.at(-1)?.op === ";") delete commands.at(-1)!.op;
  else return undefined;
  return commands;
}

/** The note for one simple command whose exit 1 is its answer, or undefined. */
function exitAnswer(words: readonly string[], powershell: boolean): string | undefined {
  let at = 0;
  while (at < words.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!)) at++;
  const typed = words[at] ?? "";
  const exe = /\.exe$/i.test(typed);
  const program = typed.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
  const args = words.slice(at + 1);
  if (powershell && !exe && NOT_POWERSHELL.has(program)) return undefined;
  if (program === "git") {
    let sub = 0;
    while (sub < args.length && /^(?:--no-pager|-C|-c)$/.test(args[sub]!)) sub += args[sub] === "--no-pager" ? 1 : 2;
    const options = args.slice(sub + 1);
    const before = options.includes("--") ? options.slice(0, options.indexOf("--")) : options;
    if (args[sub] === "grep") return "nothing found";
    if (args[sub] !== "diff") return undefined;
    if (before.includes("--no-index")) return "files differ";
    return before.includes("--quiet") || before.includes("--exit-code") ? "changes found" : undefined;
  }
  if (program === "command") return /^-[vV]$/.test(args[0] ?? "") ? "not installed" : undefined;
  return Object.hasOwn(EXIT_ANSWERS, program) ? EXIT_ANSWERS[program] : undefined;
}

/** Pi's shell calls every non-zero exit an error. `grep` that found nothing, `diff` that found a difference, `test` that
 * was false: exit 1 is their answer, when the line runs only that kind of program (after a `cd DIR &&`) and printed no
 * error. Display only: the model still gets the exit code. */
function shellAnswer(event: ToolEnd, text: string): string | undefined {
  if (!event.isError || !["bash", "powershell"].includes(event.toolName) || typeof event.input?.command !== "string") return undefined;
  const status = [...text.matchAll(/(?:^|\n\n)Command exited with code (\d+)(?=\n|$)/g)].at(-1)?.[1];
  if (status !== "1" || EXIT_ERRORS.test(text)) return undefined;
  let commands = shellCommands(event.input.command.trim());
  while (commands && commands.length > 1 && commands[0]!.words[0] === "cd" && commands[0]!.words.length <= 2 && commands[0]!.op === "&&") commands = commands.slice(1);
  const answers = new Set(commands?.map(command => exitAnswer(command.words, event.toolName === "powershell")));
  return answers.size === 1 ? [...answers][0] : undefined;
}

/** Expected lookup misses and designed skips are notes. Permission and parse errors are not. */
export function outcomeNote(event: ToolEnd): string | undefined {
  const text = event.output?.text ?? "";
  if (event.sessionOnlyCheck) return "session-only check in use";
  if (emptyLookup(event.toolName, text)) return "nothing found";
  if (event.toolName === "read" && event.isError && /\bENOENT\b|no such file or directory|file not found/i.test(text)) return "path not found";
  if (["read", "grep", "find", "ls"].includes(event.toolName) && /^Skipped as a repeat\b/.test(text.trim())) return "skipped repeated lookup";
  if (event.toolName === "casper_check") {
    try { if (JSON.parse(text).status === "skip") return "skipped"; } catch { /* Not a check result. */ }
  }
  return shellAnswer(event, text);
}

/** Display intent only: negated expectations are not an expected red phase. */
export function expectsTestFailure(text: string): boolean {
  if (/(?:\bnot|\bisn't|\bwithout|\bno)\s+(?:an?\s+)?(?:test[- ]first|TDD|red phase)|(?:not|never|don't|do not)\s+expect(?:ing)?\b/i.test(text)) return false;
  return /(?:test[- ]first|\bTDD\b|red phase)/i.test(text)
    && /(?:\bexpect(?:ing)?\b(?![^.!?\n]{0,80}\b(?:no|not|never|without)\b)[^.!?\n]{0,80}\bfail\b|\bshould fail\b|\bintentionally fail\b)/i.test(text);
}

/** A recovery is provisional until a matching operation succeeds; ordinary failed checks never qualify. */
export function recoveryKind(event: ToolEnd, testFirst = false, commands?: Partial<Record<ProjectCommand, string>>): RecoveryKind | undefined {
  if (!event.isError) return undefined;
  const text = event.output?.text ?? "";
  const tests = event.input?.check === "test" || (event.input?.command && commandCheck(event.input.command, commands) === "test");
  if (testFirst && tests && (testFailureSummary(text) || /(?:\b[1-9]\d* (?:fail|failed)|\(fail\)|FAIL(?:ED)?\b)/.test(text))) return "test-first";
  if (event.toolName === "casper_check") return undefined;
  if (event.input?.command && /\bgit (?:merge|cherry-pick)\b/.test(event.input.command) && /CONFLICT\b|fix conflicts|resolve.*conflicts/i.test(text)) return "conflict";
  // A failed check that printed "timeout" or an HTTP code is still a failed check.
  // Only a process-level timeout with no failing assertions can be treated as a retry.
  if (event.input?.command && commandCheck(event.input.command, commands)) {
    if (/\(fail\)|\b[1-9]\d* (?:fail|failed)\b|AssertionError|^FAIL\b/m.test(text)) return undefined;
    return /(?:^|\n)(?:Command|Process|Execution) timed out\b/i.test(text) ? "timeout" : undefined;
  }
  if (/timed out|timeout|ETIMEDOUT/i.test(text)) return "timeout";
  if (/\b(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|503|502|429)\b|service unavailable|rate limit|temporarily unavailable/i.test(text)) return "service";
  return undefined;
}
export function recoveredBy(kind: RecoveryKind, before: { toolName: string; input?: ToolObservationInput }, after: ToolEnd): boolean {
  const note = outcomeNote(after);
  const answered = note !== undefined && ANSWER_NOTES.has(note);
  if ((after.isError && !answered) || before.toolName !== after.toolName || (note && !answered)) return false;
  if (kind === "timeout" && ["grep", "find"].includes(before.toolName) && before.input?.pattern === after.input?.pattern) return true;
  if (kind === "conflict") {
    const operation = /\bgit (merge|cherry-pick)\b/.exec(before.input?.command ?? "")?.[1];
    return !!operation && new RegExp(`^(?:git add [^;&|\\n]+ && )?git ${operation} --continue(?: --no-edit)?\\s*$`).test(after.input?.command?.trim() ?? "");
  }
  // Timeout limits are not observation identities; a longer retry has the same command/path/url.
  const keys: Array<keyof ToolObservationInput> = ["path", "command", "operation", "pattern", "check", "url", "query"];
  return keys.every(key => before.input?.[key] === after.input?.[key]);
}

/** Only explicit runner summaries support a denominator; never count individual passing tail lines. */
export function testFailureSummary(output: string): string | undefined {
  try {
    const result = JSON.parse(output);
    if (result && typeof result === "object") output = [result.stderr, result.stdout].filter(value => typeof value === "string").join("\n");
  } catch { /* Ordinary command output. */ }
  const summaries = stripVTControlCharacters(output).split("\n")
    .filter(line => /^\s*(?:Tests:|[=]+)|^\s*\d+ (?:pass|passed|fail|failed|skip|skipped)\b/.test(line)).join("\n");
  const last = (pattern: RegExp) => { const value = [...summaries.matchAll(pattern)].at(-1)?.[1]; return value === undefined ? undefined : Number(value); };
  const failed = last(/\b(\d+) (?:fail|failed)\b/g);
  const passed = last(/\b(\d+) (?:pass|passed)\b/g);
  const total = last(/\b(\d+) total\b/g) ?? (passed === undefined || failed === undefined ? undefined : passed + failed + (last(/\b(\d+) (?:skip|skipped)\b/g) ?? 0));
  return failed && total !== undefined && total >= failed ? `${failed} of ${total} tests failed` : undefined;
}

/** A narrow GitHub label, only for successful, recognized PR operations. */
export function githubLabel(input: ToolObservationInput | undefined, output = "", running = false): string | undefined {
  // Help and previews run the command, not the PR action (including while it is running).
  if (/[\n;&|]/.test(input?.command ?? "") || /\s(?:--(?:help|dry-run)(?:[=\s]|$)|-h(?:\s|$))/.test(input?.command ?? "")) return undefined;
  const match = /^\s*gh pr (edit|create|view|checks|merge|close|reopen|comment)\b(?:\s+(\d+))?/.exec(input?.command ?? "");
  if (!match) return undefined;
  const number = match[2] ?? /\/pull\/(\d+)\b/.exec(output)?.[1];
  const target = number ? `PR #${number}` : "PR";
  if (match[1] === "merge" && /(?:^|\s)--auto(?:\s|$)/.test(input?.command ?? "")) return `${running ? "Enabling" : "Enabled"} auto-merge for ${target}`;
  const verbs = { edit: ["Updating", "Updated"], create: ["Creating", "Created"], view: ["Reading", "Read"], checks: ["Checking", "Checked"], merge: ["Merging", "Merged"], close: ["Closing", "Closed"], reopen: ["Reopening", "Reopened"], comment: ["Commenting on", "Commented on"] };
  return `${verbs[match[1] as keyof typeof verbs][running ? 0 : 1]} ${target}`;
}
