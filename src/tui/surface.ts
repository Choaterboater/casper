import {
  CombinedAutocompleteProvider, Container, type AutocompleteProvider, type Component, Editor, type MarkdownTheme,
  matchesKey, SelectList, setCapabilityOverrides, Text, TuiMainScreen, truncateToWidth,
} from "@earendil-works/pi-tui";
import type { RuntimeModelPickerHost, RuntimePickerIO, RuntimePickerView } from "../runtime/types";
import { COMMANDS } from "./commands";
import { BUSY_GLYPH, markdownTheme, paint, PROMPT_GLYPH, terminalText } from "./format";
import { StreamingMarkdown } from "./markdown-stream";
import { PANEL_MAX_COLUMNS, renderPanel } from "./presentation";
import { StreamTerminal } from "./stream-terminal";
import { Transcript } from "./transcript";

const GUTTER = 2;

/** pi-tui's main screen clears scrollback and reprints on any height change. Wrapping does not depend
 * on height, so a rows-only resize is absorbed by moving the remembered viewport instead of repainting.
 * The field names below are private in pi-tui's typings; verified against @earendil-works/pi-tui 0.85.1
 * (`doRender` in dist/tui-main-screen.js, the same adjustment its Termux branch computes). */
class StableMainScreen extends TuiMainScreen {
  protected override doRender(): void {
    const frame = this as unknown as { previousWidth: number; previousHeight: number; previousViewportTop: number };
    const rows = this.terminal.rows;
    if (frame.previousHeight > 0 && frame.previousHeight !== rows && frame.previousWidth === this.terminal.columns) {
      frame.previousViewportTop = Math.max(0, frame.previousViewportTop + frame.previousHeight - rows);
      frame.previousHeight = rows;
    }
    super.doRender();
  }
}

const EXIT_NOTE = "Ctrl-C again to exit · Ctrl-D exits too";

/** Braille spinner frames; the footer dot and Working panel title cycle through them while
 * background work runs, so activity is visible even between transcript updates. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;

/** 95000 ms → "1m35s"; hours fold to "1h02m". Same shape the events layer uses for panels. */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  if (minutes) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** Prompt editor with a fixed two-column gutter: the glyph changes with state, the box never moves. */
class PromptEditor extends Editor {
  glyph: () => string = () => PROMPT_GLYPH;
  paintGutter: (text: string) => string = text => text;
  /** Suggestion rows are lifted out of the box; the surface composites them over the transcript. */
  popup: string[] = [];
  private bottom = "";

  protected override renderBottomBorder(width: number, hidden: number): string {
    return this.bottom = super.renderBottomBorder(width, hidden);
  }

  override render(width: number): string[] {
    const lines = super.render(Math.max(1, width - GUTTER));
    const end = lines.lastIndexOf(this.bottom);
    const rule = this.borderColor("─".repeat(GUTTER));
    const gutter = " ".repeat(GUTTER);
    this.popup = end === -1 ? [] : lines.slice(end + 1).map(line => truncateToWidth(gutter + line, width));
    return lines.slice(0, end === -1 ? lines.length : end + 1).map((line, index) =>
      truncateToWidth((index === 0 || index === end ? rule : index === 1 ? this.paintGutter(this.glyph()) + " " : gutter) + line, width));
  }
}

/** Main-screen renderer: terminal scrollback, one editor, no autonomous input queue. */
export class TerminalSurface {
  private readonly tui: TuiMainScreen;
  private readonly terminal: StreamTerminal;
  private readonly editor: PromptEditor;
  private readonly transcript = new Transcript();
  private readonly theme: MarkdownTheme;
  private readonly accent: (text: string) => string;
  private readonly muted: (text: string) => string;
  private status = "";
  private activity?: string;
  private note = "";
  private noteTimer?: NodeJS.Timeout;
  private exitArmed?: NodeJS.Timeout;
  private onCycleEffort?: () => void;
  private cwd = "";
  private autocomplete?: AutocompleteProvider;
  private started = false;
  private closed = false;
  private busy = false;
  private spinnerFrame = 0;
  private spinnerTimer?: NodeJS.Timeout;
  /** When the current busy/activity stretch began; drives the footer's elapsed timer. */
  private activeSince?: number;
  /** Component shown in place of the editor while a picker is mounted. */
  private slot?: Component;
  /** Raw input is on loan to a line-oriented flow; the surface keeps rendering. */
  private lending = false;
  private command?: (text?: string) => void;
  private confirmation?: (approved: boolean) => void;
  private pendingAsk?: (answer: string[] | undefined) => void;
  private askOptions?: { label: string; description?: string }[];
  private askMulti = false;
  private askPanel?: Container;
  private askQuestion?: string;
  private askList?: SelectList;
  private askSelections = new Set<number>();
  private askActiveIndex = 0;
  private message?: StreamingMarkdown;
  private source = "";
  private plainAssistantOpen = false;

