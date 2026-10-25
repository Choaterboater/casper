import { afterEach, expect, test } from "bun:test";
import { ModelRuntime, type AgentSession, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { AnyModel } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  applyLatestOpenRouterModels, forgetOpenRouterModels, mergeOpenRouterModels, openRouterChatModel, OPENROUTER_MODELS_URL, OPENROUTER_ZDR_URL,
  startOpenRouterModels, type OpenRouterModel,
} from "../src/runtime/openrouter-models";
import { pickerCatalog } from "../src/runtime/pi-model-picker";
import { PiModels } from "../src/runtime/pi-models";
import { removeTempDir } from "./support/temp-dir";
import { waitUntil } from "./support/wait";

const dirs: string[] = [];
const lifetimes: AbortController[] = [];
afterEach(async () => {
  for (const lifetime of lifetimes.splice(0)) lifetime.abort();
  forgetOpenRouterModels();
  await Promise.all(dirs.splice(0).map((dir) => removeTempDir(dir)));
});

// The engine's OpenRouter list (its copy of pi.dev's): a model with request settings of its own, one OpenRouter no
// longer lists, and a picture model.
const known = {
  id: "vendor-a/known-model", name: "Vendor A: Known", provider: "openrouter", api: "anthropic-messages", baseUrl: "https://openrouter.ai/api",
  reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
  input: ["text", "image"], contextWindow: 200_000, maxTokens: 64_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, tiers: [{ inputTokensAbove: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 }] },
  compat: { thinkingFormat: "openrouter", cacheControlFormat: "anthropic", supportsStrictMode: true, sendSessionAffinityHeaders: true },
};
const older = {
  id: "vendor-b/older-model", name: "Vendor B: Older", provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false, input: ["text"], contextWindow: 131_072, maxTokens: 16_384, cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
  compat: { thinkingFormat: "openrouter", supportsStrictMode: true, sendSessionAffinityHeaders: true, supportsDeveloperRole: false },
};
const picture = {
  type: "image", id: "vendor-c/picture-model", name: "Vendor C: Pictures", provider: "openrouter", api: "openrouter-images",
  baseUrl: "https://openrouter.ai/api/v1", input: ["text", "image"], output: ["image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** One model as OpenRouter's list has it: prices are US dollars per token, as text. */
const row = (id: string, extra: Partial<OpenRouterModel> = {}): OpenRouterModel => ({
  id, name: id, context_length: 131_072,
  pricing: { prompt: "0.000001", completion: "0.000002", input_cache_read: "0.0000001" },
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  supported_parameters: ["tools", "tool_choice"],
  top_provider: { context_length: 131_072, max_completion_tokens: 32_768 },
  ...extra,
});
const live: OpenRouterModel[] = [
  // Newer facts about a model the engine lists.
  row("vendor-a/known-model", {
    name: "Vendor A: Known 2", context_length: 1_000_000, pricing: { prompt: "0.0000025", completion: "0.0000125", input_cache_read: "0.00000025" },
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools", "reasoning", "include_reasoning"],
    top_provider: { context_length: 400_000, max_completion_tokens: 128_000 },
  }),
  // Released today: in OpenRouter's list, not in the engine's yet.
  row("vendor-d/new-model", {
    name: "Vendor D: New", context_length: 1_048_576, pricing: { prompt: "0.0000002", completion: "0.0000008", input_cache_read: "0.00000002" },
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools", "tool_choice", "reasoning", "include_reasoning"],
    top_provider: { context_length: 262_144, max_completion_tokens: 65_536 },
  }),
  row("vendor-d/new-model:free", { name: "Vendor D: New (free)", pricing: { prompt: "0", completion: "0" } }),
  // Ones Casper can't work with: no tool calls, a router with no fixed price, pictures only, past its end date.
  row("vendor-e/no-tools", { supported_parameters: ["reasoning", "include_reasoning"] }),
  row("vendor-f/router", { pricing: { prompt: "-1", completion: "-1" } }),
  row("vendor-g/pictures-only", { architecture: { input_modalities: ["text"], output_modalities: ["image"] } }),
  row("vendor-h/retired", { expiration_date: "2020-01-31" }),
];

/** The engine's saved copy of pi.dev's OpenRouter list (models-store.json, beside models.json). */
async function stock(dir: string, models: object[]) {
  const now = Date.now();
  await writeFile(path.join(dir, "models-store.json"), JSON.stringify({ openrouter: { models, checkedAt: now, lastModified: now, etag: "\"fixture\"" } }));
}

/** A real engine catalog in a fresh folder, with (or without) an OpenRouter sign-in, as a start leaves it. */
async function engine(options: { signedIn?: boolean } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "casper-openrouter-models-")); dirs.push(dir);
  const signIns = options.signedIn === false ? {} : { openrouter: { type: "api_key", key: "sk-or-placeholder-0000" } };
  await writeFile(path.join(dir, "auth.json"), JSON.stringify(signIns), { mode: 0o600 });
  await stock(dir, [known, older, picture]);
  const catalog = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: path.join(dir, "models.json"), refreshOnCreate: false });
  // The engine's list comes back from its store, with no network.
  await catalog.refresh({ providers: ["openrouter"], allowNetwork: false });
  return { dir, catalog };
}

