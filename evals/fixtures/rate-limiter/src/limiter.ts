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

  take(key: string, cost = 1): Decision {
    if (!positiveInteger(cost) || cost > this.#capacity) throw new RangeError("cost must be a positive integer no larger than capacity");
    const now = this.#now();
    const full = this.#capacity * 1000;
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      bucket = { milli: full, at: now };
      this.#buckets.set(key, bucket);
    } else if (now > bucket.at) {
      bucket.milli = Math.min(full, bucket.milli + (now - bucket.at) * this.#rate);
      bucket.at = now;
    }
    const needed = cost * 1000;
    if (bucket.milli >= needed) {
      bucket.milli -= needed;
      return { allowed: true, remaining: Math.floor(bucket.milli / 1000), retryAfterMs: 0 };
    }
    return { allowed: false, remaining: Math.floor(bucket.milli / 1000), retryAfterMs: Math.ceil((needed - bucket.milli) / this.#rate) };
  }
}
