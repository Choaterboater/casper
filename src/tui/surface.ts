import { CombinedAutocompleteProvider, type AutocompleteProvider, Editor, matchesKey, Text, TuiMainScreen, truncateToWidth } from "@earendil-works/pi-tui";
import type { RuntimeModelPickerHost, RuntimePickerIO } from "../runtime/types";
import { COMMANDS } from "./commands";
import { MarkdownFormatter, paint, terminalText } from "./format";
import { StreamTerminal } from "./stream-terminal";

class PromptEditor extends Editor {
  prompt = () => "> ";
  override render(width: number): string[] {
    const prefix = this.prompt();
    return super.render(Math.max(1, width - prefix.length)).map((line, index) =>
      truncateToWidth((index === 1 ? prefix : " ".repeat(prefix.length)) + line, width));
  }
}

/** Main-screen renderer: terminal scrollback, one editor, no autonomous input queue. */
export class TerminalSurface {
  private readonly tui: TuiMainScreen;
  private readonly editor: PromptEditor;
  private readonly transcript = new Text("", 0, 0);
  private text = "";
  private status = "";
  private cwd = "";
  private autocomplete?: AutocompleteProvider;
  private started = false;
  private closed = false;
  private suspended = false;
  private busy = false;
  private command?: (text?: string) => void;
  private confirmation?: (approved: boolean) => void;
  private assistantPending = "";
  private plainAssistantOpen = false;
  private readonly markdown: MarkdownFormatter;

  constructor(private readonly io: RuntimePickerIO, private readonly cancel: () => void, private readonly eof: () => void) {
    this.markdown = new MarkdownFormatter(io.color);
    this.tui = new TuiMainScreen(new StreamTerminal(io, () => this.close()));
    const accent = (text: string) => paint(text, "36", io.color);
    const muted = (text: string) => paint(text, "2", io.color);
    this.editor = new PromptEditor(this.tui, { borderColor: accent, selectList: {
      selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: muted,
    } }, { autocompleteMaxVisible: 7 });
    this.editor.prompt = () => this.busy && !this.confirmation ? "working › " : "> ";
    this.editor.onSubmit = value => {
      if (this.confirmation) { this.confirmation(value.trim() === "yes"); return; }
      if (!this.command) {
        this.editor.setText(value);
        this.write("[input] Still working; draft retained. Press Enter again when ready.\n");
        return;
      }
      const resolve = this.command; this.command = undefined; this.busy = true;
      this.configureAutocomplete();
      this.editor.addToHistory(value); this.editor.setText("");
      this.write(paint(`> ${terminalText(value)}\n`, "36", io.color));
      resolve(value);
    };
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.editor);
    this.tui.addChild({ render: width => [truncateToWidth((this.busy ? "working › " : "") + (this.status || "Casper · / for commands"), width)], invalidate() {} });
    this.tui.setFocus(this.editor);
    this.tui.addInputListener(data => {
      if (matchesKey(data, "enter") && this.editor.isShowingAutocomplete()) {
        if (COMMANDS.some(command => this.editor.getText().trim().split(/\s+/)[0] === `/${command.name}`)) {
          this.editor.handleInput("\x1b"); // Submit exact commands literally, not a stale completion.
        } else { this.editor.handleInput("\t"); return { consume: true }; }
      }
      if (matchesKey(data, "ctrl+c")) { this.interrupt(); return { consume: true }; }
      if (matchesKey(data, "ctrl+d") && !this.editor.getText()) { this.close(); return { consume: true }; }
      if (matchesKey(data, "escape") && (this.busy || this.confirmation)) {
        if (this.confirmation) this.confirmation(false); else this.cancel();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+l")) { this.tui.requestRender(true); return { consume: true }; }
      return undefined;
    });
  }

