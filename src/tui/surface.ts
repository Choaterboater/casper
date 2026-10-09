import {
  CombinedAutocompleteProvider, type AutocompleteProvider, type Component, Editor, getNativeClipboard, type MarkdownTheme,
  matchesKey, setCapabilityOverrides, TuiMainScreen, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RuntimeImage, RuntimeModelPickerHost, RuntimePickerIO, RuntimePickerView } from "../runtime/types";
import { imageLabel, imageMimeType, MAX_IMAGE_BYTES, MAX_IMAGES, promptPath } from "../app/images";
import { readClipboardFiles } from "./clipboard-files";
import { commandMenu, COMMANDS, findCommand, fitDescriptions, menuRunsDuringWork } from "./commands";
import { BUSY_GLYPH, formatElapsed, hasLineControls, hasTerminalControls, markdownTheme, PROMPT_GLYPH, terminalText, tint } from "./format";
import { answerRecord, choiceHint, choiceNumber, KEY_PICK_MAX, keyChoice, OTHER_CHOICE, typedChoice, type PickRecord } from "./choices";
import { typedDuringTask } from "./give-way";
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

const EXIT_NOTE = "Ctrl+C again to exit · Ctrl+D exits too";

/** The key that pastes a picture: Ctrl+V, or Alt+V on Windows, where Ctrl+V is the terminal's own text paste (as in Pi). */
export const PASTE_IMAGE_KEY = process.platform === "win32" ? "alt+v" : "ctrl+v";
/** Where a pasted picture comes from: the system clipboard through pi-tui's helper, and files copied in a file
 * manager through the system's clipboard tool (tui/clipboard-files.ts). Tests swap them.
 * Undefined: no clipboard helper here; null: nothing of that kind on the clipboard. */
export const clipboardDefaults: {
  image: () => Promise<Uint8Array | null | undefined>;
  text: () => Promise<string | null | undefined>;
  files: () => Promise<string[] | null | undefined>;
  /** Copied files are looked for before a picture: on a Mac, where Finder also puts a copied file's icon on the clipboard as a picture. */
  filesFirst: boolean;
} = {
  image: async () => getNativeClipboard()?.getImage(),
  text: async () => getNativeClipboard()?.getText(),
  files: () => readClipboardFiles(),
  filesFirst: process.platform === "darwin",
};

/** Spinner frames (braille; ASCII on the old Windows console); the footer dot and Working panel title cycle through
 * them while background work runs, so activity is visible even between transcript updates. */
const SPINNER_FRAMES = GLYPHS.spinner;
const SPINNER_INTERVAL_MS = 120;

/** The text before the cursor when the prompt is a one-line slash command, for the command menu. */
function slashLine(lines: readonly string[], cursorLine: number, cursorCol: number): string | undefined {
  const before = lines.length === 1 ? (lines[cursorLine] ?? "").slice(0, cursorCol) : "";
  return before.startsWith("/") ? before : undefined;
}

/** The footer status ends with this while Casper waits for a request (src/app/footer.ts). It is the state, so a
 * narrow window cuts the details before it, never the state itself. */
