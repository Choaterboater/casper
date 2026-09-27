# url-router

Matches HTTP method and path against registered route patterns.

## Conventions

- `Router` and `RouteError` live in `src/router.ts`.
- An invalid route pattern given to `add` is a `RouteError`; there are no other throws.
- Tests live in `tests/`. No runtime dependencies.
