/**
 * Side questions: a line the person types that starts with `?` ("? what does ECONNRESET mean"), idle or during a
 * task, goes to one separate model call (the fast model, else the conversation's) with no tools. It gets a short
 * summary of the session (project name, the task's first line, recent tool names: no file contents, no secrets). It
 * asks with thinking off, since side questions are quick (a model that can't stop thinking gets its lowest effort),
 * unless the fast role's own effort sets it; a request that
 * still thinks gets thinking room on top of the answer's 1,024 tokens. An empty answer says why. The
 * answer shows as a side answer and is never added to the conversation, so the working AI never sees it. Its cost shows
 * in /usage. `sideQuestions: false` (/settings) makes such lines ordinary requests. `/btw <question>` asks the same
 * way, idle or during a task, and stays on with `sideQuestions: false` (it can't be meant as a request).
 */

import path from "node:path";
import type { CasperApp } from "../app";
import { hideCommandSecrets } from "../secrets/files";
import { redactPreview, terminalText } from "../tui/format";
import type { RuntimeEvent } from "../runtime/types";
import { requestOf } from "../sessions/resume";
import { ensureRuntime } from "./runtime-start";
import { pastedMask } from "./request-words";

const MAX_TOKENS = 1024;
/** Room a request that thinks gets on top of the answer's tokens (a fast role set to think, or a model that can't stop). */
export const THINKING_ROOM = 4096;
const RECENT_TOOLS = 8;
/** The side model's view of the session stays small: the last few messages and tool lines, each trimmed, within these. */
const RECENT_TURNS = 6;
const TURNS_CHARS = 2_400;
const TOOL_LINE_CHARS = 240;
const SUMMARY_CHARS = 4_800;
/** Secrets are hidden in a window wider than what is kept, so a cut never splits one into a part that no longer looks like one. */
const REDACT_WINDOW = 3_000;
/** Tools whose output is a file's text: their line names the file, never its contents. */
const FILE_BODY_TOOLS = new Set(["read", "write", "edit"]);

/** What side questions cost this session. `unknown`: a provider reported no usage for one, so the totals are a floor. */
export interface SideQuestionUsage { requests: number; tokens: number; estimatedCost: number; unknown: boolean }

/** A side question: the line starts with a `?` the person typed and has a question after it. */
export function sideQuestionText(line: string, pasted: readonly string[] = []): string | undefined {
  // A `?` that came from a paste is not the person's.
  if (!line.startsWith("?") || pastedMask(line, pasted)[0]) return undefined;
  const question = line.slice(1).trim();
  return question || undefined;
}

/** `/btw <question>`: the question ("" when none follows); undefined for any other line. It is a side question even
 * with `sideQuestions: false`, which only stops a leading `?` from being one: /btw is typed on purpose. */
export function btwQuestion(line: string): string | undefined {
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(line.trim());
  return match ? (match[1] ?? "").trim() : undefined;
}

export const BTW_USAGE = "Type /btw and your question, for example /btw what does ECONNRESET mean. The answer is not part of the conversation.";

/** Side questions are on unless the person turned them off. */
export function sideQuestionsOn(app: CasperApp): boolean {
  return app.projectContext?.sideQuestions !== false;
}

/** The tool names the AI used lately, newest last, without repeats. */
export function rememberTool(app: CasperApp, name: string): void {
  const recent = app.recentTools.filter((tool) => tool !== name);
  recent.push(name.slice(0, 80));
  app.recentTools = recent.slice(-RECENT_TOOLS);
}

function hidden(text: string): string {
  return redactPreview(hideCommandSecrets(text).text).replace(/\s+/g, " ").trim();
}

/** The start of `text`, secrets hidden; a word the window cut is left out, so no part of a secret is kept. */
function start(text: string): string {
  return text.length > REDACT_WINDOW ? hidden(text.slice(0, REDACT_WINDOW)).replace(/\s*\S*$/, "") : hidden(text);
}

/** The end of `text`, likewise. */
function end(text: string): string {
  return text.length > REDACT_WINDOW ? hidden(text.slice(-REDACT_WINDOW)).replace(/^\S*\s*/, "") : hidden(text);
}

function oneLine(text: string, max: number): string {
  return start(text).slice(0, max);
}

/** `text` on one line, secrets hidden, at most `max` characters: its start and, when longer, its end (`headShare` of
 * it from the start), with "…" between. */
function clip(text: string, max: number, headShare = 0.5): string {
  const head = start(text);
  const tail = end(text);
  if (text.length <= REDACT_WINDOW && head.length <= max) return head;
  const first = Math.floor((max - 3) * headShare);
  return `${head.slice(0, first).trimEnd()} … ${tail.slice(-(max - 3 - first)).trimStart()}`;
}

