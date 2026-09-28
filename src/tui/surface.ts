import {
  CombinedAutocompleteProvider, type AutocompleteProvider, type Component, Editor, type MarkdownTheme,
  matchesKey, setCapabilityOverrides, TuiMainScreen, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RuntimeModelPickerHost, RuntimePickerIO, RuntimePickerView } from "../runtime/types";
import { COMMANDS } from "./commands";
import { BUSY_GLYPH, hasTerminalControls, markdownTheme, paint, PROMPT_GLYPH, terminalText } from "./format";
import { StreamingMarkdown } from "./markdown-stream";
import { renderPanel } from "./presentation";
import { StreamTerminal } from "./stream-terminal";
import { Transcript } from "./transcript";

const GUTTER = 2;

/** pi-tui's main screen clears scrollback and reprints on any height change. Wrapping does not depend
 * on height, so a rows-only resize repaints just the visible rows instead. Terminals re-fit a resized
 * screen differently (some keep the bottom rows; xterm.js drops the rows below the cursor, which are
 * the prompt's lower border and the footer), so no fixed viewport shift is right for all of them. The
 * last `rows` lines are taken as visible and every one is marked changed: Pi's differential pass then
 * moves up from the cursor, which each terminal keeps on its own line, and rewrites the whole screen.
 * The field names below are private in pi-tui's typings; verified against @earendil-works/pi-tui 0.87.0
 * (`doRender` in dist/tui-main-screen.js). */
