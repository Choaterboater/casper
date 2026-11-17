import type { RuntimeConversation, RuntimeConversationHit } from "../runtime/types";
import { scrubPlainSecrets } from "../secrets/files";
import { LINE_MARKER, SECRET_MARKER, scrubText } from "../secrets/scrub";
import { lineText, redactPreview } from "../tui/format";

/** How much of one conversation's text a search reads: its start and its end, half each. */
export const SEARCH_TEXT_CHARS = 400_000;
const EXCERPT_BEFORE = 24;
const EXCERPT_CHARS = 80;
/** At most this many hits come back, the newest: far more than the picker shows, and the search stops there. */
export const SEARCH_HIT_LIMIT = 50;
/** How long the search runs before it lets keys (Esc) through, in milliseconds. */
const SLICE_MS = 15;
/** What redactPreview leaves for a key-shaped value: like the scrub's markers, never a word the search finds. */
const REDACTED = "<redacted>";
const ASCII = /^[\x00-\x7f]*$/;

/** One character's search form: lower case, accents dropped ("É" is "e"). */
function foldChar(char: string): string {
  return char.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/** Text in its search form: lower case, accents dropped, so "Café" and "cafe" match. */
export function foldText(text: string): string {
  // Plain ASCII (most text) folds whole, at once.
  if (ASCII.test(text)) return text.toLowerCase();
  let out = "";
  for (const char of text) out += foldChar(char);
  return out;
}

/** The words /resume searches for: split on spaces, each in its search form, none repeated. */
export function searchWords(text: string): string[] {
  return [...new Set(text.split(/\s+/).map(foldText).filter(Boolean))];
}

/** Casper's own lines in the requests it sent (its classification hints, the same in every conversation) and the
 * "User request:" heading before the user's words: what you typed and what the AI wrote are what a search finds. */
function withoutCasperLines(text: string): string {
  return text.replace(/Casper initial classification \(hints[\s\S]*?User request:\n/g, " ").replace(/User request:\n/g, " ");
}

function bounded(text: string): string {
  if (text.length <= SEARCH_TEXT_CHARS) return text;
  const half = SEARCH_TEXT_CHARS / 2;
  return `${text.slice(0, half)} … ${text.slice(-half)}`;
}

/** Folded text with, for each of its characters, where it came from in `text`; a hidden secret's marker is blank, so
 * it never counts as a match. */
function foldWithMap(text: string): { folded: string; at: (index: number) => number } {
  let blanked = text;
  for (const marker of [SECRET_MARKER, LINE_MARKER, REDACTED]) blanked = blanked.split(marker).join(" ".repeat(marker.length));
  if (ASCII.test(blanked)) return { folded: blanked.toLowerCase(), at: (index) => index };
  let folded = "";
  const at: number[] = [];
  let index = 0;
  for (const char of blanked) {
    const piece = foldChar(char);
    folded += piece;
    for (let i = 0; i < piece.length; i++) at.push(index);
    index += char.length;
  }
  return { folded, at: (hit) => at[hit]! };
}

export interface FindOptions {
  /** Where secret-named values come from (the process environment when unset). */
  env?: NodeJS.ProcessEnv;
  /** More exact values to hide: Casper's own logins. */
  values?: readonly string[];
}

export interface SearchOptions extends FindOptions {
  /** Esc: the search stops, and what it found so far comes back. */
  signal?: AbortSignal;
  /** At most this many hits (SEARCH_HIT_LIMIT when unset). */
  limit?: number;
}

/**
 * A short excerpt around the first hit when `text` holds every one of `words` (from searchWords), else undefined. The
 * text is read bounded, with Casper's own lines left out, and secrets hidden before it is matched: a hidden secret
 * never matches and never shows in the excerpt.
 */
export function findWords(text: string, words: readonly string[], options: FindOptions = {}): string | undefined {
  if (!words.length) return undefined;
  const plain = withoutCasperLines(bounded(text));
  // Cheap first: most conversations do not hold every word, and those are never scrubbed.
  const quick = foldText(plain);
  if (words.some(word => !quick.includes(word))) return undefined;
  const device = scrubText(plain).text;
  // Key-shaped values in prose (sk-…, AKIA…) too, as every other preview hides them.
  const shown = redactPreview(scrubPlainSecrets(device, { ...(options.env ? { env: options.env } : {}), ...(options.values ? { values: options.values } : {}) }).text);
  const { folded, at } = foldWithMap(shown);
  let first = Infinity;
  for (const word of words) {
    const hit = folded.indexOf(word);
    if (hit === -1) return undefined;
    first = Math.min(first, at(hit));
  }
  return excerpt(shown, first);
}

function excerpt(text: string, hit: number): string {
  const start = Math.max(0, hit - EXCERPT_BEFORE);
  const end = Math.min(text.length, start + EXCERPT_CHARS);
  const piece = lineText(text.slice(start, end)).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${piece}${end < text.length ? "…" : ""}`;
}

/** The conversations whose name or text holds every one of `words`, newest first, each with its excerpt: the newest
 * `limit` of them, or those found before `signal` stopped it. The text is read only here: what comes back is the
 * conversation's usual row and the excerpt. It pauses every few milliseconds, so a long search never holds up keys. */
export async function searchConversationTexts(list: ReadonlyArray<RuntimeConversation & { text: string }>, words: readonly string[],
  options: SearchOptions = {}): Promise<RuntimeConversationHit[]> {
  const { signal, limit = SEARCH_HIT_LIMIT, ...find } = options;
  const hits: RuntimeConversationHit[] = [];
  let since = performance.now();
  for (const { text, ...item } of [...list].sort((a, b) => b.modified.localeCompare(a.modified))) {
    if (performance.now() - since > SLICE_MS) { await new Promise<void>((resolve) => { setImmediate(resolve); }); since = performance.now(); }
    if (signal?.aborted || hits.length >= limit) break;
    const found = findWords(`${item.name ? `${item.name}\n` : ""}${text}`, words, find);
    if (found !== undefined) hits.push({ ...item, excerpt: found });
  }
  return hits;
}
