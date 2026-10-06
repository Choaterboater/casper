/**
 * Side questions: a line the person types that starts with `?` ("? what does ECONNRESET mean"), idle or during a
 * task, goes to one separate model call (the fast model, else the conversation's) with no tools. It gets a short
 * summary of the session (project name, the task's first line, recent tool names: no file contents, no secrets). The
 * answer shows as a side answer and is never added to the conversation, so the working AI never sees it. Its cost shows
 * in /usage. `sideQuestions: false` (/settings) makes such lines ordinary requests.
 */

import path from "node:path";
import type { CasperApp } from "../app";
import { hideCommandSecrets } from "../secrets/files";
import { redactPreview, terminalText } from "../tui/format";
import { ensureRuntime } from "./runtime-start";
import { pastedMask } from "./request-words";

const MAX_TOKENS = 1024;
const RECENT_TOOLS = 8;

/** What side questions cost this session. `unknown`: a provider reported no usage for one, so the totals are a floor. */
export interface SideQuestionUsage { requests: number; tokens: number; estimatedCost: number; unknown: boolean }

/** A side question: the line starts with a `?` the person typed and has a question after it. */
export function sideQuestionText(line: string, pasted: readonly string[] = []): string | undefined {
  // A `?` that came from a paste is not the person's.
  if (!line.startsWith("?") || pastedMask(line, pasted)[0]) return undefined;
  const question = line.slice(1).trim();
  return question || undefined;
}

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

function oneLine(text: string, max: number): string {
  return redactPreview(hideCommandSecrets(text).text).replace(/\s+/g, " ").trim().slice(0, max);
}

/** The short summary the side model gets: names only, never file contents. */
export function sideSummary(app: CasperApp): string {
  const lines = [`Project: ${oneLine(path.basename(app.activeWorkspaceRoot()), 80)}`];
  const task = app.lastTaskRequest?.split("\n").find((line) => line.trim());
  if (task) lines.push(`${app.commandActive ? "Current task" : "Last task"}: ${oneLine(task, 120)}`);
  if (app.recentTools.length) lines.push(`Recent tools: ${app.recentTools.map((tool) => oneLine(tool, 80)).join(", ")}`);
  return lines.join("\n");
}

const SYSTEM_PROMPT = `You answer a quick side question from a person using Casper, a coding assistant, while its AI works on a task.
Answer in a few short sentences or a short list, in plain words. You have no tools and cannot read or change anything.
The task goes on without you: do not try to do it, and do not ask to.
What Casper says about the session (names only):`;

/** Ask, show the answer as a side answer, and count its cost. Never touches the conversation. */
export async function askSideQuestion(app: CasperApp, question: string): Promise<void> {
  const controller = new AbortController();
  const signal = app.commandActive && app.commandAbort ? AbortSignal.any([controller.signal, app.commandAbort.signal]) : controller.signal;
  if (!app.commandActive) app.sideAbort = controller;
  try {
    const session = app.session ?? await ensureRuntime(app);
    if (!session.complete) { app.output.write("  ? Side questions need a runtime that can make a separate model call.\n"); return; }
    const answer = await session.complete({ systemPrompt: `${SYSTEM_PROMPT}\n${sideSummary(app)}`, user: question, role: "fast", effort: "low", maxTokens: MAX_TOKENS, signal });
    const usage = app.sideQuestions;
    usage.requests++;
    if (answer.usage) { usage.tokens += answer.usage.tokens; usage.estimatedCost += answer.usage.estimatedCost; }
    else usage.unknown = true;
    if (app.closing) return;
    app.events.ensureLineBreak();
    const model = answer.model ? ` · ${terminalText(answer.model)}` : "";
    if (answer.error || !answer.text.trim()) {
      app.output.write(`  ? side answer${model} · failed: ${terminalText(answer.error ?? "no answer")}\n`);
      return;
    }
    const body = terminalText(answer.text.trim()).split("\n").map((line) => `  │ ${line}`.trimEnd()).join("\n");
    app.output.write(`  ? side answer${model} · not part of the conversation\n${body}\n`);
  } catch (error) {
    if (app.closing) return;
    app.events.ensureLineBreak();
    app.output.write(signal.aborted ? "  ? side question stopped\n" : `  ? side question failed: ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
  } finally {
    if (app.sideAbort === controller) app.sideAbort = undefined;
  }
}
