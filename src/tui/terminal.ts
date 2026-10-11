import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RuntimeImage, RuntimeModelPickerHost, RuntimePickerIO } from "../runtime/types";
import { terminalText, tint } from "./format";
import { renderPanel, type PanelTone } from "./presentation";
import type { ThemeRole } from "./theme";
import { TerminalSurface, type AskOrigin, type WorkView } from "./surface";
import { renderEditBox, renderFailureBox, stepRows, type EditedFile, type FailedStep, type StepPart } from "./step-view";
import type { EntryKind } from "./transcript";
import type { NextRow } from "./next-row";
import { bellSequence, hostCommand, prepareTmuxPane, titleSequence, TITLE_RESTORE, TITLE_SAVE, type HostCommand, type HostTerminal } from "./host-terminal";
import { SidePane, type ActivityPane } from "./side-pane";
import { answerRecordText, numberPrompt, OTHER_CHOICE, type PickRecord } from "./choices";

export { numberPrompt } from "./choices";

/** One transcript line colored by how it starts: ✗ error, ✓ success, a note (–), a warning (⚠) or a step that did not
 * run (○) warning, a running step (•) muted (the theme's colours); a detailed diff line added or removed. */
export function styleLine(line: string, color: boolean): string {
  const role: ThemeRole | undefined = /^(?:\[error\]|✗)/.test(line) ? "error" : /^✓/.test(line) ? "success"
    : /^(?:– |○ |⚠ |\[skills\]|\[cancel|\[approval\]|\[ask\]|\[effort\])/.test(line) ? "warning" : /^CASPER/.test(line) ? "accent" : /^(?: \/help · |…|• )/.test(line) ? "muted"
    : /^ {4}\+ /.test(line) ? "diffAdded" : /^ {4}- /.test(line) ? "diffRemoved" : undefined;
  // The text header is bold as well as the accent colour.
  return role ? tint(line, role, color, role === "accent" ? "1" : undefined) : line;
}

/** A folded group's rows at this width: two columns in under the AI's words (`attached`, with └), or at the left edge
 * with ● when nothing of theirs is above. */
export function renderFold(fold: FoldView, width: number, attached: boolean, color: boolean): string[] {
  const indent = attached ? "  " : "";
  const inner = Math.max(1, width - indent.length);
  const rows = [
    ...stepRows(fold.parts, inner, tint(attached ? "└" : "●", "muted", color), color),
    ...fold.lines.flatMap(line => terminalText(line).split("\n")).map(row => styleLine(row, color)),
    ...(fold.edits.length ? renderEditBox(fold.edits, inner, { color, maxLines: fold.editLines }) : []),
    ...fold.failures.flatMap(failure => failure.output?.trim() ? renderFailureBox(failure, inner, color) : [styleLine(terminalText(failure.title), color)]),
  ];
  return rows.map(row => truncateToWidth(`${indent}${row}`, width, ""));
}

/** A group of finished steps as the screen shows it once the AI moves on (see writeFold). */
export interface FoldView {
  /** What went well, by kind, for the one named row. */
  parts: StepPart[];
  /** Lines shown as they are, under the row: steps Casper stopped before they ran, or every step at the detailed level. */
  lines: string[];
  /** The group's edits, for the edit box. */
  edits: EditedFile[];
  /** The edit box's rows at most. */
  editLines: number;
  /** Steps that failed, each in its own box. */
  failures: FailedStep[];
}

/** The terminal Casper was started in (tmux, iTerm2), when it is a real one. Tests leave it out. */
export interface TerminalHost {
  host: HostTerminal;
  /** Opens the view-only steps pane; SidePane.open by default. */
  openPane?: () => ActivityPane | undefined;
  /** Runs tmux for Casper's own pane settings (tests pass a fake). */
  run?: HostCommand;
}

/** The steps pane opens only on a window at least this wide: a split halves it. */
export const PANE_MIN_COLUMNS = 120;

export type TerminalOutput = RuntimePickerIO["output"] & { isTTY?: boolean };

/** Terminal ownership boundary. Rich raw editor on a TTY; line input otherwise.
 * Lines typed during work go to the app (sent to the AI, queued, or run now), never to an approval; neither path
 * treats a stale draft as consent; plain
 * input typed before the first prompt is read (a person or a pipe may be ahead of startup). */
export class InteractiveTerminal {
  readonly color: boolean;
  private readonly surface?: TerminalSurface;
  private rl?: readline.Interface;
  private closed = false;
  private busy = false;
  private discardingInput = false;
  private assistantOpen = false;
  private badgeText?: string;
  private command?: (line?: string) => void;
  private confirmation?: (answer: string | undefined) => void;
  private plainQuestions = 0;
  private plainRecords = 0;
  /** Plain line input that arrived while idle but not yet reading (startup, before the first
   * prompt). Lines typed during work are still dropped, and approvals never read this. */
  private readonly earlyLines: string[] = [];
  /** Plain line input: the row under the last receipt. A line that is exactly one of its keys runs that step. */
  private nextKeys?: Map<string, string>;
  /** The steps pane beside Casper inside tmux or iTerm2: opened on the first busy step, closed at exit. */
  private pane?: ActivityPane;
  private paneTried = false;
  /** /pane off (saved), or iTerm2 before its one question is answered: no pane. */
  private paneOff = false;
  private titleSaved = false;
  private title?: string;
  private undoHost?: () => void;
  private busySubmit?: (line: string, plain?: boolean) => true | string;

  constructor(private readonly input: Readable, private readonly output: TerminalOutput,
    private readonly onInterrupt: () => void, private readonly onEOF: () => void, private readonly host?: TerminalHost) {
    const tty = Boolean((input as NodeJS.ReadStream).isTTY && output.isTTY && process.env.TERM !== "dumb");
    this.color = Boolean(output.isTTY && process.env.TERM !== "dumb" && process.env.NO_COLOR === undefined);
    if (tty) this.surface = new TerminalSurface({ input, output, color: this.color, onEOF }, onInterrupt, onEOF);
    if (this.surface && host) this.surface.setBell(bellSequence(host.host, "Casper is waiting for you"));
  }

  start(): void {
    if (this.surface) {
      if (this.host && !this.undoHost) this.undoHost = prepareTmuxPane(this.host.host, this.host.run ?? hostCommand());
      this.surface.start(); return;
    }
    if (this.rl || this.closed) return;
    this.rl = readline.createInterface({ input: this.input, output: this.output as Writable, terminal: false });
    // Readline emits a chunk's lines synchronously. Lines that arrive in the same chunk as the
    // one that answered a read were typed or piped ahead of it, not during its work.
    let sameChunk = false;
    this.rl.on("line", line => {
      if (this.closed || this.discardingInput) return;
      if (this.confirmation) { this.confirmation(line.trim()); return; }
      if (this.command) {
        const resolve = this.command; this.command = undefined; this.busy = true;
        sameChunk = true; queueMicrotask(() => { sameChunk = false; });
        // Only a line typed while Casper waits at the prompt can pick from the row.
        const offered = this.nextKeys?.get(line.trim());
        this.nextKeys = undefined;
        resolve(offered ?? line);
      } else if (!this.busy || sameChunk) this.earlyLines.push(line);
      else if ((this.input as NodeJS.ReadStream).isTTY && this.busySubmit && line.trim()) {
        // A person typing during work: the same as Enter on the rich terminal (sent to the AI, queued, or run now).
        const answer = this.busySubmit(line.trim(), true);
        if (answer !== true) this.write(`[input] ${answer}\n`);
      }
    });
    this.rl.on("SIGINT", () => this.interrupt());
    this.rl.once("close", () => {
      this.closed = true; this.command?.(); this.command = undefined;
      // A pipe that ends with lines still queued is not a hang-up: the command loop drains
      // them and then reads EOF itself.
      this.confirmation?.(undefined); if (!this.earlyLines.length) this.onEOF();
    });
  }

  setStatus(status: string, cwd = process.cwd()): void { this.surface?.setStatus(status, cwd); }
  /** Pictures pasted (Ctrl+V) into the line just sent, by their number in `[image N]`. Empty on the plain terminal. */
  takePastedImages(): Map<number, RuntimeImage> { return this.surface?.takePastedImages() ?? new Map(); }
  /** Text pasted into the line just sent, so Casper reads its words only from what the person typed. Empty on the
   * plain terminal, where every line is typed. */
  takeSubmittedPastes(): string[] { return this.surface?.takeSubmittedPastes() ?? []; }
  /** The MCP writes badge ("WRITES: <servers> · Ctrl+O"); kept here too, so the plain terminal can report it. */
  setBadge(text?: string): void { this.badgeText = text; this.surface?.setBadge(text); }
  get badge(): string | undefined { return this.badgeText; }
  /** A newer Casper is out: the short note at the end of the idle footer. Nothing on the plain terminal, which has the
   * `[update]` line at the start. */
  setUpdate(text?: string): void { this.surface?.setUpdate(text); }
  /** ctrl+o on the rich terminal: turn writes off everywhere. The handler returns true when any were on. */
  setWritesRevert(handler: (() => boolean) | undefined): void { this.surface?.setWritesRevert(handler); }
  /** Work in progress on the rich terminal: the open group's steps under the AI's words, and the status row above the
   * prompt. Nothing on the plain terminal. Inside tmux or iTerm2 the steps go to the view-only steps pane instead, and
   * the main screen keeps the status row and the rows the steps fold into. */
  setWork(view?: WorkView): void {
    const lines = [...view?.rows ?? [], ...(view?.status ? [view.status] : [])];
    const pane = lines.length ? this.activityPane() : this.pane;
    if (pane) { pane.show(lines); this.surface?.setWork(view?.status ? { rows: [], status: view.status } : undefined); return; }
    this.surface?.setWork(view);
  }
  /** A helper's (delegate's) step: in the steps pane when there is one; the main screen stays quiet. */
  logHelper(line: string): void { this.activityPane()?.log(line); }
  /** The steps pane is open (inside tmux or iTerm2, after the first busy step). */
  get hasPane(): boolean { return this.pane !== undefined; }
  private activityPane(): ActivityPane | undefined {
    if (!this.surface || !this.host || this.closed || this.paneOff) return undefined;
    if (!this.paneTried) {
      // A narrow window keeps its Working box; a later step tries again once it is wide.
      if ((this.output.columns ?? 0) < PANE_MIN_COLUMNS) return undefined;
      this.paneTried = true;
      this.pane = this.host.openPane ? this.host.openPane() : SidePane.open({ host: this.host.host });
    }
    return this.pane;
  }
  /** /pane on|off: off closes an open pane (the Working box comes back); on opens it at the next step. */
  setPane(setting: "on" | "off"): void {
    this.paneOff = setting === "off";
    if (this.paneOff) { const pane = this.pane; this.pane = undefined; pane?.close(); }
    this.paneTried = this.pane !== undefined;
  }
  /** Where a steps pane can open: inside tmux (its own pane known), or iTerm2 on a Mac. */
  get paneHost(): "tmux" | "iterm" | undefined {
    const host = this.host?.host;
    if (!this.surface || !host) return undefined;
    if (host.tmux) return host.tmuxPane ? "tmux" : undefined;
    return host.iterm && host.itermSession && (this.host.openPane || process.platform === "darwin") ? "iterm" : undefined;
  }

  /** The window title (the pane title inside tmux); the one before comes back at exit. Rich terminal only,
   * written only when it changes (the footer sets it on every update). */
  setTitle(title: string): void {
    if (!this.surface || this.closed || title === this.title) return;
    if (!this.titleSaved) { this.titleSaved = true; this.output.write(TITLE_SAVE); }
    this.title = title;
    this.output.write(titleSequence(title));
  }
  /** The current task's stages ("checklist ✓ · building"), shown first in the footer while work runs. */
  setSteps(steps?: string): void { this.surface?.setSteps(steps); }
  /** How long a request must run before its end or a question rings the terminal bell (default 10 s). */
  setAttentionAfter(ms: number): void { this.surface?.setAttentionAfter(ms); }
  /** Rich terminal only. Shift+Tab cycles effort; plain line input has no equivalent key. */
  setEffortCycle(handler: (() => void) | undefined): void { this.surface?.setEffortCycle(handler); }
  /** Enter while Casper works: true took it (ran it, sent it to the AI or queued it); text is why it waits. `plain`:
   * the plain terminal, which has no draft to keep. */
  setBusySubmit(handler: ((line: string, plain?: boolean) => true | string) | undefined): void {
    this.busySubmit = handler;
    this.surface?.setBusySubmit(handler && (line => handler(line)));
  }
  /** Rich terminal only. Ctrl+T shows the last finished step in full. */
  setExpandLast(handler: (() => void) | undefined): void { this.surface?.setExpandLast(handler); }
  flashNote(text: string): void { this.surface?.flashNote(text); }
  /** The rich footer at this width; undefined on the plain terminal. */
  footerLine(width: number): string | undefined { return this.surface?.footerLine(width); }

  /** A person can answer Casper's numbered questions: the rich surface, or plain line input typed at a
   * terminal. Piped input can't: its lines were written before any question existed. */
  get canAsk(): boolean { return this.surface !== undefined || Boolean((this.input as NodeJS.ReadStream).isTTY); }

  /** Rich surface present (TTY input and output, TERM not dumb) and its current width. */
  get rich(): boolean { return this.surface !== undefined; }
  /** Plain line input: how many questions or approvals have been shown, and whether one is open now. A tool's
   * start line waits on these, so it never lands in the middle of an answer being typed. */
  get questionsShown(): number { return this.plainQuestions; }
  get questionOpen(): boolean { return this.confirmation !== undefined; }
  get columns(): number | undefined { return this.output.columns; }

  /** Constant, already-styled lines laid out per width, such as the startup wordmark. Never for model or tool output. */
  writeTrusted(block: Component): void {
    if (this.surface) this.surface.writeBlock(block); else this.output.write(block.render(this.output.columns ?? 80).join("\n") + "\n");
  }

  /** Untrusted text its caller lays out for each width (a pack's files, a bar in front of every row): each row is
   * sanitized as untrusted text and stays one row, so the layout is never wrapped again into rows it didn't make. */
  writeRows(rows: (width: number) => string[]): void {
    const laid = (width: number) => rows(width).map(row => truncateToWidth(terminalText(row).replace(/\n/g, " "), Math.max(1, width), ""));
    if (this.surface) this.surface.writeBlock({ render: laid, invalidate() {} });
    else this.output.write(laid(this.output.columns ?? 80).join("\n") + "\n");
  }

  /** Code-like output (a replayed tool result, a diff) boxed under a title on the rich surface; a
   * titled plain block otherwise. Both title and body are sanitized as untrusted text. `diff`
   * colors unified-diff lines in the theme's diff colours (added, removed, hunk headers). */
  writePanel(title: string, body: string, options: { tone?: PanelTone; diff?: boolean } = {}): void {
    const heading = terminalText(title).replace(/\s+/g, " ").trim();
    const plain = terminalText(body).replace(/\n$/, "").split("\n");
    if (!this.surface) { this.write(`${heading}\n${plain.join("\n")}\n`); return; }
    const lines = options.diff ? plain.map(line =>
      /^\+(?!\+\+ )/.test(line) ? tint(line, "diffAdded", this.color) : /^-(?!-- )/.test(line) ? tint(line, "diffRemoved", this.color)
        : line.startsWith("@@") ? tint(line, "diffHunk", this.color) : line) : plain;
    this.surface.writeBlock({ render: width => renderPanel(heading, lines, width, this.color, options.tone ?? "muted"), invalidate() {} }, "group");
  }

  /** `kind`: how the lines sit among the blocks around them on the rich terminal (plain lines pack together). */
  write(text: string, kind: EntryKind = "line"): void {
    const styled = terminalText(text).split("\n").map(line => this.styleLine(line)).join("\n");
    if (this.surface) this.surface.write(styled, kind); else this.output.write(styled);
  }

  /**
   * A group of finished steps, folded, on the rich terminal: one row naming what went well (└ under the AI's words, or
   * ● on its own), the lines given as they are (steps Casper stopped before they ran), the edits in one box with a short
   * diff, and each failure in an error box with the last lines it printed (a failure with nothing printed stays a ✗
   * line). The plain terminal prints the lines and failures as lines.
   */
  writeFold(fold: FoldView): void {
    if (!this.surface) {
      for (const line of [...fold.lines, ...fold.failures.map(failure => failure.title)]) this.write(`${line}\n`);
      return;
    }
    const color = this.color;
    this.surface.writeAttachable(attached => ({ render: width => renderFold(fold, width, attached, color), invalidate() {} }));
  }

  private styleLine(line: string): string { return styleLine(line, this.color); }

  /** A task's result (the receipt) on the rich terminal: a colored edge down its left side, success for a pass,
   * error for a failure, warning for anything in between. The plain terminal gets the lines as they are. */
  writeResult(text: string): void {
    if (!this.surface) { this.write(text); return; }
    const lines = terminalText(text).split("\n");
    const tone = /^✓/.test(lines[0] ?? "") ? "success" : /^(?:✗|\[error\])/.test(lines[0] ?? "") ? "error" : "warning";
    const edge = tint("▌", tone, this.color);
    // A block of its own: a blank row before it.
    this.surface.write(lines.map(line => line ? `${edge} ${this.styleLine(line)}` : line).join("\n"), "group");
  }

  assistant(delta: string): void {
    if (this.surface) { this.surface.assistant(delta); return; }
    const text = terminalText(delta); this.output.write(text);
    if (text) this.assistantOpen = !text.endsWith("\n");
  }

  endAssistant(): void {
    if (this.surface) { this.surface.endAssistant(); return; }
    if (this.assistantOpen) this.output.write("\n");
    this.assistantOpen = false;
  }

  /** Put queued lines back in the prompt draft. False on the plain terminal, which has no draft to hold them. */
  restoreDraft(text: string, pasted: readonly string[] = []): boolean {
    if (!this.surface) return false;
    this.surface.restoreDraft(text, pasted);
    return true;
  }

  /** Print the receipt's next-step row and offer its keys until the next line or key. Nothing waits on it. */
  offerNext(row: NextRow | undefined): void {
    if (!row) { this.nextKeys = undefined; this.surface?.offerNext(undefined); return; }
    // Right under the receipt it belongs to.
    this.write(`${row.line}\n`, "attached");
    if (this.surface) this.surface.offerNext(row.keys); else this.nextKeys = new Map(row.keys);
  }

  readCommand(): Promise<string | undefined> {
    if (this.surface) return this.surface.readCommand();
    this.endAssistant(); this.busy = false;
    // Lines typed ahead were written before the row existed: they are requests, never picks from it.
    if (this.earlyLines.length) { this.nextKeys = undefined; this.busy = true; return Promise.resolve(this.earlyLines.shift()!); }
    if (this.closed || !this.rl) return Promise.resolve(undefined);
    return new Promise(resolve => { this.command = resolve; this.rl!.setPrompt("> "); this.rl!.prompt(); });
  }

  private discardPartialLine(): void {
    // Plain readline has a separate unfinished-line buffer. Flush it while
    // discarding so stale fragments cannot answer approval or become commands.
    // A closed interface has no buffer left, and writing to it throws (EOF during an approval).
    if (this.closed) return;
    this.discardingInput = true;
    try { this.rl?.write("\n"); } finally { this.discardingInput = false; }
  }

  /**
   * One approval box (a change, a host, a command, a device check), in the same numbered style as every other
   * question: the context lines, then the choices. Rich: the panel, where one key picks; plain: numbered lines and
   * a number with Enter. It resolves the chosen label (typed words or Enter alone are the first choice, No), or
   * undefined for Esc, Ctrl+C, ctrl+o, EOF or abort. Lines and keys typed before the box appeared never answer it.
   * The model's ask tool never reaches this channel.
   */
  async approve(preview: string, question: string, options: ReadonlyArray<string | { label: string; description?: string }>, signal?: AbortSignal): Promise<string | undefined> {
    const choices = options.map(option => typeof option === "string" ? { label: option } : option);
    if (this.surface) return this.surface.approve(preview, question, choices, signal);
    // A plain terminal on a TTY means the box can't be shown where it is answered (TERM=dumb, output redirected).
    if ((this.input as NodeJS.ReadStream).isTTY && this.rl && !this.closed) {
      this.write("[input] No: approval denied, because this terminal can't show the box (TERM=dumb, or output redirected).\n");
      return undefined;
    }
    if (!this.rl || this.closed || this.confirmation || signal?.aborted || !choices.length) return undefined;
    this.endAssistant(); this.discardPartialLine();
    if (preview.trim()) this.write(`${preview.replace(/\n+$/, "")}\n`);
    return this.plainPick(question, choices, signal, true, false);
  }

  modelPickerHost(): RuntimeModelPickerHost | undefined { return this.exclusiveHost(); }
  exclusiveHost(options?: { onYield?: () => void }): RuntimeModelPickerHost | undefined { return this.surface?.exclusiveHost(options); }

  /** Structured clarification on the rich surface; undefined when skipped or unavailable. */
  ask(question: string, options: { label: string; description?: string }[], multi: boolean, signal?: AbortSignal, from: AskOrigin = "casper"): Promise<string[] | undefined> {
    // Only the AI's own questions take a typed answer; Casper's are pickers (keys only).
    return this.surface ? this.surface.ask(question, options, multi, signal, from, from === "ai") : Promise.resolve(undefined);
  }

  /**
   * One numbered question from Casper itself (never an approval, never the AI's ask tool), answerable on
   * both terminals. It resolves the chosen option's label, the text typed instead, or undefined for Esc,
   * Ctrl+C, EOF or abort. Rich: the ask panel (Enter picks the highlighted option). Plain: numbered lines;
   * a number or a label picks, Enter picks the first, other text comes back as typed. Lines typed before the question
   * appeared never answer it.
   */
  async pick(question: string, options: { label: string; description?: string }[], signal?: AbortSignal, settings: PickRecord & { typed?: boolean } = {}): Promise<string | undefined> {
    // Rich: a picker takes keys only (a paste waits for after it), unless `typed` says a typed answer means something here.
    if (this.surface) return (await this.surface.ask(question, options, false, signal, "casper", settings.typed ?? false, settings.record))?.[0];
    return this.plainPick(question, options, signal, false, settings.typed ?? false, settings.record);
  }

  /** How many closed boxes have left their one-line record ("Pick a server → lab"), on either terminal. */
  get records(): number { return this.surface?.records ?? this.plainRecords; }

  /** The plain terminal's numbered question. `approval`: typed words are a No, and the record says so. `other`: the
   * question takes a typed answer, so its last row is Other, and picking it asks "Your answer: ". */
  private async plainPick(question: string, options: { label: string; description?: string }[], signal: AbortSignal | undefined, approval: boolean, other: boolean,
    record?: PickRecord["record"]): Promise<string | undefined> {
    if (this.earlyLines.length) {
      this.write(`[input] Discarded ${this.earlyLines.length} line(s) entered before this question appeared.\n`);
      this.earlyLines.length = 0;
    }
    if (!this.rl || this.closed || this.confirmation || signal?.aborted || !options.length) return undefined;
    this.endAssistant(); this.discardPartialLine();
    this.plainQuestions += 1;
    const rows = [...options, ...(other ? [{ label: OTHER_CHOICE }] : [])];
    this.write(`${question}\n${rows.map((option, index) => `  ${index + 1} ${option.label}${option.description ? ` · ${option.description}` : ""}`).join("\n")}\n`);
    return new Promise(resolve => {
      let settled = false;
      // After Other: the next line is the answer as typed (an empty one asks again).
      let typing = false;
      const finish = (answer: string | undefined) => {
        if (settled) return;
        const text = answer?.trim();
        const number = text && /^\d+$/.test(text) ? Number(text) : 0;
        if (!typing && other && number === rows.length) {
          typing = true;
          this.rl!.setPrompt("Your answer: "); this.rl!.prompt();
          return;
        }
        if (typing && text === "") { this.rl!.prompt(); return; }
        settled = true;
        signal?.removeEventListener("abort", cancel);
        this.confirmation = undefined; this.discardPartialLine();
        const named = text === undefined ? undefined : options.find(option => option.label.toLowerCase() === text.toLowerCase());
        const typed = text === undefined ? undefined : typing ? text : !text ? options[0]!.label : number >= 1 && number <= options.length ? options[number - 1]!.label : named?.label ?? text;
        const picked = approval && typed !== undefined && !options.some(option => option.label === typed) ? options[0]!.label : typed;
        // The same one-line record the rich terminal leaves, so both say what was answered in the same words.
        const own = picked === undefined ? undefined : record?.(picked);
        if (!this.closed && own !== "") {
          this.write(`${own ?? (picked === undefined && approval ? `${answerRecordText(question, undefined)} (${options[0]!.label})` : answerRecordText(question, picked === undefined ? undefined : [picked]))}\n`);
          this.plainRecords += 1;
        }
        resolve(picked);
      };
      const cancel = () => finish(undefined);
      this.confirmation = finish;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      this.rl!.setPrompt(rows.length > 1 ? numberPrompt(rows.length) : "Enter for 1, or type your own: ");
      this.rl!.prompt();
    });
  }

  /** Lines edited in place on the rich surface; undefined when skipped or unavailable. */
  editLines(heading: string, hint: string, lines: readonly string[], signal?: AbortSignal): Promise<string[] | undefined> {
    return this.surface ? this.surface.editLines(heading, hint, lines, signal) : Promise.resolve(undefined);
  }

  interrupt(): void {
    if (this.surface) { this.surface.interrupt(); return; }
    if (this.closed) return;
    this.confirmation?.(undefined);
    if (this.busy) this.onInterrupt(); else this.close();
  }

  close(): void {
    this.closeHost();
    if (this.surface) { this.surface.close(); return; }
    if (this.closed) return;
    this.endAssistant(); this.rl?.close(); this.closed = true;
  }

  /** Close the steps pane, undo Casper's own pane setting and give the title back. Once. */
  private closeHost(): void {
    const pane = this.pane; this.pane = undefined; this.paneTried = true;
    pane?.close();
    this.undoHost?.(); this.undoHost = () => {};
    if (this.titleSaved) { this.titleSaved = false; this.output.write(TITLE_RESTORE); }
  }
}
