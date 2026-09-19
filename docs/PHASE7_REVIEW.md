# Phase 7 — Independent Standards / Spec Review

## Method and status

User-confirmed baseline: `f8bb28eaf0b79d3279587f5960657d1023e7555b` → current working tree, including untracked files. `git log f8bb28e..HEAD --oneline` is empty; a three-dot committed diff alone would miss this work. Phase 4/5 standalone changes were excluded.

Separate read-only Codex processes (`gpt-6-astra`, medium reasoning) ran each phase/axis independently, with user config/MCP disabled (`--ignore-user-config`), `--ephemeral`, and `--sandbox read-only`. Subsequent independent follow-ups verified corrections. Reviewers did not edit or run filesystem-writing suites; execution evidence belongs to the coordinator. Authorized reviewer-model calls were made, not production MCP connections or live Casper feature acceptance.

Standards sources: README, `docs/CASPER_COMPLETE_PLAN.md`, implementation documents and applicable safety contracts; no dedicated coding-standards file. Fowler smell baseline was supplied as optional heuristics. Spec source: complete plan and the phase-specific supported contracts.

**Final runtime disposition: reported actionable runtime findings resolved; no new actionable findings in the final follow-up.** Interactive MindMesh remains a separately disclosed broader §17A gap: JSON export is not interactive integration, and full §17A compliance is not claimed. Optional duplication heuristics remain advisory, not blocking violations. No commit or push.

## Standards

### Initial independent report

# Phase 7 — Standards

**Actionable findings**

- **P1 — Failed creation can delete another creator’s worktree.** [worktree.ts:215–223](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:215). Two processes creating the same name can both pass the branch-existence check. Once one registers the worktree, the other’s failed `worktree add` finds that identical path/branch and forcibly removes it, including newly written files. Matching deterministic names does not establish ownership. Serialize creation and restrict rollback to resources owned by that attempt. Breaches [CASPER_COMPLETE_PLAN.md:2362](/Users/stephenchoate/Documents/Casper/docs/CASPER_COMPLETE_PLAN.md:2362), `confirmDestructive: true`; creation approval does not authorize deleting another operation’s work.

- **P1 — Cleanup can destroy changes made after its final snapshot.** [worktree.ts:303–329](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:303). After `capturePatch()` matches the approved hash, additional asynchronous Git calls precede unconditional forced removal. An editor/process writing a new file during that interval loses unreviewed content. Breaches [SESSIONS.md:32](/Users/stephenchoate/Documents/Casper/docs/SESSIONS.md:32): “If the candidate changes after review, destructive cleanup is refused.” Establish exclusive ownership of the cleanup snapshot or preserve the worktree when concurrent writers cannot be excluded.

- **P2 — Failed workspace rebinding retains old connection consent.** [app.ts:463–480](/Users/stephenchoate/Documents/Casper/src/app.ts:463). Runtime switching occurs before this method, but destination configuration loads before old MCP/LSP connections close. Reproduce by connecting services, making the destination `.casper/project.yaml` malformed, then approving a switch. Loading throws; interactive execution continues with the destination runtime cwd but old project context and connected capabilities. Breaches [SESSIONS.md:25](/Users/stephenchoate/Documents/Casper/docs/SESSIONS.md:25), requiring old connections to close and fresh consent. Revoke capabilities before switching and block prompts until rebinding succeeds.

**Optional heuristic**

- **Possible Duplicated Code — judgment call:** [worktree.ts:51–85](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:51). Both helpers repeat `execFileAsync("git", safeGitArgs(args), ...)` and identical error handling. A shared execution helper could prevent safety-option drift; retaining separate string/Buffer interfaces is reasonable.

**Coverage/limitations:** Reviewed scoped tracked changes against the supplied baseline and scoped new files in full, plus relevant dependencies. Commit log was empty. Excluded standalone other-phase findings. Static analysis only: no tests, edits, service calls, or other reviewers’ outputs.

### First independent follow-up

# Phase 7 — Standards

**Resolved findings**

