# Casper — next-session handoff

## Resume here: work-driven check tool checkpoint

Read the managed-tool follow-up in `docs/CODING_LOOP_EVIDENCE_CONTRACT.md` and the current README verification section before changing this slice. Run `git status --short` and `git log -1 --oneline`; preserve any later local changes. This user-requested checkpoint includes the evidence-contract correction and managed check tool. Everything below **Historical authorization** records earlier checkpoints, not current implementation instructions.

- `--verify` / `autoVerify: true` now offers `casper_check({ check: "test" })` during normal tasks. The model selects checks based on actual work; keyword classification no longer selects or filters checks. No selection means no recorded verification, including docs-only/no-change work.
- `src/verify/task.ts` shares task-local scoped evidence between the tool and the existing repair owner. Managed calls serialize; valid scoped passes are reused, observed input changes invalidate them, and captured tools expire at task end. Commands/scopes stay frozen. Native bash and `src/runtime/pi.ts` are unchanged.
- Only unresolved actual failures reach bounded repair after the primary prompt settles. No nested repair prompt. Successful managed checks during repair can avoid duplicate commands. Cancellation stops running/queued checks and retains already-executed evidence as blocked.
- `tests/work-driven-checks.integration.test.ts` exercises `CasperApp.runOnce()` and `RuntimeTool.execute()` with real commands. The added pinned-Pi/local-provider case in `tests/phase8-pi.integration.test.ts` proves native edit → check → reuse → later edit → failure → repair through Pi 0.85.1. Each vertical fixture executes the selected managed command **three times** (pass, fail, repaired pass), with one repair prompt and no additional human approval.
- Full validation: `bun run check` — TypeScript clean; **247 tests / 1,537 assertions**, **67.76 s** test-runner time. The first full run caught an unnecessary prompt-label compatibility change; that was corrected before this passing rerun. `git diff --check` is clean.

Limits: this is a managed subset, not transparent shell reuse or a live-model benchmark. Native signal-killed bash can still resolve successfully without exit metadata; its events remain diagnostics. Scope is a declaration, not discovered dependency coverage; observations are bounded/non-atomic and do not lock native/external writers. Unknown-scope or stale passes are rechecked once at normal task completion and remain qualified if still unavailable/stale. Repeated unknown-scope calls do not deduplicate. Model selection quality, comparative productivity/cost, and independent acceptance have not been evaluated.

Next useful step is review of this checkpoint against `7ce29ad`, not recovery/model controls or a broader autonomy change. The user explicitly requested this commit after validation. No live-model spending, credential access or push occurred. Further commits, pushes and broader work require separate authorization.

## Historical authorization: work-driven check tool agreed, not implemented

The user agreed to the tool-based next slice and wants to start a fresh session first. No OMP/Codex launch is required; an independent review afterward is optional. Preserve the existing uncommitted implementation, tests, README, and review/handoff documents. Do not reset to `7ce29ad` or mistake the original handoff below for current working-tree status.

Next slice:

- Add an opt-in `casper_check` runtime tool using Casper's existing command runner and frozen configured commands/scopes. Keep native bash unchanged. This is a deliberate managed-check subset, not transparent shell reuse.
- Replace request-keyword authority with actual-work-driven, model-selected checks. Keep Pi's ordinary edit/check loop; do not add a mandatory four-check pipeline or infer behavioral acceptance.
- Share task-local scoped evidence with the existing verification/repair owner: reuse valid passes, invalidate them after relevant edits, and feed actual failures into bounded repair. No nested repair prompt inside a tool execution.
- Agreed test seams: `CasperApp.runOnce()` and `RuntimeTool.execute()`, using real local commands, plus a pinned-Pi/local-provider integration fixture. Start with a failing vertical-path test; prove vague request → edit → relevant check → no duplicate valid pass → later input edit invalidation → failure → repair. Cover docs-only/no-change work, unknown scope, concurrent/partial edits, cancellation, and new-task isolation without claiming a live-model benchmark.
- Recovery/model controls, default autonomy changes, live-model spending, commits and pushes remain outside this authorization.

### SDK finding from the resume investigation

Inspected the pinned public Pi package (`@earendil-works/pi-coding-agent` 0.85.1), SDK/extensions documentation and tool examples. Local pinned SDK/extensions docs matched the installed Pi docs. Re-read relevant docs before implementing integration changes.

- `BashToolDetails` contains truncation/full-output information, not an exit code. Tool-event success remains diagnostic only.
- Public `BashOperations.exec` **does** expose actual `exitCode` and cwd; `createLocalBashOperations` and tool-definition factories are exported. Do not claim Pi has no trustworthy execution seam. Using that seam for native model shell calls requires owning/overriding the bash definition and preserving shell/prefix/environment semantics; the agreed smaller approach avoids that expansion.
- A temporary real-command probe wrapped `createBashTool` with `createLocalBashOperations`: `true` produced operation exit **0** and a resolved tool; `exit 7` produced exit **7** and a rejected tool; `kill -TERM $$` produced exit **null** but a **resolved** tool. Resolved results had no exit metadata. Never parse displayed output or promote `isError: false` into exit 0.
- The probe used no model or credentials, changed no repository source, and removed its temporary directory. The next slice has not been implemented or tested yet. Last full validation remains the 232-test run below.

