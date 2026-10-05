import type { Component } from "@earendil-works/pi-tui";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RuntimeImage, RuntimeModelPickerHost, RuntimePickerIO } from "../runtime/types";
import { paint, terminalText } from "./format";
import { renderPanel, type PanelTone } from "./presentation";
import { TerminalSurface, type AskOrigin } from "./surface";
import type { NextRow } from "./next-row";
import { bellSequence, hostCommand, prepareTmuxPane, titleSequence, TITLE_RESTORE, TITLE_SAVE, type HostCommand, type HostTerminal } from "./host-terminal";
import { SidePane, type ActivityPane } from "./side-pane";

/** The plain terminal's prompt under numbered choices, the same for every question and box: "Type 1, 2 or 3: ".
 * Enter alone picks 1, which is always the safe choice. */
export function numberPrompt(count: number): string {
  const digits = Array.from({ length: count }, (_, index) => String(index + 1));
  return `Type ${digits.length === 2 ? "1 or 2" : `${digits.slice(0, -1).join(", ")} or ${digits.at(-1)}`}: `;
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
  /** The MCP writes badge ("WRITES: <servers> · ctrl+o"); kept here too, so the plain terminal can report it. */
  setBadge(text?: string): void { this.badgeText = text; this.surface?.setBadge(text); }
  get badge(): string | undefined { return this.badgeText; }
  /** ctrl+o on the rich terminal: turn writes off everywhere. The handler returns true when any were on. */
  setWritesRevert(handler: (() => boolean) | undefined): void { this.surface?.setWritesRevert(handler); }
  /** The rich Working box: one line or a few (the latest steps). Nothing on the plain terminal. Inside tmux or
   * iTerm2 the lines go to the view-only steps pane instead, and the main screen keeps only the model's words. */
  setActivity(status?: string | readonly string[]): void {
    const lines = typeof status === "string" ? [status] : status ?? [];
    const pane = lines.length ? this.activityPane() : this.pane;
    if (pane) { pane.show(lines); this.surface?.setActivity(undefined); return; }
    this.surface?.setActivity(status);
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

  /** Code-like output (a replayed tool result, a diff) boxed under a title on the rich surface; a
   * titled plain block otherwise. Both title and body are sanitized as untrusted text. `diff`
   * colors unified-diff lines (added green, removed red, hunk headers cyan). */
  writePanel(title: string, body: string, options: { tone?: PanelTone; diff?: boolean } = {}): void {
    const heading = terminalText(title).replace(/\s+/g, " ").trim();
    const plain = terminalText(body).replace(/\n$/, "").split("\n");
    if (!this.surface) { this.write(`${heading}\n${plain.join("\n")}\n`); return; }
    const lines = options.diff ? plain.map(line =>
      /^\+(?!\+\+ )/.test(line) ? paint(line, "32", this.color) : /^-(?!-- )/.test(line) ? paint(line, "31", this.color)
        : line.startsWith("@@") ? paint(line, "36", this.color) : line) : plain;
    this.surface.writeBlock({ render: width => renderPanel(heading, lines, width, this.color, options.tone ?? "muted"), invalidate() {} });
  }

  write(text: string): void {
    const styled = terminalText(text).split("\n").map(line => this.styleLine(line)).join("\n");
    if (this.surface) this.surface.write(styled); else this.output.write(styled);
  }

  /** One transcript line colored by how it starts: ✗ red, ✓ green, • yellow; a detailed diff line red or green. */
  private styleLine(line: string): string {
    const code = /^(?:\[error\]|✗)/.test(line) ? "31" : /^✓/.test(line) ? "32"
      : /^(?:•|\[skills\]|\[cancel|\[approval\]|\[ask\]|\[effort\])/.test(line) ? "33" : /^CASPER/.test(line) ? "1;36" : /^(?: \/help · |…)/.test(line) ? "2"
      : /^ {4}\+ /.test(line) ? "32" : /^ {4}- /.test(line) ? "31" : undefined;
    return code ? paint(line, code, this.color) : line;
  }

  /** A task's result (the receipt) on the rich terminal: a colored edge down its left side, green for a pass,
   * red for a failure, yellow for anything in between. The plain terminal gets the lines as they are. */
  writeResult(text: string): void {
    if (!this.surface) { this.write(text); return; }
    const lines = terminalText(text).split("\n");
    const tone = /^✓/.test(lines[0] ?? "") ? "32" : /^(?:✗|\[error\])/.test(lines[0] ?? "") ? "31" : "33";
    const edge = paint("▌", tone, this.color);
    this.surface.write(lines.map(line => line ? `${edge} ${this.styleLine(line)}` : line).join("\n"));
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
  restoreDraft(text: string): boolean {
    if (!this.surface) return false;
    this.surface.restoreDraft(text);
    return true;
  }

  /** Print the receipt's next-step row and offer its keys until the next line or key. Nothing waits on it. */
  offerNext(row: NextRow | undefined): void {
    if (!row) { this.nextKeys = undefined; this.surface?.offerNext(undefined); return; }
    this.write(`${row.line}\n`);
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
    const answer = await this.pick(question, choices, signal);
    if (answer === undefined) return undefined;
    return choices.some(choice => choice.label === answer) ? answer : choices[0]!.label;
  }

  modelPickerHost(): RuntimeModelPickerHost | undefined { return this.exclusiveHost(); }
  exclusiveHost(options?: { onYield?: () => void }): RuntimeModelPickerHost | undefined { return this.surface?.exclusiveHost(options); }

  /** Structured clarification on the rich surface; undefined when skipped or unavailable. */
  ask(question: string, options: { label: string; description?: string }[], multi: boolean, signal?: AbortSignal, from: AskOrigin = "casper"): Promise<string[] | undefined> {
    return this.surface ? this.surface.ask(question, options, multi, signal, from) : Promise.resolve(undefined);
  }

  /**
   * One numbered question from Casper itself (never an approval, never the AI's ask tool), answerable on
   * both terminals. It resolves the chosen option's label, the text typed instead, or undefined for Esc,
   * Ctrl+C, EOF or abort. Rich: the ask panel (Enter picks the highlighted option). Plain: numbered lines;
   * a number or a label picks, Enter picks the first, other text comes back as typed. Lines typed before the question
   * appeared never answer it.
   */
  async pick(question: string, options: { label: string; description?: string }[], signal?: AbortSignal): Promise<string | undefined> {
    if (this.surface) return (await this.surface.ask(question, options, false, signal, "casper"))?.[0];
    if (this.earlyLines.length) {
      this.write(`[input] Discarded ${this.earlyLines.length} line(s) entered before this question appeared.\n`);
      this.earlyLines.length = 0;
    }
    if (!this.rl || this.closed || this.confirmation || signal?.aborted || !options.length) return undefined;
    this.endAssistant(); this.discardPartialLine();
    this.plainQuestions += 1;
    this.write(`${question}\n${options.map((option, index) => `  ${index + 1} ${option.label}${option.description ? ` · ${option.description}` : ""}`).join("\n")}\n`);
    return new Promise(resolve => {
      let settled = false;
      const finish = (answer: string | undefined) => {
        if (settled) return; settled = true;
        signal?.removeEventListener("abort", cancel);
        this.confirmation = undefined; this.discardPartialLine();
        if (answer === undefined) { resolve(undefined); return; }
        const text = answer.trim();
        const number = /^\d+$/.test(text) ? Number(text) : 0;
        const named = options.find(option => option.label.toLowerCase() === text.toLowerCase());
        resolve(!text ? options[0]!.label : number >= 1 && number <= options.length ? options[number - 1]!.label : named?.label ?? text);
      };
      const cancel = () => finish(undefined);
      this.confirmation = finish;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      this.rl!.setPrompt(options.length > 1 ? numberPrompt(options.length) : "Enter for 1, or type your own: ");
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
