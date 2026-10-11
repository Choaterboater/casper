import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SIDE_NAMES, SIDES, type Side } from "./config";
import type { PromptSet } from "./prompts";
import type { SideResult } from "./sides";

export const LABELS = ["X", "Y", "Z"] as const;
export type Label = (typeof LABELS)[number];
export type Winner = Side | "tie";

/** One run of one prompt on all three sides, kept as runs/<id>/run.json. */
export interface RunRecord {
  v: 1;
  id: string;
  created: string;
  set: PromptSet;
  promptId: string;
  prompt: string;
  starter?: string;
  model: string;
  /** Side B's commit, so a tally can keep one experiment's picks apart from the next. */
  experiment: { commit: string; dirty: boolean };
  skyn3t: { dir: string; via: string };
  minutes: number;
  sides: Partial<Record<Side, SideResult>>;
  status: "running" | "ready" | "judged";
  pick?: Winner;
  labels?: Record<Label, Side>;
}

/** One saved pick, a line of results.jsonl. */
export interface PickRecord {
  v: 1;
  time: string;
  runId: string;
  set: PromptSet;
  promptId: string;
  model: string;
  pick: Winner;
  labels: Record<Label, Side>;
  note?: string;
  experiment: { commit: string; dirty: boolean };
  /** Whether each side's app could be shown at all. */
  started: Record<Side, boolean>;
}

export const runFile = (runDir: string) => path.join(runDir, "run.json");
export async function saveRun(runDir: string, run: RunRecord): Promise<void> {
  await writeFile(runFile(runDir), `${JSON.stringify(run, null, 2)}\n`);
}
export async function loadRun(runDir: string): Promise<RunRecord> {
  return JSON.parse(await readFile(runFile(runDir), "utf8")) as RunRecord;
}

/** A fresh random X/Y/Z order for each judging, so a side's place on the page says nothing. */
export function shuffleLabels(random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32): Record<Label, Side> {
  const order: Side[] = [...SIDES];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return { X: order[0]!, Y: order[1]!, Z: order[2]! };
}

const resultsFile = (home: string) => path.join(home, "results.jsonl");
export async function appendPick(home: string, record: PickRecord): Promise<void> {
  await mkdir(home, { recursive: true });
  await appendFile(resultsFile(home), `${JSON.stringify(record)}\n`);
}

/** Every saved pick; a damaged line is skipped, not fatal. */
export async function readPicks(home: string): Promise<PickRecord[]> {
  const text = await readFile(resultsFile(home), "utf8").catch(() => "");
  const picks: PickRecord[] = [];
  for (const line of text.split("\n")) {
    try { const value = JSON.parse(line); if (value?.v === 1 && typeof value.pick === "string") picks.push(value); } catch { /* blank or damaged */ }
  }
  return picks;
}

interface Row { picks: number; wins: Record<Side, number>; ties: number }
export interface Tally { total: Row; bySet: Partial<Record<PromptSet, Row>>; experiments: string[] }

const emptyRow = (): Row => ({ picks: 0, wins: { A: 0, B: 0, C: 0 }, ties: 0 });
const count = (row: Row, pick: Winner) => { row.picks++; if (pick === "tie") row.ties++; else row.wins[pick]++; };

/** Wins per side, overall and per set. `since` (YYYY-MM-DD) and `experiment` (side B's commit) narrow it. */
export function tally(picks: readonly PickRecord[], filter: { since?: string; experiment?: string } = {}): Tally {
  const result: Tally = { total: emptyRow(), bySet: {}, experiments: [] };
  for (const pick of picks) {
    if (filter.since && pick.time.slice(0, 10) < filter.since) continue;
    if (filter.experiment && !pick.experiment.commit.startsWith(filter.experiment)) continue;
    count(result.total, pick.pick);
    count(result.bySet[pick.set] ??= emptyRow(), pick.pick);
    const commit = pick.experiment.commit + (pick.experiment.dirty ? "+changes" : "");
    if (!result.experiments.includes(commit)) result.experiments.push(commit);
  }
  return result;
}

const percent = (part: number, whole: number) => whole ? `${Math.round((part / whole) * 100)}%` : "-";

export function formatTally(result: Tally): string {
  const { total } = result;
  if (!total.picks) return "No picks yet. Run one with: bun run compare run web";
  const width = Math.max(...SIDES.map((side) => SIDE_NAMES[side].length)) + 4;
  const lines = [`Scoreboard: ${total.picks} pick${total.picks === 1 ? "" : "s"}, ${total.ties} tie${total.ties === 1 ? "" : "s"}`, ""];
  lines.push(`${"".padEnd(width)}Wins  Won`);
  for (const side of SIDES) lines.push(`${`${side}  ${SIDE_NAMES[side]}`.padEnd(width)}${String(total.wins[side]).padStart(4)}  ${percent(total.wins[side], total.picks).padStart(4)}`);
  lines.push("", "By set:");
  for (const [set, row] of Object.entries(result.bySet)) {
    lines.push(`  ${set.padEnd(8)} ${SIDES.map((side) => `${side} ${row!.wins[side]}`).join("  ")}  tie ${row!.ties}   (${row!.picks})`);
  }
  lines.push("", `Experiment builds (side B) in these picks: ${result.experiments.join(", ")}`);
  return lines.join("\n");
}
