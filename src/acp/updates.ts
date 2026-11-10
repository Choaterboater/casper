// Casper's events (the ones behind `casper --json`, src/app/json-events.ts) as ACP session/update notifications.
// Everything that leaves goes through `hide` first: the --json redaction plus the exact values of the user's own secrets.

import { retryWords } from "../app/events";
import type { CasperEvent, PhaseEvent, ReceiptEvent } from "../app/json-events";
import type { PlanStepReport } from "../flows/plan-build";
import { tokenFields } from "../runtime/model-usage";
import type { RuntimeEvent, RuntimeStatus, RuntimeUsage } from "../runtime/types";
import { fileTextHoldsSecret, liveOutputHoldsSecret, showsPartOfSecret } from "../secrets/tool-output";
import type { TaskResult } from "../task/result";
import { lineText, redactPreview } from "../tui/format";
import type { AcpCommand } from "./commands";
import type { BoxStep } from "./permission";
import type { Json } from "./rpc";
import { endUpdate, liveLines, liveUpdate, startUpdate, stepFacts, type ShowRules, type StepFacts } from "./tool-content";

const HIDDEN = "<secret hidden>";

/** A headline cut at 60 characters (reasoningHeadline) may end inside a secret, which `hide` then cannot see whole:
 * a run of 4 or more characters before the final `…` that starts one of `values` is hidden too. */
export function hideCut(headline: string, values: readonly string[]): string {
  if (!headline.endsWith("…")) return headline;
  const body = headline.slice(0, -1);
  for (const value of values) {
    if (value.length < 6) continue;
    for (let size = Math.min(value.length - 1, body.length); size >= 4; size--) {
      if (body.endsWith(value.slice(0, size))) return `${body.slice(0, -size)}${HIDDEN}…`;
    }
  }
  return headline;
}

/** A conversation's name as the app's chat title (decision 96), hidden: `hide`, then each of `values` (the user's own
 * secrets) as sessionTitle may have trimmed it (a final `.`, `,`, `:`, `;`, `!` or `?` gone), then the start of one
 * that a long first word's cut at 40 characters ends inside (hideCut). */
export function titleShown(name: string, hide: (text: string) => string, values: readonly string[]): string {
  let shown = hide(name);
  const forms = [...new Set(values.map((value) => value.replace(/[\s.,:;!?]+$/, "")))].filter((form) => form.length >= 6).sort((a, b) => b.length - a.length);
  for (const form of forms) if (shown.includes(form)) shown = shown.split(form).join(HIDDEN);
  return hideCut(shown, values);
}

/** Each of `values` as reasoningHeadline may have changed it, longest first: marks and a leading `#` taken off,
 * spaces run together, and at the end of a sentence its final `.`, `:` or `;` gone; the value itself too. */
