// Casper's approval boxes as ACP session/request_permission. The client's person answers; nothing here ever answers
// yes. A refusal, an error, "cancelled", a cancelled prompt, a closed connection or no answer in time is No.

import type { AwayAsker, AwayQuestion } from "../tui/terminal";
import type { Json } from "./rpc";

/** How long a box waits for the client's answer before it is No. A person in an app may be away for a while; a client
 * that never answers must not hold the task for ever. */
export const PERMISSION_WAIT_MS = 30 * 60_000;

/** ACP's option kinds for Casper's choice labels: "No…" rejects, a session-wide or "always" yes is allow_always, any
 * other yes (this once, preview first) is allow_once. */
export function optionKind(label: string): "reject_once" | "allow_once" | "allow_always" {
  if (/^no\b/i.test(label)) return "reject_once";
  if (/session|always|everything/i.test(label)) return "allow_always";
  return "allow_once";
}

export interface PermissionChannel {
  /** Sends session/request_permission and resolves with its result; rejects on an error reply or a closed connection. */
  request(params: Json, signal: AbortSignal): Promise<unknown>;
  /** Sends one session/update: the box is a step of its own, so a client that ties permissions to steps can show it. */
  update(update: Json): void;
}

/**
 * Answers the boxes of one session (the terminal's asker, as a walk-away job's is). Only Casper's numbered boxes go to
 * the client: approvals and picks with a fixed list. A question that needs typed words, or more than one pick, can't be
 * put as a permission request, so it gets no answer (the same as a run that can't ask).
 */
export class AcpAsker implements AwayAsker {
  private boxes = 0;

  /** `hide`: the session's secret hiding, for the box's words as for every update. */
  constructor(private readonly sessionId: string, private readonly channel: PermissionChannel, private readonly hide: (text: string) => string = (text) => text,
    private readonly waitMs = PERMISSION_WAIT_MS) {}

  async ask(question: AwayQuestion, signal?: AbortSignal): Promise<string[] | undefined> {
    if ((question.kind !== "approve" && question.kind !== "pick") || question.typed || question.multi || !question.choices.length) return undefined;
    if (signal?.aborted) return undefined;
    const options = question.choices.map((choice, index) => ({ optionId: String(index + 1), name: this.hide(choice.label), kind: optionKind(choice.label),
      ...(choice.description ? { _meta: { casper: { description: this.hide(choice.description) } } } : {}) }));
    const preview = question.preview?.replace(/\n+$/, "");
    const toolCallId = `casper-approval-${++this.boxes}`;
    const step = { toolCallId, title: this.hide(question.question), kind: "other", status: "pending",
      ...(preview ? { content: [{ type: "content", content: { type: "text", text: this.hide(preview) } }] } : {}) };
    this.channel.update({ sessionUpdate: "tool_call", ...step });
    const params = { sessionId: this.sessionId, toolCall: step, options };
    const stop = new AbortController();
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
    }
    // The step closes with the answer: "completed" for a yes, "failed" for No or nothing.
    const yes = picked !== undefined && picked.kind !== "reject_once";
    this.channel.update({ sessionUpdate: "tool_call_update", toolCallId, status: yes ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: `→ ${picked?.name ?? "No (no answer)"}` } }] });
    return picked ? [question.choices[Number(picked.optionId) - 1]!.label] : undefined;
  }
}
