# allocation

Splits a money amount into parts by ratio without losing or inventing a single minor unit.

## Conventions

- `allocate` lives in `src/allocate.ts`; the currency table is `src/currencies.ts` (do not change it).
- Money is a decimal string such as `"12.34"` or `"-0.05"`; arithmetic is done in exact integer minor units, never floating point.
- Invalid input throws `RangeError`.
- Tests live in `tests/`. No runtime dependencies.
