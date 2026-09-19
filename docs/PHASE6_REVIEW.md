# Phase 6 — Independent Standards / Spec Review

## Method and status

User-confirmed baseline: `f8bb28eaf0b79d3279587f5960657d1023e7555b` → current working tree, including untracked files. `git log f8bb28e..HEAD --oneline` is empty; a three-dot committed diff alone would miss this work. Phase 4/5 standalone changes were excluded.

Separate read-only Codex processes (`gpt-6-astra`, medium reasoning) ran each phase/axis independently, with user config/MCP disabled (`--ignore-user-config`), `--ephemeral`, and `--sandbox read-only`. Subsequent independent follow-ups verified corrections. Reviewers did not edit or run filesystem-writing suites; execution evidence belongs to the coordinator. Authorized reviewer-model calls were made, not production MCP connections or live Casper feature acceptance.

Standards sources: README, `docs/CASPER_COMPLETE_PLAN.md`, implementation documents and applicable safety contracts; no dedicated coding-standards file. Fowler smell baseline was supplied as optional heuristics. Spec source: complete plan and the phase-specific supported contracts.

**Final runtime disposition: reported actionable runtime findings resolved; no new actionable findings in the final follow-up.** Interactive MindMesh remains a separately disclosed broader §17A gap: JSON export is not interactive integration, and full §17A compliance is not claimed. Optional duplication heuristics remain advisory, not blocking violations. No commit or push.

## Standards

### Initial independent report

## Phase 6 — Standards

**Actionable findings**

- **P2 — Artifact writes can enter the workspace.** [router.ts:63–74](/Users/stephenchoate/Documents/Casper/src/visualize/router.ts:63) writes to the configured directory without checking repository containment or symlink resolution. Set global `visualize.outputDir` to the repository, or symlink the default artifact directory into it; `/visualize repo` then modifies the workspace. This breaches `docs/CASPER_COMPLETE_PLAN.md:2792` (“without affecting the code workspace”) and `docs/PHASE6_IMPLEMENTATION.md:28` (“Writes stay outside the workspace”). Validate the resolved destination against the active workspace before writing.

- **P2 — User IDs can collide with synthetic roots and cause stack overflow.** [types.ts:165–168](/Users/stephenchoate/Documents/Casper/src/visualize/types.ts:165), [mindmesh.ts:74–77](/Users/stephenchoate/Documents/Casper/src/visualize/mindmesh.ts:74). Reproduced with validated, two-node, edgeless mindmaps titled `Forest`: ID `__root__` crashes Mermaid; ID `casper-forest: root` crashes MindMesh. Projection attaches the synthetic root to itself. This breaches the explicit collision-safety invariant in `docs/PHASE6_IMPLEMENTATION.md:27`. Allocate an internal root identity distinct from all graph IDs.

- **P2 — Cancellation stops being checked before artifact persistence.** [router.ts:56–74](/Users/stephenchoate/Documents/Casper/src/visualize/router.ts:56). Abort during the final provider render or pending `mkdir`; execution still reaches every write. A read-only probe confirmed cancellation inside the last provider still resolves successfully. This contradicts the shutdown-cancellation contract documented in `docs/PHASE6_PERFORMANCE.md:15`. Recheck cancellation after awaited rendering and before each write, and drain visualization work during shutdown.

- **P3 — Repository graphs bypass documented IR byte limits.** [repo.ts:146–158](/Users/stephenchoate/Documents/Casper/src/visualize/repo.ts:146) bounds counts only. A source path exceeding 200 bytes becomes an oversized ID/label passed directly to providers. This breaches `docs/VISUALIZATION.md:21`, which requires byte limits and validation before providers. Normalize repository graphs through the same bounded IR contract.

**Optional heuristic**

Possible **Duplicated Code**—judgment call: `router.ts:88–89` and `mindmesh.ts:62–63` repeat the slug hunk, including `.replace(/^-+|-+$/g, "").slice(0, 60)`. Consider sharing normalization while retaining distinct fallbacks.

