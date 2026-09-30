import { NotExecutedError } from "../capabilities/result";
import { decodeEntities, htmlToText, tidyText } from "./html";

/** One search result, before Casper labels and scrubs it. */
export interface SearchHit { title: string; url: string; snippet: string }

/** What a provider gets back from one GET (the body as text, already size-capped). */
export interface WebReply { status: number; url: string; contentType: string; text: string }

/** A GET through the lookup's checks. `trusted`: your own configured provider address (searxng), which
 * may be on your network; nothing the AI or a page names is ever trusted. */
export type WebGet = (url: string, options?: { headers?: Record<string, string>; accept?: string; trusted?: boolean }, signal?: AbortSignal) => Promise<WebReply>;

/** A search provider. New ones (Tavily, Exa ...) only need this. */
export interface SearchProvider {
  readonly id: "duckduckgo" | "brave" | "searxng";
  /** The name /status and results show. */
  readonly label: string;
  search(query: string, count: number, get: WebGet, signal?: AbortSignal): Promise<SearchHit[]>;
}

/** The names /status and results show. */
export const PROVIDER_LABELS: Record<SearchProvider["id"], string> = { duckduckgo: "DuckDuckGo", brave: "Brave Search", searxng: "SearXNG" };

export const TITLE_LIMIT = 200;
export const SNIPPET_LIMIT = 400;

