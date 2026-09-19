# Phase 3 Pre-commit Review, Debugging, and Performance

## Scope and method

Base: `c8603ce6bae7e7ef6bcf5ffeaa2d9482d918396f` (Phase 2). Phase 3 was uncommitted, so `git diff c8603ce...HEAD` was empty. The effective review included `git diff c8603ce --` plus every untracked source/test/document file, captured with `git diff --no-index /dev/null <file>`.

Two independent Pi subprocesses reviewed standards and spec in parallel, with only read/grep/find/ls tools and no extensions, skills, or context-file injection. They reviewed the full diff and repository evidence. They did not edit files. Standards sources were the product plan's design rules and scoped README/implementation-plan contracts, plus the code-review skill's heuristic smell baseline. Spec sources were the Phase 3 user scope and local plan documents. No dedicated coding-standards or issue-tracker configuration was present; local specs were sufficient.

## Standards

Initial independent review: **two actionable findings, one heuristic suggestion**.

1. **Stale explicit-repair objective.** `src/app.ts` reused the last ordinary prompt for `/verify repair`, even if it was an unrelated read-only request. Fixed: explicit verification has its own objective; automatic post-task repair still receives its actual original task.
2. **Termination could wait forever for runtime startup.** `close()` drains startup, but the runtime interface does not offer startup cancellation. Fixed at the CLI boundary: signals synchronously request cancellation and give cleanup up to one second before process exit. The runtime boundary remains unchanged.
3. **Possible duplicated check-name list.** Config validation duplicated the canonical verifier names. Resolved by sharing `CHECK_NAMES` with validation.

Independent follow-up: **No blocking findings.** The fresh read-only reviewer checked all fixes against the current code and regressions, confirmed shared check names, and found no other blocking standards regressions.

## Spec

Initial independent review: **two substantive defects; no scope creep**.

1. SIGINT/SIGTERM could not reliably stop a repair waiting on stalled Pi startup, contrary to the documented cancellation behavior.
2. An unrelated earlier prompt could be presented as the explicit repair's original request, contrary to the evidence/constraint contract.

These are the same functional findings as the standards review and are fixed as described above. The reviewer confirmed the implementation stayed within Phase 3 and kept Pi behind the adapter.

Independent follow-up: **No blocking findings.** The fresh read-only reviewer confirmed the request-context and termination fixes, verified the additional shutdown/UTF-8 regressions, and found no other scope or behavior mismatches.

## Additional targeted debugging

Three other defects were reproduced with focused failing tests before fixes:

| Defect | Red signal | Fix |
| --- | --- | --- |
| Closing during an initial `--verify` model prompt could still launch verifier commands/repair afterward | Verifier marker file existed after close; expected absent | App-wide shutdown state checked across prompt/startup boundaries; startup drained and disposal idempotent |
| Runtime abort rejection skipped disposal | Disposal count 0; expected 1 | Teardown uses `finally` to drain verifier cleanup and dispose despite abort failure |
| Nontruncated UTF-8 could be corrupted at the 4096-byte capture split | Expected `étail`, received `��tail` | Join intact head/tail buffers before decoding |

Reviewer findings also received failing-then-passing regressions:

- Previous read-only request followed by `/verify repair test`: the old repair prompt contained the unrelated summary request; now it contains the explicit verification objective.
- Real subprocess with stalled injected runtime startup: SIGTERM previously needed the test's 2.5-second SIGKILL safety deadline (exit 137); now the CLI exits 143 under its own one-second deadline.

The shutdown suite covers real verifier process-group cleanup, model prompt completion after abort, late runtime startup, repeated close calls, and abort errors. Git changed-file collection also receives the verification abort signal.

## Lightweight performance check

No speculative optimization was applied. Measurements were taken on the current macOS/Bun 1.4.0 environment:

### Startup comparison

Phase 2 was extracted with `git archive c8603ce` into a temporary directory and used the same installed dependencies. Each revision ran the real CLI `/project` against the same fixture with isolated HOME, no model, and cached project detection. Two warmups per revision, followed by seven alternating subprocess measurements:

| Revision | Median | Observed range |
| --- | ---: | ---: |
| Phase 2 | 379.08 ms | 348.45–417.30 ms |
| Phase 3 | 376.41 ms | 361.24–428.78 ms |

Conclusion: no clear startup regression in this small sample; the roughly 3 ms difference is not a claimed speedup. Lazy model startup remains intact.

### Output stress

A real shell command emitted repeated 64 KiB buffers. Each measurement used a fresh verifier process; peak RSS is the verifier process, not a whole-system memory profile.

| Emitted stdout | Retained evidence characters | Duration | Peak RSS |
| --- | ---: | ---: | ---: |
| 1 MiB | 8,218 | 86 ms | 30 MiB |
| 64 MiB | 8,218 | 93 ms | 41 MiB |
| 256 MiB | 8,218 | 262 ms | 46 MiB |

All commands passed with `truncated: true`. The retained string is 8 KiB of original ASCII bytes plus the truncation marker. Memory was not proportional to total emitted output. This is a bounded-output smoke, not an exhaustive profiler or adversarial-process guarantee.

## Validation

- `bun run check`: TypeScript passed; **41 tests, 225 assertions**, no failures.
- Three consecutive Phase 3 suite runs: **22 tests, 109 assertions** each, no failures.
- `git diff --check`: passed.
- Real CLI/Pi failure → repair → targeted rerun → full selected-suite rerun: post-review repeat passed with all fixes applied. `bun test` exited 1, Pi repaired only `sum.ts`, and Casper's two independent reruns exited 0; CLI exit 0. Saved session evidence included the actual `Expected: 5 / Received: -1` diagnostic. Test/config/rules were unchanged; separate `bun test` passed (1 test, 2 assertions). Temporary auth copy was removed. See `docs/PHASE3_VERIFICATION.md`.
- No dependency pins or runtime-adapter files changed.
- No temporary debug logging or benchmark fixtures were added to production code; temporary harnesses remain outside the repository.

## Remaining limitations

Existing Phase 2 limitations still apply. Verification is opt-in repository shell execution, not a sandbox. Check strings are frozen, but their scripts can be changed by the model; preventing test weakening remains prompt guidance. Output is bounded/discarded rather than stored as a full artifact. Configuration/command discovery still requires restart to refresh. The task classifier is lexical. Windows descendant cleanup is not validated. CLI termination has a forced-exit deadline; programmatic close and model work have no independent runtime deadline.

**Final summary:** Standards: 2 actionable findings fixed, 1 heuristic suggestion resolved; no outstanding blockers. Spec: 2 actionable findings fixed, no scope creep; no outstanding blockers. Additional targeted debugging: 3 defects fixed with regression coverage.
