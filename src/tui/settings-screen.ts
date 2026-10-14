import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { RuntimePickerView } from "../runtime/types";
import { SETTINGS_AREAS, settingsArea } from "../app/settings-areas";
import { choiceHint, choiceNumber, keyChoice, typedChoice } from "./choices";
import { hasLineControls, lineText, tint } from "./format";

export interface ScreenSetting {
  label: string;
  value: string;
  question: string;
  keep: string;
  choices: { label: string; value: unknown; description?: string }[];
}
export interface SettingsUpdate { rows: ScreenSetting[]; note: string }
export const SETTINGS_HINT = "↑/↓ move · Enter/Space change · ←/→/Tab area · type to search · Esc close";

/** One live component owns both the settings and their small numbered choices. */
export class SettingsScreen implements Component {
  private area = 0;
  private selected = 0;
  private search = "";
  private width = 80;
  private areaList = true;
  private choosing?: ScreenSetting;
  private choiceIndex = 0;
  private choiceNumber = "";
  private saving = false;
  private closed = false;
  private note = "";

  constructor(private rows: ScreenSetting[], private readonly color: boolean,
    private readonly change: (label: string, choice: number) => Promise<SettingsUpdate>,
    private readonly close: () => void, private readonly redraw: () => void,
    private readonly height: () => number = () => 24, private readonly eof: () => void = close) {}

