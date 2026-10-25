/**
 * OpenRouter's own model list (https://openrouter.ai/api/v1/models), laid over the engine's OpenRouter models. The
 * engine's list is its copy of pi.dev's, which can trail OpenRouter by days; OpenRouter adds models every day.
 *
 * The main session reads the list as it starts, every few minutes after and when /model opens, only while you are
 * signed in to OpenRouter and never offline (CASPER_OFFLINE=1). The list is public: the request carries no key and
 * no attribution. A model the engine lists keeps its request settings (API and address, thinking levels, longest
 * answer, price tiers) and takes OpenRouter's newer name, window, prices and picture input. One it doesn't list yet is
 * added with OpenRouter's usual settings when it can call tools; the engine's other models stay. A read that fails
 * keeps what is listed. Decision: docs/adr/0002/36-openrouter-models-live.md.
 *
 * The engine lets Casper own a provider's model list (ModelRuntime.registerProvider with `models`), which replaces the
 * engine's own. So each update takes Casper's list off, reads the engine's list as it is now, and lays the new one on.
 *
 * The same read also says what the catalog has no field for (when OpenRouter added each model, its scores):
 * src/runtime/model-facts.ts keeps it, and /model shows and sorts by it.
 */
import type { ModelRuntime, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AnyModel } from "@earendil-works/pi-ai";
import { forgetModelFacts, setModelFacts, type ModelFacts } from "./model-facts";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/** OpenRouter's public list of the hosts that keep nothing of a request (zero data retention), one entry per host. */
export const OPENROUTER_ZDR_URL = "https://openrouter.ai/api/v1/endpoints/zdr";
const OPENROUTER_API = "https://openrouter.ai/api/v1";
/** The request settings most OpenRouter models have in the engine's list: a model it doesn't list yet gets them. */
const OPENROUTER_COMPAT = { thinkingFormat: "openrouter", supportsStrictMode: true, sendSessionAffinityHeaders: true, supportsDeveloperRole: false } as const;

export const openRouterModelDefaults: { fetch: (url: string, init?: RequestInit) => Promise<Response>; everyMs: number; freshMs: number; zeroRetentionFreshMs: number; timeoutMs: number } = {
  fetch: (url, init) => fetch(url, init),
  /** How often a signed-in session reads the list again. */
  everyMs: 5 * 60_000,
  /** OpenRouter's CDN keeps the list two minutes: reading it sooner gets the same list. */
  freshMs: 2 * 60_000,
  /** The zero-data-retention list changes seldom and isn't cached by OpenRouter's CDN: read at most this often. */
  zeroRetentionFreshMs: 30 * 60_000,
  timeoutMs: 10_000,
};

/** What Casper reads of one model in OpenRouter's list. Prices are US dollars per token, as text. */
export interface OpenRouterModel {
  id: string;
  name?: string;
  /** When OpenRouter listed it, in seconds since 1970. */
  created?: number | null;
  context_length?: number | null;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
  expiration_date?: string | null;
  /** Scores OpenRouter shows with the model: Artificial Analysis' indexes and Design Arena's boards. */
  benchmarks?: {
    artificial_analysis?: { intelligence_index?: number | null; coding_index?: number | null; agentic_index?: number | null } | null;
    design_arena?: Array<{ arena?: string; category?: string; rank?: number | null; elo?: number; win_rate?: number }> | null;
  } | null;
}

type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;
type Catalog = Pick<ModelRuntime, "getAllModels" | "getRegisteredProviderConfig" | "registerProvider" | "unregisterProvider">;

/** The models in OpenRouter's answer. Throws when it isn't the list, so the caller keeps what is listed. */
export function parseOpenRouterModels(body: unknown): OpenRouterModel[] {
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new Error("OpenRouter's model list is not in the expected form.");
  const models = data.filter((entry): entry is OpenRouterModel => typeof entry === "object" && entry !== null
    && typeof (entry as { id?: unknown }).id === "string" && /^[\x21-\x7e]+$/.test((entry as { id: string }).id));
  if (!models.length) throw new Error("OpenRouter's model list is empty.");
  return models;
}

