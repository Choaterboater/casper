# fixture-ledger

Small invoicing fixture used by Casper's evaluation suite.

## Rules

- Production code lives in `src/`. Tests live in `tests/`; shared test data lives in
  `tests/fixtures/` and is typed against `src/`.
- `tests/*.test.ts` describe intended behavior and are read-only. Test data under
  `tests/fixtures/` follows the types in `src/` and changes with them.
- `tsconfig.json` covers `src` and `tests`; `tsc --noEmit -p tsconfig.json` must pass.
- No runtime dependencies.