/** OpenRouter's model list as the fake host serves it (and its zero-data-retention list), and the addresses asked for. */
function host(models: OpenRouterModel[] = live) {
  const state = { urls: [] as string[], answer: (): Response => Response.json({ data: models }) };
  const zeroRetention = () => Response.json({ data: [{ model_id: "vendor-a/known-model", provider_name: "Hoster One" }] });
  return { state, fetch: async (url: string) => { state.urls.push(url); return url === OPENROUTER_ZDR_URL ? zeroRetention() : state.answer(); } };
}

function session() {
  const lifetime = new AbortController(); lifetimes.push(lifetime);
  return lifetime;
}

test("a model only OpenRouter lists: its window, prices, pictures, tools and thinking come from OpenRouter's list", () => {
  expect(openRouterChatModel(live[1]!)).toEqual({
    id: "vendor-d/new-model", name: "Vendor D: New", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
    reasoning: true, input: ["text", "image"],
    // OpenRouter's list doesn't say whether thinking can be turned off, and some models refuse "off": not offered.
    thinkingLevelMap: { off: null },
    // Dollars per token in OpenRouter's list, per million tokens in the catalog.
    cost: { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0 },
    // The window OpenRouter's usual host serves (the engine's list uses the same), not the largest any host has.
    contextWindow: 262_144, maxTokens: 65_536,
    compat: { thinkingFormat: "openrouter", supportsStrictMode: true, sendSessionAffinityHeaders: true, supportsDeveloperRole: false },
  });
  // A :free model, or one priced 0, is free; one that calls tools but has no thinking parameter doesn't think.
  expect(openRouterChatModel(live[2]!)).toMatchObject({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, input: ["text"] });
  expect(openRouterChatModel(live[2]!)).not.toHaveProperty("thinkingLevelMap");
  for (const model of live.slice(3)) expect(openRouterChatModel(model)).toBeUndefined();
});

test("over the engine's list: a model it lists keeps its request settings and takes OpenRouter's newer name, window and prices; new ones are added", () => {
  const merged = mergeOpenRouterModels([known, older, picture] as AnyModel[], live);
  expect(merged.map((model) => model.id)).toEqual(["vendor-a/known-model", "vendor-b/older-model", "vendor-c/picture-model", "vendor-d/new-model", "vendor-d/new-model:free"]);
  // Its API and address, thinking levels, longest answer and price tiers stay the engine's.
  expect(merged[0]).toEqual({ ...known, name: "Vendor A: Known 2", contextWindow: 400_000, cost: { ...known.cost, input: 2.5, output: 12.5, cacheRead: 0.25 } } as AnyModel);
  // One OpenRouter no longer lists, and the picture model, stay as the engine has them.
  expect(merged[1]).toBe(older as AnyModel);
  expect(merged[2]).toBe(picture as AnyModel);
});

