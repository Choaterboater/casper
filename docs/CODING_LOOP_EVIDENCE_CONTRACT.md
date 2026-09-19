# Coding-loop evidence contract — narrow correction

Implemented after the direction review at `7ce29ad`, with user approval for the contract-and-regression slice. Included with the managed-tool follow-up in the user-requested checkpoint. This is implementation validation and self-inspection, **not independent review or daily-driver readiness approval**.

The original `CODING_LOOP_DIRECTION_REVIEW.md` remains the historical assessment. Its work-driven-selection finding is now addressed by the managed-tool follow-up below, not by transparent shell reuse. No recovery/model expansion, native-shell exit inference, new verification default, external inference, credential access, or push was added.

## Native-edit invalidation review correction

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
