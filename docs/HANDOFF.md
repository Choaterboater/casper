# Casper — next-session handoff

## Resume here: Phase 9 local reference search — checkpoint

The user approved resuming Phase 9 with **explicitly configured, read-only local
reference search**, then requested **commit and continue**. This checkpoint records
that search slice. The toy coding demo is parked, not a phase gate or the user's
current task; the older next-session proposal below remains superseded.

This checkpoint builds on `5d5773f`; resolve it with `git log -1 --oneline`. Check
git status and preserve later local work. **This checkpoint commit is authorized;
no push or further commit is authorized.**

### Current delivery

- `/references` lists configured source metadata; `/references search <id|*> <query>`
  searches locally without Pi or credentials. Normal parent tasks get one
  `search_references` tool only when sources are configured.
- User/profile `references.yaml` files explicitly name local roots and search
  paths. No sources are automatically installed; project-local files cannot add
  arbitrary external roots. Existing profile selection still applies.
- Excerpts carry configuration/root/file/line/digest provenance. Partial results,
  read/result bounds and missing sources stay explicit. Current repository rules
  outrank reference examples; nothing is executed, learned or promoted.
- One `ReferenceLibrary` serves CLI and tool calls, rereads content per query,
  cancels/drains searches on close and revokes old tools on workspace rebinding.
- Native bash, the Pi adapter, dependency pins, verifier and single repair owner
  are unchanged. No spending cap, new task-attempt policy, recovery/model feature,
  remote retrieval or external integration was added. Backburner research stays parked.