/** Each model's hosts in OpenRouter's zero-data-retention list, once each, in plain text (a host's name is shown on
 * screen). Throws when the answer names none, so no model is ever marked from an empty or broken list. */
export function parseZeroRetentionHosts(body: unknown): Map<string, string[]> {
  const data = typeof body === "object" && body !== null ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new Error("OpenRouter's zero-data-retention list is not in the expected form.");
  const hosts = new Map<string, string[]>();
  for (const entry of data) {
    const { model_id: id, provider_name: name } = (typeof entry === "object" && entry !== null ? entry : {}) as { model_id?: unknown; provider_name?: unknown };
    if (typeof id !== "string" || !/^[\x21-\x7e]+$/.test(id) || typeof name !== "string") continue;
    const host = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 40);
    if (!host) continue;
    const named = hosts.get(id) ?? [];
    if (!named.includes(host)) hosts.set(id, [...named, host]);
  }
  if (!hosts.size) throw new Error("OpenRouter's zero-data-retention list is empty.");
  return hosts;
}

/** Per million tokens, as the catalog has prices. A router's "-1" (the price of whichever model it picks) is none. */
function perMillion(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? Math.round(price * 1e12) / 1e6 : undefined;
}
const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
/** The window OpenRouter's usual host serves, as the engine's list has it; the model's largest only without one. */
const windowOf = (model: OpenRouterModel) => count(model.top_provider?.context_length) ?? count(model.context_length);
const nameOf = (model: OpenRouterModel) => typeof model.name === "string" ? model.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() : "";
const free = (model: OpenRouterModel) => model.id.endsWith(":free");
/** Whether the model takes pictures; unknown when the list doesn't say. */
function pictures(model: OpenRouterModel): boolean | undefined {
  const input = model.architecture?.input_modalities;
  return Array.isArray(input) ? input.includes("image") : undefined;
}
/** Past its end date: OpenRouter lists a model it is retiring until the end of its last day. */
function ended(model: OpenRouterModel, now: number): boolean {
  const last = typeof model.expiration_date === "string" ? Date.parse(model.expiration_date) : Number.NaN;
  return Number.isFinite(last) && now >= last + 24 * 60 * 60_000;
}

const score = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** What OpenRouter's list says about a model beyond the catalog's fields (src/runtime/model-facts.ts). Only what the
 * list says: a price it doesn't fix (a router's), a date or a score it doesn't give is left out, never 0. */
export function openRouterModelFacts(model: OpenRouterModel): ModelFacts {
  const input = perMillion(model.pricing?.prompt);
  const output = perMillion(model.pricing?.completion);
  const price = free(model) ? { input: 0, output: 0 } : input !== undefined && output !== undefined ? { input, output } : undefined;
  const contextWindow = windowOf(model);
  const created = count(model.created);
  const aa = model.benchmarks?.artificial_analysis;
  const board = Array.isArray(model.benchmarks?.design_arena) ? model.benchmarks.design_arena : [];
  const codingRank = count(board.find((entry) => entry?.category === "codecategories" && (entry.arena ?? "models") === "models")?.rank);
  const scores = { intelligence: score(aa?.intelligence_index), coding: score(aa?.coding_index), agentic: score(aa?.agentic_index), codingRank };
  return {
    free: free(model) || (price !== undefined && price.input === 0 && price.output === 0),
    ...price ? { price } : {},
    ...contextWindow ? { contextWindow } : {},
    ...created ? { created: created * 1000 } : {},
    tools: Array.isArray(model.supported_parameters) && model.supported_parameters.includes("tools"),
    ...Object.fromEntries(Object.entries(scores).filter(([, value]) => value !== undefined)),
  };
}

/** A model the engine doesn't list yet, through OpenRouter's OpenAI-style endpoint. None for one Casper can't work
 * with: no tool calls, no text answer, past its end date, no window, or no fixed price (a router). */