**Coverage/limitations:** Reviewed scoped working-tree changes and new files, including integration and tests; excluded standalone changes from other phases. Ran only in-memory probes, not test suites or artifact-writing reproductions. No files edited, services contacted, or other reviewers’ outputs read.

### First independent follow-up

## Phase 6 — Standards

**Resolved**

- Synthetic-root collisions: projection and MindMesh output now allocate separate, collision-free identities.
- Cancellation: checks follow rendering and persistence awaits; shutdown drains local visualization work.
- Repository IR bounds: generated graphs now shorten text, remap oversized IDs, and pass through validation.
- Original containment scenarios: direct workspace destinations and existing symlink aliases are rejected.

**Actionable findings**

- **P2 — New classification regression bypasses requested verification.** [classify.ts:33–38](/Users/stephenchoate/Documents/Casper/src/task/classify.ts:33) treats any occurrence of `chart` or `draw` as a visualization action. An in-memory probe confirmed both `"fix the chart export crash"` and `"refactor the draw function"` produce `mode: "read", verification: []`. Consequently, [app.ts:369–370](/Users/stephenchoate/Documents/Casper/src/app.ts:369) skips `--verify` after these modification requests. This breaches [README.md:200](/Users/stephenchoate/Documents/Casper/README.md:200), which assigns all four checks to fix/refactor tasks. Restrict precedence to actual visualization requests while preserving modification intent when those words describe the subject.

- **P2 — Artifact containment remains vulnerable to directory replacement.** [router.ts:99–106](/Users/stephenchoate/Documents/Casper/src/visualize/router.ts:99) validates a pathname, then independently opens it. Reproduction interleaving: after the final `realpath` check, another process renames the output directory and replaces it with a symlink to the workspace; `open(..., "wx")` follows that parent symlink and writes inside the repository. Exclusive creation protects the final filename, not ancestor directories. This still breaches [PHASE6_IMPLEMENTATION.md:28](/Users/stephenchoate/Documents/Casper/docs/PHASE6_IMPLEMENTATION.md:28), “Writes stay outside the workspace.” Bind creation to the validated directory identity. This finding follows from inspection; no filesystem race was executed.

**Optional heuristic**

Possible **Duplicated Code**, judgment call: `router.ts` and `mindmesh.ts` still repeat the slug hunk `.replace(/^-+|-+$/g, "").slice(0, 60)`. Sharing normalization is optional.

**Remaining scope and coverage**

Interactive MindMesh remains an explicitly disclosed §17A gap; full spec compliance is not established. Reviewed scoped working-tree/new files and applicable integration dependencies, including recovery-by-rename semantics. Excluded standalone other-phase findings. Ran only the read-only classification probe; no tests, edits, commits, pushes, services, or other reviewers’ outputs. The coordinator’s reported test results were not independently verified.

### Second independent follow-up

## Phase 6 — Standards

**Resolved**

By inspection, directory-relative creation/cleanup addresses the reported artifact-directory replacement race. The fixed-arity C bridge closes temporary descriptors and creates owner-only files. Synthetic-root identities, repository IR bounds, and cancellation checks remain corrected. The original chart/draw classification examples now retain verification. Cleanup no longer prunes globally, and locked-cleanup errors preserve recovery locations in the manifest.

**Actionable findings**

- **P1 — Requested cleanup correction can unregister another worktree.** [worktree.ts:364–376](/Users/stephenchoate/Documents/Casper/src/workspace/worktree.ts:364) accepts any administration directory under `.git/worktrees`, without checking its backlink against the approved path. Reproduction interleaving: after final candidate capture, replace its `.git` pointer with an unrelated, offline worktree’s administration path. The parent-directory check passes; placeholder repair/removal then targets that unrelated registration and index. This violates [SESSIONS.md:55](/Users/stephenchoate/Documents/Casper/docs/SESSIONS.md:55), requiring registration and managed-relation revalidation before consequential operations. Bind the administration identity and backlink to the approved worktree before repair/removal. **Inspection-derived; no destructive reproduction executed.**

