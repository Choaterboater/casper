import { Container, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { terminalText, tint } from "./format";

/** A box's frame and title take its tone's colour from the theme in use. */
export type PanelTone = "accent" | "success" | "warning" | "error" | "muted";

/** Semantic colors always accompany readable titles or status labels. */
export function panelColor(text: string, tone: PanelTone, color: boolean): string {
  return tint(text, tone, color);
}

/**
 * An open box that copies clean: a title rule (`── Edited 2 files ────`), the body at the left edge with nothing
 * beside it, and a closing rule. A mouse copy of the body takes no border characters. Body lines contain trusted
 * styling only; callers sanitize external text before styling.
 */
export function renderPanel(title: string, body: readonly string[], width: number, color: boolean, tone: PanelTone = "accent"): string[] {
  width = Number.isFinite(width) ? Math.min(120, Math.max(1, Math.floor(width))) : 80;
  const label = terminalText(title).replace(/\s+/g, " ").trim();
  if (width < 8) return [label, ...body].flatMap(line => wrapTextWithAnsi(line, width))
    .map(line => visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line);
  const head = truncateToWidth(`── ${label} `, width, "");
  const rows = [panelColor(`${head}${"─".repeat(Math.max(0, width - visibleWidth(head)))}`, tone, color)];
  for (const source of body) rows.push(...wrapTextWithAnsi(source, width));
  rows.push(panelColor("─".repeat(width), tone, color));
  return rows;
}

/**
 * A code block that copies clean: a title line (`── ts ────`), the code exactly as written with no side border and
 * no indent, and a closing rule. A line wider than the screen is cut at the edge only, so every character stays and
 * nothing is added (a terminal must break it somewhere); a wide character that does not fit starts the next row.
 * `style` colors each piece of code.
 */
export function renderCodeBlock(title: string, code: readonly string[], width: number, color: boolean,
  style: (text: string) => string = text => text): string[] {
  width = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
  const label = terminalText(title).replace(/\s+/g, " ").trim() || "code";
  const head = truncateToWidth(`── ${label} `, width, "");
  const rows = [tint(`${head}${"─".repeat(Math.max(0, width - visibleWidth(head)))}`, "border", color)];
  for (const line of code) {
    const total = visibleWidth(line);
    if (total <= width) { rows.push(line ? style(line) : ""); continue; }
    for (let column = 0; column < total;) {
      // Cut between characters: a 2-column character (CJK, emoji) that would cross the edge starts the next row.
      // Only a character wider than the whole screen is cut short, so no row is ever wider than the screen.
      let piece = sliceByColumn(line, column, width, true);
      let used = visibleWidth(piece);
      if (!used) { piece = sliceByColumn(line, column, 1); used = Math.max(1, visibleWidth(piece)); piece = truncateToWidth(piece, width, ""); }
      rows.push(style(piece));
      column += used;
    }
  }
  rows.push(tint("─".repeat(width), "border", color));
  return rows;
}

/** Pi container with one consistent, width-aware frame for output and exclusive menus. */
export class Panel extends Container {
  constructor(public title: string, private readonly color: boolean, private readonly tone: PanelTone = "accent") { super(); }
  override render(width: number): string[] {
    width = Math.min(120, width);
    return renderPanel(this.title, super.render(Math.max(1, width)), width, this.color, this.tone);
  }
  override handleMouse(event: Parameters<Container["handleMouse"]>[0]) {
    const narrow = event.width < 8;
    const top = narrow ? wrapTextWithAnsi(terminalText(this.title).replace(/\s+/g, " ").trim(), Math.max(1, event.width)).length : 1;
    const height = event.height - top - (narrow ? 0 : 1);
    if (event.y < top || event.y >= top + height) return undefined;
    return super.handleMouse({ ...event, y: event.y - top, height });
  }
}
