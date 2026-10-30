import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VERSION as ENGINE_VERSION } from "@earendil-works/pi-coding-agent";
import { engineAgent, forgetLatestLists, LATEST_EVERY_MS, listDay, listFreshness, PI_CATALOG_URL, STALE_AFTER_MS } from "../src/runtime/catalog-freshness";
import { removeTempDir } from "./support/temp-dir";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);
const OCT_15 = Date.UTC(2026, 9, 15, 12, 41, 1);
const OCT_21 = Date.UTC(2026, 9, 21, 0, 0, 0);
const OCT_29 = Date.UTC(2026, 9, 29, 13, 12, 59);

const dirs: string[] = [];
afterEach(async () => { forgetLatestLists(); await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir))); });

/** The engine's saved copies of pi.dev's lists (models-store.json), with the date pi.dev last changed each. */
async function store(entries: Record<string, { lastModified?: number; checkedAt?: number }>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-freshness-")); dirs.push(dir);
  await writeFile(path.join(dir, "models-store.json"), JSON.stringify(Object.fromEntries(Object.entries(entries)
    .map(([provider, entry]) => [provider, { models: [{ id: "fixture" }], checkedAt: NOW, etag: "\"fixture\"", ...entry }]))));
  return dir;
}

/** pi.dev as a fake: the date of each provider's current list, and of the copy it gives this engine version (named by
 * the engine's own User-Agent, as pi.dev pins it; the current one when not given), and the requests made. */
function piDev(latest: Record<string, number | { current: number; engine: number } | undefined>) {
  const asked: Array<{ url: string; method?: string; agent?: string | null }> = [];
  return { asked, fetch: async (url: string, init?: RequestInit) => {
    const agent = new Headers(init?.headers).get("user-agent");
    asked.push({ url, method: init?.method, agent });
    const provider = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
    const dates = latest[provider];
    const at = typeof dates === "object" ? (agent === engineAgent() ? dates.engine : dates.current) : dates;
    return at === undefined ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { "last-modified": new Date(at).toUTCString() } });
  } };
}

const signedIn = (...providers: string[]) => ({ hasConfiguredAuth: (provider: string) => providers.includes(provider) });

