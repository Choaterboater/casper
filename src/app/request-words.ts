/**
 * Words at the start of a request the person typed ("think hard:", "big model:", "plan first:") and `ultrathink`
 * anywhere in it. Casper reads them before the model does, applies them to this task only, says so in one line, and
 * takes them out of what the model gets. Only the person's own typing counts: text that came from a paste (or a file,
 * a tool or the AI, which never reach this parser) is never read as a word. Words never grant permission.
 */

export type WordEffort = "top" | "low";
export type WordRole = "reason" | "fast";

export interface RequestWords {
  /** The request without the words: what the model gets. */
  text: string;
  effort?: WordEffort;
  role?: WordRole;
  planFirst?: boolean;
}

const LEADING: ReadonlyArray<{ pattern: RegExp; effort?: WordEffort; role?: WordRole; planFirst?: true }> = [
  { pattern: /^think hard/i, effort: "top" },
  { pattern: /^quick/i, effort: "low" },
  { pattern: /^(?:use the )?big model/i, role: "reason" },
  { pattern: /^(?:use the )?fast model/i, role: "fast" },
  { pattern: /^plan first/i, planFirst: true },
];

/** Which characters of `line` came from a paste: every place a pasted piece appears. */
export function pastedMask(line: string, pasted: readonly string[]): boolean[] {
  const mask = Array.from({ length: line.length }, () => false);
  for (const piece of pasted) {
    if (!piece) continue;
    for (let at = line.indexOf(piece); at !== -1; at = line.indexOf(piece, at + 1)) {
      for (let i = at; i < at + piece.length; i++) mask[i] = true;
    }
  }
  return mask;
}

/** The words in a typed request. `pasted` is what was pasted into it (the terminal keeps it); none of it is read. */
export function parseRequestWords(line: string, pasted: readonly string[] = []): RequestWords {
  const mask = pastedMask(line, pasted);
  const typed = (from: number, to: number) => mask.slice(from, to).every((bit) => !bit);
  const words: Omit<RequestWords, "text"> = {};
  let at = 0;
  // Several may lead ("big model, think hard: …"); they stop at the first line's end.
  for (let found = 0; found < LEADING.length; found++) {
    while (line[at] === " " || line[at] === "\t") at++;
    const rest = line.slice(at);
    const word = LEADING.find((candidate) => candidate.pattern.test(rest));
    if (!word) break;
    const length = word.pattern.exec(rest)![0].length;
    const after = /^[ \t]*([:,]|\r?\n)/.exec(rest.slice(length));
    if (!after || !typed(at, at + length + after[0].length)) break;
    if (word.effort) words.effort ??= word.effort;
    if (word.role) words.role ??= word.role;
    if (word.planFirst) words.planFirst = true;
    at += length + after[0].length;
    if (after[1] !== ":" && after[1] !== ",") break;
  }
  let text = line.slice(at);
  // ultrathink, as a word of its own anywhere the person typed it (as in Claude Code): space or a line's edge on
  // both sides, so a file name (src/ultrathink.ts) or a hyphenated word (ultrathink-mode) is left as it is.
  const offset = at;
  let ultra = false;
  text = text.replace(/(?<=^|\s)ultrathink[:,]?(?:[ \t]+|(?=\s|$))/gi, (whole: string, index: number) => {
    const start = offset + index;
    if (!typed(start, start + "ultrathink".length)) return whole;
    ultra = true;
    return "";
  });
  if (ultra) words.effort = "top";
  text = text.trim();
  // Nothing left to ask: the words were the whole line, so it is an ordinary request.
  if (!text || (!words.effort && !words.role && !words.planFirst)) return { text: line.trim() };
  return { text, ...words };
}