- **P1 creation ownership:** Same-name creation is serialized. Rollback now requires successful creation and uses non-forced removal, preventing a failed contender from deleting the winner’s worktree.
- **P1 late-write loss:** Atomic rename preserves candidate files, including late untracked/ignored content and open-handle writes. This addresses the original deletion race under the revised recovery contract.
- **P2 stale capability consent:** Capabilities are revoked before runtime movement; failed rebinding blocks subsequent commands until recovery.

**New actionable finding**

- **P2 — Cleanup prunes unrelated worktrees without approval.** [worktree.ts:359–363](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:359) runs repository-wide `git worktree prune --expire now`. Reproduction scenario: create another unlocked linked worktree, temporarily rename its directory or disconnect its storage, then approve `/switch main discard` for a Casper experiment. Cleanup also removes the unrelated worktree’s administrative state, including its index; restoring its directory leaves a broken Git link and loses staging state. Git’s installed documentation confirms this repository-wide behavior. This breaches [CASPER_COMPLETE_PLAN.md:2362](/Users/stephenchoate/Documents/Casper/docs/CASPER_COMPLETE_PLAN.md:2362), `confirmDestructive: true`: approval covers the displayed candidate, not unrelated worktrees. Restrict unregistration to the owned candidate while retaining the atomic-rename preservation strategy.

**Remaining optional heuristic**

- **Possible Duplicated Code — judgment call:** [worktree.ts:51–85](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:51) still repeats `execFileAsync("git", safeGitArgs(args), …)` and matching error handling in string/Buffer helpers. Sharing execution logic could prevent safety-option drift; separate typed interfaces remain reasonable.

**Coverage and limitations:** Reviewed scoped working-tree changes against the supplied baseline, scoped new files in full, and relevant dependencies. Commit log was empty. Excluded standalone other-phase findings and other reviewers’ outputs. Static review only: no tests, edits, commits, pushes, or service calls. The coordinator’s reported test results were not independently verified.

Interactive MindMesh remains the disclosed broader §17A integration gap; this review does not establish complete spec compliance.

### Second independent follow-up

# Phase 7 — Standards

**Resolved on static inspection**

- Same-name creation ownership, candidate-byte preservation, and capability revocation/rebind protections remain in place.
- Repository-wide pruning is gone. Locked-cleanup errors now carry the recovery path into persisted session metadata.
- Artifact creation/deletion uses a held directory descriptor and a fixed-arity native bridge. No additional actionable native-resource finding identified.

**Remaining actionable finding**

- **P2 — Cleanup can unregister an unrelated worktree through a redirected `.git` file.** [worktree.ts:364–376](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:364) obtains `admin` from the candidate’s mutable `.git` pointer and checks only its parent directory. It never verifies that this administration directory belongs to the approved path/branch.

  Reproduction scenario: create candidate A and unrelated unlocked worktree B in the same repository; stage content in B and temporarily move B offline. During A’s discard confirmation, replace A’s `.git` contents with B’s pointer. Patch revalidation uses a temporary index, so unchanged candidate content still passes. Cleanup then repairs **B’s** registration onto its placeholder and force-removes it, deleting B’s index and registration. A’s registration remains.

  This breaches [CASPER_COMPLETE_PLAN.md:2362](/Users/stephenchoate/Documents/Casper/docs/CASPER_COMPLETE_PLAN.md:2362), `confirmDestructive: true`: approval concerns A, not B. Validate the administration directory’s reverse `gitdir` link and branch against the approved relation before moving it; revalidate ownership before removal. Add this redirected-pointer regression alongside the offline-worktree test.

**Optional heuristic**

- **Possible Duplicated Code — judgment call:** [worktree.ts:57–89](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:57) repeats `execFileAsync("git", safeGitArgs(args), …)` and matching error handling. Sharing execution plumbing could prevent drift; separate string/Buffer interfaces remain reasonable.

**Coverage/limitations:** Inspected scoped working-tree changes against the supplied baseline, scoped new files in full, both native artifact files, and relevant dependencies. Commit log was empty. Static inspection only; the reproduction above was not executed. No tests, edits, commits, pushes, service calls, or other reviewers’ outputs. Reported test passes were not independently verified. Interactive MindMesh remains the disclosed broader-plan gap, not completed runtime integration.

### Final targeted independent verification (Phases 6 and 7)

