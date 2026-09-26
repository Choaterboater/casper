# docs-api

A tiny JSON document service built on the web `Request`/`Response` types.

## Conventions

- Routes are in `src/app.ts`; handlers live in `src/handlers.ts`.
- Every error response goes through `jsonError(status, code)` from `src/http.ts`, so clients always get `{ "error": "<code>" }` with `content-type: application/json`.
- The store (`src/store.ts`) is in memory and owned by each `createApp()` call; it starts with document 1.
- `src/server.ts` serves the app on `PORT`/`HOST` (`bun run dev`). Tests live in `tests/`. No runtime dependencies.