export function openRouterChatModel(model: OpenRouterModel, now = Date.now()): ChatModelConfig | undefined {
  const parameters = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
  const output = model.architecture?.output_modalities;
  if (!parameters.includes("tools") || (Array.isArray(output) && !output.includes("text")) || ended(model, now)) return undefined;
  const contextWindow = windowOf(model);
  const input = perMillion(model.pricing?.prompt);
  const answer = perMillion(model.pricing?.completion);
  if (!contextWindow || (!free(model) && (input === undefined || answer === undefined))) return undefined;
  const reasoning = parameters.includes("reasoning") || parameters.includes("include_reasoning");
  return {
    id: model.id,
    name: nameOf(model) || model.id,
    api: "openai-completions",
    baseUrl: OPENROUTER_API,
    reasoning,
    // The list doesn't say whether thinking can be turned off, and some models refuse "off": until the engine's list
    // says, a thinking model isn't offered it (the engine then sends no reasoning switch at all).
    ...(reasoning ? { thinkingLevelMap: { off: null } } : {}),
    input: pictures(model) ? ["text", "image"] : ["text"],
    cost: free(model) || input === undefined || answer === undefined ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      : { input, output: answer, cacheRead: perMillion(model.pricing?.input_cache_read) ?? 0, cacheWrite: perMillion(model.pricing?.input_cache_write) ?? 0 },
    contextWindow,
    maxTokens: Math.min(count(model.top_provider?.max_completion_tokens) ?? 16_384, contextWindow),
    compat: { ...OPENROUTER_COMPAT },
  };
}

const PRICES = [["input", "prompt"], ["output", "completion"], ["cacheRead", "input_cache_read"], ["cacheWrite", "input_cache_write"]] as const;

/** A model the engine lists, with OpenRouter's newer name, window, prices and picture input. */
function freshened(model: AnyModel, live: OpenRouterModel): AnyModel {
  const cost = { ...model.cost };
  for (const [field, key] of PRICES) {
    const price = free(live) ? 0 : perMillion(live.pricing?.[key]);
    if (price !== undefined) cost[field] = price;
  }
  const image = pictures(live);
  return {
    ...model,
    name: nameOf(live) || model.name,
    ...("contextWindow" in model ? { contextWindow: windowOf(live) ?? model.contextWindow } : {}),
    cost,
    ...(image === undefined ? {} : { input: image ? [...new Set([...model.input, "image" as const])] : model.input.filter((kind) => kind !== "image") }),
  } as AnyModel;
}

const isChat = (model: AnyModel) => ((model as { type?: string }).type ?? "chat") === "chat";

/** The engine's OpenRouter models with OpenRouter's list laid over: its chat models freshened, its others (pictures)
 * as they are, then the chat models only OpenRouter lists. */
export function mergeOpenRouterModels(listed: readonly AnyModel[], live: readonly OpenRouterModel[], now = Date.now()): ProviderModelConfig[] {
  const byId = new Map(live.map((model) => [model.id, model]));
  const known = new Set<string>();
  const merged = listed.map((model) => {
    if (!isChat(model)) return model;
    known.add(model.id);
    const fresh = byId.get(model.id);
    return fresh ? freshened(model, fresh) : model;
  }) as ProviderModelConfig[];
  for (const model of byId.values()) {
    if (known.has(model.id)) continue;
    const added = openRouterChatModel(model, now);
    if (added) merged.push(added);
  }
  return merged;
}

/** The list Casper laid on each catalog, and the read it came from: only that list is Casper's to take off. */
const laid = new WeakMap<object, { models: ProviderModelConfig[]; from: readonly OpenRouterModel[] }>();

/** Lays OpenRouter's list over the catalog's OpenRouter models, taking Casper's earlier list off first so the engine's
 * list as it is now (a newer pi.dev copy) shows through. False, and nothing changed, when another layer (an engine
 * extension) owns OpenRouter's models; false with the engine's own list when the engine refuses the new one. */
