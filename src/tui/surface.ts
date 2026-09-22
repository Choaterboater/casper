import { CombinedAutocompleteProvider, type AutocompleteProvider, Container, Editor, getCapabilities, Markdown, type MarkdownTheme, matchesKey, setCapabilities, stripTerminalSequences, Text, TuiMainScreen, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import type { RuntimeModelPickerHost, RuntimePickerIO } from "../runtime/types";
import { COMMANDS } from "./commands";
import { paint, styleOutput, terminalText } from "./format";
import { Panel, panelColor, renderPanel, type PanelTone } from "./presentation";
import { StreamTerminal } from "./stream-terminal";

/** Keep Pi's editing/cursor layout, replacing only its horizontal border presentation. */
class PromptEditor extends Editor {
  title = () => "Your message";
  tone: () => PanelTone = () => "accent";
  color = false;
  private above = 0;
  private below = 0;
  protected override renderTopBorder(_width: number, hiddenLineCount: number): string {
    this.above = hiddenLineCount;
    return "";
  }
  protected override renderBottomBorder(_width: number, hiddenLineCount: number): string {
    this.below = hiddenLineCount;
    return "";
  }
  override render(width: number): string[] {
    const inset = width < 8 ? 0 : 2;
    const rows = super.render(width - inset * 2);
    // Pi pads every editor body row, so the second empty row is its bottom border.
    const bottom = rows.indexOf("", 1);
    const scroll = `${this.above ? ` · ${this.above} above` : ""}${this.below ? ` · ${this.below} below` : ""}`;
    const title = this.title() + scroll;
    if (!inset) {
      rows[0] = panelColor(truncateToWidth(title, width, ""), this.tone(), this.color);
      rows[bottom] = panelColor("─".repeat(width), this.tone(), this.color);
      return rows;
    }
    const frame = renderPanel(title, rows.slice(1, bottom), width, this.color, this.tone());
    // Keep autocomplete below the bottom border at Pi's original row offsets.
    return frame.concat(rows.slice(bottom + 1).map(line => `  ${line}  `));
  }
  override handleMouse(event: TuiMouseEvent) {
    const inset = event.width < 8 ? 0 : 2;
    if (event.x < inset || event.x >= event.width - inset) return undefined;
    return super.handleMouse({ ...event, x: event.x - inset, width: event.width - inset * 2 });
  }
}

/** Use Pi's Markdown parser, but always show link destinations as inert text. */
class AssistantMarkdown extends Markdown {
  constructor(private readonly color: boolean, theme: MarkdownTheme) {
    super("", 0, 0, theme, undefined, {
      preserveOrderedListMarkers: true, preserveBackslashEscapes: true, renderLatex: false,
    });
  }
  override render(width: number): string[] {
    const capabilities = getCapabilities();
    // Pi's setting is process-wide. Scope this synchronous override to our render.
    if (capabilities.hyperlinks) setCapabilities({ ...capabilities, hyperlinks: false });
    try {
      const lines = super.render(width);
      return this.color ? lines : lines.map(stripTerminalSequences);
    } finally {
      if (capabilities.hyperlinks) setCapabilities(capabilities);
    }
  }
}

/** Main-screen renderer: terminal scrollback, one input owner, no autonomous input queue. */
export class TerminalSurface {
  private readonly tui: TuiMainScreen;
  private readonly editor: PromptEditor;
  private readonly transcript = new Container();
  private readonly inputRegion = new Container();
  private readonly status = new Text("", 0, 0);
  private readonly markdownTheme: MarkdownTheme;
  private outputBlock?: { text: string; component: Text };
  private assistantBlock?: { text: string; component: AssistantMarkdown };
  private approvalEditor?: PromptEditor;
  private inputHint = "";
  private cwd = "";
  private autocomplete?: AutocompleteProvider;
  private started = false;
  private closed = false;
  private suspended = false;
  private busy = false;
  private command?: (text?: string) => void;
  private confirmation?: (approved: boolean) => void;
  private plainAssistantOpen = false;

  constructor(private readonly io: RuntimePickerIO, private readonly cancel: () => void, private readonly eof: () => void) {
    this.tui = new TuiMainScreen(new StreamTerminal(io, () => this.close()));
    this.tui.setShowHardwareCursor(true);
    const accent = (text: string) => panelColor(text, "accent", io.color);
    const muted = (text: string) => panelColor(text, "muted", io.color);
    this.markdownTheme = {
      heading: text => paint(text, "1;35", io.color), link: accent, linkUrl: muted,
      code: accent, codeBlock: accent, codeBlockBorder: muted, codeBlockIndent: "",
      quote: muted, quoteBorder: muted, hr: muted, listBullet: accent,
      bold: text => paint(text, "1", io.color), italic: text => paint(text, "3", io.color),
      strikethrough: text => paint(text, "9", io.color), underline: text => paint(text, "4", io.color),
    };
    this.editor = this.createEditor();
    this.editor.title = () => this.busy ? "Working · draft only" : "Your message";
    this.editor.tone = () => this.busy ? "muted" : "accent";
    this.editor.onSubmit = value => {
      if (!this.command) return;
      const resolve = this.command; this.command = undefined; this.busy = true;
      this.inputHint = "";
      this.configureAutocomplete();
      this.editor.addToHistory(value);
      this.writePanel("You", value, "accent");
      resolve(value);
    };
    this.inputRegion.addChild(this.editor);
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.inputRegion);
    this.tui.addChild({ render: width => {
      const hint = this.confirmation ? "Type yes to allow · Enter or Esc to deny"
        : this.busy ? this.inputHint || "Esc cancel · drafts are not sent automatically"
        : "Enter send · Shift+Enter newline · / commands";
      return [muted(truncateToWidth(hint, width)), ...this.status.render(width)];
    }, invalidate: () => this.status.invalidate() });
    this.tui.setFocus(this.editor);
    this.tui.addInputListener(data => {
      const editor = this.approvalEditor ?? this.editor;
      if (matchesKey(data, "enter") && this.busy && !this.confirmation) {
        this.inputHint = "Draft retained · not sent. Press Enter when ready.";
        this.render();
        return { consume: true };
      }
      if (matchesKey(data, "enter") && editor.isShowingAutocomplete()) {
        if (COMMANDS.some(command => editor.getText().trim().split(/\s+/)[0] === `/${command.name}`)) {
          editor.handleInput("\x1b"); // Submit exact commands literally, not a stale completion.
        } else { editor.handleInput("\t"); return { consume: true }; }
      }
      if (matchesKey(data, "ctrl+c")) { this.interrupt(); return { consume: true }; }
      if (matchesKey(data, "ctrl+d") && !editor.getText()) { this.close(); return { consume: true }; }
      if (matchesKey(data, "escape") && (this.busy || this.confirmation)) {
        if (this.confirmation) this.confirmation(false); else this.cancel();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+l")) { this.tui.requestRender(true); return { consume: true }; }
      return undefined;
    });
  }

  private createEditor(): PromptEditor {
    const accent = (text: string) => panelColor(text, "accent", this.io.color);
    const muted = (text: string) => panelColor(text, "muted", this.io.color);
    const editor = new PromptEditor(this.tui, { borderColor: accent, selectList: {
      selectedPrefix: accent, selectedText: accent, description: muted, scrollInfo: muted, noMatch: muted,
    } }, { autocompleteMaxVisible: 7 });
    editor.color = this.io.color;
    return editor;
  }

  start(): void { if (!this.started && !this.closed) { this.started = true; this.tui.start(); } }
  setStatus(status: string, cwd: string): void {
    this.status.setText(panelColor(terminalText(status).replace(/[\r\n\t]/g, " "), "muted", this.io.color));
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
    this.editor.disableSubmit = this.busy || !this.command;
    const provider = this.autocomplete;
    if (!provider) return;
    this.editor.setAutocompleteProvider(this.busy || this.confirmation
      ? { ...provider, triggerCharacters: [], getSuggestions: async () => null } : provider);
  }
  private render(): void { if (this.started && !this.suspended && !this.closed) this.tui.requestRender(); }
  write(text: string): void {
    if (!text || this.closed) return;
    this.endAssistant();
    if (!this.started) { this.io.output.write(styleOutput(text, this.io.color)); return; }
    if (!this.outputBlock) {
      const component = new Text("", 0, 0);
      const panel = new Panel("Output", this.io.color, "muted");
      panel.addChild(component); this.transcript.addChild(panel);
      this.outputBlock = { text: "", component };
    }
    this.outputBlock.text += terminalText(text);
    this.outputBlock.component.setText(styleOutput(this.outputBlock.text.replace(/\n$/, ""), this.io.color));
    this.render();
  }
  writePanel(title: string, body: string, tone: PanelTone = "accent"): void {
    if (this.closed) return;
    this.endAssistant(); this.outputBlock = undefined;
    const panel = new Panel(title, this.io.color, tone);
    panel.addChild(new Text(styleOutput(body, this.io.color), 0, 0));
    if (!this.started) { this.io.output.write(panel.render(this.io.output.columns ?? 80).join("\n") + "\n"); return; }
    this.transcript.addChild(panel);
    this.render();
  }
  assistant(delta: string): void {
    if (!delta || this.closed) return;
    const text = terminalText(delta);
    if (!this.started) {
      this.io.output.write(text);
      if (text) this.plainAssistantOpen = !text.endsWith("\n");
      return;
    }
    this.outputBlock = undefined;
    if (!this.assistantBlock) {
      const component = new AssistantMarkdown(this.io.color, this.markdownTheme);
      const panel = new Panel("Casper", this.io.color, "assistant");
      panel.addChild(component); this.transcript.addChild(panel);
      this.assistantBlock = { text: "", component };
    }
    this.assistantBlock.text += text;
    this.assistantBlock.component.setText(this.assistantBlock.text);
    this.render();
  }
  endAssistant(): void {
    if (this.plainAssistantOpen) { this.io.output.write("\n"); this.plainAssistantOpen = false; }
    this.assistantBlock = undefined;
  }
  readCommand(): Promise<string | undefined> {
    this.endAssistant(); this.outputBlock = undefined; this.busy = false; this.inputHint = "";
    if (this.closed) return Promise.resolve(undefined);
    return new Promise(resolve => { this.command = resolve; this.configureAutocomplete(); this.render(); });
  }
  confirm(preview: string, question: string, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || this.suspended || this.confirmation || !this.started || signal?.aborted) return Promise.resolve(false);
    this.writePanel("Approval required · exact operation", preview + question, "warning");
    // A separate, empty editor isolates approval from drafts, history, pastes and undo.
    // The original editor stays intact, including its cursor and autocomplete state.
    const approvalEditor = this.createEditor();
    approvalEditor.title = () => "Approval · type yes to allow";
    approvalEditor.tone = () => "warning";
    this.approvalEditor = approvalEditor;
    this.inputRegion.clear(); this.inputRegion.addChild(approvalEditor); this.tui.setFocus(approvalEditor);
    return new Promise(resolve => {
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return; settled = true;
        signal?.removeEventListener("abort", cancel);
        this.confirmation = undefined; this.approvalEditor = undefined;
        this.inputRegion.clear(); this.inputRegion.addChild(this.editor); this.tui.setFocus(this.editor);
        this.configureAutocomplete(); this.render(); resolve(approved);
      };
      const cancel = () => finish(false);
      this.confirmation = finish;
      approvalEditor.onSubmit = value => finish(value.trim() === "yes");
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel(); else this.render();
    });
  }
  exclusiveHost(): RuntimeModelPickerHost | undefined {
    if (this.closed || this.suspended || this.confirmation || !this.started) return undefined;
    return { run: async operation => {
      if (this.closed || this.suspended || this.confirmation) throw new Error("Terminal input is unavailable.");
      this.endAssistant(); this.outputBlock = undefined; this.suspended = true; this.tui.stop();
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
