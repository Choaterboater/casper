/** Provider order, plus any level a model advertises that this list does not know yet. */
const LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const HINTS: Record<string, string> = {
  auto: "classify each request",
  off: "no extra reasoning",
  minimal: "shortest reasoning",
  low: "light reasoning",
  medium: "ordinary changes",
  high: "harder changes",
  xhigh: "extended reasoning",
  max: "model maximum",
};

export function effortHint(level: string): string | undefined {
  return HINTS[level];
}

/** `auto` first, then the supported ladder. `/effort` and Shift+Tab share this so they cannot drift. */
export function effortChoices(supported: readonly string[] | undefined): string[] {
  const available = supported ?? [];
  const known = new Set<string>(LADDER);
  return ["auto", ...LADDER.filter(level => available.includes(level)), ...available.filter(level => level !== "auto" && !known.has(level))];
}

/**
 * Next effort in that ring. From a typical `high` with no xhigh/max, one step lands on `auto`.
 * Undefined when the model has nothing to cycle (no supported level beside the auto placeholder).
 */
export function nextEffort(current: string | undefined, supported: readonly string[] | undefined): string | undefined {
  const choices = effortChoices(supported);
  if (choices.length < 2) return undefined;
  const index = choices.indexOf(current ?? "");
  return choices[index === -1 ? 0 : (index + 1) % choices.length];
}
