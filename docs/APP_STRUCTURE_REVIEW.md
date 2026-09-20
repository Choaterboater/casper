# CasperApp first structural slice — completion review

## Scope and baseline

The user approved completing the bounded refactor in
[APP_STRUCTURE_PLAN.md](APP_STRUCTURE_PLAN.md): separate slash-command dispatch
from normal model tasks and extract passive task observations. This is not a
whole-app rewrite or completion of Phase 9.

Reviewed against the pre-edit working-tree snapshot at:

`/var/folders/yj/l1q2ypcj68qck8m_kcrdv26r0000gp/T/casper-app-refactor-baseline-42ivg7ee`

Its `files/` directory preserves tracked and untracked file contents, and
`manifest.json` records hashes/modes. Compared the snapshot to current files using
unified diffs; new files were reviewed directly. At review time, HEAD was
`c8df2235209a2d74e5f5a4a8765c798ec2226cbf`; a HEAD-only diff would incorrectly include
older unrelated work. No commits were created during that review; subsequent local
checkpoint IDs are recorded in [HANDOFF.md](HANDOFF.md).

Review is **single-agent**, with Standards and Spec assessed separately. No
independent/subagent tool was available, and no reviewer model was called. Local
plan documents supply the spec; the missing tracker configuration does not create
an issue or imply tracker closure.

## Standards

**0 findings.**

The runtime-adapter isolation and small-interface principles in the complete plan
are preserved. `TaskObservations` uses runtime-neutral types, owns its collections,
and has three entry points: record an edit, observe a tool result, and take a
snapshot. It introduces no Pi imports, I/O, lifecycle hooks or callback-heavy host
interface. It is not added to `src/index.ts`.

The change removes duplicate ownership of observation rules from the app rather
than layering a second implementation over them. Shared command names and output
bounding are reused. No actionable Fowler-smell finding was confirmed in this
bounded diff; static type/style checks are reported separately below.

## Spec

**0 findings.**

- “Retain `handlePrompt()` as the common command-lifetime wrapper”: command
  exclusion, state reset, workspace rebind and the existing cleanup `finally`
  remain there. Slash-prefixed input selects `handleSlashCommand()`; other input
  selects `runModelTask()`. Unknown slash commands still fail locally.
- “Keep existing handler validation and wording”: all command branches, arguments,
  return values and output strings remain unchanged. Slash commands that can use
  a runtime/model keep their existing behavior; none is assumed inherently local.
- “Extract task observations, not task lifetime”: only bounded edit paths, shell
  observations and possible-write classification move. A fresh instance is created
  at the existing per-command reset, and snapshots detach nested check records.
- “Keep evidence invalidation in the app”: successful native edits invalidate
  before post-edit LSP work; failed writes retain conservative invalidation.
  Receipt limits cannot suppress invalidation. Runtime failure/cancellation,
  verification evidence and repair ownership are unchanged.
- Capability selection/caching, runtime and terminal adapters, workspace managers,
  dependencies, credential handling and the barrel surface are unchanged.

The app remains a substantial control layer (964 lines, previously 979). The new
37-line module consolidates observation ownership; this is not a claim that every
future extraction or maintainability concern has been resolved.

## Validation

One characterization was added at the agreed `CasperApp` seam before source edits:
“task observations retain bounded latest shell diagnostics, detached results and
command-local state.” It passed on the original implementation and after both
refactor steps. It verifies exact trimmed-command matching, ignoring non-shell and
nonmatching results, latest diagnostic retention, UTF-8-safe output bounds,
detached returned data, local-command clearing, and a clean subsequent chat receipt.
It does not inspect private fields or depend on the new module's implementation.

This was a behavior-preserving refactor, not a bug fix: no artificial red result
is claimed. Existing regressions were retained without weakened assertions.

| Gate | Result |
| --- | --- |
| Pre-edit characterization | 1 test / 15 assertions, passed |
| Dispatch split: typecheck + app/Phase 3 regressions | TypeScript clean; 38 tests / 250 assertions, passed |
| Observation extraction: typecheck + Phase 3/work-driven checks | TypeScript clean; 65 tests / 455 assertions, passed |
| Final serial isolated `bun run check` | **432 tests / 4,787 assertions**, TypeScript clean; 34 files; test portion **136.61 s** |

All test invocations used temporary HOME directories and an allowlisted environment
with explicit offline Pi configuration. Localhost protocol fixtures are not
live-provider trials. The full gate includes production CLI picker/terminal PTYs,
model-selection diagnostics, workspace/consent behavior, partial-write evidence,
shutdown and verifier process-group cleanup. The cleanup test passing does not
diagnose the previously documented intermittent SIGTERM failure.

`git diff --check` passed. All seven website files, twenty acceptance-evidence files,
dependency pins, CLI mode and unrelated working-tree hashes/modes match the snapshot.

## Completion

Only `src/app.ts`, new `src/task/observations.ts`, one existing integration-test file,
and the app-structure/handoff documents changed. The first slice is complete.
This review predates the authorized checkpoint. No live-provider calls, personal
credential changes, commits, pushes, OAuth work, saved O4 application or Phase 9
promotion occurred during the refactor/review itself.

**Summary:** Standards 0 findings; Spec 0 findings. No outstanding finding from
this bounded single-agent review. Further architecture or product work requires
separate scope.
