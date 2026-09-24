# ttl-cache

An in-memory cache whose entries expire after a time-to-live.

## Rules

- Tests must be deterministic: no real sleeps, no timing margins, no retries.
- Never skip, focus or delete a test to make the suite pass.
- No runtime dependencies.
