import type { InteractiveTerminal } from "../tui/terminal";
import { formatDuration, formatToolActivity, redactPreview, terminalText } from "../tui/format";
import type { RuntimeEvent } from "../runtime/types";
import type { OutputWriter } from "./commands";
import { SPEND_STOP_REASON } from "../task/spend";

/** Session-owned effects the renderer needs; the app implements these against its state. */
export interface RuntimeEventCallbacks {
  updateFooter(): void;
  /** Bounded tool-output retention plus downstream invalidation for mutation tools. */
  onToolEnd(event: Extract<RuntimeEvent, { type: "tool_end" }>): void;
  /** Final provider stop outcome of the current model turn. */
  setTaskStop(cancelled: boolean, failed: boolean): void;
  markRuntimeFailed(): void;
  /** The request's --max-turns limit stopped the model after this many turns. */
  turnLimitReached(turns: number): void;
  /** The person cancelled the current command; its abort errors are not news to them. */
  cancelled(): boolean;
  /** The project root, so tool paths print relative to it. */
  projectRoot?(): string | undefined;
}

type ToolStart = Extract<RuntimeEvent, { type: "tool_start" }>;
type ToolEnd = Extract<RuntimeEvent, { type: "tool_end" }>;
type StepKind = "edit" | "command" | "read" | "other";

/** One tool call on the rich terminal: shown in the Working box while the model works, then folded. */
interface Step {
  id?: string;
  toolName: string;
  kind: StepKind;
  path?: string;
  startedAt: number;
  endedAt?: number;
  /** Its line in the Working box (running, then finished). */
  line: string;
  /** The finished line as printed on the main screen, with a failure's detail. */
  printed?: string;
  failed?: boolean;
  /** A failed edit the model tried again at once: counted, not printed. */
  retried?: boolean;
  /** Casper stopped it before it ran (the spend limit): printed as not run, never counted as a step. */
  notRun?: boolean;
}

function stepKind(toolName: string): StepKind {
  if (toolName === "edit" || toolName === "write") return "edit";
  if (toolName === "bash" || toolName === "powershell") return "command";
  if (["read", "grep", "find", "ls"].includes(toolName)) return "read";
  return "other";
}

const KIND_WORDS: Record<StepKind, [string, string]> = {
  edit: ["edit", "edits"], command: ["command", "commands"], read: ["read", "reads"], other: ["other step", "other steps"],
};

/** After a tool call Casper stopped at the spend limit. */
const NOT_RUN = " — not run (spend limit)";

/** How many steps the Working box shows. */
const BOX_STEPS = 3;

/** One line for a finished group of steps: "✓ 14 edits · 6 commands · 1 failed · 38s". */
export function stepSummary(steps: ReadonlyArray<{ kind: StepKind; failed?: boolean; startedAt: number; endedAt?: number }>): string {
  const counts = new Map<StepKind, number>();
  for (const step of steps) counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
  const parts = (["edit", "command", "read", "other"] as const).flatMap(kind => {
    const count = counts.get(kind) ?? 0;
    return count ? [`${count} ${KIND_WORDS[kind][count === 1 ? 0 : 1]}`] : [];
  });
  const failed = steps.filter(step => step.failed).length;
  if (failed) parts.push(`${failed} failed`);
  const first = Math.min(...steps.map(step => step.startedAt));
  const last = Math.max(...steps.map(step => step.endedAt ?? step.startedAt));
  const duration = formatDuration(last - first);
  if (duration) parts.push(duration);
  return `✓ ${parts.join(" · ")}`;
}

/** Renders runtime events onto the terminal. On the rich terminal the main screen keeps the model's words,
 * questions and receipts: tool calls live in the Working box (the last few steps, updated in place) and fold
 * into one summary line when the model moves on. The plain terminal prints one line per finished tool.
 * Extraction-safe: everything here is rendering, not orchestration. */
export class RuntimeEventView {
  private readonly toolStarted = new Map<string, number>();
  private steps: Step[] = [];
  /** What the model is doing now ("Waiting for …", "Reasoning"), under the steps in the Working box. */
  private status?: string;
  private responseActivity?: string;
  private responseStartedAt?: number;
  private activityTimer?: NodeJS.Timeout;
  private endedWithNewline = true;
  private displayedError?: string;

  constructor(private readonly terminal: InteractiveTerminal, private readonly output: OutputWriter,
    private readonly callbacks: RuntimeEventCallbacks) {}

  /** Tool lines: relative paths, and on a rich terminal one row at its current width (inside the box when boxed). */
  private fit(inset = 0): { root?: string; width?: number } {
    return { root: this.callbacks.projectRoot?.(), ...(this.terminal.rich && this.terminal.columns ? { width: this.terminal.columns - inset } : {}) };
  }

  ensureLineBreak(): void {
    if (!this.endedWithNewline) {
      this.output.write("\n");
      this.endedWithNewline = true;
    }
  }

