# O3 — shared parallel workspace discovery

## Scope

`CasperApp.start()` and workspace rebinding now use the same private
`loadWorkspace()` implementation. Inspection and project/profile context loading
still precede skill, MCP, LSP and reference discovery. Those four independent
metadata reads then run through `Promise.all`, as rebinding already did. Managers
are initialized only after all discovery succeeds and shutdown is checked.

No connection consent, configuration precedence, skill-discovery internals,
verification behavior, git command, dependency or runtime adapter changed. This
is not the broader `app.ts` decomposition proposed by A1.

The injected discovery callbacks now may overlap. A rejected discovery prevents
publication; already-started sibling reads may finish afterward. They are not
abortable transactions, and this change does not add a filesystem snapshot or
make `close()` drain all metadata reads. Shutdown still prevents late publication,
banners, connections and model startup. Rebinding still revokes old tools before
loading the replacement workspace and requires fresh connection consent.

## Measurement

Same harness/environment as [O2](STARTUP_O2.md): Bun 1.4.0, macOS arm64, Apple M2
Pro; fresh processes, isolated HOME, empty cached project and one unconnected
synthetic MCP definition. Two warmups per variant/workload, then five ABBA blocks
(ten observations per variant). A full pre-edit source snapshot preserves all
previous uncommitted changes, including O2. Only `src/app.ts` differs.

| Workload | Before median (range), ms | After median (range), ms |
| --- | ---: | ---: |
| App import | 36.955 (35.864–40.524) | 35.876 (33.908–41.151) |
| Import subprocess wall time | 59.105 (56.194–75.616) | 56.810 (52.664–63.108) |
| `/project` subprocess wall time | 99.530 (91.721–120.738) | 97.690 (90.996–101.376) |

**No material startup improvement established.** The ~1.8 ms median difference is
small relative to overlapping ranges; there is no claim of the report's suggested
30–60 ms saving. Controlled loader gates establish actual scheduling overlap,
not a real-world latency gain. The shared loading implementation removes duplicated
initialization and keeps startup/rebinding consistent. MCP/Ajv import counts remain
zero for both local-command variants, preserving O2.

The unpaired pre-edit baseline was 97.074 ms for `/project`; use the paired table
for comparison. Raw ordered samples: [STARTUP_O3_SAMPLES.json](STARTUP_O3_SAMPLES.json).

Reproduce at this source version using the saved O3-only diff (the snapshot itself
is temporary):

```sh
before=$(mktemp -d)
cp -R src "$before/src"
ln -s "$PWD/node_modules" "$before/node_modules"
patch -R -p1 -d "$before" < docs/benchmarks/STARTUP_O3.patch
CASPER_BENCH_BASE="$before" bun scripts/benchmark-startup.ts
# Remove this temporary snapshot after inspecting the output.
```

Future `src/app.ts` edits may require manually applying the saved diff to the
matching source version. Do not compare against bare `c8df223`, which omits the
other uncommitted follow-ups and would confound the measurement.

## Validation

Four public-app tests in `tests/workspace-loading.test.ts` cover context-before-
discovery ordering, simultaneous loader starts, out-of-order completion with no
early banner, deterministic diagnostic order, failure without partial publication,
retry, close during loading, and invalid-context rejection before any dependent
loader. The overlap and sibling-failure tracers were red before the change; the
shutdown and invalid-context controls already passed.

Focused app/workspace/session/reference suites: **39 tests / 253 assertions**,
including named-session rebinding, source reload and captured-tool revocation.
Serial `bun run check`: **389 tests / 2,599 assertions**, no failures, TypeScript
clean, **118.66 s**. `git diff --check` passed. No live-model/production MCP calls,
commit or push. These are same-agent implementation checks, not independent
acceptance or daily-driver readiness.