  constructor(private readonly io: RuntimePickerIO, private readonly cancel: () => void, private readonly eof: () => void) {
    this.theme = markdownTheme(io.color);
    this.accent = text => paint(text, "36", io.color);
    this.muted = text => paint(text, "2", io.color);
    // Model-written links show their URL in parentheses instead of hiding it behind an OSC 8 hyperlink.
    setCapabilityOverrides({ hyperlinks: false });
    this.terminal = new StreamTerminal(io, () => this.close());
    this.tui = new StableMainScreen(this.terminal);
    this.editor = new PromptEditor(this.tui, { borderColor: this.muted, selectList: {
      selectedPrefix: this.accent, selectedText: this.accent, description: this.muted, scrollInfo: this.muted, noMatch: this.muted,
    } }, { autocompleteMaxVisible: 7 });
    this.editor.glyph = () => this.confirmation || this.pendingAsk ? "?" : this.busy ? BUSY_GLYPH : PROMPT_GLYPH;
    this.editor.paintGutter = text => this.busy && !this.confirmation && !this.pendingAsk ? this.muted(text) : this.accent(text);
    this.editor.onSubmit = value => {
      if (this.pendingAsk) { this.answerAsk(value); return; }
      if (this.confirmation) { this.confirmation(value.trim() === "yes"); return; }
      if (!this.command) {
        this.editor.setText(value);
        this.note = "draft retained · Enter again when idle";
        this.render();
        return;
      }
      if (!value.trim()) { this.editor.setText(""); return; } // Enter on an empty box is not a transcript event.
      const resolve = this.command; this.command = undefined; this.busy = true;
      this.updateSpinner();
      this.configureAutocomplete();
      this.editor.addToHistory(value); this.editor.setText("");
      // Continuation lines of a multiline prompt sit under the text, not under the gutter glyph.
      this.write(terminalText(value).split("\n").map((line, index) => this.accent(`${index ? "  " : `${PROMPT_GLYPH} `}${line}`)).join("\n") + "\n");
      resolve(value);
    };
    // Popovers cover the transcript tail without scrolling. Private login panels
    // instead follow it, keeping copyable authorization URLs and device codes visible.
    this.tui.addChild({
      render: width => {
        const editorLines = this.editor.render(width);
        const rule = this.muted("─".repeat(width));
        const activity = this.activity ? renderPanel(`${SPINNER_FRAMES[this.spinnerFrame]} Working`, [this.activity], Math.min(width, PANEL_MAX_COLUMNS), this.io.color, "accent") : [];
        const askLines = this.askPanel?.render(width) ?? [];
        const block = this.slot ? this.slot.render(width).map(line => truncateToWidth(line, width))
          : this.lending ? [rule, this.muted(truncateToWidth("  exclusive input in progress · Esc or Ctrl+C cancels", width)), rule]
          : this.askPanel ? [rule, ...askLines, rule, ...editorLines]
          : this.editor.popup.length ? [rule, ...this.editor.popup, ...activity, ...editorLines] : [...activity, ...editorLines];
        while (block.length < editorLines.length) block.push("");
        const body = this.transcript.render(width);
        const overlayLines = this.slot ? block.length - editorLines.length
          : this.askPanel ? askLines.length + 2
          : this.editor.popup.length ? this.editor.popup.length + 1 : 0;
        const overflow = this.lending ? 0 : Math.max(0, overlayLines);
        return [...body.slice(0, Math.max(0, body.length - overflow)), ...block, this.footer(width)];
      },
      invalidate: () => { this.transcript.invalidate(); this.editor.invalidate(); this.slot?.invalidate(); },
    });
    this.tui.setFocus(this.editor);
    this.tui.addInputListener(data => {
      if (this.exitArmed && !matchesKey(data, "ctrl+c")) this.disarmExit();
      if (this.slot || this.lending) {
        // A slot-mounted picker cancels itself on Ctrl+C (its own listener below);
        // interrupting here would clear an editor that is not even visible.
        if (this.lending && matchesKey(data, "ctrl+c")) { this.interrupt(); return { consume: true }; }
        return undefined;
      }
      if (matchesKey(data, "enter") && this.editor.isShowingAutocomplete()) {
        if (COMMANDS.some(command => this.editor.getText().trim().split(/\s+/)[0] === `/${command.name}`)) {
          this.editor.handleInput("\x1b"); // Submit exact commands literally, not a stale completion.
        } else { this.editor.handleInput("\t"); return { consume: true }; }
      }
      if (matchesKey(data, "ctrl+c")) { this.interrupt(); return { consume: true }; }
      if (matchesKey(data, "ctrl+d") && !this.editor.getText()) { this.close(); return { consume: true }; }
      if (matchesKey(data, "escape") && (this.busy || this.confirmation || this.pendingAsk)) {
        if (this.confirmation) this.confirmation(false);
        else if (this.pendingAsk) this.pendingAsk(undefined);
        else this.cancel();
        return { consume: true };
      }
      if (this.askList && this.pendingAsk) {
        if ((matchesKey(data, "up") || matchesKey(data, "down")) && !this.editor.getText()) {
          this.askList.handleInput(data); this.render(); return { consume: true };
        }
        if (matchesKey(data, "enter") && !this.editor.getText()) {
          this.askList.handleInput(data); return { consume: true };
        }
        if (this.askMulti && matchesKey(data, "space") && !this.editor.getText()) {
          const selected = this.askList.getSelectedItem();
          if (selected) {
            const index = Number(selected.value);
            if (this.askSelections.has(index)) this.askSelections.delete(index); else this.askSelections.add(index);
            this.buildAskList(); this.render();
          }
          return { consume: true };
        }
      }
      if (matchesKey(data, "ctrl+l")) { this.tui.requestRender(true); return { consume: true }; }
      // Pi's thinking-cycle key. Consumed even while busy so the sequence never lands in the draft.
      if (matchesKey(data, "shift+tab")) {
        if (this.busy || this.confirmation || this.pendingAsk) this.flashNote("effort unchanged · wait until idle");
        else this.onCycleEffort?.();
        return { consume: true };
      }
      return undefined;
    });
  }

