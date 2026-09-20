# Casper — historical handoff archive

Archived when the current handoff was condensed after acceptance trial 01.
Use [HANDOFF.md](HANDOFF.md) for current direction, user preferences and approvals.
The prior entries below preserve evidence; their “next” instructions are historical.

## Current direction: acceptance trial 01 completed — candidate unapplied

The user approved the original trial limits, without adaptive effort. One live
Casper task used the approved Codex subscription route in isolated runner/candidate
copies: **gpt-6-astra, fixed medium effort, 286.10 s**, no timeout at the 10-minute
outer limit, no model rerun or supervising-agent code repair. Temporary protected
auth was removed; original source/auth/settings were unchanged at the audit.

**Mixed outcome:** the candidate meets the edit allowlist and passes the separate
behavior/CLI evaluator plus **398 tests / 2,609 assertions**, TypeScript clean,
120.49 s. But Casper's managed full test command timed out at its existing
**120-second command limit**, so the live CLI honestly exited **1**, with zero
repair attempts. Do not call that managed check passed or confuse the two timers.
Ordinary Git inspection uses 2 → 1 calls; unborn uses 2 → 3 and non-Git uses 1 → 2.
The host has NOT applied or repaired the candidate. Current repository production
code still has O4 unimplemented; its last clean baseline gate is **389 tests /
2,599 assertions**, not the candidate's 398.

The first isolated baseline gate also failed two profile tests because the harness
forced `CASPER_PROFILE=default`, and reproduced the existing SIGTERM verifier
cleanup failure (`leaked` marker present). Removing the profile override yielded a
clean serial baseline; that does **not** diagnose the cleanup failure. It has now
also been observed in a serial gate, not only the earlier parallel gate.

Permanent report, unapplied patch, prompt, evaluator, manifests, logs and usage:
[acceptance/TRIAL_01.md](acceptance/TRIAL_01.md). Raw snapshots/session remain at
`/tmp/casper-acceptance-sgTCoi/` (may later be absent), with no auth token copy left.
Usage: 75,819 session-reported tokens including cache reads; actual subscription
charge/remaining allowance unavailable. No separately paid API provider, source
commit, push or automatic application.

**Next decisions:** review/apply or reject the candidate; agree per-command timeout
headroom before authorizing any new trial; scope the reproduced cleanup issue if
needed. Independent Phase 9 Standards/Spec review is still required. No additional
live run or candidate application is authorized by the completed one-run approval.
Keep optimization/promotion/Phase 10 paused and `check` serial. This self-hosted
coding trial does not establish learning quality or general daily-driver readiness.

## Previous direction: acceptance trial preparation (superseded by execution above)

The user asked whether to move to the next phase, then said “do it” after the
recommendation to pause optimization and perform acceptance testing. **Do not
resume the optimization backlog by default.** A proposed bounded self-hosted
trial is written in [ACCEPTANCE_TRIAL.md](ACCEPTANCE_TRIAL.md): Casper performs
O4 on a disposable snapshot of this repository, with root/branch/worktree
correctness, restricted edits, serial checks and honest before/after measurement.
The supervising agent has not implemented O4 or pre-solved the task.

**Preparation only:** no live-model run, new evaluation tests, candidate snapshot,
credential handling, commit or push. Last code gate remains **389 tests / 2,599
assertions**, TypeScript clean; this session's preparation is docs-only.
Confirm project/task/seams and provider usage allowance before launching. Proposed:
one supervised 10-minute Casper task on the existing Codex subscription, no rerun
or separately paid API provider, isolated runner/candidate state, no automatic
post-task repair. Parent tasks have no hard dollar/token cap; wall time is not a
spending limit. Credential handling must also be explicitly agreed.

Independent Phase 9 Standards/Spec review remains pending; no independent
review-agent tool is available here. Human promotion remains unimplemented and
paused, not silently dropped from Phase 9. Phase 10 remains paused. A successful
self-hosted coding trial would not establish learning usefulness or broad
real-project readiness. See the proposal for approval and evidence requirements.

