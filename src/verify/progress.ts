import { StringDecoder } from "node:string_decoder";

/**
 * Live progress of a check Casper runs itself, for the Working box. A progress sink is told when a check starts,
 * the last of what it printed (at most twice a second) and when it ends. It only watches: nothing a sink does
 * (or throws) changes the check's result, output or exit handling.
 */
export interface CheckProgressRun {
  /** The end of the output so far (a bounded tail, never the whole output). */
  update(tail: string): void;
  end(): void;
}
export type CheckProgress = (name: string) => CheckProgressRun | undefined;

let ambient: CheckProgress | undefined;

/** The app's own sink, used by every check it runs. Returns a function that removes it (only if still the owner). */
export function setCheckProgress(progress: CheckProgress | undefined): () => void {
  ambient = progress;
  return () => { if (ambient === progress) ambient = undefined; };
}
export function currentCheckProgress(): CheckProgress | undefined { return ambient; }

/** How much of the end of the output is kept for the display. */
export const PROGRESS_TAIL_CHARS = 2048;
/** At most this often a sink hears of new output. */
export const PROGRESS_EVERY_MS = 500;
/** A quiet runner keeps naming its last announced file, without changing the command's deadline. */
export const SLOW_FILE_MS = 10_000;

/** Feeds a sink from output chunks: keeps only a small tail, throttles, and swallows every sink error. */
export class ProgressFeed {
  private tail = "";
  private last = -Infinity;
  private pending?: ReturnType<typeof setTimeout>;
  private slow?: ReturnType<typeof setTimeout>;
  private lastOutput = 0;
  private file?: string;
  private line = "";
  private readonly decoder = new StringDecoder("utf8");
  private done = false;
  private readonly run: CheckProgressRun | undefined;

  constructor(progress: CheckProgress | undefined, name: string, private readonly now: () => number = () => performance.now()) {
    try { this.run = progress?.(name); } catch { this.run = undefined; }
  }

  get active(): boolean { return this.run !== undefined; }

  add(chunk: Buffer): void {
    if (!this.run || this.done) return;
    const text = this.decoder.write(chunk);
    this.tail = (this.tail + text).slice(-PROGRESS_TAIL_CHARS);
    this.lastOutput = this.now();
    this.scanFiles(text);
    const wait = PROGRESS_EVERY_MS - (this.now() - this.last);
    if (wait <= 0) this.flush();
    else if (!this.pending) {
      this.pending = setTimeout(() => { this.pending = undefined; this.flush(); }, wait);
      this.pending.unref?.();
    }
  }

  private scanFiles(text: string): void {
    const lines = (this.line + text).split("\n");
    this.line = lines.pop()!.slice(-PROGRESS_TAIL_CHARS);
    for (const raw of lines) {
      const line = raw.replace(/\x1b\[[\d;]*[A-Za-z]/g, "").trim();
      // Bun announces a file before executing it; Jest's RUNS is a start, unlike PASS/FAIL.
      // Keep only explicit headings, never an assertion/stack trace that happens to name a file.
      const match = /^(?:RUNS\s+(.+\.[cm]?[jt]sx?)|((?:[A-Za-z]:[\\/])?[^:\r\n]+\.[cm]?[jt]sx?):)$/.exec(line);
      const file = match?.[1] ?? match?.[2];
      if (file && file.length <= 500) this.file = file;
    }
    if (this.file) {
      // Count silence from the latest chunk, not from the first file heading's timer phase.
      if (this.slow) clearTimeout(this.slow);
      this.watchQuietFile();
    }
  }

  private watchQuietFile(wait = SLOW_FILE_MS): void {
    this.slow = setTimeout(() => {
      this.slow = undefined;
      if (this.done) return;
      const quiet = this.now() - this.lastOutput;
      if (this.file && quiet >= SLOW_FILE_MS) {
        this.last = this.now();
        try { this.run?.update(`${this.tail}\nLast announced test file: ${this.file} · no output for ${Math.floor(quiet / 1000)}s`.slice(-PROGRESS_TAIL_CHARS)); }
        catch { /* progress cannot fail a check */ }
      }
      if (!this.done) this.watchQuietFile(quiet < SLOW_FILE_MS ? SLOW_FILE_MS - quiet : SLOW_FILE_MS);
    }, wait);
    this.slow.unref?.();
  }

  private flush(): void {
    if (this.done) return;
    this.last = this.now();
    try { this.run?.update(this.tail); } catch { /* a display problem never changes a check */ }
  }

  end(): void {
    if (this.done) return;
    if (this.pending) { clearTimeout(this.pending); this.pending = undefined; this.flush(); }
    this.done = true;
    if (this.slow) { clearTimeout(this.slow); this.slow = undefined; }
    try { this.run?.end(); } catch { /* same */ }
  }
}