test("signed in to OpenRouter: a model released today is in the catalog at once, the engine's newer list shows through on /model, and a failed read keeps the models", async () => {
  const { dir, catalog } = await engine();
  expect(catalog.getModel("openrouter", "vendor-d/new-model")).toBeUndefined();
  const { state, fetch } = host();
  const models = startOpenRouterModels(catalog, session().signal, { env: {}, fetch, freshMs: 0 });
  await models.ready;
  expect(state.urls).toEqual([OPENROUTER_MODELS_URL, OPENROUTER_ZDR_URL]);
  expect(catalog.getModel("openrouter", "vendor-d/new-model")).toMatchObject({ provider: "openrouter", api: "openai-completions", contextWindow: 262_144, cost: { input: 0.2, output: 0.8 } });
  expect(catalog.getModel("openrouter", "vendor-a/known-model")).toMatchObject({ api: "anthropic-messages", baseUrl: "https://openrouter.ai/api", contextWindow: 400_000, maxTokens: 64_000, cost: { input: 2.5, tiers: known.cost.tiers } });
  expect(catalog.getModel("openrouter", "vendor-b/older-model")).toBeDefined();
  expect(catalog.getAllModels("openrouter").some((model) => model.id === "vendor-c/picture-model")).toBe(true);
  expect(catalog.getModel("openrouter", "vendor-e/no-tools")).toBeUndefined();

  // pi.dev's copy catches up while the session runs: /model's refresh lays the list over the engine's newer one.
  await stock(dir, [known, older, picture, { ...older, id: "vendor-b/listed-later", name: "Vendor B: Later" }]);
  await catalog.refresh({ providers: ["openrouter"], allowNetwork: false });
  await models.refresh();
  expect(catalog.getModel("openrouter", "vendor-b/listed-later")).toBeDefined();
  expect(catalog.getModel("openrouter", "vendor-d/new-model")).toBeDefined();

  // OpenRouter doesn't answer: nothing listed goes away.
  state.answer = () => new Response("busy", { status: 503 });
  await models.refresh();
  state.answer = () => Response.json({ unexpected: true });
  await models.refresh();
  // The zero-data-retention list is read at most every 30 minutes: four reads of the model list, one of it.
  expect(state.urls.filter((url) => url === OPENROUTER_MODELS_URL)).toHaveLength(4);
  expect(state.urls.filter((url) => url === OPENROUTER_ZDR_URL)).toHaveLength(1);
  expect(catalog.getModel("openrouter", "vendor-d/new-model")).toBeDefined();
  expect(catalog.getModel("openrouter", "vendor-b/listed-later")).toBeDefined();
  expect(catalog.getModel("openrouter", "vendor-a/known-model")?.contextWindow).toBe(400_000);
});

test("OpenRouter's model list is read without your key or Casper's name: a plain request to its public address", async () => {
  const { catalog } = await engine();
  const sent: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string, init?: RequestInit) => { sent.push({ url, init }); return Response.json({ data: live }); };
  await startOpenRouterModels(catalog, session().signal, { env: {}, fetch }).ready;
  expect(sent.map((request) => [request.url, request.init?.method ?? "GET"])).toEqual([["https://openrouter.ai/api/v1/models", "GET"],
    ["https://openrouter.ai/api/v1/endpoints/zdr", "GET"]]);
  for (const request of sent) {
    expect([...new Headers(request.init?.headers).keys()]).toEqual(["accept"]);
    expect(request.init?.body).toBeUndefined();
  }
  expect(catalog.getModel("openrouter", "vendor-d/new-model")).toBeDefined();
});

test("not signed in to OpenRouter, or offline: its list is never read", async () => {
  const { catalog } = await engine({ signedIn: false });
  const { state, fetch } = host();
  const lifetime = session();
  const models = startOpenRouterModels(catalog, lifetime.signal, { env: {}, fetch, freshMs: 0 });
  await models.ready;
  await models.refresh();
  expect(catalog.getModel("openrouter", "vendor-d/new-model")).toBeUndefined();
  const signedIn = (await engine()).catalog;
  for (const env of [{ CASPER_OFFLINE: "1" }, { PI_OFFLINE: "1" }]) {
    const offline = startOpenRouterModels(signedIn, lifetime.signal, { env, fetch, freshMs: 0 });
    await offline.ready;
    await offline.refresh();
  }
  expect(state.urls).toEqual([]);
  expect(signedIn.getModel("openrouter", "vendor-d/new-model")).toBeUndefined();
});

test("a helper's catalog takes the list the main session read without reading it; a list another extension owns is left alone", async () => {
  const main = await engine();
  const { state, fetch } = host();
  await startOpenRouterModels(main.catalog, session().signal, { env: {}, fetch }).ready;
  const helper = await engine();
  applyLatestOpenRouterModels(helper.catalog);
  expect(helper.catalog.getModel("openrouter", "vendor-d/new-model")).toBeDefined();
  expect(state.urls).toEqual([OPENROUTER_MODELS_URL, OPENROUTER_ZDR_URL]);

  const other = await engine();
  other.catalog.registerProvider("openrouter", { models: [{ ...older, id: "vendor-x/own-list" }] as never });
  applyLatestOpenRouterModels(other.catalog);
  expect(other.catalog.getModels("openrouter").map((model) => model.id)).toEqual(["vendor-x/own-list"]);
});