## Latest completed bounded follow-up: O3 workspace discovery (uncommitted)

Implemented **O3** in `src/app.ts`. One private `loadWorkspace()` now serves startup
and rebinding. Inspection/context loading remain sequential; independent skill,
MCP, LSP and reference metadata discovery then overlaps. Shared initialization
runs after successful discovery and a shutdown check. Startup banner/diagnostic
order, rebind revocation/context append and fresh connection consent are retained.
No larger app decomposition, connection change or dependency/runtime edit.

Four public-app tests added in `tests/workspace-loading.test.ts`: overlap and
sibling-failure tracers were red before the change; shutdown and invalid-context
controls already passed. Focused app/session/reference suites: **39 tests / 253
assertions**, including named-session rebinding and old-tool revocation.

Paired `/project` medians **99.530 → 97.690 ms**, overlapping ranges: **no material
speedup established**, and no claim of the report's proposed 30–60 ms gain.
The shared loading path and controlled scheduling overlap are established. O2's
zero MCP/Ajv imports remain intact. Permanent samples, O3-only reconstruction diff
and reproduction: [O3 benchmark](benchmarks/STARTUP_O3.md).

Serial `bun run check`: **389 tests / 2,599 assertions**, 0 failures, TypeScript
clean, 118.66 s; `git diff --check` passed. Logs: `/tmp/casper-o3-{red,focused,check}.log`
(may be absent later). Same-agent validation only; no live-model/production MCP
calls, commit or push. Prior work preserved. **Keep `check` serial.**

