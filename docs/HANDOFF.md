# Casper — next-session handoff

## Resume here: native-edit invalidation correction checkpoint

The user requested this commit and handoff after approving the correction and parking two research references. This checkpoint builds on `43073d7` (`Add opt-in work-driven checks with task-local scoped evidence`). Resolve the current commit with `git log -1 --oneline`; run `git status --short` and preserve any later local work.

Read `docs/CODING_LOOP_EVIDENCE_CONTRACT.md`, especially **Native-edit invalidation review correction**, and the README verification section before changing this slice. No next feature is preauthorized.

## What this session completed

- Reviewed `7ce29ad..43073d7` against the opt-in `casper_check` agreement. Single-agent inspection and local validation, not independent review. One confirmed P2 spec finding: a scoped pass → observed native write creating an included file → native removal → another managed check reused the old pass because directory membership matched again.
- Corrected that finding in `src/verify/task.ts` and `src/app.ts`. Existing native edit/write observations invalidate matching frozen scopes until another execution. Per-check edit revisions cover observed edits during a running check; asynchronous freshness refresh cannot overwrite invalidation. Failed native edit/write paths conservatively invalidate possible partial writes without claiming completed edits.
- Kept scope boundaries and exclusions effective. Unrelated edits do not invalidate other checks. Invalidation neither selects checks nor depends on the receipt's 32-path display cap.
- Shared the same behavior with explicit repair through `src/verify/repair-loop.ts`, without exposing the managed tool to non-opted-in requests. There remains one bounded repair owner, after the primary prompt settles.
- Added six regressions in `tests/work-driven-checks.integration.test.ts` and one in `tests/phase8-pi.integration.test.ts`; strengthened the no-selection case. The original, overlapping-edit, partial-write and explicit-repair failures were reproduced before correction. The pinned-Pi native-write/removal case was also reproduced before the fix.

**Native bash, `src/runtime/pi.ts`, the command runner and dependency pins are unchanged.** No recovery/model controls, new autonomy default, filesystem watcher or shell override was added.

## Validation

Latest full gate, immediately before this checkpoint:

```sh
bun run check
```

- TypeScript clean; **254 tests / 1,581 assertions**, **0 failures**, **70.02 s** test-runner time.
- Earlier focused validation: **79 tests / 553 assertions** across verification/app, evidence, memory, managed checks and three selected pinned-Pi cases.
- The restored-membership Pi regression executes **two** real commands across check → native write → native removal → check → reuse.
- The existing edit/check/failure/repair vertical fixtures still execute **three** real commands with **one** repair prompt and no additional human approval.
- Separate temporary pinned-Pi cancellation and task-isolation probes passed: started-command evidence retained as blocked, queued work/descendants stopped, and new tasks plus explicit `/verify` start fresh. Temporary reproduction files were removed after passing reruns; permanent regressions remain in the repo.
- `git diff --check` clean. Tests use real local commands, language servers and scripted localhost providers; no live-model spending or production-service evaluation.

A deliberately early-returning fake runtime lost pending evidence in an exploratory probe, but that behavior was not reproduced with pinned Pi and was not promoted as a confirmed Pi-path finding or fixed. Do not relabel that probe as a production regression.

## Current contract and limits

- Managed checks remain opt-in (`--verify` / `autoVerify: true`). The model chooses relevant checks from actual work; no selection means no Casper verification recorded. Explicit `/verify` remains available and starts fresh.
- Command outcome, declared-input freshness, behavioral coverage and human acceptance remain separate. Fresh scoped evidence permits task-local reuse; it does not certify requested behavior or unlisted dependencies.
- Scope observations remain bounded/non-atomic and do not lock native/external writers. Unobserved shell/external changes still rely on those observations. Unknown or stale selected passes get one completion-time recheck, not a freshness-seeking loop; repeated unknown-scope calls do not deduplicate.
- Native shell events remain diagnostics, never process-exit evidence. Pinned Pi's signal-killed bash can still resolve successfully without exit metadata; no exit zero is inferred from that.
- No live-model selection/productivity/cost comparison or independent acceptance has been performed. Passing fixtures are not daily-driver readiness approval.

## Parked research — not a roadmap change

For a future **security review** or **CLI/TUI usability pass**, read `docs/REFERENCE_IDEAS_BACKBURNER.md`:

- Cloudflare `security-audit-skill`: useful trust-boundary and adversarial-validation guidance. Its full audit pipeline and OS-sandbox execution requirements are not implemented in Casper.
- `ayghri/i-have-adhd`: useful low-noise communication ideas, not authority to discard evidence, invent causes/estimates, or impose a persistent style. Treat accessibility as a user preference, not a diagnosis.

Both repositories were inspected at pinned revisions using public primary sources. Nothing was installed, activated or executed from them. Integration and paid experiments remain unapproved.

## Next session

Review this correction against `43073d7` before expanding the coding loop. Keep validation at `CasperApp.runOnce()`, `RuntimeTool.execute()` and the pinned-Pi/local-provider fixture; report any new findings before editing. Then agree the next bounded step with the user.

The user authorized this checkpoint commit only. **No push.** Further commits, live-model spending, recovery/model expansion, trust/autonomy changes, research integrations and unrelated phase work require separate authorization. Preserve useful edits and the single repair owner.

Suggested resume prompt:

> Read docs/HANDOFF.md and docs/CODING_LOOP_EVIDENCE_CONTRACT.md. Review the latest checkpoint against 43073d7, focusing on native-edit invalidation, overlapping checks, explicit repair, cancellation and task isolation. Validate at the existing app/tool and pinned-Pi/local-provider seams; report findings before editing. Keep the research references parked. No live-model spending, recovery/model expansion, commit or push.

## Historical context

`43073d7` introduced the managed tool and evidence contract; `7ce29ad` is the earlier partial-evidence baseline. Earlier handoff history is preserved with `git show 43073d7:docs/HANDOFF.md`. `docs/CODING_LOOP_DIRECTION_REVIEW.md`, `docs/CODING_LOOP_AUDIT.md` and the phase review documents remain historical design/review evidence, not authorization to resume their old instructions.
