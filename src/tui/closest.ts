/** The word closest to a mistyped one, when it is close enough to be a typo: the start of exactly one word ("/q" for
 * /quit), or one or two edits away. Undefined for the word itself or nothing near. */
export function closestWord(typed: string, words: readonly string[]): string | undefined {
  const word = typed.toLowerCase();
  if (!word) return undefined;
  const started = words.includes(word) ? [] : words.filter((name) => name.startsWith(word));
  if (started.length === 1) return started[0];
  let best: { name: string; distance: number } | undefined;
  for (const name of words) {
    const distance = editDistance(word, name);
    // Distance 0 is the word itself: never "Did you mean" the word that was typed.
    if (distance > 0 && distance <= Math.max(1, Math.min(2, Math.floor(name.length / 3))) && (!best || distance < best.distance)) best = { name, distance };
  }
  return best?.name;
}

function editDistance(a: string, b: string): number {
  // Damerau (one swap of neighbours counts as one edit): "sttaus" is one edit from "status".
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}
