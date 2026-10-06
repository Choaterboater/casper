import {
  CombinedAutocompleteProvider, type AutocompleteProvider, type Component, Editor, getNativeClipboard, type MarkdownTheme,
  matchesKey, setCapabilityOverrides, TuiMainScreen, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RuntimeImage, RuntimeModelPickerHost, RuntimePickerIO, RuntimePickerView } from "../runtime/types";
import { imageLabel, imageMimeType, MAX_IMAGE_BYTES, MAX_IMAGES } from "../app/images";
import { COMMANDS, fitDescriptions, RUNS_DURING_WORK } from "./commands";
import { BUSY_GLYPH, hasTerminalControls, markdownTheme, paint, PROMPT_GLYPH, terminalText } from "./format";
import { GLYPHS } from "./glyphs";
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

/** The key that pastes a picture: Ctrl+V, or Alt+V on Windows, where Ctrl+V is the terminal's own text paste (as in Pi). */
export const PASTE_IMAGE_KEY = process.platform === "win32" ? "alt+v" : "ctrl+v";
/** Where a pasted picture comes from: the system clipboard through pi-tui's helper. Tests swap it.
 * Undefined: no clipboard helper here; null: no picture on the clipboard. */
export const clipboardDefaults: { image: () => Promise<Uint8Array | null | undefined>; text: () => Promise<string | null | undefined> } = {
  image: async () => getNativeClipboard()?.getImage(),
  text: async () => getNativeClipboard()?.getText(),
};

/** Spinner frames (braille; ASCII on the old Windows console); the footer dot and Working panel title cycle through
 * them while background work runs, so activity is visible even between transcript updates. */
const SPINNER_FRAMES = GLYPHS.spinner;
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
  /** What was pasted into the draft, so words Casper reads ("big model:", "?") count only when the person typed them. */
  pasted: string[] = [];
  private pasteBefore?: string;

  override handleInput(data: string): void {
    if (data.includes("\x1b[200~")) this.pasteBefore = this.getExpandedText();
    super.handleInput(data);
    if (this.pasteBefore === undefined || !data.includes("\x1b[201~")) return;
    const before = this.pasteBefore;
    this.pasteBefore = undefined;
    const after = this.getExpandedText();
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0;
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
    const inserted = after.slice(start, after.length - end);
    if (inserted.trim()) this.pasted.push(inserted.trim());
  }

  override setText(text: string): void {
    if (!text) this.pasted = [];
    super.setText(text);
  }

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

/** Who asked a numbered question: Casper itself (choices), Casper's approval boxes, or the AI through its ask tool.
 * An approval box takes no typed answer (typed words are a No) and ctrl+o denies it. */
export type AskOrigin = "ai" | "casper" | "approval";
/** Keys pressed this soon after a box opens are ignored: they were typed before it appeared (mid-sentence), so they
 * never answer it. tests/support/preload.ts sets 0 for the suite; tests/one-input-style.test.ts checks the real wait. */
export const askDefaults = { guardMs: 300 };
/** The muted first line of every question the AI asks, so it never looks like a Casper approval. */
export const AI_ASKS_LABEL = "The AI asks:";

