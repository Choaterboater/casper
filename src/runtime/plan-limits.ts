import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimePlanLimit } from "./types";

/**
 * The Claude plan's usage windows, as Claude Code reports them with its responses (decision 106). Claude Code sends a
 * `rate_limit_event` whenever a window's share, reset or status moves; Casper keeps the latest one per window. Nothing
 * is asked for: no extra call, no tokens.
 *
 * - `/usage` and `/status` show the window that matters most in one line (planLimitText).
 * - A window that turns to a warning, or to extra usage, is said once per window and reset (takeNotice).
 * - A used-up window with its reset still ahead is written into the failed request's error (planLimitError), so the
 *   error line names the window and the reset, and failover switches at once (src/runtime/failover.ts).
 */

const WINDOW_NAMES: Record<string, string> = {
  five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus", seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly included", overage: "extra usage",
};

/** A window in plain words: "5-hour", "weekly", "weekly Opus". */
export function planWindowName(window: string): string {
  return WINDOW_NAMES[window] ?? window.replace(/_/g, " ");
}

export class PlanLimits {
  private readonly windows = new Map<string, RuntimePlanLimit>();
  /** Window and reset of each notice already given: said once. */
  private readonly told = new Set<string>();
  private pending?: RuntimePlanLimit;

  /** What one of Claude Code's rate-limit events says. Its top-level status is whether requests are refused now. */
  record(info: SDKRateLimitInfo): void {
    if (!info || typeof info !== "object" || !["allowed", "allowed_warning", "rejected"].includes(info.status)) return;
    const window = typeof info.rateLimitType === "string" ? info.rateLimitType : "plan";
    const overage = info.isUsingOverage === true || info.overageInUse === true
      || (info.status === "rejected" && (info.overageStatus === "allowed" || info.overageStatus === "allowed_warning"));
    const limit: RuntimePlanLimit = { window, status: info.status, overage, blocked: info.status === "rejected" && !overage,
      ...(Number.isFinite(info.resetsAt) ? { resetsAt: info.resetsAt! * 1000 } : {}),
      ...(Number.isFinite(info.utilization) ? { used: info.utilization! } : {}) };
    // A request that goes through means no window is refusing requests any more.
    if (!limit.blocked) for (const [name, held] of this.windows) if (held.blocked) this.windows.delete(name);
    this.windows.set(window, limit);
    if (limit.status === "allowed_warning" || limit.overage) {
      const key = `${window}:${limit.resetsAt ?? ""}:${limit.overage ? "overage" : "warning"}`;
      if (!this.told.has(key)) { this.told.add(key); this.pending = limit; }
    }
  }

  /** Every window still current (its reset not yet past), the one that matters most first: a used-up window, then extra
   * usage, then the most used. */
  current(now = Date.now()): RuntimePlanLimit[] {
    const live = [...this.windows.values()].filter((limit) => limit.resetsAt === undefined || limit.resetsAt > now);
    const rank = (limit: RuntimePlanLimit) => limit.blocked ? 3 : limit.overage ? 2 : limit.status === "allowed_warning" ? 1 : 0;
    return live.sort((a, b) => rank(b) - rank(a) || (b.used ?? -1) - (a.used ?? -1)).map((limit) => ({ ...limit }));
  }

  /** The window refusing requests until its reset, which is still ahead; none without a known reset. */
  blocked(now = Date.now()): RuntimePlanLimit | undefined {
    return this.current(now).find((limit) => limit.blocked && limit.resetsAt !== undefined);
  }

  /** A window that just turned to a warning or to extra usage, once: taken by the conversation that shows it. */
  takeNotice(now = Date.now()): RuntimePlanLimit | undefined {
    const pending = this.pending;
    this.pending = undefined;
    return pending && (pending.resetsAt === undefined || pending.resetsAt > now) ? { ...pending } : undefined;
  }
}

/** The Claude account is one for every conversation and helper in this Casper. */
export const planLimits = new PlanLimits();

/** A clock time in plain words: "3:40 PM" today, "Tue 3:40 PM" within a week, "Nov 18, 3:40 PM" after. */
export function clockTime(at: number, now = Date.now(), timeZone?: string): string {
  const zone = timeZone ? { timeZone } : {};
  const time = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...zone });
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { year: "numeric", month: "numeric", day: "numeric", ...zone });
  if (day(at) === day(now)) return time;
  const weekday = at - now < 6 * 86_400_000 && at > now;
  return `${new Date(at).toLocaleDateString("en-US", weekday ? { weekday: "short", ...zone } : { month: "short", day: "numeric", ...zone })}${weekday ? "" : ","} ${time}`;
}

/** One window in a few words: "82% of 5-hour limit, resets 3:40 PM"; extra usage in use never reads as refused. */
export function planLimitText(limit: RuntimePlanLimit, now = Date.now(), timeZone?: string): string {
  const name = planWindowName(limit.window);
  const reset = limit.resetsAt === undefined ? "" : `, resets ${clockTime(limit.resetsAt, now, timeZone)}`;
  if (limit.blocked) return `${name} limit reached${reset}`;
  if (limit.overage && limit.status === "rejected") return `${name} limit reached, using extra usage${reset}`;
  const share = limit.used === undefined ? limit.status === "allowed_warning" ? `near ${name} limit` : `within ${name} limit`
    : `${Math.floor(limit.used * 100)}% of ${name} limit`;
  return `${share}${limit.overage ? ", using extra usage" : ""}${reset}`;
}

const IN_ERROR = /Claude plan limit reached: ([a-z_]+) until (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/;

/** What the subscription runtime adds to a refused request's error while it holds a used-up window. */
export function planLimitError(limit: Pick<RuntimePlanLimit, "window" | "resetsAt">): string {
  return `Claude plan limit reached: ${limit.window} until ${new Date(limit.resetsAt ?? 0).toISOString()}.`;
}

/** The used-up window a failed request's error names, from planLimitError. */
export function planLimitInError(message: string): { window: string; resetsAt: number } | undefined {
  const found = IN_ERROR.exec(message);
  const resetsAt = found ? Date.parse(found[2]!) : NaN;
  return found && Number.isFinite(resetsAt) ? { window: found[1]!, resetsAt } : undefined;
}
