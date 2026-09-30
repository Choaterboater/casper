# 1. Casper is its own product; `verified` means checked and proven

Date: 2026-09-26. Status: accepted.

## Context

The hard-pack decision run (docs/evals/2026-09-26-hard-pack.md) found that Casper's receipt said `verified`
on 12 of 12 wrong runs, and the agreed rule said Casper should shrink to a Pi extension. The maintainer
reversed that call the same day. A Pi extension cannot own the process exit code, the task prompt or the
CLI, so it cannot be the product. The independent acceptance check that followed
(docs/evals/2026-09-26-acceptance-check.md) caught 1 of 8 wrong runs.

## Decision

1. Casper stays its own product and embeds Pi's SDK as a pinned library. It is neither a fork nor an extension.
2. `verified` keeps its current meaning: the checks passed fresh and the tests prove the change. The
   receipt is to name the stated requirements that no test covers. Catching wrong-but-tested changes stays
   research behind a flag.
3. The next research step is a cross-model independent acceptance check (a different model writes the
   tests), because it falsifies the leading explanation "same model, same blind spot" at the lowest cost.
   If it fails, the next candidate is requirement-to-test tracing, checked by the host.
4. The decision rule stays: caught ≥ 70%, flagged ≤ 20%, wall time and tokens ≤ 1.25× Pi.
5. Measurement moves to replay: keep wrong-run workspaces so new checks are graded on the same misses.
   A harder pack adds new misses.

## Consequences

- The standalone harness is no longer frozen.
- Each new check must be measured on replayed misses as well as fresh runs.
