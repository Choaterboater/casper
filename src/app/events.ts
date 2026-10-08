import type { InteractiveTerminal } from "../tui/terminal";
import { BUSY_GLYPH, displayPath, formatDuration, formatToolActivity, lastOutputLine, redactPreview, runningElapsed, terminalText } from "../tui/format";
import type { RuntimeEvent } from "../runtime/types";
import type { OutputWriter } from "./commands";
import { SPEND_STOP_REASON } from "../task/spend";
import type { HelperActivity } from "../agents/manager";
import { inlineDiff, type DisplayLevel } from "../tui/display";
import os from "node:os";
import path from "node:path";
import { tildePath } from "../new/scaffold";
import { isOutside } from "../platform/inside";
import { explainModelError } from "../runtime/model-errors";
import type { CheckProgressRun } from "../verify/progress";

/** Session-owned effects the renderer needs; the app implements these against its state. */
export interface RuntimeEventCallbacks {
  updateFooter(): void;
  /** The goals of the builders running now, for the Working box. Unset: no line. */
  builderGoals?(): readonly string[];
  /** How many reviewers run now, for the same line. Unset: none. */
  reviewerCount?(): number;
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
  /** The session's home folder, for ~ in paths. Unset: the real home. */
  homeDir?(): string;
  /** How much of the work shows (display: in the config, /details). Unset: normal. */
  display?(): DisplayLevel;
  /** Plain terminal: say once a minute that a long check still runs. Unset: yes. (`--json` says no.) */
  announceLongChecks?(): boolean;
}

/** A check Casper itself is running, for the Working box (rich) or the once-a-minute line (plain). */
interface RunningCheck { name: string; startedAt: number; tail?: string; minutes?: ReturnType<typeof setInterval> }

/** A plain terminal says a check still runs this often. */
export const PLAIN_CHECK_EVERY_MS = 60_000;
/** How many running checks the Working box lists. */
const BOX_CHECKS = 3;

/** The last finished step in full, for ctrl+t: an edit's whole diff, or what a tool printed. */
export interface ExpandedStep { title: string; body: string; diff: boolean }

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
  /** The start event, to redraw the running line with its elapsed time. */
  start?: ToolStart;
  /** The last line of a running command's output so far (rich terminal, not quiet). */
  tail?: string;
  /** Its line in the Working box (running, then finished). */
  line: string;
  /** The finished line as printed on the main screen, with a failure's detail. */
  printed?: string;
  /** An edit's diff, for the detailed display. */
  diff?: string;
  failed?: boolean;
  /** A failed edit the model tried again at once: counted, not printed. */
  retried?: boolean;
  /** Casper stopped it before it ran (the spend limit, or a refusal): printed as not run, never counted as a step. */
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
/** After a tool call Casper refused before it ran (a private place, another machine, your No). */
const REFUSED = " — not run";

/**
 * Casper's own refusals start with "Not run:" and end with words for the model ("Ask the user instead").
 * On screen only the reason stays, said to you: "Not run: the user said no to …" reads "You said no to …".
 */
