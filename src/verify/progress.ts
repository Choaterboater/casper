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

/** Feeds a sink from output chunks: keeps only a small tail, throttles, and swallows every sink error. */
export class ProgressFeed {
  private tail = "";
  private last = -Infinity;
  private pending?: ReturnType<typeof setTimeout>;
  private done = false;
  private readonly run: CheckProgressRun | undefined;

  constructor(progress: CheckProgress | undefined, name: string, private readonly now: () => number = () => performance.now()) {
    try { this.run = progress?.(name); } catch { this.run = undefined; }
  }

  get active(): boolean { return this.run !== undefined; }

  add(chunk: Buffer): void {
    if (!this.run || this.done) return;
    this.tail = (this.tail + chunk.toString("utf8")).slice(-PROGRESS_TAIL_CHARS);
    const wait = PROGRESS_EVERY_MS - (this.now() - this.last);
    if (wait <= 0) this.flush();
    else if (!this.pending) {
      this.pending = setTimeout(() => { this.pending = undefined; this.flush(); }, wait);
      this.pending.unref?.();
    }
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
    try { this.run?.end(); } catch { /* same */ }
  }
}
