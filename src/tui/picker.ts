import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { choiceNumber, KEY_PICK_MAX, keyChoice, typedChoice } from "./choices";
import { dim, lineText, tint } from "./format";

export interface PickerOption { label: string; description?: string }

/** Shared by mounted pickers and the surface's questions. The cursor is accent, descriptions always dim. */
export function pickerCursor(active: boolean, color: boolean): string {
  return active ? tint("❯ ", "accent", color) : "  ";
}

/** Full labels wrap under their number; short descriptions share an aligned column when they fit. */
export function pickerOptionLines(options: readonly PickerOption[], index: number, active: boolean, width: number, color: boolean,
  settings: { count?: number; offset?: number; compact?: boolean; labelWidth?: number } = {}): string[] {
  width = Math.max(1, width);
  const count = settings.count ?? options.length;
  const offset = settings.offset ?? 0;
  const option = options[index]!;
  const label = lineText(option.label);
  const description = settings.compact && !active ? undefined : option.description && lineText(option.description);
  const number = choiceNumber(index + offset, count);
  const prefix = pickerCursor(active, color) + number;
  const indent = " ".repeat(visibleWidth(prefix));
  const paint = (text: string) => active ? tint(text, "accent", color) : text;
  const descriptionStyle = (text: string) => dim(text, color);
  const column = (settings.labelWidth ?? Math.max(...options.map(row => visibleWidth(lineText(row.label))))) + indent.length + 2;
  let lines: string[];
  if (description && column + visibleWidth(description) <= width) {
    lines = [`${prefix}${paint(label)}${" ".repeat(Math.max(2, column - indent.length - visibleWidth(label)))}${descriptionStyle(description)}`];
  } else {
    lines = wrapTextWithAnsi(label, Math.max(1, width - indent.length)).map((line, at) => `${at ? indent : prefix}${paint(line)}`);
    if (description) lines.push(...wrapTextWithAnsi(description, Math.max(1, width - indent.length - 2)).map(line => `${indent}  ${descriptionStyle(line)}`));
  }
  return lines.map(line => {
    const fit = truncateToWidth(line, width);
    return color ? fit : stripVTControlCharacters(fit);
  });
}

/** Bound a wrapped row without losing its cursor/number; an ellipsis marks omitted text. */
function limitPickerLines(lines: string[], maxLines: number, width: number): string[] {
  const cap = Math.max(1, maxLines);
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap - 1), truncateToWidth(lines[cap - 1]!, Math.max(0, width - 1), "") + "…"];
}

/** A rendered-line window, always retaining the selected row even when that row alone is too tall. */
export function pickerWindow(rows: string[][], active: number, maxLines: number, width: number): { start: number; end: number; lines: string[] } {
  if (!rows.length || maxLines < 1) return { start: 0, end: 0, lines: [] };
  const selected = limitPickerLines(rows[active]!, maxLines, width);
  let start = active, end = active + 1, used = selected.length;
  for (let grew = true; grew;) {
    grew = false;
    if (end < rows.length && used + rows[end]!.length <= maxLines) { used += rows[end]!.length; end++; grew = true; }
    if (start > 0 && used + rows[start - 1]!.length <= maxLines) { start--; used += rows[start]!.length; grew = true; }
  }
  return { start, end, lines: [...rows.slice(start, active).flat(), ...selected, ...rows.slice(active + 1, end).flat()] };
}

/** A small, numbered list without Pi's separate arrow style or text-entry row. */
export class PickerList implements Component {
  private index = 0;
  private number = "";
  onSelect?: (item: { value: string; label: string; description?: string }) => void;
  onCancel?: () => void;
  constructor(private readonly items: { value: string; label: string; description?: string }[], private readonly color: boolean,
    private readonly maxVisible = 9) {}
  invalidate(): void {}
  setSelectedIndex(index: number): void { this.index = Math.max(0, Math.min(index, this.items.length - 1)); }
  getSelectedItem(): (typeof this.items)[number] | undefined { return this.items[this.index]; }
  render(width: number): string[] {
    if (!this.items.length) return [tint("No choices", "muted", this.color)];
    const start = Math.max(0, Math.min(this.index - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible));
    const lines = this.items.slice(start, start + this.maxVisible).flatMap((_, offset) =>
      pickerOptionLines(this.items, start + offset, start + offset === this.index, width, this.color));
    if (this.items.length > this.maxVisible) lines.push(tint(`${this.index + 1}/${this.items.length} · ↑/↓ for more`, "muted", this.color));
    if (this.number) lines.push(tint(`Number: ${this.number}`, "muted", this.color));
    return lines;
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { this.onCancel?.(); return; }
    const digit = keyChoice(data, this.items.length);
    if (digit >= 0) { this.index = digit; this.onSelect?.(this.items[digit]!); return; }
    if (this.items.length > KEY_PICK_MAX && /^\d$/.test(data)) { this.number = (this.number + data).slice(0, 3); return; }
    if (matchesKey(data, "backspace")) { this.number = this.number.slice(0, -1); return; }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.number = "";
      if (this.items.length) this.index = (this.index + (matchesKey(data, "up") ? this.items.length - 1 : 1)) % this.items.length;
    } else if (matchesKey(data, "enter")) {
      const index = this.number ? typedChoice(this.number, this.items.length) : this.index;
      this.number = "";
      if (index >= 0 && this.items[index]) { this.index = index; this.onSelect?.(this.items[index]!); }
    }
  }
}
