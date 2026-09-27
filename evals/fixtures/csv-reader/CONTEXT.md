# csv-reader

A forgiving CSV reader that reports problems instead of throwing on bad data.

## Conventions

- `readCsv` lives in `src/csv.ts`, along with the `CsvOptions` and result types.
- Invalid options throw `RangeError`; everything about the text itself is reported as a problem, never a throw.
- Tests live in `tests/`. No runtime dependencies.
