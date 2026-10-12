/**
 * /rewind: back to just before one of your earlier prompts in this conversation, with that prompt's words back in the
 * prompt to change and send again. When tasks after it changed files, one numbered choice also puts those files back
 * (undo's copies, as /undo would, task by task). No model call. Nothing is deleted: the later turns stay in the
 * conversation's saved file, on the branch Casper left.
 */
import type { OutputWriter } from "./commands";
import type { TaskUndo, UndoableTask } from "./undo";
import type { RuntimeSession } from "../runtime/types";
import { KEY_PICK_MAX } from "../tui/choices";
import { lineText, terminalText } from "../tui/format";
import type { InteractiveTerminal } from "../tui/terminal";

export interface RewindHost {
  readonly output: OutputWriter;
  readonly terminal: InteractiveTerminal;
  readonly interactive: boolean;
  /** The conversation, only when it is already running (rewind never starts a model session). */
  readonly liveSession?: RuntimeSession;
  readonly taskUndo: TaskUndo;
}

export const REWIND_USAGE = "Usage: /rewind [n] (n: 1 is your last prompt)";

/** The two answers when tasks after the prompt changed files. The first changes no file. */
export const REWIND_CHOICES = [
  { label: "Conversation only", description: "the files stay as they are now" },
  { label: "Conversation and files", description: "the files go back as they were before that prompt; /redo <task> puts one back again" },
] as const;

/** One of your prompts on the conversation's branch: where to rewind to, and your words. */
export interface EarlierPrompt {
  /** The conversation's position just before the prompt (null: the start). */
  before: string | null;
  /** Its place in the branch's entries. */
  index: number;
  words: string;
}

/** Casper's own rounds inside a task (repairs, review, proof, page look, a retry): they are not your prompts. A build
 * after an accepted plan belongs to its /plan prompt. */
const ROUND = /\nOriginal request:\n|^Your last response failed with a provider error\.|\n\nCasper plan \(the user read and accepted it\)/;
/** What Casper adds after your words in a task's message (a flow, the checklist, a builders line). */
const TAIL = /\n\n(?:Casper flow "|Cases your request states|Split this job:|Do this yourself: no builders)/;
const PLAN = /^Casper flow "[^"\n]*", chosen by the user[\s\S]*?\n--- End flow ---\n\nRequest: ([\s\S]*?)(?:\n\nCases the user listed \(put each under Tests:\):\n[\s\S]*)?$/;

/** Your own words in a message Casper sent the model, or undefined for one of Casper's own rounds. A /plan comes back
 * as "/plan <words>", so sending it again plans again. */
export function promptWords(text: string): string | undefined {
  if (ROUND.test(text)) return undefined;
  const plan = PLAN.exec(text);
  if (plan) return plan[1]!.trim() ? `/plan ${plan[1]!.trim()}` : undefined;
  const marker = text.lastIndexOf("User request:\n");
  let words = marker === -1 ? text : text.slice(marker + "User request:\n".length);
  const tail = TAIL.exec(words);
  if (tail) words = words.slice(0, tail.index);
  return words.trim() || undefined;
}

/** Your prompts on the branch, newest first. */
export function earlierPrompts(entries: ReadonlyArray<{ id: string; prompt?: string }>): EarlierPrompt[] {
  const found: EarlierPrompt[] = [];
  entries.forEach((entry, index) => {
    const words = entry.prompt === undefined ? undefined : promptWords(entry.prompt);
    if (words !== undefined) found.push({ before: index ? entries[index - 1]!.id : null, index, words });
  });
  return found.reverse();
}

