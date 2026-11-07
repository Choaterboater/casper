// Casper's approval boxes as ACP session/request_permission. The client's person answers; nothing here ever answers
// yes. A refusal, an error, "cancelled", a cancelled prompt, a closed connection or no answer in time is No.
// A question that takes typed words or several picks goes to a client that shows forms as elicitation/create
// (decision 83); anything but an accepted form is skipped. The plan's Build box carries the plan (decision 84). A box a
// running step raises names that step and repeats its diffs and file (decision 85).

import type { AwayAsker, AwayQuestion } from "../tui/terminal";
import type { Json } from "./rpc";

/** How long a box waits for the client's answer before it is No. A person in an app may be away for a while; a client
 * that never answers must not hold the task for ever. */
export const PERMISSION_WAIT_MS = 30 * 60_000;

/** How a box closed by the app's switch to Read only ends (decision 82). */
export const READ_ONLY_NO = "→ No (access set to Read only)";

/** ACP's option kinds for Casper's choice labels: "No…" rejects, a session-wide or "always" yes is allow_always, any
 * other yes (this once, preview first) is allow_once. */
export function optionKind(label: string): "reject_once" | "allow_once" | "allow_always" {
  if (/^no\b/i.test(label)) return "reject_once";
  if (/session|always|everything/i.test(label)) return "allow_always";
  return "allow_once";
}

/** The running step a box belongs to (UpdateMapper.step): its ACP id, and the diffs and files its start showed, hidden. */
export interface BoxStep {
  id: string;
  diffs: Json[];
  locations?: Json[];
}

export interface PermissionChannel {
  /** Sends session/request_permission and resolves with its result; rejects on an error reply or a closed connection. */
  request(params: Json, signal: AbortSignal): Promise<unknown>;
  /** Sends one session/update: the box is a step of its own, so a client that ties permissions to steps can show it. */
  update(update: Json): void;
  /** Sends elicitation/create (a form) and resolves with its result; rejects on an error reply or a closed connection. */
  elicit?(params: Json, signal: AbortSignal): Promise<unknown>;
  /** The step a question is asked on, when it has one already: the ask tool's own step for the AI's question. */
  stepFor?(question: AwayQuestion): string | undefined;
}

/** The form for a question (elicitation/create's requestedSchema): a pick's choices by number ("1".."n") with their
 * labels as titles, so a label `hide` changed still maps back by its index; a typed line; and "Or type your answer"
 * where the question takes typed words. */
export function questionSchema(question: AwayQuestion, hide: (text: string) => string): { type: "object"; properties: Record<string, any>; required: string[] } {
  if (question.kind === "line") return { type: "object", required: ["answer"], properties: { answer: { type: "string", title: hide(question.hint || "Your answer") } } };
  const choices = question.choices.map((choice, index) => ({ const: String(index + 1), title: hide(choice.label), ...(choice.description ? { description: hide(choice.description) } : {}) }));
  // A multi pick's items have no type key, so they read as the titled kind of choice list.
  const answer = question.multi ? { type: "array", title: "Choose", items: { anyOf: choices } } : { type: "string", title: "Choose", oneOf: choices };
  return { type: "object", required: [], properties: { answer, ...(question.typed ? { other: { type: "string", title: "Or type your answer" } } : {}) } };
}

/** The answer a form gave, as the terminal's box would give it, or undefined (skipped). Only an accepted form counts.
 * A choice is its label by its number (an unknown one is dropped); typed words count only where the question takes
 * them: a single pick prefers them, a multi pick puts them after its picks. A line's spaces are collapsed. */
