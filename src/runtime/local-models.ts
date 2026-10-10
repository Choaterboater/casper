import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/** Model servers on this computer that Casper finds by itself, so their models show in /model with no models.json.
 * Each is probed at its usual loopback address, or where its variable points (which may be another computer). A
 * server that does not answer is skipped without a word unless its variable is set; then Casper says why, in plain
 * words. A provider of the same name in your models.json, or one of your providers at the same address, wins: the
 * found one is not added. */
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
/** Why a server Casper was told about is not in /model. */
export type LocalCause = "address" | "timeout" | "refused" | "key" | "name" | "other" | "redirect" | "certificate" | "http" | "unknown";
export interface LocalProblem {
  provider: string;
  /** Where it was looked for (no /v1), when the address could be read. */
  root?: string;
  cause: LocalCause;
  /** One plain sentence: "Ollama at http://192.0.2.10:11434 (OLLAMA_HOST) refused the connection." */
  text: string;
}
export interface LocalDiscovery { servers: LocalServer[]; /** One per server whose variable is set but that did not answer. */ problems: LocalProblem[] }
/** One server's look, as soon as it ends. */
export interface LocalFound { provider: string; server?: LocalServer; problem?: LocalProblem }
export interface DiscoverOptions {
  env?: Record<string, string | undefined>; timeoutMs?: number; signal?: AbortSignal; fetch?: typeof fetch;
  /** Called as each server's look ends, before the slowest one: a server on this computer is not held up by one far away. */
  each?: (found: LocalFound) => void;
}

/** Pi's own default for a model whose window is not known (models.json without contextWindow). */
const UNKNOWN_WINDOW = 128_000;
const EMBEDDING = /embed|rerank|(^|[-_/:.])bge([-_/:.]|$)/i;

/** A variable's address as a root URL: a bare host[:port] gets http:// and, without a port, the server's own (as
 * Ollama reads OLLAMA_HOST); 0.0.0.0 (listen on all) is reached on 127.0.0.1; a trailing /v1 or / is dropped.
 * Undefined when unusable. */
