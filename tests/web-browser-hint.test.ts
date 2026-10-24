import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { OutcomeUnknownError } from "../src/capabilities/result";
import { WebLookup, type WebHttp, type WebLookupOptions } from "../src/web/lookup";
import type { SearchProvider } from "../src/web/providers";
import { webTools } from "../src/web/tools";
import type { WebDns } from "../src/web/url";

/**
 * A page web_fetch can't read for the person (a sign-in page, a site that turns anything but a browser away, a page
 * that shows its text only with JavaScript, a site that doesn't answer) says what can: the AI's browser, whose
 * signin asks the person first, or the person. Addresses web_fetch refuses on purpose get no such advice.
 */

const PUBLIC: Record<string, string> = { "docs.example.com": "93.184.215.14", "app.example.com": "93.184.215.15" };
const dns = (extra: Record<string, string> = {}): WebDns => async (host: string) => {
  const address = extra[host] ?? PUBLIC[host];
  return address ? [{ address, family: 4 as const }] : [];
};
const page = (body: string, status = 200, type = "text/html; charset=utf-8", headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": type, ...headers } });

function lookupWith(http: WebHttp, options: Partial<WebLookupOptions> = {}) {
  const provider: SearchProvider = { id: "duckduckgo", label: "Fake", search: async () => [] };
  return new WebLookup({ provider, http, dns: dns(), env: {}, now: () => new Date("2026-10-23T12:00:00Z"), ...options });
}

const ARTICLE = `<title>Guide</title><main>${"<p>Configure the switch ports one by one, then save and check the result.</p>".repeat(30)}</main>`;
const LOGIN_FORM = `<title>Sign in</title><form><label>Email <input type="email" name="email"></label>
  <label>Password <input type="password" name="password"></label><button>Sign in</button></form>`;
const APP_SHELL = `<title>Dashboard</title><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript>
  <script src="/static/main.js"></script>`;
const CHALLENGE = "<title>Just a moment...</title><p>Checking your browser before accessing docs.example.com.</p><script>/* challenge */</script>";

test("a sign-in page, a site that turned the lookup away and a page that needs JavaScript are named; ordinary pages and API errors are not", async () => {
  const cases: Array<[string, WebHttp, string, string | undefined]> = [
    ["401 page", async () => page("<title>Unauthorized</title><p>Please sign in.</p>", 401), "https://app.example.com/reports", "sign-in"],
    ["sent to a login page", async (request) => request.url.pathname === "/login" ? page(LOGIN_FORM)
      : new Response(null, { status: 302, headers: { location: "/login?next=%2Fdashboard" } }), "https://app.example.com/dashboard", "sign-in"],
    ["short page with a password form", async () => page(LOGIN_FORM), "https://app.example.com/dashboard", "sign-in"],
    ["403", async () => page("<title>Access denied</title><p>You don't have permission to access this page.</p>", 403), "https://docs.example.com/a", "turned-away"],
    ["429", async () => page("<p>Too many requests</p>", 429), "https://docs.example.com/a", "turned-away"],
    ["503 bot check", async () => page(CHALLENGE, 503), "https://docs.example.com/a", "turned-away"],
    ["app shell", async () => page(APP_SHELL), "https://app.example.com/dashboard", "javascript"],
    // The page asked for: a guide about signing in, or the sign-in page itself asked for by its address, is read as it is.
    ["a guide at /login", async () => page(ARTICLE), "https://docs.example.com/login", undefined],
    ["the sign-in page asked for", async () => page(LOGIN_FORM), "https://app.example.com/login", undefined],
    ["ordinary page", async () => page(ARTICLE), "https://docs.example.com/guide", undefined],
    ["404", async () => page("<title>Not found</title><p>No such page.</p>", 404), "https://docs.example.com/missing", undefined],
    // An API's own answer is not a page a browser reads better.
    ["API 401", async () => page(JSON.stringify({ message: "Bad credentials" }), 401, "application/json"), "https://app.example.com/api/user", undefined],
    ["API 403", async () => page(JSON.stringify({ message: "rate limited" }), 403, "application/json"), "https://app.example.com/api/user", undefined],
  ];
  for (const [name, http, url, expected] of cases) {
    const result = await lookupWith(http).fetch(url);
    expect({ name, unread: result.unread }).toEqual({ name, unread: expected as never });
  }
});

/** web_fetch's reply as the model reads it. */
async function fetched(http: WebHttp, url: string, browser: boolean, options: Partial<WebLookupOptions> = {}) {
  const tool = webTools(lookupWith(http, options), undefined, { browser: () => browser }).find((entry) => entry.name === "web_fetch")!;
  const reply = await tool.execute({ url });
  return { reply, shown: JSON.parse(reply.text) as { error?: string; next?: string; data?: { unread?: string; next?: string; status: number } } };
}

test("web_fetch says what reads such a page: the browser when it is offered (signin for a sign-in page), else the person", async () => {
  const signIn = await fetched(async () => page(LOGIN_FORM), "https://app.example.com/dashboard", true);
  expect(signIn.shown.data?.next).toBe("This is a sign-in page, not the page asked for. If the person wants it read, the browser tool's signin "
    + "action asks them to sign in, in a window you never see; then open the page with the browser and inspect it.");
  const away = await fetched(async () => page("<p>Access denied</p>", 403), "https://docs.example.com/a", true);
  expect(away.shown.data?.next).toBe("The site turned this lookup away (status 403), as some do for anything but a browser. Open the page with "
    + "the browser tool and inspect it; if it is turned away there too, tell the person you can't read it.");
  const script = await fetched(async () => page(APP_SHELL), "https://app.example.com/dashboard", true);
  expect(script.shown.data?.next).toBe("This page shows its text only with JavaScript, which web_fetch doesn't run. Open it with the browser "
    + "tool and inspect it to read the text.");
  // No browser to offer: the person can open it.
  for (const http of [async () => page(LOGIN_FORM), async () => page("<p>Access denied</p>", 403), async () => page(APP_SHELL)] as WebHttp[]) {
    const plain = await fetched(http, "https://app.example.com/dashboard", false);
    expect(plain.shown.data?.next).toBe("Tell the person you can't read this page here; they can open it in their own browser and paste what you need.");
  }
  // An ordinary page has nothing to add.
  const ordinary = await fetched(async () => page(ARTICLE), "https://docs.example.com/guide", true);
  expect(ordinary.shown.data && "next" in ordinary.shown.data).toBe(false);
  expect(ordinary.reply.text).not.toContain("browser");
});

test("a site that can't be reached may still open in the browser; an address that doesn't exist or is private is never sent there", async () => {
  const reset = await fetched(async () => { throw new Error("read ECONNRESET"); }, "https://docs.example.com/a", true);
  expect(reset.reply.isError).toBe(true);
  expect(reset.shown.error).toBe("could not reach docs.example.com (read ECONNRESET)");
  expect(reset.shown.next).toBe("If the address is right, the browser tool may still open it, as some sites only answer browsers; if it can't, "
    + "tell the person you can't read it.");
  const lookup = lookupWith(async () => page("x"));
  lookup.fetch = async () => { throw new OutcomeUnknownError("docs.example.com did not answer within 15 seconds"); };
  const slow = JSON.parse((await webTools(lookup, undefined, { browser: () => true })[1]!.execute({ url: "https://docs.example.com/a" })).text);
  expect(slow.next).toContain("the browser tool may still open it");
  const noBrowser = await fetched(async () => { throw new Error("read ECONNRESET"); }, "https://docs.example.com/a", false);
  expect(noBrowser.shown.next).toBe("Tell the person you can't read this page here; they can open it in their own browser and paste what you need.");
  // web_fetch refuses these on purpose: nothing points the AI at another way in.
  for (const [url, extra] of [["https://nowhere.example.com/", {}], ["https://router.example.com/", { "router.example.com": "10.0.0.1" }],
    ["https://metadata.example.com/", { "metadata.example.com": "169.254.169.254" }], ["https://127.0.0.1/", {}]] as const) {
    const refused = await fetched(async () => page("x"), url, true, { dns: dns(extra) });
    expect({ url, refused: refused.reply.isError, next: refused.shown.next, browser: refused.reply.text.includes("browser") })
      .toEqual({ url, refused: true, next: undefined, browser: false });
  }
});

test("the advice counts toward the observation: a long page that turned the lookup away still comes back whole, with next", async () => {
  const long = `<title>Blocked</title>${"<p>Your request was blocked by our security service. Reference 0000.</p>".repeat(600)}`;
  const { reply, shown } = await fetched(async () => page(long, 403), "https://docs.example.com/a", true);
  expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(16_384);
  expect(shown.data?.status).toBe(403);
  expect(shown.data?.unread).toBe("turned-away");
  expect(shown.data?.next).toContain("Open the page with the browser tool");
});

test("the docs say when web_fetch points to the browser, and that refused addresses never are", async () => {
  const configuration = (await readFile(new URL("../docs/CONFIGURATION.md", import.meta.url), "utf8")).replace(/\s+/g, " ");
  expect(configuration).toContain("When a page can't be read this way (a sign-in page, a site that turns anything but a browser away, a page "
    + "that shows its text only with JavaScript, or a site that doesn't answer), the result tells the AI to open it in its own browser");
  expect(configuration).toContain("An address `web_fetch` refuses (private, local, cloud metadata, or one that doesn't exist) is never pointed there.");
  const browser = (await readFile(new URL("../docs/BROWSER.md", import.meta.url), "utf8")).replace(/\s+/g, " ");
  expect(browser).toContain("A page `web_fetch` can't read comes here");
});
