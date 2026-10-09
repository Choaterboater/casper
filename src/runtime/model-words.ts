/**
 * A model named in loose words (`opus 5.5`, `sonnet 5`, `qwen3`) against the models you can pick now (the list the
 * /model browser shows). Exact ids and @roles stay with resolveModelSelection; this runs only when they name nothing.
 *
 * Words and ids are compared as tokens: lower case, split at `-`, `.`, `_`, `:`, `/` and spaces, and between letters
 * and digits (`opus5.5` and `claude-opus-5-5` both read opus 5 5). A size (`8b`, `2.4t`) is one token, never a
 * version. The words must appear in the id in order, side by side, each a whole token (`son` is no word of sonnet:
 * part of a name opens the /model browser on it). The best match wins, in this order:
 *   1. the whole id is the words (`claude opus 5.5`);
 *   2. the words end the id, past its family prefix (`opus 5` names claude-opus-5, not claude-opus-5-5);
 *   3. any other id with the words: the newest version after them first (`opus` names claude-opus-5-5).
 * Within a step the provider you are on comes first, so words never move you to another provider while yours has as
 * good a match; when a better match is only elsewhere and yours has one too, or the best are on several other
 * providers, that is several. Words followed by different names (`claude`: opus, sonnet, haiku) are several too.
 * A dated copy (claude-opus-4-5-20251101) ranks below its undated alias, an id with more after the words below a
 * shorter one. Two or more equally good matches are several, never a guess.
 */

import { isEffortSelection, type EffortSelection, type ModelReference } from "./model-routing";

export type WordsModel = ModelReference & { name?: string };
export type ModelWordsMatch =
  | { kind: "one"; model: WordsModel; effort?: EffortSelection }
  | { kind: "several"; models: WordsModel[]; effort?: EffortSelection }
  | { kind: "none"; closest: WordsModel[] };

/** `current`: the model in use now; its provider comes first. `head`: the words must start the model's name (after
 * its vendor/ and a `claude-` prefix), for a typed line that only asks to change the model: `next` is no model even
 * though qwen3-coder-next ends with it. */
export type ModelWordsOptions = { current?: ModelReference; head?: boolean };

type Token = { text: string; glued: boolean; date: boolean };

const DATE = /^(?:19|20)\d{6}$/;

/** Tokens of an id or of typed words. `glued`: the token runs straight into the next one inside the same part
 * (the 8 of `8b`), so it is a size, not a version number. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  // A size written with a dot (2.4t, 1.5b) is one size, not version 2 then 4t.
  const parts = text.toLowerCase().replace(/(\d+)\.(\d+[bkmt])(?![a-z])/g, "$1$2").split(/[\s\-._:/]+/).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    // 2024-11-20 is one date, like 20241120.
    if (/^(?:19|20)\d\d$/.test(part) && /^\d\d$/.test(parts[index + 1] ?? "") && /^\d\d$/.test(parts[index + 2] ?? "")) {
      out.push({ text: `${part}${parts[index + 1]}${parts[index + 2]}`, glued: false, date: true });
      index += 2;
      continue;
    }
    const pieces = part.match(/[a-z]+|\d+|[^a-z\d]+/g) ?? [part];
    pieces.forEach((piece, at) => out.push({ text: piece, glued: at < pieces.length - 1, date: DATE.test(piece) }));
  }
  return out;
}

const numeric = (token: Token) => /^\d+$/.test(token.text) && !token.date;

/** Where `query` sits in `id`, side by side and in order; -1 when it does not. */
function findRun(query: readonly Token[], id: readonly Token[]): number {
  const same = (word: Token, token: Token) => word.text === token.text;
  for (let start = 0; start + query.length <= id.length; start++) {
    if (query.every((word, offset) => same(word, id[start + offset]!))) return start;
  }
  return -1;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index]; const right = b[index];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    return left - right;
  }
  return 0;
}

type Ranked = {
  model: WordsModel; tier: number; version: number[]; dated: boolean; extra: number; elsewhere: boolean;
  /** The name right after the words, when one follows (`opus` in claude-opus-5-5 for `claude`). */
  branch: string;
};

/** Lower is better; 0 means equally good. */
function compare(a: Ranked, b: Ranked): number {
  return a.tier - b.tier || Number(a.elsewhere) - Number(b.elsewhere) || compareVersions(b.version, a.version)
    || Number(a.dated) - Number(b.dated) || a.extra - b.extra;
}

