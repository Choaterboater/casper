import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { HelperActivity, SubagentStatus } from "../agents/manager";
import { formatElapsed, formatTokens, redactPreview, terminalText, tint } from "./format";
import { GLYPHS } from "./glyphs";

export const CREW_FADE_MS = 1200;
export const CREW_EXPIRE_MS = 6000;
export const CREW_ROW_CAP = 4;

interface CrewRow {
  id: number;
  name: string;
  goal: string;
  startedAt: number;
  activity: string;
  tokens?: number;
  finishedAt?: number;
  status?: SubagentStatus;
  waitedMs: number;
  waitingSince?: number;
}

const clean = (text: string) => terminalText(redactPreview(text)).replace(/\s+/g, " ").trim();

/** Ephemeral helper rows, separate from the transcript. No tool output or approval answers are retained. */
export class CrewPanel {
  private readonly helpers = new Map<number, CrewRow>();
  private builder = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}

  update(activity: HelperActivity): void {
    const { run } = activity;
    if (run.role === "explorer") return;
    let row = this.helpers.get(run.id);
    if (!row) {
      if (activity.kind !== "start") return; // Ignore a late event after expiry.
      row = { id: run.id, name: run.label ?? (run.role === "builder" ? `Builder ${++this.builder}` : `Reviewer ${run.id}`),
        goal: clean(run.goal), startedAt: this.now(), activity: "Starting", waitedMs: 0 };
      this.helpers.set(run.id, row);
    }
    row.tokens = run.spent?.tokens ?? row.tokens;
    if (activity.kind === "tool" && row.finishedAt === undefined) {
      row.activity = activity.event.type === "tool_end" ? "Thinking" : clean(activity.event.toolName) + "…";
    } else if (activity.kind === "end" && row.finishedAt === undefined) {
      this.resume(row);
      row.finishedAt = this.now();
      row.status = activity.status;
      row.activity = activity.status === "completed"
        ? run.role === "reviewer" && activity.response?.trim() ? clean(activity.response.split("\n").find(line => line.trim()) ?? "Done") : "Done"
        : activity.status.replaceAll("_", " ");
    }
  }

  /** Only the helper whose approval is waiting pauses; other helpers keep their own running clocks. */
  setWaiting(name: string, waiting: boolean): void {
    for (const row of this.helpers.values()) {
      if (row.name !== name || row.finishedAt !== undefined) continue;
      if (waiting) row.waitingSince ??= this.now();
      else this.resume(row);
    }
  }

  private resume(row: CrewRow): void {
    if (row.waitingSince === undefined) return;
    row.waitedMs += Math.max(0, this.now() - row.waitingSince);
    row.waitingSince = undefined;
  }

  private current(): CrewRow[] {
    for (const [id, row] of this.helpers) {
      if (row.finishedAt !== undefined && this.now() - row.finishedAt >= CREW_EXPIRE_MS) this.helpers.delete(id);
    }
    return [...this.helpers.values()].sort((a, b) => Number(a.finishedAt !== undefined) - Number(b.finishedAt !== undefined) || a.id - b.id);
  }

  get size(): number { return this.current().length; }

  /** Height includes the overflow/hint row. Even a one-column or one-row terminal gets bounded output. */
  render(width: number, height: number, options: { color?: boolean; frame?: number; details?: boolean; offset?: number } = {}): string[] {
    if (width < 1 || height < 1) return [];
    const rows = this.current();
    if (!rows.length) return [];
    const cap = options.details ? Math.max(1, height - 1) : Math.min(CREW_ROW_CAP, Math.max(1, height - 1));
    const offset = options.details ? Math.min(Math.max(0, options.offset ?? 0), Math.max(0, rows.length - cap)) : 0;
    const shown = rows.slice(offset, offset + cap);
    const lines = shown.map(row => {
      const waited = row.waitedMs + (row.waitingSince === undefined ? 0 : Math.max(0, this.now() - row.waitingSince));
      const elapsed = Math.max(0, (row.finishedAt ?? this.now()) - row.startedAt - waited);
      const mark = row.finishedAt !== undefined ? row.status === "completed" ? "✓" : "○"
        : row.waitingSince !== undefined ? "?" : GLYPHS.spinner[(options.frame ?? 0) % GLYPHS.spinner.length]!;
      const time = `${formatElapsed(elapsed)} · ${row.tokens === undefined ? "—" : formatTokens(row.tokens)} tokens${waited ? ` · waited ${formatElapsed(waited)}` : ""}`;
      const lead = `${mark} ${clean(row.name)}`;
      const activity = row.waitingSince === undefined ? row.activity : "waiting for you";
      const room = width - visibleWidth(`${lead} ·  · ${time}`);
      const line = room >= 4 ? `${lead} · ${truncateToWidth(activity, room, "…")} · ${time}` : `${lead} · ${time}`;
      const full = `${line} · ${row.goal}`;
      const faded = row.finishedAt !== undefined && this.now() - row.finishedAt >= CREW_FADE_MS;
      return tint(truncateToWidth(full, width, "…"), faded ? "muted" : "accent", options.color ?? false);
    });
    const hidden = rows.length - shown.length;
    if (lines.length < height) lines.push(tint(truncateToWidth(options.details
      ? `Crew ${offset + 1}–${offset + shown.length}/${rows.length} · ↑↓ scroll · Ctrl+O closes · Alt+O raw steps`
      : `${hidden ? `+${hidden} more · ` : ""}Ctrl+O crew details · Alt+O raw steps`, width, "…"), "muted", options.color ?? false));
    return options.color ? lines : lines.map(stripVTControlCharacters);
  }
}

/** Rich transcript keeps outcomes, never helper start/update chatter. Plain output is deliberately unchanged. */
export function crewTranscriptLine(line: string, rich: boolean): string | undefined {
  if (!rich) return `[crew] ${terminalText(line)}\n`;
  if (!/\b(?:was applied to your folder|Applied to your folder|work was not applied)\b/.test(line)) return undefined;
  return `[crew] ${clean(line)}\n`;
}
