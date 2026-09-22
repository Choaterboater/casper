# Casper Bug Review

Reviewed: 2026-04-02

## Scope

Static review of the current TypeScript source tree, with emphasis on process cleanup, configuration precedence, session/worktree identity, and persistent-state locking. The repository already contained uncommitted changes before this review, so findings describe the current working tree rather than a clean Git revision.

## Summary

| Severity | Finding | Primary location |
|---|---|---|
| High | POSIX process cleanup can report success when signaling failed | `src/platform/processes.ts:128-140` |
| Medium | An unmanaged linked worktree is classified as the main session | `src/sessions/manager.ts:139-147` |
| Medium | A crashed process can leave permanent lock directories | `src/sessions/store.ts:146-161`, `src/memory/store.ts:154-165`, `src/workspace/worktree.ts:194-207` |
| Low | Invalid shadowed profile settings override a valid higher-precedence selection | `src/config/load.ts:307-320` |

## Findings

### 1. High: POSIX process cleanup can report success when signaling failed

**Location:** `src/platform/processes.ts:128-140`

`terminateTree()` catches errors from `process.kill(-group, signal)`, handles only `ESRCH`, ignores all other failures, and then returns `"stopped"`. The direct-PID fallback also catches every error as if the process had already exited.

For example, `EPERM` means Casper did not have permission to signal the process; it does not mean the process stopped. Reporting `"stopped"` allows callers such as the verifier to proceed without activating their existing `"unknown"` cleanup-failure path.

**Impact:** A verifier, language server, MCP server, browser server, or descendant process may remain alive while Casper reports successful cleanup. This can leak processes and permit later work after cleanup was not actually confirmed.

**Recommended fix:**

- Treat only `ESRCH` as evidence that the target is absent.
- Return `"unknown"` for `EPERM` and other signaling failures, or throw a `ProcessCleanupError` that callers must preserve.
- Apply the same error discrimination to the direct-PID fallback.
- Add tests with a process-platform seam that throws `EPERM`; current POSIX use calls `process.kill` directly, which makes this failure path harder to test deterministically.

### 2. Medium: An unmanaged linked worktree is classified as the main session

**Location:** `src/sessions/manager.ts:139-147`

When startup occurs outside the primary worktree, Casper looks for an open saved branch matching the current path. If none exists, the expression falls back to `"main"` even though the process remains in the linked worktree.

That creates contradictory state: `activeName` and `/tree` identify the session as main, while the runtime current directory is not the main workspace. `rememberConversation()` subsequently expects `store.primaryWorkspace`, and `resumeActive()` may compare the linked-worktree path with a saved main-session path.

**Impact:** Starting Casper in a linked worktree that Casper did not create can produce misleading session status and later workspace-mismatch errors. It may also associate user intent with the wrong named session.

**Recommended fix:** Reject an unrecognized non-primary worktree at startup with a clear message, or explicitly create/bind a session record for that worktree. Do not silently select `"main"` unless `projectRoot` is the primary workspace.

### 3. Medium: A crashed process can leave permanent lock directories

**Locations:**

- `src/sessions/store.ts:146-161`
- `src/memory/store.ts:154-165`
- `src/workspace/worktree.ts:194-207`

These code paths use directory creation as a cross-process lock and remove the directory only in `finally`. If the owning process crashes, is killed, or the host loses power after acquisition, no process executes the cleanup. Every future operation sees `EEXIST`, retries for roughly two seconds, and then fails. There is no owner metadata, age check, liveness check, or documented automated recovery.

**Impact:** One abnormal exit can indefinitely disable session persistence, memory updates, or creation of a particular managed worktree until the user discovers and manually deletes internal lock state.

**Recommended fix:** Store owner metadata in each lock (PID, process-start identity, hostname, and acquisition time), then reclaim only locks whose owner is provably gone. Keep fail-closed behavior when ownership cannot be established. At minimum, include the exact lock path and safe recovery instructions in every error.

### 4. Low: Invalid shadowed profile settings override a valid higher-precedence selection

**Location:** `src/config/load.ts:307-320`

The candidates are ordered by precedence and `selectedProfile ??= value` keeps the first defined value. However, the loop validates every later candidate too. Therefore, a valid explicit `options.profileName` can still be rejected because a lower-precedence environment, project, or global value is malformed even though that value would never be selected.

**Impact:** Explicit recovery is impossible in some malformed-configuration cases. A user cannot temporarily override a bad lower-precedence setting with a valid CLI/API selection.

**Recommended fix:** Select the first defined candidate and validate that selected candidate only. If validating all layers is an intentional security policy, document that behavior as distinct from ordinary configuration precedence and add a diagnostic explaining that the rejected value was shadowed.

## Verification

- `bun run typecheck`: passed.
- `bun test`: many suites passed, but the command exceeded the 180-second review timeout before producing a final suite summary. This is not evidence that the complete test suite passed or failed.
- No production source was changed as part of this review.

## Suggested order of repair

1. Correct POSIX cleanup result handling and add deterministic failure-path tests.
2. Define and enforce startup behavior for unmanaged linked worktrees.
3. Introduce safely reclaimable locks shared by session, memory, and worktree state.
4. Clarify whether shadowed profile values should be validated, then align implementation, tests, and documentation.