function oneLine(text: string, max = 70): string {
  const line = lineText(text).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** "tasks 7, 6" or "task 7". */
function taskNames(tasks: readonly UndoableTask[]): string {
  return `task${tasks.length === 1 ? "" : "s"} ${tasks.map((task) => task.n).join(", ")}`;
}

/** /rewind [n]. */
export async function rewind(host: RewindHost, argument: string, signal?: AbortSignal): Promise<void> {
  if (!/^(?:\d{1,6})?$/.test(argument)) throw new Error(REWIND_USAGE);
  const write = (text: string) => host.output.write(text);
  const session = host.liveSession;
  let entries: Array<{ id: string; prompt?: string }> | undefined;
  try { entries = session?.conversationEntries?.(); } catch { entries = undefined; }
  if (!session?.rewindTo || !session.conversationMark || !entries) { write("Nothing to rewind: no conversation has started in this session yet.\n"); return; }
  const prompts = earlierPrompts(entries);
  if (!prompts.length) { write("Nothing to rewind: this conversation has no prompts of yours yet.\n"); return; }
  const canAsk = host.interactive;
  const labels = prompts.map((prompt, at) => `${oneLine(prompt.words)}${prompts.slice(0, at).some((other) => oneLine(other.words) === oneLine(prompt.words)) ? ` (${at + 1})` : ""}`);
  let at: number;
  if (argument) {
    at = Number(argument) - 1;
    if (!prompts[at]) { write(`No prompt ${Number(argument)}: this conversation has ${prompts.length}. /rewind lists them.\n`); return; }
  } else if (canAsk) {
    const shown = labels.slice(0, KEY_PICK_MAX);
    if (prompts.length > shown.length) write(`${prompts.length - shown.length} older prompt(s) not shown: /rewind <n> picks one (1 is your last).\n`);
    const picked = await host.terminal.pick("Rewind to just before which prompt?", shown.map((label) => ({ label })), signal);
    at = picked === undefined ? -1 : shown.indexOf(picked);
    if (at < 0) { write("Nothing was changed.\n"); return; }
  } else {
    write(`${labels.map((label, index) => `  ${index + 1} ${terminalText(label)}`).join("\n")}\nType /rewind <n> to go back to just before one (1 is your last).\n`);
    return;
  }
  const target = prompts[at]!;
  // The tasks that ended after this prompt in the conversation: this prompt's own task, every later one, and the ones on
  // a branch an earlier rewind left below it. A task on a branch that leaves this one above the prompt ran before it.
  const ids = entries.map((entry) => entry.id);
  const promptId = entries[target.index]!.id;
  const below = (after: string) => {
    const at = ids.indexOf(after);
    if (at !== -1) return at >= target.index;
    try { return Boolean(session.conversationEntries?.(after).some((entry) => entry.id === promptId)); } catch { return false; }
  };
  let sessionId: string | null = null;
  try { sessionId = session.getSessionInfo?.().sessionId ?? null; } catch { sessionId = null; }
  const tasks = await host.taskUndo.tasksAfter(sessionId, ({ after }) => after !== null && below(after));
  let files = false;
  if (tasks.length && canAsk) {
    const answer = await host.terminal.pick(`${taskNames(tasks)} after that prompt changed files.`, REWIND_CHOICES.map((choice) => ({ ...choice })), signal);
    if (answer === undefined) { write("Nothing was changed.\n"); return; }
    files = answer === REWIND_CHOICES[1].label;
  }
  const expected = session.conversationMark();
  if (files && !(await host.taskUndo.undoTasks(tasks, signal))) return;
  let moved = false;
  try { moved = await session.rewindTo(target.before, expected); } catch { moved = false; }
  if (!moved) {
    write(files ? `Casper could not rewind the conversation; the files were put back (/redo <task> brings one back).\n` : "Casper could not rewind the conversation, so nothing was changed.\n");
    return;
  }
  const back = host.terminal.restoreDraft(target.words);
  const lines = [`✓ Rewound to just before "${terminalText(labels[at]!)}".`,
    back ? "– Its words are back in the prompt: change them and press Enter to send." : `– Your prompt was:\n${terminalText(target.words)}`,
    ...(tasks.length && !files ? [`– Files are as they are now: ${taskNames(tasks)} changed them after that prompt.`] : []),
    "– Nothing is deleted: the later turns stay in this conversation's saved file."];
  write(`${lines.join("\n")}\n`);
}
