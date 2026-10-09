/** The approval boxes: MCP change boxes, risky-kind boxes, server questions, numbered answers and the AI's ask tool.
 * Only a person answers them, one box at a time (moved from src/app.ts; the app owns the state). */

import type { CasperApp } from "../app";
import { askTool } from "../tui/ask";
import { terminalText } from "../tui/format";
import { NotExecutedError } from "../capabilities/result";
import type { ServerQuestionHandler } from "../mcp/manager";
import { changeScopeText } from "../mcp/access";
import { formatApproval, kindBox, maskText, planLabel, TOO_LONG_TEXT, tooLongToShow } from "../capabilities/approval";
import { KIND_TEXT } from "../capabilities/kinds";
import type { ConfirmCapability, ConfirmKind } from "../capabilities/broker";
import type { RuntimeTool } from "../runtime/types";
import { NO, YES_ONCE, YES_SESSION } from "./safe-choices";
import { PRODUCT_LABELS } from "../mcp/network/logins";
import { typedDuringTask } from "../tui/give-way";

/** Boxes one at a time. A command typed during a task waits for the boxes already queued, then asks outside the queue,
 * so the task's next approval or question is never stuck behind it: that box closes the command's (src/tui/surface.ts). */
export function oneAtATime<T>(app: CasperApp, work: () => Promise<T>): Promise<T> {
  if (typedDuringTask()) return queueIdle(app).then(work);
  const next = app.approvalQueue.then(work, work);
  app.approvalQueue = next.catch(() => {});
  return next;
}

async function queueIdle(app: CasperApp): Promise<void> {
  for (let queue = app.approvalQueue; ; queue = app.approvalQueue) { await queue; if (queue === app.approvalQueue) return; }
}

/** One numbered answer from the user (never the model), in the same one-at-a-time queue as approvals. */
export function chooseAnswer(app: CasperApp, preview: string, question: string, choices: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  return oneAtATime(app, () => chooseNumbered(app, preview, question, choices, signal));
}

/** A numbered question ("text\n  1 A\n  2 B\n", as the network setup and login ask it) in the same numbered box as
 * every approval: one key picks, Esc is No. The answer is the number picked, or undefined when nobody answered. */
export async function chooseNumbered(app: CasperApp, preview: string, _question: string, choices: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  const lines = preview.replace(/\n+$/, "").split("\n");
  const labels: string[] = [];
  while (lines.length && /^ {2}\d+ /.test(lines.at(-1)!)) labels.unshift(lines.pop()!.replace(/^ {2}\d+ /, ""));
  const offered = labels.length === choices.length ? labels : [...choices];
  const question = lines.pop() ?? "";
  const picked = await approveBox(app, lines.length ? `${lines.join("\n")}\n` : "", question, offered, signal);
  const index = picked === undefined ? -1 : offered.indexOf(picked);
  return index < 0 ? undefined : choices[index];
}

/** One approval box from the user (never the model), in the same one-at-a-time queue as approvals: the chosen
 * label, or undefined when nobody answered. */
export function approveChoice(app: CasperApp, preview: string, question: string, options: ReadonlyArray<string | { label: string; description?: string }>, signal?: AbortSignal): Promise<string | undefined> {
  return oneAtATime(app, () => approveBox(app, preview, question, options, signal));
}

/** The outcome line after a box, written only where the box left no record of its own. A box that was shown leaves one
 * line on both terminals ("Make this change? → No", "… — skipped (No)"), so this is for a box that could not show. */
function recordOutcome(app: CasperApp, line: string, recorded: boolean): void {
  if (app.closing || recorded) return;
  app.output.write(line);
}

export function approvalStopped(app: CasperApp, signal?: AbortSignal): boolean {
  return app.closing || Boolean(signal?.aborted) || Boolean(app.commandAbort?.signal.aborted);
}

/**
 * The approval box for one MCP call: the real tool, EXECUTE or preview, secrets hidden, an AI-set
 * confirm flagged, and the last preview. Only the user's typed answer counts; the model's ask tool
 * never reaches this prompt. Nobody asked (one-shot, too long, closing) is never "you said no".
 */
