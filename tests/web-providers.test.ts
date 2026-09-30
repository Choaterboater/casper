import { expect, test } from "bun:test";
import { NotExecutedError } from "../src/capabilities/result";
import { brave, duckduckgo, DUCKDUCKGO_REFUSED, parseBrave, parseDuckDuckGo, parseSearxng, searxng, type WebGet } from "../src/web/providers";

/** The shape of html.duckduckgo.com/html results, with an ad first. */
const DDG = `<!DOCTYPE html><html><body><div class="serp__results"><div id="links" class="results">
<div class="result results_links results_links_deep result--ad">
  <div class="links_main links_deep result__body"><h2 class="result__title">
  <a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example&amp;u3=x">Buy now</a></h2>
  <a class="result__snippet" href="https://duckduckgo.com/y.js?x">An ad</a></div></div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body"><h2 class="result__title">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs%2Fapi%2Fhtml%2Drewriter&amp;rut=abc"><b>HTMLRewriter</b> &ndash; Bun Docs</a></h2>
  <div class="result__extras"><a class="result__url" href="//duckduckgo.com/l/?uddg=x">bun.sh/docs</a></div>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Bun&#x27;s <b>HTMLRewriter</b> transforms HTML with CSS selectors.</a></div></div>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body"><h2 class="result__title">
  <a rel="nofollow" class="result__a" href="https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/">HTMLRewriter · Cloudflare Workers</a></h2>
  <a class="result__snippet" href="https://developers.cloudflare.com/x">Stream and rewrite HTML.</a></div></div>
</div></div></body></html>`;

test("DuckDuckGo's result page becomes titles, real links and snippets; ads are left out", async () => {
  expect(await parseDuckDuckGo(DDG, 5)).toEqual([
    { title: "HTMLRewriter – Bun Docs", url: "https://bun.sh/docs/api/html-rewriter", snippet: "Bun's HTMLRewriter transforms HTML with CSS selectors." },
    { title: "HTMLRewriter · Cloudflare Workers", url: "https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/", snippet: "Stream and rewrite HTML." },
  ]);
  expect(await parseDuckDuckGo(DDG, 1)).toHaveLength(1);
});

test("DuckDuckGo: one search every 2 seconds, and a 202 gives the plain refusal and a minute's rest", async () => {
  let clock = 1_000_000;
  const waits: number[] = [];
  const provider = duckduckgo({ now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  const urls: string[] = [];
  let status = 200;
  const get: WebGet = async (url, options) => {
    urls.push(url);
    expect(options?.accept).toBe("text/html");
    return { status, url, contentType: "text/html", text: DDG };
  };
  expect(await provider.search("bun html rewriter", 5, get)).toHaveLength(2);
  expect(urls[0]).toBe("https://html.duckduckgo.com/html/?q=bun%20html%20rewriter");
  await provider.search("again", 5, get);
  expect(waits).toEqual([2000]);
  status = 202;
  clock += 5000;
  await expect(provider.search("third", 5, get)).rejects.toThrow(DUCKDUCKGO_REFUSED);
  expect(DUCKDUCKGO_REFUSED).toContain("Brave");
  // While it rests, nothing is sent.
  clock += 30_000;
  const sent = urls.length;
  await expect(provider.search("fourth", 5, get)).rejects.toThrow(NotExecutedError);
  expect(urls.length).toBe(sent);
  status = 200;
  clock += 31_000;
  expect(await provider.search("later", 5, get)).toHaveLength(2);
});

test("Brave's JSON shape parses, the key goes in its header, and no key refuses without sending", async () => {
  const body = { web: { results: [
    { title: "Bun <strong>docs</strong>", url: "https://bun.sh/docs", description: "Fast <strong>JavaScript</strong> runtime &amp; toolkit" },
    { title: "no link", url: "javascript:alert(1)", description: "" },
  ] } };
  expect(await parseBrave(body, 5)).toEqual([{ title: "Bun docs", url: "https://bun.sh/docs", snippet: "Fast JavaScript runtime & toolkit" }]);
  let seen: { url: string; headers?: Record<string, string> } | undefined;
  const get: WebGet = async (url, options) => { seen = { url, ...(options?.headers ? { headers: options.headers } : {}) }; return { status: 200, url, contentType: "application/json", text: JSON.stringify(body) }; };
  expect(await brave(() => "BSA-test-key-123456").search("bun", 3, get)).toHaveLength(1);
  expect(seen).toEqual({ url: "https://api.search.brave.com/res/v1/web/search?q=bun&count=3", headers: { "X-Subscription-Token": "BSA-test-key-123456" } });
  seen = undefined;
  await expect(brave(() => undefined).search("bun", 3, get)).rejects.toThrow("no Brave key saved");
  expect(seen).toBeUndefined();
});

test("SearXNG asks your own address for JSON", async () => {
  expect(parseSearxng({ results: [{ title: "A", url: "https://a.example/", content: "about a" }] }, 5)).toEqual([{ title: "A", url: "https://a.example/", snippet: "about a" }]);
  let asked: { url: string; trusted?: boolean } | undefined;
  const get: WebGet = async (url, options) => { asked = { url, ...(options?.trusted ? { trusted: true } : {}) }; return { status: 200, url, contentType: "application/json", text: "{\"results\":[]}" }; };
  await searxng("http://127.0.0.1:8888/").search("a b", 5, get);
  expect(asked).toEqual({ url: "http://127.0.0.1:8888/search?q=a+b&format=json", trusted: true });
});
