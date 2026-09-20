import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { MarkdownFormatter, paint, terminalText } from "./format";
import type { RuntimeModelPickerHost, RuntimePickerIO } from "../runtime/types";

export type TerminalOutput = RuntimePickerIO["output"] & { isTTY?: boolean };

/** Owns transcript rendering, the editable draft, and exclusive confirmation input.
 * No command queue: Enter during work keeps the draft; it never runs later by itself.
 * Redirected streams use line input and emit no terminal control sequences.
 */
export class InteractiveTerminal {
  readonly color: boolean;
  private readonly tty: boolean;
  private rl?: readline.Interface;
  private history: string[] = [];
  private promptVisible = false;
  private previewVisible = false;
  private pending = "";
  private markdown: MarkdownFormatter;
  private markdownPending = "";
  private plainAssistantOpen = false;
  private discardingInput = false;
  private busy = false;
  private closed = false;
  private suspended = false;
  private suspendedOutput = "";
  private command?: (line?: string) => void;
  private confirmation?: (approved: boolean) => void;
  private savedDraft?: { line: string; cursor: number };
  private promptText = "> ";

  constructor(private readonly input: Readable, private readonly output: TerminalOutput,
    private readonly onInterrupt: () => void, private readonly onEOF: () => void) {
    this.tty = Boolean((input as NodeJS.ReadStream).isTTY && output.isTTY && process.env.TERM !== "dumb");
    this.color = Boolean(output.isTTY && process.env.TERM !== "dumb" && process.env.NO_COLOR === undefined);
    this.markdown = new MarkdownFormatter(this.color);
  }

  start(): void {
    this.rl = readline.createInterface({ input: this.input, output: this.output as Writable, terminal: this.tty, history: this.history });
    this.rl.on("history", (history) => { this.history = [...history]; });
    this.rl.on("line", (line) => this.acceptLine(line));
    this.rl.on("SIGINT", () => this.interrupt());
    this.rl.once("close", () => {
      if (this.suspended) return;
      this.closed = true;
      this.command?.(); this.command = undefined;
      this.confirmation?.(false);
      this.onEOF();
    });
  }

  private clearDisplay(): void {
    if (!this.tty || !this.rl || !this.promptVisible) return;
    const rows = this.rl.getCursorPos().rows + (this.previewVisible ? 1 : 0);
    readline.cursorTo(this.output as Writable, 0);
    if (rows) readline.moveCursor(this.output as Writable, 0, -rows);
    readline.clearScreenDown(this.output as Writable);
    this.promptVisible = false; this.previewVisible = false;
  }

  private draw(): void {
    if (!this.rl || this.closed || this.suspended || !this.tty) return;
    this.clearDisplay();
    if (this.pending) {
      // Keep incomplete streamed lines to one display row; the complete line is
      // committed unabridged once it arrives. This avoids unbounded redraw state.
      let preview = this.pending;
      const width = Math.max(1, (this.output.columns ?? 80) - 2);
      if (Bun.stringWidth(preview) > width) {
        preview = terminalText(preview);
        while (preview && Bun.stringWidth(preview) > width - 1) preview = preview.slice(0, -1);
        preview += "…";
      }
      this.output.write(preview + "\n"); this.previewVisible = true;
    }
    // readline's refresh moves up from its previously rendered cursor row.
    // We already cleared that input before writing transcript lines. Restore
    // that vertical position so refresh cannot erase the new transcript.
    const previousRows = this.rl.getCursorPos().rows;
    if (previousRows) this.output.write("\n".repeat(previousRows));
    this.rl.setPrompt(paint(this.promptText, this.confirmation ? "33" : "36", this.color));
    this.rl.prompt(true); this.promptVisible = true;
  }

