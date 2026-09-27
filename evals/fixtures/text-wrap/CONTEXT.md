# text-wrap

Wraps plain text to a fixed column width, handling indentation, hyphenation, wide characters and ANSI codes.

## Conventions

- `wrap` lives in `src/wrap.ts`.
- Invalid options throw `RangeError` with the exact message stated in the task; there are no other throws.
- Tests live in `tests/`. No runtime dependencies.
