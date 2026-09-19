# Pre-next-phase debug/review checkpoint

## Scope and method

User-approved baseline: `f8bb28eaf0b79d3279587f5960657d1023e7555b` (Phase 3 handoff) → current working tree, including all untracked Phase 4–9 implementation/test/docs files. The user authorized corrective changes and a repository commit, not a push or phase expansion.

Reviewed runtime boundaries, app admission/shutdown/rebinding, MCP consent/catalog lifecycle/result budgets, LSP synchronization/rename/process handling, visualization input/output paths, worktree ownership/recovery, named-session persistence, child limits/cancellation, and memory evidence/persistence. Standards source: `docs/CASPER_COMPLETE_PLAN.md` §§5, 37–38, 49; Spec sources: its phase contracts plus `docs/IMPLEMENTATION_PLAN.md` and phase implementation/usage documents. No separate AGENTS/CONTEXT/ADR/issue-tracker file was present.

This pass used **one agent with separate Standards and Spec passes**, not parallel independent reviewers: no sub-agent tool was available. Earlier independent reports remain historical evidence, not sign-off on these new edits. All test files ran; this is a risk-focused source review, not a claim that every possible interleaving or platform was exhaustively audited.

## Standards

**S1 — P2, fixed: outcome schema validation accepted non-string enums.** `src/memory/store.ts:32` coerced persisted values with `String(...)`, so `modelStatus: ["completed"]`, `verification: ["pass"]`, and array-valued check statuses passed validation. Nested evidence also accepted arbitrary extra fields. This undermined inspectable evidence (§49, “Proof beats self-reporting” / “Keep Casper inspectable”). Added strict string checks and exact nested evidence keys. Regressions prove malformed state is rejected and remains byte-for-byte untouched, including on acceptance updates.

Advisory smell: **possible Duplicated Code** in bounded JSON readers, per-file directory locks, and terminal escaping across modules. Consolidation is nonblocking and intentionally deferred: the readers have different symlink, corruption, and permission contracts. No speculative common abstraction was added.

## Spec

**P1 — P2, fixed: non-regular files could hang memory reads and startup discovery.** `src/memory/store.ts:111`, `src/mcp/config.ts:67`, `src/lsp/config.ts:28` opened paths in blocking mode before checking their type (discovery had no type check). A FIFO without a writer never reached rejection. This violated Phase 9's “Regular files only” / fail-closed contract and §38's lazy, responsive startup goals. Memory now uses nonblocking open before descriptor validation; MCP/LSP discovery does likewise and reports a diagnostic for non-regular files. Existing config symlink compatibility is preserved; memory still rejects final symlinks.

**P2 — P2, fixed: explicitly selected repository scan scope escaped through symlinks.** `src/visualize/repo.ts:53` checked lexical containment, then followed an external directory symlink passed as scope. The repo-scope contract says the scan stays inside the project. Canonical root/scope checks now reject this static escape; segment-aware checks also allow legal names beginning with two dots. This is not a hostile-filesystem race sandbox: another same-user process can still mutate a scanned tree.

**Deferred requirements (not relabeled complete):**

1. Interactive MindMesh (§17A) remains missing; the adapter exports files for manual import.
2. Phase 9 remains partial: reference search, `casper learn`, and reviewed human promotion are pending; its full independent review gate remains open.
3. Optional real-HPE deployment acceptance remains pending explicit endpoint/credential authorization. Local MCP fixtures are not production acceptance.

## Red → green evidence

- `bun test tests/phase9-memory.test.ts`: before fixes **5 pass / 2 fail**. FIFO worker hit its 1-second kill deadline; malformed enum state unexpectedly resolved. After fixes **7 pass / 49 assertions**.
- `bun test tests/phase6-review.test.ts -t 'repository scope'`: before fix **1 fail** (external symlink scan unexpectedly resolved); after fix passed, including canonical workspace aliases and `..sources`.
- `bun test tests/review-config.test.ts`: before fixes **2 fail**, both FIFO workers hit their kill deadlines; after fixes **2 pass / 12 assertions**.
- Combined targeted suites: **21 pass / 130 assertions**, about 0.75 seconds.
- Final `bun run check`, three sequential runs: **204 tests / 1,186 assertions**, TypeScript passed every time. Wall times **63.259, 62.867, 63.024 seconds**.
- CLI `--help` and `git diff --check` passed. No debug logging or temporary repro sources were left in the repository. FIFO subprocesses are killed/drained on timeout and fixtures cleaned.

## Performance evidence

Initial current-tree gate, before these corrections: **199 tests / 1,157 assertions**, **62.26 seconds wall**, Bun test **58.64 seconds**. Final gate median: **63.024 seconds wall**, with five added regression tests. These different-sized runs do **not** establish a same-workload performance regression or optimization.

The reported historic 37→50 seconds is not a controlled comparison: no same-workload Phase 6–8 source snapshot was available in Git. Do not attach an optimization claim to safety changes or compare that history directly to this machine's current gate.

A separate same-workload comparison uses the **same five current Phase 0–3 test files** against archived Phase 3 source and current source, sharing the installed dependency tree. The two current fake-runtime `setTools()` compatibility additions are present on both sides; the archive is not advertised as a pristine historical dependency environment. All six final runs passed the 41-test workload:

| Run | Phase 3 source | Current source |
| --- | ---: | ---: |
| 1 | 8.534 s | 8.095 s |
| 2 | 8.611 s | 7.931 s |
| 3 | 9.037 s | 7.570 s |
| Median | **8.611 s** | **7.931 s** |

There is **no observed slowdown in this legacy-test sample**. This is not a model-latency, production-runtime, or individual-feature optimization claim. It excludes typecheck; alternating order is fixed baseline→current and timing remains sensitive to machine load/caches. New phases cannot be benchmarked against Phase 3 APIs that did not exist.

The median final full-gate run's summed per-test durations show where the workload goes: session/worktree tests **21.28 s**, real TypeScript/Pyright **8.56 s**, Pi subagent fixtures **6.64 s**, MCP tests **5.46 s**. These exclude runner overhead and are diagnostic attribution, not standalone feature benchmarks. Safety checks, deadlines, and real language-server coverage were not removed or relaxed.

Reproduce the matching-workload comparison (temporary archive; no checkout/reset or repository changes):

```sh
python3 scripts/benchmark-legacy-gate.py --baseline f8bb28e --runs 3 \
  --output /tmp/casper-legacy-gate.json
bun run check
```

Committed artifacts: `docs/benchmarks/review-legacy-gate.json` (environment, source/test/lock hashes, samples) and `docs/benchmarks/review-full-gate.json` (full-gate samples and per-file test durations). Local detailed logs were captured under `/tmp/casper-review/`; they are not required dependencies and may be deleted.

No external model, personal/production MCP, or credential/configuration changes were used in this pass. macOS was tested; Linux/Windows acceptance remains unproven. User-requested checkpoint includes existing Phase 4–9 work and these corrections; no push.

**Summary:** Standards—1 runtime defect fixed, 1 advisory duplication heuristic; Spec—2 runtime defects fixed, 3 disclosed scope/acceptance items deferred. No additional actionable runtime findings identified within this pass's coverage; independent full Phase 9 review remains pending.