class StableMainScreen extends TuiMainScreen {
  protected override doRender(): void {
    const frame = this as unknown as { previousLines: string[]; previousWidth: number; previousHeight: number; previousViewportTop: number };
    const rows = this.terminal.rows;
    if (frame.previousHeight > 0 && frame.previousHeight !== rows && frame.previousWidth === this.terminal.columns) {
      const top = Math.max(0, frame.previousLines.length - rows);
      frame.previousViewportTop = top;
      frame.previousHeight = rows;
      // No rendered line is NUL, so each visible row compares as changed and is written again.
      frame.previousLines = frame.previousLines.map((line, index) => index < top ? line : "\u0000");
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

type AskOption = { label: string; description?: string };

/** One clarification option wrapped to the width under a hanging indent: the label after its marker,
 * its description two columns further in. They share a row only when both fit whole, so nothing is cut. */
function askOptionLines(prefix: string, option: AskOption, width: number,
  style: { label: (text: string) => string; description: (text: string) => string }): string[] {
  const indent = " ".repeat(visibleWidth(prefix));
  const { label, description } = option;
  if (indent.length + visibleWidth(label) + (description ? 2 + visibleWidth(description) : 0) <= width) {
    return [`${prefix}${style.label(label)}${description ? style.description(`  ${description}`) : ""}`];
  }
  return [
    ...wrapTextWithAnsi(label, Math.max(1, width - indent.length)).map((line, index) => `${index ? indent : prefix}${style.label(line)}`),
    ...(description ? wrapTextWithAnsi(description, Math.max(1, width - indent.length - 2)).map(line => `${indent}  ${style.description(line)}`) : []),
  ];
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
  /** The task's stages for the footer while work runs; see StepRail. */
  private steps?: string;
  private note = "";
  private noteTimer?: NodeJS.Timeout;
  private exitArmed?: NodeJS.Timeout;
  private onCycleEffort?: () => void;
  private cwd = "";
  private autocomplete?: AutocompleteProvider;
  private started = false;
  private closed = false;
  private busy = false;
  /** When the current request started; a bell rings when one that ran longer than attentionAfterMs
   * finishes or asks something, so a person who looked away comes back. */
  private busySince?: number;
  private attentionAfterMs = 10_000;
  private spinnerFrame = 0;
  private spinnerTimer?: NodeJS.Timeout;
  /** When the current busy/activity stretch began; drives the footer's elapsed timer. */
  private activeSince?: number;
  /** Time the work spent waiting on the user, left out of the footer's elapsed time. */
  private waitedMs = 0;
  private waitStart?: number;
  /** Component shown in place of the editor while a picker is mounted. */
  private slot?: Component;
  /** Raw input is on loan to a line-oriented flow; the surface keeps rendering. */
  private lending = false;
  private command?: (text?: string) => void;
  private confirmation?: (approved: boolean) => void;
  private pendingAsk?: (answer: string[] | undefined) => void;
  /** The open question and its options sanitized for display; an answer is the caller's own label. */
  private askQuestion?: string;
  private askOptions?: AskOption[];
  private askLabels: string[] = [];
  private askMulti = false;
  private askSelections = new Set<number>();
  private askActiveIndex = 0;
  /** An open list edit: the editor holds the lines; Enter returns them, Esc/Ctrl+C/close return undefined. */
  private pendingEdit?: (lines: string[] | undefined) => void;
  private editHeading: string[] = [];
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
    this.editor.glyph = () => this.confirmation || this.pendingAsk || this.pendingEdit ? "?" : this.busy ? BUSY_GLYPH : PROMPT_GLYPH;
    this.editor.paintGutter = text => this.busy && !this.confirmation && !this.pendingAsk && !this.pendingEdit ? this.muted(text) : this.accent(text);
    this.editor.onSubmit = value => {
      if (this.pendingEdit) { this.pendingEdit(value.split("\n")); return; }
      if (this.pendingAsk) { this.answerAsk(value); return; }
      if (this.confirmation) { this.confirmation(value.trim() === "yes"); return; }
      if (!this.command) {
        this.editor.setText(value);
        this.note = "draft retained · Enter again when idle";
        this.render();
        return;
      }
      if (!value.trim()) { this.editor.setText(""); return; } // Enter on an empty box is not a transcript event.
      const resolve = this.command; this.command = undefined; this.busy = true; this.busySince = Date.now();
      this.updateSpinner();
      this.configureAutocomplete();
      this.editor.addToHistory(value); this.editor.setText("");
      // Continuation lines of a multiline prompt sit under the text, not under the gutter glyph.
      this.write(terminalText(value).split("\n").map((line, index) => this.accent(`${index ? "  " : `${PROMPT_GLYPH} `}${line}`)).join("\n") + "\n");
      resolve(value);
    };
    // Popovers cover the transcript tail without scrolling. Private login panels and questions
    // instead follow it: authorization URLs, device codes and the model's lead-in stay visible.
    this.tui.addChild({
      render: width => {
        const editorLines = this.editor.render(width);
        const rule = this.muted("─".repeat(width));
        const activity = this.activity ? renderPanel(`${SPINNER_FRAMES[this.spinnerFrame]} Working`, [this.activity], width, this.io.color, "accent") : [];
        const block = this.slot ? this.slot.render(width).map(line => truncateToWidth(line, width))
          : this.lending ? [rule, this.muted(truncateToWidth("  exclusive input in progress · Esc or Ctrl+C cancels", width)), rule]
          : this.pendingAsk ? [rule, ...this.renderAsk(width, this.terminal.rows - editorLines.length - 2), ...editorLines]
          : this.pendingEdit ? [rule, ...this.editHeading.flatMap(line => wrapTextWithAnsi(line, width)).map(line => truncateToWidth(line, width)), ...editorLines]
          : this.editor.popup.length ? [rule, ...this.editor.popup, ...activity, ...editorLines] : [...activity, ...editorLines];
        while (block.length < editorLines.length) block.push("");
        const body = this.transcript.render(width);
        const overlayLines = this.slot ? block.length - editorLines.length
          : this.pendingAsk || this.pendingEdit ? 0
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
        } else {
          // Consuming skips pi-tui's own post-input render, so paint the completion now.
          this.editor.handleInput("\t"); this.render(); return { consume: true };
        }
      }
      if (matchesKey(data, "ctrl+c")) { this.interrupt(); return { consume: true }; }
      if (matchesKey(data, "ctrl+d") && !this.editor.getText()) { this.close(); return { consume: true }; }
      if (matchesKey(data, "escape") && (this.busy || this.confirmation || this.pendingAsk || this.pendingEdit)) {
        if (this.confirmation) this.confirmation(false);
        else if (this.pendingAsk) this.pendingAsk(undefined);
        else if (this.pendingEdit) this.pendingEdit(undefined);
        else this.cancel();
        return { consume: true };
      }
      if (this.pendingAsk && this.askOptions && !this.editor.getText()) {
        const count = this.askOptions.length;
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
          this.askActiveIndex = (this.askActiveIndex + (matchesKey(data, "up") ? count - 1 : 1)) % count;
          this.render(); return { consume: true };
        }
        if (matchesKey(data, "enter")) { this.chooseAsk(); return { consume: true }; }
        // A choice's number picks it (or toggles it) while nothing is typed; a digit past the last
        // choice, or after typed text, is ordinary text.
        const number = /^[1-9]$/.test(data) ? Number(data) : 0;
        if (number && number <= Math.min(count, 9)) {
          const index = number - 1;
          if (!this.askMulti) { this.askActiveIndex = index; this.chooseAsk(); return { consume: true }; }
          this.askActiveIndex = index;
          if (this.askSelections.has(index)) this.askSelections.delete(index); else this.askSelections.add(index);
          this.render(); return { consume: true };
        }
        if (this.askMulti && matchesKey(data, "space")) {
          const index = this.askActiveIndex;
          if (this.askSelections.has(index)) this.askSelections.delete(index); else this.askSelections.add(index);
          this.render(); return { consume: true };
        }
      }
      if (matchesKey(data, "ctrl+l")) { this.tui.requestRender(true); return { consume: true }; }
      // Pi's thinking-cycle key. Consumed even while busy so the sequence never lands in the draft.
      if (matchesKey(data, "shift+tab")) {
        if (this.busy || this.confirmation || this.pendingAsk || this.pendingEdit) this.flashNote("effort unchanged · wait until idle");
        else this.onCycleEffort?.();
        return { consume: true };
      }
      return undefined;
    });
  }