**Phase 6 — Standards**

Resolved by static inspection:

- Artifact persistence now walks every canonical destination component using held directory descriptors and `openat`/`mkdirat` with `O_NOFOLLOW`. Creation and cleanup remain descriptor-relative. The fixed-arity C bridge handles errno and owner-only modes; acquisition failure paths close descriptors. See [artifacts.ts:32](/Users/stephenchoate/Documents/Casper/src/visualize/artifacts.ts:32).
- Explicit modification requests now override incidental “as a diagram” wording while explicit visualization requests retain priority. The reported “fix the crash when exporting as a diagram” example selects modification and all four checks, consistent with README verification policy.
- Regression tests cover missing-directory ancestor swaps, artifact-directory replacement, cancellation cleanup, and classification precedence.

**New actionable findings:** None identified in this targeted pass.

**Phase 7 — Standards**

Resolved by static inspection:

- The prior unrelated-worktree unregister finding is addressed. Cleanup binds administration before snapshot, checks the reverse `gitdir` link, canonical candidate path, and symbolic branch, then revalidates before rename. Placeholder repair/removal uses the bound administration path without rereading the moved candidate’s pointer. See [worktree.ts:330](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:330) and [worktree.ts:412](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:412).
- The redirected-pointer regression substitutes B’s pointer after A’s final snapshot and asserts rejection, preservation of B’s index/registration, and retention of A’s directory.
- Separate tests cover unrelated offline worktrees and locked cleanup. Session integration carries `WorktreeCleanupError.preservedPath` into persisted metadata and `/tree`.

These corrections respect the documented approval boundary and preserve the runtime seam.

**New actionable findings:** None identified in this targeted pass.

**Separate broader-plan gap:** Interactive MindMesh remains disclosed as unimplemented; file export does not establish full §17A compliance.

**Evidence limits:** Read all requested files and relevant session integration. Static inspection only: no tests, native execution, destructive reproductions, edits, or service calls. No opposite-axis reports consulted. The documented same-UID/OS boundary remains applicable. Git inspection emitted sandbox-denied cache-write diagnostics; no execution success is inferred from supplied test claims.

## Spec

### Initial independent report

## Phase 7 — Spec

- **P2 — Restart overwrites saved conversation linkage.** Complete plan §27 requires preserving “conversation history.” [src/sessions/manager.ts:251–256](/Users/stephenchoate/Documents/Casper/src/sessions/manager.ts:251) records the newly started runtime as the outgoing named session without resuming its saved conversation. Reproduce: create an experiment, exit, restart from main, then `/switch experiment`. Pi creates a fresh main session, and the manifest replaces main’s original session reference. Returning to main loses access to its original history through Casper. Starting inside an experiment similarly labels it active without loading its saved session. Resume or explicitly distinguish fresh sessions before updating persisted references.

- **P2 — Failed rebinding leaves capabilities targeting the previous workspace.** The session contract says switching “closes old MCP/LSP connections” and “requires fresh connection consent” (`docs/SESSIONS.md:25`); complete plan §27 requires preserving “workspace branch/worktree relation.” At [src/app.ts:463–480](/Users/stephenchoate/Documents/Casper/src/app.ts:463), configuration loading precedes teardown, although the runtime has already switched. Reproduce: connect capabilities in main, introduce invalid `.casper/project.yaml` in an existing experiment, then switch there. Loading throws; the interactive loop continues with native tools in the experiment but project context and connected capabilities still targeting main. Preflight the destination or fail closed and restore a coherent workspace.

- **P2 — Ignored files in main cause failure after successful application.** Phase 7 requires a “return-to-main workflow”; its contract promises to “apply that exact patch to main … and clean up the worktree/branch” (`docs/SESSIONS.md:29`). [src/workspace/worktree.ts:295–299](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:295) applies first, then calls candidate capture against main, whose ignored-file check throws. Reproduce with a Git-clean main containing ignored `.env`, an experiment without ignored files, and one tracked edit. Main receives the patch, but return reports failure and leaves the experiment open; retry fails because main is now dirty. This differs from the documented candidate ignored-file restriction. Separate cleanup eligibility from applied-diff comparison.