/** Main-screen renderer: terminal scrollback, one editor. Lines typed during work go to the app, never to a question. */
export class TerminalSurface {
  private readonly tui: TuiMainScreen;
  private readonly terminal: StreamTerminal;
  private readonly editor: PromptEditor;
  private readonly transcript = new Transcript();
  private readonly theme: MarkdownTheme;
  private readonly accent: (text: string) => string;
  private readonly muted: (text: string) => string;
  private status = "";
  /** The Working box's lines: the latest steps and what the model is doing now. */
  private activity?: string[];
  /** The task's stages for the footer while work runs; see StepRail. */
  private steps?: string;
  private note = "";
  private noteTimer?: NodeJS.Timeout;
  private exitArmed?: NodeJS.Timeout;
  private onCycleEffort?: () => void;
  private onBusySubmit?: (line: string) => true | string;
  private onExpandLast?: () => void;
  /** "WRITES: <servers> · ctrl+o" while any MCP server has writes on; drawn first, never cut off. */
  private badge?: string;
  /** ctrl+o: turn writes off everywhere. True when something was on. */
  private onWritesRevert?: () => boolean;
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
  /** Closes a picker that gives way to an approval or question (one opened during a task). */
  private slotYield?: () => void;
  /** Raw input is on loan to a line-oriented flow; the surface keeps rendering. */
  private lending = false;
  private command?: (text?: string) => void;
  private pendingAsk?: (answer: string[] | undefined) => void;
  /** The open question and its options sanitized for display; an answer is the caller's own label. */
  private askQuestion?: string;
  /** Who is asking: the AI's own questions carry the "The AI asks:" line; Casper's never do. */
  private askFrom: AskOrigin = "casper";
  private askOptions?: AskOption[];
  private askLabels: string[] = [];
  private askMulti = false;
  private askSelections = new Set<number>();
  private askActiveIndex = 0;
  /** When the open question appeared; keys before askDefaults.guardMs has passed are ignored. */
  private askOpenedAt = 0;
  /** An open list edit: the editor holds the lines; Enter returns them, Esc/Ctrl+C/close return undefined. */
  private pendingEdit?: (lines: string[] | undefined) => void;
  /** The row under the last receipt: a lone key on an empty, idle prompt submits its command. Any other key clears it. */
  private nextKeys?: Map<string, string>;
  private editHeading: string[] = [];
  private message?: StreamingMarkdown;
  /** Pictures pasted into the prompt, by their number in `[image N]`; the app takes them with the request. */
  private pasted = new Map<number, RuntimeImage>();
  /** What was pasted into the line just sent (see PromptEditor.pasted). */
  private submittedPastes: string[] = [];
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
    this.editor.glyph = () => this.pendingAsk || this.pendingEdit ? "?" : this.busy ? BUSY_GLYPH : PROMPT_GLYPH;
    this.editor.paintGutter = text => this.busy && !this.pendingAsk && !this.pendingEdit ? this.muted(text) : this.accent(text);
    this.editor.onSubmit = value => {
      this.submittedPastes = this.editor.pasted;
      this.editor.pasted = [];
      if (this.pendingEdit) { this.pendingEdit(value.split("\n")); return; }
      if (this.pendingAsk) { this.answerAsk(value); return; }
      if (!this.command) {
        // While Casper works the app takes the line (runs it, sends it to the AI or queues it), or says why it waits.
        const answer = value.trim() ? this.onBusySubmit?.(value.trim()) : undefined;
        if (answer === true) {
          this.editor.addToHistory(value); this.editor.setText("");
          this.write(this.accent(`${PROMPT_GLYPH} ${terminalText(value.trim())}`) + "\n");
          return;
        }
        this.editor.setText(value);
        this.editor.pasted = this.submittedPastes;
        // A timed note: the steps and the timer come back on their own.
        this.flashNote(answer ?? "draft kept · Enter again when this task ends", 2400);
        return;
      }
      if (!value.trim()) { this.editor.setText(""); return; } // Enter on an empty box is not a transcript event.
      this.nextKeys = undefined;
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
        const activity = this.activity ? renderPanel(`${SPINNER_FRAMES[this.spinnerFrame]} Working`, this.activity.map(line => truncateToWidth(line, Math.max(1, width - 4))), width, this.io.color, "accent") : [];
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
      // ctrl+o turns MCP writes off at once, even while busy or while a question is open; an open
      // approval is denied, so a change can't slip through while writes go off.
      if (matchesKey(data, "ctrl+o")) {
        const reverted = this.onWritesRevert?.() ?? false;
        if (!reverted) { this.flashNote("writes are already off"); return { consume: true }; }
        if (this.askFrom === "approval") this.pendingAsk?.(undefined);
        this.flashNote("Writes are off now");
        return { consume: true };
      }
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
      if (matchesKey(data, "escape") && (this.busy || this.pendingAsk || this.pendingEdit)) {
        if (this.pendingAsk) this.pendingAsk(undefined);
        else if (this.pendingEdit) this.pendingEdit(undefined);
        else this.cancel();
        return { consume: true };
      }
      // A box that just opened ignores keys for a moment: they were typed before it appeared.
      if (this.pendingAsk && Date.now() - this.askOpenedAt < askDefaults.guardMs) return { consume: true };
      if (this.nextKeys) {
        // Only a key pressed at the idle, empty prompt picks from the row; the row never answers a question.
        const offered = this.command && !this.waiting && !this.busy && !this.editor.getText() ? this.nextKeys.get(data) : undefined;
        this.nextKeys = undefined;
        if (offered !== undefined) { this.editor.onSubmit?.(offered); return { consume: true }; }
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
      // A picture from the clipboard goes in as [image N]; with no picture, the clipboard's text is pasted.
      if (matchesKey(data, PASTE_IMAGE_KEY) && !this.pendingAsk) { void this.pasteImage(); return { consume: true }; }
      // The last step in full (an edit's diff, a command's output), even while work runs.
      if (matchesKey(data, "ctrl+t")) {
        if (this.onExpandLast) this.onExpandLast(); else this.flashNote("no step to show yet");
        return { consume: true };
      }
      // Pi's thinking-cycle key. Consumed even while busy so the sequence never lands in the draft.
      if (matchesKey(data, "shift+tab")) {
        // While working too: the app applies it from the model's next step. A question or approval is still open first.
        if (this.pendingAsk || this.pendingEdit) this.flashNote("effort unchanged · answer first");
        else this.onCycleEffort?.();
        return { consume: true };
      }
      return undefined;
    });
  }

  /** Ctrl+V: the clipboard's picture as `[image N]` at the cursor, kept until the request is sent. */
  private async pasteImage(): Promise<void> {
    let bytes: Uint8Array | null | undefined;
    try { bytes = await clipboardDefaults.image(); } catch { bytes = undefined; }
    if (this.closed) return;
    if (!bytes?.length) {
      let text: string | null | undefined;
      try { text = await clipboardDefaults.text(); } catch { text = undefined; }
      // As a bracketed paste: the editor drops terminal control codes from it (and folds a long paste), as for any paste.
      // ESC goes first, so the text can't end the paste early and be read as keys.
      const safe = text?.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
      if (safe) { this.editor.handleInput(`\x1b[200~${safe}\x1b[201~`); this.render(); }
      else this.flashNote("no picture on the clipboard");
      return;
    }
    const mimeType = imageMimeType(bytes);
    if (!mimeType) { this.flashNote("the clipboard picture is not PNG, JPEG, GIF or WebP"); return; }
    if (bytes.length > MAX_IMAGE_BYTES) { this.flashNote(`the clipboard picture is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB; not attached`); return; }
    if (this.pasted.size >= MAX_IMAGES) { this.flashNote(`at most ${MAX_IMAGES} pictures go with one request`); return; }
    const number = Math.max(0, ...this.pasted.keys()) + 1;
    this.pasted.set(number, { data: Buffer.from(bytes).toString("base64"), mimeType });
    this.editor.insertTextAtCursor(`${imageLabel(number)} `);
    this.render();
  }

  /** What was pasted into the line just sent (empty when all of it was typed). */
  takeSubmittedPastes(): string[] {
    const pasted = this.submittedPastes;
    this.submittedPastes = [];
    return pasted;
  }

  /** The pictures pasted for the line just sent; the next request starts again at [image 1]. */
  takePastedImages(): Map<number, RuntimeImage> {
    const pasted = this.pasted;
    this.pasted = new Map();
    return pasted;
  }

  /** An approval box is open: nothing else may take the terminal's input. */
  private get approvalOpen(): boolean { return Boolean(this.pendingAsk) && this.askFrom === "approval"; }

  /** A question, checklist, approval or picker is open: Casper is waiting on the user, not working. */
  private get waiting(): boolean { return Boolean(this.pendingAsk || this.pendingEdit || this.slot || this.lending); }

  private footer(width: number): string {
    if (!this.badge) return this.footerText(width);
    // The badge leads and is never cut off; a window too narrow for it gets the short form.
    const text = visibleWidth(this.badge) + 1 < width ? this.badge : "WRITES · ctrl+o";
    const rest = width - visibleWidth(text) - 1;
    const badge = paint(text, "1;33", this.io.color);
    return rest > 2 ? `${badge} ${this.footerText(rest)}` : truncateToWidth(badge, width);
  }

  private footerText(width: number): string {
    // Waiting on the user: no spinner or running timer, so it never looks busy while it needs Enter.
    if (this.waiting && !this.note) return truncateToWidth(`${this.accent("?")} ${this.accent("waiting for you")}${this.muted(` │ ${this.status || "Casper"}`)}`, width);
    const active = this.busy || this.activity !== undefined;
    const state = active ? this.accent(SPINNER_FRAMES[this.spinnerFrame]) : this.muted("○");
    // A transient note replaces the status line so it is never truncated away; elapsed time
    // rides on the status line so a long-running request is measurable at a glance.
    const elapsed = active && this.activeSince !== undefined && !this.note
      ? this.muted(` · ${formatElapsed(Date.now() - this.activeSince - this.waitedMs)}`) : "";
    // The stages lead, so a narrow window truncates the project and model details, not the progress.
    // Narrow: only the current stage and the time, so neither is cut off.
    const steps = this.steps && visibleWidth(`${this.steps}${elapsed} │ `) + 2 > width ? this.steps.split(" · ").at(-1)! : this.steps;
    const rail = active && steps && !this.note ? `${steps}${elapsed ? this.muted(elapsed) : ""}${this.muted(" │ ")}` : "";
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
  setBusySubmit(handler: ((line: string) => true | string) | undefined): void { this.onBusySubmit = handler; }
  /** Ctrl+T: show the last finished step in full. */
  setExpandLast(handler: (() => void) | undefined): void { this.onExpandLast = handler; }
  setWritesRevert(handler: (() => boolean) | undefined): void { this.onWritesRevert = handler; }
  setBadge(text?: string): void {
    const next = text ? terminalText(text).replace(/\s+/g, " ").trim() || undefined : undefined;
    if (next === this.badge) return;
    this.badge = next;
    this.render();
  }
  /** The footer line at this width (for tests and the layout checks). */
  footerLine(width: number): string { return this.footer(width); }
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
          const items = result.items.filter(item =>
            [item.value, item.label, item.description ?? ""].every(value => !hasTerminalControls(value) && !/[\r\n\t]/.test(value)));
          return { ...result, items: result.prefix.startsWith("/") ? this.fitMenu(items) : items };
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
  /** The Working box: one line, or a few (the latest steps). Undefined or empty removes it. */
  setActivity(status?: string | readonly string[]): void {
    const lines = (typeof status === "string" ? [status] : status ?? [])
      .map(line => terminalText(line).replace(/\s+/g, " ").trim()).filter(Boolean);
    const next = lines.length ? lines : undefined;
    if (next?.join("\n") === this.activity?.join("\n")) return;
    this.activity = next;
    this.updateSpinner();
    this.render();
  }
  private configureAutocomplete(): void {
    const provider = this.autocomplete;
    if (!provider) return;
    if (this.pendingAsk || this.pendingEdit) {
      this.editor.setAutocompleteProvider({ ...provider, triggerCharacters: [], getSuggestions: async () => null });
      return;
    }
    if (!this.busy) { this.editor.setAutocompleteProvider(provider); return; }
    // During a task the menu stays; the commands that wait for the task are dimmed and say so.
    this.editor.setAutocompleteProvider({ ...provider, getSuggestions: async (...args) => {
      const result = await provider.getSuggestions(...args);
      if (!result?.prefix.startsWith("/")) return result;
      return { ...result, items: this.fitMenu(result.items.map(item => RUNS_DURING_WORK.has(item.value) ? item
        : { ...item, label: this.muted(item.label || item.value), description: `waits for this task${item.description ? ` · ${item.description}` : ""}` })) };
    } });
  }
  /** Command descriptions trimmed to the menu at a word, with "…" (see fitDescriptions). */
  private fitMenu<T extends { value: string; label?: string; description?: string }>(items: T[]): T[] {
    return fitDescriptions(items, Math.max(1, (this.io.output.columns ?? 80) - GUTTER));
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
    this.terminal.write(this.bell);
  }
  private bell = "\x07";
  /** What rings: BEL, plus iTerm2's notification (through tmux when inside it); see host-terminal.ts. */
  setBell(sequence: string): void { this.bell = sequence; }
  setAttentionAfter(ms: number): void { this.attentionAfterMs = ms; }

  /** Put text back in the prompt (queued lines of a stopped task), ahead of anything typed since. */
  restoreDraft(text: string): void {
    if (this.closed || !text) return;
    const typed = this.editor.getExpandedText();
    this.editor.setText(typed ? `${text}\n${typed}` : text);
    this.render();
  }

  /** Offer the receipt's next-step row: until another key or command, a lone key from `keys` submits its command. */
  offerNext(keys: ReadonlyMap<string, string> | undefined): void { this.nextKeys = keys?.size ? new Map(keys) : undefined; }

  readCommand(): Promise<string | undefined> {
    if (this.busy) { this.attention(); this.busySince = undefined; }
    // The prompt is back: whatever work was shown in the Working box is over.
    this.endAssistant(); this.busy = false; this.note = ""; this.activity = undefined; this.configureAutocomplete();
    this.updateSpinner();
    if (this.closed) return Promise.resolve(undefined);
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    this.command = resolve; this.render();
    return promise;
  }
  /**
   * One approval box: the context lines go into the transcript, then the numbered panel asks. One key picks (or
   * Up/Down and Enter); typed words are a No, the first choice. It resolves the chosen label, or undefined for Esc,
   * Ctrl+C, ctrl+o, close or abort. A pretyped draft never answers, and nor does a key pressed as the box opened.
   * This channel is the user's alone: the model's ask tool never reaches it.
   */
  async approve(preview: string, question: string, options: { label: string; description?: string }[], signal?: AbortSignal): Promise<string | undefined> {
    this.yieldSlot();
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingEdit || signal?.aborted || !options.length) return undefined;
    this.endAssistant();
    if (preview.trim()) this.write(`${terminalText(preview.replace(/\n+$/, ""))}\n`);
    const answer = await this.ask(question, options, false, signal, "approval");
    if (!answer) return undefined;
    return options.some(option => option.label === answer[0]) ? answer[0] : options[0]!.label;
  }

  /** One structured clarification with a standalone question, navigable choices and free-text input. */
  ask(question: string, options: { label: string; description?: string }[], multi: boolean, signal?: AbortSignal, from: AskOrigin = "casper"): Promise<string[] | undefined> {
    this.yieldSlot();
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingEdit || signal?.aborted) return Promise.resolve(undefined);
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
        ...(from === "ai" ? [this.muted(AI_ASKS_LABEL)] : []),
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
      this.pendingAsk = undefined; this.askQuestion = undefined; this.askOptions = undefined; this.askLabels = []; this.askFrom = "casper";
      this.askMulti = false; this.askSelections.clear(); this.askActiveIndex = 0;
      chosen = answer;
      this.writeBlock(record);
      this.editor.setText(draft); this.configureAutocomplete(); this.updateSpinner(); this.render(); resolve(answer);
    };
    const cancel = () => finish(undefined);
    this.attention();
    this.pendingAsk = finish; this.askQuestion = safeQuestion; this.askOptions = shown; this.askFrom = from;
    this.askLabels = options.map(option => option.label); this.askMulti = multi;
    this.askSelections.clear(); this.askActiveIndex = 0; this.askOpenedAt = Date.now();
    this.configureAutocomplete(); this.updateSpinner(); this.render();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    return promise;
  }

  /** Lines for the user to edit in place, one per editor line, under a heading and a key hint. Enter
   * returns the editor's lines as they stand (blank ones included); Esc, Ctrl+C, abort or close return
   * undefined. A pretyped draft is set aside and restored. The caller records the outcome. */
  editLines(heading: string, hint: string, lines: readonly string[], signal?: AbortSignal): Promise<string[] | undefined> {
    this.yieldSlot();
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingEdit || signal?.aborted) return Promise.resolve(undefined);
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
      : this.askFrom === "approval" ? `Press ${keys} or Up/Down + Enter · Esc is No`
      : `Press ${keys} or Up/Down + Enter · type to answer · Esc skip`;
    const lines = (compact: boolean) => [
      ...(this.askFrom === "ai" ? [this.muted(AI_ASKS_LABEL)] : []),
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

  /** A picker that gives way: an approval or question that opens while it is mounted closes it first. */
  private yieldSlot(): void {
    const close = this.slotYield;
    if (!this.slot || !close) return;
    this.slotYield = undefined; this.slot = undefined;
    close();
    this.updateSpinner();
    this.tui.setFocus(this.editor);
  }

  /** `onYield`: the picker gives way to an approval or question (it must then close itself); see yieldSlot. */
  exclusiveHost(options: { onYield?: () => void } = {}): RuntimeModelPickerHost | undefined {
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingEdit || !this.started) return undefined;
    const claim = () => {
      if (this.closed || this.slot || this.lending || this.approvalOpen) throw new Error("Terminal input is unavailable.");
      this.endAssistant();
    };
    return {
      run: async operation => {
        claim();
        this.lending = true; this.terminal.suspendInput(); this.updateSpinner(); this.render();
        try {
          return await operation({ input: this.io.input, color: this.io.color, onEOF: () => this.close(),
            output: { write: text => this.write(terminalText(text)) },
            show: component => { this.slot = component; this.updateSpinner(); this.render(); },
            requestRender: () => this.render() });
        } finally {
          this.slot = undefined; this.lending = false; this.updateSpinner();
          if (!this.closed) { this.terminal.resumeInput(); this.tui.setFocus(this.editor); this.render(); }
        }
      },
      mount: async operation => {
        claim();
        const view: RuntimePickerView = { tui: this.tui, color: this.io.color, onEOF: () => this.close(),
          show: component => { this.slot = component; this.slotYield = options.onYield; this.updateSpinner(); this.render(); } };
        try { return await operation(view); }
        finally {
          this.slot = undefined; this.slotYield = undefined; this.updateSpinner();
          if (!this.closed) { this.tui.setFocus(this.editor); this.render(); }
        }
      },
    };
  }
  interrupt(): void {
    if (this.closed) return;
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
    this.pendingAsk?.(undefined); this.pendingEdit?.(undefined); this.command?.(); this.command = undefined;
    // The last lines written (a final notice) are drawn before the terminal is handed back.
    if (this.started) { this.tui.renderNow(); this.tui.stop(); }
    this.eof();
  }
}
