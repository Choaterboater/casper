import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RuntimeModelPickerHost, RuntimePickerIO } from "../runtime/types";
import { paint, terminalText } from "./format";
import { PANEL_MAX_COLUMNS, renderPanel, type PanelTone } from "./presentation";
import { TerminalSurface } from "./surface";

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
  private command?: (line?: string) => void;
  private confirmation?: (approved: boolean) => void;
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
    this.rl.on("line", line => {
      if (this.closed || this.discardingInput) return;
      if (this.confirmation) { this.confirmation(line.trim() === "yes"); return; }
      if (this.command) {
        const resolve = this.command; this.command = undefined; this.busy = true; resolve(line);
      } else if (!this.busy) this.earlyLines.push(line);
    });
    this.rl.on("SIGINT", () => this.interrupt());
    this.rl.once("close", () => {
      this.closed = true; this.command?.(); this.command = undefined;
      this.confirmation?.(false); this.onEOF();
    });
  }

  setStatus(status: string, cwd = process.cwd()): void { this.surface?.setStatus(status, cwd); }

  /** Rich surface present (TTY input and output, TERM not dumb) and its current width. */
  get rich(): boolean { return this.surface !== undefined; }
  get columns(): number | undefined { return this.output.columns; }

  /** Constant, already-styled text such as the startup wordmark. Never for model or tool output. */
  writeTrusted(text: string): void {
    if (this.surface) this.surface.write(text); else this.output.write(text);
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
    this.surface.writeBlock({ render: width => renderPanel(heading, lines, Math.min(width, PANEL_MAX_COLUMNS), this.color, options.tone ?? "muted"), invalidate() {} });
  }

  write(text: string, options: { rewriteLine?: boolean } = {}): void {
    const styled = terminalText(text).split("\n").map(line => {
      const code = /^(?:\[error\]|✗)/.test(line) ? "31" : /^✓/.test(line) ? "32"
        : /^(?:•|\[skills\]|\[cancel|\[approval\]|\[effort\])/.test(line) ? "33" : /^CASPER/.test(line) ? "1;36" : /^(?: \/help · |…)/.test(line) ? "2" : undefined;
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
    if (this.closed || !this.rl) return Promise.resolve(undefined);
    if (this.earlyLines.length) { this.busy = true; return Promise.resolve(this.earlyLines.shift()!); }
    return new Promise(resolve => { this.command = resolve; this.rl!.setPrompt("> "); this.rl!.prompt(); });
  }

  private discardPartialLine(): void {
    // Plain readline has a separate unfinished-line buffer. Flush it while
    // discarding so stale fragments cannot answer approval or become commands.
    this.discardingInput = true;
    try { this.rl?.write("\n"); } finally { this.discardingInput = false; }
  }

  confirm(preview: string, question: string, signal?: AbortSignal): Promise<boolean> {
    if (this.surface) return this.surface.confirm(preview, question, signal);
    if (!this.rl || this.closed || this.confirmation || signal?.aborted) return Promise.resolve(false);
    if ((this.input as NodeJS.ReadStream).isTTY) {
      this.write("[input] Exact approval denied: use an interactive terminal with TERM other than dumb and output not redirected.\n");
      return Promise.resolve(false);
    }
    this.endAssistant(); this.discardPartialLine(); this.write(preview);
    return new Promise(resolve => {
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return; settled = true;
        signal?.removeEventListener("abort", cancel);
        this.confirmation = undefined; this.discardPartialLine(); resolve(approved);
      };
      const cancel = () => finish(false);
      this.confirmation = finish;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      this.rl!.setPrompt(question); this.rl!.prompt();
    });
  }

  modelPickerHost(): RuntimeModelPickerHost | undefined { return this.exclusiveHost(); }
  exclusiveHost(): RuntimeModelPickerHost | undefined { return this.surface?.exclusiveHost(); }

  interrupt(): void {
    if (this.surface) { this.surface.interrupt(); return; }
    if (this.closed) return;
    this.confirmation?.(false);
    if (this.busy) this.onInterrupt(); else this.close();
  }

  close(): void {
    if (this.surface) { this.surface.close(); return; }
    if (this.closed) return;
    this.endAssistant(); this.rl?.close(); this.closed = true;
  }
}