- **P2 — Classification still suppresses requested verification.** A read-only probe confirmed `"fix the crash when exporting as a diagram"` returns `intent: "visualize", mode: "read", verification: []`. [classify.ts:33–39](/Users/stephenchoate/Documents/Casper/src/task/classify.ts:33) gives the unanchored “as a diagram” alternative precedence even when `modificationRequest` matches. Consequently, `--verify` skips checks. This breaches [README.md:200](/Users/stephenchoate/Documents/Casper/README.md:200): fix tasks select all four checks. Preserve explicit modification intent when visualization describes the failing operation.

**Optional heuristic**

Possible **Duplicated Code**, judgment call: the slug hunks in `router.ts` and `mindmesh.ts` repeat `.replace(/^-+|-+$/g, "").slice(0, 60)`. Shared normalization is optional, not a hard violation.

**Coverage and limitations**

Reviewed scoped working-tree changes, new visualization files fully—including both native bridge files—and the explicitly requested cleanup correction. Interactive MindMesh remains the documented §17A gap; it is not completed runtime functionality.

Ran only the in-memory classification probe. No tests, edits, commits, pushes, service calls, or other reviewers’ outputs. Native execution and Git failure scenarios were not independently exercised; coordinator test claims remain unverified.

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

# Phase 6 — Spec

1. **P2 — Diagram requests become modification tasks.** Spec §17A requires “Visualization is read-only by default” and includes “refactor scope” and “test/verification flow.” At [classify.ts:21](/Users/stephenchoate/Documents/Casper/src/task/classify.ts:21), lines 21–24 prioritize those subject keywords over visualization. Reproduced: “map out the refactor scope” becomes `modify`, omits the visualization tool, and can trigger verification/repair with `--verify`.

2. **P2 — Valid graph IDs crash both tree renderers.** Phase 6 acceptance requires a “useful visual.” At [types.ts:165](/Users/stephenchoate/Documents/Casper/src/visualize/types.ts:165), lines 165–168 attach synthetic roots without checking ID collisions. Reproduced using two disconnected nodes: ID `__root__` crashes Mermaid; title `Demo` with ID `casper-demo: root` crashes MindMesh. Both pass validation and raise `RangeError: Maximum call stack size exceeded`. Allocate synthetic IDs outside the input ID set.

3. **P2 — Artifact paths can modify the repository.** Phase 6 requires output “without affecting the code workspace.” At [router.ts:120](/Users/stephenchoate/Documents/Casper/src/visualize/router.ts:120), lines 120–123 resolve global `outputDir: diagrams` against process cwd. Reproduced resolution points inside this repository; rendering then creates artifacts there. Global-source validation does not enforce workspace exclusion. Resolve relative paths against a user directory and check canonical destination containment.

4. **P2 — Cancellation still permits artifact writes.** `PHASE6_PERFORMANCE.md` identifies “write artifacts after shutdown began” as a defect to fix. At [router.ts:59](/Users/stephenchoate/Documents/Casper/src/visualize/router.ts:59), lines 59–73 never recheck cancellation after the final provider or during persistence. Cancellation while awaiting `mkdir` still proceeds to `writeFile`. An in-memory provider that aborts before returning also produces a successful result.

5. **P2 — Interactive MindMesh remains missing.** Spec §17A specifies “yes → interactive MindMesh” when available. [mindmesh.ts:49](/Users/stephenchoate/Documents/Casper/src/visualize/mindmesh.ts:49), lines 49–58 only serialize JSON; an available MindMesh installation never receives interactive output. The implementation documents this deferral, but it remains an unmet original requirement.

Coverage: scoped working-tree diff and complete new files; adjacent runtime/result paths inspected. In-memory probes only; no writing suites, edits, external services, or other reviewers’ outputs. No actionable scope-creep finding.

### First independent follow-up

# Phase 6 — Spec

**Resolved:** Findings 2–4. Synthetic graph roots now avoid collisions; artifact paths resolve under the user home and undergo canonical workspace-exclusion checks; cancellation is checked after providers and filesystem awaits, with partial-artifact cleanup and app shutdown draining. In-memory probes confirmed collision rendering, relative-path resolution, and cancellation of inline rendering.

