import { afterEach, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { forgetModelFacts, modelFacts, type ModelFacts } from "../src/runtime/model-facts";
import { forgetOpenRouterModels, OPENROUTER_MODELS_URL, OPENROUTER_ZDR_URL, parseZeroRetentionHosts, startOpenRouterModels, type OpenRouterModel } from "../src/runtime/openrouter-models";
import { ModelBrowser, type ModelBrowserCatalog } from "../src/runtime/pi-model-browser";
import { removeTempDir } from "./support/temp-dir";

const dirs: string[] = [];
const lifetimes: AbortController[] = [];
afterEach(async () => {
  for (const lifetime of lifetimes.splice(0)) lifetime.abort();
  forgetOpenRouterModels();
  forgetModelFacts();
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
});

/** One model as OpenRouter's list has it. */
const listed = (id: string): OpenRouterModel => ({
  id, name: id, context_length: 131_072, pricing: { prompt: "0.0000002", completion: "0.0000008" },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: ["tools"],
  top_provider: { context_length: 131_072, max_completion_tokens: 32_768 },
});
/** OpenRouter's zero-data-retention list: one entry per host serving a model. */
const zeroRetention = [
  { model_id: "vendor-p/private-model", provider_name: "Hoster One", tag: "hoster-one/fp8" },
  { model_id: "vendor-p/private-model", provider_name: "Hoster One", tag: "hoster-one/fp4" },
  { model_id: "vendor-p/private-model", provider_name: "Hoster\u001b[31m Two\u0007", tag: "hoster-two" },
  { model_id: "vendor-x/not-in-the-list", provider_name: "Hoster Three" },
  { model_id: 42, provider_name: "Broken" },
];

/** A signed-in engine catalog, and OpenRouter's two public lists as a fake host serves them. */
async function signedIn() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-model-privacy-")); dirs.push(dir);
  await writeFile(path.join(dir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-placeholder-0000" } }), { mode: 0o600 });
  const catalog = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json"), refreshOnCreate: false });
  await catalog.refresh({ providers: ["openrouter"], allowNetwork: false });
  const state = { sent: [] as Array<{ url: string; init?: RequestInit }>, zeroRetention: (): Response | Promise<Response> => Response.json({ data: zeroRetention }) };
  const fetch = async (url: string, init?: RequestInit) => {
    state.sent.push({ url, init });
    return url === OPENROUTER_ZDR_URL ? state.zeroRetention() : Response.json({ data: [listed("vendor-p/private-model"), listed("vendor-k/keeps-prompts")] });
  };
  const lifetime = new AbortController(); lifetimes.push(lifetime);
  return { catalog, state, fetch, lifetime };
}
const urls = (state: { sent: Array<{ url: string }> }) => state.sent.map((request) => request.url);

test("OpenRouter's zero-data-retention list names each model's hosts that keep nothing, once each and in plain text", () => {
  const hosts = parseZeroRetentionHosts({ data: zeroRetention });
  expect(hosts.get("vendor-p/private-model")).toEqual(["Hoster One", "Hoster[31m Two"]);
  expect(hosts.get("vendor-x/not-in-the-list")).toEqual(["Hoster Three"]);
  expect(hosts.size).toBe(2);
  expect(parseZeroRetentionHosts({ data: [{ model_id: "vendor-l/long", provider_name: "H".repeat(60) }] }).get("vendor-l/long")).toEqual(["H".repeat(40)]);
  for (const body of [{ data: [] }, { data: [{ model_id: 1 }] }, { unexpected: true }, []]) expect(() => parseZeroRetentionHosts(body)).toThrow();
});

test("the same reads say which models a host keeps nothing for: a model the list doesn't name may keep prompts; nothing about where requests go changes", async () => {
  const { catalog, state, fetch, lifetime } = await signedIn();
  const live = startOpenRouterModels(catalog, lifetime.signal, { env: {}, fetch, freshMs: 0 });
  await live.refresh();
  expect(modelFacts("openrouter", "vendor-p/private-model")?.privateHosts).toEqual(["Hoster One", "Hoster[31m Two"]);
  expect(modelFacts("openrouter", "vendor-k/keeps-prompts")?.privateHosts).toEqual([]);
  // Display only: no request is restricted to those hosts.
  for (const id of ["vendor-p/private-model", "vendor-k/keeps-prompts"]) {
    expect(catalog.getModel("openrouter", id)?.compat).not.toHaveProperty("openRouterRouting");
  }
  // Both lists are public: plain requests, no key, no app name.
  expect(urls(state)).toEqual([OPENROUTER_MODELS_URL, OPENROUTER_ZDR_URL]);
  for (const request of state.sent) {
    expect([...new Headers(request.init?.headers).keys()]).toEqual(["accept"]);
    expect(request.init?.body).toBeUndefined();
  }
});

test("the zero-data-retention list is read at most every 30 minutes, and never signed out or offline", async () => {
  const { catalog, state, fetch, lifetime } = await signedIn();
  const live = startOpenRouterModels(catalog, lifetime.signal, { env: {}, fetch, freshMs: 0 });
  await live.refresh();
  await live.refresh();
  expect(urls(state)).toEqual([OPENROUTER_MODELS_URL, OPENROUTER_ZDR_URL, OPENROUTER_MODELS_URL]);
  forgetOpenRouterModels();
  state.sent.length = 0;
  const again = startOpenRouterModels(catalog, lifetime.signal, { env: {}, fetch, freshMs: 0, zeroRetentionFreshMs: 0 });
  await again.refresh();
  await again.refresh();
  expect(urls(state)).toEqual([OPENROUTER_MODELS_URL, OPENROUTER_ZDR_URL, OPENROUTER_MODELS_URL, OPENROUTER_ZDR_URL]);
  state.sent.length = 0;
  for (const env of [{ CASPER_OFFLINE: "1" }, { PI_OFFLINE: "1" }]) await startOpenRouterModels(catalog, lifetime.signal, { env, fetch, zeroRetentionFreshMs: 0 }).refresh();
  expect(state.sent).toEqual([]);
});

test("/model's refresh waits for the zero-data-retention list, so the rows it reloads have their marks; a start never waits for it", async () => {
  const { catalog, state, fetch, lifetime } = await signedIn();
  const answer = Promise.withResolvers<void>();
  state.zeroRetention = async () => { await answer.promise; return Response.json({ data: zeroRetention }); };
  const live = startOpenRouterModels(catalog, lifetime.signal, { env: {}, fetch, freshMs: 0 });
  await live.ready;
  expect(catalog.getModel("openrouter", "vendor-p/private-model")).toBeDefined();
  expect(modelFacts("openrouter", "vendor-p/private-model")).not.toHaveProperty("privateHosts");
  let refreshed = false;
  const refreshing = live.refresh().then(() => { refreshed = true; });
  await Bun.sleep(50);
  expect(refreshed).toBe(false);
  answer.resolve();
  await refreshing;
  expect(modelFacts("openrouter", "vendor-p/private-model")?.privateHosts).toEqual(["Hoster One", "Hoster[31m Two"]);
});

test("when the zero-data-retention list can't be read, no model is marked either way; the models are still listed", async () => {
  const { catalog, state, fetch, lifetime } = await signedIn();
  state.zeroRetention = () => new Response("busy", { status: 503 });
  await startOpenRouterModels(catalog, lifetime.signal, { env: {}, fetch, freshMs: 0 }).refresh();
  expect(catalog.getModel("openrouter", "vendor-k/keeps-prompts")).toBeDefined();
  expect(modelFacts("openrouter", "vendor-k/keeps-prompts")).toBeDefined();
  expect(modelFacts("openrouter", "vendor-k/keeps-prompts")).not.toHaveProperty("privateHosts");
  const picker = browser(catalog.getAvailableSnapshot().filter((model) => model.provider === "openrouter"));
  try {
    expect(text(picker)).not.toMatch(/🔒|⚠/);
  } finally { picker.dispose(); }
});

function fakeModel(provider: string, id: string): Model<Api> {
  return {
    id, name: id, api: "openai-completions", provider, baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 4_000,
  } as Model<Api>;
}
const fakeCatalog = (list: readonly Model<Api>[]): ModelBrowserCatalog => ({
  getAvailableSnapshot: () => list, getError: () => undefined, refresh: async () => ({ aborted: false, errors: new Map() }),
});
const fakeTui = () => ({ requestRender() {}, terminal: { rows: 24, columns: 200 } }) as unknown as TUI;
function browser(list: readonly Model<Api>[], facts?: Record<string, ModelFacts>) {
  return new ModelBrowser({ tui: fakeTui(), catalog: fakeCatalog(list), color: false, sessionOnly: false, onSelect() {}, onCancel() {},
    initialScope: list[0]?.provider, ...facts ? { facts: (provider: string, id: string) => facts[`${provider}/${id}`] } : {} });
}
const text = (picker: ModelBrowser, width = 200) => picker.render(width).join("\n");
const pane = (picker: ModelBrowser, width = 200) => text(picker, width).split("\n").map((line) => line.split(" │ ")[1] ?? "");
const row = (picker: ModelBrowser, label: string, width = 200) => pane(picker, width).find((line) => line.includes(` ${label} `)) ?? "";

const models = [fakeModel("openrouter", "vendor-p/private-model"), fakeModel("openrouter", "vendor-k/keeps-prompts"), fakeModel("openrouter", "vendor-u/unknown")];
const facts: Record<string, ModelFacts> = {
  "openrouter/vendor-p/private-model": { free: false, price: { input: 1, output: 2 }, tools: true, privateHosts: ["Hoster One", "Hoster Two", "Hoster Three", "Hoster Four"] },
  "openrouter/vendor-k/keeps-prompts": { free: false, price: { input: 1, output: 2 }, tools: true, privateHosts: [] },
  "openrouter/vendor-u/unknown": { free: false, price: { input: 1, output: 2 }, tools: true },
};

test("each row shows 🔒 when a host keeps nothing and ⚠ when every host may keep prompts; the legend says once that OpenRouter may pick another host", () => {
  const picker = browser(models, facts);
  try {
    expect(row(picker, "openrouter/vendor-p/private-model")).toMatch(/ 🔒 +128k ctx/);
    expect(row(picker, "openrouter/vendor-k/keeps-prompts")).toMatch(/ ⚠ +128k ctx/);
    expect(row(picker, "openrouter/vendor-u/unknown")).not.toMatch(/🔒|⚠/);
    // The marks take the same two cells, so the columns after them stay in line.
    const ctxAt = (line: string) => visibleWidth(line.slice(0, line.indexOf("128k ctx")));
    expect(new Set([row(picker, "openrouter/vendor-p/private-model"), row(picker, "openrouter/vendor-k/keeps-prompts"), row(picker, "openrouter/vendor-u/unknown")].map(ctxAt)).size).toBe(1);
    const shown = text(picker);
    expect(shown.match(/OpenRouter may pick another/g)).toHaveLength(1);
    expect(shown).toContain("🔒 a host keeps nothing (OpenRouter may pick another) · ⚠ every host may keep your prompts");
    for (const width of [40, 60, 80, 120, 200]) for (const line of picker.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    // Narrow lists keep the mark: it is the last thing to go.
    expect(pane(picker, 60).find((line) => line.includes("vendor-p/"))).toContain("🔒");
  } finally { picker.dispose(); }
  // Another provider's list, or one read without the zero-data-retention list, looks as before.
  const plain = browser([fakeModel("anthropic", "claude-x")]);
  try {
    expect(text(plain)).not.toMatch(/🔒|⚠|OpenRouter may pick another/);
  } finally { plain.dispose(); }
});

test("the line under the list names the hosts that keep nothing, or says no host promises it", () => {
  const picker = browser(models, facts);
  try {
    // The list opens on its first row (ids newest first): one the zero-data-retention list wasn't read for.
    expect(picker.render(200).at(-3)).toContain("openrouter/vendor-u/unknown");
    expect(picker.render(200).at(-3)).not.toMatch(/🔒|⚠|retention/);
    picker.handleInput("\x1b[B");
    expect(picker.render(200).at(-3)).toContain("$1/2 per M · 🔒 zero retention on Hoster One, Hoster Two, Hoster Three +1 more · AA not rated");
    picker.handleInput("\x1b[B");
    expect(picker.render(200).at(-3)).toContain("$1/2 per M · ⚠ no host promises zero retention · AA not rated");
  } finally { picker.dispose(); }
});