const clip = (text: string, limit: number) => {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit - 1).join("")}…`;
};
const hit = (title: string, url: string, snippet: string): SearchHit =>
  ({ title: clip(tidyText(title), TITLE_LIMIT), url, snippet: clip(tidyText(snippet), SNIPPET_LIMIT) });
const httpURL = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined; }
  catch { return undefined; }
};
const json = (reply: WebReply, name: string): unknown => {
  try { return JSON.parse(reply.text); } catch { throw new Error(`${name} sent back something that is not search results`); }
};

/** What to do when DuckDuckGo turns searches away. */
export const DUCKDUCKGO_NEXT = "Try again in a minute, or switch to Brave Search: web: { provider: brave } in ~/.casper/config.yaml, with your Brave key saved as \"brave\" in Casper's login file (~/.casper/agent/auth.json).";
export const DUCKDUCKGO_REFUSED = `DuckDuckGo turned the search away for now (it limits automated searches). ${DUCKDUCKGO_NEXT}`;

/** The DuckDuckGo result page's links go through duckduckgo.com/l/?uddg=<the real address>. */
function realLink(href: string): string | undefined {
  try {
    const url = new URL(decodeEntities(href), "https://html.duckduckgo.com/");
    if (/(^|\.)duckduckgo\.com$/.test(url.hostname)) {
      if (url.pathname === "/l/") return httpURL(url.searchParams.get("uddg"));
      return undefined; // ads (y.js) and DuckDuckGo's own pages
    }
    return httpURL(url.href);
  } catch { return undefined; }
}

/** Results from DuckDuckGo's HTML page (html.duckduckgo.com/html). */
export async function parseDuckDuckGo(html: string, count: number): Promise<SearchHit[]> {
  const found: { title: string; href: string; snippet: string }[] = [];
  let current: { title: string; href: string; snippet: string } | undefined;
  let into: "title" | "snippet" | undefined;
  await new HTMLRewriter()
    .on("a.result__a", {
      element(element) {
        current = { title: "", href: element.getAttribute("href") ?? "", snippet: "" };
        found.push(current);
        into = "title";
        element.onEndTag(() => { into = undefined; });
      },
    })
    .on(".result__snippet", {
      element(element) {
        if (!current) return;
        into = "snippet";
        try { element.onEndTag(() => { into = undefined; }); } catch { into = undefined; }
      },
    })
    .onDocument({ text(chunk) { if (current && into) current[into] += chunk.text; } })
    .transform(new Response(html))
    .text();
  const hits: SearchHit[] = [];
  for (const entry of found) {
    const url = realLink(entry.href);
    if (!url || hits.some((known) => known.url === url)) continue;
    hits.push(hit(decodeEntities(entry.title), url, decodeEntities(entry.snippet)));
    if (hits.length >= count) break;
  }
  return hits;
}

export interface PacedOptions { now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal!.reason); };
  signal?.addEventListener("abort", stop, { once: true });
});

/** DuckDuckGo, the default: no key and no cost. At most one search every 2 seconds, and after it turns a
 * search away (HTTP 202) none for a minute. */
export function duckduckgo(options: PacedOptions = {}): SearchProvider {
  const now = options.now ?? Date.now, wait = options.sleep ?? sleep;
  let next = 0, blockedUntil = 0, queue: Promise<unknown> = Promise.resolve();
  return {
    id: "duckduckgo",
    label: PROVIDER_LABELS.duckduckgo,
    search(query, count, get, signal) {
      const run = async () => {
        if (now() < blockedUntil) throw new NotExecutedError("DuckDuckGo turned a search away less than a minute ago", DUCKDUCKGO_NEXT);
        const delay = next - now();
        if (delay > 0) await wait(delay, signal);
        next = now() + 2000;
        const reply = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { accept: "text/html" }, signal);
        if (reply.status === 202 || reply.status === 403 || reply.status === 429) {
          blockedUntil = now() + 60_000;
          throw new Error(DUCKDUCKGO_REFUSED);
        }
        if (reply.status !== 200) throw new Error(`DuckDuckGo answered HTTP ${reply.status}`);
        return parseDuckDuckGo(reply.text, count);
      };
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
  };
}

/** Results from Brave Search's API reply. */
export async function parseBrave(body: unknown, count: number): Promise<SearchHit[]> {
  const results = (body as { web?: { results?: unknown } } | undefined)?.web?.results;
  if (!Array.isArray(results)) return [];
  const hits: SearchHit[] = [];
  for (const entry of results) {
    const item = entry as { title?: unknown; url?: unknown; description?: unknown };
    const url = httpURL(item.url);
    if (!url) continue;
    const plain = async (value: unknown) => typeof value === "string" ? (await htmlToText(value)).text : "";
    hits.push(hit(await plain(item.title), url, await plain(item.description)));
    if (hits.length >= count) break;
  }
  return hits;
}

/** Brave Search. `key` reads your key from Casper's login file when a search runs. */
export function brave(key: () => string | undefined): SearchProvider {
  return {
    id: "brave",
    label: PROVIDER_LABELS.brave,
    async search(query, count, get, signal) {
      const token = key();
      if (!token) throw new NotExecutedError("no Brave key saved", "Save your Brave Search key as \"brave\" in Casper's login file (~/.casper/agent/auth.json), or set web: { provider: duckduckgo } in ~/.casper/config.yaml");
      const reply = await get(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
        { accept: "application/json", headers: { "X-Subscription-Token": token } }, signal);
      if (reply.status === 401 || reply.status === 403) throw new Error("Brave Search did not accept the saved key");
      if (reply.status === 429) throw new Error("Brave Search says the plan's search limit is used up for now");
      if (reply.status !== 200) throw new Error(`Brave Search answered HTTP ${reply.status}`);
      return parseBrave(json(reply, "Brave Search"), count);
    },
  };
}

/** Results from a SearXNG JSON reply. */
export function parseSearxng(body: unknown, count: number): SearchHit[] {
  const results = (body as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(results)) return [];
  const hits: SearchHit[] = [];
  for (const entry of results) {
    const item = entry as { title?: unknown; url?: unknown; content?: unknown };
    const url = httpURL(item.url);
    if (!url) continue;
    hits.push(hit(typeof item.title === "string" ? item.title : "", url, typeof item.content === "string" ? item.content : ""));
    if (hits.length >= count) break;
  }
  return hits;
}

/** Your own SearXNG (web.searxngUrl), which has to allow format=json. */
export function searxng(base: string): SearchProvider {
  return {
    id: "searxng",
    label: PROVIDER_LABELS.searxng,
    async search(query, count, get, signal) {
      const url = new URL("search", base.endsWith("/") ? base : `${base}/`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const reply = await get(url.href, { accept: "application/json", trusted: true }, signal);
      if (reply.status === 403) throw new Error("SearXNG refused format=json; turn on the json format in its settings.yml (search.formats)");
      if (reply.status !== 200) throw new Error(`SearXNG answered HTTP ${reply.status}`);
      return parseSearxng(json(reply, "SearXNG"), count);
    },
  };
}
