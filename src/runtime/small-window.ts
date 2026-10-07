/** Small model windows (typically local models). Casper's own request (instructions plus tool
 * descriptions) takes about 4,600 tokens, and Pi keeps 16,384 tokens free for the reply when it
 * decides to compact, so an 8k window would compact on every turn. */
export const SMALL_WINDOW = 16_000;
export const COMPACTION_RESERVE_UNTIL = 32_000;
const MIN_RESERVE = 2_000;

/** The compaction reserve for a window below 32k: a quarter of it, at least 2,000. Undefined means
 * "leave Pi's default". */
export function compactionReserveFor(contextWindow: number | undefined): number | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  if (contextWindow >= COMPACTION_RESERVE_UNTIL) return undefined;
  return Math.max(MIN_RESERVE, Math.floor(contextWindow / 4));
}

export function smallWindowWarning(contextWindow: number | undefined): string | undefined {
  if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow) || contextWindow <= 0 || contextWindow >= SMALL_WINDOW) return undefined;
  return `This model's window is only ${contextWindow.toLocaleString("en-US")} tokens; Casper's own instructions take about 4,600 of them. `
    + "Expect short tasks only, or pick a model with 16k or more (see docs/CONFIGURATION.md, Local models).";
}
