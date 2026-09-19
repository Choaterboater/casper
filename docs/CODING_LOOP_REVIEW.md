# Coding-loop partial checkpoint review

## Scope and method

Baseline: `db139f7` (`HEAD` before this checkpoint). Reviewed `git diff db139f7` and the original untracked audit, research, and task-result files, then corrective source/tests/docs. No staged changes were present at entry. User authorization: review the uncommitted evidence slice, fix correctness defects, validate, and commit a **partial checkpoint** before recovery/model work. No push.

Spec: `CODING_LOOP_AUDIT.md` agreed direction and the conversation's edit/check evidence requirements. Standards sources: that audit's bounded-observation contract and `CASPER_COMPLETE_PLAN.md` §§5–6 (thin runtime adapter, Pi owns the loop). No standalone coding-standard or issue-tracker file was found. Issue-linked review setup, if wanted later: `/setup-matt-pocock-skills`.

This was **single-agent** inspection and testing. No independent parallel reviewers or external inference were available/used. The two axes below are separate; test success is not behavioral acceptance of arbitrary coding tasks.

## Standards

**One evidence-bound violation corrected.** The provisional runtime changes forwarded arbitrary `event.args` and `event.result`, including full edit bodies and unbounded tool data, contrary to the audit §5 recommendation to expose only needed, bounded observations. `runtime/observation.ts` now retains only bounded identity fields and shell text, preserves truncation disclosure, and omits arbitrary details. Pi's pending input map is bounded and cleared on completion/rebind/disposal. Commands/output can still contain secrets: this is not general-purpose secret redaction.

A possible Feature Envy/duplication smell in app-owned output decoding was removed by placing normalization in the runtime module. This is a heuristic, not a separate standards breach. No new dependency, Pi fork, scoring subsystem, or orchestration pipeline was added.

## Spec

1. **Stale passes (corrected).** The event-counter cache could return a pass after external edits; failed/partial writes were ignored; successful checks could mutate inputs; overlapping edits were stamped with the revision at completion. Minimal regressions for external removal and later-verifier mutation both returned `pass` before correction. Reuse is now task-local to one `verifyAndRepair` invocation and limited to matching before/after local filesystem fingerprints. Final results are refreshed after later checks and failed/cancelled repair. Actual exits are retained, but known-stale passes yield an incomplete report. No repeated stale-state retry loop is added.
2. **Fabricated execution evidence (corrected by narrowing scope).** The provisional native-shell harvesting invented exit 0/1, duration 0, separated stdout/stderr that Pi actually combined, and `truncated: false`. Pi tool success also does not prove process exit 0 (the pinned bash implementation accepts a null exit code); extensions can modify tool results. Raw shell events now remain explicitly diagnostic observations, never cached verifier passes or authoritative repair failures. Casper-run checks supply real bounded command failures to the existing repair prompt. Safe reuse of native model-run checks is **deferred**, not declared delivered.
3. **Recovered provider errors (corrected).** The first-slice terminal-error latch incorrectly marked a task failed even after Pi retried successfully within `prompt()`. A regression emitted error then stop and reproduced `failed` rather than `completed`. Final response stop status now governs nonthrowing completion; thrown prompt failures and terminal abort/error still fail/cancel, preserve edits, and prevent automatic repair.
4. **Broader edit/check integration (partial, disclosed).** Automatic selection remains keyword-based and opt-in. Bounded native-edit paths, possible tool writes, and exact-command shell diagnostics are observable, but they do not yet select verification. Trustworthy native-shell execution observation/reuse, relevant input scopes, progress-aware recovery, effort/model controls, and task stop/steer remain pending. This checkpoint does not satisfy the entire second audit slice.

## Freshness contract and limits

- No cache across requests; explicit `/verify` always starts new command execution.
- Within one invocation, frozen verifier commands may reuse passing evidence when the whole bounded local filesystem identity matches. The multi-check regression selection is retained; targeted successful checks need not execute twice if no intervening local change is detected.
- Fingerprints include regular-file bytes, membership, permissions, identity and modification/change times, including ignored files and Git metadata. No broad checks/scans run after every native edit.
- Bounds: 1 MiB/file, 16 MiB total, 4,096 traversal/read/validation work items, and 500 ms checked between async filesystem operations. The time budget does not preempt a stalled kernel/filesystem call. Symlinks, special files, unsupported trees, mismatched verifier cwd, errors, or exhausted budgets yield unavailable freshness and disable reuse.
- Commands still run when snapshots are unavailable. `status: pass` then describes actual command exits with an explicit unavailable-freshness reason; it does **not** certify current workspace contents. Known changes yield stale/incomplete evidence without undoing work.
- This is not an atomic filesystem transaction, security sandbox, dependency graph, or proof about services/environment/dependencies outside cwd. No promise about changes after the final observation. Large/dependency-heavy repositories may not benefit from reuse. No performance improvement claim.
- Shell observations use tool-reported success/error and bounded combined output, with no invented process metadata. They are separate from persisted verification summaries and human acceptance. Unsupported adapters may supply no observations.

## Validation

Reproductions before fixes:

- `bun test tests/phase3-app.integration.test.ts -t 'review:'`: **2 failed**, stale pass after external removal and later-check mutation.
- `bun test tests/phase3-app.integration.test.ts -t 'recovered Pi'`: **1 failed**, recovered provider error remained terminal.

After corrections:

- Focused app/evidence/pinned-Pi suites: **39 passed / 223 assertions**.
- Final `bun run check`: **223 passed / 1,298 assertions**, TypeScript passed; test-runner time **63.55 s**. An earlier full run before the additional cwd-scope regression also passed (222 tests).
- `git diff --check`: passed.

Coverage includes actual temporary verifier commands, fresh targeted-result reuse with execution counts, failed/partial mutations, overlapping edits, unsupported/FIFO/symlink/oversized snapshots, byte/membership/permission changes, Unicode/truncation bounds, sanitized receipts, and a real pinned-Pi subprocess against a local deterministic provider. That Pi fixture correlates concurrent write/shell results, captures an actual shell failure, and confirms edit bodies and fabricated exit fields are not forwarded. Existing cancellation, session/worktree, MCP, LSP, memory and read-only delegation suites also passed.

Summary: **Standards: 1 corrected evidence-bound violation; Spec: 3 corrected correctness findings, 1 explicitly partial scope finding.** Independent review and live-model daily-task acceptance are not claimed.
