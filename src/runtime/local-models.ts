import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Model servers on this computer that Casper finds by itself, so their models show in /model with no models.json.
 * Each is probed at its usual loopback address, or where its variable points. A server that does not answer is
 * skipped without a word unless its variable is set. A provider of the same name in your models.json, or one of
 * your providers at the same address, wins: the found one is not added. */
export interface LocalServerKind {
  /** The provider name: the first half of the model name (ollama/qwen3:8b). */
  id: "ollama" | "lm-studio" | "llama.cpp" | "vllm";
  name: string;
  /** Variables that move it, first set wins. */
  variables: readonly string[];
  /** The server's root address (no /v1). */
  root: string;
  defaultPort: number;
}

export const LOCAL_SERVERS: readonly LocalServerKind[] = [
  { id: "ollama", name: "Ollama", variables: ["OLLAMA_BASE_URL", "OLLAMA_HOST"], root: "http://127.0.0.1:11434", defaultPort: 11434 },
  { id: "lm-studio", name: "LM Studio", variables: ["LM_STUDIO_BASE_URL"], root: "http://127.0.0.1:1234", defaultPort: 1234 },
  { id: "llama.cpp", name: "llama.cpp", variables: ["LLAMA_CPP_BASE_URL", "LLAMA_BASE_URL"], root: "http://127.0.0.1:8080", defaultPort: 8080 },
  { id: "vllm", name: "vLLM", variables: ["VLLM_BASE_URL"], root: "http://127.0.0.1:8000", defaultPort: 8000 },
];

export interface LocalModel { id: string; contextWindow?: number; images?: boolean }
export interface LocalServer { provider: LocalServerKind["id"]; name: string; /** OpenAI-style address, ends in /v1. */ baseUrl: string; models: LocalModel[] }
export interface LocalDiscovery { servers: LocalServer[]; /** One plain line per server whose variable is set but did not answer. */ problems: string[] }
export interface DiscoverOptions { env?: Record<string, string | undefined>; timeoutMs?: number; signal?: AbortSignal; fetch?: typeof fetch }

/** Pi's own default for a model whose window is not known (models.json without contextWindow). */
const UNKNOWN_WINDOW = 128_000;
const EMBEDDING = /embed|rerank|(^|[-_/:.])bge([-_/:.]|$)/i;

/** A variable's address as a root URL: a bare host[:port] gets http:// and, without a port, the server's own (as
 * Ollama reads OLLAMA_HOST); 0.0.0.0 (listen on all) is reached on 127.0.0.1; a trailing /v1 or / is dropped.
 * Undefined when unusable. */