  start(): void { if (!this.started && !this.closed) { this.started = true; this.tui.start(); } }
  setStatus(status: string, cwd: string): void {
    this.status = terminalText(status).replace(/[\r\n\t]/g, " ");
    if (cwd !== this.cwd) {
      this.cwd = cwd;
      const provider = new CombinedAutocompleteProvider(COMMANDS, cwd);
      this.autocomplete = {
        triggerCharacters: ["/", "@"],
        getSuggestions: async (...args) => {
          const result = await provider.getSuggestions(...args);
          if (!result) return null;
          return { ...result, items: result.items.filter(item =>
            [item.value, item.label, item.description ?? ""].every(value => terminalText(value) === value && !/[\r\n\t]/.test(value))) };
        },
        applyCompletion: (lines, row, col, item, prefix) => {
          if (prefix.startsWith("/") && lines.length === 1 && !/\s/.test(lines[0]!)) {
            const text = `/${item.value} `;
            return { lines: [text], cursorLine: 0, cursorCol: text.length };
          }
          return provider.applyCompletion(lines, row, col, item, prefix);
        },
      };
      this.configureAutocomplete();
    }
    this.render();
  }
  private configureAutocomplete(): void {
    const provider = this.autocomplete;
    if (!provider) return;
    this.editor.setAutocompleteProvider(this.busy || this.confirmation
      ? { ...provider, triggerCharacters: [], getSuggestions: async () => null } : provider);
  }
  private render(): void { if (this.started && !this.suspended && !this.closed) this.tui.requestRender(); }
  write(text: string): void {
    if (!this.started) { this.io.output.write(text); return; }
    this.text += text;
    this.transcript.setText(this.text.replace(/\n$/, ""));
    this.render();
  }
  assistant(delta: string): void {
    if (!this.started) {
      const text = terminalText(delta); this.io.output.write(text);
      if (text) this.plainAssistantOpen = !text.endsWith("\n");
      return;
    }
    this.assistantPending += terminalText(delta);
    const lines = this.assistantPending.split("\n");
    this.assistantPending = lines.pop()!;
    for (const line of lines) this.text += this.markdown.line(line) + "\n";
    this.transcript.setText(this.text + this.markdown.line(this.assistantPending, false));
    this.render();
  }
  endAssistant(): void {
    if (this.plainAssistantOpen) { this.io.output.write("\n"); this.plainAssistantOpen = false; }
    if (this.assistantPending) this.write(this.markdown.line(this.assistantPending) + "\n");
    this.assistantPending = ""; this.markdown.reset();
  }
  readCommand(): Promise<string | undefined> {
    this.endAssistant(); this.busy = false; this.configureAutocomplete();
    if (this.closed) return Promise.resolve(undefined);
    return new Promise(resolve => { this.command = resolve; this.render(); });
  }
  confirm(preview: string, question: string, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || this.suspended || this.confirmation || signal?.aborted) return Promise.resolve(false);
    this.endAssistant();
    const draft = this.editor.getExpandedText();
    this.editor.setText(""); // Pretyped drafts never answer approval.
    this.write(terminalText(preview + question) + "\n");
    return new Promise(resolve => {
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return; settled = true;
        signal?.removeEventListener("abort", cancel);
        this.confirmation = undefined;
        this.editor.setText(draft); this.render(); resolve(approved);
      };
      const cancel = () => finish(false);
      this.confirmation = finish; this.configureAutocomplete();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
  exclusiveHost(): RuntimeModelPickerHost | undefined {
    if (this.closed || this.suspended || this.confirmation || !this.started) return undefined;
    return { run: async operation => {
      if (this.closed || this.suspended || this.confirmation) throw new Error("Terminal input is unavailable.");
      this.endAssistant(); this.suspended = true; this.tui.stop();
      try { return await operation({ ...this.io, onEOF: () => this.close() }); }
      finally {
        this.suspended = false;
        if (!this.closed) { this.tui.start(); this.tui.requestRender(true); }
      }
    } };
  }
  interrupt(): void {
    if (this.closed) return;
    if (this.confirmation) this.confirmation(false);
    if (this.busy) { this.cancel(); return; }
    if (this.editor.getText()) { this.editor.setText(""); this.render(); }
    else this.close();
  }
  close(): void {
    if (this.closed) return;
    this.endAssistant(); this.closed = true;
    this.confirmation?.(false); this.command?.(); this.command = undefined;
    if (this.started && !this.suspended) this.tui.stop();
    this.eof();
  }
}
