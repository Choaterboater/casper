# rate-limiter

A per-key token-bucket rate limiter.

## Conventions

- The limiter lives in `src/limiter.ts`.
- Time comes only from the injected `now()` clock (milliseconds, default `Date.now`); tests never wait on real time.
- Invalid options or arguments throw `RangeError`.
- Tests live in `tests/`. No runtime dependencies.
