// Pure word matching for the capability catalog. No imports, so it stays cheap
// to load and easy to test.

// Same stop words the broker has always used: very common words that would
// otherwise match almost every tool.
const STOP_WORDS = new Set(["the", "a", "an", "to", "of", "for", "and", "in", "with", "please", "tool", "tools", "read", "get", "show", "use"]);
const MAX_FIELD_CHARS = 64;

/** Lowercase words of 2+ letters or digits, without stop words, each once. */
export function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1 && !STOP_WORDS.has(word)))];
}

/**
 * The word plus its likely singular forms, so "sites" meets "site" and
 * "policies" meets "policy" without a lookup table. Two words match when
 * their variant sets overlap.
 */
export function termVariants(word: string): string[] {
  const variants = new Set([word]);
  if (word.length > 4 && word.endsWith("ies")) variants.add(`${word.slice(0, -3)}y`);
  if (word.length > 3 && word.endsWith("es")) variants.add(word.slice(0, -2));
  if (word.length >= 3 && word.endsWith("s") && !word.endsWith("ss")) variants.add(word.slice(0, -1));
  return [...variants];
}

/** Every variant of every word in the text. */
export function indexWords(text: string): Set<string> {
  const index = new Set<string>();
  for (const word of tokenize(text)) for (const variant of termVariants(word)) index.add(variant);
  return index;
}

/**
 * Score one query word against a tool: 4 for a name match, 2 for a prefix of a
 * name word (only when `prefix` is on and the word has 5+ letters), 1 for a
 * description match, else 0. The prefix rule is meant for search only; direct
 * tool selection keeps exact matching so it stays stable.
 */
export function termScore(term: string, nameSet: ReadonlySet<string>, descSet: ReadonlySet<string>, options: { prefix?: boolean } = {}): number {
  const variants = termVariants(term);
  if (variants.some((variant) => nameSet.has(variant))) return 4;
  if (options.prefix && term.length >= 5) {
    for (const word of nameSet) if (word.length > term.length && word.startsWith(term)) return 2;
  }
  if (variants.some((variant) => descSet.has(variant))) return 1;
  return 0;
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

function fieldParts(name: string): string[] {
  // Split snake_case, kebab-case and camelCase into lowercase parts.
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 3);
}

/**
 * Pick the known field the caller most likely meant by an unknown field name:
 * one that starts with it (or it starts with), shares a word stem with it, or
 * is within two typing mistakes. Returns undefined when nothing is close.
 */
export function suggestField(name: string, known: readonly string[]): string | undefined {
  const wanted = name.slice(0, MAX_FIELD_CHARS);
  const lower = wanted.toLowerCase();
  if (!lower) return undefined;
  const wantedStems = new Set(fieldParts(wanted).flatMap(termVariants));
  let best: { field: string; rank: number; distance: number } | undefined;
  for (const candidate of known) {
    const field = candidate.slice(0, MAX_FIELD_CHARS);
    const other = field.toLowerCase();
    if (!other || field === wanted) continue;
    const distance = levenshtein(lower, other);
    let rank: number;
    if (other === lower) rank = 0;
    else if (other.startsWith(lower) || lower.startsWith(other)) rank = 1;
    else if (fieldParts(field).some((part) => termVariants(part).some((variant) => wantedStems.has(variant)))) rank = 2;
    // Short names need a closer match, so "id" does not suggest "os".
    else if (distance <= 2 && distance < Math.min(lower.length, other.length)) rank = 3;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && distance < best.distance)) best = { field, rank, distance };
  }
  return best?.field;
}
