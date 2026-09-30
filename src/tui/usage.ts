import type { RuntimeStatus, RuntimeUsage } from "../runtime/types";

/** 43741 -> "44k", 4856497 -> "4.9M"; under 1000 stays exact. */
export function compactCount(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

/** "44k out · 131k new · 4.9M cached". New is input plus cache writes: tokens the model read fresh.
 * Cached is re-read context, usually most of the total. Zero parts are left out, except out. */
export function formatTokenSplit(tokens: RuntimeUsage["tokens"]): string {
  const fresh = tokens.input + tokens.cacheWrite;
  return [`${compactCount(tokens.output)} out`, fresh ? `${compactCount(fresh)} new` : "", tokens.cacheRead ? `${compactCount(tokens.cacheRead)} cached` : ""]
    .filter(Boolean).join(" · ");
}

/** /usage cache line body: "97% of input read from cache this session", or "—" before any input.
 * Rounded down, so it never shows 100% while some input was read fresh. */
export function formatCacheHitRate(tokens: RuntimeUsage["tokens"]): string {
  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  if (!input) return "—";
  return `${Math.floor((tokens.cacheRead / input) * 100)}% of input read from cache this session`;
}

/** Plain name for a subscription sign-in. */
export function subscriptionName(provider?: string): string {
  return provider === "github-copilot" ? "Copilot subscription" : provider === "openai-codex" ? "ChatGPT subscription" : "subscription";
}

/** Status bar cost. A subscription pays no per-token price, so the catalog figure is only what
 * the same tokens would cost pay-per-token. The catalog figure is never the provider's reported charge. */
export function formatCostShort(usage: Pick<RuntimeUsage, "estimatedCost">, status?: Pick<RuntimeStatus, "provider" | "billing">): string | undefined {
  const cost = usage.estimatedCost;
  if (status?.billing === "subscription") return `${subscriptionName(status.provider)}${cost === undefined ? "" : ` (≈$${cost.toFixed(2)} pay-per-token)`}`;
  return cost === undefined ? undefined : `$${cost.toFixed(3)} est`;
}

/** /usage cost line body, before the "not a bill" note. The figure is the whole session, across model switches. */
export function formatCostLong(usage: Pick<RuntimeUsage, "estimatedCost">, status?: Pick<RuntimeStatus, "provider" | "billing">): string {
  const cost = usage.estimatedCost;
  if (status?.billing === "subscription") return `${subscriptionName(status.provider)}${cost === undefined ? "" : `; pay-per-token these tokens would be ≈ $${cost.toFixed(4)} (SDK/catalog estimate)`}`;
  return cost === undefined ? "unavailable" : `$${cost.toFixed(4)} SDK/catalog estimate`;
}
