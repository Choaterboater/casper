# Phase 5 — debug, speed, and optimization pass

## Scope and method

Full repository validation plus targeted LSP lifecycle/concurrency stress and performance measurements. No production servers, HPE endpoints, personal configuration, or external model calls were used in benchmarks/acceptance. Independent code-review processes are separate from those local workloads.

Before changing production code, preserved the current uncommitted `src`/`tests` in a temporary baseline directory. Ran the **same** benchmark script against baseline and optimized sources in **A–B–B–A order**, with isolated temporary HOME/project directories and shared installed dependency versions. Each metric has a discarded warm-up. CLI startup uses a fresh process, not a cold OS filesystem cache. All benchmark outputs assert successful execution and expected diagnostic/rename results.

Reproduce current measurements:

```bash
bun run scripts/benchmark-lsp.ts
# Compare another preserved source tree (must also contain tests/fixtures/lsp-server.ts):
CASPER_BENCH_ROOT=/path/to/source-snapshot bun run scripts/benchmark-lsp.ts
```

Raw samples, run order, machine metadata, and before/after source SHA-256 hashes: [`benchmarks/phase5-lsp.json`](benchmarks/phase5-lsp.json). Hardware: Apple M2 Pro, macOS arm64, Bun 1.4.0. Results below pool the two runs per version. Percentages describe **latency reductions**, not guaranteed production/model speedups.

## Measurements

| Operation | Samples/version | Before median | After median | Reduction | Before → after p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Local `/project`, fresh CLI process | 14 | 174.56 ms | 170.53 ms | noise-level | 227.17 → 188.85 ms |
| Snapshot 4 KiB file | 200 | 0.308 ms | 0.242 ms | 21.6% | 1.070 → 0.345 ms |
| Snapshot 1 MiB file | 40 | 0.798 ms | 0.455 ms | 43.1% | 2.484 → 1.440 ms |
| Parse 1 MiB message in 256-byte chunks | 14 | 372.70 ms | 0.583 ms | 99.8% | 450.22 → 1.455 ms |
| Parse 1 MiB message in 8 KiB chunks | 14 | 12.073 ms | 0.202 ms | 98.3% | 14.198 → 1.735 ms |
| Fixture connect + close | 14 | 40.26 ms | 41.85 ms | 3.9% slower median | 75.71 → 48.29 ms |
| Symbols, one open file | 40 | 0.949 ms | 0.639 ms | 32.7% | 1.782 → 0.804 ms |
| Symbols, 100 open files | 30 | 38.72 ms | 18.85 ms | 51.3% | 44.40 → 24.14 ms |
| Diagnostics, 100 open files | 30 | 77.08 ms | 38.12 ms | 50.5% | 87.32 → 45.80 ms |
| 100-file rename + fresh diagnostics | 10 | 4700.62 ms | 319.46 ms | **93.2%** | 4869.62 → 393.25 ms |
| 10-file rename, absent diagnostics, 100 ms budget | 6 | 1175.95 ms | 148.94 ms | **87.3%** | 1195.46 → 154.90 ms |

The fixture isolates Casper overhead; it is not a compiler or model benchmark. Rename timing includes resetting fixture source files in both versions. Real TypeScript/Pyright acceptance is tested separately. Connection latency and CLI startup were not meaningful optimization wins, and the snapshot microbenchmark is sensitive to filesystem/cache noise; no claims of universally improved startup or compiler speed are made.

## Measured causes and changes

1. **Repeated protocol-buffer copying.** The old reader concatenated every incoming chunk with all prior bytes and reparsed headers while waiting for the body. The new reader has bounded incremental header/body state and copies each body byte once. Limits remain 8 KiB headers and 4 MiB bodies. Fragmented Unicode, multiple frames, invalid headers, and invalid UTF-8 have regression coverage.
2. **Maximum-sized buffers for tiny source files.** Every snapshot previously allocated 1 MiB regardless of file size, magnifying allocation/GC overhead in repeated scans. Reads now allocate the stat-reported size plus one growth sentinel, accumulate short reads, and reject size changes. UTF-8/BOM, empty-file, hardlink/path, and byte-limit guards remain; no persistent filesystem cache was introduced.
3. **Quadratic post-rename validation and serial diagnostic waits.** Each of N reports previously re-read N open documents, and missing publications multiplied the wait budget. Reports now share one wait budget with at most eight collectors and one final full dependency/snapshot validation pass. A detected change to a target or dependency invalidates the entire batch. Two-phase content/version synchronization remains intact, and absent/unversioned reports never become clean results.

## Reproduced correctness issues

Regressions in `tests/phase5-lsp-stress.test.ts` failed before fixes:

- Immediate disconnect could allow a server to launch later and complete connection. Startup now has a cancellable consent lifetime created before any await/spawn; disconnect cancels it immediately.
- A cancelled queued read remained blocked behind another operation's interactive approval. Queued calls now settle cancellation immediately and never execute later; the active-operation deadline still begins only when dequeued, and completed-operation timers are cleared.
- Sequential post-rename reports could represent different disk states if another file changed during collection. Batch validation now invalidates every report together, instead of mixing stale and refreshed evidence.
- A 10-file missing-diagnostic workload exceeded three seconds with a 300 ms budget. The new shared-budget regression finishes below its generous 1.5-second guard while all reports remain explicitly `timeout`.

Stress coverage also exercises ten repeated concurrent-start/teardown cycles, 200 queued reads/cancellations, verifies every recorded child PID is gone, and verifies pull-diagnostic concurrency never exceeds eight. All filesystem mutations occur in temporary fixtures.

## Validation / review status

- Three full checks after optimization: TypeScript passed, **117 tests / 596 assertions each**. Real TypeScript/Pyright acceptance and actual Pi/local-provider integration remain included.
- Three repeated Phase 5 suites: **46 tests / 207 assertions each**, all passed.
- The benchmark script separately passed strict TypeScript checking; `git diff --check` passed.
- Two independent read-only reviewer processes (`gpt-6-astra`, medium reasoning), Standards and Spec, compared the exact preserved pre-optimization sources with current code and inspected tests, script, and documentation. **Both returned no actionable findings.** They confirmed the thin runtime seam, consent/cancellation, bounded framing, snapshot validation, approval, and two-phase freshness protections remained intact. Spec independently checked source hashes and recomputed the reported pooled medians from the saved samples. Neither reviewer ran tests or benchmarks; execution evidence above belongs to the coordinating agent.
- No leftover language-server fixture processes were observed after validation; the repeated-lifecycle regression also verifies all ten recorded PIDs have exited.

No commit or push. Phase 6 not started. Existing safety limitations in [`LSP.md`](LSP.md), including non-atomic external filesystem races and unsandboxed executables, still apply.
