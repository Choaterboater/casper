# semver-range

Parses semantic versions, compares them, and matches them against range expressions.

## Conventions

- `parse`, `compare`, `satisfies`, `maxSatisfying`, `minSatisfying`, `sort` and `SemverError` live in `src/semver.ts`.
- An invalid version or range is a `SemverError`; there are no other throws.
- Tests live in `tests/`. No runtime dependencies.