  private footer(width: number): string {
    const active = this.busy || this.activity !== undefined;
    const state = active ? this.accent(SPINNER_FRAMES[this.spinnerFrame]) : this.muted("○");
    // A transient note replaces the status line so it is never truncated away; elapsed time
    // rides on the status line so a long-running request is measurable at a glance.
    const elapsed = active && this.activeSince !== undefined && !this.note
      ? this.muted(` · ${formatElapsed(Date.now() - this.activeSince)}`) : "";
    const text = this.note ? this.accent(this.note) : this.muted(this.status || "Casper · / for commands") + elapsed;
    return truncateToWidth(`${state} ${text}`, width);
  }

  /** While work runs (a prompt in flight or tool activity), the footer dot and Working panel
 * title cycle through braille frames; idle returns to the static ○. */
private updateSpinner(): void {
    const active = (this.busy || this.activity !== undefined) && !this.closed;
    if (active) this.activeSince ??= Date.now();
    else this.activeSince = undefined;
    if (active && this.spinnerTimer === undefined) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        this.render();
      }, SPINNER_INTERVAL_MS);
      this.spinnerTimer.unref?.();
    } else if (!active && this.spinnerTimer !== undefined) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
      this.spinnerFrame = 0;
    }
  }

  start(): void {
    if (!this.started && !this.closed) {
      this.started = true;
      // A fresh session owns the whole screen: clear the viewport so a previous run's
      // transcript stays in scrollback instead of stacking the new banner mid-screen.
      this.terminal.clearScreen();
      this.tui.start();
    }
  }
  /** Shift+Tab. Absent on the plain-line terminal; the key is still consumed so it cannot edit the draft. */
  setEffortCycle(handler: (() => void) | undefined): void { this.onCycleEffort = handler; }
  /** Footer note that expires on its own and never clears a newer note (including the exit arm). */
  flashNote(text: string, ms = 1600): void {
    if (this.closed) return;
    const note = terminalText(text).replace(/[\r\n\t]/g, " ").slice(0, 120);
    if (!note) return;
    this.note = note;
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.noteTimer = undefined;
      if (this.note === note) { this.note = ""; this.render(); }
    }, ms);
    this.noteTimer.unref?.();
    this.render();
  }
  setStatus(status: string, cwd: string): void {
    const next = terminalText(status).replace(/[\r\n\t]/g, " ");
    const cwdChanged = cwd !== this.cwd;
    if (!cwdChanged && next === this.status) return;
    this.status = next;
    if (cwdChanged) {
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
    // A note already covers the footer; the stored status appears when it expires.
    if (cwdChanged || !this.note) this.render();
  }
  setActivity(status?: string): void {
    const activity = status ? terminalText(status).replace(/\s+/g, " ").trim() : "";
    const next = activity || undefined;
    if (next === this.activity) return;
    this.activity = next;
    this.updateSpinner();
    this.render();
  }
  private configureAutocomplete(): void {
    const provider = this.autocomplete;
    if (!provider) return;
    this.editor.setAutocompleteProvider(this.busy || this.confirmation || this.pendingAsk
      ? { ...provider, triggerCharacters: [], getSuggestions: async () => null } : provider);
  }
  private render(): void { if (this.started && !this.closed) this.tui.requestRender(); }
  write(text: string): void {
    if (!this.started) { this.io.output.write(text); return; }
    this.transcript.append(text);
    this.render();
  }
  /** A block that renders itself per width (a bordered panel) commits after any open tail line. */
  writeBlock(block: Component): void {
    if (!this.started) { this.io.output.write(block.render(this.io.output.columns ?? 80).join("\n") + "\n"); return; }
    this.transcript.commit(block);
    this.render();
  }
  assistant(delta: string): void {
    if (!this.started) {
      const text = terminalText(delta); this.io.output.write(text);
      if (text) this.plainAssistantOpen = !text.endsWith("\n");
      return;
    }
    this.source += terminalText(delta);
    if (!this.message) this.transcript.preview = this.message = new StreamingMarkdown(this.io.color, this.theme);
    this.message.setText(this.source);
    this.render();
  }
  endAssistant(): void {
    if (this.plainAssistantOpen) { this.io.output.write("\n"); this.plainAssistantOpen = false; }
    if (!this.message) return;
    this.transcript.preview = undefined;
    this.transcript.commit(this.message);
    this.message = undefined; this.source = "";
    this.render();
  }
  readCommand(): Promise<string | undefined> {
    this.endAssistant(); this.busy = false; this.note = ""; this.configureAutocomplete();
    this.updateSpinner();
    if (this.closed) return Promise.resolve(undefined);
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    this.command = resolve; this.render();
    return promise;
  }
  confirm(preview: string, question: string, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || this.slot || this.lending || this.confirmation || signal?.aborted) return Promise.resolve(false);
    this.endAssistant();
    const draft = this.editor.getExpandedText();
    this.editor.setText(""); // Pretyped drafts never answer approval.
    this.write(terminalText(preview + question) + "\n");
    const { promise, resolve } = Promise.withResolvers<boolean>();
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return; settled = true;
      signal?.removeEventListener("abort", cancel);
      this.confirmation = undefined;
      this.editor.setText(draft); this.configureAutocomplete(); this.render(); resolve(approved);
    };
    const cancel = () => finish(false);
    this.confirmation = finish; this.configureAutocomplete(); this.render();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    return promise;
  }

  /** One structured clarification with a standalone question, navigable choices and free-text input. */
  ask(question: string, options: { label: string; description?: string }[], multi: boolean, signal?: AbortSignal): Promise<string[] | undefined> {
    if (this.closed || this.slot || this.lending || this.confirmation || this.pendingAsk || signal?.aborted) return Promise.resolve(undefined);
    this.endAssistant(); this.activity = undefined;
    const draft = this.editor.getExpandedText();
    this.editor.setText(""); // Pretyped drafts never answer a question.
    const safeQuestion = terminalText(question);
    const transcriptEntry = [this.accent(safeQuestion), ...options.flatMap(option => [
      `• ${terminalText(option.label)}`,
      ...(option.description ? [`  ${terminalText(option.description)}`] : []),
    ])].join("\n") + "\n";
    this.askQuestion = safeQuestion;
    const { promise, resolve } = Promise.withResolvers<string[] | undefined>();
    let settled = false;
    const finish = (answer: string[] | undefined) => {
      if (settled) return; settled = true;
      signal?.removeEventListener("abort", cancel);
      this.pendingAsk = undefined; this.askOptions = undefined; this.askMulti = false;
      this.askPanel = undefined; this.askList = undefined; this.askSelections.clear(); this.askActiveIndex = 0;
      this.write(transcriptEntry); this.askQuestion = undefined;
      this.editor.setText(draft); this.configureAutocomplete(); this.render(); resolve(answer);
    };
    const cancel = () => finish(undefined);
    this.pendingAsk = finish; this.askOptions = options; this.askMulti = multi; this.askSelections.clear(); this.askActiveIndex = 0;
    this.buildAskList(); this.configureAutocomplete(); this.render();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    return promise;
  }

  private buildAskList(): void {
    const options = this.askOptions ?? [];
    const items = options.map((option, index) => {
      const marker = this.askMulti ? (this.askSelections.has(index) ? "[x] " : "[ ] ") : "";
      return {
        value: String(index), label: `${marker}${terminalText(option.label)}`,
        description: option.description ? terminalText(option.description) : undefined,
      };
    });
    const list = new SelectList(items, Math.max(1, items.length), {
      selectedPrefix: this.accent, selectedText: this.accent, description: this.muted,
      scrollInfo: this.muted, noMatch: this.muted,
    });
    list.setSelectedIndex(this.askActiveIndex);
    list.onSelectionChange = item => { this.askActiveIndex = Number(item.value); };
    list.onSelect = item => {
      const index = Number(item.value);
      if (!this.askMulti) { this.pendingAsk?.([options[index]!.label]); return; }
      if (!this.askSelections.size) this.askSelections.add(index);
      this.pendingAsk?.([...this.askSelections].sort((a, b) => a - b).map(selected => options[selected]!.label));
    };
    list.onCancel = () => this.pendingAsk?.(undefined);
    const panel = new Container();
    panel.addChild(new Text(this.accent(this.askQuestion ?? ""), 0, 0));
    panel.addChild(list);
    panel.addChild(new Text(this.muted(this.askMulti
      ? "Up/Down: move · Space: toggle · Enter: answer · type: custom answer · Esc: skip"
      : "Up/Down: move · Enter: choose · type: custom answer · Esc: skip"), 0, 0));
    this.askList = list; this.askPanel = panel;
  }

  /** A nonempty editor submission is always free text; listed choices are selected with arrow keys. */
  private answerAsk(value: string): void {
    const text = value.trim();
    if (text) this.pendingAsk?.([text]);
  }

  exclusiveHost(): RuntimeModelPickerHost | undefined {
    if (this.closed || this.slot || this.lending || this.confirmation || !this.started) return undefined;
    const claim = () => {
      if (this.closed || this.slot || this.lending || this.confirmation) throw new Error("Terminal input is unavailable.");
      this.endAssistant();
    };
    return {
      run: async operation => {
        claim();
        this.lending = true; this.terminal.suspendInput(); this.render();
        try {
          return await operation({ input: this.io.input, color: this.io.color, onEOF: () => this.close(),
            output: { write: text => this.write(terminalText(text)) },
            show: component => { this.slot = component; this.render(); },
            requestRender: () => this.render() });
        } finally {
          this.slot = undefined; this.lending = false;
          if (!this.closed) { this.terminal.resumeInput(); this.tui.setFocus(this.editor); this.render(); }
        }
      },
      mount: async operation => {
        claim();
        const view: RuntimePickerView = { tui: this.tui, color: this.io.color, onEOF: () => this.close(),
          show: component => { this.slot = component; this.render(); } };
        try { return await operation(view); }
        finally {
          this.slot = undefined;
          if (!this.closed) { this.tui.setFocus(this.editor); this.render(); }
        }
      },
    };
  }
  interrupt(): void {
    if (this.closed) return;
    if (this.confirmation) this.confirmation(false);
    if (this.pendingAsk) this.pendingAsk(undefined);
    if (this.busy) { this.cancel(); return; }
    if (this.editor.getText()) { this.editor.setText(""); this.render(); return; }
    // An idle, empty editor: the first Ctrl-C only arms exit, so a reflexive Ctrl-C after a task
    // does not end the session; a second within two seconds (or Ctrl-D) exits.
    if (this.exitArmed) { this.close(); return; }
    if (this.noteTimer) { clearTimeout(this.noteTimer); this.noteTimer = undefined; }
    this.note = EXIT_NOTE;
    this.exitArmed = setTimeout(() => this.disarmExit(), 2000);
    this.render();
  }
  private disarmExit(): void {
    if (!this.exitArmed) return;
    clearTimeout(this.exitArmed); this.exitArmed = undefined;
    if (this.note === EXIT_NOTE) { this.note = ""; this.render(); }
  }
  close(): void {
    if (this.closed) return;
    if (this.exitArmed) clearTimeout(this.exitArmed);
    if (this.noteTimer) clearTimeout(this.noteTimer);
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
    this.endAssistant(); this.closed = true;
    this.confirmation?.(false); this.pendingAsk?.(undefined); this.command?.(); this.command = undefined;
    if (this.started) this.tui.stop();
    this.eof();
  }
}