  writePrompt(prompt: string): void {
    if (!this.endedWithNewline) {
      this.output.write("\n");
    }

    this.output.write(`> ${prompt}\n`);
    this.endedWithNewline = true;
  }

  /** The Working box: the latest steps, then what the model is doing now. */
  private renderBox(): void {
    if (!this.terminal.rich) return;
    const lines = this.steps.slice(-BOX_STEPS).map(step => step.line);
    if (this.status) lines.push(this.status);
    this.terminal.setActivity(lines.length ? lines : undefined);
  }

  private setResponseActivity(activity: string): void {
    if (!this.terminal.rich) return;
    this.responseActivity = activity;
    this.responseStartedAt ??= performance.now();
    this.renderResponseActivity();
    if (!this.activityTimer) {
      this.activityTimer = setInterval(() => this.renderResponseActivity(), 1000);
      this.activityTimer.unref();
    }
  }

  private renderResponseActivity(): void {
    if (!this.responseActivity || this.responseStartedAt === undefined) return;
    const seconds = Math.floor((performance.now() - this.responseStartedAt) / 1000);
    const minutes = Math.floor(seconds / 60);
    const elapsed = minutes ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
    this.status = `${this.responseActivity} · ${elapsed}`;
    this.renderBox();
  }

  private clearResponseActivity(): void {
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = undefined; this.responseActivity = undefined; this.responseStartedAt = undefined;
  }

  private setStaticActivity(activity?: string): void {
    // Text deltas call this on every chunk. Skip once the status is already gone.
    if (activity === undefined && this.status === undefined && !this.activityTimer) return;
    this.clearResponseActivity();
    this.status = activity;
    this.renderBox();
  }

  /** The model moved on: finished steps leave the box and fold into one line on the main screen. A single
   * step prints its own line; failures print theirs, except failed edits the model retried at once. */
  private fold(): void {
    const done = this.steps.filter(step => step.endedAt !== undefined);
    if (!done.length) return;
    this.steps = this.steps.filter(step => step.endedAt === undefined);
    this.terminal.endAssistant();
    this.ensureLineBreak();
    for (const step of done) if (step.notRun) this.output.write(`${step.printed}\n`);
    const ran = done.filter(step => !step.notRun);
    if (ran.length === 1 && !ran[0]!.retried) this.output.write(`${ran[0]!.printed}\n`);
    else if (ran.length) {
      for (const step of ran) if (step.failed && !step.retried) this.output.write(`${step.printed}\n`);
      this.output.write(`${stepSummary(ran)}\n`);
    }
    this.endedWithNewline = true;
    this.renderBox();
  }

  /** The receipt is next: fold what finished, and the Working box goes away whatever arrives late. */
  reset(): void {
    this.fold();
    this.steps = [];
    this.clearResponseActivity();
    this.status = undefined;
    this.toolStarted.clear();
    this.terminal.setActivity(undefined);
  }

  get lastError(): string | undefined {
    return this.displayedError;
  }

  clearError(): void {
    this.displayedError = undefined;
  }