/** The model's name: an OpenRouter id carries its vendor (anthropic/claude-opus-5-5). */
const nameOf = (id: string) => id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
/** Brand prefixes the model's own name follows (claude-opus-5-5, claude-3-7-sonnet). */
const BRANDS = new Set(["claude"]);

/** Words after a name that make a variant of it, not another name (claude-opus-latest is still Opus). */
const VARIANTS = new Set(["latest", "preview", "exp", "beta", "thinking", "instruct", "chat", "mini", "nano", "lite", "flash", "pro",
  "max", "plus", "turbo", "fast", "free", "online", "batch", "it", "base"]);
const isName = (token: Token | undefined) => token !== undefined && /^[a-z]+$/.test(token.text) && !VARIANTS.has(token.text);

function rank(query: readonly Token[], model: WordsModel, options: ModelWordsOptions): Ranked | undefined {
  const id = tokens(nameOf(model.id));
  const start = findRun(query, id);
  if (start === -1) return undefined;
  if (options.head && start > 0) {
    // Past a brand and the numbers after it (claude-3-7-sonnet), the name starts.
    let head = BRANDS.has(id[0]!.text) ? 1 : 0;
    while (head && head < start && numeric(id[head]!)) head++;
    if (start !== head) return undefined;
  }
  const end = start + query.length;
  const rest = id.slice(end);
  const dated = rest.some((token) => token.date);
  const undated = id.filter((token) => !token.date);
  const words = query.map((token) => token.text).join("-");
  // Ending the id counts only when the words end in a number (a version asked for): `sonnet` alone is a family,
  // and claude-3-7-sonnet-20250219 must not beat claude-sonnet-4-5 for it.
  const tier = undated.map((token) => token.text).join("-") === words ? 0
    : numeric(query[query.length - 1]!) && rest.every((token) => token.date) ? 1 : 2;
  const versionOf = (from: readonly Token[]) => {
    const found: number[] = [];
    for (const token of from) {
      if (!numeric(token) || token.glued) break;
      found.push(Number(token.text));
    }
    return found;
  };
  // A name right after the words (claude-opus-5-5 for `claude`), unless it is the unit of a size (qwen3:8b for `qwen3 8`).
  const branch = isName(rest[0]) && !id[end - 1]!.glued ? rest[0]!.text : "";
  // The version after the words (claude-opus-5-5) or after the name that follows them; when the words end the id,
  // the one before them (claude-3-7-sonnet).
  let version = versionOf(branch ? rest.slice(1) : rest);
  if (rest.every((token) => token.date)) version = id.slice(0, start).filter((token) => numeric(token) && !token.glued).map((token) => Number(token.text));
  // A size and its unit (8b) count once.
  const extra = rest.filter((token) => !token.date && !token.glued).length;
  const elsewhere = !options.current || options.current.provider.toLowerCase() !== model.provider.toLowerCase();
  return { model, tier, version: tier === 2 ? version : [], dated, extra, elsewhere, branch };
}

/** The best of `ranked` (at least one): one model, or several equally good. */
function pick(ranked: Ranked[]): Ranked[] {
  ranked.sort(compare);
  const best = ranked[0]!;
  const top = ranked.filter((entry) => entry.tier === best.tier && entry.elsewhere === best.elsewhere);
  // Different names after the words (`claude`: opus, sonnet, haiku), or the best on several other providers: the
  // best of each, never a guess and never a silent move to another provider.
  const groups = new Map<string, Ranked[]>();
  for (const entry of top) {
    const key = `${entry.branch}\0${entry.elsewhere ? entry.model.provider.toLowerCase() : ""}`;
    const group = groups.get(key);
    if (!group) groups.set(key, [entry]);
    else if (compare(entry, group[0]!) === 0) group.push(entry);
  }
  if (groups.size > 1) return [...groups.values()].flat();
  const tied = groups.values().next().value!;
  if (tied.length > 1) return tied;
  // A better match only elsewhere while yours has one too: both, to pick from.
  const yours = best.elsewhere ? ranked.find((entry) => !entry.elsewhere) : undefined;
  return yours ? [best, yours] : [best];
}

