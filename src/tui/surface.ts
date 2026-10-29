import {
  CombinedAutocompleteProvider, type AutocompleteProvider, type Component, decodeKittyPrintable, Editor, getNativeClipboard, type MarkdownTheme,
  isKeyRelease, matchesKey, setCapabilityOverrides, TuiMainScreen, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RuntimeImage, RuntimeModelPickerHost, RuntimePickerIO, RuntimePickerView } from "../runtime/types";
import { imageLabel, imageMimeType, MAX_IMAGE_BYTES, MAX_IMAGES, promptPath } from "../app/images";
import { readClipboardFiles } from "./clipboard-files";
import { commandMenu, COMMANDS, findCommand, fitDescriptions, type MenuCommand, menuRunsDuringWork } from "./commands";
import { BUSY_GLYPH, dim, formatElapsed, hasLineControls, hasTerminalControls, lineText, markdownTheme, PROMPT_GLYPH, terminalText, tint } from "./format";
import { answerRecord, answerRecordText, choiceHint, choiceNumber, KEY_PICK_MAX, keyChoice, NOTE_CHOICE, OTHER_CHOICE, pickKeysHint, reasonPrefix, typedChoice, type PickRecord } from "./choices";
import { typedDuringTask } from "./give-way";
import { GLYPHS } from "./glyphs";
import { StreamingMarkdown } from "./markdown-stream";
import { renderPanel } from "./presentation";
import { commandPreview } from "./command-preview";
import { readableFooter } from "./footer-layout";
import { pickerOptionLines, pickerWindow } from "./picker";
import { modelReasonLine } from "./model-reason";
import type { HelperActivity } from "../agents/manager";
import { CrewPanel } from "./crew-panel";
import { StreamTerminal } from "./stream-terminal";
import { roleCode } from "./theme";
import { type EntryKind, Transcript } from "./transcript";

const GUTTER = 2;

/** pi-tui's main screen clears scrollback and reprints on any height change. Wrapping does not depend
 * on height, so a rows-only resize repaints just the visible rows instead. Terminals re-fit a resized
 * screen differently (some keep the bottom rows; xterm.js drops the rows below the cursor, which are
 * the prompt's lower border and the footer), so no fixed viewport shift is right for all of them. The
 * last `rows` lines are taken as visible and every one is marked changed: Pi's differential pass then
 * moves up from the cursor, which each terminal keeps on its own line, and rewrites the whole screen.
 * The field names below are private in pi-tui's typings; verified against @earendil-works/pi-tui 1.1.0
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

/** Spinner frames (braille; ASCII on the old Windows console); the footer, the status row and a running step's mark
 * cycle through them while work runs, so activity is visible even between transcript updates. */
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

type AskOption = { label: string; description?: string };

/** How far a cut typed row moves its start forward (or its end back) to begin (or end) with a whole word. */
const WORD_EDGE = 16;
/** Columns the Other row keeps for the words typed after its label; with fewer, the label is just "Other". */
const TYPED_ROOM = 20;

/** The character a key types, however the terminal sends it: as itself, or as a kitty or modifyOtherKeys escape code
 * (the keypad's digits, Shift+letters), which the editor would otherwise insert. Undefined for keys that type nothing. */
export function printableKey(data: string): string | undefined {
  if (!data.startsWith("\x1b")) return /^[^\x00-\x1f\x7f]+$/.test(data) ? data : undefined;
  // A key the keypad sends as a private-use character (its Enter, say) types nothing.
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return /^[\ue000-\uf8ff]$/u.test(kitty) ? undefined : kitty;
  // modifyOtherKeys: ESC [ 27 ; <modifier> ; <code> ~, as pi-tui reads it: Shift alone (Caps and Num Lock aside) types.
  const other = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
  if (!other) return undefined;
  const modifier = (Number(other[1]) - 1) & ~(64 | 128);
  const code = Number(other[2]);
  if ((modifier & ~1) !== 0 || !Number.isFinite(code) || code < 32) return undefined;
  try { return String.fromCodePoint(code); } catch { return undefined; }
}

/** Words typed in a box (an answer on the Other row, a note on an approval's last row) on their row, laid out by `layout` at
 * most `width` columns wide: all of them when they fit in `maxLines` rows, else the part around the cursor (where letters
 * go in, at the end while typing goes on) with … for what is left out. They were cut at 100 characters, so the end of
 * a long answer never showed while it was typed. */
function typedRowLines(text: string, cursor: number, maxLines: number, width: number, layout: (shown: string) => string[]): string[] {
  const chars = Array.from(text);
  const length = chars.length;
  const rows = Math.max(1, maxLines);
  const lines = (start: number, end: number) => {
    let shown = chars.slice(start, end).join("");
    if (start > 0) shown = `…${shown.trimStart()}`;
    if (end < length) shown = `${shown.trimEnd()}…`;
    return layout(shown);
  };
  const fits = (start: number, end: number) => lines(start, end).length <= rows;
  if (visibleWidth(text) <= rows * width && fits(0, length)) return lines(0, length);
  // A row holds at most `width` characters, so the part shown is never longer than this.
  const most = rows * width;
  /** The first `at` in [low, high] found to pass, or high + 1 when none does. Less text mostly fits more easily (a word
   * moving beside the label can break that by a row), and whatever this returns has been tested and passes. */
  const first = (low: number, high: number, passes: (at: number) => boolean) => {
    while (low <= high) { const middle = (low + high) >> 1; if (passes(middle)) high = middle - 1; else low = middle + 1; }
    return low;
  };
  const space = (at: number) => /\s/.test(chars[at] ?? " ");
  // A cut moves to the nearest word edge only while the words next to the cursor stay in view.
  const wordStart = (start: number) => {
    if (space(start - 1)) return start;
    for (let at = start; at < Math.min(start + WORD_EDGE, cursor - WORD_EDGE); at++) if (space(at)) return at + 1;
    return start;
  };
  const wordEnd = (end: number) => {
    if (space(end)) return end;
    for (let at = end - 1; at >= Math.max(end - WORD_EDGE, cursor + WORD_EDGE); at--) if (space(at)) return at;
    return end;
  };
  // Typing at the end, or near it: as much before the cursor as fits, and all that follows it.
  const start = first(Math.max(0, length - most), cursor, at => fits(at, length));
  if (start <= cursor) {
    // A whole first word can take a row more: it may not fit beside the label where a cut word did.
    const word = wordStart(start);
    return lines(word !== start && fits(word, length) ? word : start, length);
  }
  // Typing further back: as much before the cursor as fits, then what fits after it.
  const from = Math.min(cursor, first(Math.max(0, cursor - most), cursor, at => fits(at, cursor)));
  let end = Math.max(cursor, first(cursor, Math.min(length, from + most), at => !fits(from, at)) - 1);
  while (end > cursor && !fits(from, end)) end--;
  const [wordFrom, wordTo] = [wordStart(from), wordEnd(end)];
  return (wordFrom !== from || wordTo !== end) && fits(wordFrom, wordTo) ? lines(wordFrom, wordTo) : lines(from, end);
}

