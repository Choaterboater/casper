// Casper's events (the ones behind `casper --json`, src/app/json-events.ts) as ACP session/update notifications.
// Everything that leaves goes through `hide` first: the --json redaction plus the exact values of the user's own secrets.

import type { CasperEvent, PhaseEvent, ReceiptEvent } from "../app/json-events";
import type { RuntimeEvent } from "../runtime/types";
import { fileTextHoldsSecret } from "../secrets/tool-output";
import type { TaskResult } from "../task/result";
import { redactPreview } from "../tui/format";
import type { Json } from "./rpc";
import { endUpdate, startUpdate, stepFacts, type ShowRules, type StepFacts } from "./tool-content";

const HIDDEN = "<secret hidden>";

/** The --json redaction, then each of `values` (the user's own secrets, longest first) replaced wherever it appears. */
export function hider(values: () => readonly string[]): (text: string) => string {
  return (text) => {
    let shown = redactPreview(text);
    for (const value of values()) if (value.length >= 6 && shown.includes(value)) shown = shown.split(value).join(HIDDEN);
    return shown;
  };
}

/** Only each of `values` replaced, the rest left as it is: Casper's transcript on stderr, where the client's own MCP
 * values (a bearer token) never show. */
export function valuesHider(values: () => readonly string[]): (text: string) => string {
  return (text) => {
    let shown = text;
    for (const value of values()) if (value.length >= 6 && shown.includes(value)) shown = shown.split(value).join(HIDDEN);
    return shown;
  };
}

/** Every string inside `value`, hidden the same way (a receipt's data); `keys` hides the names too (the model's own
 * arguments, whose names it chose). */
export function hideDeep<T>(value: T, hide: (text: string) => string, options: { keys?: boolean } = {}): T {
  if (typeof value === "string") return hide(value) as T;
  if (Array.isArray(value)) return value.map((item) => hideDeep(item, hide, options)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [options.keys ? hide(key) : key, hideDeep(item, hide, options)])) as T;
  return value;
}

/** Casper's stages in plain words, as the client's plan shows them. */
const PHASE_WORDS: Record<PhaseEvent["phase"], string> = {
  task: "Do the task",
  checklist: "List the cases the request states",
  checks: "Run the project's checks",
  smoke: "Try the app",
  pages: "Open the changed pages",
  review: "Review the work against the request",
  proof: "Prove the change",
  acceptance: "Run tests written from the request",
  repair: "Fix what the checks found",
};

const text = (words: string) => ({ type: "text", text: words });

export interface MapperOptions {
  /** The folder a relative path in a step is in. Default: the process's. */
  cwd?: () => string;
  /** The MCP server and tool a runtime tool reaches (CapabilityBroker.named). */
  mcpTool?: (name: string, args: Record<string, unknown>) => { server: string; tool: string } | undefined;
  /** Whether a file's text holds a secret; default fileTextHoldsSecret with Casper's own login files. */
  holdsSecret?: ShowRules["holdsSecret"];
  /** A file whose text only netconan can check (onlyNetconanChecks); default none. */
  unchecked?: ShowRules["unchecked"];
}

/**
 * Stateful, one per session. The model's text goes out a line at a time, so a secret is hidden whole, never split
 * across two chunks; the rest goes out when the message ends, before a tool starts, or at flush(). Tool steps come
 * from the runtime's own events (runtime()), with their arguments, output and diffs (src/acp/tool-content.ts).
 */
export class UpdateMapper {
  private pending = "";
  private readonly plan: Array<{ phase: PhaseEvent["phase"]; status: "in_progress" | "completed" }> = [];
  private steps = 0;
  /** The ACP id of each running tool, by the model's id: a model may use the same id again in a later turn. */
  private readonly running = new Map<string, { id: string; facts: StepFacts }>();
  private readonly cwd: () => string;
  private readonly rules: ShowRules;

  constructor(private readonly hide: (text: string) => string, private readonly options: MapperOptions = {}) {
    this.cwd = options.cwd ?? (() => process.cwd());
    this.rules = { holdsSecret: options.holdsSecret ?? ((file, text) => fileTextHoldsSecret(file, text)), ...(options.unchecked ? { unchecked: options.unchecked } : {}) };
  }

  /** The ACP toolCallId of the running tool the model calls `id`, if it is running. */
  acpId(id: string): string | undefined {
    return this.running.get(id)?.id;
  }