const IDLE_TAIL = " │ idle";
/** Leads the idle footer when the whole line fits. */
const IDLE_HINT = "type / for commands";

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
  private readonly border: (text: string) => string;
  /** The highlighted choice in a list or question. */
  private readonly selected: (text: string) => string;
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
  /** "WRITES: <servers> · Ctrl+O" while any MCP server has writes on; drawn first, never cut off. */
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
  /** Component shown in place of the editor while a picker is mounted. */
  private slot?: Component;
  /** Closes a picker that gives way to an approval or question (one opened during a task). */
  private slotYield?: () => void;
  /** Raw input is on loan to a line-oriented flow; the surface keeps rendering. */
  private lending = false;
  /** A private box (a key, a password) a command typed during a task holds: the task's boxes wait until it closes. */
  private held?: Promise<void>;
  /** The open question or list edit came from a command typed during a task: the task's boxes close it (yieldSlot). */
  private askGivesWay = false;
  private editGivesWay = false;
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
  /** The open question takes a typed or pasted answer (the AI's questions, a name); a picker or approval takes keys only. */
  private askTyped = false;
  /** The Other row was picked: the box takes the typed answer, and Esc goes back to the list. */
  private askOther = false;
  /** The draft the open question set aside, with what is pasted while it is open; back in the prompt when it closes. */
  private askSetAside?: { draft: string; pasted: string[] };
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
  /** How many closed boxes have left their one-line record; a caller that sees it grow writes no outcome line of its own. */
  records = 0;

  constructor(private readonly io: RuntimePickerIO, private readonly cancel: () => void, private readonly eof: () => void) {
    this.theme = markdownTheme(io.color);
    this.accent = text => tint(text, "accent", io.color);
    this.muted = text => tint(text, "muted", io.color);
    this.border = text => tint(text, "border", io.color);
    this.selected = text => tint(text, "selection", io.color);
    // Model-written links show their URL in parentheses instead of hiding it behind an OSC 8 hyperlink.
    setCapabilityOverrides({ hyperlinks: false });
    this.terminal = new StreamTerminal(io, () => this.close());
    this.tui = new StableMainScreen(this.terminal);
    this.editor = new PromptEditor(this.tui, { borderColor: this.border, selectList: {
      selectedPrefix: this.selected, selectedText: this.selected, description: this.muted, scrollInfo: this.muted, noMatch: this.muted,
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
          // After the words streamed so far, not above them: the answer carries on under the line.
          this.endAssistant();
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
        const rule = this.border("─".repeat(width));
        const activity = this.activity ? renderPanel(`${SPINNER_FRAMES[this.spinnerFrame]} Working`, this.activity.map(line => { const fitted = truncateToWidth(line, Math.max(1, width - 4)); return line.startsWith("↳ ") ? this.muted(fitted) : fitted; }), width, this.io.color, "accent") : [];
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
      // A picker or approval takes keys, not pastes: a paste waits as the draft for after the box, so it never lands
      // in the box's answer row. pi-tui delivers a whole paste as one input. A box that takes a typed answer takes it.
      if (this.pendingAsk && !this.askTyped && data.startsWith("\x1b[200~")) {
        this.keepPaste(data.slice(6).replace(/\x1b\[201~$/, ""));
        return { consume: true };
      }
      if (matchesKey(data, "enter") && this.editor.isShowingAutocomplete()) {
        if (/^\/\S/.test(this.editor.getText().trim()) && findCommand(this.editor.getText().trim().split(/\s+/)[0]!)) {
          this.editor.handleInput("\x1b"); // Submit exact commands literally, not a stale completion.
        } else {
          // Consuming skips pi-tui's own post-input render, so paint the completion now.
          this.editor.handleInput("\t"); this.render(); return { consume: true };
        }
      }
      if (matchesKey(data, "ctrl+c")) { this.interrupt(); return { consume: true }; }
      if (matchesKey(data, "ctrl+d") && !this.editor.getText()) { this.close(); return { consume: true }; }
      // Esc while typing an answer goes back to the list (the typed words go); Esc at the list skips.
      if (matchesKey(data, "escape") && this.pendingAsk && this.askTyping()) {
        this.askOther = false; this.editor.setText(""); this.render();
        return { consume: true };
      }
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
      if (this.pendingAsk && this.askOptions && !this.editor.getText() && (matchesKey(data, "up") || matchesKey(data, "down"))) {
        // On an empty answer line, Up/Down goes back to the list from the Other row.
        if (this.askOther) { this.askOther = false; this.askActiveIndex = this.askOptions.length; }
        const count = this.askRows();
        this.askActiveIndex = (this.askActiveIndex + (matchesKey(data, "up") ? count - 1 : 1)) % count;
        this.render(); return { consume: true };
      }
      if (this.pendingAsk && this.askOptions && !this.askOther && !this.editor.getText()) {
        const count = this.askRows();
        if (matchesKey(data, "enter")) { this.chooseAsk(); return { consume: true }; }
        // A choice's number picks it (or toggles it) while nothing is typed; a digit past the last
        // choice, after typed text, or in a list past nine rows (typed, then Enter) is ordinary text.
        const index = keyChoice(data, count);
        if (index >= 0) { this.pickAsk(index); return { consume: true }; }
        if (this.askMulti && matchesKey(data, "space")) {
          const index = this.askActiveIndex;
          if (index === this.askOptions.length) { this.typeAsk(); return { consume: true }; }
          if (this.askSelections.has(index)) this.askSelections.delete(index); else this.askSelections.add(index);
          this.render(); return { consume: true };
        }
      }
      // A picker or approval takes no typed answer: letters go nowhere (its row stays empty), and the footer says which
      // keys work. Past nine rows a row's number is typed, so digits still go in.
      if (this.pendingAsk && !this.askTyped && !data.startsWith("\x1b") && /^[^\x00-\x1f\x7f]+$/.test(data)
        && !((this.askOptions?.length ?? 0) > KEY_PICK_MAX && /^\d+$/.test(data))) {
        this.flashNote(`press a number · Esc ${this.askFrom === "approval" ? "is No" : "skips"}`);
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+l")) { this.tui.requestRender(true); return { consume: true }; }
      // A picture from the clipboard goes in as [image N]; with no picture, copied files' paths, else the clipboard's text.
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

  /** Ctrl+V: the clipboard's picture as `[image N]` at the cursor, kept until the request is sent. With no picture,
   * files copied in a file manager, then the clipboard's text. */
  private async pasteImage(): Promise<void> {
    if (clipboardDefaults.filesFirst && await this.pasteFiles()) return;
    let bytes: Uint8Array | null | undefined;
    try { bytes = await clipboardDefaults.image(); } catch { bytes = undefined; }
    if (this.closed) return;
    if (!bytes?.length) {
      if (!clipboardDefaults.filesFirst && await this.pasteFiles()) return;
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

  /** Copied files go in as quoted paths, as if dropped: a picture among them becomes `[image N]` when the request is
   * sent, with the same checks and limits as a typed path. False when no files were copied. */
  private async pasteFiles(): Promise<boolean> {
    let files: string[] | null | undefined;
    try { files = await clipboardDefaults.files(); } catch { files = undefined; }
    if (this.closed) return true;
    if (!files?.length) return false;
    // A name with a control or bidi character would not show as it is: it is left out, not changed.
    const shown = files.filter((file) => !hasLineControls(file));
    if (shown.length < files.length) this.flashNote("a copied file's name has control characters; left out");
    if (!shown.length) return true;
    // As a paste, so its words never count as typed ones.
    this.editor.handleInput(`\x1b[200~${shown.map(promptPath).join(" ")} \x1b[201~`);
    this.render();
    return true;
  }

  /** A paste while a box is open: kept with the draft the box set aside, and back in the prompt when it closes. */
  private keepPaste(text: string): void {
    const kept = this.askSetAside;
    const safe = text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim();
    if (!kept || !safe) return;
    kept.draft = kept.draft ? `${kept.draft}\n${safe}` : safe;
    kept.pasted.push(safe);
    this.flashNote("paste kept for after this question");
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
    const text = visibleWidth(this.badge) + 1 < width ? this.badge : "WRITES · Ctrl+O";
    const rest = width - visibleWidth(text) - 1;
    const badge = tint(text, "warning", this.io.color, "1");
    return rest > 2 ? `${badge} ${this.footerText(rest)}` : truncateToWidth(badge, width);
  }

  private footerText(width: number): string {
    // The status ends with "idle" when Casper waits for a request; any other state leads the line instead.
    const idle = this.status.endsWith(IDLE_TAIL);
    const details = idle ? this.status.slice(0, -IDLE_TAIL.length) : this.status;
    // Waiting on the user: no spinner or running timer, so it never looks busy while it needs Enter.
    if (this.waiting && !this.note) return truncateToWidth(`${this.accent("?")} ${this.accent("waiting for you")}${this.muted(` │ ${details || "Casper"}`)}`, width);
    // One state mark: the spinner while working.
    const active = this.busy || this.activity !== undefined;
    const state = active ? `${this.accent(SPINNER_FRAMES[this.spinnerFrame])} ` : "";
    // A transient note replaces the status line so it is never truncated away.
    if (this.note) return truncateToWidth(`${state}${this.accent(this.note)}`, width);
    if (active) {
      // The elapsed time always sits right after the spinner (after the stage once there is one), so a long-running
      // request is measurable at a glance, and the stages lead, so a narrow window truncates the details, not them.
      const elapsed = this.activeSince !== undefined ? formatElapsed(Date.now() - this.activeSince) : "";
      // The rail shows while a stage runs. Narrow: only the stage running now and the time, so neither is cut off
      // and a finished stage (✓) never stands for what is happening.
      const running = this.steps?.split(" · ").filter(step => !/ (?:✓|skipped)$/.test(step)) ?? [];
      const steps = !running.length ? undefined : visibleWidth(`${this.steps} · ${elapsed} │ `) + 2 > width ? running.at(-1) : this.steps;
      const lead = [...(steps ? [steps] : []), ...(elapsed ? [this.muted(elapsed)] : [])].join(this.muted(" · "));
      return truncateToWidth(`${state}${lead}${this.muted(`${lead ? " │ " : ""}${details || "Casper"}`)}`, width);
    }
    if (!this.status) return truncateToWidth(this.muted("Casper · / for commands"), width);
    if (!idle) return truncateToWidth(this.muted(this.status), width);
    // Idle: the hint first when the whole line fits; otherwise the details are cut, never the state at the end.
    if (visibleWidth(`${IDLE_HINT} │ ${this.status}`) <= width) return this.muted(`${IDLE_HINT} │ ${this.status}`);
    const room = width - visibleWidth(IDLE_TAIL);
    return this.muted(room > 3 ? `${truncateToWidth(details, room, "…")}${IDLE_TAIL}` : truncateToWidth(this.status, width));
  }

  /** While work runs (a prompt in flight or tool activity), the footer's state mark and the Working panel
 * title cycle through braille frames; idle has no mark. */
private updateSpinner(): void {
    const working = (this.busy || this.activity !== undefined) && !this.closed;
    const active = working && !this.waiting;
    // The timer counts the whole task, a question's wait included, like the Working box's step times.
    if (working) this.activeSince ??= Date.now();
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
          // The command names: each command once, found by its name or an alias (Pi's own list would need an alias row).
          const before = (args[0][args[1]] ?? "").slice(0, args[2]);
          const names = !args[3].force && /^\/\S*$/.test(before) ? commandMenu(before.slice(1)) : undefined;
          const result = names ? (names.length ? { items: names, prefix: before } : null) : await provider.getSuggestions(...args);
          if (!result) return null;
          const items = result.items.filter(item =>
            [item.value, item.label, item.description ?? ""].every(value => !hasTerminalControls(value) && !/[\r\n\t]/.test(value)));
          return { ...result, items: slashLine(args[0], args[1], args[2]) ? this.fitMenu(items) : items };
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
      const line = slashLine(args[0], args[1], args[2]);
      if (!result || !line) return result;
      // The command names, or one command's subcommands (`/mcp ` lists them): the same table decides both.
      const command = /\s/.test(line) ? findCommand(line.split(/\s+/)[0]!) : undefined;
      const runs = (value: string) => !command ? menuRunsDuringWork(value)
        : !command.subcommands?.some(sub => sub.name === value.trim()) || menuRunsDuringWork(command.name, value.trim());
      return { ...result, items: this.fitMenu(result.items.map(item => runs(item.value) ? item
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

  /** Put text back in the prompt (queued lines of a stopped task), ahead of anything typed since. `pasted` is what
   * was pasted into those lines: it stays pasted, so its words still count for nothing. */
  restoreDraft(text: string, pasted: readonly string[] = []): void {
    if (this.closed || !text) return;
    const typed = this.editor.getExpandedText();
    this.editor.setText(typed ? `${text}\n${typed}` : text);
    this.editor.pasted.push(...pasted);
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
    // An approval always comes first: it waits only for a private box, and closes any other command's question.
    if (this.held && !typedDuringTask()) { await this.held; return this.approve(preview, question, options, signal); }
    this.yieldSlot(true);
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingEdit || signal?.aborted || !options.length) return undefined;
    this.endAssistant();
    if (preview.trim()) this.write(`${terminalText(preview.replace(/\n+$/, ""))}\n`);
    const answer = await this.ask(question, options, false, signal, "approval");
    if (!answer) return undefined;
    return options.some(option => option.label === answer[0]) ? answer[0] : options[0]!.label;
  }

  /** One structured clarification with a standalone question and navigable choices. `typed`: the box also takes a typed
   * (or pasted) answer; a picker or an approval doesn't, so keys go to it and a paste waits as the draft for after. */
  ask(question: string, options: { label: string; description?: string }[], multi: boolean, signal?: AbortSignal, from: AskOrigin = "casper",
    typed = from !== "approval", ownRecord?: PickRecord["record"]): Promise<string[] | undefined> {
    if (this.held && !typedDuringTask()) return this.held.then(() => this.ask(question, options, multi, signal, from, typed, ownRecord));
    this.yieldSlot();
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingEdit || signal?.aborted) return Promise.resolve(undefined);
    this.endAssistant(); this.activity = undefined;
    const draft = this.editor.getExpandedText();
    const draftPastes = this.editor.pasted;
    this.editor.setText(""); // Pretyped drafts never answer a question.
    const safeQuestion = terminalText(question);
    const shown = options.map(option => ({
      label: terminalText(option.label).replace(/\s+/g, " ").trim(),
      description: option.description ? terminalText(option.description).replace(/\s+/g, " ").trim() : undefined,
    }));
    // A closed box leaves one line, "<question> → <answer>" or "<question> — skipped", re-fitted per width; the
    // choices and the hint go with the box. It commits after any open tail line.
    let chosen: string[] | undefined;
    // The box's own record (a muted line, or none) for a chosen label.
    let own: string | undefined;
    // Closed for the task's own box: the record says so, and the command can be typed again.
    let gaveWay = false;
    const record: Component = { render: width => {
      if (own) return [this.muted(truncateToWidth(terminalText(own), width, "…"))];
      // The answer as the box showed it: a choice by its shown label, typed words as typed.
      const said = chosen?.map(answer => {
        const index = options.findIndex(option => option.label === answer);
        return index >= 0 ? shown[index]!.label : terminalText(answer).replace(/\s+/g, " ").trim();
      });
      const { question: asked, answer } = answerRecord(safeQuestion, said);
      const lead = from === "ai" ? `${AI_ASKS_LABEL} ` : "";
      // An approval nobody answered is a No; the record says both.
      const tail = answer !== undefined ? ` → ${answer}` : gaveWay ? " — closed for the task's question; type the command again" : from === "approval" ? ` — skipped (${shown[0]?.label ?? "No"})` : " — skipped";
      const paint = (question: string) => `${this.muted(lead)}${this.accent(question)}${answer !== undefined ? `${this.accent(" →")} ${this.selected(answer)}` : this.muted(tail)}`;
      // The answer is never cut: a long question is cut short with "…" to leave it room, and a long answer wraps.
      const room = width - visibleWidth(lead) - visibleWidth(tail);
      if (room >= Math.min(24, visibleWidth(asked))) return [paint(truncateToWidth(asked, Math.max(1, room), "…"))];
      return wrapTextWithAnsi(paint(asked), width).map(line => truncateToWidth(line, width));
    }, invalidate() {} };
    const { promise, resolve } = Promise.withResolvers<string[] | undefined>();
    let settled = false;
    const setAside = this.askSetAside = { draft, pasted: [...draftPastes] };
    const finish = (answer: string[] | undefined) => {
      if (settled) return; settled = true;
      signal?.removeEventListener("abort", cancel);
      gaveWay = this.askGivesWay && answer === undefined && this.yielding;
      this.askGivesWay = false;
      this.pendingAsk = undefined; this.askQuestion = undefined; this.askOptions = undefined; this.askLabels = []; this.askFrom = "casper";
      this.askMulti = false; this.askSelections.clear(); this.askActiveIndex = 0; this.askSetAside = undefined; this.askTyped = false;
      this.askOther = false;
      // Typed words in an approval are a No (the first choice): the record says No, since it is the only record.
      chosen = from === "approval" && answer && !options.some(option => option.label === answer[0]) ? [options[0]!.label] : answer;
      own = chosen?.length === 1 && options.some(option => option.label === chosen![0]) ? ownRecord?.(chosen[0]!) : undefined;
      if (own !== "") { this.writeBlock(record); this.records++; }
      this.restoreSetAside(setAside.draft, setAside.pasted); this.configureAutocomplete(); this.updateSpinner(); this.render(); resolve(answer);
    };
    const cancel = () => finish(undefined);
    this.attention();
    this.pendingAsk = finish; this.askQuestion = safeQuestion; this.askOptions = shown; this.askFrom = from;
    // The task's approvals and questions are never closed for another box; a box a command typed during it opened is.
    this.askGivesWay = typedDuringTask();
    this.askLabels = options.map(option => option.label); this.askMulti = multi; this.askTyped = typed && from !== "approval";
    this.askSelections.clear(); this.askActiveIndex = 0; this.askOpenedAt = Date.now();
    this.configureAutocomplete(); this.updateSpinner(); this.render();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    return promise;
  }

  /** The draft a question or edit box set aside, back in the prompt with what was pasted into it. */
  private restoreSetAside(draft: string, pasted: string[]): void {
    this.editor.setText(draft);
    this.editor.pasted = draft ? pasted : [];
  }

  /** Lines for the user to edit in place, one per editor line, under a heading and a key hint. Enter
   * returns the editor's lines as they stand (blank ones included); Esc, Ctrl+C, abort or close return
   * undefined. A pretyped draft is set aside and restored. The caller records the outcome. */
  editLines(heading: string, hint: string, lines: readonly string[], signal?: AbortSignal): Promise<string[] | undefined> {
    if (this.held && !typedDuringTask()) return this.held.then(() => this.editLines(heading, hint, lines, signal));
    this.yieldSlot();
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingEdit || signal?.aborted) return Promise.resolve(undefined);
    this.endAssistant(); this.activity = undefined;
    const draft = this.editor.getExpandedText();
    const draftPastes = this.editor.pasted;
    this.editor.pasted = [];
    const { promise, resolve } = Promise.withResolvers<string[] | undefined>();
    let settled = false;
    const finish = (edited: string[] | undefined) => {
      if (settled) return; settled = true;
      signal?.removeEventListener("abort", cancel);
      this.pendingEdit = undefined; this.editHeading = []; this.editGivesWay = false;
      this.restoreSetAside(draft, draftPastes); this.configureAutocomplete(); this.updateSpinner(); this.render(); resolve(edited);
    };
    const cancel = () => finish(undefined);
    this.attention();
    this.pendingEdit = finish; this.editGivesWay = typedDuringTask();
    this.editHeading = [this.accent(terminalText(heading)), this.muted(terminalText(hint))];
    this.editor.setText(lines.map(line => terminalText(line).replace(/\s+/g, " ")).join("\n"));
    this.configureAutocomplete(); this.updateSpinner(); this.render();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    return promise;
  }

  /** The whole question and every option, wrapped to the width; the highlighted option in the selection colour.
   * When that is taller than `height` rows, only the highlighted option keeps its description, so the
   * question itself stays on screen instead of scrolling away. */
  private renderAsk(width: number, height: number): string[] {
    const choices = this.askOptions?.length ?? 0;
    // A box that takes a typed answer ends with the Other row; while an answer is typed, it stays highlighted.
    const count = this.askRows();
    const typing = this.askTyping();
    const active = typing ? choices : this.askActiveIndex;
    // A multi-select's numbers toggle rather than pick, so its keys say so.
    const hint = typing ? "Type your answer below · Enter send · Esc back to the list"
      : this.askMulti ? `Press 1-${count} or Space to toggle · Up/Down move · Enter answer · Esc skip`
      : this.askFrom === "approval" ? choiceHint(count, "Esc is No")
      : choiceHint(count, "Esc skip");
    const head = [
      ...(this.askFrom === "ai" ? [this.muted(AI_ASKS_LABEL)] : []),
      ...wrapTextWithAnsi(this.accent(this.askQuestion ?? ""), width),
    ];
    const tail = wrapTextWithAnsi(this.muted(hint), width);
    const option = (index: number, compact: boolean) => {
      const entry = index < choices ? this.askOptions![index]! : { label: OTHER_CHOICE };
      const selected = index === active;
      const marker = choiceNumber(index, count) + (this.askMulti && index < choices ? (this.askSelections.has(index) ? "[x] " : "[ ] ") : "");
      return askOptionLines(selected ? this.selected("→ ") : "  ",
        { label: marker + entry.label, description: compact && !selected ? undefined : entry.description }, width,
        selected ? { label: this.selected, description: this.selected } : { label: text => text, description: this.muted });
    };
    const fit = (lines: string[]) => lines.map(line => truncateToWidth(line, width));
    const all = (compact: boolean) => fit([...head, ...Array.from({ length: count }, (_, index) => option(index, compact)).flat(), ...tail]);
    const full = all(false);
    if (full.length <= height) return full;
    const compact = all(true);
    // Still taller than the screen: the rows around the highlighted one, with how many more are above and below, so
    // the box never pushes its own top into the scrollback (where it would stay once the box closes).
    const room = height - head.length - tail.length - 2;
    if (compact.length <= height || room < 1 || !count) return compact;
    const rows = Array.from({ length: count }, (_, index) => option(index, true));
    let start = active, end = start + 1, used = rows[start]!.length;
    for (let grew = true; grew;) {
      grew = false;
      if (end < count && used + rows[end]!.length <= room) { used += rows[end]!.length; end++; grew = true; }
      if (start > 0 && used + rows[start - 1]!.length <= room) { start--; used += rows[start]!.length; grew = true; }
    }
    return fit([...head, this.muted(start ? `  … ${start} more above` : ""), ...rows.slice(start, end).flat(),
      this.muted(end < count ? `  … ${count - end} more below` : ""), ...tail]);
  }

  /** Enter on the list: the highlighted option, or every toggled option (the highlighted one if none). */
  private chooseAsk(): void {
    if (this.askActiveIndex === (this.askOptions?.length ?? 0)) { this.typeAsk(); return; }
    if (!this.askMulti) { this.pendingAsk?.([this.askLabels[this.askActiveIndex]!]); return; }
    if (!this.askSelections.size) this.askSelections.add(this.askActiveIndex);
    this.pendingAsk?.([...this.askSelections].sort((a, b) => a - b).map(index => this.askLabels[index]!));
  }

  /** A digit, or a number typed and sent past nine rows: picks that choice, or toggles it in a multi-select. */
  private pickAsk(index: number): void {
    this.askActiveIndex = index;
    if (index === (this.askOptions?.length ?? 0)) { this.typeAsk(); return; }
    if (!this.askMulti) { this.chooseAsk(); return; }
    if (this.askSelections.has(index)) this.askSelections.delete(index); else this.askSelections.add(index);
    this.render();
  }

  /** The rows of the open box: its choices, then the Other row where a typed answer is taken. */
  private askRows(): number {
    return (this.askOptions?.length ?? 0) + (this.askTyped ? 1 : 0);
  }

  /** An answer is being typed: the Other row was picked, or letters were typed straight into the box. */
  private askTyping(): boolean {
    return this.askTyped && (this.askOther || this.editor.getText() !== "");
  }

  /** The Other row: the box now takes a typed answer on its input line; Enter sends it, Esc goes back to the list. */
  private typeAsk(): void {
    this.askOther = true;
    this.render();
  }

  /** A nonempty editor submission is free text, except a row's number in a list past nine rows; listed choices are
   * otherwise picked by number or arrow keys. */
  private answerAsk(value: string): void {
    const text = value.trim();
    // While an answer is typed after picking Other, a number is the answer, not a row.
    const index = this.askOther ? -1 : typedChoice(text, this.askRows());
    if (index >= 0) { this.pickAsk(index); return; }
    if (text) this.pendingAsk?.([text]);
  }

  /** A picker that gives way: an approval or question that opens while it is mounted closes it first. So does a question
   * or list edit a command typed during a task opened, for any box but that command's own. */
  private yieldSlot(always = false): void {
    if (!always && typedDuringTask()) return;
    this.yielding = true;
    try {
      if (this.pendingAsk && this.askGivesWay) this.pendingAsk(undefined);
      if (this.pendingEdit && this.editGivesWay) this.pendingEdit(undefined);
    } finally { this.yielding = false; }
    const close = this.slotYield;
    if (!this.slot || !close) return;
    this.slotYield = undefined; this.slot = undefined;
    close();
    this.updateSpinner();
    this.tui.setFocus(this.editor);
  }
  /** yieldSlot is closing a command's question for the task's box. */
  private yielding = false;

  /** A command typed during a task holds the screen for a private box: the task's boxes wait for `release`. */
  private hold(): () => void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.held = promise;
    return () => { if (this.held === promise) this.held = undefined; resolve(); };
  }

  /** `onYield`: the picker gives way to an approval or question (it must then close itself); see yieldSlot. One that
   * can't give way (a private box for a key), opened by a command typed during a task, makes the task's boxes wait. */
  exclusiveHost(options: { onYield?: () => void } = {}): RuntimeModelPickerHost | undefined {
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingEdit || !this.started) return undefined;
    const holds = typedDuringTask() && !options.onYield;
    const claim = () => {
      if (this.closed || this.slot || this.lending || this.approvalOpen) throw new Error("Terminal input is unavailable.");
      this.endAssistant();
    };
    return {
      run: async operation => {
        claim();
        const release = holds ? this.hold() : undefined;
        this.lending = true; this.terminal.suspendInput(); this.updateSpinner(); this.render();
        try {
          return await operation({ input: this.io.input, color: this.io.color, onEOF: () => this.close(),
            output: { write: text => this.write(terminalText(text)) },
            show: component => { this.slot = component; this.updateSpinner(); this.render(); },
            requestRender: () => this.render() });
        } finally {
          release?.();
          this.slot = undefined; this.lending = false; this.updateSpinner();
          if (!this.closed) { this.terminal.resumeInput(); this.tui.setFocus(this.editor); this.render(); }
        }
      },
      mount: async operation => {
        claim();
        const release = holds ? this.hold() : undefined;
        const view: RuntimePickerView = { tui: this.tui, color: this.io.color, onEOF: () => this.close(),
          show: component => { this.slot = component; this.slotYield = options.onYield; this.updateSpinner(); this.render(); } };
        try { return await operation(view); }
        finally {
          release?.();
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
