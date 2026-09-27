export interface WrapOptions {
  tabWidth?: number;
  hangingIndent?: number;
  maxLines?: number;
}

/** One indivisible display unit inside a word: a normal character, a combining-mark cluster merged onto its
 * base character, an ANSI SGR escape sequence, a literal hyphen, or a soft hyphen. */
interface Atom {
  /** Text produced when this atom is not used as a break point. */
  render: string;
  /** Display width contributed when not used as a break point. */
  width: number;
  /** Whether a line may break right after this atom, and how. */
  breakable: "hard" | "soft" | null;
}

const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function isWide(cp: number): boolean {
  return WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function isCombining(cp: number): boolean {
  return cp >= 0x0300 && cp <= 0x036f;
}

const SOFT_HYPHEN = "­";

/** Splits a word's text into atoms: ANSI escapes and combining-mark clusters never break apart. */
function atomize(word: string): Atom[] {
  const chars = Array.from(word);
  const atoms: Atom[] = [];
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "\x1b" && chars[i + 1] === "[") {
      let j = i + 2;
      while (j < chars.length && /[0-9;]/.test(chars[j]!)) j++;
      if (j < chars.length && chars[j] === "m") {
        atoms.push({ render: chars.slice(i, j + 1).join(""), width: 0, breakable: null });
        i = j + 1;
        continue;
      }
    }
    const ch = chars[i]!;
    if (ch === SOFT_HYPHEN) {
      atoms.push({ render: "", width: 0, breakable: "soft" });
      i++;
      continue;
    }
    if (ch === "-") {
      atoms.push({ render: "-", width: 1, breakable: "hard" });
      i++;
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (isCombining(cp)) {
      if (atoms.length > 0) atoms[atoms.length - 1]!.render += ch;
      else atoms.push({ render: ch, width: 0, breakable: null });
      i++;
      continue;
    }
    atoms.push({ render: ch, width: isWide(cp) ? 2 : 1, breakable: null });
    i++;
  }
  return atoms;
}

function atomsWidth(atoms: Atom[]): number {
  return atoms.reduce((sum, atom) => sum + atom.width, 0);
}

function renderAtoms(atoms: Atom[]): string {
  return atoms.map((atom) => atom.render).join("");
}

/** Display width of a plain string of already-rendered text (used for the maxLines/ellipsis check). */
function displayWidth(text: string): number {
  return atomsWidth(atomize(text));
}

/** Finds the last breakable atom whose prefix (through that atom, hyphen shown) fits within `budget`; -1 if none. */
function findLastFittingBreak(atoms: Atom[], budget: number): number {
  let running = 0;
  let last = -1;
  for (let idx = 0; idx < atoms.length; idx++) {
    const atom = atoms[idx]!;
    if (atom.breakable === "hard") {
      if (running + atom.width <= budget) last = idx;
    } else if (atom.breakable === "soft") {
      if (running + 1 <= budget) last = idx;
    }
    running += atom.width;
  }
  return last;
}

/** Greedily takes whole atoms (never splitting one) while the running width stays within `budget`; always takes
 * at least one atom so a piece can never come out empty. */
function takeByWidth(atoms: Atom[], budget: number): { taken: Atom[]; rest: Atom[] } {
  let used = 0;
  let count = 0;
  for (; count < atoms.length; count++) {
    const next = used + atoms[count]!.width;
    if (count > 0 && next > budget) break;
    used = next;
  }
  if (count === 0 && atoms.length > 0) count = 1;
  return { taken: atoms.slice(0, count), rest: atoms.slice(count) };
}

/** Splits one overlong word into output-line pieces. `firstBudget` is the width available for the line this word
 * starts on; every later piece uses `laterBudget` (the paragraph's continuation-line budget). */
function splitOverlongWord(atoms: Atom[], firstBudget: number, laterBudget: number, isURL: boolean, isPureWide: boolean): string[] {
  const pieces: string[] = [];
  let remaining = atoms;
  let budget = firstBudget;
  while (true) {
    const width = atomsWidth(remaining);
    if (width <= budget) {
      pieces.push(renderAtoms(remaining));
      break;
    }
    if (isURL || isPureWide) {
      const { taken, rest } = takeByWidth(remaining, budget);
      pieces.push(renderAtoms(taken));
      remaining = rest;
    } else {
      const breakIdx = findLastFittingBreak(remaining, budget);
      if (breakIdx !== -1) {
        const prefix = remaining.slice(0, breakIdx + 1);
        const last = prefix[prefix.length - 1]!;
        const rendered = prefix.slice(0, -1).map((atom) => atom.render).join("") + (last.breakable === "soft" ? "-" : last.render);
        pieces.push(rendered);
        remaining = remaining.slice(breakIdx + 1);
      } else if (budget <= 1) {
        const { taken, rest } = takeByWidth(remaining, budget);
        pieces.push(renderAtoms(taken));
        remaining = rest;
      } else {
        const { taken, rest } = takeByWidth(remaining, budget - 1);
        pieces.push(renderAtoms(taken) + "-");
        remaining = rest;
      }
    }
    budget = laterBudget;
  }
  return pieces;
}

interface Line {
  indent: number;
  /** Rendered word strings (a forced-split piece counts as a single "word" here). */
  words: string[];
}

function lineToString(line: Line): string {
  return " ".repeat(line.indent) + line.words.join(" ");
}

