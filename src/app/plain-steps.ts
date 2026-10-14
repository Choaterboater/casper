/** The live steps as plain lines (the rich terminal's default; Ctrl+O shows the raw steps instead): one line that
 * counts what the AI looked through, updated in place ("Looking through the code: 14 searches, 9 files read, 3 found
 * nothing (2m)"), one line for the edits, and a short line for each command ("Ran the tests"). */

import type { ToolObservationInput } from "../runtime/observation";
import type { ProjectCommand } from "../project/model";
import { BUSY_GLYPH, commandLabel, displayPath, formatDuration, redactPreview, runningElapsed, type ToolLineFit } from "../tui/format";
import { describeSteps } from "../tui/step-view";
import type { StepKind } from "./fold";

/** A step of the open group, as the plain list needs it. */
export interface PlainStep {
  toolName: string;
  kind: StepKind;
  input?: ToolObservationInput;
  path?: string;
  startedAt: number;
  endedAt?: number;
  failed?: boolean;
  retried?: boolean;
  notRun?: boolean;
  /** A search or listing that found nothing. */
  empty?: boolean;
  /** The raw line, kept as it is for a step Casper stopped before it ran. */
  line: string;
  /** A running command's latest output row (`↳ …`), shown under it. */
  tailRow?: string;
}

export interface PlainOptions { fit?: ToolLineFit; commands?: Partial<Record<ProjectCommand, string>> }

/** What a search, find or listing prints when there is nothing. */
const NOTHING_FOUND = /^(?:No matches found|No files found matching pattern|\(empty directory\))$/;
export function foundNothing(text: string | undefined): boolean { return NOTHING_FOUND.test(text?.trim() ?? ""); }

const CHECK_WORDS: Record<ProjectCommand, string> = { test: "the tests", lint: "the linter", typecheck: "the type check", build: "the build" };
/** Common commands for a check when the project names none. */
const CHECK_GUESSES: ReadonlyArray<[RegExp, ProjectCommand]> = [
  [/^(?:(?:bun|npm|pnpm|yarn) (?:run )?test\b|bun test\b|(?:python[\d.]* -m )?pytest\b|cargo test\b|go test\b)/, "test"],
  [/^(?:(?:bun|npm|pnpm|yarn) (?:run )?lint\b|(?:bunx |npx )?(?:oxlint|eslint)\b|ruff check\b|cargo clippy\b)/, "lint"],
  [/^(?:(?:bun|npm|pnpm|yarn) (?:run )?typecheck\b|(?:bunx |npx )?tsc\b|mypy\b|pyright\b)/, "typecheck"],
  [/^(?:(?:bun|npm|pnpm|yarn) (?:run )?build\b|cargo build\b|go build\b)/, "build"],
];