  invalidate(): void {}
  cancel(): void { this.finish(); }
  private shown(): ScreenSetting[] {
    return this.rows.filter(row => this.search
      ? `${row.label} ${row.question} ${SETTINGS_AREAS[settingsArea(row.label)]!.name}`.toLowerCase().includes(this.search.toLowerCase())
      : settingsArea(row.label) === this.area);
  }
  private finish(): void { if (!this.closed) { this.closed = true; this.close(); } }
  private switchArea(delta: number): void {
    this.area = (this.area + delta + SETTINGS_AREAS.length) % SETTINGS_AREAS.length;
    this.search = ""; this.selected = 0; this.areaList = false;
  }
  private async save(row: ScreenSetting, choice: number): Promise<void> {
    this.saving = true;
    try {
      const update = await this.change(row.label, choice);
      this.rows = update.rows; this.note = update.note;
      // Search may match the old value/help only: retain the row whenever it still matches.
      const index = this.shown().findIndex(item => item.label === row.label);
      this.selected = index < 0 ? Math.min(this.selected, Math.max(0, this.shown().length - 1)) : index;
    } catch (error) { this.note = `Not saved: ${error instanceof Error ? error.message : String(error)}`; }
    finally { this.saving = false; this.choosing = undefined; this.redraw(); }
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "ctrl+d")) { this.finish(); this.eof(); return; }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (this.choosing && !this.saving) this.choosing = undefined;
      else this.finish();
      this.redraw(); return;
    }
    if (this.saving) return;
    const up = matchesKey(data, "up"), down = matchesKey(data, "down");
    const enter = matchesKey(data, "enter") || (data === " " && (!this.search || this.choosing !== undefined));
    if (this.choosing) {
      const count = this.choosing.choices.length + 1;
      const digit = keyChoice(data, count);
      if (count > 9 && /^\d$/.test(data)) this.choiceNumber += data;
      else if (matchesKey(data, "backspace")) this.choiceNumber = this.choiceNumber.slice(0, -1);
      else if (up || down) { this.choiceNumber = ""; this.choiceIndex = (this.choiceIndex + (down ? 1 : -1) + count) % count; }
      else if (enter || digit >= 0) {
        const typed = this.choiceNumber ? typedChoice(this.choiceNumber, count) : this.choiceIndex;
        const index = digit >= 0 ? digit : typed;
        if (index < 0) { this.redraw(); return; }
        if (!index) this.choosing = undefined;
        else void this.save(this.choosing, index - 1);
      }
    } else if (matchesKey(data, "left") || matchesKey(data, "right") || matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.switchArea(matchesKey(data, "left") || matchesKey(data, "shift+tab") ? -1 : 1);
    } else if (up || down) {
      const areas = this.width < 80 && this.areaList && !this.search;
      const count = areas ? SETTINGS_AREAS.length : this.shown().length;
      if (count) {
        if (areas) this.area = (this.area + (down ? 1 : -1) + count) % count;
        else this.selected = (this.selected + (down ? 1 : -1) + count) % count;
      }
    } else if (enter) {
      if (this.width < 80 && this.areaList && !this.search) this.areaList = false;
      else {
        const row = this.shown()[this.selected];
        if (row?.choices.length === 1 && typeof row.choices[0]!.value === "boolean") void this.save(row, 0);
        else if (row) { this.choosing = row; this.choiceIndex = 0; this.choiceNumber = ""; }
      }
    } else if (matchesKey(data, "backspace")) {
      this.search = Array.from(this.search).slice(0, -1).join(""); this.selected = 0;
    } else if (data && !hasLineControls(data)) {
      this.search += lineText(data); this.selected = 0;
    }
    this.redraw();
  }

  render(width: number): string[] {
    this.width = width;
    const fit = (text: string) => truncateToWidth(text, Math.max(1, width));
    const style = (text: string, role: "accent" | "selection" | "muted" | "border") => tint(text, role, this.color);
    const lines = [style("─".repeat(Math.max(1, width)), "border"), style("Settings · saved for you", "accent")];
    if (width >= 80) lines.push(SETTINGS_AREAS.map((area, index) => style(index === this.area && !this.search ? `[${area.tab}]` : ` ${area.tab} `,
      index === this.area && !this.search ? "selection" : "muted")).join(" "));
    const areas = width < 80 && this.areaList && !this.search && !this.choosing;
    if (areas) {
      lines.push("Areas · Enter opens one");
      lines.push(...SETTINGS_AREAS.map((area, index) => style(`${index === this.area ? "❯" : " "} ${area.name}`, index === this.area ? "selection" : "muted")));
    } else if (this.choosing) {
      lines.push(style(this.choosing.label, "accent"));
      const options = [{ label: this.choosing.keep }, ...this.choosing.choices];
      const cap = Math.max(1, Math.min(10, this.height() - 11));
      const start = Math.max(0, Math.min(this.choiceIndex - Math.floor(cap / 2), options.length - cap));
      lines.push(...options.slice(start, start + cap).map((option, offset) => {
        const index = start + offset;
        return style(`${index === this.choiceIndex ? "❯" : " "} ${choiceNumber(index, options.length)}${lineText(option.label)}${"description" in option && option.description ? ` · ${lineText(option.description)}` : ""}`,
          index === this.choiceIndex ? "selection" : "muted");
      }));
      if (options.length > cap) lines.push(style(`${this.choiceIndex + 1}/${options.length} · ↑/↓ for more`, "muted"));
      if (this.choiceNumber) lines.push(`Number: ${this.choiceNumber}`);
      lines.push(style(fit(lineText(this.choosing.question)), "muted"));
      lines.push(style(choiceHint(options.length, "Esc back"), "muted"));
    } else {
      lines.push(style(this.search ? `Search: ${this.search}` : SETTINGS_AREAS[this.area]!.name, "accent"));
      const rows = this.shown();
      const maxRows = Math.max(1, Math.min(10, this.height() - 11));
      const start = Math.max(0, Math.min(this.selected - Math.floor(maxRows / 2), rows.length - maxRows));
      // Leave space for the value even on narrow windows; Pi counts terminal cells, not code units.
      const labelWidth = Math.max(1, Math.min(36, width >= 60 ? width - 25 : Math.floor((width - 4) * 0.6)));
      lines.push(...rows.slice(start, start + maxRows).map((row, offset) => {
        const label = truncateToWidth(lineText(row.label), labelWidth);
        const text = `${start + offset === this.selected ? "❯" : " "} ${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)) + 2)}${lineText(row.value)}`;
        return style(fit(text), start + offset === this.selected ? "selection" : "muted");
      }));
      if (!rows.length) lines.push("No settings match");
      if (rows.length > maxRows) lines.push(style(`${this.selected + 1}/${rows.length} · ↑/↓ for more`, "muted"));
      lines.push("", style(fit(lineText(rows[this.selected]?.question ?? "Type another word, or Backspace to clear the search.")), "muted"));
    }
    if (this.note || this.saving) lines.push(style(this.saving ? "Saving…" : lineText(this.note), "muted"));
    if (!this.choosing) {
      // Split the same short hint where narrow terminals cannot keep it on one line.
      const parts = (this.search ? SETTINGS_HINT.replace("Enter/Space change", "Enter change · Space in search") : SETTINGS_HINT).split(" · ");
      let hint = "";
      for (const part of parts) {
        if (hint && visibleWidth(`${hint} · ${part}`) > width) { lines.push(style(hint, "muted")); hint = part; }
        else hint = hint ? `${hint} · ${part}` : part;
      }
      if (hint) lines.push(style(hint, "muted"));
    }
    lines.push(style("─".repeat(Math.max(1, width)), "border"));
    // Pi's truncation can add SGR resets even to plain text; NO_COLOR means no SGR at all.
    return lines.map(line => this.color ? fit(line) : stripVTControlCharacters(fit(line)).trimEnd());
  }
}

export async function showSettings(view: RuntimePickerView, rows: ScreenSetting[],
  change: (label: string, choice: number) => Promise<SettingsUpdate>, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let pending: Promise<SettingsUpdate> | undefined;
  const screen = new SettingsScreen(rows, view.color, (label, choice) => pending = change(label, choice), resolve,
    () => view.tui.requestRender(), () => view.tui.terminal.rows, () => view.onEOF());
  const cancel = () => screen.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (!signal?.aborted) { view.show(screen); view.tui.setFocus(screen); await promise; }
    // A deliberate save already started is finished before returning the terminal slot.
    await pending?.catch(() => {}); // The screen already showed a failed save; closing is not a second failure.
  } finally { signal?.removeEventListener("abort", cancel); }
}
