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

/** Why `/effort <level>` can't be set on this model: a word that is no level, or a level the model doesn't have. Each
 * names the model's own choices. Undefined when it can be set, or when the model's levels are not known. */
export function effortProblem(level: string, status: { provider?: string; model?: string; availableThinkingLevels?: readonly string[] } | undefined): string | undefined {
  const supported = status?.availableThinkingLevels;
  const choices = `Choose: ${effortChoices(supported).join(", ")}`;
  if (level !== "auto" && !(LADDER as readonly string[]).includes(level) && !supported?.includes(level)) {
    return supported ? `Unknown effort ${level}. ${choices}` : `Unknown effort ${level}. Choose: auto, ${LADDER.join(", ")}`;
  }
  if (!supported || level === "auto" || supported.includes(level)) return undefined;
  const model = status?.model ? `${status.provider ? `${status.provider}/` : ""}${status.model}` : "This model";
  return `${model} doesn't support effort ${level}. ${choices}`;
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
