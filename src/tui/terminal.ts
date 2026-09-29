import type { Component } from "@earendil-works/pi-tui";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RuntimeModelPickerHost, RuntimePickerIO } from "../runtime/types";
import { paint, terminalText } from "./format";
import { renderPanel, type PanelTone } from "./presentation";
import { TerminalSurface, type AskOrigin } from "./surface";

export type TerminalOutput = RuntimePickerIO["output"] & { isTTY?: boolean };

/** Terminal ownership boundary. Rich raw editor on a TTY; line input otherwise.
 * Neither path queues submissions made during work or treats a stale draft as consent; plain
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
  /** Plain line input that arrived while idle but not yet reading (startup, before the first
   * prompt). Lines typed during work are still dropped, and approvals never read this. */
  private readonly earlyLines: string[] = [];

  constructor(private readonly input: Readable, private readonly output: TerminalOutput,
    private readonly onInterrupt: () => void, private readonly onEOF: () => void) {
    const tty = Boolean((input as NodeJS.ReadStream).isTTY && output.isTTY && process.env.TERM !== "dumb");
    this.color = Boolean(output.isTTY && process.env.TERM !== "dumb" && process.env.NO_COLOR === undefined);
    if (tty) this.surface = new TerminalSurface({ input, output, color: this.color, onEOF }, onInterrupt, onEOF);
  }

  start(): void {
    if (this.surface) { this.surface.start(); return; }
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
        resolve(line);
      } else if (!this.busy || sameChunk) this.earlyLines.push(line);
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
  /** The MCP writes badge ("WRITES: <servers> · ctrl+o"); kept here too, so the plain terminal can report it. */
  setBadge(text?: string): void { this.badgeText = text; this.surface?.setBadge(text); }
  get badge(): string | undefined { return this.badgeText; }
  /** ctrl+o on the rich terminal: turn writes off everywhere. The handler returns true when any were on. */
  setWritesRevert(handler: (() => boolean) | undefined): void { this.surface?.setWritesRevert(handler); }
  setActivity(status?: string): void { this.surface?.setActivity(status); }
  /** The current task's stages ("checklist ✓ · building"), shown first in the footer while work runs. */
  setSteps(steps?: string): void { this.surface?.setSteps(steps); }
  /** How long a request must run before its end or a question rings the terminal bell (default 10 s). */
  setAttentionAfter(ms: number): void { this.surface?.setAttentionAfter(ms); }
  /** Rich terminal only. Shift+Tab cycles effort; plain line input has no equivalent key. */
  setEffortCycle(handler: (() => void) | undefined): void { this.surface?.setEffortCycle(handler); }
  flashNote(text: string): void { this.surface?.flashNote(text); }
  /** The rich footer at this width; undefined on the plain terminal. */
  footerLine(width: number): string | undefined { return this.surface?.footerLine(width); }

  /** Rich surface present (TTY input and output, TERM not dumb) and its current width. */
  get rich(): boolean { return this.surface !== undefined; }
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

  write(text: string, options: { rewriteLine?: boolean } = {}): void {
    const styled = terminalText(text).split("\n").map(line => {
      const code = /^(?:\[error\]|✗)/.test(line) ? "31" : /^✓/.test(line) ? "32"
        : /^(?:•|\[skills\]|\[cancel|\[approval\]|\[ask\]|\[effort\])/.test(line) ? "33" : /^CASPER/.test(line) ? "1;36" : /^(?: \/help · |…)/.test(line) ? "2" : undefined;
      return code ? paint(line, code, this.color) : line;
    }).join("\n");
    // `rewriteLine` restarts the transcript's open tail line (a "running" status) instead of
    // appending; the sanitizer above would otherwise escape a caller's `\r`. Rich surface only.
    if (this.surface) this.surface.write(options.rewriteLine ? `\r${styled}` : styled); else this.output.write(styled);
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

  readCommand(): Promise<string | undefined> {
    if (this.surface) return this.surface.readCommand();
    this.endAssistant(); this.busy = false;
    if (this.earlyLines.length) { this.busy = true; return Promise.resolve(this.earlyLines.shift()!); }
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

  /** Exact yes/no approval: only a freshly typed "yes" approves. */
  async confirm(preview: string, question: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.choose(preview, question, ["yes"], signal)) === "yes";
  }

  /**
   * One approval or server question with a few exact typed answers, on the rich surface or plain
   * line input. It resolves one of `choices` as typed, "no" for any other text, and undefined for
   * Ctrl+C, EOF or abort. Lines typed before the question appeared never answer it. The model's ask
   * tool never reaches this channel.
   */
  choose(preview: string, question: string, choices: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
    if (this.surface) return this.surface.choose(preview, question, choices, signal);
    // Lines queued ahead of an approval were written before its preview existed: they can neither
    // answer it nor, once it settles, silently become later commands or paid prompts.
    if (this.earlyLines.length) {
      this.write(`[input] Discarded ${this.earlyLines.length} line(s) entered before this approval appeared.\n`);
      this.earlyLines.length = 0;
    }
    if (!this.rl || this.closed || this.confirmation || signal?.aborted) return Promise.resolve(undefined);
    if ((this.input as NodeJS.ReadStream).isTTY) {
      this.write("[input] Exact approval denied: use an interactive terminal with TERM other than dumb and output not redirected.\n");
      return Promise.resolve(undefined);
    }
    this.endAssistant(); this.discardPartialLine(); this.write(preview);
    return new Promise(resolve => {
      let settled = false;
      const finish = (answer: string | undefined) => {
        if (settled) return; settled = true;
        signal?.removeEventListener("abort", cancel);
        this.confirmation = undefined; this.discardPartialLine();
        resolve(answer === undefined ? undefined : choices.includes(answer) ? answer : "no");
      };
      const cancel = () => finish(undefined);
      this.confirmation = finish;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      this.rl!.setPrompt(question); this.rl!.prompt();
    });
  }

  modelPickerHost(): RuntimeModelPickerHost | undefined { return this.exclusiveHost(); }
  exclusiveHost(): RuntimeModelPickerHost | undefined { return this.surface?.exclusiveHost(); }

  /** Structured clarification on the rich surface; undefined when skipped or unavailable. */
  ask(question: string, options: { label: string; description?: string }[], multi: boolean, signal?: AbortSignal, from: AskOrigin = "casper"): Promise<string[] | undefined> {
    return this.surface ? this.surface.ask(question, options, multi, signal, from) : Promise.resolve(undefined);
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
    if (this.surface) { this.surface.close(); return; }
    if (this.closed) return;
    this.endAssistant(); this.rl?.close(); this.closed = true;
  }
}
