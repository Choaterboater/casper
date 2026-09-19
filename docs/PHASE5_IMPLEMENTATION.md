# Phase 5 — LSP complete (within documented scope)

Implementation, real-language-server rename acceptance, and independent review gates are complete. All changes remain uncommitted and unpushed.

The user authorized starting Phase 5 after the Phase 4 handoff. Actual personal HPE deployment acceptance remains pending separately. No commit or push is authorized.

## Contract

Build the smallest Casper-owned, language-server-independent layer for diagnostics after edits, symbols, definitions, references, and rename. Acceptance requires a repository-wide language-aware rename with no new diagnostics. Pure edit tests alone do not meet that gate.

## OMP reference study

Reviewed selected sections of public `can1357/oh-my-pi`, `packages/coding-agent/src/lsp/`, as reference only; no OMP dependency or source copied:

- `edits.ts` (Git blob `dcb31725fa55eb03f313259ef5970ec10e5fa1b4`): original-snapshot coordinates, overlap preflight, ordered same-position inserts, separate workspace changes.
- `client.ts` (Git blob `078689e82764464e378a255ebf7a753a8a388224`): pending startup deduplication, client lifecycle, document versions, in-flight work excluded from idle cleanup.
- `diagnostics.ts` (Git blob `ef214c21eea97b7d4500caac8fc5ca232e3aca13`): version-aware push diagnostics and pull requests; failures must not masquerade as clean results. Casper should explicitly distinguish unknown/stale from complete rather than treating silence as an empty report.

Source directory: https://github.com/can1357/oh-my-pi/tree/main/packages/coding-agent/src/lsp

## Edit core

`src/lsp/edits.ts` provides pure UTF-16 text-edit preflight/application against one snapshot. It preserves line endings, validates bounds and surrogate boundaries, rejects overlaps/reversed ranges, and maintains same-position insertion order. Duplicate nonempty edits fail closed rather than being deduplicated. It is used by workspace rename preflight.

`tests/phase5-lsp-edits.test.ts` exercises this contract.

## Delivered layers

- `src/lsp/protocol.ts`: bounded Content-Length JSON-RPC transport, request deadlines/cancellation, late-reply isolation, client-request rejection, and process-group teardown.
- `src/lsp/config.ts`: metadata-only layered definitions and explicit process-local `/lsp connect` / `--lsp` consent.
- `src/lsp/manager.ts`: server-independent capability queries, document synchronization, honest diagnostic states, and serialized rename orchestration.
- `src/lsp/workspace.ts`: bounded full-workspace snapshots, untrusted edit parsing, path/range/version preflight, approval revalidation, and partial-write disclosure without destructive rollback.
- `src/lsp/tools.ts`: one runtime-neutral model tool for all Phase 5 operations.
- `src/runtime/types.ts` / `src/runtime/pi.ts`: native file-write diagnostics callback and shared file-mutation queues, with Pi imports confined to its adapter.
- `src/app.ts` / `src/cli.ts`: local status/connect/disconnect, exact interactive rename confirmation, one-shot denial, lazy runtime and deterministic cleanup.

See `docs/LSP.md` for the exact supported behavior and safety limits.

## Implementation checklist (delivered; review/validation recorded below)

1. Bounded stdio JSON-RPC transport and lifecycle: explicit opt-in command, no automatic installation, initialize/capability negotiation, UTF-16 negotiation, request deadlines/cancellation, crash isolation, deterministic shutdown. Fixture coverage for fragmented frames and late replies.
2. Server-independent manager: document open/change versions, symbols, definitions, references, and rename requests. Unsupported capabilities are explicit; diagnostics distinguish fresh, unversioned, unavailable, and timed out, rejecting stale publications. No unsolicited server `workspace/applyEdit` writes.
3. Workspace rename plan: parse server results as untrusted data; canonical project-bound paths, reject resource operations/unsupported edits, preflight all files, capture snapshots and document versions. Explicit approval of the exact plan; revalidate before writes. Partial writes are disclosed without automatic rollback; native file locks and snapshot revalidation protect ordinary concurrent edits.
4. Runtime-neutral tool integration and diagnostics after native edits. Keep Pi imports confined to its adapter and startup lazy. Shell writes are not automatically assumed to have fresh diagnostics.
5. Acceptance: a real local language server on a temporary multi-file repository; baseline diagnostics, rename declaration and cross-file references, verify unrelated identifiers unchanged, collect fresh post-edit diagnostics and run project checks. Missing diagnostics cannot pass. Independent Standards/Spec reviews and follow-ups completed before sign-off.