/** "the tests" for the project's test command (or a common one), else undefined. */
function checkWords(command: string, commands: PlainOptions["commands"] = {}): string | undefined {
  const text = command.replace(/\s+/g, " ").trim().replace(/^(?:cd \S+ && )+/, "");
  for (const [name, own] of Object.entries(commands) as Array<[ProjectCommand, string | undefined]>) {
    const wanted = own?.replace(/\s+/g, " ").trim();
    if (wanted && (text === wanted || text.startsWith(`${wanted} `))) return CHECK_WORDS[name];
  }
  const guess = CHECK_GUESSES.find(([pattern]) => pattern.test(text));
  return guess ? CHECK_WORDS[guess[1]] : undefined;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const count = (n: number, one: string, many: string) => n ? `${n} ${n === 1 ? one : many}` : "";
const running = (step: PlainStep) => step.endedAt === undefined;
/** " (2m05s)" for something that took 10 s or more. */
const took = (ms: number) => ms >= 10_000 ? ` (${formatDuration(ms)})` : "";

function names(list: readonly string[], shown = 3): string {
  const unique = [...new Set(list)];
  return unique.length > shown ? `${unique.slice(0, shown).join(", ")} +${unique.length - shown} more` : unique.join(", ");
}

function where(step: PlainStep, fit: ToolLineFit): string {
  const target = step.path ?? step.input?.path;
  return typeof target === "string" && target ? redactPreview(displayPath(target, fit)) : "a file";
}

function lookingLine(steps: readonly PlainStep[], now: number): string {
  const busy = steps.some(running);
  const reads = new Set(steps.filter(step => step.toolName === "read").map(step => step.path ?? step.input?.path ?? "")).size;
  const parts = [
    count(steps.filter(step => step.toolName === "grep" || step.toolName === "find").length, "search", "searches"),
    count(reads, "file read", "files read"),
    count(steps.filter(step => step.toolName === "ls").length, "folder listed", "folders listed"),
    count(steps.filter(step => step.empty).length, "found nothing", "found nothing"),
    count(steps.filter(step => step.failed).length, "failed", "failed"),
  ].filter(Boolean);
  const start = Math.min(...steps.map(step => step.startedAt));
  const end = busy ? now : Math.max(...steps.map(step => step.endedAt ?? now));
  return `${busy ? BUSY_GLYPH : "✓"} ${busy ? "Looking" : "Looked"} through the code: ${parts.join(", ")}${took(end - start)}`;
}

function commandLine(step: PlainStep, now: number, options: PlainOptions): string {
  const command = typeof step.input?.command === "string" ? step.input.command : undefined;
  const check = step.toolName === "casper_check" && typeof step.input?.check === "string" && step.input.check in CHECK_WORDS
    ? CHECK_WORDS[step.input.check as ProjectCommand] : undefined;
  const named = check ?? (command ? checkWords(command, options.commands) : undefined);
  const label = named ?? (command ? commandLabel(redactPreview(command), 60).replace(/ …$/, "") : "a command");
  if (running(step)) return `${BUSY_GLYPH} Running ${label}${runningElapsed(now - step.startedAt)}`;
  if (step.failed) return `✗ ${capital(label)} failed`;
  return `✓ Ran ${label}${took(step.endedAt! - step.startedAt)}`;
}

function otherLine(step: PlainStep, fit: ToolLineFit): string {
  const part = describeSteps([step], fit)[0];
  const words = part ? `${capital(part.verb)} ${part.names.join(", ")}` : capital(step.toolName);
  return running(step) ? `${BUSY_GLYPH} ${words}` : step.failed ? `✗ ${words} — failed` : `✓ ${words}`;
}

/** The open group's steps as plain lines, in the order they first ran: the looking line and the edits line each
 * once, where their first step ran; a line per command and per other tool; a failed edit on its own line; a step
 * Casper stopped before it ran as its raw line. A failed edit the model tried again at once is left out. */
export function plainSteps(steps: readonly PlainStep[], now: number, options: PlainOptions = {}): string[] {
  const fit = options.fit ?? {};
  const looks = steps.filter(step => step.kind === "read" && !step.notRun);
  const edits = steps.filter(step => step.kind === "edit" && !step.notRun && !step.retried && !step.failed);
  const rows: string[] = [];
  let looked = false, edited = false;
  for (const step of steps) {
    if (step.notRun) { rows.push(step.line); continue; }
    if (step.retried) continue;
    if (step.kind === "read") {
      if (!looked) rows.push(lookingLine(looks, now));
      looked = true;
    } else if (step.kind === "edit") {
      if (step.failed) rows.push(`✗ Couldn't edit ${where(step, fit)}`);
      else if (!edited) {
        edited = true;
        const busy = edits.some(running);
        rows.push(`${busy ? BUSY_GLYPH : "✓"} ${busy ? "Editing" : "Edited"} ${names(edits.map(edit => where(edit, fit)))}`);
      }
    } else if (step.kind === "command" || step.toolName === "casper_check") {
      rows.push(commandLine(step, now, options));
      if (running(step) && step.tailRow) rows.push(step.tailRow);
    } else rows.push(otherLine(step, fit));
  }
  return rows;
}
