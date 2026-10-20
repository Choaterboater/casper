/**
 * The one line Casper prints when a crew reviewer finishes: the first line of its report that says something. Reports
 * open with a heading ("## Findings"), and three of four reviewers on one debug report showed only that.
 */
const GENERIC = /^(?:findings?|summary|review|report|results?|issues?|notes?|overview|details)\s*:?$/i;

export function reviewerLine(response: string | undefined): string {
  for (const raw of (response ?? "").split(/\r?\n/)) {
    // Markdown around the words: #, list marks, bold and a trailing colon.
    const line = raw.trim().replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/\*\*|__/g, "").trim();
    if (!line || /^[-=_*]{3,}$/.test(line) || GENERIC.test(line)) continue;
    return line;
  }
  return "Review completed";
}