export async function confirmCapability(app: CasperApp, ...[call, signal]: Parameters<ConfirmCapability>): ReturnType<ConfirmCapability> {
  const header = `MCP · ${call.plan.server} · ${call.plan.tool}  [${planLabel(call.plan)}]`;
  if (tooLongToShow(call.arguments)) {
    if (app.interactive && !app.closing) app.output.write(`${terminalText(header)}\n${TOO_LONG_TEXT}\n`);
    throw new NotExecutedError("arguments too long to show you for approval");
  }
  if (!app.interactive) throw new NotExecutedError("needs your approval, and this run cannot ask");
  return oneAtATime(app, async () => {
    if (approvalStopped(app, signal)) throw new NotExecutedError("cancelled");
    // A routed tool's own product (Mist, Central, ClearPass): the box names it, and the reach is that login's.
    const access = app.mcp?.policy(call.plan.server).access;
    // A tool of no known product on a server with more than one: whose reach applies isn't known, so no line.
    const products = new Set(access?.products.map((item) => item.product));
    const scope = !access ? undefined : call.product ? changeScopeText({ ...access, products: access.products.filter((item) => item.product === call.product) })
      : products.size > 1 ? undefined : changeScopeText(access);
    const box = formatApproval(call.plan, call.lastPreview, {
      product: app.mcp?.productLabel(call.plan.server), ...(call.product ? { toolProduct: PRODUCT_LABELS[call.product] } : {}),
      ...(scope ? { scope } : {}), ...(call.tool ? { tool: call.tool } : {}),
      ...(call.showOnly ? { showOnly: true } : {}),
    });
    // The same channel as /mcp writes: only a key pressed after the box appeared answers it.
    const first = await recordedBox(app, box.preview, box.question, box.labels, signal);
    const picked = first.answer;
    if (picked === undefined && approvalStopped(app, signal)) throw new NotExecutedError("cancelled");
    const index = picked === undefined ? -1 : box.labels.indexOf(picked);
    let result = index < 0 ? "no" : box.answers[String(index + 1)] ?? "no";
    let recorded = first.recorded;
    // "Yes to everything" asks once more, so a key pressed from habit (3 or 4 in another box) never grants it.
    if (result === "allow-all") {
      const product = app.mcp?.productLabel(call.plan.server) ?? call.plan.server;
      const sure = await recordedBox(app, `No box will ask about any change on ${terminalText(product)} until Ctrl+O or the session ends.\n`,
        `Yes to everything on ${terminalText(product)}?`, ["No", "Yes to everything"], signal);
      if (sure.answer === undefined && approvalStopped(app, signal)) throw new NotExecutedError("cancelled");
      if (sure.answer !== "Yes to everything") result = "no";
      recorded = sure.recorded;
    }
    // A call you allowed that can change things: undo can't reach it, and /undo says so.
    if ((result === "yes" || result === "yes-session" || result === "allow-all") && planLabel(call.plan) !== "read") app.taskChangeServers.add(call.plan.server);
    const said = { yes: "allowed", "yes-session": "allowed for this session", "allow-all": "allowed (allow all)", preview: "preview first", no: "denied",
      "show-session": `allowed show commands on ${terminalText(call.plan.server)} for this session` }[result];
    recordOutcome(app, `[approval] ${said}\n`, recorded);
    return result;
  });
}

/** A risky change kind (firmware, delete, admin) the user hasn't allowed on this server: 2 allows it for this session,
 * then the change box asks about the call itself. Same box and queue as the change box. */
export async function confirmKind(app: CasperApp, ...[ask, signal]: Parameters<ConfirmKind>): ReturnType<ConfirmKind> {
  if (!app.interactive) throw new NotExecutedError("needs your approval, and this run cannot ask");
  return oneAtATime(app, async () => {
    if (approvalStopped(app, signal)) throw new NotExecutedError("cancelled");
    const box = kindBox(ask.kind, app.mcp?.productLabel(ask.server) ?? ask.server, ask.realTool);
    const { answer: picked, recorded } = await recordedBox(app, box.preview, box.question, box.labels, signal);
    if (picked === undefined && approvalStopped(app, signal)) throw new NotExecutedError("cancelled");
    const answer = picked === YES_SESSION ? true : picked === YES_ONCE ? "once" as const : false;
    const kind = KIND_TEXT[ask.kind].toLowerCase();
    recordOutcome(app, `[approval] ${answer === true ? `allowed ${kind} on ${terminalText(ask.server)} for this session`
      : answer ? `allowed ${kind} on ${terminalText(ask.server)} for this change` : "denied"}\n`, recorded);
    return answer;
  });
}

/**
 * A server asked about the call the user approved (MCP elicitation). Only the user answers, in the
 * same kind of box; one-shot runs and a closing Casper decline without asking.
 */
export async function answerServerQuestion(app: CasperApp, ...[question, signal]: Parameters<ServerQuestionHandler>): ReturnType<ServerQuestionHandler> {
  if (!app.interactive || app.closing) return { action: "decline" };
  return oneAtATime(app, async () => {
    if (approvalStopped(app, signal)) return { action: "cancel" as const };
    const shown = (text: string) => maskText(text).replace(/[\r\n\v\f\u0085\u2028\u2029]+/g, " ");
    const options = question.options?.map(shown) ?? [];
    // A choice Casper would have to hide or change can't be offered as typed.
    if (question.kind === "choice" && options.some((option, index) => option !== question.options![index])) {
      if (!app.closing) app.output.write(`[mcp] ${terminalText(question.server)} asked a question Casper can only answer yes/no; declined.\n`);
      return { action: "decline" as const };
    }
    // Secrets are hidden before the message is cut, so a cut never shows part of one.
    const message = shown(question.message);
    const cut = message.length > 4000 ? `${message.slice(0, 4000)} … (more not shown)` : message;
    // Numbered like every box: 1 is always No; a yes/no question is 1 No · 2 Yes, a pick-one lists its options after No.
    const labels = question.kind === "boolean" ? ["No", "Yes"] : ["No", ...options];
    const preview = `${shown(question.server)} asks about the ${shown(question.realTool)} call you approved:\n`;
    const { answer: chosen, recorded } = await recordedBox(app, preview, cut, labels, signal);
    if (chosen === undefined) {
      recordOutcome(app, "[server question] no\n", recorded);
      return { action: "cancel" as const };
    }
    const picked = labels.indexOf(chosen);
    if (picked < 1) {
      recordOutcome(app, "[server question] no\n", recorded);
      return { action: "decline" as const };
    }
    const answer = question.kind === "boolean" ? "yes" : options[picked - 1]!;
    recordOutcome(app, `[server question] ${answer}\n`, recorded);
    return { action: "accept" as const, value: question.kind === "boolean" ? true : answer };
  });
}

