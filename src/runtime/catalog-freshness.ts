/**
 * How fresh each provider's model list is, for /model: where it comes from (your plan's own list, pi.dev's copy, or
 * the one built into this Casper), when it last changed, and why it is out of date when it is.
 *
 * pi.dev gives an engine the copy of a provider's list made for its version, and stops moving an older engine's copy
 * when the list changes in a way that engine can't read (Pi 1.1.0's copies stayed at Oct 15, 2026). The engine then
 * asks every 4 hours, hears "unchanged" and calls the list fresh. So a copy over a week old is checked with two plain
 * HEAD requests (no body, no sign-in), at most every 4 hours per provider and never offline: the date of the copy pi.dev
 * gives this engine (asked with the engine's own User-Agent, which pi.dev pins to its version) and of its current copy
 * (asked as Casper). Only an engine copy more than a day older than the current one means this Casper's engine can't
 * be given it: update Casper. An old saved copy the engine would be given a newer one of says nothing (the next
 * refresh brings it), and pi.dev not answering makes no claim.
 *
 * OpenRouter isn't checked: Casper reads OpenRouter's own list (src/runtime/openrouter-models.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { VERSION as ENGINE_VERSION, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { CASPER_VERSION } from "../version";
import type { AccountList } from "./account-models";

const DAY = 24 * 60 * 60 * 1000;
/** A copy older than this is checked against pi.dev's current one. */
export const STALE_AFTER_MS = 7 * DAY;
/** pi.dev is asked about a provider at most this often. */
export const LATEST_EVERY_MS = 4 * 60 * 60 * 1000;
/** How much newer pi.dev's current copy must be to call this one out of date (the same list saved minutes apart isn't). */
const NEWER_BY_MS = DAY;
export const PI_CATALOG_URL = "https://pi.dev/api/models/providers/";
/** The model types the engine asks pi.dev for (remote-catalog-provider.js), so the same list's date is asked for. */
const TYPES = "chat,image,classifier";

export interface ListFreshness {
  provider: string;
  /** Where the models listed come from. */
  source: "your account" | "pi.dev" | "built in";
  /** When the list last changed (pi.dev, built in) or was read (your account). */
  at?: number;
  /** Why the list is out of date, in plain words; none when it isn't, or nobody can tell. */
  stale?: string;
  /** Models your plan offers that this Casper can't call yet. */
  unknown?: readonly string[];
}

export interface FreshnessOptions {
  catalog: Pick<ModelRuntime, "hasConfiguredAuth">;
  /** The engine's store: its models-store.json holds the copies of pi.dev's lists. */
  agentDir: string;
  /** Your plans' own lists (src/runtime/account-models.ts). */
  accounts?: ReadonlyMap<string, AccountList>;
  env?: NodeJS.ProcessEnv;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: number;
  /** When the lists built into the engine were made. */
  builtinAt?: number;
  signal?: AbortSignal;
}

