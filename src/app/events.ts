import type { InteractiveTerminal } from "../tui/terminal";
import { formatToolActivity, redactPreview, terminalText } from "../tui/format";
import type { RuntimeEvent } from "../runtime/types";
import type { OutputWriter } from "./commands";

/** Session-owned effects the renderer needs; the app implements these against its state. */
export interface RuntimeEventCallbacks {
  updateFooter(): void;
  /** Bounded tool-output retention plus downstream invalidation for mutation tools. */
  onToolEnd(event: Extract<RuntimeEvent, { type: "tool_end" }>): void;
  /** Final provider stop outcome of the current model turn. */
  setTaskStop(cancelled: boolean, failed: boolean): void;
  markRuntimeFailed(): void;
}

/** Renders runtime events onto the terminal and owns the transcript-flow state that makes
 * incremental output correct: the open tool line and whether the last write ended a line.
 * Extraction-safe: everything here is rendering, not orchestration. */
export class RuntimeEventView {
  private readonly toolStarted = new Map<string, number>();
  private openToolLine = false;
  private openToolCallId?: string;
  private responseActivity?: string;
  private responseStartedAt?: number;
  private activityTimer?: NodeJS.Timeout;
  private endedWithNewline = true;
  private displayedError?: string;

  constructor(private readonly terminal: InteractiveTerminal, private readonly output: OutputWriter,
    private readonly callbacks: RuntimeEventCallbacks) {}

  /** Called by the app's output wrapper before every write to commit an open tool line. */
  beforeWrite(text: string): void {
    if (this.openToolLine) { this.openToolLine = false; if (!text.startsWith("\r")) this.terminal.write("\n"); }
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
    this.terminal.setActivity(`${this.responseActivity} · ${elapsed}`);
  }

  private clearResponseActivity(): void {
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = undefined; this.responseActivity = undefined; this.responseStartedAt = undefined;
  }

  private setStaticActivity(activity?: string): void {
    // Text deltas call this on every chunk. Skip once the waiting box is already gone.
    if (activity === undefined && !this.responseActivity && !this.activityTimer) return;
    this.clearResponseActivity();
    this.terminal.setActivity(activity);
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
        if (this.openToolLine) { this.openToolLine = false; this.terminal.write("\n"); }
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
        if (failed && event.errorMessage && this.displayedError !== event.errorMessage) {
          this.ensureLineBreak();
          this.output.write(`[error] ${redactPreview(event.errorMessage)}\n`);
          this.displayedError = event.errorMessage;
          this.endedWithNewline = true;
        }
        break;
      }
      case "assistant_text_delta":
        this.setStaticActivity();
        this.openToolLine = false; // The streaming block commits any open tool line inside the transcript.
        this.terminal.assistant(event.delta);
        this.endedWithNewline = true;
        break;
      case "tool_start": {
        this.setStaticActivity(formatToolActivity(event));
        this.terminal.endAssistant();
        this.ensureLineBreak();
        if (event.toolCallId) this.toolStarted.set(event.toolCallId, performance.now());
        const inPlace = this.terminal.rich && event.toolCallId !== undefined;
        this.output.write(`${formatToolActivity(event)}${inPlace ? "" : "\n"}`);
        if (inPlace) { this.openToolLine = true; this.openToolCallId = event.toolCallId; }
        this.endedWithNewline = true;
        break;
      }
      case "tool_end":
        this.callbacks.onToolEnd(event);
        this.setStaticActivity(`${event.isError ? "Tool failed" : "Tool finished"} · ${terminalText(event.toolName)}`);
        this.terminal.endAssistant();
        const started = event.toolCallId ? this.toolStarted.get(event.toolCallId) : undefined;
        if (event.toolCallId) this.toolStarted.delete(event.toolCallId);
        // A failed casper_check already printed its formatted result line; its JSON payload is for the model.
        const shown = event.toolName === "casper_check" ? { ...event, output: undefined } : event;
        const line = `${formatToolActivity(shown, started === undefined ? undefined : performance.now() - started)}\n`;
        if (this.openToolLine && event.toolCallId === this.openToolCallId) { this.openToolLine = false; this.terminal.write(line, { rewriteLine: true }); }
        else this.output.write(line);
        this.endedWithNewline = true;
        break;
      case "message_end":
        this.setStaticActivity();
        this.terminal.endAssistant();
        this.toolStarted.clear();
        this.ensureLineBreak();
        break;
      case "error":
        this.callbacks.markRuntimeFailed();
        this.setStaticActivity();
        this.terminal.endAssistant();
        this.ensureLineBreak();
        if (this.displayedError !== event.message) this.output.write(`[error] ${redactPreview(event.message)}\n`);
        this.displayedError = event.message;
        this.endedWithNewline = true;
        break;
    }
  }
}
