# Phase 5 — independent Standards / Spec review

## Scope and method

Two independent read-only Codex processes (`gpt-6-astra`, medium reasoning) reviewed Phase 5 and repeated focused follow-ups after fixes. They inspected all `src/lsp/*.ts`, `tests/phase5*.ts`, `tests/fixtures/lsp-server.ts`, LSP integration in app/CLI/runtime/public exports, dependency changes, and LSP documentation. The tracked comparison was `git diff f8bb28e -- …`; because Phase 4 was already uncommitted, reviewers explicitly excluded preexisting MCP changes and read the untracked LSP files in full. No prior Phase 4 sign-off was reused.

Standards authority: README, complete-plan runtime seam/generic core/safety/performance requirements, implementation plan, and adjacent code. There is no dedicated coding-standards file. Fowler smell heuristics were labeled optional judgments. Spec authority: `docs/CASPER_COMPLETE_PLAN.md`, Phase 5, and the detailed supported contract in `docs/LSP.md`; no issue-tracker document exists.

Reviewers did not modify files or run the filesystem-writing test suites. The coordinating agent ran the tests below. Initial review launches were interrupted before verdicts and were not counted; detached retry processes completed both axes.

## Standards

Initial findings:

- P2: updating the local document cache before synchronization succeeded could subsequently label stale server analysis fresh.
- P2: operation cancellation did not bound uncooperative approval/native-lock callbacks.
- Optional judgment: duplicated MCP/LSP confirmation lifecycle.

Follow-up identified the multi-document freshness variant below and a P2 partial-notification failure: `didChange` could succeed while `didSave` failed, leaving an unsafe old retry baseline.

**Final independent verdict:** both remaining cases resolved; **no new actionable P1/P2/P3 findings**. No regressions identified in workspace membership, cancellation, partial-write disclosure, late-callback guards, detached approval previews, or exact confirmation. The optional duplication was resolved with a shared lifecycle helper preserving separate budgets/previews.

## Spec

Initial findings:

- P2: changed open dependencies could leave stale matching-version diagnostics for unchanged dependents.
- P2: source files added during approval escaped workspace membership validation.
- P2: disconnect after the commit gate did not cancel remaining writes.
- P2: failed synchronization prematurely advanced the local cache (shared with Standards).

Follow-up found that simultaneous dependent/dependency changes and post-rename sequential synchronization could still retain premature matching-version reports.

**Final independent verdict:** both remaining cases resolved; **no actionable P1/P2/P3 findings**. No regressions found in prior safety fixes. Documented final filesystem check/write races and draining active OS I/O remain limitations, not new findings.

## Fixes and regression evidence

- Synchronize all changed contents first, then force fresh versions for **all** open documents. Keep refresh invalidation pending through failures and new dependencies. Recheck disk snapshots before returning evidence.
- Rescan bounded workspace membership and revalidate every original snapshot after approval and after acquiring native file locks.
- Bind rename to the exact connection lifetime; check cancellation after validation and before writes/truncation. Preserve possibly-modified paths on partial failure.
- Commit cached text/version only after synchronization succeeds. Close the connection on notification failure, including partial `didChange`/`didSave` delivery, and require explicit reconnect rather than replaying uncertain ranges.
- Abort-race approval and pre-mutation native-lock waits. Late callbacks cannot enter mutation; already-started I/O is drained for honest result reporting.

Eight failing-before/passing-after cases cover single and simultaneous dependency changes, post-rename ordering, new workspace members, mid-validation disconnect, ignored approval/lock cancellation, and partial synchronization. An additional regression covers the early-cache-advance defect, corrected during the initial review. All live in `tests/phase5-lsp.test.ts`.

## Final validation

- `bun run check`: TypeScript passed, **109 tests / 541 assertions**.
- Three final repeated Phase 5 suites: **38 tests / 152 assertions each**, all passed.
- Real TypeScript Language Server and Pyright acceptance tests included in full/repeated runs.
- Actual Pi/local provider protocol tests cover native-write diagnostics, one-shot rename denial, and interactive approved rename through shared native mutation queues.
- `git diff --check` passed.

One intermediate repeat hit a test-only 500 ms fixture request deadline. The isolated case passed 20 subsequent runs, with no leftover server processes observed. The default non-deadline fixture budget was raised to 2 seconds; deliberate timeout/cancellation tests retain their short explicit budgets. That failed repeat is not included in the three successful final runs above.

No real external model smoke, production server/device access, commit, or push was performed for Phase 5 acceptance. Automated language-server tests use temporary repositories. Optional personal HPE acceptance remains a separate pending authorization gate.
