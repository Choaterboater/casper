# Coding-loop evidence contract — narrow correction

Implemented after the direction review at `7ce29ad`, with user approval for the contract-and-regression slice. Included with the managed-tool follow-up in the user-requested checkpoint. This is implementation validation and self-inspection, **not independent review or daily-driver readiness approval**.

The original `CODING_LOOP_DIRECTION_REVIEW.md` remains the historical assessment. Its work-driven-selection finding is now addressed by the managed-tool follow-up below, not by transparent shell reuse. No recovery/model expansion, native-shell exit inference, new verification default, external inference, credential access, or push was added.

## Missing-suffix and empty-path correction

After the review and docs-only handoff below, the user approved finishing the two bounded findings and then requested this checkpoint commit. **Both are corrected and locally validated; this correction slice is closed within its documented limits.** Further work should follow an agreed user-visible milestone or a concrete reproducible contract regression, not another open-ended path audit. This is not independent acceptance or daily-driver readiness.

`src/verify/task.ts` now retains the canonical existing parent separately from a missing suffix. When both a declared input and an observation stop at that same parent, possible case/Unicode aliases of the first missing entry conservatively invalidate evidence. That entry can be the named input itself or an included parent: a partial write to a sibling can create/remove that parent too. Only unresolved entries are compared this way; existing canonical prefixes and declared exclusion strings are not folded.

Exclusions can suppress an observation only when the known traversal prefix establishes that it is excluded. For example, an existing excluded `src/generated` still excludes missing descendants, but an already-removed parent cannot prove that the actual entry was `generated` rather than included `GENERATED`. **Ambiguous absent names may cause extra executions even on case-sensitive filesystems.** This is conservative invalidation, not invented filesystem case-sensitivity or a claim that a failed tool completed a write. Distinct missing entries and known excluded parents retain non-invalidating controls.

`src/app.ts` now distinguishes an empty string path from absent path metadata in failed native observations. Native `@` expands once to the empty relative path and still denotes cwd; it no longer disappears at the truthiness guard. The Pi adapter's existing expansion behavior is preserved.

Eleven permanent app/tool and pinned-Pi regressions/controls were added in `tests/work-driven-checks.integration.test.ts` and `tests/phase8-pi.integration.test.ts`. They cover removed case/NFC-NFD/Unicode-case names, a missing named-input parent, exclusion ambiguity, overlap, explicit repair, unrelated missing names, known excluded parents and empty expanded paths. The primary tracers were red before implementation; additional parent and `ß`/`ẞ` cases were red before correcting those details. All nine regression cases fail against an isolated pre-fix source copy, while the two non-invalidating controls pass; all eleven pass with the correction. Alias-specific fixtures probe filesystem behavior and skip explicitly when the required equivalence is unsupported.

