/** A response the client will not retry, or the last response after retries ran out. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}