No visualization, debugger, sessions/worktrees, subagents, or memory belongs in this phase.

## Validation evidence

- Real TypeScript Language Server **6.0.0**: symbols, definition, references, and cross-file rename; unrelated same-name property unchanged; `tsc --noEmit` passes before/after. TLS publishes unversioned diagnostics, so these are not counted as strict fresh-diagnostic acceptance.
- Real Pyright **1.1.414**: baseline fresh zero diagnostics across a three-file repository; semantic rename updates declaration/import/call across two files, preserves an unrelated same-name string, and returns fresh zero diagnostics for all three files. Independent Pyright CLI project check passes. This meets the Phase 5 repository-wide rename/no-new-diagnostics gate.
- Both servers are pinned devDependencies used only on temporary repositories in automated acceptance tests, with no model credentials or external services.
- `tests/phase5-lsp.test.ts`: framing, config precedence, lifecycle, cancellation, stale/missing/unversioned/pull reports, rename approval, concurrent edits/reconnect, path escape/conflicts, partial I/O, and post-write server failure.
- `tests/phase5-app.integration.test.ts`: lazy local commands, one-shot denial, interactive exact approval, and actual Pi/local provider protocol evidence that native write diagnostics reach the next model request.

## Independent review follow-up

Two independent read-only Codex reviewers (gpt-6-astra, medium reasoning) covered the LSP sources, tests, fixture, integration changes, and documentation. Spec reported four P2 issues; Standards reported two P2 issues (one shared) and an optional duplicated-confirmation heuristic.

Resolved in the implementation:
- Open dependency changes could leave stale diagnostic evidence: synchronize all changed contents first, then invalidate reports and advance **all** open versions, including changed dependents. Preserve pending invalidation across failures and recheck open snapshots before returning evidence.
- New files during approval escaped rename membership validation: rescan bounded workspace membership before committing.
- Disconnect during precommit I/O did not cancel later writes: bind rename to the connection's lifetime and check cancellation before write/truncate operations.
- Failed synchronization advanced the local cache: update the cache only after notifications succeed. Partial `didChange`/`didSave` failure now closes the connection and requires explicit reconnect instead of replaying uncertain incremental ranges.
- Approval/native-lock callbacks could ignore cancellation indefinitely: race pre-mutation waits with abort, reject late mutation starts, but drain any filesystem mutation already in progress.
- Consolidated the interactive confirmation lifecycle while retaining separate MCP/LSP previews and budgets.

Eight failing-before/passing-after regression cases cover the initial findings and follow-up variants. A separate regression protects early cache advancement, corrected during the initial review. Both final independent reviews report all findings resolved and no new actionable findings. Full evidence: `docs/PHASE5_REVIEW.md`.

Initial completion `bun run check`: TypeScript passed, **109 tests / 541 assertions**. Three repeated Phase 5 suites passed at **38 tests / 152 assertions each**. `git diff --check` passed. All changes are preserved uncommitted/unpushed; Phase 6 is not started.

## Subsequent debug / speed / optimization pass

Complete: `docs/PHASE5_PERFORMANCE.md` records reproduced lifecycle/cancellation fixes, coherent batched diagnostics, linear framing, file-sized snapshot allocation, and controlled before/after measurements. Current full check: **117 tests / 596 assertions**, TypeScript passed; three repeats **46 tests / 207 assertions each**. Both independent follow-up review axes found no actionable issues. No safety checks were replaced with a persistent filesystem cache.
