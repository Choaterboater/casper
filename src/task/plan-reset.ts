/**
 * Going on by itself when a Claude plan limit resets (docs/adr/0002/107-a-task-goes-on-when-the-claude-plan-resets.md).
 * A task stopped on a used-up Claude plan window, with no failover model to go on: when the window resets within a day
 * (in practice the 5-hour limit), Casper waits for it and sends the AI on, as one of keep going's rounds. No model call
 * and no tokens until then.
 */
import { clockTime, planLimitInError, planWindowName } from "../runtime/plan-limits";

/** The longest Casper waits for a reset: a question in a walk-away job waits as long (decision 51). */
export const PLAN_WAIT_LIMIT_MS = 24 * 60 * 60_000;
/** A little after the reset, so the window has surely reset on Claude's side too. */
export const RESET_GRACE_MS = 30_000;
/** The timer wakes at least this often: the wall clock is read again (a computer asleep, a clock that moved). */
const STEP_MS = 60_000;

export const PLAN_RESET_PROMPT = "Continue where you left off. Your last turn stopped at a usage limit; check what already took effect before repeating a step that changes files or state.";

/** The used-up window a failed turn's error names, with its reset still ahead; `wait` when it is near enough to wait for. */
export function planReset(errorMessage: string, now = Date.now()): { window: string; resetsAt: number; wait: boolean } | undefined {
  const held = planLimitInError(errorMessage);
  if (!held || held.resetsAt <= now) return undefined;
  return { ...held, wait: held.resetsAt - now <= PLAN_WAIT_LIMIT_MS };
}

/** "Claude's 5-hour limit resets at 3:40 PM; Casper goes on then. Type anything or press Esc to cancel." */
export function planWaitLine(reset: { window: string; resetsAt: number }, rich: boolean, now = Date.now()): string {
  return `Claude's ${planWindowName(reset.window)} limit resets at ${clockTime(reset.resetsAt, now)}; Casper goes on then. Type anything${rich ? " or press Esc" : ""} to cancel.`;
}

/** A reset more than a day away: said, and nothing waits for it. */
export function planTooFarLine(reset: { window: string; resetsAt: number }, now = Date.now()): string {
  return `Claude's ${planWindowName(reset.window)} limit resets at ${clockTime(reset.resetsAt, now)}, more than a day away, so Casper doesn't wait for it.`;
}

/** The job's "why" while it waits: "the Claude plan's 5-hour limit resets at 3:40 PM". */
export function planWaitWhy(reset: { window: string; resetsAt: number }, now = Date.now()): string {
  return `the Claude plan's ${planWindowName(reset.window)} limit resets at ${clockTime(reset.resetsAt, now)}`;
}

/** The clock the wait runs on; tests pass their own. */
export interface ResetClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: ResetClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Waits until `at` on the wall clock. `done` is true then, false once cancelled or `signal` aborts. The timer doesn't
 * keep Casper running: an open terminal does, and a walk-away job holds itself while it waits (src/app/away.ts). */
export function waitUntil(at: number, options: { signal?: AbortSignal; clock?: ResetClock } = {}): { done: Promise<boolean>; cancel(): void } {
  const clock = options.clock ?? realClock;
  const { promise: done, resolve } = Promise.withResolvers<boolean>();
  let handle: unknown;
  let over = false;
  const finish = (value: boolean) => {
    if (over) return;
    over = true;
    clock.clearTimeout(handle);
    options.signal?.removeEventListener("abort", aborted);
    resolve(value);
  };
  const aborted = () => finish(false);
  const step = () => {
    if (over) return;
    const left = at - clock.now();
    if (left <= 0) { finish(true); return; }
    handle = clock.setTimeout(step, Math.min(left, STEP_MS));
    (handle as { unref?: () => void } | undefined)?.unref?.();
  };
  if (options.signal?.aborted) finish(false);
  else { options.signal?.addEventListener("abort", aborted, { once: true }); step(); }
  return { done, cancel: () => finish(false) };
}

/** Whether two listings of the folder (path → fingerprint) hold the same files. */
export function sameFiles(a: ReadonlyMap<string, string> | undefined, b: ReadonlyMap<string, string> | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.size !== b.size) return false;
  for (const [file, print] of a) if (b.get(file) !== print) return false;
  return true;
}
