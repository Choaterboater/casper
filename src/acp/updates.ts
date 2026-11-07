// Casper's events (the ones behind `casper --json`, src/app/json-events.ts) as ACP session/update notifications.
// Everything that leaves goes through `hide` first: the --json redaction plus the exact values of the user's own secrets.

import type { CasperEvent, PhaseEvent, ReceiptEvent } from "../app/json-events";
import type { PlanStepReport } from "../flows/plan-build";
import type { RuntimeEvent } from "../runtime/types";
import { fileTextHoldsSecret } from "../secrets/tool-output";
import type { TaskResult } from "../task/result";
import { redactPreview } from "../tui/format";
import type { AcpCommand } from "./commands";
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

/** What starts a paragraph of its own after `tail` (the end of the text sent so far): the app reads an agent message
 * as Markdown, where text after a single newline goes on in the same paragraph. */
function paragraphAfter(tail: string): string {
  return !tail || tail.endsWith("\n\n") ? "" : tail.endsWith("\n") ? "\n" : "\n\n";
}

/** Casper's own lines (a receipt, an `[image]` note) as Markdown keeps them: each line ends in a hard break, so the app
 * shows them one under another as the terminal does, not run on as one paragraph. A blank line (or one of only spaces)
 * stays a blank line, and the line before it gets no break: a break that ends a paragraph would show as a backslash. */
export function keptLines(lines: string): string {
  const all = lines.replace(/^\n+|\n+$/g, "").split("\n");
  // A line that ends in a backslash already would read as an escaped one: two spaces are its break.
  return `${all.map((line, index) => all[index + 1]?.trim() && line.trim() ? `${line}${line.endsWith("\\") ? "  " : "\\"}` : line).join("\n")}\n`;
}

/** A command's output is a monospace block: four backticks, so a ``` line in it does not end the block. */
export const COMMAND_FENCE_OPEN = "````text\n";
/** A line of the output that would end that block (four or more backticks, at most 3 spaces in, nothing after them
 * but spaces: a Markdown file's own block in /diff or /output). */
