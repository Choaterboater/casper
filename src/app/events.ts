import type { InteractiveTerminal } from "../tui/terminal";
import { BUSY_GLYPH, commandLabel, formatDuration, formatElapsed, formatToolActivity, lastOutputLine, NOT_RUN_GLYPH, NOTE_GLYPH, redactPreview, runningElapsed, terminalText, toolTarget } from "../tui/format";
import type { RuntimeEvent } from "../runtime/types";
import type { OutputWriter } from "./commands";
import { SPEND_STOP_REASON } from "../task/spend";
import type { HelperActivity } from "../agents/manager";
import { inlineDiff, type DisplayLevel } from "../tui/display";
import { planFold, stepKind, type StepKind } from "./fold";
import os from "node:os";
import path from "node:path";
import { tildePath } from "../new/scaffold";
import { isOutside } from "../platform/inside";
import { explainModelError } from "../runtime/model-errors";
import { ToolCallTags } from "../task/text-tool-call";
import type { CheckProgressRun } from "../verify/progress";
import { foundNothing, plainSteps } from "./plain-steps";
import type { ProjectCommand } from "../project/model";
import { checkName, expectsTestFailure, githubLabel, outcomeNote, recoveredBy, recoveryKind, runningCheck, type RecoveryKind } from "../tui/tool-status";

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
  /** The project's own commands, so the plain steps say "Ran the tests" for its test command. */
  projectCommands?(): Partial<Record<ProjectCommand, string>> | undefined;
  /** Plain terminal: say once a minute that a long check still runs. Unset: yes. (`--json` says no.) */
  announceLongChecks?(): boolean;
}

/** A check Casper itself is running, for the live rows (rich) or the once-a-minute line (plain). */
interface RunningCheck { name: string; startedAt: number; tail?: string; minutes?: ReturnType<typeof setInterval> }

/** A plain terminal says a check still runs this often. */
export const PLAIN_CHECK_EVERY_MS = 60_000;
/** How many running checks the live rows list. */
const BOX_CHECKS = 3;

/** The last finished step in full, for ctrl+t: an edit's whole diff, or what a tool printed. */
export interface ExpandedStep { title: string; body: string; diff: boolean }

type ToolStart = Extract<RuntimeEvent, { type: "tool_start" }>;
type ToolEnd = Extract<RuntimeEvent, { type: "tool_end" }>;

/** One tool call on the rich terminal: a live row under the AI's words while the model works, then folded. */
interface Step {
  id?: string;
  toolName: string;
  kind: StepKind;
  path?: string;
  input?: ToolStart["input"];
  startedAt: number;
  endedAt?: number;
  /** The start event, to redraw the running line with its elapsed time. */
  start?: ToolStart;
  /** The last line of a running command's output so far (rich terminal, not quiet). */
  tail?: string;
  /** Its live row (running, then finished). */
  line: string;
  /** The finished line as the detailed level and a not-run step show it, with a reason under it. */
  printed?: string;
  /** The finished line alone, a failure box's title. */
  title?: string;
  /** What a failed step printed, for its box. */
  output?: string;
  /** What Ctrl+T shows for it in full. */
  expanded?: ExpandedStep;
  /** An edit's size and diff, for the edit box. */
  lines?: { added: number; removed: number };
  diff?: string;
  failed?: boolean;
  note?: string;
  /** Keep recoverable failures out of the transcript until a retry succeeds or the turn ends. */
  recovery?: RecoveryKind;
  /** A timeout or busy service the next call of the same tool did not retry: the next fold shows it. */
  heldOnce?: boolean;
  /** A failed edit the model tried again at once: counted, not printed. */
  retried?: boolean;
  /** Casper stopped it before it ran (the spend limit, or a refusal): printed as not run, never counted as a step. */
  notRun?: boolean;
  /** A search or listing that found nothing. */
  empty?: boolean;
}

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

/** What went wrong before a retry, in the words of its cause: one of OpenRouter's hosts failing is not "can't reach". */
export function retryCause(provider: string, errorMessage = ""): string {
  if (/\bupstream error\b/i.test(errorMessage)) return `${provider}'s host for this model failed`;
  const cause = explainModelError(errorMessage)?.cause;
  if (cause === "rate") return `${provider} is busy`;
  if (cause === "offline" || !errorMessage.trim()) return `Can't reach ${provider}`;
  return `${provider} answered with an error`;
}