export function headlineForms(values: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const value of values) {
    const plain = lineText(value).replace(/\*\*|__|`/g, "").replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
    for (const form of [value, plain, plain.replace(/[\s.:;…]+$/, "")]) if (form.length >= 6) forms.add(form);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

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
  /** Whether the model's reasoning headlines go out as thoughts (decision 87): reasoning_headline, and not at display
   * quiet. Default: yes. */
  headlines?: () => boolean;
  /** The user's own secrets, for a headline that changed one or was cut inside one (headlineForms, hideCut). */
  values?: () => readonly string[];
  /** The main runtime's usage and status, for the usage_update after each of its responses (decision 88). */
  usage?: () => RuntimeUsage | undefined;
  status?: () => RuntimeStatus | undefined;
  /** Whether a running command's output goes out while it runs (decision 98): acp_live_output. Default: yes. */
  liveOutput?: () => boolean;
  /** Whether netconan is in use: it can't check text shown at once, so then no running output goes out. Default: no. */
  netconan?: () => boolean;
  /** Whether a running command's latest lines hold what its final output's scrub would hide, read after `before`, the
   * output above them (`cut`: that does not start where the output did); default liveOutputHoldsSecret with Casper's own
   * login files. */
  liveHoldsSecret?: (text: string, cut: boolean, before: string) => boolean;
}

/** How a cost is paid: OpenRouter's is what it charged, another provider's a catalog estimate, a subscription's
 * no per-token price at all (formatCostLong); null when there is no cost. */
export type CostKind = "charged" | "estimate" | "subscription" | null;

export function costKind(status: RuntimeStatus | undefined, cost: number | null | undefined): CostKind {
  if (status?.billing === "subscription") return "subscription";
  if (cost === undefined || cost === null) return null;
  return status?.provider === "openrouter" ? "charged" : "estimate";
}

/** ACP's usage_update after a main-runtime response (decision 88): the context the response left and its window, the
 * session's cost (none under a subscription), and the response's own tokens in `_meta.casper`. None without a window
 * or a reported usage, nor for a cancelled or failed response: its usage is a stream's start (Pi's context skips it)
 * and a held error's cost is already the session's, so the app keeps the last figures. The runtime's figures do not hold the response yet (Pi records it after its listeners hear it),
 * so the response's prompt and output are the context, and its cost is added to the session's. */
export function usageUpdate(end: Extract<RuntimeEvent, { type: "assistant_response_end" }>, usage: RuntimeUsage | undefined, status: RuntimeStatus | undefined): Json | undefined {
  const size = usage?.context?.contextWindow ?? 0;
  const reported = end.usage;
  if (!(size > 0) || !reported || end.stopReason === "aborted" || end.stopReason === "error") return undefined;
  const tokens = tokenFields(reported);
  const split = tokens.input !== null && tokens.output !== null;
  const used = split ? tokens.input! + (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) + tokens.output! : usage?.context?.tokens ?? reported.tokens;
  const total = (usage?.estimatedCost ?? 0) + (Number.isFinite(reported.estimatedCost) ? reported.estimatedCost : 0);
  const cost = total > 0 ? total : undefined;
  const kind = costKind(status, cost);
  return { sessionUpdate: "usage_update", used, size,
    ...(cost !== undefined && kind !== "subscription" ? { cost: { amount: cost, currency: "USD" } } : {}),
    _meta: { casper: { response: { ...tokens, tokens: reported.tokens, toolUse: end.stopReason === "toolUse" },
      model: { provider: status?.provider ?? null, model: status?.model ?? null }, cost: kind } } };
}

/** Whether a running step still sends its output as it runs (decision 98), and the content it sent last. */
interface LiveState { on: boolean; last?: string }

/** A plan step's status as ACP's: one not done is still open, and says why. */
const STEP_STATUS: Record<PlanStepReport["status"], "pending" | "in_progress" | "completed"> = { pending: "pending", active: "in_progress", done: "completed", "not-done": "pending" };

/**
 * Stateful, one per session. The model's text goes out a line at a time, so a secret is hidden whole, never split
 * across two chunks; the rest goes out when the message ends, before a tool starts, or at flush(). Tool steps come
 * from the runtime's own events (runtime()), with their arguments, output and diffs (src/acp/tool-content.ts), and a
 * running command's latest lines while it runs (decision 98).
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
  /** The headline last sent as a thought, until a step, the end of a response or a new prompt (decision 87). */
  private lastHeadline?: string;
  /** The ACP id of each running tool, by the model's id: a model may use the same id again in a later turn. `box` is
   * what a box the step raises repeats (decision 85): the diffs and files its start showed, already hidden. */
  private readonly running = new Map<string, { id: string; facts: StepFacts; box: Omit<BoxStep, "id">; live: LiveState }>();
  private readonly cwd: () => string;
  private readonly rules: ShowRules;
  private readonly liveHoldsSecret: (text: string, cut: boolean, before: string) => boolean;

  constructor(private readonly hide: (text: string) => string, private readonly options: MapperOptions = {}) {
    this.cwd = options.cwd ?? (() => process.cwd());
    this.rules = { holdsSecret: options.holdsSecret ?? ((file, text) => fileTextHoldsSecret(file, text)), ...(options.unchecked ? { unchecked: options.unchecked } : {}) };
    this.liveHoldsSecret = options.liveHoldsSecret ?? ((text, cut, before) => liveOutputHoldsSecret(text, { cut, before }));
  }

  /** The ACP toolCallId of the running tool the model calls `id`, if it is running. */
  acpId(id: string): string | undefined {
    return this.running.get(id)?.id;
  }

  /** The running step the model calls `id`, as a box it raises names it: its ACP id, and a copy of the diffs and files
   * its start showed (an edit's replacements; a write, a command or an edit holding a secret has none). */
  step(id: string): BoxStep | undefined {
    const step = this.running.get(id);
    return step ? { id: step.id, ...structuredClone(step.box) } : undefined;
  }

  /** The ACP toolCallId of the running step of `tool` (the ask tool's, so the AI's question is asked on it). */
  runningStep(tool: string): string | undefined {
    let found: string | undefined;
    for (const step of this.running.values()) if (step.facts.tool === tool) found = step.id;
    return found;
  }

  /** A runtime event as updates: a tool step's start, its running output and its end (every other event comes through
   * map()). */
  runtime(event: RuntimeEvent): Json[] {
    if (event.type === "assistant_progress") {
      if (event.kind !== "thinking" || !event.headline || this.options.headlines?.() === false) return [];
      // A thought of its own, sent only when it changed: the model's text held so far stays held.
      // The headline is made from the reasoning (reasoningHeadline), which can change a secret: each changed form too.
      const forms = headlineForms(this.options.values?.() ?? []);
      let shown = this.hide(event.headline);
      for (const form of forms) if (shown.includes(form)) shown = shown.split(form).join(HIDDEN);
      shown = hideCut(shown, forms);
      if (!shown.trim() || shown === this.lastHeadline) return [];
      this.lastHeadline = shown;
      return [this.thoughtChunk(`${shown}\n\n`, false)];
    }
    if (event.type === "retry") return [this.thoughtChunk(`${retryWords(event)}\n\n`)];
    if (event.type === "assistant_response_end") {
      this.lastHeadline = undefined;
      // The main runtime's only: a helper's usage comes as a `usage` event, which sends nothing (decision 88).
      let update: Json | undefined;
      try { update = usageUpdate(event, this.options.usage?.(), this.options.status?.()); } catch { update = undefined; }
      return update ? [...this.flush(), hideDeep(update, this.hide)] : [];
    }
    if (event.type === "tool_start") {
      this.lastHeadline = undefined;
      const id = `casper-tool-${++this.steps}`;
      let mcp: { server: string; tool: string } | undefined;
      try { mcp = this.options.mcpTool?.(event.toolName, event.args ?? {}); } catch { mcp = undefined; }
      const facts = stepFacts(event, this.cwd(), mcp);
      const start = hideDeep(startUpdate(id, facts, this.rules), this.hide, { keys: true });
      if (event.toolCallId) {
        const diffs = Array.isArray(start.content) ? start.content.filter((item: Json) => item?.type === "diff") : [];
        this.running.set(event.toolCallId, { id, facts, box: { diffs: structuredClone(diffs), ...(Array.isArray(start.locations) ? { locations: structuredClone(start.locations) } : {}) },
          live: { on: this.commandShown(facts) } });
      }
      const before = this.flush();
      this.tail = "";
      return [...before, start];
    }
    if (event.type === "tool_progress") return this.live(event);
    if (event.type === "tool_end") {
      const step = event.toolCallId ? this.running.get(event.toolCallId) : undefined;
      if (!step) return [];
      this.running.delete(event.toolCallId!);
      return [hideDeep(endUpdate(step.id, step.facts, event, this.rules), this.hide, { keys: true })];
    }
    return [];
  }

  /** A shell step whose start showed its command as it is: one the command rules or the session's hiding changed (a
   * secret typed into it) may print that secret, so its output waits for its end. */
  private commandShown(facts: StepFacts): boolean {
    const command = facts.args.command;
    return ["bash", "powershell"].includes(facts.tool) && typeof command === "string" && facts.input.command === command && this.hide(command) === command;
  }

  /** A running shell step's latest whole lines (decision 98), hidden as its end is. Nothing with acp_live_output off,
   * while netconan is in use, for a step that is not running or whose command was hidden, or for lines that hold what
   * the final scrub would hide: that step then sends no more until it ends, scrubbed. */
  private live(event: Extract<RuntimeEvent, { type: "tool_progress" }>): Json[] {
    const step = event.toolCallId ? this.running.get(event.toolCallId) : undefined;
    if (!step?.live.on || this.options.liveOutput?.() === false || this.options.netconan?.() === true) return [];
    const { before, lines, pending } = liveLines(event.text, event.cut === true);
    // The lines that wait are read too: a step whose lines hold a secret sends no more, shown yet or not.
    const read = lines + pending;
    if (!read.trim()) return [];
    let holds: boolean;
    try {
      // The session's hiding reads the end's output whole: a value of several lines only whole, and a name on a line
      // above ("password:", "--token", "Bearer") hides the first word below it. Lines it would hide otherwise than
      // alone wait for the end too.
      holds = this.liveHoldsSecret(read, event.cut === true, before)
        || showsPartOfSecret(read, { before, cut: event.cut === true }, (this.options.values?.() ?? []).filter((value) => value.length >= 6))
        || this.hide(before + read) !== this.hide(before) + this.hide(read);
    } catch { holds = true; }
    if (holds) { step.live.on = false; return []; }
    if (!lines.trim()) return [];
    const update = hideDeep(liveUpdate(step.id, lines), this.hide, { keys: true });
    const shown = JSON.stringify(update.content);
    if (shown === step.live.last) return [];
    step.live.last = shown;
    return [update];
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

  /** `hide` false: the words went through it already. */
  private thoughtChunk(words: string, hide = true): Json {
    return { sessionUpdate: "agent_thought_chunk", content: text(hide ? this.hide(words) : words) };
  }

  /** A line for the person (an `[image] ` note: a picture that was not sent), after the model's text so far, so it
   * reads where it happened: a paragraph of its own, its lines kept (keptLines). `_meta.casper.note` tells it from the
   * model's words (decision 88). */
  note(line: string): Json[] {
    const before = this.flush();
    const update = { ...this.message(`${paragraphAfter(this.tail)}${keptLines(line)}`), _meta: { casper: { note: true } } };
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
    this.newMessage();
    this.planned = undefined;
    this.lastHeadline = undefined;
  }

  /** The app was shown the person's line (a steer the AI read, decision 86): the model's next words start a new
   * message. The prompt's plan steps stay. */
  newMessage(): void {
    this.tail = "";
    this.separate = false;
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
  /** The task's model use, as the receipt event's; null when no model task ran. */
  usage: ReceiptEvent["usage"];
  /** How its cost is paid (costKind); null when it has none. */
  cost: CostKind;
  /** The folder the changed files are in. */
  root: string;
}

export function acpReceipt(receipt: ReceiptEvent, task: TaskResult | undefined, hide: (text: string) => string,
  context: { status?: RuntimeStatus; root: string }): AcpReceipt {
  const reasons = new Map((task?.verification?.results ?? []).map((result) => [result.name, result.reason ?? ""]));
  return hideDeep({
    outcome: receipt.outcome, verdict: receipt.verdict, exitCode: receipt.exitCode, changed: receipt.changed,
    checksRun: receipt.checks.filter((check) => check.status !== "skip").map((check) => ({ name: check.name, status: check.status as "pass" | "fail",
      command: check.command, exit: check.exit, ms: check.ms, fresh: check.fresh })),
    checksNotRun: receipt.checks.filter((check) => check.status === "skip").map((check) => ({ name: check.name, reason: reasons.get(check.name) || "not run" })),
    text: receipt.text, json: receipt,
    usage: receipt.usage ? { ...receipt.usage } : null, cost: costKind(context.status, receipt.usage?.estimatedCost), root: context.root,
  }, hide);
}

/** The receipt as the session's last message: the text a person reads, each of its lines kept (keptLines), with the
 * data in `_meta`. `lead` starts its paragraph after the model's last words (UpdateMapper.receipt). */
export function receiptUpdate(receipt: AcpReceipt, lead = "\n\n"): Json {
  return { sessionUpdate: "agent_message_chunk", content: text(`${lead}${keptLines(receipt.text)}`), _meta: { casper: { receipt } } };
}
