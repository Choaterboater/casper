/** Unit suffixes in descending order of size; a duration lists each at most once, largest first. */
const UNITS: readonly { readonly suffix: string; readonly ms: number }[] = [
  { suffix: "d", ms: 86_400_000 },
  { suffix: "h", ms: 3_600_000 },
  { suffix: "m", ms: 60_000 },
  { suffix: "s", ms: 1_000 },
  { suffix: "ms", ms: 1 },
];

/** `"1h30m"`, `"2.5s"`, `"1d 2h"` → milliseconds. Every part needs a unit; units appear at most
 * once and only in descending order, so `"30m1h"` and `"1m1m"` are rejected rather than guessed. */
export function parseDuration(input: string): number {
  const text = input.trim();
  if (!text) throw new Error("Empty duration");
  const part = /(\d+(?:\.\d+)?)(ms|[dhms])\s*/y;
  let total = 0;
  let nextUnit = 0;
  while (part.lastIndex < text.length) {
    const match = part.exec(text);
    if (!match) throw new Error(`Invalid duration: ${JSON.stringify(input)}`);
    const index = UNITS.findIndex((unit) => unit.suffix === match[2]);
    if (index < nextUnit) throw new Error(`Units out of order or repeated in ${JSON.stringify(input)}`);
    total += Number(match[1]) * UNITS[index]!.ms;
    nextUnit = index + 1;
  }
  return total;
}

/** Milliseconds → the shortest descending unit list, e.g. `5400000` → `"1h30m"`; `0` → `"0ms"`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid milliseconds: ${ms}`);
  let remaining = Math.round(ms);
  let text = "";
  for (const unit of UNITS) {
    const count = Math.floor(remaining / unit.ms);
    if (count > 0) { text += `${count}${unit.suffix}`; remaining -= count * unit.ms; }
  }
  return text || "0ms";
}