Coverage: scoped working-tree diff, all scoped new files in full, relevant spec sections, and adjacent dependencies. HEAD equals baseline. Findings are static traces; no tests, edits, service calls, or reviewer outputs used. No Phase 7 scope-creep finding.

### First independent follow-up

## Phase 7 — Spec

**Resolved:** All three prior findings are addressed: startup resumes saved conversation linkage before manifest updates; transitions revoke capabilities before moving and block commands after failed rebinding; ignored files in main no longer invalidate applied-diff comparison.

**New actionable findings:**

- **P2 — Cleanup unregisters unrelated worktrees.** Phase 7 requires “safe experiment worktrees”; §27 requires preserving the “workspace branch/worktree relation.” [src/workspace/worktree.ts:359–363](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:359) runs repository-wide `git worktree prune --expire now` after renaming the approved candidate. Scenario: another unlocked worktree resides on a temporarily disconnected drive, or was manually moved pending repair. Approving discard of Casper’s experiment also deletes that unrelated worktree’s administrative state, including its index, breaking its Git linkage when restored. Cleanup must unregister only the approved candidate.

- **P3 — Partial cleanup loses the persisted recovery location.** The adjusted contract promises: “The recovery path is printed and recorded in `/tree`” (`docs/SESSIONS.md`). At [src/sessions/manager.ts:321–340](/Users/stephenchoate/Documents/Casper/src/sessions/manager.ts:321), `preservedPath` is assigned only when cleanup returns successfully. Scenario: externally `git worktree lock` the candidate, then approve discard. Rename preserves its files, pruning skips its locked registration, and branch deletion fails. The error prints the recovery location, but the manifest stores only cleanup-pending status; after restart, `/tree` cannot locate the retained files. Return structured partial-cleanup information and persist the recovery path even when unregistering fails.

**Remaining scope gap — P3:** §17A specifies “MindMesh available? yes → interactive MindMesh.” [src/visualize/mindmesh.ts:38–58](/Users/stephenchoate/Documents/Casper/src/visualize/mindmesh.ts:38) only produces JSON, so an available MindMesh installation still receives no interactive integration. This remains the disclosed optional live-integration gap, separate from Phase 7 runtime defects.

Coverage: current scoped working-tree changes, scoped new files in full, relevant spec/component sections, regression-test sources, and adjacent dependencies. HEAD equals baseline. Findings are static traces, supported where relevant by installed Git documentation. No tests, edits, commits, pushes, service calls, or other reviewer outputs used; coordinator test results were not independently verified.

### Second independent follow-up

## Phase 7 — Spec

**Resolved:** Global pruning is removed; partial cleanup now persists its recovery path. Startup resumption, capability revocation/rebind blocking, and ignored-main-file handling remain corrected. The classifier handles the reported chart/draw cases. Artifact creation and unlinking now use a held directory descriptor.

**Remaining actionable findings:**

- **P2 — Cleanup can unregister another worktree through a substituted `.git` pointer.** Phase 7 requires “safe experiment worktrees”; §27 requires preserving the “workspace branch/worktree relation.” At [src/workspace/worktree.ts:364–376](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:364), the selected admin directory is checked only for membership under `.git/worktrees`. Scenario: replace the candidate’s `.git` file with another unlocked worktree’s pointer in the same repository, then approve discard. Registration validation still checks the original candidate’s listed path/branch, while `rev-parse` selects the other admin directory. Repair moves that registration onto the placeholder; removal deletes its index and administrative state. Validate the admin directory’s backlink and branch against the approved candidate before transferring ownership.

- **P3 — Directory creation remains vulnerable before descriptor pinning.** The explicitly requested visualization follow-up remains short of Phase 6’s requirement: “without affecting the code workspace.” At [src/visualize/router.ts:74–91](/Users/stephenchoate/Documents/Casper/src/visualize/router.ts:74), recursive `mkdir` precedes descriptor acquisition. Scenario: configure an absent `/outside/parent/new` destination, then replace `parent` with a workspace symlink after canonical validation but before `mkdir`. Casper creates `workspace/new`; subsequent validation rejects rendering but leaves that mutation. Directory creation also needs a validated, descriptor-relative parent.

