# notes-api

A tiny JSON notes service built on the web `Request`/`Response` types.

## Conventions

- Routes are registered in `src/app.ts`; handlers live in `src/handlers.ts`.
- Every error response goes through `jsonError(status, code, extra?)` from `src/http.ts`,
  so clients always get `{ "error": "<code>", ... }` with `content-type: application/json`.
- Validation errors are 422 `validation_failed` with `fields` keyed by the top-level property name
  (`title`, not `title.length`; a bad array element is reported under the array, e.g. `tags`).
- The store (`src/store.ts`) is in memory and owned by each `createApp()` call.
- `src/server.ts` serves the app on `PORT`/`HOST` (`bun run dev`). Tests live in `tests/`. No runtime dependencies.
