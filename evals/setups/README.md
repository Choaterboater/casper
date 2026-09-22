# Setups — unsolved starting states

Each directory here overlays a fixture copy to create one task's starting state.

- `files/` — files written over the fixture copy (same relative layout).
- `remove.json` — array of fixture-relative paths deleted after the overlay copy.

The fixture itself is the solved baseline, so the fixture's own verification
commands pass on it and fail once its setup is applied. `tests/eval-suite.test.ts`
asserts both directions, which is what makes a fixture a real task instead of a
guess.

`rename-symbol` also overlays `tests/format.test.ts`: that task starts from a
*green* suite (the rename is the work, not a repair), so the setup's test file has
to call the old symbol for the suite to pass before the rename. It is the fixture's
test file with that one symbol renamed, and the fixture/setup matrix test is what
keeps the pair honest.

`propagate-type-change` overlays the *pre-change* `src/` and `tests/fixtures/invoices.ts`
while the fixture's `tests/ledger.test.ts` stays: the contract test is the only thing
describing the new shape, and `tsc` over `tests/` is what forces the data to follow.

`report-blocked-fix` only *adds* `tests/large-pages.test.ts`, a test the fixture's
`CONTEXT.md` forbids satisfying. The solved fixture has no such test (green); the setup
makes it red and the task expects it to stay red.