/** "Oct 15": the day in UTC, the zone pi.dev dates its lists in. */
export function listDay(at: number): string {
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The date each copy of pi.dev's lists last changed, by provider. Nothing when the store can't be read. */
function storedDates(agentDir: string): Map<string, number | undefined> {
  try {
    const store = JSON.parse(readFileSync(path.join(agentDir, "models-store.json"), "utf8")) as Record<string, { lastModified?: unknown } | null>;
    return new Map(Object.entries(store).flatMap(([provider, entry]) => entry && typeof entry === "object"
      ? [[provider, typeof entry.lastModified === "number" && entry.lastModified > 0 ? entry.lastModified : undefined] as const] : []));
  } catch { return new Map(); }
}

/** The date of a provider's copy at pi.dev as one client is given it, by provider and client, and when it was asked. */
const latest = new Map<string, { asked: number; at?: number }>();

/** Tests only. */
export function forgetLatestLists(): void { latest.clear(); }

/** The engine's own `User-Agent` for pi.dev (pi-coding-agent's getPiUserAgent, which it doesn't export): pi.dev gives
 * the copy for this engine version to it. */
export function engineAgent(): string {
  const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
  return `pi/${ENGINE_VERSION} (${process.platform}; ${runtime}; ${process.arch})`;
}

/** The date of the copy of `provider`'s list pi.dev gives a client named `agent` (HEAD, redirects followed). */
async function copyDate(provider: string, agent: string, options: Required<Pick<FreshnessOptions, "fetch" | "now">> & { signal?: AbortSignal }): Promise<number | undefined> {
  const key = `${provider}\0${agent}`;
  const known = latest.get(key);
  if (known && options.now - known.asked < LATEST_EVERY_MS) return known.at;
  let at: number | undefined;
  try {
    const response = await options.fetch(`${PI_CATALOG_URL}${encodeURIComponent(provider)}?types=${encodeURIComponent(TYPES)}`, {
      method: "HEAD", headers: { "user-agent": agent },
      signal: AbortSignal.any([...options.signal ? [options.signal] : [], AbortSignal.timeout(5_000)]),
    });
    await response.body?.cancel();
    const parsed = response.ok ? Date.parse(response.headers.get("last-modified") ?? "") : NaN;
    at = Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    if (options.signal?.aborted) return undefined;
  }
  latest.set(key, { asked: options.now, at });
  return at;
}

/** Each signed-in provider's list: its source and date, and why it is out of date when it is. Never rejects. */
export async function listFreshness(options: FreshnessOptions): Promise<ListFreshness[]> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const builtinAt = options.builtinAt ?? getBuiltinModelDataGeneratedAt();
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const offline = env.CASPER_OFFLINE === "1" || env.PI_OFFLINE !== undefined;
  const stored = storedDates(options.agentDir);
  const providers = [...new Set([...stored.keys(), ...options.accounts?.keys() ?? []])]
    .filter((provider) => provider !== "openrouter" && options.catalog.hasConfiguredAuth(provider))
    .sort((a, b) => a.localeCompare(b));
  return Promise.all(providers.map(async (provider): Promise<ListFreshness> => {
    const piDev = stored.get(provider);
    const fromPiDev = piDev !== undefined && (builtinAt === undefined || piDev > builtinAt);
    const listed = fromPiDev ? piDev : builtinAt;
    let stale: string | undefined;
    if (listed !== undefined && now - listed > STALE_AFTER_MS && !offline) {
      const asking = { fetch: fetcher, now, signal: options.signal };
      // What pi.dev gives this engine, and its current copy: only the first trailing means the engine is frozen out.
      // An old copy the engine would be given a newer one of is just not refetched yet, and says nothing.
      const [given, current] = await Promise.all([copyDate(provider, engineAgent(), asking), copyDate(provider, `casper/${CASPER_VERSION}`, asking)]);
      if (given !== undefined && current !== undefined && current - given > NEWER_BY_MS && current - listed > NEWER_BY_MS) {
        stale = `list from ${listDay(Math.max(listed, given))}; pi.dev's is from ${listDay(current)}, but this Casper's engine (version ${ENGINE_VERSION}) is given the older one. Update Casper.`;
      }
    }
    const account = options.accounts?.get(provider);
    if (account && (account.at > 0 || account.problem)) {
      const shown = account.at > 0 ? account.at : listed;
      const problem = account.problem && `couldn't read your account's list (${account.problem}); ${account.at > 0 ? `showing the one read ${listDay(account.at)}` : "showing the engine's"}.`;
      return { provider, source: account.at > 0 ? "your account" : fromPiDev ? "pi.dev" : "built in", ...shown !== undefined ? { at: shown } : {},
        ...problem || stale ? { stale: problem ?? stale } : {}, ...account.unknown.length ? { unknown: account.unknown } : {} };
    }
    return { provider, source: fromPiDev ? "pi.dev" : "built in", ...listed !== undefined ? { at: listed } : {}, ...stale ? { stale } : {} };
  }));
}
