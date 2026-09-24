export interface TtlCacheOptions {
  readonly ttlMs: number;
  /** Clock in milliseconds. Defaults to `Date.now`; tests inject a fake one. */
  readonly now?: () => number;
}

/** Entries expire `ttlMs` after they were set: `get` at exactly that instant misses. */
export class TtlCache<V> {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(options: TtlCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new Error("ttlMs must be a positive number");
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
  }

  set(key: string, value: V): void {
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (this.#now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Live entries only. */
  get size(): number {
    const now = this.#now();
    for (const [key, entry] of this.#entries) if (now >= entry.expiresAt) this.#entries.delete(key);
    return this.#entries.size;
  }
}