/** Wraps one non-blank paragraph's words into output lines. */
function wrapParagraph(words: string[], indentWidth: number, hangingIndent: number, width: number): Line[] {
  const firstBudget = width - indentWidth;
  const laterBudget = width - indentWidth - hangingIndent;
  const lines: Line[] = [];
  let current: Line = { indent: indentWidth, words: [] };
  let currentWidth = 0;
  let isFirstLine = true;

  const budget = () => (isFirstLine ? firstBudget : laterBudget);
  const indent = () => (isFirstLine ? indentWidth : indentWidth + hangingIndent);
  const flush = () => {
    lines.push(current);
    isFirstLine = false;
    current = { indent: indent(), words: [] };
    currentWidth = 0;
  };

  for (const rawWord of words) {
    const atoms = atomize(rawWord);
    const whole = renderAtoms(atoms);
    const wholeWidth = atomsWidth(atoms);

    if (current.words.length > 0 && currentWidth + 1 + wholeWidth <= budget()) {
      current.words.push(whole);
      currentWidth += 1 + wholeWidth;
      continue;
    }
    if (current.words.length > 0) flush();

    if (wholeWidth <= budget()) {
      current.words.push(whole);
      currentWidth = wholeWidth;
      continue;
    }

    // The word alone does not fit even a fresh line: force-split it. Each piece is its own output line;
    // nothing else shares that line, even when its last piece is shorter than the line width.
    const isURL = /^https?:\/\//.test(rawWord);
    const isPureWide = atoms.length > 0 && atoms.every((atom) => atom.width !== 1);
    const startBudget = budget();
    const pieces = splitOverlongWord(atoms, startBudget, laterBudget, isURL, isPureWide);
    for (const piece of pieces) {
      lines.push({ indent: indent(), words: [piece] });
      isFirstLine = false;
    }
    current = { indent: indent(), words: [] };
    currentWidth = 0;
  }
  if (current.words.length > 0) flush();
  return lines;
}

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

/** Width of a paragraph's leading run of spaces and tabs; a tab advances to the next multiple of `tabWidth`. */
function indentWidthOf(line: string, tabWidth: number): { width: number; contentStart: number } {
  let width = 0;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " ") {
      width += 1;
    } else if (ch === "\t") {
      width = (Math.floor(width / tabWidth) + 1) * tabWidth;
    } else {
      break;
    }
    i++;
  }
  return { width, contentStart: i };
}

export function wrap(text: string, width: number, options: WrapOptions = {}): string {
  if (!Number.isInteger(width) || width <= 0) throw new RangeError("width must be a positive integer");

  const maxLines = options.maxLines;
  if (maxLines !== undefined && (!Number.isInteger(maxLines) || maxLines <= 0)) {
    throw new RangeError("maxLines must be a positive integer");
  }
  const tabWidth = options.tabWidth ?? 4;
  if (!Number.isInteger(tabWidth) || tabWidth <= 0) throw new RangeError("tabWidth must be a positive integer");
  const hangingIndent = options.hangingIndent ?? 0;
  if (!Number.isInteger(hangingIndent) || hangingIndent < 0) throw new RangeError("hangingIndent must be a non-negative integer");

  const normalized = text.replace(/\r\n/g, "\n");
  const hadTrailingNewline = normalized.endsWith("\n");
  // A run of one or more trailing newlines is entirely absorbed into "kept once": it never surfaces as a
  // visible blank paragraph at the end, however many newlines the input actually ends with.
  const stripped = hadTrailingNewline ? normalized.replace(/\n+$/, "") : normalized;
  const rawLines = stripped.split("\n");

  for (const raw of rawLines) {
    if (isBlank(raw)) continue;
    const { width: indentWidth } = indentWidthOf(raw, tabWidth);
    if (indentWidth + hangingIndent >= width) throw new RangeError("indent leaves no room");
  }

  const structured: Line[] = [];
  let previousWasBlank = false;
  for (const raw of rawLines) {
    if (isBlank(raw)) {
      if (!previousWasBlank) structured.push({ indent: 0, words: [] });
      previousWasBlank = true;
      continue;
    }
    previousWasBlank = false;
    const { width: indentWidth, contentStart } = indentWidthOf(raw, tabWidth);
    const content = raw.slice(contentStart);
    const words = content.split(/[ \t]+/).filter((w) => w.length > 0);
    structured.push(...wrapParagraph(words, indentWidth, hangingIndent, width));
  }

  let finalLines = structured.map(lineToString);
  if (maxLines !== undefined && structured.length > maxLines) {
    const kept = structured.slice(0, maxLines);
    const last = kept[kept.length - 1]!;
    const lastWords = [...last.words];
    let ellipsisLine: string;
    while (true) {
      const base = " ".repeat(last.indent) + lastWords.join(" ");
      const candidate = lastWords.length > 0 ? base + "…" : " ".repeat(last.indent) + "…";
      if (lastWords.length === 0 || displayWidth(candidate) <= width) {
        ellipsisLine = candidate;
        break;
      }
      lastWords.pop();
    }
    finalLines = kept.slice(0, -1).map(lineToString);
    finalLines.push(ellipsisLine);
  }

  let result = finalLines.join("\n");
  if (hadTrailingNewline) result += "\n";
  return result;
}