See [Latest validation](HANDOFF.md#latest-validation) for the full gate and all supplemental probes, including the formerly failing 13-case suite. Temporary correction logs/source evidence are at `/tmp/casper-missing-identity-fix-jQmsN3/`; the permanent regressions do not depend on those files.

Production edits in this slice are confined to task path matching and the app's failed-observation guard. Native bash, the command runner, dependency pins, 4,096-work-item / 500-ms / 40-hop lookup bounds and the single repair owner are unchanged. Invalidation stays synchronous and does not select checks. Cancellation/task-isolation fixtures remain green. Lookup and scope observations remain non-atomic; Windows and concurrent alias replacement remain outside validated guarantees. No live-model spending, new integration or push was performed. The user authorized the correction checkpoint commit after validation; further commits require separate approval.

## Findings that prompted this correction (resolved)

The following descriptions, source locations and actual results refer to the **pre-correction** uncommitted diff reviewed against `2475975`. They are retained to explain the defects and reproduce the red behavior in a pre-fix source copy, not as remaining open findings. The intended contract is unchanged; the corrected source now satisfies the expected outcomes below.

### P2 — missing-suffix alias identity (pre-existing at 2475975)

Pre-correction locations: `src/verify/task.ts:29–31` (`pathIdentity`) and `src/verify/task.ts:119–125` (scope matching).

The pre-fix resolver returned a canonical existing ancestor plus the literal unresolved suffix. On the reviewed case-insensitive filesystem, declared `SRC/MISSING` and observed `src/missing` identify the same input while it exists, but their missing suffixes compared as different strings after removal. An observed partial write could therefore leave old evidence reusable as `fresh`. This also failed at `2475975`: **a residual gap, not an introduced P2 regression**. No concurrent alias replacement was needed.

Reproduce at `CasperApp.runOnce()` / `RuntimeTool.execute()`:

1. Create directory `src`; leave the named input absent. Configure `verify.test: "printf x >> test-runs"` and `verification.scopes.test.inputs: ["SRC/MISSING"]`. Opt in with `autoVerify: true`.
2. In the runtime fixture, execute `casper_check({ check: "test" })` and obtain a fresh pass.
3. Write partial content to `src/missing`. Confirm `realpath()` returns the same path for both spellings, then remove the file before emitting `{ type: "tool_end", toolName: "write", isError: true, input: { path: "src/missing" } }` through the runtime event seam.
4. Execute the managed check again. **Pre-fix actual:** `reused: true`, `freshness: "fresh"`, one command (`test-runs` contains `x`). **Expected and now observed:** another execution (`xx`). Failed-write evidence still records possible mutations without claiming a completed edit.

The identical-spelling observation `SRC/MISSING` is a passing control; an unrelated check scoped to `docs` still reuses. NFC/NFD spellings (`"src/caf\u00e9"` versus `"src/cafe\u0301"`) reproduce the same missing-name gap on this filesystem. Establish filesystem equivalence rather than assuming it from the OS name.

Pinned Pi **0.85.1**, scripted localhost-provider reproduction:

- Use the same missing named input, then script check → native `edit` of `src/missing` with `edits: [{ oldText: "old", newText: "new" }]` → check → check → final answer.
- The native edit fails because the target is absent. **Pre-fix reuse:** `[false, true, true]`; **expected and now observed:** `[false, false, true]`, with two commands. The identical-spelling control passes.
- This proves real failed-edit handling, **not an actual partial Pi write**. The removed-partial-write scenario is reproduced at the app/tool seam above.

Additional pre-fix app/tool manifestations of the same P2:

- **Overlap:** hold a real check open using a `started`/`release` file handshake; perform step 3 while it runs, then release it. The result is incorrectly `fresh`, rather than `stale`, and the next call reuses it. The literal-spelling control invalidates synchronously.
- **Explicit repair:** select test plus build with `/verify repair test build`, without opting in to the managed tool. Keep the test configuration above; build uses `printf x >> build-runs; test -f fixed` with input `fixed`. During the one repair prompt, perform step 3, then write `fixed` and invoke its successful-edit callback. Build correctly executes twice, but test incorrectly executes only once. There remains **one repair owner and no managed tool**; the failure is missing test invalidation.
- **Exclusions after parent removal:** declare input `src` and literal exclusion `src/generated`. After a fresh pass, create actual directory entry `src/GENERATED` and write through case alias `src/generated/transient`. `workspaceState()` confirms that the uppercase traversal spelling is included. Remove the file and uppercase parent before the failed-write observation for the lowercase path, then check again. The missing suffix is incorrectly treated as excluded and the old pass is reused. Keeping the parent until observation is a passing control in current code. **Preserve literal traversal exclusions; simply case-folding exclusions would be wrong.**

These manifestations also failed at `2475975`. The code reviewed before this follow-up already fixed the parent-still-present exclusion control, which failed at that baseline. The follow-up now also fixes the missing-name and removed-parent cases. These manifestations belong to one identity defect, not separate findings.

### P3 — expanded @ becomes an ignored empty path (introduced)

Pre-correction locations: changed `src/runtime/pi.ts:183`, interacting with then-unchanged `src/app.ts:847`.

Pi interprets native `@` as an empty relative path, hence cwd. At review time the adapter stored `input.path = ""`, but the app's truthiness guard dropped that failed-tool observation before verification could interpret it as cwd.

To reproduce with pinned Pi and a localhost provider, configure a check that appends to `test-runs`, scoped to an existing `src` directory. Script check → native `write({ path: "@", content: "cannot overwrite a directory" })` → check → check → final answer. The write fails on cwd. Before correction, the uncommitted code executed one command with reuse `[false, true, true]`; `2475975` executed two with `[false, false, true]`. The corrected code also executes two. Native path `.` is a passing control on both pre-fix versions and after correction.

This is a **low-priority conservative-handling inconsistency**. The reproduction demonstrates no actual partial mutation or falsely validated changed content; keep that qualification and distinguish it from P2.

### Pre-correction review evidence

See [Pre-correction review validation](HANDOFF.md#pre-correction-review-validation-historical) for the then-green gate and **separate failing reproduction suite**. Standards review found no actionable violations; spec review found these two root causes, not one finding per failing variant. This was local single-agent review, not independent acceptance or daily-driver readiness.

The original review harnesses were temporary; permanent regressions for the findings are now recorded above. Optional historical artifacts remain in `/tmp/casper-2475975-review-Ajv6j2/`: `REVIEW.md`, `missing-case.test.ts`, `missing-contexts.test.ts`, `empty-expanded-path.test.ts`, plus `check-handoff.log`, `handoff-controls.log`, `handoff-repros.log` and per-suite baseline/current logs. Baseline comparison used a separate `git archive 2475975` source copy with pinned dependencies; the working checkout was preserved. The reproduction steps above retain the red scenarios if temporary artifacts are absent.

The user subsequently approved the bounded correction and regressions, now completed above, and requested the checkpoint commit. Further changes still require agreement; no new phase, integration, model spending, additional commit or push is authorized.

## Native-path identity follow-up

Review of `43073d7..2475975` found one remaining P2: Pi accepts native path forms that the invalidator interpreted differently. Canonical `file://` URLs, tilde paths, Unicode-space normalization, double `@` prefixes and filesystem aliases could leave a recorded matching edit unrecognized, allowing an old pass to revive after directory membership was restored. Failed-write observations had the same mapping gap. The user approved this bounded correction; it was **uncommitted during review** and is now included in the user-requested checkpoint. Push remains unapproved.

The Pi adapter now expands native edit/write syntax once for both successful callbacks and failed-tool path observations. Downstream consumers receive literal filesystem paths; verification does not strip another `@`. The task resolves aliases for cwd, the observed path and declared input roots synchronously, so an overlapping check cannot finish before the edit revision is updated. Exclusions retain the scope observer's traversal spelling beneath each declared input; they are not followed through symlinks into other included inputs. Missing targets resolve via their nearest existing ancestor with the missing suffix retained. Other resolution errors conservatively invalidate scoped evidence, without selecting checks or changing command outcomes. Identity also retains traversed symlink entries: an included link remains invalidating even if its target is excluded or outside the scope. Excluded/unrelated observations with no included traversal remain non-invalidating. Synchronous identity lookup is bounded per edit observation to 4,096 work items and 500 ms checked between operations, with at most 40 symlink hops per path; exhaustion is unknown identity, not evidence that a path is unrelated.

Permanent regressions cover these forms at `CasperApp.runOnce()`, `RuntimeTool.execute()` and the pinned-Pi/local-provider seam, including failed native edit/write observations, missing aliased parents, restored membership after partial writes, exclusions and unrelated checks. File URL, double-`@`, tilde, Unicode-space and missing-target alias cases were made red before their corresponding corrections. The eight successful-write path fixtures each execute two commands across check → write → native removal → check → reuse. Failed edits/writes conservatively rerun once without recording a completed edit.

Acceptance self-review caught a P2 regression in the first fix: a declared `SRC` scope on a case-insensitive filesystem was compared against a canonical `src/transient` observation and could incorrectly reuse its pass. The pinned-Pi probe passed against `2475975` but failed against that first fix. Resolving both input roots and observations now retains included-path invalidation and the original exclusion semantics. The permanent regression was red before correction, and skips explicitly on case-sensitive fixture filesystems; an app/tool control also ensures an excluded symlink cannot hide a write to an included file.

### Included-symlink traversal correction

A further review against `2475975` reproduced one P2 in the uncommitted canonical-only matcher: check → create included `src/link` → native write through the link to excluded/out-of-scope output → remove output/link → check reused the old pass. The two pinned-Pi probes passed at `2475975` and failed against that matcher, without concurrent alias replacement. The prior green gate (**272 tests / 1,710 assertions**, plus **19 supplemental probes / 151 assertions**) did not cover this inverse of the excluded-link-to-included-target control. The user approved this bounded correction before implementation.

`src/verify/task.ts` now retains both the referent and the observed symlink entries, including entries reached through a link chain. Matching uses the link's actual directory-entry spelling, preserving case-aliased scope roots and literal exclusions. A named input's observed symlinked parent also invalidates its evidence. Missing targets retain their suffix under the last existing canonical directory; invalid non-directory traversal and lookup failures remain conservative. The lookup stays synchronous, so overlapping checks cannot publish fresh evidence ahead of the edit revision. No shell override, watcher, command selection or new repair owner was introduced.

Eleven permanent app/tool and pinned-Pi tests were added. The first tracer was red before the fix; all nine included-alias regression cases were also red in an isolated pre-correction source copy. They cover successful and partial writes (including an already-removed target), unrelated checks, overlapping checks, explicit repair, excluded/outside-workspace targets and case-aliased link chains. The excluded-link-to-unrelated-output control remains green. An additional invalid `file/..` traversal regression was made red before tightening the resolver's non-directory guard. Existing one-time path expansion, exclusions and single-owner controls remain intact.

Implementation-checkpoint validation (before the final review above): `bun run check` passed with TypeScript clean, **283 tests / 1,793 assertions**, **0 failures**, **98.21 s** test-runner time. All **45 supplemental local probes / 576 assertions** passed, including the original 19 lifecycle/path probes, 16 normalization/scope-spelling controls, six original symlink repros and four traversal controls. Pinned-Pi cancellation/process cleanup, task isolation, explicit repair and its cancellation, plus asynchronous freshness refresh remain green. These are local scripted-provider fixtures and single-agent implementation/self-review evidence, not live-model or independent acceptance.

**Native bash, the command runner, dependency pins and the single repair owner are unchanged.** `src/runtime/pi.ts` changes only edit/write observation-path handling; earlier statements below about that file being unchanged describe the preceding checkpoints. No watcher, shell override, recovery/model expansion or integration was added. Path lookup and scope observations remain non-atomic and cannot reconstruct an alias replaced concurrently with observation. Windows remains unvalidated. Backburner references remain parked.

## Native-edit invalidation review correction (2475975)

Review of `7ce29ad..43073d7` reproduced a P2 gap: a scoped pass → native write creating an included file → native removal of that file → another managed check reused the old pass. Casper recorded the edit but refreshed input identity only at check boundaries, so restored directory membership erased the invalidating observation.

The user-approved correction forwards existing native edit/write observations into the task's frozen scopes. Matching evidence stays invalidated until a new execution; a per-check edit revision also catches observed edits during a running check, even if its before/after fingerprints match. An asynchronous freshness refresh cannot overwrite that invalidation. Failed native edit/write paths conservatively invalidate possible partial writes without claiming a completed edit. Excluded/unrelated paths do not invalidate other scopes, and observations neither select checks nor inherit the receipt's 32-path limit. Explicit repair shares its active evidence with these observations without exposing the opt-in tool.

Regressions use `CasperApp.runOnce()` and `RuntimeTool.execute()` with real commands. The original case, overlapping native edits, possible partial writes, and explicit-repair reuse were made red before their corrections. The permanent pinned-Pi/local-provider regression now executes **two** commands across check → native write → native removal → check → reuse. The existing vertical fixture still executes **three** commands with **one** repair prompt. Separate local-provider cancellation and fresh-task probes remain green.

Validation: **79 focused repository tests / 553 assertions** passed (evidence, verification/app, memory, managed checks, and three selected pinned-Pi cases). The subsequent pre-commit full gate, `bun run check`, passed with TypeScript clean and **254 tests / 1,581 assertions**, **70.02 s** test-runner time. This remains single-agent inspection/local-fixture evidence, not live-model or independent acceptance. Native bash, `src/runtime/pi.ts`, the command runner and dependency pins are unchanged. Unobserved shell/external mutations still rely on bounded non-atomic scope observations; no watcher, shell override, recovery/model expansion or push was added. The user separately authorized the correction checkpoint commit and handoff.

## Work-driven managed-tool follow-up

The opt-in `casper_check({ check: "test" })` slice is implemented and included in the checkpoint. `--verify` / `autoVerify: true` exposes it during normal tasks. The model sees all available configured commands and selects checks from actual work; the classifier no longer controls execution or filters the advertised checks. If the model selects none (including docs-only/no-change work), the receipt says no verification was recorded. Explicit `/verify` remains local and starts fresh.

`src/verify/task.ts` replaces the repair loop's private evidence cache with one task-local module shared by tool calls and the existing repair owner. It uses the unchanged command runner and frozen command/scope registry. Tool arguments cannot supply commands, scopes, cwd or timeout overrides. It serializes managed checks, observes cross-check invalidation, revokes captured tools at task end, and drains/cancels queued and running checks on shutdown. It does not serialize native writers or external processes; scope observations remain non-atomic.

At normal task completion:

- Valid scoped passes need no duplicate command.
- Selected stale/unavailable passes are rechecked once; known-stale failures are rechecked in case the model already fixed them. Unknown/self-mutating inputs stay qualified if observation is still unavailable/stale. Freshness alone never starts repair.
- Unresolved actual failures enter `verifyAndRepair` after the primary prompt settles. The tool itself returns evidence and never prompts for repair. Successful managed checks inside repair share the same cache and can avoid duplicate reruns. Existing attempt limits and regression selection remain in force.
- Terminal error/cancellation stops further execution/repair and retains already-executed evidence as blocked. New tasks and explicit `/verify` never inherit prior evidence.

### Follow-up evidence and limits

`tests/work-driven-checks.integration.test.ts` exercises the agreed `CasperApp.runOnce()` and `RuntimeTool.execute()` seams with real commands. The first red test was the full vague-request → edit → selected check → scoped reuse → later edit → failure → repair path. Further red tests exposed finalization after partial edits, keyword-filtered guidance, duplicate concurrent execution, queued work after cancellation, and cross-check invalidation; those paths now pass.

`tests/phase8-pi.integration.test.ts` also exercises that path with pinned Pi **0.85.1**, real native write/edit/bash tools, and an isolated localhost provider fixture. Both vertical fixtures execute the selected managed check **three times** (pass, fail, repaired pass), despite repeat calls and repair validation. There is one bounded repair prompt and no additional human approval. The Pi fixture uses nine scripted provider responses, not a live model. A separate native `kill -TERM $$` call still resolves successfully with no exit evidence; it remains diagnostic, never a managed pass. The managed runner reports signal termination as failure with a null exit code and the real signal.

Additional seam coverage includes opt-in/default behavior, no selection, missing checks, strict arguments, frozen commands/scopes, bounded output, unknown scope, excluded generated output, concurrent checks, overlapping external/partial edits, cancellation/process-group cleanup, shutdown, old-tool revocation, and fresh tasks/explicit verification. Unknown-scope repeated calls deliberately rerun: two tool calls plus task finalization execute three commands; a valid unchanged scope executes once. This is the cost of unavailable evidence, not a claim of deduplication for arbitrary commands.

Native bash and `src/runtime/pi.ts` are unchanged. The SDK's `BashOperations` remains a trustworthy execution seam, but using it transparently would require owning the bash definition. This smaller subset uses Casper's platform shell/inherited environment, not Pi's bash prefixes/session environment injection. There is no automatic scope inference, dependency freshness certification, live-model selection benchmark, comparative cost/speed claim, or independent review. Current full-gate results are recorded in `docs/HANDOFF.md`.

## Contract

| Fact | Meaning and consumers |
|---|---|
| Command outcome | Check `status` and actual `exitCode` describe execution. Report `status` aggregates selected commands: pass, fail, incomplete (skips/no commands), blocked. Freshness never rewrites the command outcome. |
| Input freshness | `fresh`, `stale`, or `unavailable`, **within the declared scope at observation time**. Stale/unavailable evidence cannot support reuse and explicitly leaves current files unverified. Known invalidation persists until a new execution, even if directory membership is later restored. |
| Scope | Optional per-check `inputs` and `exclude` paths, frozen with the command. No declaration means unavailable freshness and no reuse. Scope is declared, not inferred from request words, `.gitignore`, or dependency manifests. |
| Behavioral coverage | Passing checks do not certify requested behavior. The shared summary stores `coverage: not-certified`; human acceptance remains separate and initially null. |

CLI exit **0** means successful selected commands (or ordinary task completion without verification), **1** failure/blocked, **2** skips/no commands. Terminal task cancellation/error handling is unchanged. A stale successful command now exits 0 with an explicit stale qualification, not an unqualified claim of current verification. Receipts say `Checks pass (command execution)` rather than `Verification pass`.

`src/verify/evidence.ts` owns the compact projection used by report/result rendering, task receipts, and durable outcomes. Saved checks retain name/status, exit code, scope, freshness and a bounded freshness reason; no stdout/stderr, command transcript, or fingerprint is stored. New outcomes mark their status meaning as `command-execution`. Legacy outcomes remain readable and are labeled legacy in `/memory outcomes`; absent freshness becomes unavailable, not invented freshness. Reading history does not rewrite old files or revalidate them against today's workspace.

## Explicit input scope

Project-local `.casper/project.yaml` example:

```yaml
verify:
  test: bun test
verification:
  scopes:
    test:
      inputs: [src, tests, package.json, bun.lock, tsconfig.json]
      exclude: [tests/coverage]
```

Paths are literal project-relative files/directories, not globs. Directories are recursive; `.` means the root. Limits: 32 paths per list, 256 UTF-8 bytes per path, 2 KiB per declaration. Traversal, absolute paths, unknown fields, and exclusions covering an entire declared input root are rejected. Commands without scopes still execute normally.

The old implicit whole-workspace policy is replaced, not supplemented with a second cache. `workspaceState(cwd, scope?, signal?)` now returns either `{ fingerprint }` or `{ reason }`. **The direction review's old `state !== undefined` availability probe must not be used with this interface.**

Within the declared scope:

- File bytes, identity/metadata, directory membership and modes contribute to evidence. Explicitly missing named inputs are observed as absent, so creation/deletion changes identity.
- Excluded artifacts do not affect identity through parent directory timestamps. Included ignored files still count as inputs.
- Included symlinks, symlinked parents, special files, I/O failures and observation limits disable reuse with a specific reason.
- Bounds remain 1 MiB/file, 16 MiB total, 4,096 work items, 500 ms checked between I/O operations. No budget increase or filesystem watcher was added.
- Both before and after observations must succeed and match. A later successful observation cannot upgrade missing execution-time evidence. Freshness refresh also invalidates the task-local cache.

**Limits:** a scope is an assumption about relevant local inputs, not discovered coverage. The sample does not observe installed `node_modules`, environment, external tools/services, or unlisted files. A lockfile does not prove the installation is unchanged. Changes outside scope can go undetected; include relevant inputs or leave scope undeclared to disable reuse. Before/after observations are not atomic and cannot rule out every transient change during a command. Changes after reporting remain outside the receipt's observation window. Exclusions are not a sandbox or permission policy.

## Regression evidence

The original successful-build/symlink test was made red before changing aggregation. Further red tests exposed missing scope support, missing receipt qualifications, lost durable qualifications, named-input deletion being reduced to unavailable, and stale cache entries reviving after repair restored directory membership. Each was fixed and rerun.

Real command results now covered through verification and the CLI:

| Scenario | Exit | Freshness | Report / CLI |
|---|---:|---|---|
| Artifact-only build, no scope | 0 | unavailable: no declaration | pass / 0 |
| Same build + unrelated symlink, no scope | 0 | unavailable: no declaration | pass / 0 |
| Artifact-only build, declared unchanged source input | 0 | fresh within scope | pass / 0 |
| Same scoped build + unrelated out-of-scope symlink | 0 | fresh within scope | pass / 0 |
| Check writes a declared source input | 0 | stale, current files unverified | pass / 0 |
| Later check deletes a named input | 0 | earlier result stale | pass / 0 |

Additional coverage: ignored source edits, included membership/permission changes, overlapping external edits, coverage output, dependency-heavy fixtures, partial/missing observations, unsupported inputs, cancellation, scoped repair reuse, invalidation after repair, frozen scopes/commands, history reopening/legacy inspection, strict bounded saved-field validation, and actual verifier failures reaching the existing repair callback. Existing native-tool diagnostic-only and cancellation regressions remain intact.

The scoped two-check repair fixture executes **test twice and build twice** (four actual commands), reusing the unchanged targeted test pass during the regression selection even though build writes excluded artifacts. This is a fixture command-count result, not a live-model productivity benchmark.

## Checkout diagnostic probes

Five whole-tree observations with explicit `inputs: ["."]` were unavailable. They now identify the first unsupported input:

```text
node_modules/.bin/anthropic-ai-sdk — symlink or special file
```

Durations: 55.53, 29.71, 32.23, 26.41, 22.81 ms.

Five observations of the explicit subset `src`, `tests`, `package.json`, `bun.lock`, `tsconfig.json` succeeded: 17.37, 15.83, 19.21, 16.76, 18.70 ms. This only establishes applicability for that subset on this checkout. It does **not** establish dependency freshness or complete check coverage. No scope configuration was silently installed into Casper's checkout.

Updated probe:

```sh
bun --eval 'import {workspaceState} from "./src/verify/workspace-state.ts";
const scope={inputs:["src","tests","package.json","bun.lock","tsconfig.json"]};
for(let i=0;i<5;i++){const start=performance.now();const state=await workspaceState(process.cwd(),scope);
console.log({available:!!state.fingerprint,reason:state.reason,ms:performance.now()-start});}'
```

## Initial contract-slice validation (historical)

- `bun run check`: TypeScript passed; **232 tests / 1,396 assertions**, 64.05 s test-runner time.
- Tests run real local commands, local-protocol Pi fixtures and language servers; no external inference or production service evaluation.
- Temporary reproduction fixtures were removed. The pre-existing review/handoff content is preserved; the handoff has a short follow-up pointer.

At that checkpoint, the complete work-driven path was still pending and automatic selection was keyword-based. The follow-up above now exercises that path using the managed subset. Native Pi shell observations remain diagnostics only. Recovery/model adjustment, new autonomy defaults and live-model evaluation still require separate authorization; fixture acceptance is not daily-driver readiness.