/** Plain terminal: a command still running after this long prints its start line. */
export const PLAIN_START_AFTER_MS = 2000;

/** Starts the live row that shows a running command's latest output (the surface draws it dim). */
export const TAIL_MARK = "↳ ";

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

/** What a running step is doing, for the status row: "Running bun test", "Reading src/x.ts", "web_fetch docs.x.com". */
function doing(step: Step, fit: { root?: string }, commands?: Partial<Record<ProjectCommand, string>>): string {
  const human = runningCheck(step.input, commands) ?? githubLabel(step.input, "", true);
  if (human && (step.kind === "command" || step.toolName === "casper_check")) return redactPreview(human).replace(/\s+/g, " ");
  if (step.toolName === "delegate") return "Delegating · helper working";
  if (step.toolName === "crew") return "Delegating · Builder 1 working";
  const target = toolTarget(step.input, fit, command => commandLabel(redactPreview(command), 60).replace(/ …$/, ""));
  const what = target ? redactPreview(String(target)).replace(/\s+/g, " ").slice(0, 80) : "";
  if (step.kind === "command") return what ? `Running ${what}` : "Running a command";
  if (step.toolName === "read") return what ? `Reading ${what}` : "Reading";
  if (step.kind === "edit") return what ? `Editing ${what}` : "Editing";
  if (step.toolName === "grep" || step.toolName === "find") return what ? `Searching ${what}` : "Searching";
  return `${terminalText(step.toolName).slice(0, 40)}${what ? ` ${what}` : ""}`;
}