  /** A runtime event as updates: a tool step's start and end (every other event comes through map()). */
  runtime(event: RuntimeEvent): Json[] {
    if (event.type === "tool_start") {
      const id = `casper-tool-${++this.steps}`;
      let mcp: { server: string; tool: string } | undefined;
      try { mcp = this.options.mcpTool?.(event.toolName, event.args ?? {}); } catch { mcp = undefined; }
      const facts = stepFacts(event, this.cwd(), mcp);
      if (event.toolCallId) this.running.set(event.toolCallId, { id, facts });
      return [...this.flush(), hideDeep(startUpdate(id, facts, this.rules), this.hide, { keys: true })];
    }
    if (event.type === "tool_end") {
      const step = event.toolCallId ? this.running.get(event.toolCallId) : undefined;
      if (!step) return [];
      this.running.delete(event.toolCallId!);
      return [hideDeep(endUpdate(step.id, step.facts, event, this.rules), this.hide, { keys: true })];
    }
    return [];
  }

  map(event: CasperEvent): Json[] {
    switch (event.type) {
      case "assistant_delta": {
        this.pending += event.text;
        const end = this.pending.lastIndexOf("\n");
        if (end < 0) return [];
        const ready = this.pending.slice(0, end + 1);
        this.pending = this.pending.slice(end + 1);
        return [this.message(ready)];
      }
      case "assistant_message": return this.flush();
      case "check": {
        const notRun = event.status === "skip";
        const title = `Check ${event.name}${event.command ? `: ${event.command}` : ""}${notRun ? " (not run)" : ""}`;
        return [...this.flush(), { sessionUpdate: "tool_call", toolCallId: `casper-check-${++this.steps}`, title: this.hide(title), kind: "execute",
          status: event.status === "fail" ? "failed" : "completed",
          rawOutput: { status: event.status, exit: event.exit, ms: event.ms, ...(event.ended ? { ended: event.ended } : {}), ...(event.label ? { label: this.hide(event.label) } : {}) } }];
      }
      case "phase": {
        let entry = this.plan.find((item) => item.phase === event.phase);
        if (!entry) this.plan.push(entry = { phase: event.phase, status: "in_progress" });
        entry.status = event.state === "start" ? "in_progress" : "completed";
        return [{ sessionUpdate: "plan", entries: this.plan.map((item) => ({ content: PHASE_WORDS[item.phase], priority: "medium", status: item.status })) }];
      }
      case "error": return [...this.flush(), this.message(`[error] ${event.message}\n`)];
      default: return [];
    }
  }

  /** A line for the person (an `[image] ` note: a picture that was not sent), after the model's text so far, so it
   * reads where it happened. */
  note(line: string): Json[] {
    return [...this.flush(), this.message(line.endsWith("\n") ? line : `${line}\n`)];
  }

  /** The model's text not sent yet. */
  flush(): Json[] {
    const rest = this.pending;
    this.pending = "";
    return rest ? [this.message(rest)] : [];
  }

  private message(words: string): Json {
    return { sessionUpdate: "agent_message_chunk", content: text(this.hide(words)) };
  }
}

/** The receipt's facts as data: what `_meta.casper.receipt` carries on the last message and on the prompt's reply. */
export interface AcpReceipt {
  outcome: ReceiptEvent["outcome"];
  verdict: string;
  exitCode: number;
  /** Files the request changed; null when Casper could not compare the workspace. */
  changed: string[] | null;
  checksRun: Array<{ name: string; status: "pass" | "fail"; command: string | null; exit: number | null; ms: number; fresh: boolean }>;
  checksNotRun: Array<{ name: string; reason: string }>;
  /** The readable receipt, as the last message's text. */
  text: string;
  /** Everything `casper --json` puts in its receipt event, for clients that want the rest. */
  json: ReceiptEvent;
}

export function acpReceipt(receipt: ReceiptEvent, task: TaskResult | undefined, hide: (text: string) => string): AcpReceipt {
  const reasons = new Map((task?.verification?.results ?? []).map((result) => [result.name, result.reason ?? ""]));
  return hideDeep({
    outcome: receipt.outcome, verdict: receipt.verdict, exitCode: receipt.exitCode, changed: receipt.changed,
    checksRun: receipt.checks.filter((check) => check.status !== "skip").map((check) => ({ name: check.name, status: check.status as "pass" | "fail",
      command: check.command, exit: check.exit, ms: check.ms, fresh: check.fresh })),
    checksNotRun: receipt.checks.filter((check) => check.status === "skip").map((check) => ({ name: check.name, reason: reasons.get(check.name) || "not run" })),
    text: receipt.text, json: receipt,
  }, hide);
}

/** The receipt as the session's last message: the text a person reads, with the data in `_meta`. */
export function receiptUpdate(receipt: AcpReceipt): Json {
  // On a line of its own after the model's last words.
  return { sessionUpdate: "agent_message_chunk", content: text(`\n${receipt.text.replace(/^\n+|\n+$/g, "")}\n`), _meta: { casper: { receipt } } };
}
