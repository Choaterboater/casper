# notes-api

A tiny JSON notes service built on the web `Request`/`Response` types.

## Conventions

- Routes are registered in `src/app.ts`; handlers live in `src/handlers.ts`.
- Every error response goes through `jsonError(status, code, extra?)` from `src/http.ts`,
  so clients always get `{ "error": "<code>", ... }` with `content-type: application/json`.
- The store (`src/store.ts`) is in memory and owned by each `createApp()` call.
- Tests live in `tests/`. No runtime dependencies.
