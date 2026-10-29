/**
 * Your plan's own model lists, the way oh-my-pi reads them: for a ChatGPT plan (OpenAI Codex) and GitHub Copilot, the
 * account says which models it offers, and the engine's catalog says how to call each one. pi.dev's copy of a
 * provider's list is given per engine version and can stop moving for an older engine (it did for Pi 1.1.0 on
 * Oct 15, 2026), so it can list models the account no longer has and miss new ones.
 *
 * Codex: a model the catalog has but the account doesn't offer is taken off (the engine lays nothing similar), unless
 * the account names none of the catalog's models. Copilot: the engine already keeps only the models your sign-in
 * offers (`availableModelIds`, read again when the Copilot token is renewed), so nothing is taken off here. For both, a
 * model the account offers that the catalog doesn't have is only named: how to call it (thinking levels, prices,
 * request settings) isn't in the account's list, and Casper doesn't guess it. /model says to update Casper.
 *
 * The main session reads both as it starts and again when /model opens, if the last read is over `freshMs` old; only
 * with that plan sign-in, and never offline. The token goes only to that provider and never into a message. A read that
 * fails keeps the list read before. Decision: docs/adr/0002/44-account-model-lists.md.
 */
import { VERSION as ENGINE_VERSION, type ModelRuntime, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { AnyModel } from "@earendil-works/pi-ai";
import { COPILOT_HEADERS, copilotCatalog } from "./other-logins";

export const CODEX_MODELS_URL = "https://chatgpt.com/backend-api/codex/models";
const COPILOT_INDIVIDUAL_API = "https://api.individual.githubcopilot.com";
const ACCOUNT_PROVIDERS = ["openai-codex", "github-copilot"] as const;
type AccountProvider = typeof ACCOUNT_PROVIDERS[number];
const NAMES: Record<AccountProvider, string> = { "openai-codex": "OpenAI", "github-copilot": "GitHub Copilot" };

export const accountModelDefaults: { fetch: (url: string, init?: RequestInit) => Promise<Response>; freshMs: number; timeoutMs: number } = {
  fetch: (url, init) => fetch(url, init),
  freshMs: 10 * 60 * 1000,
  timeoutMs: 15_000,
};

/** One plan's list as last read. */
export interface AccountList {
  /** The models the account offers, in its order. */
  ids: readonly string[];
  /** When they were read (0: never). */
  at: number;
  /** Ones the engine's catalog doesn't have: Casper can't call them yet. */
  unknown: readonly string[];
  /** Why the newest read failed, in plain words; `ids` and `at` are then the read before's. */
  problem?: string;
}

export interface AccountModels {
  /** Settles once the session's first reads have ended. Never rejects. */
  ready: Promise<void>;
  /** Reads again, as /model does when it opens, when the last read is over `freshMs` old. Never rejects. */
  refresh(signal?: AbortSignal): Promise<void>;
  lists(): ReadonlyMap<string, AccountList>;
}

export interface AccountModelOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof accountModelDefaults.fetch;
  freshMs?: number;
}

type Catalog = Pick<ModelRuntime, "getAllModels" | "getRegisteredProviderConfig" | "registerProvider" | "unregisterProvider">;
type Reading = Catalog & Pick<ModelRuntime, "getAuth" | "hasConfiguredAuth" | "isUsingOAuth">;

const isChat = (model: AnyModel) => ((model as { type?: string }).type ?? "chat") === "chat";

/** The slugs Codex's list shows (`visibility` "list", or none given). Undefined when the body isn't such a list. */
export function parseCodexModels(body: unknown): string[] | undefined {
  const entries = (body as { models?: unknown; data?: unknown } | null)?.models ?? (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(entries)) return undefined;
  return entries.flatMap((entry: { slug?: unknown; id?: unknown; visibility?: unknown } | null) => {
    const slug = typeof entry?.slug === "string" ? entry.slug : typeof entry?.id === "string" ? entry.id : undefined;
    if (!slug) return [];
    const visibility = typeof entry?.visibility === "string" ? entry.visibility.toLowerCase() : "list";
    return visibility === "hide" || visibility === "hidden" ? [] : [slug];
  });
}

/** The ChatGPT account a sign-in's token names. */
function codexAccount(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, { chatgpt_account_id?: unknown } | undefined>;
    const id = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" ? id : undefined;
  } catch { return undefined; }
}

class ReadFailure extends Error {}