export function serverRoot(raw: string, defaultPort: number): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  let url: URL;
  try { url = new URL(bare ? `http://${value}` : value); } catch { return undefined; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (url.hostname === "[::]") url.hostname = "[::1]";
  if (bare && !url.port) url.port = String(defaultPort);
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

/** The same server written two ways (localhost or 127.0.0.1, with or without /v1) compares equal. */
export function sameAddress(a: string, b: string): boolean {
  const key = (value: string) => value.trim().toLowerCase().replace(/\/+$/, "").replace(/\/v1$/, "")
    .replace("://localhost", "://127.0.0.1").replace("://[::1]", "://127.0.0.1");
  return key(a) === key(b);
}

function positive(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0 ? number : undefined;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() && !/[\u0000-\u001f]/.test(value) ? value : undefined;

/** One GET or POST that must answer JSON. No headers but content-type: no key of any provider is sent. */
async function getJson(fetcher: typeof fetch, url: string, signal: AbortSignal, body?: unknown): Promise<Json | undefined> {
  const response = await fetcher(url, { signal, redirect: "error",
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return record(await response.json());
}

/** Ollama: /api/tags lists the models, /api/show tells each one's abilities and a num_ctx set in its Modelfile.
 * The window, as Ollama picks it: a loaded model's own (/api/ps), else its Modelfile num_ctx, else OLLAMA_CONTEXT_LENGTH
 * (the server's default for every model; Casper's environment may not be the server's, so it comes last). */
async function ollama(fetcher: typeof fetch, root: string, signal: AbortSignal, env: DiscoverOptions["env"]): Promise<LocalModel[]> {
  const tags = await getJson(fetcher, `${root}/api/tags`, signal);
  if (!tags || !Array.isArray(tags.models)) throw new Error("is not Ollama");
  const serverWindow = positive(env?.OLLAMA_CONTEXT_LENGTH);
  const loaded = new Map<string, number>();
  await getJson(fetcher, `${root}/api/ps`, signal).then((ps) => {
    for (const entry of list(ps?.models)) {
      const model = record(entry); const name = text(model?.name); const window = positive(model?.context_length);
      if (name && window) loaded.set(name, window);
    }
  }, () => undefined);
  const models = await Promise.all(tags.models.map(async (entry): Promise<LocalModel | undefined> => {
    const tag = record(entry); const id = text(tag?.name) ?? text(tag?.model);
    if (!tag || !id) return undefined;
    const show = await getJson(fetcher, `${root}/api/show`, signal, { model: id }).catch(() => undefined);
    const known = [tag.capabilities, show?.capabilities].filter(Array.isArray) as unknown[][];
    const capabilities = known.length ? known.flat() : undefined;
    const family = text(record(tag.details)?.family) ?? "";
    if (capabilities ? !capabilities.includes("completion") : EMBEDDING.test(id) || /bert/i.test(family)) return undefined;
    const numCtx = positive(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(typeof show?.parameters === "string" ? show.parameters : "")?.[1]);
    const info = record(show?.model_info);
    const trained = positive(record(tag.details)?.context_length)
      ?? positive(Object.entries(info ?? {}).find(([key]) => key.endsWith(".context_length"))?.[1]);
    const window = loaded.get(id) ?? numCtx ?? serverWindow;
    return { id, ...(window ? { contextWindow: trained ? Math.min(window, trained) : window } : trained ? { contextWindow: Math.min(trained, UNKNOWN_WINDOW) } : {}),
      ...(capabilities?.includes("vision") ? { images: true } : {}) };
  }));
  return models.filter((model) => model !== undefined);
}

/** An OpenAI-style /v1/models list; `window` reads a model's served window where the server gives one. */
async function openAiModels(fetcher: typeof fetch, root: string, signal: AbortSignal, window: (model: Json) => number | undefined = () => undefined): Promise<LocalModel[]> {
  const listed = await getJson(fetcher, `${root}/v1/models`, signal);
  if (!listed || !Array.isArray(listed.data)) throw new Error("is not an OpenAI-style server");
  return listed.data.flatMap((entry) => {
    const model = record(entry); const id = text(model?.id);
    if (!model || !id || EMBEDDING.test(id)) return [];
    const contextWindow = window(model);
    return [{ id, ...(contextWindow ? { contextWindow } : {}) }];
  });
}

/** LM Studio: its own /api/v0/models says each model's type (llm, vlm, embeddings) and the window of a loaded one. */
async function lmStudio(fetcher: typeof fetch, root: string, signal: AbortSignal): Promise<LocalModel[]> {
  const native = await getJson(fetcher, `${root}/api/v0/models`, signal).catch(() => undefined);
  if (!native || !Array.isArray(native.data)) return openAiModels(fetcher, root, signal);
  return native.data.flatMap((entry) => {
    const model = record(entry); const id = text(model?.id);
    if (!model || !id || model.type === "embeddings" || (model.type === undefined && EMBEDDING.test(id))) return [];
    const contextWindow = positive(model.loaded_context_length);
    return [{ id, ...(contextWindow ? { contextWindow } : {}), ...(model.type === "vlm" ? { images: true } : {}) }];
  });
}

/** llama.cpp: /v1/models for the ids, /props for the window the server was started with (-c) and vision. */
async function llamaCpp(fetcher: typeof fetch, root: string, signal: AbortSignal): Promise<LocalModel[]> {
  const [models, props] = await Promise.all([openAiModels(fetcher, root, signal), getJson(fetcher, `${root}/props`, signal).catch(() => undefined)]);
  const contextWindow = positive(record(props?.default_generation_settings)?.n_ctx) ?? positive(props?.n_ctx);
  const images = record(props?.modalities)?.vision === true;
  return models.map((model) => ({ ...model, ...(contextWindow ? { contextWindow } : {}), ...(images ? { images: true } : {}) }));
}

/** Probes the four servers at once. Each gets `timeoutMs` in all (a closed port answers at once on macOS and Linux,
 * after seconds on Windows: the runtime never waits for this at its start). */
export async function discoverLocalServers(options: DiscoverOptions = {}): Promise<LocalDiscovery> {
  const env = options.env ?? process.env;
  // CASPER_LOCAL_MODELS=off (a script, CI, the test suite's spawned Casper): no probe at all, like localModels: false.
  if (/^(?:off|0|false|no)$/i.test(env.CASPER_LOCAL_MODELS?.trim() ?? "")) return { servers: [], problems: [] };
  const fetcher = options.fetch ?? fetch;
  const found = await Promise.all(LOCAL_SERVERS.map(async (kind) => {
    const variable = kind.variables.find((name) => env[name]?.trim());
    const root = variable ? serverRoot(env[variable]!, kind.defaultPort) : kind.root;
    if (!root) return { problem: `${variable} is set to an address Casper can't use; ${kind.name} models are not in /model.` };
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 800), ...(options.signal ? [options.signal] : [])]);
    try {
      const models = kind.id === "ollama" ? await ollama(fetcher, root, signal, env)
        : kind.id === "lm-studio" ? await lmStudio(fetcher, root, signal)
        : kind.id === "llama.cpp" ? await llamaCpp(fetcher, root, signal)
        : await openAiModels(fetcher, root, signal, (model) => positive(model.max_model_len));
      return { server: { provider: kind.id, name: kind.name, baseUrl: `${root}/v1`, models } satisfies LocalServer };
    } catch {
      return variable && !options.signal?.aborted ? { problem: `${variable} is set (${root}) but no ${kind.name} answered there; its models are not in /model.` } : {};
    }
  }));
  return { servers: found.flatMap((entry) => "server" in entry && entry.server ? [entry.server] : []),
    problems: found.flatMap((entry) => "problem" in entry && entry.problem ? [entry.problem] : []) };
}

/** What the runtime calls: tests replace it (tests/support/preload.ts) so no test reaches a real server. */
export const localModelDefaults = { discover: discoverLocalServers, ttlMs: 24 * 60 * 60 * 1000 };

let cached: { at: number; result: Promise<LocalDiscovery> } | undefined;

/** The servers found in this process, probed again after a day or when `refresh` is set (the /model picker).
 * `cachedOnly` (a helper's runtime) never probes: it gets what the main session found, or nothing. */
export function localServers(options: { refresh?: boolean; cachedOnly?: boolean; signal?: AbortSignal } = {}): Promise<LocalDiscovery> {
  const none: LocalDiscovery = { servers: [], problems: [] };
  if (options.cachedOnly) return cached?.result ?? Promise.resolve(none);
  if (!options.refresh && cached && Date.now() - cached.at < localModelDefaults.ttlMs) return cached.result;
  const result = localModelDefaults.discover({ signal: options.signal }).catch(() => none);
  // A refresh that finds nothing keeps the last list: a server busy for a moment does not empty /model.
  const previous = cached?.result;
  const kept = previous && options.refresh ? result.then(async (fresh) => fresh.servers.length ? fresh : { ...(await previous), problems: fresh.problems }) : result;
  cached = { at: Date.now(), result: kept };
  return kept;
}

/** Forget what was found (tests). */
export function clearLocalServers(): void { cached = undefined; }

type Catalog = Pick<ModelRuntime, "getProvider" | "getModels" | "getRegisteredProviderConfig" | "registerProvider">;

/** Adds each found server as a keyless provider. Its key is the literal word "local", sent only to that server:
 * Pi resolves keys per provider, and none of these names reads a key variable. Skipped: a name your models.json
 * (or Pi) already has, and a server one of your own providers already points at. Returns the names added. */
export function registerLocalServers(catalog: Catalog, servers: readonly LocalServer[]): string[] {
  const added: string[] = [];
  for (const server of servers) {
    const ours = catalog.getRegisteredProviderConfig(server.provider)?.apiKey === "local";
    if (!ours && catalog.getProvider(server.provider)) continue;
    if (catalog.getModels().some((model) => model.provider !== server.provider && !LOCAL_SERVERS.some((kind) => kind.id === model.provider)
      && typeof model.baseUrl === "string" && sameAddress(model.baseUrl, server.baseUrl))) continue;
    if (!server.models.length && !ours) continue;
    try {
      catalog.registerProvider(server.provider, { name: server.name, baseUrl: server.baseUrl, api: "openai-completions", apiKey: "local",
        models: server.models.map((model) => {
          const contextWindow = model.contextWindow ?? UNKNOWN_WINDOW;
          return { id: model.id, name: model.id, reasoning: false, input: model.images ? ["text", "image"] : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow,
            maxTokens: Math.min(16_384, Math.max(1_024, Math.floor(contextWindow / 4))),
            // Most local servers know neither the developer role nor reasoning_effort (docs/CONFIGURATION.md, Local models).
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } };
        }) });
      added.push(server.provider);
    } catch { /* A clash Pi refuses leaves your own setup as it is. */ }
  }
  return added;
}
