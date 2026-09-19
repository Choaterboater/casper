# Phase 7 — Debug and Performance Follow-up

Status: hardening/optimization complete locally; independent Phase 7 review remains pending. Phase 6's separate pending review gate is unchanged.

## Feedback loops

- Focused destructive/session loop: `bun test tests/phase7-sessions.test.ts`.
- Race loop: concurrent branch-store writers plus main/candidate mutations during approval; five consecutive focused runs passed.
- Real-Git timing harness: isolated temporary repository/home, 100 modified files, 224,880-byte patch, seven captures per sample.
- Repository gate: `bun run check`.

No credentials, user sessions, production repositories, external models, or services were used.

## Defects reproduced and fixed

1. **Source changed after approval.** Planning checked cleanliness, but creation did not repeat the check. Creation now revalidates repository, primary-worktree identity, clean status, base commit, branch absence, and managed parent after approval.
2. **Candidate changed during discard approval.** Cleanup could destroy changes that were not in the preview. Cleanup now captures and compares the exact patch identity immediately before removal; a changed candidate remains an open resumable branch.
3. **Main changed during apply approval.** Return now preserves both workspaces, records the branch as open, and reports the incomplete outcome rather than claiming success.
4. **Tampered/stale managed relations.** A manipulated manifest could point branch cleanup at the wrong ref after a worktree disappeared. Managed path, `casper/<name>`, slug, primary workspace, base hash, repository, registration, and branch relation are now validated before consequential operations and branch switches.
5. **Unsafe create rollback race.** A failed `git worktree add` could delete a same-named branch created concurrently. Rollback now removes only an exact registered managed path/branch pair.
6. **Ignored-file loss.** Ignored files are not representable in an exact Git patch and could have been deleted by forced cleanup. Return now refuses and preserves the worktree until those files are manually preserved or removed.
7. **Concurrent manifest lost updates/duplicate names.** Two Casper processes could atomically replace the same manifest while still losing one branch. A bounded per-project lock, reload/merge under lock, and create-only insertion preserve independent writes and reject duplicate branch creation. The regression was observed red (only `left` survived), then green with both branches and exactly one concurrent duplicate.
8. **Invalid UTF-8 patch corruption/failure.** Capturing `git diff` as a JavaScript string changes invalid bytes. A minimal old-path repro failed `git apply`; patches are now retained, hashed, piped, and compared as `Buffer` bytes. Regression coverage applies both Git binary content and invalid-UTF-8 text bytes exactly.
9. **Repository hook execution.** `git worktree add` can invoke `post-checkout`; Casper now overrides hooks and filesystem-monitor commands for all managed Git operations. A real executable hook regression proves it is not run.
10. **Terminal-control review spoofing.** Patch controls and bidirectional markers could affect confirmation display. The preview escapes them while the SHA-256 continues to identify the original bytes.
11. **Partial-outcome metadata.** Apply/cleanup failures could mark an unavailable or preserved branch as completed. Status now distinguishes completed outcomes, open recoverable worktrees, and missing cleanup-pending state; `/tree` displays cleanup pending.
12. **macOS canonical path mismatch.** `/var` versus `/private/var` aliases caused valid managed paths/runtime cwd checks to fail. Home/workspace comparisons now use canonical paths at filesystem boundaries.

## Optimization

Profiling showed safe candidate capture dominated by serial Git subprocess latency, not hashing or TypeScript work. Independent read-only operations now run concurrently:

- common-dir and worktree discovery;
- repository identity and worktree registration;
- patch, name list, and stat views over one prepared temporary index;
- main HEAD and cleanliness checks.

No validation was removed, cached across an approval boundary, or moved after a destructive operation.

Controlled A–B–B–A results (milliseconds; A = sequential, B = optimized):

| Sample | Create | Capture median (7) | Apply | Remove |
| --- | ---: | ---: | ---: | ---: |
| A1 | 389.55 | 301.34 | 501.34 | 503.05 |
| B1 | 377.04 | 209.30 | 362.23 | 341.24 |
| B2 | 377.90 | 196.87 | 334.76 | 348.12 |
| A2 | 417.92 | 311.01 | 521.28 | 481.86 |
| paired midpoint | **403.74 → 377.47** | **306.18 → 203.09** | **511.31 → 348.50** | **492.45 → 344.68** |
| change | **-6.5%** | **-33.7%** | **-31.8%** | **-30.0%** |

A post-hardening sample (byte-safe patches plus hooks/fsmonitor suppression) retained the gain: 218.71 ms capture median, 396.57 ms apply, 332.32 ms remove. These are local temporary-repository measurements on this machine, not general Git or end-to-end model latency claims.

## Final validation

- `bun run check`: TypeScript passed; **148 tests / 865 assertions**.
- Two additional complete Phase 7 runs: **11 tests**, both passed.
- Five focused race/concurrency repeats: **3 tests each**, all passed.
- `git diff --check`: passed.
- No `[DEBUG-*]` instrumentation remains.

## Remaining gates

- Independent Standards/Spec review for Phase 7.
- Independent review for Phase 6 remains separately pending and was not waived.
- Commit/push only if explicitly requested.
