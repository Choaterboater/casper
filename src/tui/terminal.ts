import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { RuntimeModelPickerHost, RuntimePickerIO } from "../runtime/types";
import { terminalText } from "./format";
import type { PanelTone } from "./presentation";
import { TerminalSurface } from "./surface";

export type TerminalOutput = RuntimePickerIO["output"] & { isTTY?: boolean };

/** Terminal ownership boundary. Rich raw editor on a TTY; line input otherwise.
 * Neither path queues early submissions or treats a stale draft as consent. */
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

  constructor(private readonly input: Readable, private readonly output: TerminalOutput,
    private readonly onInterrupt: () => void, private readonly onEOF: () => void) {
    const tty = Boolean((input as NodeJS.ReadStream).isTTY && output.isTTY && process.env.TERM !== "dumb");
    this.color = tty && process.env.NO_COLOR === undefined;
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
      }
    });
    this.rl.on("SIGINT", () => this.interrupt());
    this.rl.once("close", () => {
      this.closed = true; this.command?.(); this.command = undefined;
      this.confirmation?.(false); this.onEOF();
    });
  }

  setStatus(status: string, cwd = process.cwd()): void { this.surface?.setStatus(status, cwd); }

  write(text: string): void {
    if (this.surface) { this.surface.write(text); return; }
    this.endAssistant();
    this.output.write(terminalText(text));
  }

  writePanel(title: string, body: string, tone: PanelTone = "accent"): void {
    if (this.surface) { this.surface.writePanel(title, body, tone); return; }
    const heading = terminalText(title).replace(/\s+/g, " ").trim();
    this.write(`${heading}\n${body}${body.endsWith("\n") ? "" : "\n"}`);
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
      this.writePanel("Approval denied", "Use an interactive terminal with TERM other than dumb and output not redirected. Cooked input cannot prove that an answer is fresh.", "warning");
      return Promise.resolve(false);
    }
    this.endAssistant(); this.discardPartialLine(); this.writePanel("Approval required · exact operation", preview, "warning");
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
      this.rl!.setPrompt(terminalText(question)); this.rl!.prompt();
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