Read [REFERENCES.md](REFERENCES.md) for the user/configuration contract and
[Phase 9 search validation](PHASE9_IMPLEMENTATION.md#search-validation) before
modifying this slice. Implementation: `src/references/`, app/CLI/public exports;
permanent coverage: `tests/phase9-references*.test.ts`.

### Current validation

- Fresh checkpoint `bun run check`: TypeScript clean; **313 tests / 2,010 assertions**,
  0 failures, 90.72 s test-runner time. `git diff --check` passed.
- New reference suites: **19 tests / 131 assertions**, passing. Module/local-command
  tracers and rejected-text/Unicode corrections were red before their fixes.
- Real CLI plus pinned Pi with scripted localhost responses validate the new
  tool flow; no live-model usefulness trial or paid model call was performed.
- Checkpoint gate log: `/tmp/casper-references-checkpoint-ifOLmu/full-check.log`.
  Earlier implementation gate: `/tmp/casper-phase9-references-WAc4aT/full-check.log`
  (same counts, 89.69 s). These are local single-agent implementation/checkpoint
  validation, not independent Phase 9 acceptance or daily-driver readiness.

### Next decision

Phase 9 still needs `casper learn` candidate generation, explicit human promotion,
and its full independent Standards/Spec review. Agree the next slice before
implementing it; reference search does not authorize those features or Phase 10.
The evidence correction at `5d5773f` remains closed within its documented limits.

Separate user-setting change earlier in this session: the user approved changing
`~/.pi/agent/settings.json` defaults to `openai-codex / gpt-6-astra` for their Codex
subscription. Only those two fields changed; backup is
`~/.pi/agent/settings.json.backup-wGTIo5`. This is outside the repository and is not
new Casper model support or proof of live-model/billing behavior. Preserve it.

## Earlier evidence correction checkpoint — slice closed

The user requested this commit and handoff after the bounded native-path/evidence correction and its validation. This checkpoint builds on `2475975`; resolve its commit with `git log -1 --oneline`, run `git status --short`, and preserve any later local work. **This checkpoint commit is authorized; no push or further commit is authorized.**

**Latest status: both reviewed findings corrected and locally validated. Treat this correction slice as closed within its documented limits.** The next session should agree a user-visible milestone, not restart an open-ended path review. Reopen this slice for a concrete reproducible contract regression or an approved change that affects it. This is not independent acceptance or daily-driver readiness.

Read [Missing-suffix and empty-path correction](CODING_LOOP_EVIDENCE_CONTRACT.md#missing-suffix-and-empty-path-correction) and the README verification section before changing this slice. The earlier review failures below are preserved as historical evidence, not remaining open findings.

## Latest correction — completed locally

- **P2 missing-suffix identity:** `src/verify/task.ts` now records where canonical resolution stops. Possible case/Unicode aliases of the first missing entry under the same canonical parent invalidate conservatively. This also covers a missing parent of a named input, even when the observed write targets its sibling. Exclusions suppress observations only when their traversal spelling is known; a removed parent cannot invent an exclusion spelling.
- **P3 empty expanded path:** `src/app.ts` accepts an observed string path even when empty, so native `@` still invalidates as cwd after one-time expansion. Invalid/omitted paths remain distinct from the empty string.
- **Eleven permanent regressions/controls** were added at the app/tool and pinned-Pi seams. They cover case, NFC/NFD and `ß`/`ẞ` missing names, removed input parents, exclusion ambiguity, overlapping partial writes, explicit repair, unrelated missing names, known excluded parents and the empty path. Alias-specific tests detect filesystem behavior rather than assume it from the OS name.
- The native-`@`, missing-name and exclusion tracers failed before implementation. A further missing-parent case and Unicode-case control were also made red before their corrections. Against the isolated pre-fix source, all **nine** new regression cases fail and both non-invalidating controls pass; all eleven pass with the correction.
- Production changes in this latest slice are confined to `src/verify/task.ts` and the failed-observation guard in `src/app.ts`. Earlier Pi observation-path edits were preserved. Native bash, the command runner, dependency pins, lookup bounds and the single repair owner remain unchanged.

### Latest validation

| Evidence | Result |
|---|---|
| `bun run check` | TypeScript clean; **294 tests / 1,879 assertions**, 0 failures, 88.07 s |
| All supplemental probes | **78 tests / 836 assertions**, 0 failures, 45.92 s; includes the prior 65 controls and all 13 formerly mixed red/green reproduction cases |

Pinned-Pi cancellation/process cleanup, task isolation, explicit repair and its cancellation, one-time path expansion, included/excluded link chains, lookup limits and asynchronous refresh remain green. No additional distinct defect was confirmed in the bounded implementation/self-review. This is local single-agent evidence, not independent acceptance or daily-driver readiness; no live-model spending was performed.

**Conservative trade-off:** ambiguous absent names can cause extra executions even on case-sensitive filesystems. Existing canonical prefixes and literal exclusions are not case-folded; distinct missing entries and known excluded parents retain their non-invalidating controls. Lookup remains synchronous and bounded, not atomic or a guarantee against concurrent alias replacement/external writers. Windows remains unvalidated.

Temporary correction evidence is at `/tmp/casper-missing-identity-fix-jQmsN3/` (`full-check.log`, `supplemental.log`, red/green tracer logs, `permanent-pre-fix-red-final.log`, and the pre-fix source copy). Permanent regressions are in `tests/work-driven-checks.integration.test.ts` and `tests/phase8-pi.integration.test.ts`; they do not depend on temporary artifacts surviving.

## Review findings before this correction (resolved)

The following descriptions and results concern the pre-correction source reviewed against `2475975`.

- **P2 — missing-suffix alias identity, also present at `2475975`.** `src/verify/task.ts` retains literal missing suffixes that can stop matching a case-aliased named input once its target is absent. Reproduced through `CasperApp.runOnce()` / `RuntimeTool.execute()` with removed partial writes, and pinned Pi with a failed edit of a missing case alias. Additional app/tool probes show the same gap during overlapping checks, explicit repair, and exclusion matching after a case-aliased parent is removed; an NFC/NFD variant also fails. These are one residual identity defect, not multiple new regressions. No concurrent alias replacement is needed.
- **P3 — expanded `@` becomes an ignored empty failed-tool path, introduced in the earlier uncommitted diff.** `src/runtime/pi.ts` expands `@` to `""` (cwd), but the truthiness guard in `src/app.ts` drops it. The pinned-Pi case passed at `2475975` and failed with the reviewed pre-correction diff; `.` was the passing control on both. This is a conservative-handling inconsistency: the write fails on a directory, with **no demonstrated actual partial mutation**.
- No additional distinct code defect or actionable standards finding was confirmed in the full nine-file review. Native bash, the command runner, dependency pins and the single repair owner remain unchanged.

### Pre-correction review validation (historical)

Recorded before the follow-up code correction:

| Evidence | Result |
|---|---|
| `bun run check` | TypeScript clean; **283 tests / 1,793 assertions**, 0 failures, 84.77 s |
| Passing supplemental controls | **65 tests / 730 assertions**, 0 failures, 41.32 s; includes the prior 45 plus 20 new controls |
| Open-finding reproduction suite | **6 controls passed / 7 cases failed**, 13 tests / 101 assertions, 5.73 s; six failures exercise P2 and one exercises P3 |

The supplemental controls retain path-expansion, symlink-chain, exclusion, lookup-limit, cancellation/process-cleanup and task-isolation coverage. Two deadline controls use a controlled monotonic clock; they do not establish hard preemption of blocking filesystem calls. Explicit repair still has one owner; its missing-alias reuse failure belongs to P2 above.

Those review probes were temporary at the time; their cases now have permanent coverage above, and the 13-case reproduction suite is green. Historical review/probe logs remain at `/tmp/casper-2475975-review-Ajv6j2/` (`REVIEW.md`, `check-handoff.log`, `handoff-controls.log`, `handoff-repros.log`). The contract retains pre-fix reproduction steps if these artifacts are absent.

That review left the working tree unchanged. A docs-only handoff update followed, then the user authorized the bounded code correction recorded above. Historical failures are not erased or relabeled as passing runs.

## Implemented follow-up (before final review)

- Review reproduced one P2: native `file://`, tilde, Unicode-space, `@@` and aliased absolute paths could bypass scope invalidation after directory membership was restored. Canonical file URLs were tested separately from macOS `/var` versus `/private/var` aliases. These were one path-identity defect, not six independent findings.
- `src/runtime/observation.ts` now expands supported native edit/write syntax once. Both success callbacks and failed-tool observations use it through `src/runtime/pi.ts`. Downstream paths are literal; verification no longer strips a second `@`.
- `src/verify/task.ts` resolves filesystem aliases for observations and declared input roots synchronously before advancing edit revisions. Missing targets retain their suffix under the nearest existing canonical ancestor. Other resolution failures conservatively invalidate scoped evidence rather than claiming the observation was unrelated. No observation selects a check.
- Acceptance self-review caught and corrected a P2 regression in the first version of this fix: canonicalizing an observed `SRC/transient` to `src/transient` but comparing against a literal `SRC` scope missed invalidation on a case-insensitive filesystem. A pinned-Pi differential probe passed at `2475975` and failed with the first fix. Matching now resolves both sides and reconstructs the declared input's traversal spelling for exclusions; exclusions themselves are not followed through symlinks into other included inputs. The permanent regression was red before correction and explicitly skips on case-sensitive fixture filesystems. An additional app/tool control covers an excluded symlink pointing to an included input.
- A further review against `2475975` found one P2 in the uncommitted canonical-only matcher: an included symlink to excluded/out-of-scope output lost its invalidating observation after the link was removed. The pinned-Pi probes passed at `2475975` and failed before this correction; no concurrent alias replacement was involved. The user approved the bounded fix before editing. `src/verify/task.ts` now retains traversed symlink entries as well as their referent, using actual directory-entry spelling for exclusions. Lookup is synchronous and bounded (4,096 work items / 500 ms per observation, 40 link hops per path); missing suffixes are retained, while invalid non-directory traversal or lookup failure is conservative.
- Eleven permanent regressions/controls were added for the included-symlink correction. The tracer failed before implementation; nine alias regressions also failed in an isolated pre-correction copy. Coverage includes partial writes with removed targets, overlapping checks, explicit repair, outside-workspace targets and case-aliased link chains, while excluded links and unrelated checks remain non-invalidating. An invalid `file/..` traversal probe was made red before correcting the new resolver's non-directory guard. Production edits in this latest slice are confined to `src/verify/task.ts`; the pre-existing Pi adapter edits were preserved unchanged.
- Permanent regressions exercise `CasperApp.runOnce()`, `RuntimeTool.execute()` and pinned Pi 0.85.1 with scripted localhost responses. File URLs, double `@`, tilde, Unicode spaces, and a failed edit through an alias with missing parents were made red before their corresponding corrections. Controls cover ordinary paths, exclusions, unrelated checks, removed partial writes and unresolvable paths.
- **Native bash, the command runner, dependency pins and the single repair owner are unchanged.** Unlike the earlier checkpoint, `src/runtime/pi.ts` does change: only edit/write observation-path handling. No tool override, watcher, recovery/model expansion or research integration was added.

### Implementation checkpoint validation (before final review)

- `bun run check`: TypeScript clean; **283 tests / 1,793 assertions**, **0 failures**, **98.21 s** test-runner time. The earlier 272-test / 1,710-assertion gate was green before the included-symlink regression was discovered.
- All **45 supplemental local probes / 576 assertions** passed: the original 19 path/lifecycle probes, 16 normalization/scope-spelling controls, six original symlink repros and four traversal controls. Pinned-Pi shutdown/runtime abort retains blocked evidence, stops queued commands/descendants, revokes old tools and starts new tasks plus explicit verification fresh. Explicit repair still has one owner and no managed tool; cancellation during repair retains invalidation without reruns. The asynchronous-refresh probe also passes.
- Temporary review evidence remains at `/tmp/casper-round2-review-vHXB0B/`, `/tmp/casper-path-acceptance-HSqRtI/`, `/var/folders/yj/l1q2ypcj68qck8m_kcrdv26r0000gp/T/casper-2475975-review-v2k7ael0/` and `/tmp/casper-alias-fix-awu6c2iu/` (latest logs, pre-correction snapshot and traversal controls). Permanent regressions are in the repository tests. Do not rely on temporary files surviving a new machine/session.
- Single-agent implementation validation/self-review only, not independent acceptance. No live-model spending. Path lookup and scope snapshots remain non-atomic; no guarantee against concurrent alias replacement or arbitrary external writers. Windows remains unvalidated.

## Previous checkpoint: 2475975

The earlier user-requested checkpoint built on `43073d7` (`Add opt-in work-driven checks with task-local scoped evidence`). Its completed work and validation below are historical, not the current uncommitted diff.

### What that checkpoint completed

- Reviewed `7ce29ad..43073d7` against the opt-in `casper_check` agreement. Single-agent inspection and local validation, not independent review. One confirmed P2 spec finding: a scoped pass → observed native write creating an included file → native removal → another managed check reused the old pass because directory membership matched again.
- Corrected that finding in `src/verify/task.ts` and `src/app.ts`. Existing native edit/write observations invalidate matching frozen scopes until another execution. Per-check edit revisions cover observed edits during a running check; asynchronous freshness refresh cannot overwrite invalidation. Failed native edit/write paths conservatively invalidate possible partial writes without claiming completed edits.
- Kept scope boundaries and exclusions effective. Unrelated edits do not invalidate other checks. Invalidation neither selects checks nor depends on the receipt's 32-path display cap.
- Shared the same behavior with explicit repair through `src/verify/repair-loop.ts`, without exposing the managed tool to non-opted-in requests. There remains one bounded repair owner, after the primary prompt settles.
- Added six regressions in `tests/work-driven-checks.integration.test.ts` and one in `tests/phase8-pi.integration.test.ts`; strengthened the no-selection case. The original, overlapping-edit, partial-write and explicit-repair failures were reproduced before correction. The pinned-Pi native-write/removal case was also reproduced before the fix.

**Native bash, `src/runtime/pi.ts`, the command runner and dependency pins are unchanged.** No recovery/model controls, new autonomy default, filesystem watcher or shell override was added.

### Checkpoint validation (historical)

Full gate immediately before `2475975`:

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

## Historical next-session proposal (superseded by Phase 9 work above)

1. Read this handoff and the evidence contract for the completed behavior and limits. Check git status and preserve later local work. The correction is closed; another broad filesystem audit is not the default next task.
2. Propose **one bounded, user-visible milestone** with explicit acceptance criteria. Recommended: demonstrate Casper completing one small representative coding task using existing capabilities, with a correct change, real checks and an understandable result. Scripted fixtures establish mechanics, not real-world usefulness.
3. Agree the task/project, allowed edits, checks and stop conditions with the user before implementation or evaluation. Any live-model/provider trial also needs explicit approval and a spending bound. Planning this milestone does not authorize the trial.

Keep the documented non-atomic and platform limitations visible. If a concrete regression appears, report its reproduction and agree a bounded correction rather than restarting unlimited edge-case exploration. Preserve native bash, dependency pins and the single repair owner. Recovery/model expansion, trust/autonomy changes, new integrations, research activation, further commits and push remain unapproved.

Historical suggested resume prompt (not current instructions):

> Read docs/HANDOFF.md and docs/CODING_LOOP_EVIDENCE_CONTRACT.md. Check git status and preserve later local work. Treat the coding-loop evidence correction as closed within its documented limits; do not restart a broad path/verification audit without a concrete reproducible regression. Latest gate: TypeScript clean, 294 tests / 1,879 assertions; all 78 supplemental probes / 836 assertions passed. These are local single-agent results, not independent acceptance or daily-driver readiness. Help me agree one bounded, user-visible next milestone: a small representative coding task using Casper's existing capabilities. Propose the task, acceptance criteria, execution limits and any required budget, then get my approval before implementation or live-model calls. Keep docs/REFERENCE_IDEAS_BACKBURNER.md parked. No recovery/model expansion, new integrations, further commit or push without separate approval.

## Historical context

`43073d7` introduced the managed tool and evidence contract; `7ce29ad` is the earlier partial-evidence baseline. Earlier handoff history is preserved with `git show 43073d7:docs/HANDOFF.md`. `docs/CODING_LOOP_DIRECTION_REVIEW.md`, `docs/CODING_LOOP_AUDIT.md` and the phase review documents remain historical design/review evidence, not authorization to resume their old instructions.