/** Renders runtime events onto the terminal. On the rich terminal the main screen keeps the model's words,
 * questions and receipts: tool calls show as live rows under the AI's words (updated in place, with one status row
 * above the prompt), and fold into one row naming what was done, with edits and failures in boxes, when the model's
 * next words arrive. The plain terminal prints one line per finished tool (and a start line for a command still running
 * after a moment).
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
  /** The AI's words are on screen now (their message is open): a blank delta then is part of them. */
  private speaking = false;
  /** A tool-call tag a model wrote as words is not shown (src/task/text-tool-call.ts). */
  private toolTags = new ToolCallTags();
  private activityTimer?: NodeJS.Timeout;
  private stepTimer?: NodeJS.Timeout;
  private endedWithNewline = true;
  private displayedError?: string;
  private expanded?: ExpandedStep;
  /** Folders outside the project the model looked in: said once each, when its turn ends. */
  private readonly outsideFolders = new Set<string>();
  private outsideToSay: string[] = [];
  private assistantWords = "";
  private testFirst = false;

  constructor(private readonly terminal: InteractiveTerminal, private readonly output: OutputWriter,
    private readonly callbacks: RuntimeEventCallbacks) {}

  /** A task clock pauses during interactive questions; no wait is charged to a command or response. */
  private now(): number { return performance.now() - (this.terminal.waitedMs ?? 0); }

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

    this.terminal.writePrompt(prompt);
    this.endedWithNewline = true;
  }

  /** The work in progress: every step of the open group as a live row (with a running command's latest output), the
   * checks Casper runs itself, the builders working, and the status row's words. */
  private planProgress?: string;
  setPlanProgress(line?: string): void { this.planProgress = line; this.renderBox(); }

  private renderBox(): void {
    if (!this.terminal.rich) return;
    const now = this.now();
    const width = this.terminal.columns ? Math.max(10, this.terminal.columns - 8) : 80;
    const tailRow = (step: Step) => step.tail && this.level() !== "quiet" ? `${TAIL_MARK}${lastOutputLine(step.tail, width)}` : undefined;
    // The raw steps (Ctrl+O, and the steps pane): every call on its own row.
    const lines = this.steps.flatMap(step => {
      if (step.endedAt !== undefined || !step.start) return [step.line];
      // Still running: after 10 s say for how long, and for a command show the last line it printed.
      const suffix = runningElapsed(now - step.startedAt);
      const head = suffix ? `${formatToolActivity(step.start, undefined, this.fit(2 + suffix.length))}${suffix}` : step.line;
      const tail = tailRow(step);
      return tail ? [head, tail] : [head];
    });
    // The plain steps, shown by default: what the AI looked through on one line, edits and commands in plain words.
    const plain = plainSteps(this.steps.map(step => {
      const tail = step.endedAt === undefined ? tailRow(step) : undefined;
      return { ...step, ...(tail ? { tailRow: tail } : {}) };
    }), now, { fit: this.fit(2), commands: this.callbacks.projectCommands?.() ?? {} });
    const extra: string[] = this.planProgress ? [terminalText(this.planProgress)] : [];
    // Checks Casper runs itself: a line each once they have run 10 s, with the last line they printed.
    for (const check of [...this.checks.values()].slice(0, BOX_CHECKS)) {
      const suffix = runningElapsed(now - check.startedAt);
      if (!suffix) continue;
      extra.push(`${BUSY_GLYPH} ${lastOutputLine(check.name, width - suffix.length - 2)}${suffix}`);
      const tail = check.tail ? lastOutputLine(check.tail, width) : "";
      if (tail) extra.push(`${TAIL_MARK}${tail}`);
    }
    // The elapsed time moves on its own: redraw once a second while a step or a check runs, never otherwise.
    const running = this.checks.size > 0 || this.steps.some(step => step.endedAt === undefined && step.start);
    if (running && !this.stepTimer) {
      this.stepTimer = setInterval(() => this.renderBox(), 1000);
      this.stepTimer.unref?.();
    } else if (!running && this.stepTimer) this.stopStepTimer();
    const builders = buildersLine(this.callbacks.builderGoals?.() ?? [], this.callbacks.reviewerCount?.() ?? 0);
    if (builders) extra.push(builders);
    lines.push(...extra);
    plain.push(...extra);
    const status = this.statusText(now, builders);
    this.terminal.setWork(lines.length || status ? { rows: lines, plain, ...(status ? { status } : {}) } : undefined);
  }

  /** The status row's words: what the model is doing or what Casper waits for, else the newest running step (and how
   * many more run), else a check Casper runs, else the builders. */
  private statusText(now: number, builders?: string): string | undefined {
    if (this.status) return this.status;
    const running = this.steps.filter(step => step.endedAt === undefined && step.start);
    const newest = running.at(-1);
    if (newest) {
      const goals = this.callbacks.builderGoals?.() ?? [];
      const activity = newest.toolName === "delegate" && goals.length
        ? `Delegating · ${goals.map((_, index) => `Builder ${index + 1}`).join(", ")} working`
        : doing(newest, this.fit(), this.callbacks.projectCommands?.());
      return `${activity} · ${formatElapsed(now - newest.startedAt)}${running.length > 1 ? ` (+${running.length - 1} more)` : ""}`;
    }
    const check = [...this.checks.values()][0];
    if (check) return `Running ${lastOutputLine(check.name, 60)} · ${formatElapsed(now - check.startedAt)}`;
    if (builders) {
      const goals = this.callbacks.builderGoals?.() ?? [];
      return goals.length ? `Delegating · ${goals.map((_, index) => `Builder ${index + 1}`).join(", ")} working` : `Delegating · ${builders}`;
    }
    return this.steps.length ? "Working" : undefined;
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
    const title = this.checkTitle ?? checkName(name);
    const id = ++this.checkSeq;
    const entry: RunningCheck = { name: title, startedAt: this.now() };
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
        this.endSpeech();
        this.ensureLineBreak();
        this.output.write(`[checks] ${terminalText(title)} still running · ${minutes}m${entry.tail ? ` · ${lastOutputLine(entry.tail, 200)}` : ""}\n`);
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
    this.responseStartedAt ??= this.now();
    this.renderResponseActivity();
    if (!this.activityTimer) {
      this.activityTimer = setInterval(() => this.renderResponseActivity(), 1000);
      this.activityTimer.unref();
    }
  }

  private renderResponseActivity(): void {
    if (!this.responseActivity || this.responseStartedAt === undefined) return;
    // Nothing heard for 10 s: say plainly what Casper is waiting for, counting from the last word.
    const silent = this.heardAt === undefined ? 0 : this.now() - this.heardAt;
    if (runningElapsed(silent)) { this.status = `Waiting for ${this.waitingFor}${runningElapsed(silent)}`; this.renderBox(); return; }
    this.status = `${this.responseActivity} · ${formatElapsed(this.now() - this.responseStartedAt)}`;
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

  /** The model moved on: the finished steps leave the live rows and fold under its words (see planFold): one row naming
   * what went well, the edits in a box, each failure in a box. Ctrl+T then shows the last box in full. */
  private fold(final = false): void {
    const done = this.steps.filter(step => step.endedAt !== undefined && (final || !step.recovery || step.heldOnce));
    if (!done.length) return;
    this.steps = this.steps.filter(step => !done.includes(step));
    this.endSpeech();
    this.ensureLineBreak();
    if (!this.terminal.rich) {
      for (const step of done) this.output.write(`${step.printed ?? step.line}\n`);
      this.endedWithNewline = true;
      return;
    }
    const fit = this.fit();
    const fold = planFold(done.map(step => ({
      toolName: step.toolName, kind: step.kind, printed: step.printed ?? step.line, title: step.title ?? step.line,
      ...(step.input ? { input: step.input } : {}), ...(step.path !== undefined ? { path: step.path } : {}),
      ...(step.endedAt !== undefined ? { elapsedMs: step.endedAt - step.startedAt } : {}),
      ...(step.failed ? { failed: true } : {}), ...(step.retried ? { retried: true } : {}), ...(step.notRun || step.note ? { notRun: true } : {}),
      ...(step.output ? { output: step.output } : {}), ...(step.lines ? { lines: step.lines } : {}), ...(step.diff ? { diff: step.diff } : {}),
    })), this.level(), { ...fit, home: this.callbacks.homeDir?.() ?? os.homedir() });
    if (fold.parts.length || fold.lines.length || fold.edits.length || fold.failures.length) this.terminal.writeFold(fold);
    // Ctrl+T shows the last box in full: the group's whole diff, or what the failed step printed.
    const failed = done.filter(step => step.failed && !step.retried && step.expanded).at(-1);
    const patches = done.filter(step => !step.failed && step.diff).map(step => step.diff!);
    if (failed) this.expanded = failed.expanded;
    else if (patches.length > 1) this.expanded = { title: `Edited ${new Set(fold.edits.map(edit => edit.path)).size} files`, body: patches.join("\n"), diff: true };
    this.endedWithNewline = true;
    this.renderBox();
  }

  private level(): DisplayLevel { return this.callbacks.display?.() ?? "normal"; }

  /** A step's line with its small diff under it (the plain terminal's detailed display). */
  private withDiff(line: string, diff?: string): string {
    return diff ? [line, ...inlineDiff(diff)].join("\n") : line;
  }

  /** The AI's words end here (a step, a notice, the end of the turn). */
  private endSpeech(): void { this.speaking = false; this.terminal.endAssistant(); }

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

  /** What ctrl+t shows next, set by Casper itself (the plan's cases and details). */
  showOnExpand(step: ExpandedStep): void { this.expanded = step; }

  /** While set, the model's words are kept off the screen (Casper shows them its own way after the turn) and the
   * Working box says this instead. */
  holdText(activity: string | undefined): void { this.heldText = activity; if (activity) this.held = ""; }
  private heldText?: string;
  private held = "";
  /** Everything the model wrote while its words were held, every response of the turn and a cut-off one included. */
  heldWords(): string { return this.held; }

  /** The receipt is next: fold what finished, and the Working box goes away whatever arrives late. */
  reset(): void {
    this.fold(true);
    this.assistantWords = ""; this.testFirst = false;
    this.steps = [];
    this.stopStepTimer();
    for (const check of this.checks.values()) if (check.minutes) clearInterval(check.minutes);
    this.checks.clear(); this.checkTitle = undefined;
    this.clearResponseActivity();
    this.status = undefined;
    this.speaking = false;
    this.toolStarted.clear();
    for (const id of [...this.slowStarts.keys()]) this.clearSlowStart(id);
    this.terminal.setWork(undefined);
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
        this.endSpeech();
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
      case "assistant_request_start":
      case "assistant_response_start": {
        const model = [event.provider, event.model].filter((part): part is string => Boolean(part)).map(terminalText).join("/");
        const waiting = `Waiting for ${model || "model response"}`;
        // The request went out before the answer started: the wait goes on, so its time keeps counting.
        const same = event.type === "assistant_response_start" && this.responseActivity === waiting;
        if (!same) this.clearResponseActivity();
        this.waitingFor = model || "model response";
        this.heardAt = this.now();
        this.setResponseActivity(waiting);
        break;
      }
      case "assistant_progress": {
        if (!this.terminal.rich) break;
        // Some providers deliver tool arguments whole; the box then says what is being prepared.
        const size = event.chars === 0 ? "" : event.chars >= 1024 ? ` · ${(event.chars / 1024).toFixed(1)}k chars` : ` · ${event.chars} chars`;
        this.heardAt = this.now();
        const what = event.kind === "thinking" ? "Reasoning" : `Preparing ${terminalText(event.toolName ?? "tool call")}`;
        this.setResponseActivity(`${what}${size}`);
        break;
      }
      case "retry": {
        // Pi tries the provider again by itself: say so now, instead of an error that looks final and a blank pause.
        this.endSpeech();
        this.ensureLineBreak();
        const provider = terminalText(event.provider ?? "the model provider");
        const wait = formatDuration(Math.max(1, Math.ceil(event.delayMs / 1000)) * 1000);
        this.output.write(`${NOTE_GLYPH} ${retryCause(provider, event.errorMessage)} · trying again in ${wait} (${event.attempt} of ${event.maxAttempts})${this.terminal.rich ? " · Esc stops" : ""}\n`);
        // Said once, by that line (in the warning colour): the Working box drops what it showed instead of repeating it.
        this.setStaticActivity();
        this.endedWithNewline = true;
        break;
      }
      case "assistant_response_end": {
        const rest = this.toolTags.end();
        if (rest && this.speaking) this.terminal.assistant(rest);
        // Held words of one response are kept apart from the next one's.
        if (this.heldText && this.held.trim() && !this.held.endsWith("\n\n")) this.held += this.held.endsWith("\n") ? "\n" : "\n\n";
        // A failed attempt that will be retried is not the outcome; the retry line says what happens next.
        if (event.retrying) { this.endSpeech(); break; }
        this.setStaticActivity(event.stopReason === "toolUse" ? "Starting tools…" : undefined);
        this.endSpeech();
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
        this.assistantWords = (this.assistantWords + event.delta).slice(-2000);
        // Explicit red-phase intent is scoped to the next command, and still needs a successful rerun.
        this.testFirst = expectsTestFailure(this.assistantWords);
        // Words Casper shows its own way once the turn ends (the plan screen): the status row says what is coming. They
        // are not on screen, so the steps keep gathering until words show or the turn ends.
        if (this.heldText) {
          this.held = (this.held + event.delta).slice(-65_536);
          this.heardAt = this.now();
          if (this.responseActivity !== this.heldText) { this.clearResponseActivity(); this.setResponseActivity(this.heldText); }
          break;
        }
        const delta = this.toolTags.push(event.delta);
        // Blank space before any words is not the AI moving on: the steps keep gathering in one group.
        if (!delta || (!this.speaking && !delta.trim())) break;
        // The model moved on: the finished steps fold into one row above its words.
        if (!this.speaking && this.steps.some(step => step.endedAt !== undefined)) this.fold();
        this.setStaticActivity();
        this.speaking = true;
        this.terminal.assistant(delta);
        this.endedWithNewline = true;
        break;
      case "tool_start": {
        if (event.toolCallId) this.toolStarted.set(event.toolCallId, this.now());
        if (!this.terminal.rich) {
          // The plain terminal prints the end line only. It has no status line, so a call that may take a while
          // (a command, a check, an MCP or browser call) and is still running after a moment says it started,
          // or a long test run looks hung; a quick one still gets its end line alone.
          const kind = stepKind(event.toolName);
          if (event.toolCallId && kind !== "edit" && kind !== "read" && !["web_search", "web_fetch"].includes(event.toolName)) {
            const line = `${formatToolActivity(event, undefined, this.fit())}\n`;
            // The call starts before Casper's own questions about it ("Reach <host>?", a write outside the project).
            // A question shown since then already named the command, and an open one is being answered: no line.
            const asked = this.terminal.questionsShown ?? 0;
            const timer = setTimeout(() => {
              this.slowStarts.delete(event.toolCallId!);
              if (this.terminal.questionOpen || (this.terminal.questionsShown ?? 0) !== asked) return;
              this.endSpeech();
              this.ensureLineBreak();
              this.output.write(line);
              this.endedWithNewline = true;
            }, PLAIN_START_AFTER_MS);
            timer.unref?.();
            this.slowStarts.set(event.toolCallId, timer);
          }
          break;
        }
        this.endSpeech();
        // A failed edit followed at once by another edit of the same file was retried: count it, don't print it.
        const last = this.steps.at(-1);
        const path = typeof event.input?.path === "string" ? event.input.path : undefined;
        if (last?.failed && last.kind === "edit" && stepKind(event.toolName) === "edit" && path !== undefined && last.path === path) last.retried = true;
        this.steps.push({ ...(event.toolCallId ? { id: event.toolCallId } : {}), toolName: event.toolName, kind: stepKind(event.toolName),
          ...(path !== undefined ? { path } : {}), ...(event.input ? { input: event.input } : {}), start: event, startedAt: this.now(),
          line: formatToolActivity(event, undefined, this.fit(2)) });
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
        const elapsed = started === undefined ? undefined : this.now() - started;
        // A failed casper_check already printed its formatted result line; its JSON payload is for the model.
        // A finished one keeps its payload: it is never printed, but a skip reads it to show "— skipped".
        const shown: ToolEnd = event.toolName === "casper_check" && event.isError ? { ...event, output: undefined } : event;
        // Stopped at the spend limit before it ran: not a failure, and the model's instruction is not for the screen.
        // Refused by Casper before it ran (a private place, another machine, your No): not a failure either.
        const spendStop = event.isError && event.output?.text?.trim() === SPEND_STOP_REASON;
        const refusal = event.isError && !spendStop ? refusalForScreen(event.output?.text ?? "") : undefined;
        const notRun = spendStop || refusal !== undefined;
        const note = outcomeNote(event);
        const recovery = !notRun && !note ? recoveryKind(event, this.testFirst, this.callbacks.projectCommands?.()) : undefined;
        if (stepKind(event.toolName) === "command" || event.toolName === "casper_check") {
          this.testFirst = false; this.assistantWords = "";
        }
        // Only a successful matching retry neutralizes these failures, never merely starting a retry.
        for (const previous of this.steps) {
          if (!previous.recovery || !recoveredBy(previous.recovery, previous, event)) continue;
          const reason = previous.recovery === "conflict" ? "conflicts resolved" : previous.recovery === "test-first" ? "expected test-first failure · rerun passed" : `${previous.recovery} · retry finished`;
          previous.failed = false; previous.recovery = undefined; previous.note = reason;
          previous.line = previous.printed = `${NOTE_GLYPH} ${commandLabel(redactPreview(previous.input?.command ?? previous.toolName), 60)} — ${reason}`;
        }
        // A timeout or busy service waits for its retry, which is the model's next call of that tool. When that call is
        // something else, the failure shows at the next fold. Held to the task's end, an ssh that timed out early in a
        // long task showed under its answer. A conflict or test-first failure takes several steps and waits on.
        for (const previous of this.steps) {
          if ((previous.recovery === "timeout" || previous.recovery === "service") && previous.endedAt !== undefined
            && previous.toolName === event.toolName && previous.id !== event.toolCallId) previous.heldOnce = true;
        }
        const suffix = spendStop ? NOT_RUN : REFUSED;
        // `timed`: with the step's time. The rich terminal's folded lines leave it out (the footer and box show time).
        // A designed refusal is a neutral one-line note, never a failure box.
        const endLine = (inset: number, detail: boolean, timed = true) => notRun
          ? `${NOTE_GLYPH}${formatToolActivity({ type: "tool_start", toolName: event.toolName, ...(event.input ? { input: event.input } : {}) }, undefined, this.fit(inset + suffix.length)).slice(BUSY_GLYPH.length)}${suffix}${refusal ? ` · ${redactPreview(refusal).slice(0, 180)}` : ""}`
          : formatToolActivity(note ? event : detail ? shown : { ...shown, output: undefined }, timed ? elapsed : undefined, this.fit(inset));
        const label = formatToolActivity({ type: "tool_start", toolName: event.toolName, ...(event.input ? { input: event.input } : {}) }, undefined, this.fit()).slice(BUSY_GLYPH.length + 1);
        this.expanded = event.diff && !event.isError ? { title: label, body: event.diff, diff: true }
          : { title: `${label}${notRun ? " · not run" : note ? ` · ${note}` : event.isError ? " · failed" : ""}`, body: (refusal ?? event.output?.text ?? "").replace(/\n$/, "") || "(no output text)", diff: false };
        if (!this.terminal.rich) {
          this.fold();
          if (recovery) {
            this.steps.push({ toolName: event.toolName, kind: stepKind(event.toolName), input: event.input, startedAt: started ?? this.now(), endedAt: this.now(),
              failed: true, recovery, line: endLine(0, true), printed: endLine(0, true) });
            break;
          }
          // quiet: only what went wrong (or never ran); detailed: each edit's small diff under its line.
          if (this.level() === "quiet" && !event.isError) break;
          this.endSpeech();
          this.ensureLineBreak();
          this.output.write(`${this.level() === "detailed" ? this.withDiff(endLine(0, true), event.isError ? undefined : event.diff) : endLine(0, true)}\n`);
          this.endedWithNewline = true;
          break;
        }
        let step = this.steps.find(candidate => candidate.endedAt === undefined && (event.toolCallId ? candidate.id === event.toolCallId : candidate.toolName === event.toolName));
        // The AI's question answered: its box stays in the transcript with the answer, so no "✓ ask" line as well.
        if (event.toolName === "ask" && !event.isError) {
          if (step) this.steps = this.steps.filter(candidate => candidate !== step);
          this.renderBox();
          break;
        }
        if (!step) {
          // It ended after its turn folded (or never said it started): it still shows until the next fold or receipt.
          step = { toolName: event.toolName, kind: stepKind(event.toolName), startedAt: this.now() - (elapsed ?? 0), line: "" };
          this.steps.push(step);
        }
        step.endedAt = this.now();
        step.failed = event.isError && !notRun && !note;
        if (note) step.note = note;
        if (recovery) step.recovery = recovery;
        step.empty = !event.isError && stepKind(event.toolName) === "read" && foundNothing(event.output?.text);
        step.printed = endLine(0, true, false);
        // Never ran, skipped or found nothing: keep its neutral line when the group folds.
        const skipped = !event.isError && step.printed.startsWith(NOT_RUN_GLYPH);
        if (notRun || skipped || note) step.notRun = true;
        step.line = endLine(2, skipped);
        step.title = endLine(0, false, false);
        if (event.input) step.input = event.input;
        if (step.failed && event.output?.text) step.output = event.output.text;
        step.expanded = this.expanded;
        if (event.lines && !event.isError) step.lines = event.lines;
        if (event.diff && !event.isError) step.diff = event.diff;
        this.renderBox();
        break;
      }
      case "message_end":
        this.setStaticActivity();
        this.endSpeech();
        this.fold(true);
        this.assistantWords = ""; this.testFirst = false;
        this.toolStarted.clear();
        this.ensureLineBreak();
        this.sayOutsideReads();
        break;
      case "notice":
        this.endSpeech();
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
        this.endSpeech();
        this.ensureLineBreak();
        if (this.displayedError !== event.message && !this.callbacks.cancelled()) this.writeError(event.message);
        this.displayedError = event.message;
        this.endedWithNewline = true;
        break;
    }
  }
}

/** One helper line for the steps pane: "helper explorer: find the login code", "helper explorer (low effort) · ✓ read · src/app.ts". */
export function helperActivityLine(activity: HelperActivity, root?: string): string {
  const who = `helper ${activity.run.role}${activity.run.effort ? ` (${activity.run.effort} effort)` : ""}`;
  if (activity.kind === "start") return `${who} started: ${redactPreview(activity.run.goal).replace(/\s+/g, " ").slice(0, 100)}`;
  if (activity.kind === "usage") return `${who} · ${(activity.run.spent?.tokens ?? 0).toLocaleString("en-US")} tokens so far`;
  if (activity.kind === "end") return `${who} ${activity.status === "completed" ? "finished" : `stopped (${activity.status.replace("_", " ")})`}`;
  return `${who} · ${formatToolActivity(activity.event.type === "tool_end" ? { ...activity.event, output: undefined } : activity.event, undefined, root ? { root } : {})}`;
}
