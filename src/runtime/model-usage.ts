/** Provider-reported tokens, never inferred from cost or total tokens. */
export const TOKEN_FIELDS = ["input", "cacheRead", "cacheWrite", "output"] as const;
export interface ModelUsage {
  tokens: number;
  estimatedCost: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
}
export function zeroUsage(): ModelUsage {
  return { tokens: 0, estimatedCost: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}
export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  const sum: ModelUsage = { tokens: a.tokens + b.tokens, estimatedCost: a.estimatedCost + b.estimatedCost };
  for (const key of TOKEN_FIELDS) if (a[key] !== undefined && b[key] !== undefined) sum[key] = a[key]! + b[key]!;
  return sum;
}
export function tokenFields(usage: ModelUsage | null | undefined): Record<typeof TOKEN_FIELDS[number], number | null> {
  return { input: usage?.input ?? null, cacheRead: usage?.cacheRead ?? null, cacheWrite: usage?.cacheWrite ?? null, output: usage?.output ?? null };
}
