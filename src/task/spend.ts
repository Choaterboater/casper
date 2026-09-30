/**
 * What one task spends, and the automatic limits on it. Nothing to set up: a quiet note at about $1 and a pause
 * at about $5 per task, from the model's own price. `spend.noteAt` and `spend.pauseAt` in ~/.casper/config.yaml
 * change them or turn them off (docs/CONFIGURATION.md). A free model costs nothing, so it only shows tokens.
 * Costs are the catalog's estimate from the model's price, never a bill.
 */

/** Dollars per task; undefined turns that limit off. */
export interface SpendLimits { noteAt?: number; pauseAt?: number }

/** What the model is told when the spend pause stops its tool call. The screen says "not run" instead. */
export const SPEND_STOP_REASON = "Stopped: this task reached its spend limit, so Casper stopped it here. Do not call more tools.";

export const DEFAULT_SPEND_LIMITS: Required<SpendLimits> = { noteAt: 1, pauseAt: 5 };

/** "$0.004", "$0.31", "$5.02", "$12". */
export function formatCost(dollars: number): string {
  if (dollars > 0 && dollars < 0.01) return `$${dollars.toFixed(3)}`;
  if (dollars >= 100) return `$${Math.round(dollars)}`;
  return `$${dollars.toFixed(2)}`;
}

/** A limit as the user wrote it: "$5", "$2.50". */
export function formatLimit(dollars: number): string {
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/** "950 tok", "48.2k tok", "8.1M tok". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens} tok`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 100_000 ? 1 : 0)}k tok`;
  return `${(tokens / 1_000_000).toFixed(1)}M tok`;
}

/** The footer's task segment: tokens, and the cost unless the model is free. A subscription pays no per-token
 * price, so its figure is only what the tokens would cost: "sub ≈$0.31". */
export function formatTaskSpend(spent: { tokens: number; cost: number }, priced: boolean | undefined, billing?: "subscription" | "per-token"): string {
  const tokens = `task ${formatTokens(spent.tokens)}`;
  if (priced === false || (priced === undefined && spent.cost <= 0)) return tokens;
  return `${tokens} · ${billing === "subscription" ? "sub ≈" : ""}${formatCost(spent.cost)}`;
}

/** Per task: says the note once, and asks at the pause limit, then again at each further multiple of it. */
export class SpendGuard {
  private noted = false;
  private nextPause?: number;

  constructor(private readonly limits: SpendLimits) { this.nextPause = limits.pauseAt; }

  /** True once, when the task first reaches the note limit (and not already the pause). */
  noteDue(cost: number): boolean {
    if (this.noted || this.limits.noteAt === undefined || cost < this.limits.noteAt) return false;
    this.noted = true;
    return this.nextPause === undefined || cost < this.nextPause;
  }

  /** The limit the task has reached and not yet been asked about, if any. */
  pauseDue(cost: number): number | undefined {
    return this.nextPause !== undefined && cost >= this.nextPause ? this.nextPause : undefined;
  }

  /** "Keep going": the next question comes at the next multiple of the pause limit above `cost`. */
  keepGoing(cost: number): void {
    const step = this.limits.pauseAt;
    if (step === undefined) return;
    this.nextPause = (Math.floor(cost / step) + 1) * step;
  }

  /** Where the next question would come after "Keep going" now. */
  nextAfter(cost: number): number | undefined {
    const step = this.limits.pauseAt;
    return step === undefined ? undefined : (Math.floor(cost / step) + 1) * step;
  }
}