Suggested new-session prompt:

> Read the current top sections of docs/HANDOFF.md and docs/CODING_LOOP_EVIDENCE_CONTRACT.md, then implement the agreed opt-in casper_check work-driven slice test-first at the listed public seams. Preserve all uncommitted work. Keep native bash unchanged, reuse only valid scoped evidence, and retain one bounded repair owner. No recovery/model expansion, live-model spending, commit, or push.

## Follow-up: evidence contract slice implemented (uncommitted)

After this handoff, the user approved the narrow contract-and-regression correction. Read `docs/CODING_LOOP_EVIDENCE_CONTRACT.md` and the updated README first for the current behavior, validation, limitations, and next step. Command success is now separate from scoped freshness; reuse requires a declared input scope, and durable outcomes preserve qualifications. `bun run check` passed: **232 tests / 1,396 assertions**, TypeScript clean. Work-driven selection and the full direct-loop proof are still pending; no recovery/model expansion, new default autonomy, commit, or push occurred.

The original handoff below is preserved as historical context, not a description of the new working tree. In particular, `workspaceState` now returns `{ fingerprint }` or `{ reason }`; the old availability probes need the updated interface shown in the new contract document. Preserve all existing uncommitted work.

## Start here (original direction-review handoff)

**Code checkpoint:** `7ce29ad` — `Checkpoint partial coding-loop evidence with freshness corrections`.

**Latest user request:** review the direction without defending the previous work, then write a fresh handoff. That review is complete; its new findings are **not fixed**. This session changed documentation only. No new commit or push was performed.

Read in this order:

1. `docs/CODING_LOOP_DIRECTION_REVIEW.md` — latest assessment, measured problems, reproducible probes, proposed next step.
2. `docs/CODING_LOOP_AUDIT.md` — agreed direct-loop direction and original gaps.
3. `docs/CODING_LOOP_REVIEW.md` — the earlier checkpoint's corrections, tests, and limits. Its successful review is not product-readiness approval.

Then run `git status --short` and `git log -1 --oneline`. Expected changes from this session are this replacement handoff and the new direction-review document, uncommitted. Preserve them and any newer user work. The earlier long historical handoff is preserved in Git: `git show 7ce29ad:docs/HANDOFF.md`.

## Bottom line

**The direction is right; the evidence implementation is still an experiment, not a completed daily-driver improvement.** Keep Pi's direct loop and the honest reporting fixes. Resolve evidence scope/result semantics and prove one useful edit → check → repair path before adding stalled-progress recovery or effort/model adjustment.

The latest review was a **single-agent self-review**, not independent review. No external inference or comparative real-task evaluation was performed. Do not claim neutrality is guaranteed or that Casper already reduces supervision/cost relative to Pi or OMP.

## What is actually implemented

- Pi owns the primary inspect/edit/shell loop. No score, factory pipeline, mandatory council or mandatory subagent.
- Automatic post-task verification remains **opt-in and keyword-selected**, filtered to available commands. Explicit missing checks remain skips; no applicable commands means incomplete evidence.
- Real verifier failures enter the existing bounded repair prompt in the same session. Useful edits survive failure/cancellation.
- Task receipts and `getLastTaskResult()` distinguish execution from optional verification. CLI handles terminal failure/abort. Pi-recovered provider errors are not terminal task failures.
- Native edit paths, possible tool writes (including partial/failed writes), and bounded exact-command shell diagnostics are observable.
- Raw Pi shell status is **not** a trustworthy exit code or reusable verifier pass. The provisional implementation that treated it as such was removed.
- Casper-run checks use bounded before/after whole-workspace fingerprints. Within one `verifyAndRepair` invocation, unchanged passing evidence may be reused. New requests and explicit `/verify` calls start fresh.
- Known-stale results produce incomplete reports. Unavailable fingerprints disable reuse but can accompany a passing command report with a warning. This distinction has practical problems below.

## Open findings that should drive the next session

### 1. Successful output-producing checks get an inconsistent aggregate result

A temporary project with unchanged `source.ts` and `.gitignore` excluding `dist/` ran:

```sh
mkdir -p dist; printf built > dist/output.js
```

Both executions exited **0**:

- Ordinary fixture: freshness **stale**, report **incomplete**, CLI mapping **2**.
- Same fixture with an unrelated symlink: freshness **unavailable**, report **pass**, CLI mapping **0**.

The fingerprint treats intended outputs as input changes; making observation unavailable improves the aggregate status. This was reproduced after the commit, not fixed. Full runnable probe is in the direction review. Do not merely suppress real stale-input evidence or turn every uncertainty into a mandatory failure gate.

### 2. Reuse is unavailable on Casper's own checkout in the measured state

`workspaceState(process.cwd())` returned unavailable in **5/5** probes (roughly 23–52 ms each). The cause was not diagnosed: the function returns only `undefined`, not a specific limit/error reason. This is not an end-to-end benchmark. Whole-tree requirements include ignored files and reject symlinks/special files/oversized trees. Do not simply raise budgets or silently exclude dependencies and claim complete input coverage.