/** beforeChanges gate: deny native edit/write until one ask attempt is recorded. */
export function editGateReason(app: CasperApp, toolName: string): string | undefined {
  if (!app.editGateActive || app.asksThisTask > 0) return undefined;
  return `askQuestions is set to beforeChanges and this request looks under-specified: call the ask tool once (concrete options plus Other) before using ${toolName}. If the human skips the question, state your assumptions in the reply and continue.`;
}

/** Structured clarification channel: rich surface required, command abort raced, receipt recorded. */
export function askToolFor(app: CasperApp): RuntimeTool {
  return askTool({
    available: () => app.interactive && app.terminal.rich && !app.closing,
    // One at a time with every other box, so a second question waits instead of being answered No.
    ask: (question, options, multi, signal) => oneAtATime(app, async () => {
      const signals = [signal, app.commandAbort?.signal].filter((value): value is AbortSignal => Boolean(value));
      // Commit any open tool line first, so the recorded question starts on its own line.
      app.output.write("");
      // "ai": the question is labelled "The AI asks:", so it never looks like Casper's own approval.
      return app.terminal.ask(question, options, multi, signals.length ? AbortSignal.any(signals) : undefined, "ai");
    }),
    // The closed box leaves one line, "<question> → <answer>" or "— skipped": no second line.
    record: () => { app.asksThisTask++; },
  });
}

/** A yes/no approval box: 1 No · 2 Yes, this once. Nobody to ask is a No. */
export async function confirmYes(app: CasperApp, preview: string, question: string, signal?: AbortSignal): Promise<boolean> {
  return await recordedApproval(app, preview, question, [{ label: NO }, { label: YES_ONCE }], signal) === YES_ONCE;
}

/** An approval box whose outcome the transcript records: allowed (any yes) or denied. */
export async function recordedApproval(app: CasperApp, preview: string, question: string, options: Array<{ label: string; description?: string }>, signal?: AbortSignal): Promise<string | undefined> {
  const { answer, recorded } = await oneAtATime(app, () => recordedBox(app, preview, question, options, signal));
  // The answer itself is never echoed (it is a fresh keystroke, not a draft); record the outcome where the box doesn't.
  if (app.interactive) recordOutcome(app, `[approval] ${answer === YES_SESSION ? "allowed for this session" : answer?.startsWith("Yes") ? "allowed" : "denied"}\n`, recorded);
  return answer;
}

/** One approval box from the user (undefined when nobody could answer). The box leaves its own one-line record. */
export async function approveBox(app: CasperApp, preview: string, question: string, options: ReadonlyArray<string | { label: string; description?: string }>, signal?: AbortSignal): Promise<string | undefined> {
  return (await recordedBox(app, preview, question, options, signal)).answer;
}

/** approveBox, and whether the box left its record ("Make this change? → No"): when it did, no outcome line follows. */
async function recordedBox(app: CasperApp, preview: string, question: string, options: ReadonlyArray<string | { label: string; description?: string }>, signal?: AbortSignal): Promise<{ answer?: string; recorded: boolean }> {
  if (!app.interactive || approvalStopped(app, signal)) return { recorded: false };
  const signals = [signal, app.commandAbort?.signal].filter((value): value is AbortSignal => Boolean(value));
  app.output.write("");
  const before = app.terminal.records;
  const answer = await app.terminal.approve(preview, question, options, signals.length ? AbortSignal.any(signals) : undefined);
  return { ...(answer !== undefined ? { answer } : {}), recorded: typeof before === "number" && app.terminal.records > before };
}

/**
 * A device-check box, an approval box like the MCP change box: keys typed before it appeared (mid-sentence) never
 * answer it, and boxes come one at a time. The chosen label, or undefined (no answer, cancelled, a terminal that
 * can't show the box).
 */
export function exactPick(app: CasperApp, question: string, options: { label: string; description?: string }[], signal?: AbortSignal): Promise<string | undefined> {
  return approveChoice(app, "", question, options, signal);
}
