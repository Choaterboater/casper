# api-client

A typed client for a JSON HTTP API.

## Conventions

- `createClient(options)` in `src/client.ts` is the only public entry point, re-exported from `src/index.ts`.
- Dependencies are injected through options (`fetch`, `sleep`) so tests never wait on real time.
- Errors are the classes in `src/errors.ts`; never throw strings or plain objects.
- No runtime dependencies.