test("the list is read again every few minutes while the session lasts, and laid on again only when it changed", async () => {
  const { catalog } = await engine();
  let models = live;
  const urls: string[] = [];
  const fetch = async (url: string) => { urls.push(url); return Response.json({ data: models }); };
  let laid = 0;
  const register = catalog.registerProvider.bind(catalog);
  catalog.registerProvider = (provider, config) => { laid++; register(provider, config); };
  const lifetime = session();
  startOpenRouterModels(catalog, lifetime.signal, { env: {}, fetch, everyMs: 15, freshMs: 0 });
  expect(await waitUntil(() => urls.length >= 3)).toBe(true);
  expect(laid).toBe(1);
  models = [...live, row("vendor-i/next-day", { name: "Vendor I: Next day" })];
  expect(await waitUntil(() => catalog.getModel("openrouter", "vendor-i/next-day") !== undefined)).toBe(true);
  expect(laid).toBe(2);
  lifetime.abort();
  const read = urls.length;
  await Bun.sleep(100);
  expect(urls).toHaveLength(read);
});

test("/model's refresh reads OpenRouter's list after the engine's catalogs, so the rows it reloads have both", async () => {
  const order: string[] = [];
  const target = { refresh: async () => { order.push("catalogs"); return { aborted: false, errors: new Map() }; } } as unknown as ModelRuntime;
  const view = pickerCatalog(target, undefined, async () => { order.push("openrouter"); });
  expect(await view.refresh({})).toEqual({ aborted: false, errors: new Map() });
  expect(order).toEqual(["catalogs", "openrouter"]);
});

/** PiModels over a catalog that lists `fresh` only once `listed()` says so. */
async function piModels(saved?: { defaultProvider: string; defaultModel: string }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "casper-openrouter-start-")); dirs.push(home);
  const agent = path.join(home, ".casper", "agent");
  await mkdir(agent, { recursive: true });
  if (saved) await writeFile(path.join(home, ".casper", "settings.json"), JSON.stringify(saved));
  const fresh = { ...older, id: "vendor-d/new-model", name: "Vendor D: New" };
  const state = { listed: false };
  const catalog = {
    getModels: () => state.listed ? [fresh] : [],
    getModel: (provider: string, id: string) => state.listed && provider === fresh.provider && id === fresh.id ? fresh : undefined,
    getAvailableSnapshot: () => state.listed ? [fresh] : [],
    hasConfiguredAuth: () => true,
  } as unknown as ModelRuntime;
  return { home, state, models: new PiModels(catalog, agent, home) };
}
const start = (models: PiModels, home: string) => models.create(home, { buildSessionContext: () => ({}) } as unknown as SessionManager,
  async (options) => ({ session: {} as AgentSession, options }));

test("a start whose saved model only OpenRouter's list has yet waits for the session's first read of it", async () => {
  const { home, state, models } = await piModels({ defaultProvider: "openrouter", defaultModel: "vendor-d/new-model" });
  models.useOpenRouterModels({ ready: Bun.sleep(30).then(() => { state.listed = true; }), refresh: async () => {} });
  expect((await start(models, home)).options.model?.id).toBe("vendor-d/new-model");
});

test("a missing model from another provider never waits for OpenRouter's list", async () => {
  const { home, models } = await piModels({ defaultProvider: "vendor-z", defaultModel: "gone" });
  models.useOpenRouterModels({ ready: new Promise(() => {}), refresh: async () => {} });
  expect((await start(models, home)).options.model).toBeUndefined();
});

test("/model openrouter/<id> for a model the catalog doesn't have reads OpenRouter's list again before saying so; other ids don't", async () => {
  const { models } = await piModels();
  let read = 0;
  models.useOpenRouterModels({ ready: Promise.resolve(), refresh: async () => { read++; } });
  const idle = { isIdle: true } as unknown as AgentSession;
  await expect(models.select(idle, { query: "openrouter/vendor-d/brand-new" })).rejects.toThrow();
  expect(read).toBe(1);
  await expect(models.select(idle, { query: "vendor-z/other" })).rejects.toThrow();
  expect(read).toBe(1);
});