/** Work in progress for the screen: the steps of the open group (rows under the AI's words) and what Casper is doing or
 * waiting for now (the status row above the prompt). `rows` are the raw steps, one per call (Ctrl+O); `plain` the
 * same steps in plain words, shown by default. */
/** `intent`: the AI's last line before the running group of tool calls, put before the status row's words. `headline`:
 * what the status row says while the model reasons, in place of `status` (decision 24); the steps pane never gets it. */
export interface WorkView { rows: readonly string[]; plain?: readonly string[]; status?: string; intent?: string; headline?: string }

/** An intent cut shorter than this says nothing: the row shows the activity alone. */
const MIN_INTENT = 10;

/** The status row's words in `room` columns: the AI's intent first (`Fixing the port test · Running bun test · 4s`) and
 * the first to go when the row is narrow; the activity is cut only when it alone does not fit. */
export function statusWords(status: string, intent: string | undefined, room: number): string {
  const left = room - visibleWidth(status) - 3;
  if (intent && left >= MIN_INTENT) return `${truncateToWidth(intent, left, "…")} · ${status}`;
  return truncateToWidth(status, Math.max(1, room), "…");
}

/** Marks a live row may start with, and the colour each takes; a running step's • becomes the spinner. */
const LIVE_MARK = /^(✓|✗|○|•|–|◆) /;
const SHELL_QUESTION = /^(?:(?:Builder \d+: )?(?:Run this command\?|Reach .+\?|Run outside the sandbox with your GitHub login\?)|Builder \d+ wants to run:)/;

/** Your request as Casper shows it again: ❯ and the words, bold, hanging under the mark, on the theme's userBg bar
 * across the row (none without colour, or when the theme has no bar). */