  /** A question, checklist or approval is open: Casper is waiting on the user, not working. */
  private get waiting(): boolean { return Boolean(this.pendingAsk || this.pendingEdit || this.confirmation); }

  private footer(width: number): string {
    // Waiting on the user: no spinner or running timer, so it never looks busy while it needs Enter.
    if (this.waiting && !this.note) return truncateToWidth(`${this.accent("?")} ${this.accent("waiting for you")}${this.muted(` │ ${this.status || "Casper"}`)}`, width);
    const active = this.busy || this.activity !== undefined;
    const state = active ? this.accent(SPINNER_FRAMES[this.spinnerFrame]) : this.muted("○");
    // A transient note replaces the status line so it is never truncated away; elapsed time
    // rides on the status line so a long-running request is measurable at a glance.
    const elapsed = active && this.activeSince !== undefined && !this.note
      ? this.muted(` · ${formatElapsed(Date.now() - this.activeSince - this.waitedMs)}`) : "";
    // The stages lead, so a narrow window truncates the project and model details, not the progress.
    const rail = active && this.steps && !this.note ? `${this.steps}${elapsed ? this.muted(elapsed) : ""}${this.muted(" │ ")}` : "";
    const text = this.note ? this.accent(this.note) : rail ? rail + this.muted(this.status || "Casper") : this.muted(this.status || "Casper · / for commands") + elapsed;
    return truncateToWidth(`${state} ${text}`, width);
  }

