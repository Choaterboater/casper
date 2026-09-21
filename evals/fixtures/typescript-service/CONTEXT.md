# fixture-service

Small request-router fixture used by Casper's evaluation suite.

## Rules

- Production code lives in `src/`. Tests live in `tests/`.
- `tests/` describe intended behavior. Treat them as read-only unless a task
  explicitly asks for a test change.
- No new runtime dependency without an explicit request; this project has none.
- Keep the public shape of existing exports (`createRouter`, `slugify`) unchanged.
