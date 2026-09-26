export interface LimiterOptions {
  /** Most tokens a bucket holds: a positive integer. A new key starts full. */
  readonly capacity: number;
  /** Tokens added per second, continuously: a positive integer. */
  readonly refillPerSecond: number;
  readonly now?: () => number;
}

export interface Decision {
  readonly allowed: boolean;
  /** Whole tokens left in the bucket after this call. */
  readonly remaining: number;
  /** 0 when allowed; otherwise the exact whole milliseconds until this cost would be allowed. */
  readonly retryAfterMs: number;
}

interface Bucket { milli: number; at: number }

const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;

/** Tokens are kept in thousandths so refill is exact integer arithmetic: one millisecond adds
 * `refillPerSecond` thousandths of a token. */
export class RateLimiter {
  readonly #capacity: number;
  readonly #rate: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: LimiterOptions) {
    if (!positiveInteger(options.capacity)) throw new RangeError("capacity must be a positive integer");
    if (!positiveInteger(options.refillPerSecond)) throw new RangeError("refillPerSecond must be a positive integer");
    this.#capacity = options.capacity;
    this.#rate = options.refillPerSecond;
    this.#now = options.now ?? Date.now;
  }

  /** Keys whose bucket is not full now; a bucket that refilled to full is forgotten. */
  get size(): number {
    const now = this.#now();
    for (const [key, bucket] of this.#buckets) if (this.#refill(bucket, now) >= this.#capacity * 1000) this.#buckets.delete(key);
    return this.#buckets.size;
  }

  /** Forget the key: its next take starts with a full bucket. */
  reset(key: string): void {
    this.#buckets.delete(key);
  }

  #refill(bucket: Bucket, now: number): number {
    if (now > bucket.at) {
      bucket.milli = Math.min(this.#capacity * 1000, bucket.milli + (now - bucket.at) * this.#rate);
      bucket.at = now;
    }
    return bucket.milli;
  }

  /** `cost` 0 is a probe: it reports the bucket and uses nothing. */
  take(key: string, cost = 1): Decision {
    if (!Number.isSafeInteger(cost) || cost < 0 || cost > this.#capacity) throw new RangeError("cost must be a non-negative integer no larger than capacity");
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { milli: this.#capacity * 1000, at: now };
      this.#buckets.set(key, bucket);
    } else this.#refill(bucket, now);
    const needed = cost * 1000;
    if (bucket.milli >= needed) {
      bucket.milli -= needed;
      return { allowed: true, remaining: Math.floor(bucket.milli / 1000), retryAfterMs: 0 };
    }
    return { allowed: false, remaining: Math.floor(bucket.milli / 1000), retryAfterMs: Math.ceil((needed - bucket.milli) / this.#rate) };
  }
}
