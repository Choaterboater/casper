/**
 * Time limits for one MCP tool call.
 *
 * Two timers drive one abort signal: an idle timer (restarted by each progress message from the
 * server) and a hard cap for the whole call. pause() stops BOTH timers while Casper waits for the
 * user (an approval or elicitation prompt), so a slow reader never uses up the server's time.
 * The MCP SDK's own request timeout cannot be paused, so the caller should set it far above the
 * cap and let this clock own cancellation through `signal`.
 */

export type ClockReason = "idle" | "hard";

/** Abort reason carried by `CallClock.signal`. The SDK rethrows it as McpError(RequestTimeout, String(reason)). */
export class CallClockTimeout extends Error {
  constructor(readonly reason: ClockReason, readonly limitMs: number) {
    super(reason === "idle" ? `No answer in ${formatDuration(limitMs)}` : `Still working after ${formatDuration(limitMs)}`);
    this.name = "CallClockTimeout";
  }
}

export interface ClockTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: ClockTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CallClock {
  readonly signal: AbortSignal;
  /** Last progress message from the server, as given to progress(). The caller redacts it. */
  lastProgress?: string;
  private readonly controller = new AbortController();
  private readonly timers: ClockTimers;
  private idleTimer: unknown;
  private hardTimer: unknown;
  private hardDeadline: number;
  private hardRemaining: number;
  private pauses = 0;
  private done = false;
  private tagged?: ClockReason;

  constructor(readonly idleMs: number, readonly hardMs: number, timers: ClockTimers = realTimers) {
    if (!(idleMs > 0) || !(hardMs > 0)) throw new RangeError("Call clock limits must be positive");
    this.timers = timers;
    this.signal = this.controller.signal;
    this.hardRemaining = hardMs;
    this.hardDeadline = timers.now() + hardMs;
    this.startIdle();
    this.startHard();
  }

  /** Why the clock stopped the call, or undefined while it has not. */
  reason(): ClockReason | undefined { return this.tagged; }

  get paused(): boolean { return this.pauses > 0; }

  /** Restart the idle timer (the server showed it is still working). No effect while paused or after stop. */
  reset(): void {
    if (this.done || this.pauses > 0) return;
    this.startIdle();
  }

  /** A progress message arrived: restart the idle timer and remember the message. */
  progress(message?: string): void {
    if (this.done) return;
    if (message !== undefined) this.lastProgress = message;
    this.reset();
  }

  /** Stop both timers while waiting for the user. Pauses nest; each pause() needs one resume(). */
  pause(): void {
    if (this.done) return;
    if (this.pauses++ > 0) return;
    this.hardRemaining = Math.max(0, this.hardDeadline - this.timers.now());
    this.clearTimers();
  }

  /** Start again after the user answered: a fresh idle period and the hard cap time that was left. */
  resume(): void {
    if (this.done || this.pauses === 0) return;
    if (--this.pauses > 0) return;
    this.hardDeadline = this.timers.now() + this.hardRemaining;
    this.startIdle();
    this.startHard();
  }

  /** Stop the timers for good (call finished). The signal is left as it is. */
  dispose(): void {
    this.done = true;
    this.clearTimers();
  }

  private startIdle(): void {
    if (this.idleTimer !== undefined) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = this.timers.setTimeout(() => this.fire("idle"), this.idleMs);
  }

  private startHard(): void {
    if (this.hardTimer !== undefined) this.timers.clearTimeout(this.hardTimer);
    this.hardTimer = this.timers.setTimeout(() => this.fire("hard"), this.hardRemaining);
  }

  private clearTimers(): void {
    if (this.idleTimer !== undefined) this.timers.clearTimeout(this.idleTimer);
    if (this.hardTimer !== undefined) this.timers.clearTimeout(this.hardTimer);
    this.idleTimer = this.hardTimer = undefined;
  }

  private fire(reason: ClockReason): void {
    if (this.done || this.pauses > 0) return;
    this.done = true;
    this.tagged = reason;
    this.clearTimers();
    this.controller.abort(new CallClockTimeout(reason, reason === "idle" ? this.idleMs : this.hardMs));
  }
}

/** Plain duration for people: 500 -> "0.5 s", 90_000 -> "90 s", 600_000 -> "10 min". */
export function formatDuration(ms: number): string {
  if (ms >= 120_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Number((ms / 1000).toFixed(ms < 1000 ? 2 : 1))} s`;
}
