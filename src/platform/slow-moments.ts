import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Slow moments (decision 110): while an interactive session runs, one 250 ms timer measures how late it fires. A
 * timer 2 s or more late means Casper's event loop was stuck that long (the screen and Esc did not answer); a short
 * tick keeps the measure within a quarter second of the real length. Each one is a
 * JSON line in ~/.casper/run/slow.log: when, how long, memory in use, and what was running when there is a word for
 * it. Nothing is sent and no model is asked; /doctor counts the last day's. A drift timer is used rather than
 * perf_hooks' event-loop histogram: it needs nothing from the runtime, and it gives each moment and its length.
 */

export const SLOW_MS = 2_000;
export const TICK_MS = 250;
export const SLOW_LOG_MAX_BYTES = 256 * 1024;
/** A timer this late is a computer that slept (on Windows the clock runs on through sleep) or a Casper paused from
 * outside (Ctrl+Z), not a stuck loop: a loop stuck a whole minute is far rarer than either. */
export const ASLEEP_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const ACTIVITY_CHARS = 80;

export interface SlowMoment {
  /** When it ended, as ISO text. */
  time: string;
  /** How long the loop was stuck. */
  ms: number;
  /** Memory in use then (resident set, bytes). */
  rss: number;
  /** What was running, in a few words; left out when nothing was. */
  activity?: string;
}

export function slowLogPath(home: string): string {
  return path.join(home, ".casper", "run", "slow.log");
}

export interface SlowMomentsOptions {
  home: string;
  /** Read at each slow moment: false notes nothing (slow_moments: off), from that moment on. */
  enabled?: () => boolean;
  /** What is running now, in a few words, or undefined. */
  activity?: () => string | undefined;
  /** A clock that only moves forward (tests pass their own). */
  monotonic?: () => number;
  /** Wall-clock time for the record (tests pass their own). */
  clock?: () => number;
  rss?: () => number;
  /** Calls `tick` every `ms` until stopped (tests drive it by hand). */
  every?: (ms: number, tick: () => void) => { stop(): void };
  maxBytes?: number;
}

export interface SlowMomentsWatch {
  /** Stops the timer; resolves once a moment being written is on disk. */
  stop(): Promise<void>;
  /** Resolves once every moment noted so far is on disk (tests). */
  settled(): Promise<void>;
}

function realTimer(ms: number, tick: () => void): { stop(): void } {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** Start watching for slow moments. Never throws: a log that can't be written is skipped. */
export function watchSlowMoments(options: SlowMomentsOptions): SlowMomentsWatch {
  const monotonic = options.monotonic ?? (() => performance.now());
  const clock = options.clock ?? Date.now;
  const rss = options.rss ?? (() => process.memoryUsage().rss);
  const every = options.every ?? realTimer;
  let last = monotonic();
  let writing: Promise<void> = Promise.resolve();
  let stopped = false;
  const timer = every(TICK_MS, () => {
    if (stopped) return;
    const now = monotonic();
    const late = now - last - TICK_MS;
    last = now;
    if (late < SLOW_MS || late >= ASLEEP_MS || options.enabled?.() === false) return;
    let activity: string | undefined;
    try { activity = options.activity?.()?.replace(/\s+/g, " ").trim().slice(0, ACTIVITY_CHARS) || undefined; } catch { activity = undefined; }
    let memory = 0;
    try { memory = rss(); } catch { /* not known */ }
    const moment: SlowMoment = { time: new Date(clock()).toISOString(), ms: Math.round(late), rss: memory, ...(activity ? { activity } : {}) };
    writing = writing.then(() => noteSlowMoment(options.home, moment, options.maxBytes)).catch(() => {});
  });
  return {
    stop: async () => { stopped = true; timer.stop(); await writing; },
    settled: () => writing,
  };
}

/** Append one moment to slow.log (0600, in the 0700 run folder). Past `maxBytes` the older half is dropped. */
export async function noteSlowMoment(home: string, moment: SlowMoment, maxBytes = SLOW_LOG_MAX_BYTES): Promise<void> {
  const file = slowLogPath(home);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(moment)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(file, 0o600).catch(() => {});
  const size = (await stat(file)).size;
  if (size <= maxBytes) return;
  const text = await readFile(file, "utf8");
  // Keep the newer half, from the start of a whole line.
  const half = text.slice(text.length - Math.floor(maxBytes / 2));
  const kept = half.slice(half.indexOf("\n") + 1);
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, kept, { mode: 0o600 });
  await rename(temporary, file);
}

/** The moments in slow.log, oldest first; lines that don't read as one are skipped. Empty when there is no log. */
export async function readSlowMoments(home: string): Promise<SlowMoment[]> {
  const text = await readFile(slowLogPath(home), "utf8").catch(() => "");
  const moments: SlowMoment[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<SlowMoment>;
      if (typeof value.time !== "string" || typeof value.ms !== "number" || !Number.isFinite(value.ms)) continue;
      moments.push({ time: value.time, ms: value.ms, rss: typeof value.rss === "number" ? value.rss : 0,
        ...(typeof value.activity === "string" && value.activity ? { activity: value.activity } : {}) });
    } catch { /* a torn line */ }
  }
  return moments;
}

export interface SlowMomentsSummary {
  count: number;
  /** The longest one, when there was one. */
  longest?: SlowMoment;
}

/** The moments in the day before `now`. */
export async function recentSlowMoments(home: string, now: number): Promise<SlowMomentsSummary> {
  const recent = (await readSlowMoments(home)).filter((moment) => {
    const at = Date.parse(moment.time);
    return Number.isFinite(at) && at > now - DAY_MS && at <= now + 60_000;
  });
  const longest = recent.reduce<SlowMoment | undefined>((best, moment) => !best || moment.ms > best.ms ? moment : best, undefined);
  return { count: recent.length, ...(longest ? { longest } : {}) };
}

/** "6.1 s" */
export function slowSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
