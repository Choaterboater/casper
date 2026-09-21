# O2 — deferred MCP/validator loading

## Scope and method

Only MCP SDK/transport loading in `src/mcp/manager.ts` and validator loading in
`src/capabilities/broker.ts` changed. No discovery parallelization, git-spawn
change, dependency update, connection-consent change or live-model call.

Environment: Bun 1.4.0, macOS arm64, Apple M2 Pro. An isolated temporary HOME and
empty project contain one **unconnected** synthetic MCP definition. Project state
is warmed; each observation uses a fresh Bun subprocess. There are two warmups per
variant/workload, then five ABBA blocks (ten observations per variant). The same
installed dependencies and source tree are used except for the two changed files.

The pre-edit unpaired baseline was 89.692 ms for app import and 148.841 ms for
`/project`. Use the paired measurements below for the comparison, not those
unpaired numbers. This is warm filesystem/cache startup, not cold-disk startup or
a representative repository with a user's full skill catalog.

## Paired results

| Workload | Before median (range), ms | After median (range), ms |
| --- | ---: | ---: |
| In-process `import src/app.ts` | 91.370 (86.917–94.871) | 36.954 (35.323–40.250) |
| Fresh import subprocess wall time | 115.143 (105.463–119.437) | 58.464 (57.245–63.873) |
| Fresh `casper /project` subprocess | 143.769 (141.878–147.431) | 92.494 (89.830–105.810) |

`/project` is about **51 ms / 36% lower** in this fixture. The module-cache probe
after app import finds **81 → 0 MCP/Ajv modules**. These costs are deferred, not
eliminated: the first approved connection imports the client and needed transport;
the pinned client itself imports Ajv. Standalone broker validation imports its
provider on first use and caches the module promise/resolved module. No claim of
faster MCP connections, remote requests, model execution or universal startup
improvement follows from this sample.

Raw ordered samples: [STARTUP_O2_SAMPLES.json](STARTUP_O2_SAMPLES.json).
Harness: `scripts/benchmark-startup.ts`. Reproduce against the original two files:

```sh
before=$(mktemp -d)
cp -R src "$before/src"
ln -s "$PWD/node_modules" "$before/node_modules"
git show c8df223:src/mcp/manager.ts > "$before/src/mcp/manager.ts"
git show c8df223:src/capabilities/broker.ts > "$before/src/capabilities/broker.ts"
CASPER_BENCH_BASE="$before" bun scripts/benchmark-startup.ts
# Inspect the output, then remove this temporary source snapshot when finished.
```

Without `CASPER_BENCH_BASE`, the harness measures the current tree only.
`CASPER_BENCH_ROOT` can select another source tree. It never connects the configured
fixture server or requests a model session.

## Behavioral validation

`tests/mcp-lazy-startup.test.ts` uses fresh subprocesses to avoid an already-warm
SDK hiding eager imports. It covers local-command import absence, a real cold
approved stdio connection, invalid/valid target-schema arguments, and controlled
real-module-load pauses. Close/disconnect/timeout during client or stdio-transport
imports cannot spawn a child; cancel/close/catalog replacement during validator
loading cannot reach confirmation or invocation. These import-boundary tests
supplement, not replace, real stdio/HTTP and pinned-Pi integration coverage.

An initial focused run failed the existing concurrent cancelled-call cleanup test:
awaiting a cached dynamic import for each new capability unnecessarily yielded
before the call began. Caching the resolved validator module removes that warm
boundary. The unchanged cleanup test and focused suite then passed. No deadline
or cleanup assertion was weakened.

Serial `bun run check`: **385 tests / 2,570 Bun assertions**, no failures,
TypeScript clean, **118.00 s** test-runner time. New subprocesses also run Node
assertions internally. `git diff --check` passed. Local same-agent validation only;
no independent acceptance, paid provider or production MCP evaluation.

Import promises cannot cancel module loading/evaluation. Deadline/consent checks
after the awaits prevent late transport creation; they do not hard-preempt a
blocking loader. Existing direct-child cleanup and platform limits remain.