Next non-destructive report candidate: **O4 project-inspection git spawns**, with
measurement and branch/root/worktree controls. **F3 lock recovery/F4 retention
remain deferred** pending explicit rules. Parallel metadata reads are not an
atomic snapshot or abortable transaction: sibling reads may finish after another
rejects, and close does not newly drain them. Shutdown still prevents late
publication. See [follow-up status](DEBUG_OPTIMIZATION_REVIEW.md#follow-up-implementation-status).

## Previous bounded follow-up: O2 deferred MCP loading (uncommitted)

Implemented **O2** only. `src/mcp/manager.ts` defers SDK client/transport imports to
an approved connection; post-import consent/deadline checks prevent late transport
creation. Stdio teardown retains its existing direct-child TERM/KILL behavior.
`src/capabilities/broker.ts` defers and caches its validator module; compiled
validators remain catalog-revision-local. First-use imports recheck cancellation
and catalog identity before asking for approval. The pinned MCP client itself
imports Ajv on connection; these costs are deferred, not eliminated.

Paired fresh-process benchmark: `/project` median **143.769 → 92.494 ms** (~36%
lower); app import **91.370 → 36.954 ms**; MCP/Ajv modules after app import **81 → 0**.
Five ABBA blocks, ten samples per variant, isolated HOME and empty cached fixture
project with an unconnected synthetic MCP definition. No real-project/model-speed
claim. Permanent samples and reproduction: [O2 benchmark](benchmarks/STARTUP_O2.md).

Eleven fresh-process tests cover import absence, a real cold approved stdio
connection, schema validation and cancellation at the new module-load boundaries.
The eager-import tracer was red before edits. An initial cleanup-test failure from
an unnecessary warm-path import await was corrected by caching the resolved
validator module; that existing test passes unchanged. No deadline was weakened.

Serial `bun run check`: **385 tests / 2,570 assertions**, 0 failures, TypeScript
clean, 118.00 s; `git diff --check` passed. Logs: `/tmp/casper-o2-{red,focused,check}.log`
(may be absent later). Same-agent validation only. No paid/live-model or production
MCP calls, commit or push; all prior work preserved. **Keep `check` serial.**

Next non-destructive report candidate: **O3 parallel startup discovery**, with
before/after measurement. **F3 lock recovery/F4 retention remain deferred** pending
explicit rules. Module loading itself is not abortable/hard-preemptible; guards
prevent late transport creation, not a blocking loader. Other cleanup/platform
limits remain unchanged. See
[follow-up status](DEBUG_OPTIMIZATION_REVIEW.md#follow-up-implementation-status).

## Previous bounded follow-up: memory review / F6 command keys (uncommitted)

Reviewed the latest non-destructive F3/F5 memory fix against `c8df223`, restricted
to its relevant hunks and agreed scope. **Standards: no actionable finding.
Spec: no reproduced defect within the agreed scope.** Added passing controls for
context-budget overflow, honest runtime-failure outcomes after fallback and
shutdown during a failed facts read. Memory suite: **14 tests / 177 assertions**.
No additional memory production fix was needed. This was same-agent review;
independent parallel reviewers were unavailable and acceptance remains pending.

Continued with **F6**, reproducing unsupported YAML command keys in formatted
project context. `src/config/load.ts` now filters commands to string-valued
`CHECK_NAMES`; `src/project/model.ts` narrows the override type. Flat/nested YAML,
`verify:` precedence, detected-command fallback, prompt output and cache reopening
have a permanent regression, red before the fix. README documents ignored unknown
keys/non-string values. No shell-command safety or arbitrary-cache audit claimed.

Serial `bun run check`: **374 tests / 2,559 assertions**, 0 failures, TypeScript
clean, 119.95 s; `git diff --check` passed. Focused config/memory suites: **22 tests /
355 assertions**. Logs: `/tmp/casper-f6-red.log` and
`/tmp/casper-memory-review-f6-check.log` (may be absent later). No commit, push or
live-model calls. All prior uncommitted work preserved. **Keep `check` serial.**

Next non-destructive report candidate: **O2 lazy MCP/validator imports**; measure
fresh-process startup before editing. **F3 lock recovery and F4 retention still
need explicit ownership/recovery and retention rules**; no lock stealing or
outcome pruning has been implemented. See
[follow-up status](DEBUG_OPTIMIZATION_REVIEW.md#follow-up-implementation-status).

## Previous bounded follow-up: F3 optional facts / F5 buffers (uncommitted)

Implemented only the non-destructive memory follow-up. `src/app.ts` catches facts
context failures and warns before proceeding without the entire facts block.
Explicit `/memory` operations remain fail-closed. Facts files are never reset,
partially admitted or automatically repaired; each task rereads them, and no stale
facts are reused. Warnings do not echo raw filesystem errors or stored text.

`src/memory/store.ts` allocates the observed size plus one sentinel byte, bounded
by 1 MiB + 1. Filling the buffer rejects growth instead of parsing a potentially
truncated JSONL prefix. Measured allocation for an 84-byte facts file fell from
1,048,577 to 85 bytes; no end-to-end speed claim. Reads remain non-atomic.

Four permanent tests added in `tests/phase9-memory.test.ts`; the app failure,
allocation and controlled-growth tests were red before correction. Focused suite:
**13 tests / 158 assertions**. Serial `bun run check`: **372 tests / 2,528
assertions**, 0 failures, TypeScript clean, 121.07 s; `git diff --check` passed.
Logs: `/tmp/casper-memory-followup-{red,check}.log` (may be absent later).
Same-agent validation only. All prior work preserved; no commit, push or live-model
calls. **Keep `check` serial; the parallel cleanup failure remains unresolved.**

**F3 stale-lock recovery and F4 outcome retention remain unimplemented.** Full
stores still refuse writes and locks are not stolen. Next step is to agree bounded
ownership/recovery and retention semantics, not blindly implement the report's
age/PID or deletion suggestions. Legacy locks have no owner metadata. No shared
store extraction or learning-store changes were made. See the
[follow-up status](DEBUG_OPTIMIZATION_REVIEW.md#follow-up-implementation-status).

## Previous bounded follow-up: debug review F1 (uncommitted)

Continued the report with **shared profile-name validation**, preserving all prior
uncommitted work. Reproduced project YAML traversal loading outside profile rules;
fixed unchecked selection in `src/config/load.ts`. New `src/config/profile.ts`
provides the same predicate to policy, MCP, LSP and reference loaders. Policy
loading rejects all malformed supplied selections, including overridden values;
direct discovery retains skip-invalid-profile behavior. Names are 1–64 ASCII
letters/digits/underscores/dots/hyphens, starting with a letter or digit.

README Configuration documents the retained trust decision: project YAML may
select an existing user profile, including reference sources and MCP/LSP metadata.
Connection consent is unchanged. This is lexical validation, not symlink
confinement. Two public-loader regressions were red before the fix.

Serial `bun run check`: **368 tests / 2,461 assertions**, 0 failures, TypeScript
clean, 120.18 s; `git diff --check` passed. Gate log: `/tmp/casper-f1-check.log`
(may be absent later). Same-agent validation only. No commit, push or live-model
calls. **Keep `check` serial; the earlier parallel cleanup failure is unresolved.**

At this checkpoint the next report area was **F3–F5 memory robustness/retention/
allocation**; the non-destructive subset is now implemented above. Lock-reclamation
and retention semantics still need agreement before changing stored state.
See [follow-up status](DEBUG_OPTIMIZATION_REVIEW.md#follow-up-implementation-status).

## Previous bounded follow-up: debug review O1 / F2 (uncommitted)

The user approved continuing the debugging/optimization report. Added opt-in
`bun run test:fast` and fixed slash-command model fallthrough with shared local
`/help`, one-shot `/exit`/`/quit`, and unknown-command rejection. Existing learning
work below is preserved. No commit, push or live-model calls.

Final serial `bun run check`: **366 tests / 2,326 assertions**, 0 failures,
TypeScript clean; `git diff --check` passed. Five initial parallel runs passed
in 44–45 s, but a later parallel gate hit the existing SIGTERM verifier-cleanup
test (`leaked` marker existed). Isolated rerun and final serial suite passed;
cause is unresolved. **Keep `check` serial; do not weaken cleanup tests.**
See [follow-up status](DEBUG_OPTIMIZATION_REVIEW.md#follow-up-implementation-status)
for evidence and limits. At this checkpoint the next report item was **F1 shared profile validation**
(now implemented above); other remaining findings have not been implemented. Same-agent validation only.

## Resume here: Phase 9 review corrections — implemented, uncommitted

Reference search is committed at `c8df223` (no push). The subsequently approved
candidate-only `casper learn` slice remains uncommitted. A same-agent review found
three reproduced defects; the user then authorized fixing them. All three now
have permanent regressions and locally validated corrections. Preserve the
learning work, fixes and documentation cleanup. **No further commit or push has
been made or authorized.**

### Implemented slice

- `casper learn <local-repo>` invokes one existing bounded read-only explorer with
  global Pi model defaults. `casper learn list <repo>` and
  `casper learn inspect <repo> <draft-id>` work locally without model credentials.
- `CandidateLibrary` validates up to four structured proposals, checks exact
  quoted source lines and computes file/batch SHA-256 digests. Invalid, cut-off,
  failed or incomplete output saves no batch; empty results remain qualified.
- Owner-only plaintext drafts use the existing canonical-source project-state
  identity, separate from facts/outcomes and outside skill/reference discovery.
  They remain unpromoted, unverified and unaccepted. Nothing is activated.
- The standalone CLI route bypasses the normal parent app/project task; no
  repository commands or ambient extensions are run. No new model-facing tool,
  interactive `/learn`, automatic retry, repair owner or spending cap was added.
- Pi read-only startup now rejects known writable-state/source overlaps before
  model/auth initialization. State aliases, prospective missing directories and
  auth/model-store file symlinks are checked; normal parent startup is unchanged.
- Reference filename eligibility now precedes inode deduplication. Excluded files
  and lockfiles cannot hide supported hardlinks; eligible files still deduplicate.
- Reference and learning output share terminal-safe JSON encoding, including
  DEL/C1 and bidi escaping; reference byte budgets use the same serialized form.
- Native bash, the subagent manager, dependency pins and the single coding-loop
  repair owner are unchanged. Promotion, remote retrieval, model/recovery
  expansion and Phase 10 remain paused.

Before changing learning commands, generation, provenance or persistence, read
[LEARNING.md](LEARNING.md). Implementation: `src/learn/candidates.ts`, CLI/public exports.
Permanent coverage: `tests/phase9-learn.test.ts`, through the real CLI and pinned
Pi with scripted localhost providers.

### Validation and limits

- Correction `bun run check` passed twice: TypeScript clean; **358 tests / 2,277
  assertions**, 0 failures. Test-runner times: 120.81 s and 119.77 s.
  `git diff --check` passed.
- The three public-seam tracers failed before their fixes. Focused reference and
  learning suites: **62 tests / 390 assertions**; read-only/ordinary-parent Pi
  controls: **2 tests / 8 assertions**. Four original reference-review probes
  also pass unchanged. Permanent regressions include serialized C1 byte budgets,
  lockfile hardlinks, canonical state aliases and outside-source controls.
- Correction evidence: `/tmp/casper-phase9-fixes-7vYGb7/` contains red logs,
  focused/control results, `full-check.log` and `final-check.log`. Earlier review:
  `/tmp/casper-phase9-review-GkUdkF/REVIEW.md`. Permanent tests and
  [review corrections](PHASE9_IMPLEMENTATION.md#review-corrections) survive those
  temporary paths. Original learning gates remain at
  `/tmp/casper-phase9-learn-bb4QFa/` (345 tests / 2,212 assertions).
- One earlier review gate timed out in the existing auth-preflight cancellation
  test; its cause remains unresolved. Five isolated review reruns, the review
  repeat gate, a correction isolated run and both correction gates passed. No
  cancellation deadline was weakened; do not relabel the timeout as diagnosed.
- These are same-agent implementation/self-review results, **not independent
  Phase 9 acceptance or daily-driver readiness**. No paid/live-model trial, real
  user source scan, further commit or push was performed.

Matching source quotes does **not** validate model reasoning or show that a
pattern worked. Reads are bounded/non-atomic and inspection does not refresh
provenance. Native read-only tools are **not a filesystem sandbox or spending
cap**; their source confinement is instructional. Stored-evidence checks are
stricter than native read authority. The new runtime-state preflight is bounded
and non-atomic, not a hardlink audit or protection against concurrent path
replacement or every possible runtime cache. Windows remains unvalidated.

### Next decision

Keep the foundation and pause feature expansion. Agree a representative task from
a real project, its baseline and acceptance criteria; separately authorize any
live-model budget. Use that evidence before deciding whether to resume promotion
or Phase 10. Independent Standards/Spec review remains required; the same agent's
review cannot satisfy it. Do not restart an open-ended audit without a concrete
regression or newly approved scope.

The evidence correction at `5d5773f` stays closed; the toy coding demo and
backburner research remain parked. No live provider trial, new integration,
further commit or push without separate approval. Preserve the separately
approved Pi user-setting change recorded below.

## Previous checkpoint: c8df223 — local reference search

The user approved resuming Phase 9 with **explicitly configured, read-only local
reference search**, then requested **commit and continue**. This checkpoint records
that search slice. The toy coding demo is parked, not a phase gate or the user's
current task; the older next-session proposal below remains superseded.

`c8df223` builds on `5d5773f` and was committed by user request. Nothing was
pushed. That checkpoint authorization does not authorize another commit.

### Search checkpoint delivery

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

### Search checkpoint validation

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

### Search checkpoint next decision (superseded)

At this checkpoint, candidate generation, explicit human promotion and the full
independent Standards/Spec review remained pending. The user subsequently approved
candidate generation only, as recorded above. The evidence correction at
`5d5773f` remains closed within its documented limits.

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
