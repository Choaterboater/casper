import { Container, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { paint, terminalText } from "./format";

export type PanelTone = "accent" | "assistant" | "success" | "warning" | "error" | "muted";

const colors: Record<PanelTone, string> = {
  accent: "36", assistant: "35", success: "32", warning: "33", error: "31", muted: "2",
};

/** Semantic colors always accompany readable titles or status labels. */
export function panelColor(text: string, tone: PanelTone, color: boolean): string {
  return paint(text, colors[tone], color);
}

/** Body lines contain trusted styling only; callers sanitize external text before styling. */
export function renderPanel(title: string, body: readonly string[], width: number, color: boolean, tone: PanelTone = "accent"): string[] {
  width = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
  const label = terminalText(title).replace(/\s+/g, " ").trim();
  if (width < 8) return [label, ...body].flatMap(line => wrapTextWithAnsi(line, width))
    .map(line => visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line);
  const inner = width - 4;
  const heading = truncateToWidth(` ${label} `, width - 4, "");
  const top = `╭─${heading}${"─".repeat(Math.max(0, width - 3 - visibleWidth(heading)))}╮`;
  const rows = [panelColor(top, tone, color)];
  const border = panelColor("│", tone, color);
  for (const source of body) {
    for (const line of wrapTextWithAnsi(source, inner)) {
      rows.push(`${border} ${line}${" ".repeat(Math.max(0, inner - visibleWidth(line)))} ${border}`);
    }
  }
  rows.push(panelColor(`╰${"─".repeat(width - 2)}╯`, tone, color));
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
