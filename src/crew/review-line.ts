/**
 * The one line Casper prints when a crew reviewer finishes: the first line of its report that says something. Reports
 * open with a heading ("## Findings"), and three of four reviewers on one debug report showed only that.
 */
const GENERIC = /^(?:findings?|summary|review|report|results?|issues?|notes?|overview|details)\s*:?$/i;

export function reviewerLine(response: string | undefined): string {
  // A review asked for as JSON (a blind scoring) is data for the AI, not a line to read: name what it covers.
  const body = (response ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (/^[{[]/.test(body)) {
    try {
      const parsed: unknown = JSON.parse(body);
      const keys = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed) : [];
      if (keys.length) return `Review returned as data for ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ` and ${keys.length - 4} more` : ""} (the AI reads it)`;
    } catch { /* cut off */ }
    return "Review returned as data (the AI reads it)";
  }
  for (const raw of (response ?? "").split(/\r?\n/)) {
    // Markdown around the words: #, list marks, bold and a trailing colon.
    const line = raw.trim().replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__/g, "").trim();
    if (!line || /^[-=_*]{3,}$/.test(line) || GENERIC.test(line)) continue;
    return line;
  }
  return "Review completed";
}
