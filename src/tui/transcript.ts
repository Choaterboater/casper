import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** Scrollback-style transcript: finished entries are rendered once per width and cached; only the open tail re-wraps.
 * Entries are plain lines (wrapped here) or blocks that render themselves from source at the current width. */
export class Transcript implements Component {
  /** Uncommitted block shown after the tail, e.g. the assistant message still streaming. */
  preview?: Component;
  private readonly entries: (string | Component)[] = [];
  private rendered: string[] = [];
  private renderedCount = 0;
  private renderedWidth = 0;
  private tail = "";

  /** `\n` commits a line; `\r` restarts the open tail so in-place status lines redraw instead of stacking. */
  append(text: string): void {
    const pieces = text.split("\n");
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index]!;
      const restart = piece.lastIndexOf("\r");
      this.tail = restart === -1 ? this.tail + piece : piece.slice(restart + 1);
      if (index < pieces.length - 1) { this.entries.push(this.tail); this.tail = ""; }
    }
  }

  /** Commit a finished block after any open tail line. Its lines are cached until the width changes. */
  commit(block: Component): void {
    if (this.tail) { this.entries.push(this.tail); this.tail = ""; }
    this.entries.push(block);
  }

  invalidate(): void { this.renderedWidth = 0; }

  render(width: number): string[] {
    if (width !== this.renderedWidth) { this.rendered = []; this.renderedCount = 0; this.renderedWidth = width; }
    for (; this.renderedCount < this.entries.length; this.renderedCount++) {
      const entry = this.entries[this.renderedCount]!;
      this.rendered.push(...(typeof entry !== "string" ? entry.render(width) : entry ? wrapTextWithAnsi(entry, width) : [""]));
    }
    if (!this.tail && !this.preview) return this.rendered;
    const lines = [...this.rendered];
    if (this.tail) lines.push(...wrapTextWithAnsi(this.tail, width));
    if (this.preview) lines.push(...this.preview.render(width));
    return lines;
  }
}
