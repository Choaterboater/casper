# cron-next

Finds when a cron expression next matches, in UTC.

## Conventions

- `nextRun`, `nextRuns` and `CronError` live in `src/cron.ts`.
- Invalid options and Invalid Dates throw `RangeError`; a problem in the expression itself throws `CronError`.
- Tests live in `tests/`. No runtime dependencies.
