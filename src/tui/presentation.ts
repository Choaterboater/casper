import { Container, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { terminalText, tint } from "./format";
import { GLYPHS } from "./glyphs";

/** A box's frame and title take its tone's colour from the theme in use. */
export type PanelTone = "accent" | "success" | "warning" | "error" | "muted";

/** Semantic colors always accompany readable titles or status labels. */
export function panelColor(text: string, tone: PanelTone, color: boolean): string {
  return tint(text, tone, color);
}

/** Body lines contain trusted styling only; callers sanitize external text before styling. */
export function renderPanel(title: string, body: readonly string[], width: number, color: boolean, tone: PanelTone = "accent",
  corners: readonly string[] = GLYPHS.corners): string[] {
  const [topLeft, topRight, bottomLeft, bottomRight] = corners;
  width = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
  const label = terminalText(title).replace(/\s+/g, " ").trim();
  if (width < 8) return [label, ...body].flatMap(line => wrapTextWithAnsi(line, width))
    .map(line => visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line);
  const inner = width - 4;
  const heading = truncateToWidth(` ${label} `, width - 4, "");
  const top = `${topLeft}─${heading}${"─".repeat(Math.max(0, width - 3 - visibleWidth(heading)))}${topRight}`;
  const rows = [panelColor(top, tone, color)];
  const border = panelColor("│", tone, color);
  for (const source of body) {
    for (const line of wrapTextWithAnsi(source, inner)) {
      rows.push(`${border} ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} ${border}`);
    }
  }
  rows.push(panelColor(`${bottomLeft}${"─".repeat(width - 2)}${bottomRight}`, tone, color));
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
    return renderPanel(this.title, super.render(Math.max(1, width < 8 ? width : width - 4)), width, this.color, this.tone);
  }
  override handleMouse(event: Parameters<Container["handleMouse"]>[0]) {
    const narrow = event.width < 8;
    const inset = narrow ? 0 : 2;
    const top = narrow ? wrapTextWithAnsi(terminalText(this.title).replace(/\s+/g, " ").trim(), Math.max(1, event.width)).length : 1;
    const height = event.height - top - (narrow ? 0 : 1);
    if (event.x < inset || event.x >= event.width - inset || event.y < top || event.y >= top + height) return undefined;
    return super.handleMouse({ ...event, x: event.x - inset, y: event.y - top, width: Math.max(1, event.width - inset * 2), height });
  }
}
