import type { ToolObservationInput } from "../runtime/observation";
import { configEntries, isConfigFile, isLockfile } from "../task/config-files";
import type { DisplayLevel } from "../tui/display";
import { CHANGE_GLYPH, displayPath, type ToolLineFit } from "../tui/format";
import { describeSteps, type EditedFile, type FailedStep } from "../tui/step-view";
import type { FoldView } from "../tui/terminal";
import type { StepChange } from "./changes";

export type StepKind = "edit" | "command" | "read" | "other";

export function stepKind(toolName: string): StepKind {
  if (toolName === "edit" || toolName === "write") return "edit";
  if (toolName === "bash" || toolName === "powershell") return "command";
  if (["read", "grep", "find", "ls"].includes(toolName)) return "read";
  return "other";
}

/** A finished step, as the fold needs it. */
export interface FinishedStep {
  toolName: string;
  kind: StepKind;
  input?: ToolObservationInput;
  /** A shell step's title from the AI: the fold row names it by that. */
  description?: string;
  path?: string;
  elapsedMs?: number;
  failed?: boolean;
  /** A failed edit the model tried again at once: counted nowhere, shown nowhere. */
  retried?: boolean;
  /** Casper stopped it before it ran: its line (with the reason) is shown as it is. */
  notRun?: boolean;
  /** The step's line, as the detailed level and a not-run step show it (with a reason under it when there is one). */
  printed: string;
  /** The step's line alone ("✗ bash · git push — failed"), the title of its failure box. */
  title: string;
  /** What it printed, for a failure's box. */
  output?: string;
  /** A successful edit's size and diff. */
  lines?: { added: number; removed: number };
  diff?: string;
  /** What it changed beyond this project's code (another machine, a device, this computer's setup): rows that stay in view. */
  changes?: StepChange[];
}

/** The edit box's rows at the normal level: enough to see what changed, short enough to keep the AI's words in view. */
export const EDIT_BOX_LINES = 10;

/** "a, b, c" or "a, b, c +2 more". */
const names = (list: readonly string[]) => list.length > 3 ? `${list.slice(0, 3).join(", ")} +${list.length - 3} more` : list.join(", ");

/**
 * What the screen shows for a group of finished steps once the AI moves on.
 * normal: one row naming what went well (reads, commands, searches…), the edits in one box with a short diff (named in
 * the row instead when none has a diff to show), each failure in a box with what it printed. quiet: only the failures.
 * detailed: every step's own line, and every edit's whole diff. At every level a step Casper stopped before it ran keeps its line and reason, and a failed edit the model
 * tried again at once is shown nowhere.
 * Changes stay in view at every level and are never part of the row: config files in a box of their own with their
 * diff (lockfiles one row), and what changed another machine, a device or this computer's setup as a ◆ row, with what was
 * sent elsewhere in its box. At quiet they are rows only.
 */
export function planFold(steps: readonly FinishedStep[], level: DisplayLevel, fit: ToolLineFit & { home?: string } = {}): FoldView {
  const ran = steps.filter(step => !step.notRun && !step.retried);
  const ok = ran.filter(step => !step.failed);
  const failures: FailedStep[] = ran.filter(step => step.failed)
    .map(step => ({ title: step.title, ...(step.output ? { output: step.output } : {}), ...(fit.home ? { home: fit.home } : {}) }));
  const allEdits: EditedFile[] = ok.filter(step => step.kind === "edit").map(step => ({
    path: step.path !== undefined ? displayPath(step.path, fit) : "a file",
    ...(step.lines ? { added: step.lines.added, removed: step.lines.removed } : {}),
    ...(step.diff ? { diff: step.diff } : {}),
  }));
  const config = allEdits.filter(edit => isConfigFile(edit.path) && !isLockfile(edit.path));
  const locks = [...new Set(allEdits.filter(edit => isLockfile(edit.path)).map(edit => edit.path))];
  const lockEntry = configEntries({ files: [], lockfiles: locks })[0];
  const changes = steps.flatMap(step => step.changes ?? []);
  const boxedChanges = level === "quiet" ? [] : changes.filter(change => change.sent?.length);
  const lines = [...steps.filter(step => step.notRun).map(step => step.printed),
    ...changes.filter(change => !boxedChanges.includes(change)).map(change => `${CHANGE_GLYPH} ${change.row}`),
    ...(level === "quiet" && config.length ? [`${CHANGE_GLYPH} Changed config: ${names([...new Set(config.map(edit => edit.path))])}`] : []),
    ...(lockEntry ? [locks.length === 1 ? `${CHANGE_GLYPH} lockfile updated (${lockEntry})` : `${CHANGE_GLYPH} ${lockEntry} updated`] : [])];
  const changeBoxes = { ...(level !== "quiet" && config.length ? { config } : {}), ...(boxedChanges.length ? { changes: boxedChanges } : {}) };
  if (level === "quiet") return { parts: [], lines, edits: [], editLines: 0, failures };
  const edits = allEdits.filter(edit => !isConfigFile(edit.path));
  if (level === "detailed") {
    return { parts: [], lines: [...lines, ...ok.filter(step => step.kind !== "edit").map(step => step.printed)], edits, editLines: Infinity, failures, ...changeBoxes };
  }
  // A box is for a diff: edits with none to show (a new file written whole) are named in the row instead.
  const boxed = edits.some(edit => edit.diff);
  const named = ok.filter(step => !step.changes?.length
    && !(step.kind === "edit" && step.path !== undefined && isConfigFile(displayPath(step.path, fit))) && (step.kind !== "edit" || !boxed));
  const parts = describeSteps(named.map(step => step.input || step.path === undefined ? step : { ...step, input: { path: step.path } }), fit);
  return { parts, lines, edits: boxed ? edits : [], editLines: EDIT_BOX_LINES, failures, ...changeBoxes };
}
