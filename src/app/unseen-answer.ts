/**
 * A question answered where Casper never runs checks and can't compare the files (your home folder, the top of a
 * drive): a command it can't read as a look leaves "changes unknown", but nothing it can see changed. That is one grey
 * line, not a card (decision 65); a pure answer in a project folder has no card at all.
 */

import { TOOL_CALL_LIMIT, type ToolCallLine } from "../task/observations";
import type { TaskResult } from "../task/result";
import { NOT_A_PROJECT } from "../task/changes";
import { shellChanges } from "./changes";

/** What a task may hold and still be only an answer: anything else (a check, an edit, a change elsewhere, a stop, a
 * secret, a job left running, a plan) keeps the card. */
const ANSWER_ONLY = new Set(["execution", "observedEdits", "observedChecks", "possibleMutations", "usage", "snapshotFailure", "verificationMode",
  "verificationDefaulted", "untrustedFolder", "sandbox", "undo", "receipt", "remoteChanges", "mediaLeftOut"]);

/** The command text kept per tool call is cut at this length: a longer one may hold a change Casper didn't read. */
const KEPT_COMMAND = 512;

/** The grey line shown instead of the card, or undefined when the card stays. `read`: the request asked something
 * (classification mode "read"), not for a change. `calls`: every tool call of the task. */
export function unseenAnswerLine(task: TaskResult, calls: readonly ToolCallLine[], read: boolean, home?: string): string | undefined {
  if (!read || task.execution !== "completed" || !task.untrustedFolder || task.changedPaths || !task.possibleMutations) return undefined;
  if (Object.entries(task).some(([key, value]) => value !== undefined && !ANSWER_ONLY.has(key))) return undefined;
  if (task.observedEdits?.length || task.observedChecks?.length || task.remoteChanges?.some((remote) => !remote.looked)) return undefined;
  const answered = calls.length < TOOL_CALL_LIMIT && calls.every((call) => {
    if (call.toolName === "edit" || call.toolName === "write" || (call.toolName === "lsp" && call.input?.operation === "rename")) return false;
    // A builder helper changes files in its own copy and lands them here.
    if (call.toolName === "delegate" && !["explorer", "reviewer"].includes(String(call.input?.role))) return false;
    if (call.toolName !== "bash" && call.toolName !== "powershell") return true;
    const command = call.input?.command;
    // Only shell commands that show no change Casper knows: no install, commit, push, deletion or other machine.
    return typeof command === "string" && command.length < KEPT_COMMAND && !shellChanges(command, "", true, home).length;
  });
  return answered ? `– Changes unknown: ${task.snapshotFailure?.reason ?? NOT_A_PROJECT}` : undefined;
}
