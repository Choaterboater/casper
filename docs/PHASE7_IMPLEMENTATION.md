# Phase 7 — Sessions, Branches, and Worktrees

Status: implemented; independent Standards/Spec reviews and corrective follow-ups completed with runtime findings resolved. See `docs/PHASE7_REVIEW.md`. Cleanup now retains bytes in a recovery directory and unregisters only the approved worktree; the original performance numbers predate that safety change and are historical, not measurements of the current cleanup path. Nothing committed or pushed.

## Contract

Implement named session branches, safe experimental worktrees, and a reviewed return-to-main workflow. Expose `/tree`, `/branch <name>`, and `/switch <branch>`. Preserve conversation/task/project context and the workspace relation without forking Pi or creating duplicate conversation persistence.

## Investigation and design

Pi SDK 0.85.1 already provides persistent JSONL tree sessions, `SessionManager.forkFrom/open`, session naming, runtime session replacement with cwd override, and resource rebinding. Casper now adapts those APIs through `RuntimeSession`; Pi remains the sole owner of conversation entries and file format.

The locally installed OMP 18.2.6 behavior reinforced one useful boundary: conversation branching and worktree movement are distinct operations. Casper keeps that separation internally, but policy can attach a managed worktree relation to an explicitly named experimental branch. No OMP code or runtime dependency was added.

Casper's own state is deliberately small: branch name/parent/status, Pi session id/file, workspace/Git branch, and worktree base relation. It is stored atomically under `~/.casper/sessions/`. `src/sessions/manager.ts` is the workflow boundary; `src/workspace/worktree.ts` owns Git invariants and exact candidate transport.

## Delivered

- Pi runtime upgraded to `AgentSessionRuntime`, preserving the existing thin adapter/tool seam while allowing SDK-owned session replacement and cwd-specific service/resource recreation.
- Runtime-neutral session info/fork/switch/context methods; adapters that do not implement them fail explicitly only when branch commands need them.
- `/tree`, `/branch`, `/switch`, `/switch main apply`, and `/switch main discard`.
- Policy-layered `workspace.isolateWhen` defaults for `parallelAgents`, `riskyRefactor`, and `experimentalBranch`; Phase 7 uses the last one.
- Exact interactive confirmation for branch creation, every branch switch, and candidate apply/discard. One-shot mode denies these operations.
- MCP/LSP teardown and capability/project-context rebinding after cwd changes; prior connection consent is not carried into another workspace.
- Clean-source managed worktrees under `~/.casper/worktrees/<project-key>/`, with `casper/<name>` branches.
- Bounded full diff capture with a temporary index, including untracked and binary files; review identity is SHA-256.
- Candidate verification before post-verification diff capture, byte-exact revalidation after approval, atomic Git apply semantics, applied-state comparison, guarded cleanup, and concurrent manifest-write protection.
- Apply leaves reviewed changes uncommitted in main. No commit/push behavior was added.

See `docs/SESSIONS.md` for commands, policy, and safety semantics.

## Validation

`tests/phase7-sessions.test.ts` covers:

- policy defaults and layered overrides;
- tracked/untracked/binary/invalid-UTF-8 exact patch transport and no implicit commit;
- dirty source and source-changed-during-approval refusal;
- tampered managed relations, disabled repository hooks, ignored-file refusal, and terminal-safe review;
- concurrent independent manifest writes and duplicate-name exclusion;
- shared-workspace named branches when isolation is disabled;
- verification, reviewed apply, reviewed discard, and failed-verification preservation;
- candidate mutation during approval, preserved open-branch recovery;
- lazy `/tree` and fail-closed one-shot creation;
- the actual pinned Pi adapter cloning, naming, context persistence, cwd switch, and session resume in an isolated subprocess.

The real-Git tests use temporary repositories and homes. The Pi acceptance starts no model request and uses an isolated Pi agent directory. No user Pi sessions, Git repositories, credentials, or production services are touched. Final `bun run check`: TypeScript passed, 148 tests / 865 assertions; two additional full Phase 7 runs and five focused race repeats passed.

## Deliberate limits

- No bounded subagents yet; `parallelAgents` and `riskyRefactor` are policy vocabulary for later orchestration.
- No TUI branch picker, branch rename/delete command, automatic branch creation, auto-commit, merge commit, rebase, or push.
- Nested experimental branch creation is refused; experiments start from main.
- Return transport is a bounded exact patch, not `git merge`; oversized candidates remain for manual handling.
- Worktrees require a clean primary Git worktree. Non-Git projects and disabled isolation still get named Pi session branches in the shared workspace.
- Worktree isolation is operational separation, not a sandbox.

## Remaining gates

1. Independent Phase 7 review is recorded in `docs/PHASE7_REVIEW.md`; reported runtime findings are resolved.
2. Phase 6 review is recorded separately; its broader-plan interactive MindMesh gap remains open.
3. Commit only if requested.