export function applyOpenRouterModels(catalog: Catalog, live: readonly OpenRouterModel[], now = Date.now()): boolean {
  const registered = catalog.getRegisteredProviderConfig("openrouter");
  const ours = laid.get(catalog);
  if (registered && !(ours && registered.models === ours.models && Object.keys(registered).every((key) => key === "models"))) return false;
  if (registered) catalog.unregisterProvider("openrouter");
  laid.delete(catalog);
  const models = mergeOpenRouterModels(catalog.getAllModels("openrouter"), live, now);
  try { catalog.registerProvider("openrouter", { models }); }
  catch { return false; }
  laid.set(catalog, { models, from: live });
  return true;
}

/** The newest list this process read (a helper takes it), what in it Casper uses, and when. */
let latest: { at: number; models: OpenRouterModel[]; signature: string } | undefined;
let reading: Promise<OpenRouterModel[]> | undefined;
/** The newest zero-data-retention list this process read: each model's hosts that keep nothing. */
let latestZeroRetention: { at: number; hosts: Map<string, string[]>; signature: string } | undefined;
let readingZeroRetention: Promise<void> | undefined;

/** Tests only: forget the lists this process read, and what they said about OpenRouter's models. */
export function forgetOpenRouterModels(): void {
  latest = undefined; reading = undefined; latestZeroRetention = undefined; readingZeroRetention = undefined;
  forgetModelFacts("openrouter");
}

/** What Casper takes from the list (the catalog's fields, and the facts /model shows): a read with the same signature is
 * the same list (nothing to lay on again). */
const signatureOf = (models: readonly OpenRouterModel[]) => JSON.stringify(models.map((model) => [model.id, model.name, model.context_length,
  model.pricing?.prompt, model.pricing?.completion, model.pricing?.input_cache_read, model.pricing?.input_cache_write,
  model.architecture?.input_modalities, model.architecture?.output_modalities, model.supported_parameters,
  model.top_provider?.context_length, model.top_provider?.max_completion_tokens, model.expiration_date, openRouterModelFacts(model)]));

/** What is known about OpenRouter's models (src/runtime/model-facts.ts), from the newest reads of both lists: a model the
 * zero-data-retention list doesn't name has no such host; before that list was read, nobody knows. */
function publishFacts(): void {
  if (!latest) return;
  const hosts = latestZeroRetention?.hosts;
  setModelFacts("openrouter", new Map(latest.models.map((model) => [model.id,
    { ...openRouterModelFacts(model), ...hosts ? { privateHosts: hosts.get(model.id) ?? [] } : {} }])));
}

/** A plain request for one of OpenRouter's public lists: no key, no app name. */
async function readPublic(seams: { fetch: typeof openRouterModelDefaults.fetch }, url: string, signal: AbortSignal): Promise<unknown> {
  const response = await seams.fetch(url, {
    headers: { accept: "application/json" }, redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(openRouterModelDefaults.timeoutMs)]),
  });
  if (!response.ok) throw new Error(`OpenRouter answered HTTP ${response.status}.`);
  return response.json();
}

/** Reads OpenRouter's list, or returns the one read under `freshMs` ago. Throws when it can't be read. A new list also
 * replaces what is known about OpenRouter's models (src/runtime/model-facts.ts): the same read, no second request. */
function readList(seams: { fetch: typeof openRouterModelDefaults.fetch; freshMs: number }, signal: AbortSignal): Promise<OpenRouterModel[]> {
  if (latest && Date.now() - latest.at < seams.freshMs) return Promise.resolve(latest.models);
  reading ??= (async () => {
    try {
      const models = parseOpenRouterModels(await readPublic(seams, OPENROUTER_MODELS_URL, signal));
      const signature = signatureOf(models);
      const same = latest?.signature === signature;
      latest = { at: Date.now(), models: same ? latest!.models : models, signature };
      if (!same) publishFacts();
      return latest.models;
    } finally { reading = undefined; }
  })();
  return reading;
}