/** One short line for a tool the AI just ran: its name, what it ran on, and the first lines it printed. */
export function rememberToolResult(app: CasperApp, event: Extract<RuntimeEvent, { type: "tool_end" }>): void {
  const input = event.input;
  const what = input?.command ?? input?.path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.check ?? input?.goal;
  const printed = FILE_BODY_TOOLS.has(event.toolName) ? "" : start((event.output?.text ?? "").split("\n").filter((line) => line.trim()).slice(0, 3).join(" | "));
  const line = `${oneLine(event.toolName, 40)}${what ? `: ${clip(what, 120)}` : ""}${event.isError ? " (failed)" : ""}${printed ? ` → ${printed}` : ""}`;
  app.recentToolResults = [...app.recentToolResults, line.slice(0, TOOL_LINE_CHARS)].slice(-RECENT_TOOLS);
}

/** The last few messages, oldest first, each trimmed, newest kept first when they don't all fit. */
function recentConversation(turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }>): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    // A reply's end usually says what came of it, so more of the end is kept.
    const line = turn.role === "user" ? `you: ${clip(requestOf(turn.text), 300)}` : `AI: ${clip(turn.text, 700, 0.3)}`;
    if (used + line.length > TURNS_CHARS) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines;
}

/** The short summary the side model gets: names, the last few messages, and what the last few tools ran and printed,
 * trimmed, with secrets hidden, never more than SUMMARY_CHARS. */
export function sideSummary(app: CasperApp, turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }> = []): string {
  const lines = [`Project: ${oneLine(path.basename(app.activeWorkspaceRoot()), 80)}`];
  const task = app.lastTaskRequest?.split("\n").find((line) => line.trim());
  if (task) lines.push(`${app.commandActive ? "Current task" : "Last task"}: ${oneLine(task, 120)}`);
  if (app.recentTools.length) lines.push(`Recent tools: ${app.recentTools.map((tool) => oneLine(tool, 80)).join(", ")}`);
  const conversation = recentConversation(turns);
  if (conversation.length) lines.push("Recent messages (oldest first, trimmed):", ...conversation);
  if (app.recentToolResults.length) lines.push("What recent tools ran and printed (newest last, first lines only):", ...app.recentToolResults.map((line) => `- ${line}`));
  return lines.join("\n").slice(0, SUMMARY_CHARS);
}

const SYSTEM_PROMPT = `You answer a quick side question from a person using Casper, a coding assistant, while its AI works on a task.
Answer in a few short sentences or a short list, in plain words. You have no tools and cannot read or change anything.
The task goes on without you: do not try to do it, and do not ask to.
Answer from what Casper says about the session below; when it doesn't say, say so:`;

/** Why a side answer came back with no text, in plain words, with what to try. */
export function emptyReason(answer: { stopReason?: string; maxTokens?: number }): string {
  if (answer.stopReason === "length") {
    const limit = answer.maxTokens ? `${answer.maxTokens.toLocaleString("en-US")}-token ` : "";
    return `the model used its whole ${limit}limit thinking and wrote no answer. Try /btw again, or set a fast model with /model role fast`;
  }
  return "the model sent back no text. Try /btw again, or set a fast model with /model role fast";
}

function recentTurns(session: { recentTurns?(count: number): Array<{ role: "user" | "assistant"; text: string }> }) {
  try { return session.recentTurns?.(RECENT_TURNS) ?? []; } catch { return []; }
}

/** Ask, show the answer as a side answer, and count its cost. Never touches the conversation. */
export async function askSideQuestion(app: CasperApp, question: string): Promise<void> {
  const controller = new AbortController();
  const signal = app.commandActive && app.commandAbort ? AbortSignal.any([controller.signal, app.commandAbort.signal]) : controller.signal;
  if (!app.commandActive) app.sideAbort = controller;
  try {
    const session = app.session ?? await ensureRuntime(app);
    if (!session.complete) { app.output.write("  ? Side questions need a runtime that can make a separate model call.\n"); return; }
    const answer = await session.complete({ systemPrompt: `${SYSTEM_PROMPT}\n${sideSummary(app, recentTurns(session))}`, user: question, role: "fast",
      // Quick by design: no thinking, unless the fast role's own effort (/model role fast <model>:low) asks for it.
      defaultEffort: "off", maxTokens: MAX_TOKENS, thinkingRoom: THINKING_ROOM, signal });
    const usage = app.sideQuestions;
    usage.requests++;
    if (answer.usage) { usage.tokens += answer.usage.tokens; usage.estimatedCost += answer.usage.estimatedCost; }
    else usage.unknown = true;
    if (app.closing) return;
    app.events.ensureLineBreak();
    const model = answer.model ? ` · ${terminalText(answer.model)}` : "";
    if (answer.error || !answer.text.trim()) {
      app.output.write(`  ? side answer${model} · failed: ${terminalText(answer.error ?? emptyReason(answer))}\n`);
      return;
    }
    const body = terminalText(answer.text.trim()).split("\n").map((line) => `    ${line}`.trimEnd()).join("\n");
    app.output.write(`  ? side answer${model} · not part of the conversation\n${body}\n`);
  } catch (error) {
    if (app.closing) return;
    app.events.ensureLineBreak();
    app.output.write(signal.aborted ? "  ? side question stopped\n" : `  ? side question failed: ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
  } finally {
    if (app.sideAbort === controller) app.sideAbort = undefined;
  }
}