export function promptEcho(text: string, color: boolean): Component {
  return {
    render: width => {
      const inner = Math.max(1, width - GUTTER);
      const rows = terminalText(text).split("\n").flatMap(line => line ? wrapTextWithAnsi(line, inner) : [""]);
      const bar = color ? roleCode("userBg") : "";
      return rows.map((row, index) => {
        const lead = index ? "  " : `${tint(PROMPT_GLYPH, "accent", color, "1")} `;
        const body = `${lead}${color ? `\x1b[1m${row}\x1b[0m` : row}`;
        if (!bar) return body;
        // Every reset inside the row would also end the bar: it starts again after each one, out to the edge.
        const open = `\x1b[${bar}m`;
        return `${open}${body.replaceAll("\x1b[0m", `\x1b[0m${open}`)}${" ".repeat(Math.max(0, width - visibleWidth(body)))}\x1b[0m`;
      });
    },
    invalidate() {},
  };
}

/** Prompt editor with a fixed two-column gutter: the glyph changes with state, the box never moves. */
class PromptEditor extends Editor {
  glyph: () => string = () => PROMPT_GLYPH;
  paintGutter: (text: string) => string = text => text;
  singleLine: () => boolean = () => false;
  queueHint: () => string | undefined = () => undefined;
  /** Suggestion rows are lifted out of the box; the surface composites them over the transcript. */
  popup: string[] = [];
  private bottom = "";
  /** What was pasted into the draft, so words Casper reads ("big model:", "?") count only when the person typed them. */
  pasted: string[] = [];
  private pasteBefore?: string;

  override handleInput(data: string): void {
    if (data.includes("\x1b[200~")) this.pasteBefore = this.getExpandedText();
    super.handleInput(data);
    if (this.singleLine()) {
      const text = this.getExpandedText();
      if (/[\r\n]/.test(text)) this.setText(text.replace(/[\r\n]+/g, " "));
    }
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
    return lines.slice(0, end === -1 ? lines.length : end + 1).map((line, index) => {
      if (index === 1 && !this.getText() && this.queueHint()) return truncateToWidth(gutter + this.queueHint()!, width);
      return truncateToWidth((index === 0 || index === end ? rule : index === 1 ? this.paintGutter(this.glyph()) + " " : gutter) + line, width);
    });
  }
}

/** Who asked a numbered question: Casper itself (choices), Casper's approval boxes, or the AI through its ask tool.
 * An approval's last row takes a note (a No with it) and Ctrl+X revokes writes. */
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
  /** Work in progress: the open group's steps (live rows under the AI's words) and the status row's words. */
  private work?: { rows: string[]; plain?: string[]; status?: string; intent?: string; headline?: string };
  /** Ctrl+O: the live steps show raw, one row per call, instead of in plain words. For this session. */
  private rawSteps = false;
  private readonly crew = new CrewPanel();
  private crewDetails = false;
  private crewOffset = 0;
  /** The task's stages for the footer while work runs; see StepRail. */
  private steps?: string;
  private note = "";
  private noteTimer?: NodeJS.Timeout;
  private exitArmed?: NodeJS.Timeout;
  private onCycleEffort?: () => void;
  private onBusySubmit?: (line: string) => true | string;
  private onExpandLast?: () => void;
  private userCommands: () => readonly MenuCommand[] = () => [];
  /** "ASKING OFF · /permissions ask" while the shell stops asking, and "ALLOW ALL: <servers>" or "WRITES: <servers>"
   * with "· Ctrl+X" while an MCP server has writes on; drawn first, and shortened before anything of it is cut off. */
  private badge?: string;
  /** Update state from the app: a right-aligned row above the prompt, idle or working. */
  private update?: string;
  /** Ctrl+X: turn writes off everywhere. True when something was on. */
  private onWritesRevert?: () => boolean;
  private onTakeBack?: () => boolean;
  /** Lines typed during the task that the AI hasn't read yet, oldest first. */
  private waitingLines: string[] = [];
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
  private activeWaitedMs = 0;
  private activeWaitingSince?: number;
  /** Component shown in place of the editor while a picker is mounted. */
  private slot?: Component;
  /** Closes a picker that gives way to an approval or question (one opened during a task). */
  private slotYield?: () => void;
  /** Raw input is on loan to a line-oriented flow; the surface keeps rendering. */
  private lending = false;
  /** A private box (a key, a password) a command typed during a task holds: the task's boxes wait until it closes. */
  private held?: Promise<void>;
  /** The open question or input came from a command typed during a task: the task's boxes close it (yieldSlot). */
  private askGivesWay = false;
  private lineGivesWay = false;
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
  /** The question accepts a free answer on its Other row (the AI's questions, a name); an approval has its note row. */
  private askTyped = false;
  /** The Other row was picked: the box takes the typed answer, and Esc goes back to the list. */
  private askOther = false;
  private submittedAskComment = "";
  /** The draft the open question set aside, with what is pasted while it is open; back in the prompt when it closes. */
  private askSetAside?: { draft: string; pasted: string[] };
  /** An empty, one-line input; Enter sends words, Esc/Ctrl+C/close return undefined. */
  private pendingLine?: (text: string | undefined) => void;
  /** The row under the last receipt: a lone key on an empty, idle prompt submits its command. Any other key clears it. */
  private nextKeys?: Map<string, string>;
  private lineHeading: string[] = [];
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
    this.editor.glyph = () => this.pendingAsk || this.pendingLine ? "?" : this.busy ? BUSY_GLYPH : PROMPT_GLYPH;
    this.editor.paintGutter = text => this.busy && !this.pendingAsk && !this.pendingLine ? this.muted(text) : this.accent(text);
    this.editor.singleLine = () => Boolean(this.pendingLine);
    this.editor.queueHint = () => this.busy && !this.waiting ? this.muted("type to queue a message") : undefined;
    this.editor.onSubmit = value => {
      this.submittedPastes = this.editor.pasted;
      this.editor.pasted = [];
      if (this.pendingLine) { this.pendingLine(value.replace(/\s+/g, " ").trim()); return; }
      if (this.pendingAsk) { this.answerAsk(value); return; }
      if (!this.command) {
        // While Casper works the app takes the line (runs it, sends it to the AI or queues it), or says why it waits.
        const answer = value.trim() ? this.onBusySubmit?.(value.trim()) : undefined;
        if (answer === true) {
          this.editor.addToHistory(value); this.editor.setText("");
          // After the words streamed so far, not above them: the answer carries on under the line.
          this.endAssistant();
          this.writeBlock(promptEcho(value.trim(), this.io.color), "line");
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
      // Continuation lines of a multiline prompt sit under the text, not under the gutter glyph. A blank row before it.
      this.writeBlock(promptEcho(value, this.io.color), "group");
      resolve(value);
    };
    // Popovers cover the transcript tail without scrolling. Private login panels and questions
    // instead follow it: authorization URLs, device codes and the model's lead-in stay visible.
    this.tui.addChild({
      render: width => {
        const editorLines = this.editor.render(width);
        const rule = this.border("─".repeat(width));
        const status = [...this.waitingRows(width), ...this.statusRow(width)];
        // Crew rows never own input or displace a picker/approval. Small windows reserve the answer first.
        const crew = this.slot || this.lending ? [] : this.crewRows(Math.max(1, width - 2),
          Math.max(0, this.terminal.rows - editorLines.length - (this.pendingAsk || this.pendingLine ? 10 : 4)));
        const block = this.slot ? this.slot.render(Math.min(120, Math.max(1, width - 2))).map(line => truncateToWidth(`  ${line}`, width))
          : this.lending ? [rule, this.muted(truncateToWidth("  exclusive input in progress · Esc or Ctrl+C cancels", width)), rule]
          : this.pendingAsk ? [this.askRule(Math.min(120, Math.max(1, width - 2))),
            ...this.renderAsk(Math.min(120, Math.max(1, width - 2)), this.terminal.rows - crew.length - (crew.length ? 1 : 0) - (this.shownRows.length ? 2 : 0) - 4),
            this.border("─".repeat(Math.min(120, Math.max(1, width - 2))))]
            .map(line => truncateToWidth(`  ${line}`, width))
          : this.pendingLine ? [rule, ...this.lineHeading.flatMap(line => wrapTextWithAnsi(line, width)).map(line => truncateToWidth(line, width)), ...editorLines]
          : this.editor.popup.length ? [rule, ...this.editor.popup, ...status, ...editorLines] : [...status, ...editorLines];
        if (crew.length) block.unshift(...crew.map(line => truncateToWidth(`  ${line}`, width)), ...(this.pendingAsk ? [""] : []));
        while (!this.pendingAsk && block.length < editorLines.length) block.push("");
        // Notices yield to exclusive input and short screens. Reserve the notice and footer, plus a live row and
        // its gap when steps are shown: a notice must never displace the prompt, crew rows or overflow the live tail.
        const noticeRoom = this.shownRows.length ? 4 : 2;
        if (!this.waiting && block.length + noticeRoom <= this.terminal.rows) {
          block.splice(block.length - editorLines.length, 0, ...this.updateRow(width));
        }
        // The open group's steps show under the AI's words while nothing waits on you, and never more of them than fit
        // above the prompt: a row that ticks off the top of the screen would make the terminal redraw everything.
        this.transcript.live = this.shownRows.length ? this.liveRows : undefined;
        this.transcript.liveCap = Math.max(1, this.terminal.rows - block.length - 3);
        const body = this.transcript.render(width);
        const overlayLines = this.slot ? block.length - editorLines.length
          : this.pendingAsk || this.pendingLine ? 0
          : this.editor.popup.length ? this.editor.popup.length + 1 : 0;
        const overflow = this.lending ? 0 : Math.max(0, overlayLines);
        const shownBody = body.slice(0, Math.max(0, body.length - overflow));
        const gap = this.pendingAsk && shownBody.length && shownBody.at(-1) !== "" ? [""] : [];
        return [...shownBody, ...gap, ...block, this.footer(width)];
      },
      invalidate: () => { this.transcript.invalidate(); this.editor.invalidate(); this.slot?.invalidate(); },
    });
    this.tui.setFocus(this.editor);
    this.tui.addInputListener(data => {
      // A terminal speaking the kitty keyboard protocol also reports each key's release, and matchesKey matches both:
      // Down moved two rows, so a box's second choice landed on the Other row. Only the press counts.
      if (isKeyRelease(data)) return undefined;
      if (this.exitArmed && !matchesKey(data, "ctrl+c")) this.disarmExit();
      // Ctrl+X turns MCP writes off at once, even while busy or while a question or picker is open; an open
      // approval is denied, so a change can't slip through while writes go off. With nothing on, a picker's own
      // Ctrl+X (forget a server in /model) still gets the key.
      if (matchesKey(data, "ctrl+x")) {
        const reverted = this.onWritesRevert?.() ?? false;
        if (reverted) {
          if (this.askFrom === "approval") this.pendingAsk?.(undefined);
          this.flashNote("Writes are off now");
          return { consume: true };
        }
        if (this.slot || this.lending) return undefined;
        this.flashNote("writes are already off");
        return { consume: true };
      }
      if (this.slot || this.lending) {
        // A slot-mounted picker cancels itself on Ctrl+C (its own listener below);
        // interrupting here would clear an editor that is not even visible.
        if (this.lending && matchesKey(data, "ctrl+c")) { this.interrupt(); return { consume: true }; }
        return undefined;
      }
      // Crew details are view-only: approvals/questions still get their keys first.
      if (!this.crew.size) this.crewDetails = false;
      if (this.crewDetails && !this.pendingAsk && !this.pendingLine) {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+o")) {
          this.crewDetails = false; this.render(); return { consume: true };
        }
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
          this.crewOffset = Math.max(0, Math.min(this.crew.detailSize - 1, this.crewOffset + (matchesKey(data, "up") ? -1 : 1)));
          this.render(); return { consume: true };
        }
      }
      // A box takes keys, not pastes: a paste waits as the draft for after the box, so it never lands in an answer
      // nobody picked. pi-tui delivers a whole paste as one input. Once the last row's line is open, it goes there.
      if (this.pendingAsk && !this.askOther && data.startsWith("\x1b[200~")) {
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
      if (matchesKey(data, "ctrl+g") && this.planEdit && this.pendingAsk && Date.now() - this.askOpenedAt >= askDefaults.guardMs) {
        this.pendingAsk([this.planEdit]); return { consume: true };
      }
      if (matchesKey(data, "ctrl+c")) { this.interrupt(); return { consume: true }; }
      if (matchesKey(data, "ctrl+d") && !this.editor.getText()) { this.close(); return { consume: true }; }
      // Esc while typing an answer goes back to the list (the typed words go); Esc at the list skips.
      if (matchesKey(data, "escape") && this.pendingAsk && this.askTyping()) {
        this.askOther = false; this.editor.setText(""); this.render();
        return { consume: true };
      }
      if (matchesKey(data, "escape") && (this.busy || this.pendingAsk || this.pendingLine)) {
        if (this.pendingAsk) this.pendingAsk(undefined);
        else if (this.pendingLine) this.pendingLine(undefined);
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
      // ↑ on an empty prompt during a task takes back the newest line the AI hasn't read (Copilot CLI's key; Alt+Up as
      // in Pi, where the terminal passes it on: Windows Terminal keeps Alt+arrows for its panes).
      if (this.busy && !this.pendingAsk && !this.pendingLine && this.waitingLines.length && !this.editor.getText()
        && (matchesKey(data, "up") || matchesKey(data, "alt+up")) && this.onTakeBack?.()) {
        this.render(); return { consume: true };
      }
      if (this.pendingAsk && this.askOptions && !this.editor.getText() && (matchesKey(data, "up") || matchesKey(data, "down"))) {
        // On an empty line, Up/Down goes back to the list from the last row.
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
        const index = keyChoice(printableKey(data) ?? data, count);
        if (index >= 0) { this.pickAsk(index); return { consume: true }; }
        if (this.askMulti && matchesKey(data, "space")) {
          const index = this.askActiveIndex;
          if (index === this.askOptions.length) { this.typeAsk(); return { consume: true }; }
          if (this.askSelections.has(index)) this.askSelections.delete(index); else this.askSelections.add(index);
          this.render(); return { consume: true };
        }
      }
      // Letters on a box's list go nowhere: choices are picked with keys, and words are typed only on the line the
      // last row opens (Other, or an approval's note). Past nine rows a row's number is typed, so digits still go in.
      const typedKey = this.pendingAsk && !this.askOther ? printableKey(data) : undefined;
      if (typedKey !== undefined && !(this.askRows() > KEY_PICK_MAX && /^\d+$/.test(typedKey))) {
        const field = this.askField();
        this.flashNote(pickKeysHint(this.askRows(), field ? { row: this.askRows(), what: field === NOTE_CHOICE ? "tell the AI what to do instead" : "type your own answer" } : undefined));
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+l")) { this.tui.requestRender(true); return { consume: true }; }
      // A picture from the clipboard goes in as [image N]; with no picture, copied files' paths, else the clipboard's text.
      if (matchesKey(data, PASTE_IMAGE_KEY) && !this.pendingAsk) { void this.pasteImage(); return { consume: true }; }
      // Ctrl+O opens crew details when present; Alt+O always toggles raw/plain steps, even while work runs.
      if (matchesKey(data, "ctrl+o") || matchesKey(data, "alt+o")) {
        if (matchesKey(data, "ctrl+o") && this.crew.size) {
          if (!this.waiting) { this.crewDetails = true; this.crewOffset = 0; this.render(); }
          return { consume: true };
        }
        this.rawSteps = !this.rawSteps;
        this.flashNote(this.rawSteps ? "raw steps · Alt+O for plain" : "plain steps · Alt+O for raw");
        return { consume: true };
      }
      // The last step in full (an edit's diff, a command's output), even while work runs.
      if (matchesKey(data, "ctrl+t")) {
        if (this.onExpandLast) this.onExpandLast(); else this.flashNote("no step to show yet");
        return { consume: true };
      }
      // Pi's thinking-cycle key. Consumed even while busy so the sequence never lands in the draft.
      if (matchesKey(data, "shift+tab")) {
        // While working too: the app applies it from the model's next step. A question or approval is still open first.
        if (this.pendingAsk || this.pendingLine) this.flashNote("effort unchanged · answer first");
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
  private get waiting(): boolean { return Boolean(this.pendingAsk || this.pendingLine || this.slot || this.lending); }

  private footer(width: number): string { return this.footerText(width); }

  private footerText(width: number): string {
    // The status ends with "idle" when Casper waits for a request; any other state leads the line instead.
    const idle = this.status.endsWith(IDLE_TAIL);
    const details = idle ? this.status.slice(0, -IDLE_TAIL.length) : this.status;
    const layout = (state: string) => readableFooter(state, details || "Casper", width, this.io.color, this.badge);
    if (this.waiting && !this.note) return layout(this.accent("? waiting for you"));
    // One state mark: the spinner while working.
    const active = this.busy || this.work !== undefined;
    const state = active ? `${this.accent(SPINNER_FRAMES[this.spinnerFrame])} ` : "";
    // A transient note replaces the status line so it is never truncated away.
    if (this.note) return readableFooter(`${state}${this.accent(this.note)}`, "", width, this.io.color, this.badge);
    if (active) {
      // The elapsed time always sits right after the spinner (after the stage once there is one), so a long-running
      // request is measurable at a glance, and the stages lead, so a narrow window truncates the details, not them.
      const waited = this.waitedMs;
      const elapsed = this.activeSince !== undefined ? `${formatElapsed(performance.now() - this.activeSince - waited)}${waited >= 1000 ? ` · waited ${formatElapsed(waited)}` : ""}` : "";
      return layout(`${state}${this.accent("working")}${elapsed ? ` ${this.muted(elapsed.split(" · ")[0]!)}` : ""}`);
    }
    if (!this.status) return truncateToWidth(this.muted("Casper · / for commands"), width);
    return layout(this.muted("idle"));
  }

  /** While work runs (a prompt in flight or tool activity), the footer's state mark, the status row and a running step's
   * mark cycle through braille frames; idle has no mark. */
  get waitedMs(): number {
    return this.activeWaitedMs + (this.activeWaitingSince === undefined ? 0 : Math.max(0, performance.now() - this.activeWaitingSince));
  }

  private updateSpinner(): void {
    const working = (this.busy || this.work !== undefined) && !this.closed;
    const active = working && !this.waiting;
    if (working) {
      this.activeSince ??= performance.now();
      if (this.waiting) this.activeWaitingSince ??= performance.now();
      else if (this.activeWaitingSince !== undefined) {
        this.activeWaitedMs += Math.max(0, performance.now() - this.activeWaitingSince);
        this.activeWaitingSince = undefined;
      }
    } else {
      this.activeSince = undefined;
      this.activeWaitedMs = 0;
      this.activeWaitingSince = undefined;
    }
    // Crew completions expire even after the main task stops, or while an approval waits.
    const ticking = active || (!this.closed && this.crew.size > 0);
    if (ticking && this.spinnerTimer === undefined) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
        this.updateSpinner();
        this.render();
      }, SPINNER_INTERVAL_MS);
      this.spinnerTimer.unref?.();
    } else if (!ticking && this.spinnerTimer !== undefined) {
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
  /** Your own commands (Markdown files), read when the / menu opens. */
  setUserCommands(list: () => readonly MenuCommand[]): void { this.userCommands = list; }
  setWritesRevert(handler: (() => boolean) | undefined): void { this.onWritesRevert = handler; }
  setTakeBack(handler: (() => boolean) | undefined): void { this.onTakeBack = handler; }
  setWaiting(lines: readonly string[]): void {
    const next = lines.map(line => lineText(terminalText(line)).replace(/\s+/g, " ").trim()).filter(Boolean);
    if (next.join("\n") === this.waitingLines.join("\n")) return;
    this.waitingLines = next;
    this.render();
  }
  setBadge(text?: string): void {
    const next = text ? terminalText(text).replace(/\s+/g, " ").trim() || undefined : undefined;
    if (next === this.badge) return;
    this.badge = next;
    this.render();
  }
  /** A persistent update notice, separate from footer status and transient notes. Undefined clears it. */
  setUpdate(text?: string): void {
    const next = text ? terminalText(text).replace(/\s+/g, " ").trim() || undefined : undefined;
    if (next === this.update) return;
    this.update = next;
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
          const names = !args[3].force && /^\/\S*$/.test(before) ? commandMenu(before.slice(1), this.userCommands()) : undefined;
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
  /** Work in progress: the open group's steps, shown under the AI's words, and the status row's words ("Waiting for
   * …", "Running bun test · 4s"). Undefined, or nothing in it, ends it. */
  setWork(view?: WorkView): void {
    const clean = (lines: readonly string[]) => lines.map(line => terminalText(line).replace(/\s+/g, " ").trim()).filter(Boolean);
    const rows = clean(view?.rows ?? []);
    const plain = view?.plain ? clean(view.plain) : undefined;
    const status = view?.status ? terminalText(view.status).replace(/\s+/g, " ").trim() || undefined : undefined;
    const intent = status && view?.intent ? lineText(terminalText(view.intent)).replace(/\s+/g, " ").trim() || undefined : undefined;
    const headline = status && view?.headline ? lineText(terminalText(view.headline)).replace(/\s+/g, " ").trim() || undefined : undefined;
    const next = rows.length || plain?.length || status ? { rows, ...(plain ? { plain } : {}), ...(status ? { status } : {}), ...(intent ? { intent } : {}), ...(headline ? { headline } : {}) } : undefined;
    if (next?.status === this.work?.status && next?.intent === this.work?.intent && next?.headline === this.work?.headline && next?.rows.join("\n") === this.work?.rows.join("\n")
      && next?.plain?.join("\n") === this.work?.plain?.join("\n")) return;
    this.work = next;
    this.updateSpinner();
    this.render();
  }
  /** Helper lifecycle is independent of the current tool group and the optional side pane. */
  updateCrew(activity: HelperActivity, root?: string): void {
    this.crew.update(activity, root);
    this.updateSpinner();
    this.render();
  }
  setCrewWaiting(name: string, waiting: boolean): void {
    this.crew.setWaiting(name, waiting);
    this.render();
  }
  /** The reserved bottom rows at this size, also used by layout checks. */
  crewRows(width: number, height: number): string[] {
    if (!this.crew.size) this.crewDetails = false;
    return this.crew.render(width, height, { color: this.io.color, frame: this.spinnerFrame,
      details: this.crewDetails && !this.waiting, offset: this.crewOffset });
  }
  /** The work in progress as the screen holds it now (for tests and the layout checks). */
  get workView(): WorkView | undefined { return this.work; }

  /** The steps shown now: in plain words, or raw after Ctrl+O (or when there are no plain words). */
  private get shownRows(): readonly string[] {
    return (!this.rawSteps && this.work?.plain) || this.work?.rows || [];
  }
  /** Whether the live steps show raw (Ctrl+O), for tests. */
  get rawStepsShown(): boolean { return this.rawSteps; }

  /** The open group's steps, two columns in under the AI's words: a running step's • is the spinner, a finished step
   * keeps its mark in its colour (a failed one amber: the work goes on), and a command's latest output line hangs dim under it. */
  private readonly liveRows: Component = {
    render: width => this.shownRows.map(row => {
      if (row.startsWith("↳ ")) return this.muted(truncateToWidth(`    ${row}`, width));
      const mark = LIVE_MARK.exec(row);
      if (mark?.[1] === "–") return this.muted(truncateToWidth(`  ${row}`, width));
      if (!mark) return truncateToWidth(`  ${row}`, width);
      const glyph = mark[1] === BUSY_GLYPH ? this.accent(SPINNER_FRAMES[this.spinnerFrame]!)
        : mark[1] === "◆" ? tint(mark[1], "accent", this.io.color, "1")
        : tint(mark[1]!, mark[1] === "✓" ? "success" : "warning", this.io.color);
      return truncateToWidth(`  ${glyph} ${row.slice(mark[0].length)}`, width);
    }),
    invalidate() {},
  };

  /** Whole text, a shorter action, or nothing: never wrap an update notice over the prompt. */
  private updateRow(width: number): string[] {
    if (!this.update || this.closed) return [];
    const short = this.update.includes("restart to use it") ? "✔ restart to update" : this.update.split(" · ")[0]!;
    const text = [this.update, short].find(note => visibleWidth(note) <= width);
    return text ? [" ".repeat(width - visibleWidth(text)) + tint(text, "success", this.io.color)] : [];
  }

  /** The one row above the prompt while work runs: the spinner, the AI's intent and what Casper is doing or waiting for,
   * and that Esc stops it. Nothing while a question or picker waits on you. A narrow window drops the intent, then cuts
   * the words, never the key. */
  /** One muted row per waiting line, at most 3 (the newest), and the key that takes the newest back. */
  private waitingRows(width: number): string[] {
    if (!this.waitingLines.length || this.closed || this.pendingAsk || this.pendingLine) return [];
    const shown = this.waitingLines.slice(-3);
    const more = this.waitingLines.length - shown.length;
    const hint = " · ↑ takes it back";
    return shown.map((line, i) => {
      const lead = `↳ waiting${i === 0 && more ? ` (+${more})` : ""}: `;
      const tail = i === shown.length - 1 && this.busy ? hint : "";
      const room = Math.max(4, width - 2 - visibleWidth(lead) - visibleWidth(tail));
      return truncateToWidth(this.muted(`${lead}${truncateToWidth(line, room, "…")}${tail}`), width);
    });
  }
  private statusRow(width: number): string[] {
    if (!this.work || this.waiting || this.closed) return [];
    const spin = this.accent(SPINNER_FRAMES[this.spinnerFrame]!);
    const words = this.work.headline ?? this.work.status ?? "Working";
    const hint = " · Esc stops";
    const room = width - 2 - visibleWidth(hint);
    if (room < 8) return [truncateToWidth(`${spin} ${words}`, width, "…")];
    return [`${spin} ${statusWords(words, this.work.intent, room)}${this.muted(hint)}`];
  }
  private configureAutocomplete(): void {
    const provider = this.autocomplete;
    if (!provider) return;
    if (this.pendingAsk || this.pendingLine) {
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
  /** `kind`: how the lines sit among the blocks around them (see EntryKind): plain lines pack together. */
  write(text: string, kind: EntryKind = "line"): void {
    if (!this.started) { this.io.output.write(text); return; }
    this.transcript.append(text, kind);
    this.render();
  }
  /** A block that renders itself per width (a bordered panel) commits after any open tail line. `group`: a blank row
   * before it. */
  writeBlock(block: Component, kind: EntryKind = "line"): void {
    if (!this.started) { this.io.output.write(block.render(this.io.output.columns ?? 80).join("\n") + "\n"); return; }
    this.transcript.commit(block, kind);
    this.render();
  }
  /** A block that belongs under the AI's words (the steps they led to, a box of edits): right under them when they came
   * last, else on its own after a blank row. `make` is told which, and indents itself when attached. */
  writeAttachable(make: (attached: boolean) => Component): void {
    if (!this.started) { this.io.output.write(make(false).render(this.io.output.columns ?? 80).join("\n") + "\n"); return; }
    this.transcript.commitAttachable(make);
    this.render();
  }
  assistant(delta: string): void {
    if (!this.started) {
      const text = terminalText(delta); this.io.output.write(text);
      if (text) this.plainAssistantOpen = !text.endsWith("\n");
      return;
    }
    this.source += terminalText(delta);
    // The AI's words lead with ● and hang two columns in, with a blank row before them.
    if (!this.message) this.transcript.preview = this.message = new StreamingMarkdown(this.io.color, this.theme, { hang: true });
    this.message.setText(this.source);
    this.render();
  }
  endAssistant(): void {
    if (this.plainAssistantOpen) { this.io.output.write("\n"); this.plainAssistantOpen = false; }
    if (!this.message) return;
    this.transcript.preview = undefined;
    this.transcript.commit(this.message, "narration");
    this.message = undefined; this.source = "";
    this.render();
  }
  /** The bell (BEL) a terminal turns into a sound, a flash or a dock bounce, with a desktop notification where the
   * terminal shows one; rich surface only. Not while the terminal says it is in front (focus reports): you are
   * looking already. A terminal that never says rings as before. */
  private attention(what: "done" | "question"): void {
    if (this.busySince === undefined || this.closed || Date.now() - this.busySince < this.attentionAfterMs) return;
    if (!this.notificationsOn() || this.terminal.focused === true) return;
    this.terminal.write(this.bell(what === "done" ? "Casper finished the task" : "Casper has a question for you"));
  }
  private bell: (message: string) => string = () => "\x07";
  private notificationsOn: () => boolean = () => true;
  /** What rings: BEL, plus the terminal's notification (through tmux when inside it); see host-terminal.ts. */
  setBell(sequence: (message: string) => string): void { this.bell = sequence; }
  setNotifications(on: () => boolean): void { this.notificationsOn = on; }
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
    if (this.busy) { this.attention("done"); this.busySince = undefined; }
    // The prompt is back: whatever work was shown in the Working box is over.
    this.endAssistant(); this.busy = false; this.note = ""; this.work = undefined; this.configureAutocomplete();
    this.updateSpinner();
    if (this.closed) return Promise.resolve(undefined);
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    this.command = resolve; this.render();
    return promise;
  }
  /**
   * One approval box: the context lines go into the transcript, then the numbered panel asks. One key picks (or
   * Up/Down and Enter); a note typed on its last row is a No, the first choice. It resolves the chosen label, or undefined for Esc,
   * Ctrl+C, Ctrl+X, close or abort. A pretyped draft never answers, and nor does a key pressed as the box opened.
   * This channel is the user's alone: the model's ask tool never reaches it.
   */
  async approve(preview: string, question: string, options: { label: string; description?: string }[], signal?: AbortSignal): Promise<string | undefined> {
    // An approval always comes first: it waits only for a private box, and closes any other command's question.
    if (this.held && !typedDuringTask()) { await this.held; return this.approve(preview, question, options, signal); }
    this.yieldSlot(true);
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingLine || signal?.aborted || !options.length) return undefined;
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
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingLine || signal?.aborted) return Promise.resolve(undefined);
    // Shell approvals arrive through pick(), not approve(); they still own the same safe note row.
    if (from === "casper" && options[0]?.label === "No" && SHELL_QUESTION.test(question)) from = "approval";
    // The steps and the status row step aside while the box is open, and come back after it.
    this.endAssistant();
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
    let answerComment = "";
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
      const comment = from === "approval" && chosen && answerComment ? ` (${answerComment})` : "";
      const lead = from === "ai" ? `${AI_ASKS_LABEL} ` : "";
      // An approval nobody answered is a No; the record says both.
      const tail = answer !== undefined ? ` → ${answer}${comment}` : gaveWay ? " — closed for the task's question; type the command again" : from === "approval" ? ` — skipped (${shown[0]?.label ?? "No"})` : " — skipped";
      const paint = (question: string) => `${this.muted(lead)}${this.accent(question)}${answer !== undefined ? `${this.accent(" →")} ${this.selected(answer)}${this.muted(comment)}` : this.muted(tail)}`;
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
      // Typed words are a No even if they spell a granting label; only an explicit picker action grants.
      answerComment = from === "approval" ? terminalText(this.submittedAskComment || this.editor.getExpandedText()).replace(/\s+/g, " ").trim() : "";
      this.submittedAskComment = "";
      chosen = from === "approval" && answer && answerComment ? [options[0]!.label] : answer;
      own = chosen?.length === 1 && options.some(option => option.label === chosen![0]) ? ownRecord?.(chosen[0]!) : undefined;
      if (own !== "") { this.writeBlock(record); this.records++; }
      this.restoreSetAside(setAside.draft, setAside.pasted);
      // A refusal's words are direction for the task, not just decoration in its transcript record.
      if (chosen && answerComment) {
        const accepted = this.onBusySubmit?.(answerComment);
        if (accepted !== true) this.restoreSetAside([setAside.draft, answerComment].filter(Boolean).join("\n"), setAside.pasted);
      }
      this.configureAutocomplete(); this.updateSpinner(); this.render(); resolve(chosen);
    };
    const cancel = () => finish(undefined);
    this.attention("question");
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

  /** The draft a question or input box set aside, back in the prompt with what was pasted into it. */
  private restoreSetAside(draft: string, pasted: string[]): void {
    this.editor.setText(draft);
    this.editor.pasted = draft ? pasted : [];
  }

  /** An empty input for a plain-word answer, never prefilled with plan text. Newlines become spaces.
   * Enter returns the line (empty included); Esc, Ctrl+C, abort or close return undefined. */
  askLine(question: string, hint: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.held && !typedDuringTask()) return this.held.then(() => this.askLine(question, hint, signal));
    this.yieldSlot();
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingLine || signal?.aborted) return Promise.resolve(undefined);
    this.endAssistant();
    const draft = this.editor.getExpandedText();
    const draftPastes = this.editor.pasted;
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    let settled = false;
    const finish = (text: string | undefined) => {
      if (settled) return; settled = true;
      signal?.removeEventListener("abort", cancel);
      this.pendingLine = undefined; this.lineHeading = []; this.lineGivesWay = false;
      this.writeBlock({ render: width => wrapTextWithAnsi(this.muted(terminalText(answerRecordText(question, text ? [text] : undefined))), width), invalidate() {} });
      this.records++;
      this.restoreSetAside(draft, draftPastes); this.configureAutocomplete(); this.updateSpinner(); this.render(); resolve(text);
    };
    const cancel = () => finish(undefined);
    this.attention("question");
    this.pendingLine = finish; this.lineGivesWay = typedDuringTask();
    this.lineHeading = [this.accent(terminalText(question)), this.muted(terminalText(hint))];
    this.editor.setText("");
    this.configureAutocomplete(); this.updateSpinner(); this.render();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    return promise;
  }

  /** The open box's top rule, titled by who asks: an approval in the warning colour, the AI's question or Casper's own
   * choice in the accent colour. The title is Casper's word for the box, never the question's own text. */
  private askRule(width: number): string {
    const title = this.askFrom === "approval" ? "Approval" : this.askFrom === "ai" ? "Question" : "Choose";
    const head = truncateToWidth(`── ${title} `, width, "");
    return tint(`${head}${"─".repeat(Math.max(0, width - visibleWidth(head)))}`, this.askFrom === "approval" ? "warning" : "accent", this.io.color);
  }

  /** The whole question and every option, wrapped to the width; the highlighted option in the selection colour.
   * When that is taller than `height` rows, only the highlighted option keeps its description, so the
   * question itself stays on screen instead of scrolling away. */
  private renderAsk(width: number, height: number): string[] {
    height = Math.max(0, height);
    if (!height) return [];
    const choices = this.askOptions?.length ?? 0;
    // A box that takes a typed answer ends with the Other row; while an answer is typed, it stays highlighted.
    const count = this.askRows();
    const typing = this.askTyping();
    const active = typing ? choices : this.askActiveIndex;
    const hint = typing ? (this.askFrom === "approval" ? "Enter to send No with this note · Esc to go back" : "Enter to send · Esc to go back") : choiceHint(count);
    const question = (this.askQuestion ?? "").split("\n");
    const reason = reasonPrefix(question[1]) !== undefined ? question[1] : undefined;
    // Casper's question stays first; the model's last sentence is dim context on one row.
    const shell = SHELL_QUESTION.test(question[0] ?? "");
    const inline = shell ? (/^(.*?\?)  ([\s\S]+)$/.exec(question[0]!) ?? /^(Builder \d+ wants to run:) ([\s\S]+)$/.exec(question[0]!)) : null;
    const title = inline?.[1] ?? question[0] ?? "Choose";
    const wrappedTitle = wrapTextWithAnsi(this.accent(title), width);
    const titleRows = shell && wrappedTitle.length > 3 ? [...wrappedTitle.slice(0, 2), this.muted("…")] : wrappedTitle;
    const context = shell ? [...(inline ? [inline[2]!] : []), ...question.slice(reason ? 2 : 1)] : question.slice(reason ? 2 : 1);
    let tail = wrapTextWithAnsi(dim(hint, this.io.color), width);
    if (tail.length > Math.max(1, height - 4)) tail = [dim(truncateToWidth(hint, width), this.io.color)];
    // Reserve the selected row and, where possible, the two scroll cues before budgeting context.
    const headBudget = Math.max(0, height - tail.length - Math.min(3, Math.max(1, height - tail.length)));
    const heading = [
      ...(this.askFrom === "ai" ? [this.muted(AI_ASKS_LABEL)] : []), ...titleRows,
      ...(reason ? [this.muted(modelReasonLine(reason, width))] : []),
    ];
    const head = heading.slice(0, headBudget);
    const contextBudget = Math.max(0, Math.min(shell ? 14 : headBudget, headBudget - head.length,
      height - tail.length - count - head.length));
    if (shell) {
      const framed = contextBudget >= 3;
      const commandWidth = Math.max(1, width - (framed ? 4 : 0));
      const bodyBudget = Math.max(1, contextBudget - (framed ? 2 : 0));
      const commandRows = commandPreview(context, bodyBudget, commandWidth).flatMap(line => wrapTextWithAnsi(line, commandWidth));
      head.push(...(framed ? renderPanel("Command", commandRows, width, false, "muted") : commandRows).map(line => dim(line, this.io.color)));
    } else {
      head.push(...context.flatMap(line => wrapTextWithAnsi(this.muted(line), width)).slice(0, contextBudget));
    }
    if (!typing && this.editor.getText() && head.length < headBudget) head.push(this.muted(`Number: ${this.editor.getText()}`));
    // The row that shows what is typed: the last row, once its line is open.
    const typedAt = typing ? choices : -1;
    const typed = typedAt < 0 ? undefined : this.typedText();
    const entries = Array.from({ length: count }, (_, index) => {
      const entry = index < choices ? this.askOptions![index]! : { label: this.askField()! };
      const marker = this.askMulti && index < choices ? (this.askSelections.has(index) ? "[x] " : "[ ] ") : "";
      return { ...entry, ...(index === typedAt ? { description: undefined } : {}), label: marker + entry.label };
    });
    const labelWidth = Math.max(0, ...this.askOptions?.map(row => visibleWidth(row.label)) ?? [], ...(this.askField() ? [visibleWidth(this.askField()!)] : [])) + (this.askMulti ? 4 : 0);
    // Typed words show in full after the row's label; in fewer than `maxLines` rows, the part where the cursor is. A
    // last row too small for words after its whole label keeps only "Other" (or an approval's "No").
    const option = (index: number, compact: boolean, maxLines = height) => {
      if (index !== typedAt) return pickerOptionLines(entries, index, index === active, width, this.io.color, { compact, labelWidth });
      const whole = entries[index]!.label;
      const room = Math.max(1, maxLines) * Math.max(1, width - 2 - visibleWidth(choiceNumber(index, count))) - visibleWidth(`${whole} — `);
      const short = whole === OTHER_CHOICE ? "Other" : whole === NOTE_CHOICE ? "No" : undefined;
      const label = short && room < TYPED_ROOM && visibleWidth(typed!.text) > room ? short : whole;
      return typedRowLines(typed!.text, typed!.cursor, maxLines, width, shown => pickerOptionLines([{ label: `${label} — ${shown}` }],
        0, true, width, this.io.color, { count, offset: index, compact, labelWidth }));
    };
    const fit = (lines: string[]) => lines.map(line => truncateToWidth(line, width));
    const all = (compact: boolean) => fit([...head, ...Array.from({ length: count }, (_, index) => option(index, compact)).flat(), ...tail]);
    const full = all(false);
    if (full.length <= height) return full;
    const compact = all(true);
    // Still taller than the screen: the rows around the highlighted one, with how many more are above and below, so
    // the box never pushes its own top into the scrollback (where it would stay once the box closes).
    if (compact.length <= height) return compact;
    const available = height - head.length;
    tail = tail.slice(0, Math.max(0, available - 1));
    const cues = available - tail.length >= 3;
    const room = available - tail.length - (cues ? 2 : 0);
    const rows = Array.from({ length: count }, (_, index) => option(index, true, room));
    const window = pickerWindow(rows, active, room, width);
    return fit([...head, ...(cues ? [this.muted(window.start ? `  … ${window.start} more above` : "")] : []), ...window.lines,
      ...(cues ? [this.muted(window.end < count ? `  … ${count - window.end} more below` : "")] : []), ...tail]);
  }

  /** What is typed in the open box as its row shows it (a big paste as its text, each run of spaces or lines as one
   * space) and where the cursor is in it. */
  private typedText(): { text: string; cursor: number } {
    const expanded = this.editor.getExpandedText();
    const text = expanded.replace(/\s+/g, " ").trim();
    const lines = this.editor.getLines();
    const { line, col } = this.editor.getCursor();
    const before = [...lines.slice(0, line), (lines[line] ?? "").slice(0, col)].join("\n");
    const after = [(lines[line] ?? "").slice(col), ...lines.slice(line + 1)].join("\n");
    // A big paste is a marker in the editor, never holding the cursor, and its text here. The side of the cursor without
    // one reads the same in both; with one on each side, the end stands in for the cursor.
    const typedBefore = expanded.endsWith(after) ? expanded.slice(0, expanded.length - after.length)
      : expanded.startsWith(before) ? before : expanded;
    return { text, cursor: Math.min(Array.from(text).length, Array.from(typedBefore.replace(/\s+/g, " ").trimStart()).length) };
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

  /** The open box's last row that opens a line to type on: Other for a box that takes a typed answer, the note row
   * for an approval, or none for a key-only picker. */
  private askField(): string | undefined {
    return this.askTyped ? OTHER_CHOICE : this.askFrom === "approval" ? NOTE_CHOICE : undefined;
  }

  /** The rows of the open box: its choices, then the row that opens a line to type on. */
  private askRows(): number {
    return (this.askOptions?.length ?? 0) + (this.askField() ? 1 : 0);
  }

  /** Words are being typed: the last row was picked and its line is open. */
  private askTyping(): boolean {
    return this.askOther;
  }

  /** The last row: the box now takes typed words on its input line; Enter sends them, Esc goes back to the list. */
  private typeAsk(): void {
    this.askOther = true;
    this.render();
  }

  /** A nonempty editor submission is free text, except a row's number in a list past nine rows; listed choices are
   * otherwise picked by number or arrow keys. */
  private answerAsk(value: string): void {
    const text = value.trim();
    // While words are typed after picking the last row, a number is the words, not a row.
    const index = this.askOther ? -1 : typedChoice(text, this.askRows());
    if (index >= 0) { this.pickAsk(index); return; }
    if (!this.askOther) return;
    // An approval's note is a No with the note (an empty one, a plain No); typed words never approve.
    if (this.askFrom === "approval") {
      this.submittedAskComment = text;
      this.pendingAsk?.([this.askLabels[0]!]);
    } else if (text) this.pendingAsk?.([text]);
  }

  private planEdit?: string;
  setPlanEdit(value?: string): void { this.planEdit = value; }

  /** Release the full terminal, not just input, while the person's editor owns it. */
  async externalEditor(run: () => Promise<void>): Promise<void> {
    if (this.pendingAsk || this.pendingLine || this.slot || this.lending || this.closed) throw new Error("Terminal input is unavailable.");
    this.lending = true;
    this.terminal.suspendInput();
    this.tui.stop();
    try { await run(); }
    finally { this.lending = false; if (!this.closed) { this.tui.start(); this.tui.setFocus(this.editor); this.tui.requestRender(true); } }
  }

  /** A picker that gives way: an approval or question that opens while it is mounted closes it first. So does a question
   * or input a command typed during a task opened, for any box but that command's own. */
  private yieldSlot(always = false): void {
    if (!always && typedDuringTask()) return;
    this.yielding = true;
    try {
      if (this.pendingAsk && this.askGivesWay) this.pendingAsk(undefined);
      if (this.pendingLine && this.lineGivesWay) this.pendingLine(undefined);
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
    if (this.closed || this.slot || this.lending || this.pendingAsk || this.pendingLine || !this.started) return undefined;
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
    if (this.pendingLine) this.pendingLine(undefined);
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
    this.pendingAsk?.(undefined); this.pendingLine?.(undefined); this.command?.(); this.command = undefined;
    // The last lines written (a final notice) are drawn before the terminal is handed back.
    if (this.started) { this.tui.renderNow(); this.tui.stop(); }
    this.eof();
  }
}
