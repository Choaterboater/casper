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
const OPENROUTER_API = "https://openrouter.ai/api/v1";
/** The request settings most OpenRouter models have in the engine's list: a model it doesn't list yet gets them. */
const OPENROUTER_COMPAT = { thinkingFormat: "openrouter", supportsStrictMode: true, sendSessionAffinityHeaders: true, supportsDeveloperRole: false } as const;

export const openRouterModelDefaults: { fetch: (url: string, init?: RequestInit) => Promise<Response>; everyMs: number; freshMs: number; timeoutMs: number } = {
  fetch: (url, init) => fetch(url, init),
  /** How often a signed-in session reads the list again. */
  everyMs: 5 * 60_000,
  /** OpenRouter's CDN keeps the list two minutes: reading it sooner gets the same list. */
  freshMs: 2 * 60_000,
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

/** Tests only: forget the list this process read, and what it said about its models. */
export function forgetOpenRouterModels(): void { latest = undefined; reading = undefined; forgetModelFacts("openrouter"); }

/** What Casper takes from the list (the catalog's fields, and the facts /model shows): a read with the same signature is
 * the same list (nothing to lay on again). */
const signatureOf = (models: readonly OpenRouterModel[]) => JSON.stringify(models.map((model) => [model.id, model.name, model.context_length,
  model.pricing?.prompt, model.pricing?.completion, model.pricing?.input_cache_read, model.pricing?.input_cache_write,
  model.architecture?.input_modalities, model.architecture?.output_modalities, model.supported_parameters,
  model.top_provider?.context_length, model.top_provider?.max_completion_tokens, model.expiration_date, openRouterModelFacts(model)]));

/** Reads OpenRouter's list, or returns the one read under `freshMs` ago. Throws when it can't be read. A new list also
 * replaces what is known about OpenRouter's models (src/runtime/model-facts.ts): the same read, no second request. */
function readList(seams: { fetch: typeof openRouterModelDefaults.fetch; freshMs: number }, signal: AbortSignal): Promise<OpenRouterModel[]> {
  if (latest && Date.now() - latest.at < seams.freshMs) return Promise.resolve(latest.models);
  reading ??= (async () => {
    try {
      // A plain request: no key, no app name (the list is public).
      const response = await seams.fetch(OPENROUTER_MODELS_URL, {
        headers: { accept: "application/json" }, redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(openRouterModelDefaults.timeoutMs)]),
      });
      if (!response.ok) throw new Error(`OpenRouter's model list answered HTTP ${response.status}.`);
      const models = parseOpenRouterModels(await response.json());
      const signature = signatureOf(models);
      const same = latest?.signature === signature;
      latest = { at: Date.now(), models: same ? latest!.models : models, signature };
      if (!same) setModelFacts("openrouter", new Map(models.map((model) => [model.id, openRouterModelFacts(model)])));
      return latest.models;
    } finally { reading = undefined; }
  })();
  return reading;
}

export interface OpenRouterModels {
  /** Settles once the session's first read has ended, laid on or not. Never rejects. */
  ready: Promise<void>;
  /** Reads the list again (unless it is under two minutes old) and lays it over the engine's list as it is now, as
   * /model does when it opens. Never rejects. */
  refresh(signal?: AbortSignal): Promise<void>;
}

export interface OpenRouterModelOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof openRouterModelDefaults.fetch;
  everyMs?: number;
  freshMs?: number;
}

/** The main session's reads of OpenRouter's list, from now until `lifetime` ends. Each read is skipped without an
 * OpenRouter sign-in, offline (CASPER_OFFLINE=1, or the engine's PI_OFFLINE), and once the session ended. */
export function startOpenRouterModels(catalog: Catalog & Pick<ModelRuntime, "hasConfiguredAuth">, lifetime: AbortSignal,
  options: OpenRouterModelOptions = {}): OpenRouterModels {
  const env = options.env ?? process.env;
  const seams = { fetch: options.fetch ?? openRouterModelDefaults.fetch, freshMs: options.freshMs ?? openRouterModelDefaults.freshMs };
  const update = async (signal: AbortSignal, again: boolean): Promise<void> => {
    try {
      if (lifetime.aborted || env.CASPER_OFFLINE === "1" || env.PI_OFFLINE !== undefined || !catalog.hasConfiguredAuth("openrouter")) return;
      // A read that fails keeps what is listed; /model still lays the last list over the engine's newest.
      const models = await readList(seams, signal).catch(() => again ? latest?.models : undefined);
      if (!models || lifetime.aborted) return;
      if (again || laid.get(catalog)?.from !== models) applyOpenRouterModels(catalog, models);
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
