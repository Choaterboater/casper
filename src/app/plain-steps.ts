/** The live steps as plain lines (the rich terminal's default; Ctrl+O shows the raw steps instead): one line that
 * counts what the AI looked through, updated in place ("Looking through the code: 14 searches, 9 files read, 3 found
 * nothing (2m)"), one line for the edits, and a short line for each command ("Ran tests"). */

import type { ToolObservationInput } from "../runtime/observation";
import type { ProjectCommand } from "../project/model";
import { BUSY_GLYPH, CHANGE_GLYPH, commandLabel, displayPath, formatDuration, redactPreview, runningElapsed, type ToolLineFit } from "../tui/format";
import { describeSteps } from "../tui/step-view";
import type { StepKind } from "./fold";
import type { StepChange } from "./changes";
import { isConfigFile } from "../task/config-files";
import { CHECK_NAMES, commandCheck, githubLabel, runningCheck, testFailureSummary } from "../tui/tool-status";

/** A step of the open group, as the plain list needs it. */
export interface PlainStep {
  toolName: string;
  kind: StepKind;
  input?: ToolObservationInput;
  /** A shell step's title from the AI, shown with its program. */
  description?: string;
  path?: string;
  startedAt: number;
  endedAt?: number;
  failed?: boolean;
  retried?: boolean;
  notRun?: boolean;
  /** A search or listing that found nothing. */
  empty?: boolean;
  /** An expected miss or recovered operation, shown on its own neutral line. */
  note?: string;
  /** The raw line, kept as it is for a step Casper stopped before it ran. */
  line: string;
  /** A running command's latest output row (`↳ …`), shown under it. */
  tailRow?: string;
  output?: string;
  /** What it changed beyond the project's code: shown as its ◆ rows once it ends. */
  changes?: readonly StepChange[];
}

export interface PlainOptions { fit?: ToolLineFit; commands?: Partial<Record<ProjectCommand, string>> }

/** What a search, find or listing prints when there is nothing. */
const NOTHING_FOUND = /^(?:No matches found|No files found matching pattern|\(empty directory\))$/;
export function foundNothing(text: string | undefined): boolean { return NOTHING_FOUND.test(text?.trim() ?? ""); }

const CHECK_WORDS = CHECK_NAMES;

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
  const check = step.toolName === "casper_check" && typeof step.input?.check === "string" && Object.hasOwn(CHECK_WORDS, step.input.check)
    ? CHECK_WORDS[step.input.check as ProjectCommand] : undefined;
  const checkId = command ? commandCheck(command, options.commands) : undefined;
  const named = check ?? (checkId ? CHECK_WORDS[checkId] : undefined);
  const label = named ?? (command ? commandLabel(redactPreview(command), 60).replace(/ …$/, "") : "a command");
  const human = runningCheck(step.input, options.commands) ?? githubLabel(step.input, "", true);
  const github = !step.failed && !running(step) && githubLabel(step.input);
  // A titled step: the AI's title, then the program that really runs.
  if (step.description && !github) {
    const title = redactPreview(step.description).replace(/\s+/g, " ");
    const program = command ? commandLabel(redactPreview(command), 60).replace(/ …$/, "") : label;
    if (running(step)) return `${BUSY_GLYPH} ${title} · ${program}${runningElapsed(now - step.startedAt)}`;
    if (step.failed) return `✗ ${title} · ${(named === "tests" ? testFailureSummary(step.output ?? "") : undefined) ?? `${program} failed`}`;
    return `✓ ${title} · ${program}${took(step.endedAt! - step.startedAt)}`;
  }
  if (running(step)) return `${BUSY_GLYPH} ${human ? redactPreview(human).replace(/\s+/g, " ") : `Running ${label}`}${runningElapsed(now - step.startedAt)}`;
  if (github) return `✓ ${github}${took(step.endedAt! - step.startedAt)}`;
  if (step.failed) {
    const summary = named === "tests" ? testFailureSummary(step.output ?? "") : undefined;
    return `✗ ${summary ?? `${capital(label)} failed`}`;
  }
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
  const looks = steps.filter(step => step.kind === "read" && !step.notRun && !step.note);
  const config = (step: PlainStep) => step.kind === "edit" && isConfigFile(where(step, fit));
  const edits = steps.filter(step => step.kind === "edit" && !step.notRun && !step.retried && !step.failed && !config(step));
  const configs = steps.filter(step => config(step) && !step.notRun && !step.retried && !step.failed);
  const rows: string[] = [];
  let looked = false, edited = false, configured = false;
  for (const step of steps) {
    if (step.notRun || step.note) { rows.push(step.line); continue; }
    if (step.retried) continue;
    // A change stays in view on its own rows, never as "Ran …".
    if (step.changes?.length && !running(step)) { rows.push(...step.changes.map(change => `${CHANGE_GLYPH} ${change.row}`)); continue; }
    if (step.kind === "read") {
      if (!looked) rows.push(lookingLine(looks, now));
      looked = true;
    } else if (config(step) && !step.failed) {
      if (!configured) {
        configured = true;
        const busy = configs.some(running);
        rows.push(`${busy ? BUSY_GLYPH : CHANGE_GLYPH} ${busy ? "Changing" : "Changed"} config: ${names(configs.map(edit => where(edit, fit)))}`);
      }
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