test("a list pi.dev froze for this Casper's engine says so, with both dates, never just 'refreshed'", async () => {
  // The pinned-shard case of October 2026: the engine was given openai-codex's list of Oct 15 while pi.dev's current one
  // was from Oct 29, and every check answered 304, so the list never moved.
  const agentDir = await store({ "openai-codex": { lastModified: OCT_15 } });
  const host = piDev({ "openai-codex": { current: OCT_29, engine: OCT_15 } });
  const lists = await listFreshness({ catalog: signedIn("openai-codex"), agentDir, fetch: host.fetch, now: NOW, builtinAt: OCT_21 - 10 * DAY, env: {} });
  expect(lists).toEqual([{ provider: "openai-codex", source: "pi.dev", at: OCT_15,
    stale: `list from Oct 15; pi.dev's is from Oct 29, but this Casper's engine (version ${ENGINE_VERSION}) is given the older one. Update Casper.` }]);
  // Two plain requests, no body and no sign-in: the date of the copy the engine is given (its own name, which pi.dev
  // pins to its version) and of the current copy (Casper's name).
  const url = `${PI_CATALOG_URL}openai-codex?types=chat%2Cimage%2Cclassifier`;
  expect(host.asked).toEqual([{ url, method: "HEAD", agent: engineAgent() }, { url, method: "HEAD", agent: expect.stringMatching(/^casper\//) }]);
  expect(engineAgent()).toStartWith(`pi/${ENGINE_VERSION} (`);
});

test("an old copy the engine would be given a newer one of on its next refresh is not called out of date", async () => {
  // Just after an engine update: the saved copy is the old engine's, and pi.dev gives this one the current list.
  const agentDir = await store({ "openai-codex": { lastModified: OCT_15 } });
  const host = piDev({ "openai-codex": { current: OCT_29, engine: OCT_29 } });
  expect(await listFreshness({ catalog: signedIn("openai-codex"), agentDir, fetch: host.fetch, now: NOW, builtinAt: OCT_15 - DAY, env: {} }))
    .toEqual([{ provider: "openai-codex", source: "pi.dev", at: OCT_15 }]);
});

test("an old list that pi.dev hasn't changed since is not out of date", async () => {
  const agentDir = await store({ "github-copilot": { lastModified: OCT_15 } });
  const host = piDev({ "github-copilot": OCT_15 });
  const lists = await listFreshness({ catalog: signedIn("github-copilot"), agentDir, fetch: host.fetch, now: NOW, builtinAt: OCT_15 - DAY, env: {} });
  expect(lists).toEqual([{ provider: "github-copilot", source: "pi.dev", at: OCT_15 }]);
});

test("a list under a week old asks pi.dev nothing; one the engine ships newer than pi.dev's copy is 'built in'", async () => {
  const agentDir = await store({ anthropic: { lastModified: NOW - DAY }, google: { lastModified: OCT_15 } });
  const host = piDev({});
  const lists = await listFreshness({ catalog: signedIn("anthropic", "google"), agentDir, fetch: host.fetch, now: NOW, builtinAt: NOW - 2 * DAY, env: {} });
  expect(lists).toEqual([{ provider: "anthropic", source: "pi.dev", at: NOW - DAY }, { provider: "google", source: "built in", at: NOW - 2 * DAY }]);
  expect(host.asked).toEqual([]);
  expect(STALE_AFTER_MS).toBe(7 * DAY);
});

test("pi.dev is asked about a provider at most every 4 hours; offline, not signed in, or OpenRouter: never", async () => {
  const agentDir = await store({ "openai-codex": { lastModified: OCT_15 }, openrouter: { lastModified: OCT_15 }, mistral: { lastModified: OCT_15 } });
  const host = piDev({ "openai-codex": { current: OCT_29, engine: OCT_15 } });
  const options = { catalog: signedIn("openai-codex", "openrouter"), agentDir, fetch: host.fetch, builtinAt: OCT_15 - DAY, env: {} };
  await listFreshness({ ...options, now: NOW });
  const later = await listFreshness({ ...options, now: NOW + LATEST_EVERY_MS - 1 });
  expect(later[0]?.stale).toContain("Update Casper.");
  expect(host.asked).toHaveLength(2);
  await listFreshness({ ...options, now: NOW + LATEST_EVERY_MS });
  expect(host.asked).toHaveLength(4);
  forgetLatestLists();
  // OpenRouter's models come from OpenRouter's own list (src/runtime/openrouter-models.ts); mistral isn't signed in.
  expect((await listFreshness({ ...options, now: NOW, env: { CASPER_OFFLINE: "1" } })).map((list) => [list.provider, list.stale])).toEqual([["openai-codex", undefined]]);
  expect(host.asked).toHaveLength(4);
});

test("pi.dev not answering, or not knowing the provider, makes no claim", async () => {
  const agentDir = await store({ "openai-codex": { lastModified: OCT_15 }, custom: { lastModified: OCT_15 } });
  const down = async () => { throw new Error("offline"); };
  expect(await listFreshness({ catalog: signedIn("openai-codex"), agentDir, fetch: down, now: NOW, builtinAt: OCT_15 - DAY, env: {} }))
    .toEqual([{ provider: "openai-codex", source: "pi.dev", at: OCT_15 }]);
  const host = piDev({});
  expect(await listFreshness({ catalog: signedIn("custom"), agentDir, fetch: host.fetch, now: NOW, builtinAt: OCT_15 - DAY, env: {} }))
    .toEqual([{ provider: "custom", source: "pi.dev", at: OCT_15 }]);
});

test("an account's own list is the source; models it offers that this Casper can't call, and a failed read, are said", async () => {
  const agentDir = await store({ "openai-codex": { lastModified: NOW - DAY }, "github-copilot": { lastModified: NOW - DAY } });
  const accounts = new Map([
    ["openai-codex", { ids: ["gpt-6.1-sol", "gpt-9-fixture"], at: NOW - 60_000, unknown: ["gpt-9-fixture"] }],
    ["github-copilot", { ids: ["gpt-6.1-sol"], at: NOW - DAY, unknown: [], problem: "GitHub Copilot answered HTTP 503" }],
  ]);
  const lists = await listFreshness({ catalog: signedIn("openai-codex", "github-copilot"), agentDir, accounts, fetch: piDev({}).fetch, now: NOW, builtinAt: OCT_15, env: {} });
  expect(lists).toEqual([
    { provider: "github-copilot", source: "your account", at: NOW - DAY, stale: `couldn't read your account's list (GitHub Copilot answered HTTP 503); showing the one read ${listDay(NOW - DAY)}.` },
    { provider: "openai-codex", source: "your account", at: NOW - 60_000, unknown: ["gpt-9-fixture"] },
  ]);
});

test("dates are shown as the day pi.dev names, whatever this computer's time zone", () => {
  expect(listDay(OCT_15)).toBe("Oct 15");
  expect(listDay(Date.UTC(2026, 9, 29, 23, 59))).toBe("Oct 29");
});
