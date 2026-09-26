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

export class RateLimiter {
  constructor(_options: LimiterOptions) {}

  /** Keys whose bucket is not full now; a bucket that refilled to full is forgotten. */
  get size(): number {
    throw new Error("not implemented");
  }

  /** Forget the key: its next take starts with a full bucket. */
  reset(_key: string): void {
    throw new Error("not implemented");
  }

  /** `cost` 0 is a probe: it reports the bucket and uses nothing. */
  take(_key: string, _cost = 1): Decision {
    throw new Error("not implemented");
  }
}