**Remaining:**

1. **P2 — Finding 1 only partially fixed.** §17A requires “Visualization is read-only by default” and supports “refactor scope” and “test/verification flow.” At [classify.ts:33–41](/Users/stephenchoate/Documents/Casper/src/task/classify.ts:33), the new precedence rule misses ordinary diagram requests. In-memory reproduction: “show me a diagram of the test flow” returns `test/modify`; “show me the refactor scope as a dependency graph” returns `refactor/modify`. Both omit the visualization tool and can invoke verification/repair with `--verify`. The original “map out” example is fixed.

2. **P2 — Finding 5 remains an outstanding integration requirement.** §17A specifies “yes → interactive MindMesh” when available. [mindmesh.ts:49–58](/Users/stephenchoate/Documents/Casper/src/visualize/mindmesh.ts:49) still only serializes JSON. An available MindMesh installation receives no interactive visualization. This is the disclosed optional-live-integration scope gap, not a newly introduced runtime defect.

**New regression:**

3. **P2 — Chart fixes lose authorized verification.** `IMPLEMENTATION_PLAN.md:180` specifies automatic verification/repair “after relevant modifying prompts” with `--verify`. At [classify.ts:33–38](/Users/stephenchoate/Documents/Casper/src/task/classify.ts:33), unconditional matching of `chart` overrides explicit modification intent. In-memory reproduction: “fix the chart export” now returns `visualize/read` with no checks, causing the app to skip requested post-task verification.

Coverage: scoped working-tree changes, complete new Phase 6 files and regression tests, and adjacent runtime/workspace integration. Examined recovery-directory cleanup as deliberate content preservation, not permanent deletion. No actionable scope-creep finding.

No test suites, filesystem-writing probes, external services, or other reviewers’ outputs were used. Coordinator-reported test results were not independently rerun.

### Second independent follow-up

# Phase 6 — Spec

**Resolved:** Prior classifier examples now return `visualize/read`; “fix the chart export” and “refactor the draw function” retain verification. Confirmed with in-memory probes. Synthetic-root collision fixes remain intact. Descriptor-relative artifact creation/cleanup addresses the previously reported post-validation swap. Worktree cleanup replaces global prune with placeholder removal and propagates recovery paths through `WorktreeCleanupError`.

**Remaining findings:**

1. **P2 — Workspace exclusion still has a directory-creation race.** Phase 6 requires a visual “without affecting the code workspace”; §17A says “Visualization is read-only by default.” At [router.ts:82–91](/Users/stephenchoate/Documents/Casper/src/visualize/router.ts:82), recursive `mkdir` runs before acquiring the validated directory descriptor. Reproduction scenario: configure `/safe/new`, with `/safe` existing and `new` absent; after canonical validation, rename `/safe` and replace it with a symlink to the workspace. `mkdir` creates `<workspace>/new`; subsequent validation rejects rendering but leaves that mutation behind. The descriptor fix protects later artifact operations only. An in-memory filesystem simulation confirmed creation precedes rejection; no actual filesystem race was executed. Directory creation also needs protection against pathname replacement.

2. **P2 — Interactive MindMesh remains missing.** §17A specifies “MindMesh available? yes → interactive MindMesh.” At [mindmesh.ts:49–58](/Users/stephenchoate/Documents/Casper/src/visualize/mindmesh.ts:49), rendering only serializes JSON. With MindMesh installed and available, a visualization request still produces files requiring manual import, without an interactive session. This remains the documented broader-plan requirement gap, not completed runtime integration.

**Coverage/limitations:** Inspected scoped working-tree changes, complete new visualization files—including both native bridge files—regression-test source, cancellation/resource handling, and adjacent worktree cleanup/recovery integration. No additional actionable scope-creep finding. No test suites, filesystem-writing probes, external services, commits, or other reviewers’ outputs were used. Native execution and Git cleanup were inspected statically; coordinator-reported results were not independently rerun.

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
