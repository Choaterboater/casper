export class LoginError extends Error {
  constructor(readonly status: number) {
    super(`Login rejected (HTTP ${status})`);
    this.name = "LoginError";
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(`HTTP ${status} for ${path}`);
    this.name = "HttpError";
  }
}

export class LogoutError extends Error {
  constructor(readonly status: number | null, options?: { cause?: unknown }) {
    super(`Logout failed${status === null ? "" : ` (HTTP ${status})`}`, options);
    this.name = "LogoutError";
  }
}