  write(text: string): void {
    const safe = terminalText(text);
    const styled = safe.split("\n").map((line) => {
      const code = /^(?:\[error\]|✗)/.test(line) ? "31" : /^✓/.test(line) ? "32"
        : /^(?:•|\[skills\]|\[cancel)/.test(line) ? "33" : /^CASPER/.test(line) ? "1;36" : undefined;
      return code ? paint(line, code, this.color) : line;
    }).join("\n");
    this.writeFormatted(styled);
  }

  private writeFormatted(text: string): void {
    if (this.suspended) { this.suspendedOutput += text; return; }
    if (!this.tty || !this.rl || this.closed) { this.output.write(text); return; }
    this.clearDisplay();
    const combined = this.pending + text;
    const last = combined.lastIndexOf("\n");
    if (last !== -1) this.output.write(combined.slice(0, last + 1));
    this.pending = combined.slice(last + 1);
    // Bound pathological no-newline output while keeping all text in scrollback.
    if (this.pending.length > 4096) { this.output.write(this.pending + "\n"); this.pending = ""; }
    this.draw();
  }

  assistant(delta: string): void {
    if (!this.color && (!this.tty || !this.rl)) {
      const text = terminalText(delta);
      this.output.write(text);
      if (text) this.plainAssistantOpen = !text.endsWith("\n");
      return;
    }
    // Buffer only the unfinished line for Markdown. Preview streams immediately.
    this.markdownPending += terminalText(delta);
    const lines = this.markdownPending.split("\n");
    this.markdownPending = lines.pop()!;
    for (const line of lines) {
      if (this.tty && this.rl) { this.clearDisplay(); this.pending = ""; }
      this.writeFormatted(this.markdown.line(line) + "\n");
    }
    if (this.markdownPending.length > 4096) {
      if (this.tty && this.rl) { this.clearDisplay(); this.pending = ""; }
      this.writeFormatted(this.markdown.line(this.markdownPending) + "\n"); this.markdownPending = "";
    }
    if (this.tty && this.rl) {
      this.clearDisplay(); this.pending = this.markdown.line(this.markdownPending, false); this.draw();
    }
  }

  endAssistant(): void {
    if (this.plainAssistantOpen) {
      this.output.write("\n");
      this.plainAssistantOpen = false;
    }
    if (this.markdownPending) {
      if (this.tty && this.rl) { this.clearDisplay(); this.pending = ""; }
      this.writeFormatted(this.markdown.line(this.markdownPending) + "\n");
      this.markdownPending = "";
    }
    this.markdown.reset();
  }

  readCommand(): Promise<string | undefined> {
    this.endAssistant();
    this.busy = false;
    if (this.closed || !this.rl) return Promise.resolve(undefined);
    this.clearDisplay(); this.promptText = "> ";
    return new Promise((resolve) => {
      this.command = resolve;
      if (this.tty) this.draw(); else { this.rl!.setPrompt("> "); this.rl!.prompt(); }
    });
  }

  private acceptLine(line: string): void {
    if (this.closed || !this.rl || this.discardingInput) return;
    if (this.tty) {
      // readline has already echoed Enter and cleared its line/cursor state.
      const rows = Math.floor(Bun.stringWidth(this.promptText + line) / (this.output.columns ?? 80)) + 1;
      readline.moveCursor(this.output as Writable, 0, -rows - (this.previewVisible ? 1 : 0));
      readline.cursorTo(this.output as Writable, 0); readline.clearScreenDown(this.output as Writable);
      this.promptVisible = false; this.previewVisible = false;
    }
    if (this.confirmation) { this.confirmation(line.trim() === "yes"); return; }
    if (this.command) {
      const resolve = this.command; this.command = undefined; this.busy = true;
      if (this.tty) this.output.write(paint(`> ${terminalText(line)}\n`, "36", this.color));
      this.promptText = "working › ";
      this.draw(); resolve(line); return;
    }
    // Do not queue pasted/early input, and never let it answer a later approval.
    if (this.tty) {
      this.draw();
      this.rl.write(line);
      this.write("[input] Still working; draft retained. Press Enter again when ready.\n");
    }
  }

  private replaceDraft(line: string, cursor = line.length): void {
    if (!this.rl || this.closed) return;
    if (!this.tty) {
      // readline keeps a separate unfinished-line buffer in plain mode. Flush
      // and discard it through the public interface at each approval transition;
      // stale fragments must never become answers (or later commands).
      this.discardingInput = true;
      try { this.rl.write("\n"); }
      finally { this.discardingInput = false; }
      return;
    }
    if (!this.promptVisible) this.draw();
    this.rl.write(null, { ctrl: true, name: "a" });
    this.rl.write(null, { ctrl: true, name: "k" });
    this.rl.write(line);
    // Use readline's public editing operations, not private cursor state.
    for (const _char of Array.from(line.slice(cursor))) this.rl.write(null, { name: "left" });
  }

  confirm(preview: string, question: string, signal?: AbortSignal): Promise<boolean> {
    if (!this.rl || this.closed || this.confirmation || signal?.aborted) return Promise.resolve(false);
    if ((this.input as NodeJS.ReadStream).isTTY && !this.tty) {
      // In cooked mode the OS may withhold pretyped characters until Enter.
      // readline cannot clear that unseen buffer: fail closed, never guess fresh consent.
      this.write("[input] Exact approval denied: use an interactive terminal with TERM other than dumb and output not redirected.\n");
      return Promise.resolve(false);
    }
    this.endAssistant(); this.clearDisplay();
    this.savedDraft = { line: this.rl.line, cursor: this.rl.cursor };
    this.replaceDraft("");
    this.write(preview);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        this.clearDisplay(); this.confirmation = undefined;
        this.replaceDraft(""); this.promptText = "working › ";
        const draft = this.savedDraft; this.savedDraft = undefined;
        if (draft) this.replaceDraft(draft.line, draft.cursor);
        this.draw(); resolve(approved);
      };
      const cancel = () => finish(false);
      this.confirmation = finish;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      this.clearDisplay(); this.promptText = question;
      if (this.tty) this.draw(); else { this.rl!.setPrompt(question); this.rl!.prompt(); }
    });
  }

  /** Temporarily lend the streams to the runtime's picker, never run two editors.
   * Cooked/redirected terminals use the plain /model command instead. */
  modelPickerHost(): RuntimeModelPickerHost | undefined {
    if (!this.tty || !this.rl || this.closed) return undefined;
    return { run: async (operation) => {
      if (!this.rl || this.closed || this.suspended || this.confirmation) throw new Error("Terminal is unavailable for model selection.");
      this.endAssistant(); this.clearDisplay();
      const draft = { line: this.rl.line, cursor: this.rl.cursor };
      if (this.pending) { this.output.write(this.pending + "\n"); this.pending = ""; }
      this.suspended = true;
      this.rl.close(); this.rl = undefined;
      try {
        return await operation({ input: this.input, output: this.output, color: this.color,
          onEOF: () => { this.closed = true; this.onEOF(); } });
      } finally {
        this.suspended = false;
        if (!this.closed) {
          this.start();
          this.replaceDraft(draft.line, draft.cursor);
        }
        const output = this.suspendedOutput; this.suspendedOutput = "";
        if (output) this.writeFormatted(output);
      }
    } };
  }

  interrupt(): void {
    if (this.closed) return;
    if (this.confirmation) this.confirmation(false);
    if (this.busy) { this.onInterrupt(); return; }
    if (this.rl?.line) { this.clearDisplay(); this.replaceDraft(""); this.draw(); }
    else this.close();
  }

  close(): void {
    if (this.closed) return;
    this.endAssistant(); this.clearDisplay();
    this.rl?.close(); this.closed = true;
  }
}
