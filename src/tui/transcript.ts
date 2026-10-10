import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** A row wider than the screen stops the whole terminal UI, so a block's rows are held to the width as a last guard. */
function fit(lines: string[], width: number): string[] {
  if (!lines.some(line => visibleWidth(line) > width)) return lines;
  return lines.map(line => visibleWidth(line) > width ? truncateToWidth(line, width, "") : line);
}

/** A block's own blank rows at its top and bottom: the transcript puts the one blank row between blocks itself. */
function trimBlank(lines: string[]): string[] {
  let start = 0, end = lines.length;
  while (start < end && lines[start] === "") start++;
  while (end > start && lines[end - 1] === "") end--;
  return start === 0 && end === lines.length ? lines : lines.slice(start, end);
}

/**
 * What an entry is, for the one blank row between blocks.
 * line: a plain line (a notice, a record); lines pack together.
 * group: a block of its own (your request, a box, a receipt): a blank row before it.
 * narration: the AI's words: a blank row before them, and what attaches comes right under them.
 * attached: a row or box that belongs to what is above it (the steps under the AI's words, the Next row): no blank row.
 */
export type EntryKind = "line" | "group" | "narration" | "attached";

/** One blank row between blocks, never two: before a group or the AI's words, and before the first line after a block. */
export function gapBefore(previous: EntryKind | undefined, next: EntryKind): boolean {
  if (previous === undefined || next === "attached") return false;
  return next !== "line" || previous !== "line";
}

/** Scrollback-style transcript: finished entries are rendered once per width and cached; only the open tail re-wraps.
 * Entries are plain lines (wrapped here) or blocks that render themselves from source at the current width. Each entry
 * has a kind, and the transcript puts exactly one blank row between blocks (see gapBefore). Committed rows never change:
 * a gap is decided when its entry commits. */
export class Transcript implements Component {
  /** Uncommitted block shown after the tail, e.g. the assistant message still streaming. It is the AI's words: a blank
   * row before it, as when it commits. */
  preview?: Component;
  /** Rows that change while work runs (the steps under the AI's words), after the preview. At most `liveCap` rows show:
   * the newest. */
  live?: Component;
  liveCap = Infinity;
  private readonly entries: (string | { block: Component; kind: EntryKind })[] = [];
  private rendered: string[] = [];
  private renderedCount = 0;
  private renderedWidth = 0;
  private tail = "";
  private tailKind: EntryKind = "line";
  /** The kind of the last entry that was not a blank row. */
  private lastKind?: EntryKind;
  /** The last entry is a blank row (written, or a gap). */
  private lastBlank = false;
  /** The AI's words, or something attached to them, came last: the next attachable block goes right under. */
  private lead = false;

  /** The AI's words (or what hangs under them) came last: a row or box that belongs to them attaches with no gap. */
  get leadOpen(): boolean { return this.lead; }

  /** `continued`: a later line of the same block (one write of several lines): never a gap before it. */
  private push(entry: string | { block: Component; kind: EntryKind }, kind: EntryKind, continued = false): void {
    const blank = entry === "";
    if (!blank && !continued && gapBefore(this.lastKind, kind) && !this.lastBlank && this.entries.length) this.entries.push("");
    // A blank row written right after another (or after the gap) would make two.
    if (blank && this.lastBlank) return;
    this.entries.push(entry);
    this.lastBlank = blank;
    if (blank) return;
    this.lastKind = kind;
    this.lead = kind === "narration" || kind === "attached" || (kind === "group" && this.leadNext);
    this.leadNext = false;
  }
  /** The next group entry is a block of steps standing for the AI's words (● on its own): what follows attaches. */
  private leadNext = false;

  /** `\n` commits a line; `\r` restarts the open tail so in-place status lines redraw instead of stacking. The lines of
   * one call are one block: the gap `kind` asks for comes before its first line only. */
  append(text: string, kind: EntryKind = "line"): void {
    const pieces = text.split("\n");
    let first = true;
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index]!;
      const restart = piece.lastIndexOf("\r");
      if (!this.tail) { this.tailKind = kind; this.tailContinued = !first; }
      this.tail = restart === -1 ? this.tail + piece : piece.slice(restart + 1);
      if (index < pieces.length - 1) {
        this.push(this.tail, this.tailKind, this.tailContinued);
        if (this.tail) first = false;
        this.tail = "";
      }
    }
  }
  /** The open tail line continues a block written in the same call. */
  private tailContinued = false;

  /** Commit a finished block after any open tail line. Its lines are cached until the width changes. */
  commit(block: Component, kind: EntryKind = "line"): void {
    if (this.tail) { this.push(this.tail, this.tailKind, this.tailContinued); this.tail = ""; }
    this.push({ block, kind }, kind);
  }

  /** Commit a block that belongs under the AI's words when they came last (`attached` true: no gap, indented by the
   * block itself), or else stands on its own after a gap. What comes next can attach under it either way. */
  commitAttachable(make: (attached: boolean) => Component): void {
    if (this.tail) { this.push(this.tail, this.tailKind, this.tailContinued); this.tail = ""; }
    const attached = this.lead;
    if (!attached) this.leadNext = true;
    this.push({ block: make(attached), kind: attached ? "attached" : "group" }, attached ? "attached" : "group");
  }

  invalidate(): void { this.renderedWidth = 0; }

  render(width: number): string[] {
    if (width !== this.renderedWidth) { this.rendered = []; this.renderedCount = 0; this.renderedWidth = width; }
    for (; this.renderedCount < this.entries.length; this.renderedCount++) {
      const entry = this.entries[this.renderedCount]!;
      if (typeof entry === "string") { this.rendered.push(...(entry ? wrapTextWithAnsi(entry, width) : [""])); continue; }
      const rows = fit(entry.block.render(width), width);
      this.rendered.push(...(entry.kind === "line" ? rows : trimBlank(rows)));
    }
    if (!this.tail && !this.preview && !this.live) return this.rendered;
    const lines = [...this.rendered];
    if (this.tail) lines.push(...wrapTextWithAnsi(this.tail, width));
    const blankLast = () => !lines.length || lines[lines.length - 1] === "";
    let lead = this.lead;
    if (this.preview) {
      const rows = trimBlank(fit(this.preview.render(width), width));
      if (rows.length) {
        // The same gap the words get when they commit, so no row moves.
        if (!blankLast() && (this.tail || gapBefore(this.lastKind, "narration"))) lines.push("");
        lines.push(...rows);
        lead = true;
      }
    }
    if (this.live) {
      let rows = fit(this.live.render(width), width);
      if (rows.length > this.liveCap) rows = rows.slice(rows.length - Math.max(0, this.liveCap));
      if (rows.length) {
        if (!lead && !blankLast()) lines.push("");
        lines.push(...rows);
      }
    }
    return lines;
  }
}