/** Reads the zero-data-retention list unless it is under `zeroRetentionFreshMs` old. Display only: what it says marks
 * models in /model and never changes where a request goes. Throws when it can't be read; the last list read stays. */
function readZeroRetention(seams: { fetch: typeof openRouterModelDefaults.fetch; zeroRetentionFreshMs: number }, signal: AbortSignal): Promise<void> {
  if (latestZeroRetention && Date.now() - latestZeroRetention.at < seams.zeroRetentionFreshMs) return Promise.resolve();
  readingZeroRetention ??= (async () => {
    try {
      const hosts = parseZeroRetentionHosts(await readPublic(seams, OPENROUTER_ZDR_URL, signal));
      const signature = JSON.stringify([...hosts].sort(([a], [b]) => a.localeCompare(b)));
      const same = latestZeroRetention?.signature === signature;
      latestZeroRetention = { at: Date.now(), hosts: same ? latestZeroRetention!.hosts : hosts, signature };
      if (!same) publishFacts();
    } finally { readingZeroRetention = undefined; }
  })();
  return readingZeroRetention;
}

export interface OpenRouterModels {
  /** Settles once the session's first read of the model list has ended, laid on or not. Never rejects. */
  ready: Promise<void>;
  /** Reads the list again (unless it is under two minutes old) and lays it over the engine's list as it is now, as
   * /model does when it opens, with the zero-data-retention list when that is due. Never rejects. */
  refresh(signal?: AbortSignal): Promise<void>;
}

export interface OpenRouterModelOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof openRouterModelDefaults.fetch;
  everyMs?: number;
  freshMs?: number;
  zeroRetentionFreshMs?: number;
}

/** The main session's reads of OpenRouter's lists, from now until `lifetime` ends. Each read is skipped without an
 * OpenRouter sign-in, offline (CASPER_OFFLINE=1, or the engine's PI_OFFLINE), and once the session ended. */
export function startOpenRouterModels(catalog: Catalog & Pick<ModelRuntime, "hasConfiguredAuth">, lifetime: AbortSignal,
  options: OpenRouterModelOptions = {}): OpenRouterModels {
  const env = options.env ?? process.env;
  const seams = { fetch: options.fetch ?? openRouterModelDefaults.fetch, freshMs: options.freshMs ?? openRouterModelDefaults.freshMs,
    zeroRetentionFreshMs: options.zeroRetentionFreshMs ?? openRouterModelDefaults.zeroRetentionFreshMs };
  const update = async (signal: AbortSignal, again: boolean): Promise<void> => {
    try {
      if (lifetime.aborted || env.CASPER_OFFLINE === "1" || env.PI_OFFLINE !== undefined || !catalog.hasConfiguredAuth("openrouter")) return;
      const listing = readList(seams, signal);
      // Beside the model list, never ahead of it: a start that waits for a model doesn't wait for this.
      const privacy = readZeroRetention(seams, signal).catch(() => undefined);
      // A read that fails keeps what is listed; /model still lays the last list over the engine's newest.
      const models = await listing.catch(() => again ? latest?.models : undefined);
      if (models && !lifetime.aborted && (again || laid.get(catalog)?.from !== models)) applyOpenRouterModels(catalog, models);
      // /model reloads its rows after this: the marks it shows are from this read too.
      if (again) await privacy;
    } catch { /* the models listed stay */ }
  };
  const ready = update(lifetime, false);
  const timer = setInterval(() => void update(lifetime, false), options.everyMs ?? openRouterModelDefaults.everyMs);
  (timer as { unref?: () => void }).unref?.();
  lifetime.addEventListener("abort", () => clearInterval(timer), { once: true });
  return { ready, refresh: (signal) => update(signal ? AbortSignal.any([signal, lifetime]) : lifetime, true) };
}

/** A helper's catalog takes the list the main session read; a helper never reads it itself. */
export function applyLatestOpenRouterModels(catalog: Catalog): void {
  if (!latest) return;
  try { applyOpenRouterModels(catalog, latest.models); } catch { /* the engine's list stays */ }
}