/** One plan's list from its provider. Throws a ReadFailure with plain words (never a body, address or token). */
async function readAccount(catalog: Reading, provider: AccountProvider, fetcher: typeof accountModelDefaults.fetch, signal: AbortSignal): Promise<string[]> {
  const resolved = await catalog.getAuth(provider).catch(() => undefined);
  const token = resolved?.auth.apiKey;
  if (!token) throw new ReadFailure("no sign-in to read it with");
  const within = AbortSignal.any([signal, AbortSignal.timeout(accountModelDefaults.timeoutMs)]);
  let response: Response;
  let parse: (body: unknown) => string[] | undefined;
  try {
    if (provider === "openai-codex") {
      const account = codexAccount(token);
      // Codex shows a model only to a client at least as new as its minimal_client_version; the engine's own version
      // is above every Codex CLI version, so the account's list isn't cut short by it.
      response = await fetcher(`${CODEX_MODELS_URL}?client_version=${encodeURIComponent(ENGINE_VERSION)}`, { redirect: "error", signal: within,
        headers: { accept: "application/json", authorization: `Bearer ${token}`, originator: "pi", ...account ? { "chatgpt-account-id": account } : {} } });
      parse = parseCodexModels;
    } else {
      const api = (resolved.auth.baseUrl ?? COPILOT_INDIVIDUAL_API).replace(/\/+$/, "");
      response = await fetcher(`${api}/models`, { redirect: "error", signal: within,
        headers: { accept: "application/json", authorization: `Bearer ${token}`, ...COPILOT_HEADERS, "X-GitHub-Api-Version": "2026-06-01" } });
      parse = (body) => Array.isArray((body as { data?: unknown } | null)?.data) ? copilotCatalog(body, api === COPILOT_INDIVIDUAL_API).available : undefined;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ReadFailure(`couldn't reach ${NAMES[provider]}`);
  }
  if (!response.ok) { await response.body?.cancel(); throw new ReadFailure(`${NAMES[provider]} answered HTTP ${response.status}`); }
  const ids = parse(await response.json().catch(() => undefined));
  if (!ids) throw new ReadFailure(`${NAMES[provider]} sent a list Casper can't read`);
  return [...new Set(ids)];
}

/** The Codex models Casper laid on each catalog: only that list is Casper's to take off. */
const laid = new WeakMap<object, ProviderModelConfig[]>();

/** Takes the Codex models the account doesn't offer off the catalog's list as it is now (Casper's earlier list off
 * first). Nothing changes when another layer owns Codex's models, or when the account names none of the catalog's.
 * Returns the ids the engine's own list has (what Casper can call). */
function applyCodex(catalog: Catalog, ids: readonly string[]): Set<string> {
  const registered = catalog.getRegisteredProviderConfig("openai-codex");
  const ours = laid.get(catalog);
  const all = () => catalog.getAllModels("openai-codex");
  if (registered && !(ours && registered.models === ours && Object.keys(registered).every((key) => key === "models"))) return new Set(all().map((model) => model.id));
  if (registered) catalog.unregisterProvider("openai-codex");
  laid.delete(catalog);
  const offered = new Set(ids);
  const engine = all();
  const kept = engine.filter((model) => !isChat(model) || offered.has(model.id));
  const known = new Set(engine.map((model) => model.id));
  if (kept.length === engine.length || !kept.some(isChat)) return known;
  const models = kept as unknown as ProviderModelConfig[];
  try { catalog.registerProvider("openai-codex", { models }); } catch { return known; }
  laid.set(catalog, models);
  return known;
}

/** The newest lists this process read: a helper's catalog takes them. */
const latest = new Map<AccountProvider, AccountList>();

/** Tests only. */
export function forgetAccountModels(): void { latest.clear(); }

/** The main session's reads of your plans' lists, from now until `lifetime` ends. */
export function startAccountModels(catalog: Reading, lifetime: AbortSignal, options: AccountModelOptions = {}): AccountModels {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? accountModelDefaults.fetch;
  const freshMs = options.freshMs ?? accountModelDefaults.freshMs;
  const lists = new Map<AccountProvider, AccountList>();
  let reading: Promise<void> | undefined;
  const read = async (signal: AbortSignal): Promise<void> => {
    if (lifetime.aborted || env.CASPER_OFFLINE === "1" || env.PI_OFFLINE !== undefined) return;
    await Promise.all(ACCOUNT_PROVIDERS.map(async (provider) => {
      if (!catalog.hasConfiguredAuth(provider) || !catalog.isUsingOAuth(provider)) { lists.delete(provider); return; }
      const before = lists.get(provider);
      if (before && !before.problem && Date.now() - before.at < freshMs) return;
      try {
        const ids = await readAccount(catalog, provider, fetcher, signal);
        if (lifetime.aborted) return;
        const known = provider === "openai-codex" ? applyCodex(catalog, ids) : new Set(catalog.getAllModels(provider).map((model) => model.id));
        const list = { ids, at: Date.now(), unknown: ids.filter((id) => !known.has(id)) };
        lists.set(provider, list); latest.set(provider, list);
      } catch (error) {
        if (!(error instanceof ReadFailure)) return;
        lists.set(provider, { ...before ?? { ids: [], at: 0, unknown: [] }, problem: error.message });
      }
    }));
  };
  const update = (signal: AbortSignal) => {
    reading ??= read(signal).catch(() => undefined).finally(() => { reading = undefined; });
    return reading;
  };
  const ready = update(lifetime);
  return {
    ready,
    refresh: async (signal) => {
      await reading;
      // The catalog may have changed since (a newer pi.dev copy): Codex's list goes on again over it, and what each
      // account offers that the engine doesn't know is checked again, read again or not.
      for (const [provider, list] of lists) {
        if (!list.ids.length) continue;
        const known = provider === "openai-codex" ? applyCodex(catalog, list.ids) : new Set(catalog.getAllModels(provider).map((model) => model.id));
        lists.set(provider, { ...list, unknown: list.ids.filter((id) => !known.has(id)) });
      }
      await update(signal ? AbortSignal.any([signal, lifetime]) : lifetime);
    },
    lists: () => lists,
  };
}

/** A helper's catalog takes the Codex list the main session read; a helper never reads it itself. */
export function applyLatestAccountModels(catalog: Catalog): void {
  const codex = latest.get("openai-codex");
  if (codex?.ids.length) applyCodex(catalog, codex.ids);
}
