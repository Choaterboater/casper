import { HttpError, TimeoutError } from "./errors";

export interface ClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt, for 429 and 5xx responses and network errors. */
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

export interface Client {
  get<T>(path: string): Promise<T>;
  listAll<T>(path: string): Promise<T[]>;
}

const BACKOFF_MS = [100, 200, 400, 800, 1600];
const MAX_RETRY_AFTER_MS = 60_000;

function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (header.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
}

export function createClient(options: ClientOptions): Client {
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function attempt(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(url, {
        headers: { accept: "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new TimeoutError(url, timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function request<T>(url: string): Promise<T> {
    for (let retry = 0; ; retry++) {
      let response: Response | undefined;
      let failure: unknown;
      try { response = await attempt(url); }
      catch (error) {
        if (error instanceof TimeoutError) throw error;
        failure = error;
      }
      if (response?.ok) return await response.json() as T;
      const retryable = response === undefined || response.status === 429 || response.status >= 500;
      if (!retryable || retry >= maxRetries) {
        if (response) throw new HttpError(response.status, url);
        throw failure;
      }
      const wait = response?.status === 429 ? retryAfterMs(response.headers.get("retry-after"), Date.now()) : undefined;
      await sleep(wait ?? BACKOFF_MS[Math.min(retry, BACKOFF_MS.length - 1)]!);
    }
  }

  const resolve = (path: string) => new URL(path, options.baseUrl).toString();
  return {
    get: (path) => request(resolve(path)),
    async listAll<T>(path: string) {
      const items: T[] = [];
      const seen = new Set<string>();
      let url: string | null = resolve(path);
      while (url) {
        if (seen.has(url)) throw new Error(`Pagination loop at ${url}`);
        seen.add(url);
        const page: Page<T> = await request<Page<T>>(url);
        items.push(...page.items);
        url = page.next === null ? null : new URL(page.next, url).toString();
      }
      return items;
    },
  };
}
