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
  return undefined;
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
  if ((after.isError && note !== "nothing found") || before.toolName !== after.toolName || (note && note !== "nothing found")) return false;
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
