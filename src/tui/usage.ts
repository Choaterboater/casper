import type { RuntimeStatus, RuntimeUsage } from "../runtime/types";
import { formatCost, formatTokens } from "./format";

/** "43.7k out · 131k new · 4.9M cached" (the footer's token format). New is input plus cache writes: tokens the
 * model read fresh. Cached is re-read context, usually most of the total. Zero parts are left out, except out. */
export function formatTokenSplit(tokens: RuntimeUsage["tokens"]): string {
  const fresh = tokens.input + tokens.cacheWrite;
  return [`${formatTokens(tokens.output)} out`, fresh ? `${formatTokens(fresh)} new` : "", tokens.cacheRead ? `${formatTokens(tokens.cacheRead)} cached` : ""]
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
  if (status?.billing === "subscription") return `${subscriptionName(status.provider)}${cost === undefined ? "" : ` (≈${formatCost(cost)} pay-per-token)`}`;
  return cost === undefined ? undefined : `${formatCost(cost)} est`;
}

/** /usage cost line body, before the "not a bill" note. The figure is the whole session, across model switches. */
export function formatCostLong(usage: Pick<RuntimeUsage, "estimatedCost">, status?: Pick<RuntimeStatus, "provider" | "billing">): string {
  const cost = usage.estimatedCost;
  if (status?.billing === "subscription") return `${subscriptionName(status.provider)}${cost === undefined ? "" : `; pay-per-token these tokens would be ≈ ${formatCost(cost)} (SDK/catalog estimate)`}`;
  if (cost === undefined) return "unavailable";
  // OpenRouter reports what it charged for each response; other providers are priced from the catalog.
  return status?.provider === "openrouter" ? `${formatCost(cost)} as charged by OpenRouter` : `${formatCost(cost)} SDK/catalog estimate`;
}