export function formAnswer(result: unknown, question: AwayQuestion): string[] | undefined {
  const reply = result as { action?: unknown; content?: unknown } | null | undefined;
  if (!reply || reply.action !== "accept" || !reply.content || typeof reply.content !== "object") return undefined;
  const content = reply.content as Record<string, unknown>;
  if (question.kind === "line") {
    const line = typeof content.answer === "string" ? content.answer.replace(/\s+/g, " ").trim() : "";
    return line ? [line] : undefined;
  }
  const other = question.typed && typeof content.other === "string" ? content.other.trim() : "";
  const index = (value: unknown) => typeof value === "string" && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= question.choices.length ? Number(value) - 1 : undefined;
  if (question.multi) {
    const given = Array.isArray(content.answer) ? content.answer : content.answer === undefined ? [] : [content.answer];
    const picked = [...new Set(given.map(index).filter((value): value is number => value !== undefined))].sort((a, b) => a - b);
    const answer = [...picked.map((value) => question.choices[value]!.label), ...(other ? [other] : [])];
    return answer.length ? answer : undefined;
  }
  if (other) return [other];
  const picked = index(content.answer);
  return picked === undefined ? undefined : [question.choices[picked]!.label];
}

/**
 * Answers the boxes of one session (the terminal's asker, as a walk-away job's is). Casper's numbered boxes go to the
 * client as permission requests: approvals and picks with a fixed list. A question that needs typed words, or more than
 * one pick, can't be put that way: it goes as a form to a client that shows them (`questions`), and otherwise gets no
 * answer (the same as a run that can't ask).
 */
export class AcpAsker implements AwayAsker {
  private boxes = 0;
  private forms = 0;
  /** Each box the client has open, by its step id: Read only closes them all as No (decision 82). */
  private readonly open = new Map<string, AbortController>();
  private readonly withdrawn = new Set<string>();
  /** While the app has set Read only, an approval box is No without asking (one queued behind an open box too). */
  readOnly: () => boolean = () => false;
  /** Whether the client shows forms and acp_questions is on: then a typed or multi question goes to it (decision 83). */
  questions: () => boolean = () => false;
  /** The running step that raised the box being asked, if any (decision 85). */
  stepOf: () => BoxStep | undefined = () => undefined;

  /** `hide`: the session's secret hiding, for the box's words as for every update. */
  constructor(private readonly sessionId: string, private readonly channel: PermissionChannel, private readonly hide: (text: string) => string = (text) => text,
    private readonly waitMs = PERMISSION_WAIT_MS) {}