export function serverRoot(raw: string, defaultPort: number, ollama = false): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  let url: URL;
  try { url = new URL(bare ? `http://${value}` : value); } catch { return undefined; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (url.hostname === "[::]") url.hostname = "[::1]";
  if (bare && !url.port) url.port = String(defaultPort);
  // A copied address may end in the API path (…/v1, or Ollama's own …/api): the root is what comes before it.
  const pathname = url.pathname.replace(/\/+$/, "").replace(ollama ? /\/(?:v1|api)$/ : /\/v1$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

/** Whether an address is this computer (localhost, 127.x, [::1]): those answer at once or not at all. */
export function onThisComputer(root: string): boolean {
  let host: string;
  try { host = new URL(root).hostname.toLowerCase(); } catch { return false; }
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** How long one server's look may take: 0.8 s on this computer, 10 s for another one (a LAN or Tailscale link can be
 * slow to open; omp waits as long). The start never waits for it. */
export function probeBudget(root: string): number {
  return onThisComputer(root) ? 800 : 10_000;
}

/** What to set on the other computer when its server doesn't answer: most listen on 127.0.0.1 only by default. */
export const SERVER_SIDE_TIP = "On that computer the server must listen on the network: Ollama OLLAMA_HOST=0.0.0.0 ollama serve · " +
  "LM Studio: turn on Serve on Local Network · llama.cpp llama-server --host 0.0.0.0 · vLLM --host 0.0.0.0 · then let this computer through its firewall. " +
  "These servers have no password by default: do it only on a network you trust (Tailscale is safer).";

/** Whether a problem is worth the server-side tip: another computer that didn't answer or turned Casper away. */
export function wantsServerTip(problem: Pick<LocalProblem, "root" | "cause">): boolean {
  return Boolean(problem.root && !onThisComputer(problem.root) && (problem.cause === "timeout" || problem.cause === "refused"));
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

/** The server answered with an HTTP error. */
class Answered extends Error { constructor(readonly status: number) { super(`answered ${status}`); } }
/** Something answered, but not the server looked for. */
class NotThisServer extends Error {}

/** One GET or POST that must answer JSON. No headers but content-type: no key of any provider is sent. */
async function getJson(fetcher: typeof fetch, url: string, signal: AbortSignal, body?: unknown): Promise<Json | undefined> {
  const response = await fetcher(url, { signal, redirect: "error",
    ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Answered(response.status);
  return record(await response.json().catch(() => { throw new NotThisServer(); }));
}

/** Why a look failed, from Bun's and Node's error shapes (pinned with real sockets in tests/local-models.test.ts). */
function causeOf(error: unknown, timedOut: boolean): { cause: LocalCause; status?: number } {
  if (timedOut) return { cause: "timeout" };
  if (error instanceof Answered) return error.status === 401 || error.status === 403 ? { cause: "key" }
    : error.status === 404 ? { cause: "other" } : { cause: "http", status: error.status };
  if (error instanceof NotThisServer) return { cause: "other" };
  const code = String((error as { code?: unknown } | undefined)?.code ?? "");
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:ConnectionRefused|ECONNREFUSED)$/.test(code) || /Unable to connect|ECONNREFUSED/i.test(message)) return { cause: "refused" };
  if (/^(?:ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL|DNSException)$/.test(code) || /getaddrinfo|ENOTFOUND/i.test(message)) return { cause: "name" };
  if (code === "UnexpectedRedirect" || /redirect/i.test(message)) return { cause: "redirect" };
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code) || /certificate/i.test(message)) return { cause: "certificate" };
  return { cause: "unknown" };
}

function seconds(ms: number): string {
  return ms < 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** The plain words for a failed look, after "<Server> at <address>". */
function causeWords(cause: LocalCause, kind: LocalServerKind, root: string, budget: number, status?: number): string {
  switch (cause) {
    case "timeout": return `didn't answer in ${seconds(budget)}`;
    case "refused": return "refused the connection (nothing is listening on that port)";
    case "key": return "asked for a key";
    case "name": { let host = root; try { host = new URL(root).hostname; } catch { /* the root as is */ } return `couldn't be found (no computer called ${host})`; }
    case "other": return `answered, but isn't ${kind.name}`;
    case "redirect": return "tried to send Casper to another address (not followed)";
    case "certificate": return "has a certificate this computer doesn't trust";
    case "http": return `answered with an error (HTTP ${status ?? "?"})`;
    default: return "didn't answer";
  }
}

/** Ollama: /api/tags lists the models, /api/show tells each one's abilities and a num_ctx set in its Modelfile.
 * The window, as Ollama picks it: a loaded model's own (/api/ps), else its Modelfile num_ctx, else OLLAMA_CONTEXT_LENGTH
 * (the server's default for every model; Casper's environment may not be the server's, so it comes last). */
async function ollama(fetcher: typeof fetch, root: string, signal: AbortSignal, env: DiscoverOptions["env"]): Promise<LocalModel[]> {
  const tags = await getJson(fetcher, `${root}/api/tags`, signal);
  if (!tags || !Array.isArray(tags.models)) throw new NotThisServer();
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
  if (!listed || !Array.isArray(listed.data)) throw new NotThisServer();
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

/** CASPER_LOCAL_MODELS=off (a script, CI, the test suite's spawned Casper): no probe at all, like localModels: false. */
function lookingOff(env: Record<string, string | undefined>): boolean {
  return /^(?:off|0|false|no)$/i.test(env.CASPER_LOCAL_MODELS?.trim() ?? "");
}

/** One server kind's look: at its variable's address when set, else its usual one on this computer. */
async function lookAt(kind: LocalServerKind, env: Record<string, string | undefined>, fetcher: typeof fetch, options: DiscoverOptions): Promise<LocalFound> {
  const variable = kind.variables.find((name) => env[name]?.trim());
  const root = variable ? serverRoot(env[variable]!, kind.defaultPort, kind.id === "ollama") : kind.root;
  if (!root) return { provider: kind.id, problem: { provider: kind.id, cause: "address", text: `${variable} is set to an address Casper can't use, so ${kind.name} isn't in /model.` } };
  const budget = options.timeoutMs ?? probeBudget(root);
  const timer = AbortSignal.timeout(budget);
  const signal = AbortSignal.any([timer, ...(options.signal ? [options.signal] : [])]);
  try {
    const models = kind.id === "ollama" ? await ollama(fetcher, root, signal, env)
      : kind.id === "lm-studio" ? await lmStudio(fetcher, root, signal)
      : kind.id === "llama.cpp" ? await llamaCpp(fetcher, root, signal)
      : await openAiModels(fetcher, root, signal, (model) => positive(model.max_model_len));
    return { provider: kind.id, server: { provider: kind.id, name: kind.name, baseUrl: `${root}/v1`, models } };
  } catch (error) {
    // Quiet when nobody asked for this server (its usual address, no variable), or when the look was called off.
    if (!variable || options.signal?.aborted) return { provider: kind.id };
    const { cause, status } = causeOf(error, timer.aborted);
    // 0.0.0.0 is how a server is told to listen everywhere; here it means this computer.
    const everywhere = /^(?:https?:\/\/)?(?:0\.0\.0\.0|\[::\]|::)(?::\d+)?(?:\/|$)/i.test(env[variable]!.trim())
      ? ` ${variable} is 0.0.0.0, which here means this computer; to use another computer, set it to that computer's address.` : "";
    return { provider: kind.id, problem: { provider: kind.id, root, cause,
      text: `${kind.name} at ${root} (${variable}) ${causeWords(cause, kind, root, budget, status)}.${everywhere}` } };
  }
}

/** Probes the four servers at once. Each gets its own budget (`probeBudget`, or `timeoutMs`): a closed port answers at
 * once on macOS and Linux, after seconds on Windows, and another computer may be slow to reach. The runtime never
 * waits for this at its start, and `each` hears of every server as soon as its own look ends. */
export async function discoverLocalServers(options: DiscoverOptions = {}): Promise<LocalDiscovery> {
  const env = options.env ?? process.env;
  if (lookingOff(env)) return { servers: [], problems: [] };
  const fetcher = options.fetch ?? fetch;
  const found = await Promise.all(LOCAL_SERVERS.map(async (kind) => {
    const result = await lookAt(kind, env, fetcher, options);
    try { options.each?.(result); } catch { /* a listener's failure is not the look's */ }
    return result;
  }));
  return { servers: found.flatMap((entry) => entry.server ? [entry.server] : []), problems: found.flatMap((entry) => entry.problem ? [entry.problem] : []) };
}

/** What the runtime calls: tests replace `discover` (tests/support/preload.ts) so no test reaches a real server.
 * `staleMs`: a model asked for by name that isn't there sends Casper looking once more only when the last look is
 * older than this. */
export const localModelDefaults = { discover: discoverLocalServers, ttlMs: 24 * 60 * 60 * 1000, staleMs: 15_000 };

/** One look at the servers: the whole result, and each server's own end, so a wait for one isn't a wait for all. */
interface Round {
  at: number;
  /** When the look ended (undefined while it runs). */
  ended?: number;
  result: Promise<LocalDiscovery>;
  /** Each server kind's look: settles with the server to use (this look's answer, else its last one), or undefined. */
  settled: Map<string, Promise<LocalServer | undefined>>;
  /** Servers this look has found so far, for a listener that arrives after they answered. */
  found: LocalServer[];
  /** True as soon as a server on this computer answers with models; false when none did. */
  anyFound: Promise<boolean>;
}
let round: Round | undefined;
/** Each server's last answer in this process: a look that misses one (busy for a moment) keeps its models. */
const lastFound = new Map<string, LocalServer>();
const listeners = new Set<(server: LocalServer) => void>();

function startRound(signal?: AbortSignal): Round {
  const waits = new Map<string, ReturnType<typeof Promise.withResolvers<LocalServer | undefined>>>(LOCAL_SERVERS.map(({ id }) => [id, Promise.withResolvers<LocalServer | undefined>()]));
  const any = Promise.withResolvers<boolean>();
  const seen: LocalServer[] = [];
  const each = (found: LocalFound) => {
    // A server on another computer is never picked for you, so it doesn't count as "signed in" either.
    if (found.server?.models.length && onThisComputer(found.server.baseUrl)) any.resolve(true);
    if (found.server) {
      seen.push(found.server);
      for (const listener of listeners) { try { listener(found.server); } catch { /* the runtime's own problem */ } }
    }
    waits.get(found.provider)?.resolve(found.server ?? lastFound.get(found.provider));
  };
  const none: LocalDiscovery = { servers: [], problems: [] };
  const result = localModelDefaults.discover({ signal, each }).catch(() => none).then((fresh) => {
    // Per server: what answered replaces what was known; one that didn't answer keeps its last models.
    for (const server of fresh.servers) lastFound.set(server.provider, server);
    const answered = new Set(fresh.servers.map((server) => server.provider));
    const kept = [...lastFound.values()].filter((server) => !answered.has(server.provider));
    return { servers: [...fresh.servers, ...kept], problems: fresh.problems };
  }).finally(() => {
    current.ended = Date.now();
    for (const [id, wait] of waits) wait.resolve(lastFound.get(id));
  });
  void result.then((found) => any.resolve(found.servers.some((server) => server.models.length > 0 && onThisComputer(server.baseUrl))));
  const current: Round = { at: Date.now(), result, settled: new Map([...waits].map(([id, wait]) => [id, wait.promise])), found: seen, anyFound: any.promise };
  return current;
}

/** The servers found in this process, probed again after a day or when `refresh` is set (the /model picker, or a model
 * asked for by name that isn't there). `cachedOnly` (a helper's runtime) never probes: it gets what the main session
 * found, or nothing. */
export function localServers(options: { refresh?: boolean; cachedOnly?: boolean; signal?: AbortSignal } = {}): Promise<LocalDiscovery> {
  if (options.cachedOnly) return round?.result ?? Promise.resolve({ servers: [], problems: [] });
  if (!options.refresh && round && Date.now() - round.at < localModelDefaults.ttlMs) return round.result;
  round = startRound(options.signal);
  return round.result;
}

/** Settles when this provider's look in the current round ends (at once for a provider no look is out for), with the
 * server to use: what the look found, else that server's last answer in this process. A runtime adds it to its own
 * catalog before going on, since a listener added late (a helper, or a look started before the runtime) missed it. */
export function localServerSettled(provider: string): Promise<LocalServer | undefined> {
  return round?.settled.get(provider) ?? round?.result.then((found) => found.servers.find((server) => server.provider === provider))
    ?? Promise.resolve(undefined);
}

/** Settles when the looks at this computer's addresses end, with what they found; a server far away doesn't hold this up. */
export function localServersHereSettled(env: Record<string, string | undefined> = process.env): Promise<LocalServer[]> {
  if (!round) return Promise.resolve([]);
  const here = LOCAL_SERVERS.filter((kind) => {
    const variable = kind.variables.find((name) => env[name]?.trim());
    const root = variable ? serverRoot(env[variable]!, kind.defaultPort, kind.id === "ollama") : kind.root;
    return root !== undefined && onThisComputer(root);
  });
  return Promise.all(here.map((kind) => localServerSettled(kind.id))).then((servers) => servers.filter((server) => server !== undefined));
}

/** True once a server on this computer answers with models in the current look (starting one if none is out), false
 * if none does. One on another computer doesn't count: it is never picked for you. */
export function localServerFound(): Promise<boolean> {
  void localServers();
  return round!.anyFound;
}

/** When the latest look ended (now, while one runs; undefined: none yet). Casper looks again for a missing model only
 * when this is older than `staleMs`: one that just timed out isn't asked again at once. */
export function lastLocalLook(): number | undefined { return round ? round.ended ?? Date.now() : undefined; }

/** Whether a provider is one of the model servers Casper looks for (whose models may still be on their way). */
export function isLocalProvider(provider: string | undefined): boolean {
  return LOCAL_SERVERS.some(({ id }) => id === provider);
}

/** Hear of each server as soon as its look ends (the main session registers it at once), starting with those the
 * current look already found. Returns the way to stop. */
export function onLocalServer(listener: (server: LocalServer) => void): () => void {
  listeners.add(listener);
  for (const server of round?.found ?? []) { try { listener(server); } catch { /* the runtime's own problem */ } }
  return () => { listeners.delete(listener); };
}

/** Forget what was found (tests). */
export function clearLocalServers(): void { round = undefined; lastFound.clear(); listeners.clear(); }

type Catalog = Pick<ModelRuntime, "getProvider" | "getModels" | "getRegisteredProviderConfig" | "registerProvider">;

/** Requests to a found server go through pi-ai's own openai-completions code, with one change: a redirect is an error,
 * never followed. A server (or something pretending to be one) can't bounce the conversation to another address. */
const completions = openAICompletionsApi();
const refuseRedirects = (inner: typeof fetch = fetch): typeof fetch =>
  Object.assign((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => inner(url, { ...init, redirect: "error" }), { preconnect: inner.preconnect });

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
        streamSimple: (model, context, options) => completions.streamSimple(model, context, { ...options, fetch: refuseRedirects(options?.fetch) }),
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