  /** While work runs (a prompt in flight or tool activity), the footer dot and Working panel
 * title cycle through braille frames; idle returns to the static ○. */
private updateSpinner(): void {
    const working = (this.busy || this.activity !== undefined) && !this.closed;
    const active = working && !this.waiting;
    if (working) this.activeSince ??= Date.now();
    else { this.activeSince = undefined; this.waitedMs = 0; this.waitStart = undefined; }
    // The timer pauses while a question waits for the user.
    if (working && this.waiting) this.waitStart ??= Date.now();
    else if (this.waitStart !== undefined) { this.waitedMs += Date.now() - this.waitStart; this.waitStart = undefined; }
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
            [item.value, item.label, item.description ?? ""].every(value => !hasTerminalControls(value) && !/[\r\n\t]/.test(value))) };
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
  setSteps(steps?: string): void {
    const next = steps ? terminalText(steps).replace(/\s+/g, " ").trim() || undefined : undefined;
    if (next === this.steps) return;
    this.steps = next;
    this.render();
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
    this.editor.setAutocompleteProvider(this.busy || this.confirmation || this.pendingAsk || this.pendingEdit
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
  /** The bell (BEL) a terminal turns into a sound, a flash or a dock bounce; rich surface only. */
  private attention(): void {
    if (this.busySince === undefined || this.closed || Date.now() - this.busySince < this.attentionAfterMs) return;
    this.terminal.write("\x07");
  }
  setAttentionAfter(ms: number): void { this.attentionAfterMs = ms; }

  readCommand(): Promise<string | undefined> {
    if (this.busy) { this.attention(); this.busySince = undefined; }
    this.endAssistant(); this.busy = false; this.note = ""; this.configureAutocomplete();
    this.updateSpinner();
    if (this.closed) return Promise.resolve(undefined);
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    this.command = resolve; this.render();
    return promise;
  }
  confirm(preview: string, question: string, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || this.slot || this.lending || this.confirmation || this.pendingEdit || signal?.aborted) return Promise.resolve(false);
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
      this.editor.setText(draft); this.configureAutocomplete(); this.updateSpinner(); this.render(); resolve(approved);
    };
    const cancel = () => finish(false);
    this.attention();
    this.confirmation = finish; this.configureAutocomplete(); this.updateSpinner(); this.render();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    return promise;
  }

  /** One structured clarification with a standalone question, navigable choices and free-text input. */
  ask(question: string, options: { label: string; description?: string }[], multi: boolean, signal?: AbortSignal): Promise<string[] | undefined> {
    if (this.closed || this.slot || this.lending || this.confirmation || this.pendingAsk || this.pendingEdit || signal?.aborted) return Promise.resolve(undefined);
    this.endAssistant(); this.activity = undefined;
    const draft = this.editor.getExpandedText();
    this.editor.setText(""); // Pretyped drafts never answer a question.
    const safeQuestion = terminalText(question);
    const shown = options.map(option => ({
      label: terminalText(option.label).replace(/\s+/g, " ").trim(),
      description: option.description ? terminalText(option.description).replace(/\s+/g, " ").trim() : undefined,
    }));
    // The record re-wraps per width like the live panel, and commits after any open tail line.
    // The record keeps the answer: a ✓ on each chosen option, a typed answer after →, or "skipped".
    let chosen: string[] | undefined;
    const picked = (index: number) => Boolean(chosen?.includes(options[index]!.label));
    const record: Component = { render: width => {
      const typed = chosen?.filter(answer => !options.some(option => option.label === answer)) ?? [];
      return [
        ...wrapTextWithAnsi(this.accent(safeQuestion), width),
        ...shown.flatMap((option, index) => askOptionLines(picked(index) ? "✓ " : "• ", option, width,
          { label: text => picked(index) ? this.accent(text) : text, description: this.muted })),
        ...typed.flatMap(answer => wrapTextWithAnsi(`${this.accent("→")} ${terminalText(answer).replace(/\s+/g, " ")}`, width)),
        ...(chosen === undefined ? [this.muted("  (skipped)")] : []),
      ].map(line => truncateToWidth(line, width));
    }, invalidate() {} };
    const { promise, resolve } = Promise.withResolvers<string[] | undefined>();
    let settled = false;
    const finish = (answer: string[] | undefined) => {
      if (settled) return; settled = true;
      signal?.removeEventListener("abort", cancel);
      this.pendingAsk = undefined; this.askQuestion = undefined; this.askOptions = undefined; this.askLabels = [];
      this.askMulti = false; this.askSelections.clear(); this.askActiveIndex = 0;
      chosen = answer;
      this.writeBlock(record);
      this.editor.setText(draft); this.configureAutocomplete(); this.updateSpinner(); this.render(); resolve(answer);
    };
    const cancel = () => finish(undefined);
    this.attention();
    this.pendingAsk = finish; this.askQuestion = safeQuestion; this.askOptions = shown;
    this.askLabels = options.map(option => option.label); this.askMulti = multi;
    this.askSelections.clear(); this.askActiveIndex = 0;
    this.configureAutocomplete(); this.updateSpinner(); this.render();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    return promise;
  }

  /** Lines for the user to edit in place, one per editor line, under a heading and a key hint. Enter
   * returns the editor's lines as they stand (blank ones included); Esc, Ctrl+C, abort or close return
   * undefined. A pretyped draft is set aside and restored. The caller records the outcome. */
  editLines(heading: string, hint: string, lines: readonly string[], signal?: AbortSignal): Promise<string[] | undefined> {
    if (this.closed || this.slot || this.lending || this.confirmation || this.pendingAsk || this.pendingEdit || signal?.aborted) return Promise.resolve(undefined);
    this.endAssistant(); this.activity = undefined;
    const draft = this.editor.getExpandedText();
    const { promise, resolve } = Promise.withResolvers<string[] | undefined>();
    let settled = false;
    const finish = (edited: string[] | undefined) => {
      if (settled) return; settled = true;
      signal?.removeEventListener("abort", cancel);
      this.pendingEdit = undefined; this.editHeading = [];
      this.editor.setText(draft); this.configureAutocomplete(); this.updateSpinner(); this.render(); resolve(edited);
    };
    const cancel = () => finish(undefined);
    this.attention();
    this.pendingEdit = finish;
    this.editHeading = [this.accent(terminalText(heading)), this.muted(terminalText(hint))];
    this.editor.setText(lines.map(line => terminalText(line).replace(/\s+/g, " ")).join("\n"));
    this.configureAutocomplete(); this.updateSpinner(); this.render();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    return promise;
  }

  /** The whole question and every option, wrapped to the width; the highlighted option is accented.
   * When that is taller than `height` rows, only the highlighted option keeps its description, so the
   * question itself stays on screen instead of scrolling away. */
  private renderAsk(width: number, height: number): string[] {
    const count = Math.min(this.askOptions?.length ?? 0, 9);
    const keys = count > 1 ? `1-${count}` : "1";
    const hint = this.askMulti
      ? `Press ${keys} or Space to toggle · Up/Down move · Enter answer · type to answer · Esc skip`
      : `Press ${keys} or Up/Down + Enter · type to answer · Esc skip`;
    const lines = (compact: boolean) => [
      ...wrapTextWithAnsi(this.accent(this.askQuestion ?? ""), width),
      ...(this.askOptions ?? []).flatMap((option, index) => {
        const selected = index === this.askActiveIndex;
        const number = index < 9 ? `${index + 1} ` : "  ";
        const marker = number + (this.askMulti ? (this.askSelections.has(index) ? "[x] " : "[ ] ") : "");
        return askOptionLines(selected ? this.accent("→ ") : "  ",
          { label: marker + option.label, description: compact && !selected ? undefined : option.description }, width,
          selected ? { label: this.accent, description: this.accent } : { label: text => text, description: this.muted });
      }),
      ...wrapTextWithAnsi(this.muted(hint), width),
    ].map(line => truncateToWidth(line, width));
    const full = lines(false);
    return full.length <= height ? full : lines(true);
  }

  /** Enter on the list: the highlighted option, or every toggled option (the highlighted one if none). */
  private chooseAsk(): void {
    if (!this.askMulti) { this.pendingAsk?.([this.askLabels[this.askActiveIndex]!]); return; }
    if (!this.askSelections.size) this.askSelections.add(this.askActiveIndex);
    this.pendingAsk?.([...this.askSelections].sort((a, b) => a - b).map(index => this.askLabels[index]!));
  }

  /** A nonempty editor submission is always free text; listed choices are picked by number or arrow keys. */
  private answerAsk(value: string): void {
    const text = value.trim();
    if (text) this.pendingAsk?.([text]);
  }

  exclusiveHost(): RuntimeModelPickerHost | undefined {
    if (this.closed || this.slot || this.lending || this.confirmation || this.pendingEdit || !this.started) return undefined;
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
    if (this.pendingEdit) this.pendingEdit(undefined);
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
    this.confirmation?.(false); this.pendingAsk?.(undefined); this.pendingEdit?.(undefined); this.command?.(); this.command = undefined;
    if (this.started) this.tui.stop();
    this.eof();
  }
}
