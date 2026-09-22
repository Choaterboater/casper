# fixture-duration

Duration parsing and formatting fixture used by Casper's evaluation suite.

## Rules

- Production code lives in `src/`. Tests live in `tests/` and describe intended
  behavior; they are read-only. Skipping, focusing or deleting a test is a test change.
- No runtime dependencies, and no test configuration (`bunfig.toml`, preloads) that
  narrows what `bun test` runs.
