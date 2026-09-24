export interface TtlCacheOptions {
  readonly ttlMs: number;
}

/** Entries expire `ttlMs` after they were set: `get` at exactly that instant misses. */
export class TtlCache<V> {
  readonly #ttlMs: number;
  readonly #entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(options: TtlCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new Error("ttlMs must be a positive number");
    this.#ttlMs = options.ttlMs;
  }

  set(key: string, value: V): void {
    this.#entries.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Live entries only. */
  get size(): number {
    const now = Date.now();
    for (const [key, entry] of this.#entries) if (now >= entry.expiresAt) this.#entries.delete(key);
    return this.#entries.size;
  }
}