  async ask(question: AwayQuestion, signal?: AbortSignal): Promise<string[] | undefined> {
    if (question.typed || question.multi || question.kind === "line") return this.questions() && this.channel.elicit ? this.elicit(question, signal) : undefined;
    if ((question.kind !== "approve" && question.kind !== "pick") || !question.choices.length) return undefined;
    if (signal?.aborted) return undefined;
    if (question.kind === "approve" && this.readOnly()) {
      const toolCallId = `casper-approval-${++this.boxes}`;
      this.channel.update({ sessionUpdate: "tool_call", toolCallId, title: this.hide(question.question), kind: "other", status: "failed",
        content: [{ type: "content", content: { type: "text", text: READ_ONLY_NO } }] });
      return undefined;
    }
    // A pick's first choice is its safe one (nothing is done), whatever its label says; the rest are a yes this once. The
    // Build box says it: only Build builds, and Change the plan is a no to building as Stop is.
    const review = question.review;
    const kindOf = (label: string, index: number) => review ? label === review.approve ? "allow_once" as const : "reject_once" as const
      : question.kind === "pick" ? index === 0 ? "reject_once" as const : "allow_once" as const : optionKind(label);
    const options = question.choices.map((choice, index) => ({ optionId: String(index + 1), name: this.hide(choice.label), kind: kindOf(choice.label, index),
      ...(choice.description ? { _meta: { casper: { description: this.hide(choice.description) } } } : {}) }));
    // The box's text: the plan's Markdown for the Build box, else what the box shows above its question.
    const preview = review ? review.markdown : question.preview?.replace(/\n+$/, "");
    // The step that raised the box: its diffs follow the box's text, and its files are the box's (decision 85).
    const from = this.stepOf();
    const content = [...(preview ? [{ type: "content", content: { type: "text", text: this.hide(preview) } }] : []), ...(from?.diffs ?? [])];
    // What the app may read about the box, merged: the plan's labels, so an app can show its own plan review, and the step.
    const casper = { ...(review ? { plan: { approve: this.hide(review.approve), change: this.hide(review.change) } } : {}), ...(from ? { step: from.id } : {}) };
    const toolCallId = `casper-approval-${++this.boxes}`;
    const step = { toolCallId, title: this.hide(question.question), kind: "other", status: "pending",
      ...(content.length ? { content } : {}), ...(from?.locations?.length ? { locations: from.locations } : {}),
      ...(Object.keys(casper).length ? { _meta: { casper } } : {}) };
    this.channel.update({ sessionUpdate: "tool_call", ...step });
    const params = { sessionId: this.sessionId, toolCall: step, options };
    const stop = new AbortController();
    this.open.set(toolCallId, stop);
    const timer = setTimeout(() => stop.abort(), this.waitMs);
    const onAbort = () => stop.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let picked: (typeof options)[number] | undefined;
    try {
      const result = await this.channel.request(params, stop.signal) as { outcome?: { outcome?: string; optionId?: unknown } } | null;
      picked = result?.outcome?.outcome === "selected" ? options.find((option) => option.optionId === result.outcome!.optionId) : undefined;
    } catch { /* an error reply, a closed connection, a cancel or no answer in time: No */ } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.open.delete(toolCallId);
    }
    // Closed by a switch to Read only: No, whatever came back meanwhile.
    const withdrawn = this.withdrawn.delete(toolCallId);
    if (withdrawn) picked = undefined;
    // The step closes with the answer: "completed" for a yes, "failed" for No or nothing.
    const yes = picked !== undefined && picked.kind !== "reject_once";
    this.channel.update({ sessionUpdate: "tool_call_update", toolCallId, status: yes ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: withdrawn ? READ_ONLY_NO : `→ ${picked?.name ?? "No (no answer)"}` } }] });
    return picked ? [question.choices[Number(picked.optionId) - 1]!.label] : undefined;
  }

  /** One question as a form. The AI's is asked on the ask tool's own step, which closes with the tool's result; any
   * other is a step of its own that closes with the answer or "— skipped". It is not an open box: Read only leaves it. */
  private async elicit(question: AwayQuestion, signal?: AbortSignal): Promise<string[] | undefined> {
    if (signal?.aborted) return undefined;
    const given = this.channel.stepFor?.(question);
    const toolCallId = given ?? `casper-question-${++this.forms}`;
    const typed = question.typed === true;
    const multi = question.multi === true;
    if (!given) {
      this.channel.update({ sessionUpdate: "tool_call", toolCallId, title: this.hide(`${question.from === "ai" ? "The AI asks: " : ""}${question.question}`), kind: "other", status: "pending",
        _meta: { casper: { question: { question: this.hide(question.question),
          options: question.choices.map((choice) => ({ label: this.hide(choice.label), ...(choice.description ? { description: this.hide(choice.description) } : {}) })), multi, typed } } } });
    }
    const params = { sessionId: this.sessionId, toolCallId, mode: "form", message: this.hide(question.question), requestedSchema: questionSchema(question, this.hide),
      _meta: { casper: { question: { from: question.from ?? "casper", multi, typed } } } };
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), this.waitMs);
    const onAbort = () => stop.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let answer: string[] | undefined;
    try { answer = formAnswer(await this.channel.elicit!(params, stop.signal), question); }
    catch { /* an error reply, a closed connection, a cancel or no answer in time: skipped */ } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    if (!given) {
      this.channel.update({ sessionUpdate: "tool_call_update", toolCallId, status: answer ? "completed" : "failed",
        content: [{ type: "content", content: { type: "text", text: answer ? this.hide(`→ ${answer.join(" | ")}`) : "— skipped" } }] });
    }
    return answer;
  }

  /** The app set Read only: every open box closes as No (its request is cancelled), and the step says why. */
  withdrawAll(): void {
    for (const [toolCallId, stop] of this.open) {
      this.withdrawn.add(toolCallId);
      stop.abort();
    }
  }
}