### 3. Observed work still does not drive verification

`src/app.ts:403–407` still keys automatic verification on classification. `Continue` and `Make the login button work` select no checks even if work is subsequently done; a README typo can select broad checks. Native check reuse and actual-work-driven selection remain unfinished.

### 4. Durable outcomes lose the freshness qualification

`ProjectMemory.recordOutcome()` stores verification status and check name/status, not freshness/reason/scope. A pass with unavailable freshness loses its caveat in `/memory outcomes`. Human acceptance correctly stays unknown. Outcomes are not currently injected as model guidance—only explicit facts are—so do not exaggerate the impact. Preserve compact qualifications when revising the outcome contract; do not build an evidence database.

## Recommended next slice — propose before implementing

1. Agree on a small, consistent contract separating **command exit, input freshness, check scope, and behavioral coverage** across reports, CLI, repair and saved summaries.
2. Reproduce the successful-build/symlink inconsistency and introduce desired-behavior regressions. Existing passing tests partly encode the current policy, not proof it is the right policy.
3. Prove one vertical path: vague request → actual edit → relevant model-selected check → reliable execution evidence → no duplicate passing check → later input edit invalidates it → actual failure reaches repair.
4. Inspect the pinned public Pi SDK for a trustworthy execution observation seam. Do not parse terminal output or treat `isError: false` as exit 0. If native execution cannot be observed reliably, propose a small Casper check tool using the existing runner inside Pi's ordinary loop; label it as a subset, not transparent shell reuse.
5. Test source changes, docs-only work, artifact/coverage generation, later/partial/external edits, and a dependency-heavy repository. Measure actual command counts and user interruptions, not a new quality score.
6. **Only then** add evidence-based stalled-progress recovery, supported effort controls and explicitly approved model switches. Keep one recovery owner. Task stop/steer remains a near-term need.

Prefer narrowing or replacing the provisional fingerprint policy over layering another policy around it. The user has requested this review/handoff, not authorized a broad redesign, new default autonomy, or live-model spending.

## Relevant code

| Concern | Files |
|---|---|
| Prompt/receipt/verification integration | `src/app.ts`, `src/task/classify.ts`, `src/task/result.ts`, `src/cli.ts` |
| Runtime observations | `src/runtime/types.ts`, `src/runtime/pi.ts`, `src/runtime/observation.ts` |
| Execution/freshness/reuse/repair | `src/verify/command.ts`, `registry.ts`, `evidence.ts`, `workspace-state.ts`, `repair-loop.ts` |
| Durable outcome projection | `src/memory/store.ts` |
| Current regressions | `tests/coding-loop-evidence.test.ts`, `tests/phase3-app.integration.test.ts`, `tests/phase3-verification.test.ts` |
| Actual Pi/local-provider coverage | `tests/phase8-pi.integration.test.ts` and Phase 5 app fixtures |

Keep SDK-specific work in the runtime module, use the pinned public interface, and read its current docs before changing integration. No Pi fork or generalized event platform.

## Validation and limits

- Last full code-checkpoint gate: `bun run check` — **223 tests / 1,298 assertions**, TypeScript passed, **63.55 s** test-runner time.
- Latest direction-review rerun: `bun test tests/coding-loop-evidence.test.ts tests/phase3-app.integration.test.ts tests/phase3-verification.test.ts` — **40 tests / 214 assertions**, **10.13 s**.
- Latest probes: build-artifact/symlink status comparison, five actual-checkout fingerprint calls, current classification examples. Temporary fixtures removed; no repository source changed.
- Full suite was not rerun for the documentation-only direction review. No live-model quality, speed, cost, independent acceptance, or production-service claim.

## Constraints and parked work

- Preserve Pi's direct loop, useful edits, cancellation, and honest unknown/stale evidence. No scoring gates, mandatory agent pipeline, or repeated approvals for ordinary already-authorized local work.
- Automatic verification remains opt-in. Do not change model preferences, credentials, trust policy, or autonomy defaults as part of this handoff.
- No push. The previous commit authorization was used for `7ce29ad`; do not infer authorization for another commit from this documentation request.
- Phases 4–8 and Phase 9's facts/outcomes slice remain checkpointed at `db139f7` and later. Do not reopen unrelated MCP/LSP/worktree/visualization breadth. Interactive MindMesh, the rest of Phase 9, and real personal-HPE acceptance remain pending; no HPE/production access is authorized.
- No Jev/TypeSafe experiment or credential access. Historical research is design input, not authority to add a vendor or resume old experiments.

## Suggested first prompt for the next session

> Read docs/HANDOFF.md and docs/CODING_LOOP_DIRECTION_REVIEW.md. Review checkpoint 7ce29ad against the original direct-Pi-loop goal. Reproduce the successful-build/symlink freshness inconsistency, then propose the smallest correction to evidence scope and result semantics. Do not add recovery/model adjustment yet, do not restore fabricated shell exit evidence, and do not introduce scoring gates or a factory pipeline. Preserve the uncommitted review/handoff documents.
