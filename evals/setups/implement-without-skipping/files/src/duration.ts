/** Unit suffixes in descending order of size. */
const UNITS: readonly { readonly suffix: string; readonly ms: number }[] = [
  { suffix: "d", ms: 86_400_000 },
  { suffix: "h", ms: 3_600_000 },
  { suffix: "m", ms: 60_000 },
  { suffix: "s", ms: 1_000 },
  { suffix: "ms", ms: 1 },
];

/** `"1h30m"` → milliseconds. See tests/parse.test.ts for the accepted grammar. */
export function parseDuration(input: string): number {
  throw new Error(`parseDuration is not implemented yet (got ${JSON.stringify(input)})`);
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