/** How near a model is to words that matched nothing: words found in its name, then how much of each. */
function nearness(query: readonly Token[], model: WordsModel): number {
  const id = tokens(nameOf(model.id)).map((token) => token.text);
  let score = 0;
  let named = false;
  for (const word of query) {
    const letters = /^[a-z]{2,}$/.test(word.text);
    if (id.includes(word.text)) { score += 2; named ||= letters; }
    else if (letters && id.some((token) => token.startsWith(word.text) || word.text.startsWith(token) && token.length > 2)) { score += 1; named = true; }
  }
  // A number alone is near nothing: `vue 3` lists no model with a 3 in it.
  return named ? score : 0;
}

/** All the version numbers in a model's name, for listing the newest first. */
const allNumbers = (model: WordsModel) => tokens(nameOf(model.id)).filter((token) => numeric(token) && !token.glued).map((token) => Number(token.text));

/** The closest few to words that matched nothing: the newest first, an undated alias before its dated copy, one per
 * name (the provider you are on first), no OpenRouter `~` alias or `:batch` copy. */
function closestTo(query: readonly Token[], models: readonly WordsModel[], options: ModelWordsOptions): WordsModel[] {
  const elsewhere = (model: WordsModel) => Number(!options.current || options.current.provider.toLowerCase() !== model.provider.toLowerCase());
  const dated = (model: WordsModel) => Number(tokens(nameOf(model.id)).some((token) => token.date));
  const near = models.filter((model) => !model.id.includes("~") && !/:batch$/i.test(model.id))
    .map((model) => ({ model, score: nearness(query, model) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || compareVersions(allNumbers(b.model), allNumbers(a.model)) || dated(a.model) - dated(b.model)
      || elsewhere(a.model) - elsewhere(b.model) || a.model.id.localeCompare(b.model.id));
  const seen = new Set<string>();
  const out: WordsModel[] = [];
  for (const { model } of near) {
    const name = tokens(nameOf(model.id)).filter((token) => !token.date).map((token) => token.text).join("-");
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(model);
    if (out.length === 3) break;
  }
  return out;
}

/** The model loose words name among `models`; see the top of this file. */
export function matchModelWords(words: string, models: readonly WordsModel[], options: ModelWordsOptions = {}): ModelWordsMatch {
  let text = words.trim();
  let effort: EffortSelection | undefined;
  const colon = text.lastIndexOf(":");
  if (colon !== -1 && isEffortSelection(text.slice(colon + 1).toLowerCase())) {
    effort = text.slice(colon + 1).toLowerCase() as EffortSelection;
    text = text.slice(0, colon).trim();
  }
  const query = tokens(text);
  if (!query.length) return { kind: "none", closest: [] };
  // A leading provider (`anthropic opus`, `ollama/qwen3`) narrows to that provider; when nothing there matches, it is
  // read as an ordinary word (OpenRouter's anthropic/… ids).
  const providers = new Set(models.map((model) => model.provider.toLowerCase()));
  const lead = /^\s*([^\s/]+)(?:\s+|\/)(.+)$/.exec(text);
  const attempts: Array<{ query: Token[]; models: readonly WordsModel[] }> = [];
  if (lead && providers.has(lead[1]!.toLowerCase()) && tokens(lead[2]!).length) {
    attempts.push({ query: tokens(lead[2]!), models: models.filter((model) => model.provider.toLowerCase() === lead[1]!.toLowerCase()) });
  }
  attempts.push({ query, models });
  for (const attempt of attempts) {
    const ranked = attempt.models.map((model) => rank(attempt.query, model, options)).filter((entry): entry is Ranked => Boolean(entry));
    if (!ranked.length) continue;
    const best = pick(ranked);
    if (best.length === 1) return { kind: "one", model: best[0]!.model, ...(effort ? { effort } : {}) };
    return { kind: "several", models: best.map((entry) => entry.model), ...(effort ? { effort } : {}) };
  }
  return { kind: "none", closest: closestTo(query, models, options) };
}

/** `No model matches "opus 9"; closest: a, b. /model to see all. Model unchanged.` */
export function noModelMessage(words: string, closest: readonly ModelReference[]): string {
  const near = closest.length ? `; closest: ${closest.map((model) => `${model.provider}/${model.id}`).join(", ")}` : "";
  return `No model matches ${JSON.stringify(words)}${near}. /model to see all. Model unchanged.`;
}