export function refusalForScreen(text: string): string | undefined {
  const match = /^(?:\[shell\] )?Not run: ([\s\S]+)$/.exec(text.trim());
  if (!match) return undefined;
  const sentences = match[1]!.replace(/\s+/g, " ").split(/(?<=\.)\s+/);
  const kept = sentences.filter(sentence => !/^(?:Tell the user|Ask the user|Don't|Keep the original)/.test(sentence));
  const reason = (kept.length ? kept : sentences).join(" ")
    .replace(/;\s*ask the user[^.]*\./i, ".").replace(/^the user said no/, "you said no");
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/** Plain terminal: a command still running after this long prints its start line. */
export const PLAIN_START_AFTER_MS = 2000;

/** Starts the Working box line that shows a running command's latest output (the surface draws it dim). */
export const TAIL_MARK = "↳ ";

/** How many steps the Working box shows. */
const BOX_STEPS = 3;

/** "2 builders working: fix the parser, add tests": the first line of each goal, short, the first few named.
 * Running reviewers come first: "1 reviewer, 2 builders working: ...". */
export function buildersLine(goals: readonly string[], reviewers = 0): string | undefined {
  if (!goals.length && !reviewers) return undefined;
  const who = [...(reviewers ? [`${reviewers} reviewer${reviewers === 1 ? "" : "s"}`] : []), ...(goals.length ? [`${goals.length} builder${goals.length === 1 ? "" : "s"}`] : [])].join(", ");
  const short = goals.slice(0, 3).map(goal => {
    const first = (goal.split("\n").find(line => line.trim()) ?? "").trim();
    return first.length > 40 ? `${first.slice(0, 39)}…` : first;
  }).filter(Boolean);
  const more = goals.length > 3 ? ` +${goals.length - 3} more` : "";
  return `${who} working${short.length ? `: ${short.join(", ")}` : ""}${more}`;
}

/** One line for a finished group of steps: "✓ 14 edits · 6 commands · 38s", or "• 14 edits · 6 commands · 1 failed · 38s"
 * (never a green ✓ over a failure). */
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
  return `${failed ? "•" : "✓"} ${parts.join(" · ")}`;
}

/** Renders runtime events onto the terminal. On the rich terminal the main screen keeps the model's words,
 * questions and receipts: tool calls live in the Working box (the last few steps, updated in place) and fold
 * into one summary line when the model moves on. The plain terminal prints one line per finished tool (and a start
 * line for a command still running after a moment).
 * Extraction-safe: everything here is rendering, not orchestration. */
export class RuntimeEventView {
  private readonly toolStarted = new Map<string, number>();
  /** Plain terminal: the start line a still-running command prints after a moment, by call id. */
  private readonly slowStarts = new Map<string, ReturnType<typeof setTimeout>>();
  private steps: Step[] = [];
  /** What the model is doing now ("Waiting for …", "Reasoning"), under the steps in the Working box. */
  private status?: string;
  private responseActivity?: string;
  private responseStartedAt?: number;
  /** When the model or provider last said anything (a response starting, reasoning or a tool call being prepared). */
  private heardAt?: number;
  private waitingFor = "model response";
  private readonly checks = new Map<number, RunningCheck>();
  private checkSeq = 0;
  private checkTitle?: string;
  private activityTimer?: NodeJS.Timeout;
  private stepTimer?: NodeJS.Timeout;
  private endedWithNewline = true;
  private displayedError?: string;
  private expanded?: ExpandedStep;
  /** Folders outside the project the model looked in: said once each, when its turn ends. */
  private readonly outsideFolders = new Set<string>();
  private outsideToSay: string[] = [];

  constructor(private readonly terminal: InteractiveTerminal, private readonly output: OutputWriter,
    private readonly callbacks: RuntimeEventCallbacks) {}

  /** A read, ls, find or grep outside the project (temp aside) is remembered by folder. The step folds into the
   * turn's summary like any other, so where the model looked would otherwise go unseen. Commands are not parsed. */
  private noteOutsideRead(event: ToolEnd): void {
    const root = this.callbacks.projectRoot?.();
    const target = event.input?.path;
    if (!root || stepKind(event.toolName) !== "read" || typeof target !== "string" || !target) return;
    const home = this.callbacks.homeDir?.() ?? os.homedir();
    const absolute = path.resolve(root, target.startsWith("~/") ? path.join(home, target.slice(2)) : target);
    const within = (base: string) => { const relative = path.relative(base, absolute); return relative === "" || !isOutside(relative); };
    if (within(root) || [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"].some(within)) return;
    const folder = event.toolName === "read" ? path.dirname(absolute) : absolute;
    if (this.outsideFolders.has(folder)) return;
    this.outsideFolders.add(folder);
    this.outsideToSay.push(tildePath(folder, home));
  }

  /** One line under the turn's steps, at every display level: it is about where the AI looked, not a step. */
  private sayOutsideReads(): void {
    if (!this.outsideToSay.length) return;
    this.output.write(`[read] outside this project: ${this.outsideToSay.map(terminalText).join(", ")}\n`);
    this.outsideToSay = [];
    this.endedWithNewline = true;
  }

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
    const now = performance.now();
    const shown = this.steps.slice(-BOX_STEPS);
    const lines = shown.flatMap(step => {
      if (step.endedAt !== undefined || !step.start) return [step.line];
      // Still running: after 10 s say for how long, and for a command show the last line it printed.
      const suffix = runningElapsed(now - step.startedAt);
      const head = suffix ? `${formatToolActivity(step.start, undefined, this.fit(4 + suffix.length))}${suffix}` : step.line;
      const width = this.terminal.columns ? Math.max(10, this.terminal.columns - 8) : 80;
      const tail = step.tail && this.level() !== "quiet" ? lastOutputLine(step.tail, width) : "";
      return tail ? [head, `${TAIL_MARK}${tail}`] : [head];
    });
    // Checks Casper runs itself: a line each once they have run 10 s, with the last line they printed.
    for (const check of [...this.checks.values()].slice(0, BOX_CHECKS)) {
      const suffix = runningElapsed(now - check.startedAt);
      if (!suffix) continue;
      const width = this.terminal.columns ? Math.max(10, this.terminal.columns - 8) : 80;
      lines.push(`${lastOutputLine(check.name, width - suffix.length)}${suffix}`);
      const tail = check.tail ? lastOutputLine(check.tail, width) : "";
      if (tail) lines.push(`${TAIL_MARK}${tail}`);
    }
    // The elapsed time moves on its own: redraw once a second while a step or a check runs, never otherwise.
    const running = this.checks.size > 0 || this.steps.some(step => step.endedAt === undefined && step.start);
    if (running && !this.stepTimer) {
      this.stepTimer = setInterval(() => this.renderBox(), 1000);
      this.stepTimer.unref?.();
    } else if (!running && this.stepTimer) this.stopStepTimer();
    const builders = buildersLine(this.callbacks.builderGoals?.() ?? [], this.callbacks.reviewerCount?.() ?? 0);
    if (builders) lines.push(builders);
    if (this.status) lines.push(this.status);
    this.terminal.setActivity(lines.length ? lines : undefined);
  }

  private stopStepTimer(): void {
    if (this.stepTimer) clearInterval(this.stepTimer);
    this.stepTimer = undefined;
  }

  /** A builder started, ended or spent more: redraw the box so its line is current. */
  refreshBuilders(): void { this.renderBox(); }

  /** Names the checks that start next ("tests written from the request alone"); undefined: their own names. */
  labelChecks(label?: string): void { this.checkTitle = label; }

  /** A check Casper runs itself starts: returns what to tell about it, or nothing when no line is wanted. */
  watchCheck(name: string): CheckProgressRun | undefined {
    const level = this.level();
    const title = this.checkTitle ?? name;
    const id = ++this.checkSeq;
    const entry: RunningCheck = { name: title, startedAt: performance.now() };
    if (this.terminal.rich) {
      if (level === "quiet") return undefined;
      this.checks.set(id, entry);
      this.renderBox();
    } else {
      if (level === "quiet" || this.callbacks.announceLongChecks?.() === false) return undefined;
      this.checks.set(id, entry);
      let minutes = 0;
      entry.minutes = setInterval(() => {
        minutes++;
        // Never print into the middle of a numbered question; the next minute's line says it.
        if (this.terminal.questionOpen) return;
        this.terminal.endAssistant();
        this.ensureLineBreak();
        this.output.write(`[checks] ${terminalText(title)} still running · ${minutes}m\n`);
        this.endedWithNewline = true;
      }, PLAIN_CHECK_EVERY_MS);
      entry.minutes.unref?.();
    }
    return {
      update: (text) => { entry.tail = lastOutputLine(text, 300); if (this.terminal.rich) this.renderBox(); },
      end: () => {
        if (entry.minutes) clearInterval(entry.minutes);
        if (this.checks.delete(id) && this.terminal.rich) this.renderBox();
      },
    };
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
    // Nothing heard for 10 s: say plainly what Casper is waiting for, counting from the last word.
    const silent = this.heardAt === undefined ? 0 : performance.now() - this.heardAt;
    if (runningElapsed(silent)) { this.status = `Waiting for ${this.waitingFor}${runningElapsed(silent)}`; this.renderBox(); return; }
    const elapsed = minutes ? `${minutes}m${String(seconds % 60).padStart(2, "0")}s` : `${seconds}s`;
    this.status = `${this.responseActivity} · ${elapsed}`;
    this.renderBox();
  }

  private clearResponseActivity(): void {
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = undefined; this.responseActivity = undefined; this.responseStartedAt = undefined; this.heardAt = undefined;
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
    const level = this.level();
    if (level === "detailed") {
      for (const step of ran) this.output.write(`${this.withDiff(step.printed!, step.diff)}\n`);
      if (ran.length > 1) this.output.write(`${stepSummary(ran)}\n`);
    } else if (level === "quiet") {
      for (const step of ran) if (step.failed && !step.retried) this.output.write(`${step.printed}\n`);
    } else if (ran.length === 1 && !ran[0]!.retried) this.output.write(`${ran[0]!.printed}\n`);
    else if (ran.length) {
      for (const step of ran) if (step.failed && !step.retried) this.output.write(`${step.printed}\n`);
      this.output.write(`${stepSummary(ran)}\n`);
      // The files the folded edits changed, so a wrong one is easy to spot as it happens.
      const changed = [...new Set(ran.filter(step => step.kind === "edit" && !step.failed && step.path !== undefined)
        .map(step => displayPath(step.path!, this.fit())))];
      if (changed.length) {
        const shown = changed.slice(0, 5).join(", ");
        this.output.write(`  changed ${redactPreview(shown)}${changed.length > 5 ? ` +${changed.length - 5} more` : ""}\n`);
      }
    }
    this.endedWithNewline = true;
    this.renderBox();
  }

  private level(): DisplayLevel { return this.callbacks.display?.() ?? "normal"; }

  /** A step's line with its small diff under it (the detailed display). */
  private withDiff(line: string, diff?: string): string {
    return diff ? [line, ...inlineDiff(diff)].join("\n") : line;
  }

  /** A provider error: its cause and next step in plain words when Casper can name it, else the provider's text.
   * The provider's own words stay one key away (ctrl+t), or on the next line where there is no ctrl+t. */
  private writeError(message: string): void {
    const explained = explainModelError(message);
    if (!explained) { this.output.write(`[error] ${redactPreview(message)}\n`); return; }
    if (this.terminal.rich) {
      this.expanded = { title: "Provider error", body: redactPreview(message), diff: false };
      this.output.write(`[error] ${explained.line} Ctrl+T shows the provider's message.\n`);
    } else this.output.write(`[error] ${explained.line}\n  provider: ${redactPreview(message)}\n`);
  }

  /** An error thrown to the prompt loop: a model error gets the same plain cause line as a provider error event;
   * any other error (a command's usage line) is shown as it is. */
  showError(message: string): void {
    if (explainModelError(message)) this.writeError(message);
    else this.output.write(`[error] ${message}\n`);
    this.displayedError = message;
  }

  /** ctrl+t: the last finished step in full, or undefined before the first one. */
  lastStep(): ExpandedStep | undefined { return this.expanded; }

  /** The receipt is next: fold what finished, and the Working box goes away whatever arrives late. */
  reset(): void {
    this.fold();
    this.steps = [];
    this.stopStepTimer();
    for (const check of this.checks.values()) if (check.minutes) clearInterval(check.minutes);
    this.checks.clear(); this.checkTitle = undefined;
    this.clearResponseActivity();
    this.status = undefined;
    this.toolStarted.clear();
    for (const id of [...this.slowStarts.keys()]) this.clearSlowStart(id);
    this.terminal.setActivity(undefined);
  }

  private clearSlowStart(id: string): void {
    const timer = this.slowStarts.get(id);
    if (timer) { clearTimeout(timer); this.slowStarts.delete(id); }
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
        this.waitingFor = model || "model response";
        this.heardAt = performance.now();
        this.setResponseActivity(`Waiting for ${this.waitingFor}`);
        break;
      }
      case "assistant_progress": {
        if (!this.terminal.rich) break;
        // Some providers deliver tool arguments whole; the box then says what is being prepared.
        const size = event.chars === 0 ? "" : event.chars >= 1024 ? ` · ${(event.chars / 1024).toFixed(1)}k chars` : ` · ${event.chars} chars`;
        this.heardAt = performance.now();
        const what = event.kind === "thinking" ? "Reasoning" : `Preparing ${terminalText(event.toolName ?? "tool call")}`;
        this.setResponseActivity(`${what}${size}`);
        break;
      }
      case "retry": {
        // Pi tries the provider again by itself: say so now, instead of an error that looks final and a blank pause.
        this.terminal.endAssistant();
        this.ensureLineBreak();
        const provider = terminalText(event.provider ?? "the model provider");
        const wait = `${Math.max(1, Math.ceil(event.delayMs / 1000))}s`;
        this.output.write(`… Can't reach ${provider} · trying again in ${wait} (${event.attempt} of ${event.maxAttempts})${this.terminal.rich ? " · Esc stops" : ""}\n`);
        this.setStaticActivity(`Retrying ${provider} · attempt ${event.attempt} of ${event.maxAttempts}`);
        this.endedWithNewline = true;
        break;
      }
      case "assistant_response_end": {
        // A failed attempt that will be retried is not the outcome; the retry line says what happens next.
        if (event.retrying) { this.terminal.endAssistant(); break; }
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
          this.writeError(event.errorMessage);
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
        if (!this.terminal.rich) {
          // The plain terminal prints the end line only. It has no status line, so a call that may take a while
          // (a command, a check, an MCP or browser call) and is still running after a moment says it started,
          // or a long test run looks hung; a quick one still gets its end line alone.
          const kind = stepKind(event.toolName);
          if (event.toolCallId && kind !== "edit" && kind !== "read" && !["web_search", "web_fetch"].includes(event.toolName)) {
            const line = `${BUSY_GLYPH} ${formatToolActivity(event, undefined, this.fit()).replace(/^• /, "")}\n`;
            // The call starts before Casper's own questions about it ("Reach <host>?", a write outside the project).
            // A question shown since then already named the command, and an open one is being answered: no line.
            const asked = this.terminal.questionsShown ?? 0;
            const timer = setTimeout(() => {
              this.slowStarts.delete(event.toolCallId!);
              if (this.terminal.questionOpen || (this.terminal.questionsShown ?? 0) !== asked) return;
              this.terminal.endAssistant();
              this.ensureLineBreak();
              this.output.write(line);
              this.endedWithNewline = true;
            }, PLAIN_START_AFTER_MS);
            timer.unref?.();
            this.slowStarts.set(event.toolCallId, timer);
          }
          break;
        }
        this.terminal.endAssistant();
        // A failed edit followed at once by another edit of the same file was retried: count it, don't print it.
        const last = this.steps.at(-1);
        const path = typeof event.input?.path === "string" ? event.input.path : undefined;
        if (last?.failed && last.kind === "edit" && stepKind(event.toolName) === "edit" && path !== undefined && last.path === path) last.retried = true;
        this.steps.push({ ...(event.toolCallId ? { id: event.toolCallId } : {}), toolName: event.toolName, kind: stepKind(event.toolName),
          ...(path !== undefined ? { path } : {}), start: event, startedAt: performance.now(), line: formatToolActivity(event, undefined, this.fit(4)) });
        this.clearResponseActivity(); this.status = undefined;
        this.renderBox();
        break;
      }
      case "tool_progress": {
        // Rich terminal only, bash only, never in quiet: the plain terminal and --json get no extra lines.
        if (!this.terminal.rich || event.toolName !== "bash" || this.level() === "quiet") break;
        const step = this.steps.find(candidate => candidate.endedAt === undefined && (event.toolCallId ? candidate.id === event.toolCallId : candidate.toolName === event.toolName));
        if (!step) break;
        step.tail = event.text;
        this.renderBox();
        break;
      }
      case "tool_end": {
        this.callbacks.onToolEnd(event);
        this.noteOutsideRead(event);
        const started = event.toolCallId ? this.toolStarted.get(event.toolCallId) : undefined;
        if (event.toolCallId) { this.toolStarted.delete(event.toolCallId); this.clearSlowStart(event.toolCallId); }
        const elapsed = started === undefined ? undefined : performance.now() - started;
        // A failed casper_check already printed its formatted result line; its JSON payload is for the model.
        // A finished one keeps its payload: it is never printed, but a skip reads it to show "— skipped".
        const shown: ToolEnd = event.toolName === "casper_check" && event.isError ? { ...event, output: undefined } : event;
        // Stopped at the spend limit before it ran: not a failure, and the model's instruction is not for the screen.
        // Refused by Casper before it ran (a private place, another machine, your No): not a failure either.
        const spendStop = event.isError && event.output?.text?.trim() === SPEND_STOP_REASON;
        const refusal = event.isError && !spendStop ? refusalForScreen(event.output?.text ?? "") : undefined;
        const notRun = spendStop || refusal !== undefined;
        const suffix = spendStop ? NOT_RUN : REFUSED;
        const endLine = (inset: number, detail: boolean) => notRun
          ? `${formatToolActivity({ type: "tool_start", toolName: event.toolName, ...(event.input ? { input: event.input } : {}) }, undefined, this.fit(inset + suffix.length))}${suffix}`
            + (detail && refusal ? `\n  ${redactPreview(refusal).slice(0, 240)}` : "")
          : formatToolActivity(detail ? shown : { ...shown, output: undefined }, elapsed, this.fit(inset));
        const label = formatToolActivity({ type: "tool_start", toolName: event.toolName, ...(event.input ? { input: event.input } : {}) }, undefined, this.fit()).replace(/^• /, "");
        this.expanded = event.diff && !event.isError ? { title: label, body: event.diff, diff: true }
          : { title: `${label}${notRun ? " · not run" : event.isError ? " · failed" : ""}`, body: (refusal ?? event.output?.text ?? "").replace(/\n$/, "") || "(no output text)", diff: false };
        if (!this.terminal.rich) {
          // quiet: only what went wrong (or never ran); detailed: each edit's small diff under its line.
          if (this.level() === "quiet" && !event.isError) break;
          this.terminal.endAssistant();
          this.ensureLineBreak();
          this.output.write(`${this.level() === "detailed" ? this.withDiff(endLine(0, true), event.isError ? undefined : event.diff) : endLine(0, true)}\n`);
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
        if (event.diff && !event.isError) step.diff = event.diff;
        this.renderBox();
        break;
      }
      case "message_end":
        this.setStaticActivity();
        this.terminal.endAssistant();
        this.fold();
        this.toolStarted.clear();
        this.ensureLineBreak();
        this.sayOutsideReads();
        break;
      case "notice":
        this.terminal.endAssistant();
        this.ensureLineBreak();
        this.output.write(`${event.message}\n`);
        this.endedWithNewline = true;
        break;
      case "turn_limit":
        this.callbacks.turnLimitReached(event.turns);
        break;
      case "error":
        this.callbacks.markRuntimeFailed();
        this.setStaticActivity();
        this.terminal.endAssistant();
        this.ensureLineBreak();
        if (this.displayedError !== event.message && !this.callbacks.cancelled()) this.writeError(event.message);
        this.displayedError = event.message;
        this.endedWithNewline = true;
        break;
    }
  }
}

/** One helper line for the steps pane: "helper explorer: find the login code", "helper explorer · ✓ read · src/app.ts". */
export function helperActivityLine(activity: HelperActivity, root?: string): string {
  const who = `helper ${activity.run.role}`;
  if (activity.kind === "start") return `${who} started: ${redactPreview(activity.run.goal).replace(/\s+/g, " ").slice(0, 100)}`;
  if (activity.kind === "usage") return `${who} · ${(activity.run.spent?.tokens ?? 0).toLocaleString("en-US")} tokens so far`;
  if (activity.kind === "end") return `${who} ${activity.status === "completed" ? "finished" : `stopped (${activity.status.replace("_", " ")})`}`;
  return `${who} · ${formatToolActivity(activity.event.type === "tool_end" ? { ...activity.event, output: undefined } : activity.event, undefined, root ? { root } : {})}`;
}
