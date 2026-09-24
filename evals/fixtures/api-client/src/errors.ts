/** A response the client will not retry, or the last response after retries ran out. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

/** A single request took longer than the configured timeout. */
export class TimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms: ${url}`);
    this.name = "TimeoutError";
  }
}