const ENDS_BLOCK = /^( {0,3})(`{4,}[ \t]*\r?)$/gm;
export const COMMAND_FENCE_CLOSE = "````\n";

/** The / commands an ACP client lists (src/acp/commands.ts). */
export function commandsUpdate(commands: readonly AcpCommand[]): Json {
  return { sessionUpdate: "available_commands_update", availableCommands: commands };
}

/** The model and effort options after a change Casper made itself (src/acp/config-options.ts): the whole list. */
export function configUpdate(configOptions: readonly Json[]): Json {
  return { sessionUpdate: "config_option_update", configOptions };
}

export interface MapperOptions {
  /** The folder a relative path in a step is in. Default: the process's. */
  cwd?: () => string;
  /** The MCP server and tool a runtime tool reaches (CapabilityBroker.named). */
  mcpTool?: (name: string, args: Record<string, unknown>) => { server: string; tool: string } | undefined;
  /** Whether a file's text holds a secret; default fileTextHoldsSecret with Casper's own login files. */
  holdsSecret?: ShowRules["holdsSecret"];
  /** A file whose text only netconan can check (onlyNetconanChecks); default none. */
  unchecked?: ShowRules["unchecked"];
  /** Whether the model is writing a plan Casper holds its words for (decision 84): its text then goes out as thoughts,
   * since the Build box carries the plan. */
  planning?: () => boolean;
}

/** A plan step's status as ACP's: one not done is still open, and says why. */
const STEP_STATUS: Record<PlanStepReport["status"], "pending" | "in_progress" | "completed"> = { pending: "pending", active: "in_progress", done: "completed", "not-done": "pending" };

/**
 * Stateful, one per session. The model's text goes out a line at a time, so a secret is hidden whole, never split
 * across two chunks; the rest goes out when the message ends, before a tool starts, or at flush(). Tool steps come
 * from the runtime's own events (runtime()), with their arguments, output and diffs (src/acp/tool-content.ts).
 */
export class UpdateMapper {
  private pending = "";
  /** The last two letters of the text sent in this prompt since its last step, and whether the next text starts a
   * paragraph of its own: another model message, or words after Casper's own lines. */
  private tail = "";
  private separate = false;
  /** A command's output not sent yet (a part line), and whether its fenced block is open. */
  private commandPending = "";
  private fenceOpen = false;
  private readonly plan: Array<{ phase: PhaseEvent["phase"]; status: "in_progress" | "completed" }> = [];
  /** The accepted plan's checklist in this prompt, shown where the task stage is (decision 84). */
  private planned?: readonly PlanStepReport[];
  /** The model's planning words not sent yet (a part line): thoughts, a whole line at a time as its text is. */
  private thinking = "";
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

  /** The ACP toolCallId of the running step of `tool` (the ask tool's, so the AI's question is asked on it). */
  runningStep(tool: string): string | undefined {
    let found: string | undefined;
    for (const step of this.running.values()) if (step.facts.tool === tool) found = step.id;
    return found;
  }

  /** A runtime event as updates: a tool step's start and end (every other event comes through map()). */
  runtime(event: RuntimeEvent): Json[] {
    if (event.type === "tool_start") {
      const id = `casper-tool-${++this.steps}`;
      let mcp: { server: string; tool: string } | undefined;
      try { mcp = this.options.mcpTool?.(event.toolName, event.args ?? {}); } catch { mcp = undefined; }
      const facts = stepFacts(event, this.cwd(), mcp);
      if (event.toolCallId) this.running.set(event.toolCallId, { id, facts });
      const before = this.flush();
      this.tail = "";
      return [...before, hideDeep(startUpdate(id, facts, this.rules), this.hide, { keys: true })];
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
        if (this.options.planning?.()) return this.thought(event.text);
        // The model speaking ends a command's block first.
        const closed = this.closeFence();
        // A model message after another one, or after Casper's own lines, is a paragraph of its own (two messages
        // would otherwise read as one: "…requirements.I found no issues"); the chunks of one message stay joined.
        if (this.separate && event.text) { this.pending += paragraphAfter(this.tail); this.separate = false; }
        this.pending += event.text;
        const end = this.pending.lastIndexOf("\n");
        if (end < 0) return closed;
        const ready = this.pending.slice(0, end + 1);
        this.pending = this.pending.slice(end + 1);
        return [...closed, this.message(ready)];
      }
      case "assistant_message": { const rest = this.flush(); this.separate = true; return rest; }
      case "check": {
        const notRun = event.status === "skip";
        const title = `Check ${event.name}${event.command ? `: ${event.command}` : ""}${notRun ? " (not run)" : ""}`;
        const before = this.flush();
        this.tail = "";
        return [...before, { sessionUpdate: "tool_call", toolCallId: `casper-check-${++this.steps}`, title: this.hide(title), kind: "execute",
          status: event.status === "fail" ? "failed" : "completed",
          rawOutput: { status: event.status, exit: event.exit, ms: event.ms, ...(event.ended ? { ended: event.ended } : {}), ...(event.label ? { label: this.hide(event.label) } : {}) } }];
      }
      case "phase": {
        let entry = this.plan.find((item) => item.phase === event.phase);
        if (!entry) this.plan.push(entry = { phase: event.phase, status: "in_progress" });
        entry.status = event.state === "start" ? "in_progress" : "completed";
        return [this.planUpdate()];
      }
      case "error": return this.note(`[error] ${event.message}`);
      default: return [];
    }
  }

  /** The accepted plan's checklist (PlanBuild) as the plan's entries: every step, each time. */
  planSteps(steps: readonly PlanStepReport[]): Json[] {
    this.planned = steps.map((step) => ({ ...step }));
    return [this.planUpdate()];
  }

  /** The whole plan: Casper's stages, with the accepted plan's steps where the task stage is, or where it will be. */
  private planEntries(): Json[] {
    const stage = (content: string, status: string) => ({ content: this.hide(content), priority: "medium", status });
    const steps = (this.planned ?? []).map((step) => stage(step.status === "not-done" ? `${step.title} (not done: ${step.reason ?? "no reason given"})` : step.title, STEP_STATUS[step.status]));
    const entries = this.plan.flatMap((item) => item.phase === "task" && this.planned ? steps : [stage(PHASE_WORDS[item.phase], item.status)]);
    return this.planned && !this.plan.some((item) => item.phase === "task") ? [...entries, ...steps] : entries;
  }

  private planUpdate(): Json {
    return { sessionUpdate: "plan", entries: this.planEntries() };
  }

  /** The model's words Casper held while it planned (the plan screen's), when they were no plan: a message of their own
   * after the text so far, as the terminal prints them. Never a note: they are the model's words, not Casper's. */
  words(text: string): Json[] {
    const before = this.flush();
    const shown = text.replace(/^\n+|\s+$/g, "");
    if (!shown) return before;
    const update = this.message(`${paragraphAfter(this.tail)}${shown}\n`);
    this.separate = true;
    return [...before, update];
  }

  /** Planning words as thoughts, a whole line at a time. */
  private thought(words: string): Json[] {
    this.thinking += words;
    const end = this.thinking.lastIndexOf("\n");
    if (end < 0) return [];
    const ready = this.thinking.slice(0, end + 1);
    this.thinking = this.thinking.slice(end + 1);
    return [this.thoughtChunk(ready)];
  }

  private thoughtChunk(words: string): Json {
    return { sessionUpdate: "agent_thought_chunk", content: text(this.hide(words)) };
  }

  /** A line for the person (an `[image] ` note: a picture that was not sent), after the model's text so far, so it
   * reads where it happened: a paragraph of its own, its lines kept (keptLines). */
  note(line: string): Json[] {
    const before = this.flush();
    const update = this.message(`${paragraphAfter(this.tail)}${keptLines(line)}`);
    this.separate = true;
    return [...before, update];
  }

  /** The receipt as the prompt's last message (receiptUpdate), a paragraph of its own after the text so far. */
  receipt(receipt: AcpReceipt): Json[] {
    const before = this.flush();
    const update = receiptUpdate(receipt, paragraphAfter(this.tail));
    this.tail = "";
    this.separate = false;
    return [...before, update];
  }

  /** A new prompt: its first words start the app's new message, so nothing goes before them, and it has no plan steps. */
  newPrompt(): void {
    this.tail = "";
    this.separate = false;
    this.planned = undefined;
  }

  /** A command's output (/status), a whole line at a time, so a secret is hidden whole: Casper's reply in a fenced
   * text block, opened on its first line and closed by the next flush, model text, tool, check or error. */
  commandText(text: string): Json[] {
    this.commandPending += text;
    const end = this.commandPending.lastIndexOf("\n");
    if (end < 0) return [];
    const ready = this.commandPending.slice(0, end + 1);
    this.commandPending = this.commandPending.slice(end + 1);
    return [this.fenced(ready)];
  }

  /** The model's text not sent yet (its planning words too), and the end of a command's block. */
  flush(): Json[] {
    const thought = this.thinking;
    this.thinking = "";
    const closed = [...thought ? [this.thoughtChunk(thought)] : [], ...this.closeFence()];
    const rest = this.pending;
    this.pending = "";
    return rest ? [...closed, this.message(rest)] : closed;
  }

  private fenced(lines: string): Json {
    const open = this.fenceOpen ? "" : COMMAND_FENCE_OPEN;
    this.fenceOpen = true;
    // A zero-width space before such a line keeps it inside: the rest is never read as Markdown.
    return this.message(`${open}${lines.replace(ENDS_BLOCK, "$1\u200b$2")}`);
  }

  private closeFence(): Json[] {
    const rest = this.commandPending;
    this.commandPending = "";
    const out = rest ? [this.fenced(`${rest}\n`)] : [];
    if (this.fenceOpen) {
      this.fenceOpen = false;
      out.push(this.message(COMMAND_FENCE_CLOSE));
      // A closed block ends its paragraph as a blank line does.
      this.tail = "\n\n";
    }
    return out;
  }

  private message(words: string): Json {
    const shown = this.hide(words);
    if (shown) this.tail = (this.tail + shown).slice(-2);
    return { sessionUpdate: "agent_message_chunk", content: text(shown) };
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

/** The receipt as the session's last message: the text a person reads, each of its lines kept (keptLines), with the
 * data in `_meta`. `lead` starts its paragraph after the model's last words (UpdateMapper.receipt). */
export function receiptUpdate(receipt: AcpReceipt, lead = "\n\n"): Json {
  return { sessionUpdate: "agent_message_chunk", content: text(`${lead}${keptLines(receipt.text)}`), _meta: { casper: { receipt } } };
}
