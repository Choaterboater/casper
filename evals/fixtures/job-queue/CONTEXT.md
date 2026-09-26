# job-queue

An in-process job queue with a concurrency limit, retries and cancellation.

## Conventions

- The queue lives in `src/queue.ts`; its public types are exported from there.
- Timing goes through the injectable `sleep(ms, signal)` option so tests never wait on real time.
- `result` promises never reject: failures and cancellations are results.
- Tests live in `tests/`. No runtime dependencies.