  handle(event: RuntimeEvent): void {
    if (event.type !== "assistant_text_delta" && event.type !== "assistant_progress") this.callbacks.updateFooter();
    switch (event.type) {
      case "model_controls_changed": {
        // Auto effort classified (or fell back) for this request. The footer carries the level on a
        // rich terminal; one-shot and plain output get one line so the choice is still on record.
        this.terminal.endAssistant();
        const state = event.status.autoEffort?.state;
        const degraded = state === "fallback" || state === "unavailable";
        if (degraded || (!this.terminal.rich && event.status.configuredEffort === "auto" && state === "classified")) {
          this.ensureLineBreak();
          this.output.write(degraded
            ? `[effort] automatic classification ${state}; using ${event.status.thinkingLevel ?? "the previous level"}.\n`
            : `[effort] auto → ${event.status.thinkingLevel ?? "—"}\n`);
          this.endedWithNewline = true;
        }
        break;
      }
      case "assistant_response_start": {
        this.clearResponseActivity();
        const model = [event.provider, event.model].filter((part): part is string => Boolean(part)).map(terminalText).join("/");
        this.setResponseActivity(`Waiting for ${model || "model response"}`);
        break;
      }
      case "assistant_progress": {
        if (!this.terminal.rich) break;
        // Some providers deliver tool arguments whole; the box then says what is being prepared.
        const size = event.chars === 0 ? "" : event.chars >= 1024 ? ` · ${(event.chars / 1024).toFixed(1)}k chars` : ` · ${event.chars} chars`;
        const what = event.kind === "thinking" ? "Reasoning" : `Preparing ${terminalText(event.toolName ?? "tool call")}`;
        this.setResponseActivity(`${what}${size}`);
        break;
      }
      case "assistant_response_end": {
        this.setStaticActivity(event.stopReason === "toolUse" ? "Starting tools…" : undefined);
        this.terminal.endAssistant();
        // Pi may retry a provider error inside prompt(); only the final response
        // determines the stop outcome. Thrown prompt errors are handled separately.
        const failed = !["stop", "toolUse"].includes(event.stopReason);
        this.callbacks.setTaskStop(event.stopReason === "aborted", failed);
        // A provider failure (retired model slug, quota, rejected credential) otherwise reaches
        // the receipt as a bare "Execution failed" with no cause the person can act on.
        // A cancel already printed its own notice, so its aborted stop is not an error.
        if (failed && !this.callbacks.cancelled() && event.errorMessage && this.displayedError !== event.errorMessage) {
          this.ensureLineBreak();
          this.output.write(`[error] ${redactPreview(event.errorMessage)}\n`);
          this.displayedError = event.errorMessage;
          this.endedWithNewline = true;
        }
        break;
      }
      case "assistant_text_delta":
        // The model moved on: the finished steps fold into one line above its words.
        if (this.steps.some(step => step.endedAt !== undefined)) this.fold();
        this.setStaticActivity();
        this.terminal.assistant(event.delta);
        this.endedWithNewline = true;
        break;
      case "tool_start": {
        if (event.toolCallId) this.toolStarted.set(event.toolCallId, performance.now());
        if (!this.terminal.rich) break; // The plain terminal prints the end line only.
        this.terminal.endAssistant();
        // A failed edit followed at once by another edit of the same file was retried: count it, don't print it.
        const last = this.steps.at(-1);
        const path = typeof event.input?.path === "string" ? event.input.path : undefined;
        if (last?.failed && last.kind === "edit" && stepKind(event.toolName) === "edit" && path !== undefined && last.path === path) last.retried = true;
        this.steps.push({ ...(event.toolCallId ? { id: event.toolCallId } : {}), toolName: event.toolName, kind: stepKind(event.toolName),
          ...(path !== undefined ? { path } : {}), startedAt: performance.now(), line: formatToolActivity(event, undefined, this.fit(4)) });
        this.clearResponseActivity(); this.status = undefined;
        this.renderBox();
        break;
      }
      case "tool_end": {
        this.callbacks.onToolEnd(event);
        const started = event.toolCallId ? this.toolStarted.get(event.toolCallId) : undefined;
        if (event.toolCallId) this.toolStarted.delete(event.toolCallId);
        const elapsed = started === undefined ? undefined : performance.now() - started;
        // A failed casper_check already printed its formatted result line; its JSON payload is for the model.
        const shown: ToolEnd = event.toolName === "casper_check" ? { ...event, output: undefined } : event;
        // Stopped at the spend limit before it ran: not a failure, and the model's instruction is not for the screen.
        const notRun = event.isError && event.output?.text?.trim() === SPEND_STOP_REASON;
        const endLine = (inset: number, detail: boolean) => notRun
          ? `${formatToolActivity({ type: "tool_start", toolName: event.toolName, ...(event.input ? { input: event.input } : {}) }, undefined, this.fit(inset + NOT_RUN.length))}${NOT_RUN}`
          : formatToolActivity(detail ? shown : { ...shown, output: undefined }, elapsed, this.fit(inset));
        if (!this.terminal.rich) {
          this.terminal.endAssistant();
          this.ensureLineBreak();
          this.output.write(`${endLine(0, true)}\n`);
          this.endedWithNewline = true;
          break;
        }
        let step = this.steps.find(candidate => candidate.endedAt === undefined && (event.toolCallId ? candidate.id === event.toolCallId : candidate.toolName === event.toolName));
        if (!step) {
          // It ended after its turn folded (or never said it started): it still shows until the next fold or receipt.
          step = { toolName: event.toolName, kind: stepKind(event.toolName), startedAt: performance.now() - (elapsed ?? 0), line: "" };
          this.steps.push(step);
        }
        step.endedAt = performance.now();
        step.failed = event.isError && !notRun;
        if (notRun) step.notRun = true;
        step.line = endLine(4, false);
        step.printed = endLine(0, true);
        this.renderBox();
        break;
      }
      case "message_end":
        this.setStaticActivity();
        this.terminal.endAssistant();
        this.fold();
        this.toolStarted.clear();
        this.ensureLineBreak();
        break;
      case "turn_limit":
        this.callbacks.turnLimitReached(event.turns);
        break;
      case "error":
        this.callbacks.markRuntimeFailed();
        this.setStaticActivity();
        this.terminal.endAssistant();
        this.ensureLineBreak();
        if (this.displayedError !== event.message && !this.callbacks.cancelled()) this.output.write(`[error] ${redactPreview(event.message)}\n`);
        this.displayedError = event.message;
        this.endedWithNewline = true;
        break;
    }
  }
}