- **P3 — Interactive MindMesh remains unimplemented.** §17A specifies “MindMesh available? yes → interactive MindMesh.” [src/visualize/mindmesh.ts:38–58](/Users/stephenchoate/Documents/Casper/src/visualize/mindmesh.ts:38) produces JSON only, including when MindMesh is installed. This remains a disclosed broader-plan gap, not completed Phase 7 runtime work.

Coverage: scoped working-tree changes, scoped new files in full, both native artifact files, relevant specifications, regression sources, and adjacent dependencies. HEAD equals baseline. Findings are static traces; no tests, edits, commits, pushes, service calls, or other reviewer outputs used. Coordinator test results were not independently verified.

### Final targeted independent verification (Phases 6 and 7)

**Phase 6 — Spec**

Resolved: The directory-creation race is addressed in [artifacts.ts:42](/Users/stephenchoate/Documents/Casper/src/visualize/artifacts.ts:42). Every destination component is opened or created relative to a held parent descriptor with `O_NOFOLLOW`; artifact creation and cleanup remain descriptor-relative. Failed acquisition closes held descriptors. The [native bridge](/Users/stephenchoate/Documents/Casper/src/visualize/artifacts.c:14) supplies fixed-arity wrappers, errno propagation, and owner-only creation modes.

The classifier correction at [classify.ts:35](/Users/stephenchoate/Documents/Casper/src/task/classify.ts:35) prevents “fix the crash when exporting as a diagram” from suppressing verification while preserving visualization priority for explicit show/map/draw requests.

No new actionable Spec findings in these corrections. The documented same-UID directory-movement boundary does not reopen the addressed symlink race.

**Phase 7 — Spec**

Resolved: [worktree.ts:332](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:332) binds administration before capture and revalidates it before rename. [boundAdministration:412](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:412) checks the reverse `gitdir` link, canonical candidate path, and symbolic branch. Placeholder repair/removal uses the saved administration path without rereading the candidate’s redirected pointer after rename.

Regression source covers substitution of B’s `.git` pointer after A’s final snapshot, preservation of B’s index/registration, unrelated offline worktrees, and locked-cleanup recovery metadata. Session manager/store integration retains `preservedPath` and cleanup status for subsequent `/tree` output.

No new actionable Spec findings in these corrections.

**Separate broader-plan gap**

Interactive MindMesh remains unimplemented: [mindmesh.ts:51](/Users/stephenchoate/Documents/Casper/src/visualize/mindmesh.ts:51) serializes JSON without opening an interactive session. With MindMesh available, rendering still requires manual import. This remains short of §17A’s “yes → interactive MindMesh”; full §17A compliance is **not** established.

Coverage: Fully read all seven requested files and session manager/store integration. Conclusions are static inspection only; no tests, native execution, cleanup reproduction, edits, or services were run. No opposite-axis report was read.

## Coordinator regression and validation evidence

- Reproduced creation contender deleting the winner, main ignored-file apply failure, and restart losing conversation linkage with failing temporary-Git regressions before fixes.
- Real Pi fixtures reproduced truncated tool loops exceeding the turn limit and cancellation during auth preflight still sending a model request; both now pass.
- Visualization tests cover collision IDs, action-vs-subject classification, output bounds, cancellation, swapped output directories and missing-directory ancestors. Descriptor-relative persistence includes a small Bun-native POSIX bridge, documented in `VISUALIZATION.md`.
- Cleanup now retains bytes by atomic rename, unregisters only the approved relation through an owned placeholder, validates the admin backlink/branch, and persists partial recovery metadata. Tests preserve unrelated offline worktree indexes and reject redirected `.git` pointers. See `SESSIONS.md`.
- App regressions cover failed-rebind consent revocation, blocked prompts until recovery, and concurrent delegation during workspace approval.
- Final `bun run check`: **194 tests / 1123 assertions**, TypeScript passed. `git diff --check` passed. Three earlier review-fix repeats passed 51 tests / 301 assertions each; later focused follow-ups and the final full check cover the additional fixes.

Phase 9 is a separately authorized next phase and needs its own review. These reviews do not sign off future Phase 9 edits to shared files.
