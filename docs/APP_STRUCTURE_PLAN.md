# CasperApp structure — bounded first slice

Status: **approved, implemented and locally reviewed; complete**.
See [HANDOFF.md](HANDOFF.md) for the subsequent local checkpoint state.
The user confirmed completion of this slice and its app/CLI test seams. See
[APP_STRUCTURE_REVIEW.md](APP_STRUCTURE_REVIEW.md) for the comparison, review and
**432-test / 4,787-assertion** serial gate. The design rationale below is retained.

This slice responds to the external project review. It does not authorize a
whole-app rewrite, capability caching, dependency changes, OAuth, Phase 9 promotion,
live-provider trials, credential changes, commits or pushes.

## Evidence and objective

`src/app.ts` is 979 lines. `handlePromptCommand()` combines slash-command dispatch
with normal task preparation, prompting, verification and outcome recording.
Runtime events also maintain task observations in the app. This is a locality
problem, not proof that the architecture or existing behavior is broken.

The external review's alleged missing-argument `learn` bug and tracked `.DS_Store`
files were not confirmed. Learning arguments already have count guards and a
regression. No tracked `.DS_Store` files exist. No cleanup tickets are warranted
for those claims.

Goal: make the distinction between commands, model tasks, and lifetime management
explicit, while keeping the existing `CasperApp` interface and user behavior.
Do not measure success by reaching an arbitrary line count.

## Ownership that must remain intact

| Owner | Responsibilities retained |
| --- | --- |
| `CasperApp` | Command exclusion, cancellation, shutdown, lazy runtime startup, active workspace/session, consent coordination, skill/memory task preparation, task completion and outcome persistence |
| `VerificationTask` / existing repair loop | Managed command authority, freshness, edit invalidation, check cancellation, bounded repair and evidence |
| `InteractiveTerminal` | Rendering, draft/history/input ownership, fresh confirmation input and picker handoff |
| Existing MCP/LSP/reference/session managers | Their current resource, trust, connection and workspace responsibilities |
| Internal `TaskObservations` module | Bounded edit-path observations, matching shell diagnostics to configured checks, possible-write flags, detached observation snapshots |

The observation module does **not** execute tools, determine verifier success,
invalidate evidence, start repair, persist memory or own cancellation.

“Slash command” must not be confused with “no model use”: `/model` initializes the
runtime without generation, `/delegate` can run a child, and `/verify repair` can
prompt the parent. Existing consent and lazy-start semantics remain per-command.

## Alternatives considered

These alternatives were compared locally; no subagent/independent design review
was available.

1. **Handler map only.** Shortens dispatch, but leaves shared task state and lifetime
   coupling untouched. Useful syntax, insufficient architectural change alone.
2. **External router plus full task runner.** Moves many lines, but currently needs
   access to runtime startup, mutable workspace state, confirmations, verification,
   memory, tools and shutdown. A large host interface would move complexity rather
   than hide it. Reject for this slice.
3. **Explicit command/task paths plus passive observation ownership. Recommended.**
   Keep the app as the lifetime owner, name the two execution paths separately, and
   move one coherent group of data and rules into an internal module. Small scope,
   no new framework, no duplicate lifetime owner, existing test seams remain useful.

## Approved first implementation slice

### 1. Separate paths inside the app

Retain `handlePrompt()` as the common command-lifetime wrapper. After its existing
checks, state reset and required workspace rebind:

```text
slash-prefixed input → handleSlashCommand(input)
ordinary input       → runModelTask(input)
```

`handleSlashCommand()` contains the current local dispatch and unknown-command
rejection. `runModelTask()` contains the existing normal-task preparation and
completion path. Keep existing handler validation and wording; do not introduce
new parsing rules, command normalization, aliases or return conventions.

In particular, preserve the location of `try/finally` blocks, cancellation checks,
and outcome writes. Do not make failed preparation suddenly record a completed
task or let unknown commands fall through into generation.

### 2. Extract task observations, not task lifetime

Internal file: `src/task/observations.ts`. Design sketch (implementation uses existing project/runtime types):

```typescript
class TaskObservations {
  recordEdit(path: string): void;
  observeToolEnd(event: ToolEndEvent, commands: ConfiguredCommands): void;
  snapshot(): TaskObservationSnapshot;
}
```

Use existing runtime-neutral event and project command types. The app supplies
its current configured commands when observing a tool result, preserving today's
matching behavior rather than introducing a second configuration cache.

Move these rules together from `CasperApp`:

- Bounded observed edit paths (32 entries, 512-character path previews).
- Tool-end possible-write classification, including failures/partial writes.
- Exact configured-command matching for shell observations, with the existing
  command-length bound and bounded diagnostic output.
- Fresh, detached observation snapshots for the existing `TaskResult`.

Replace the app's three observation collections/flags with one command-scoped
instance. Reset it at the same command boundary as today, including local commands.
Keep runtime failure/cancellation state in the app because it gates verification
and repair. Keep evidence invalidation in the app before awaiting post-edit LSP
work; a full receipt must never disable invalidation after its edit list fills.

Do not export this internal module from `src/index.ts`. Its dependencies are
in-process types and observation formatting; no new adapter or I/O abstraction
is needed.

## Agreed test seams and acceptance

The user approved these seams with the implementation slice:

- **App seam:** `CasperApp.runOnce()`, `getLastTaskResult()`, `close()`, and existing
  injected `AgentRuntime` fixtures. Assert commands, outcomes and cancellation,
  not private methods or the new module's field layout.
- **CLI/terminal seam:** existing isolated CLI and real PTY exercises. Keep model
  selection, draft/history and confirmation coverage intact.

Prefer existing behavior tests unchanged. Add a characterization only for a
specific uncovered behavior touched by the extraction; do not introduce redundant
internal tests merely because a new file exists. A behavior-preserving refactor
need not manufacture a failing test when the behavior is already covered.

Relevant coverage already exists:

- `tests/casper-app.integration.test.ts`: local commands stay local; unknown
  commands fail; local commands clear the prior task result and create no outcome.
- `tests/phase3-app.integration.test.ts`: detached results, error/abort stops,
  recovered provider errors, shell diagnostics vs verifier evidence, explicit
  repair objectives, startup and shutdown behavior.
- `tests/work-driven-checks.integration.test.ts`: task-local authority/evidence,
  bounded receipts independent of edit invalidation, failed partial writes,
  one repair owner and cancellation of real checks.
- Phase 6/8/9 integration tests: visualization shutdown, workspace/delegation
  behavior, facts fallback and outcome persistence.
- Model and terminal regression tests: `/model`, cancellation, input ownership,
  diagnostic sanitization, NO_COLOR and fail-closed confirmations.

Implementation completion requires targeted checks followed by serial isolated
`bun run check`, diff review against a fresh preservation baseline, and unchanged
website/acceptance evidence and unrelated dirty work. Do not relax cleanup tests
or interpret a green rerun as diagnosis of the historical verifier SIGTERM flake.

## Deferred work

- Full task-runner extraction or command-registration framework.
- Capability caching: tool selection is task-dependent; broker indexing already
  uses catalog revisions. Require measurements and explicit invalidation rules.
- Barrel narrowing and guarded-cast style changes without a demonstrated problem.
- Test-speed work without timing evidence; `test:fast` already exists as opt-in.

The first slice's completion criteria are met: the two execution paths are explicit
and observation rules have one owner, with no observed behavior change in the
characterization or existing regressions. Further extraction should follow a
concrete locality problem, not a file-size target. This completion does not close
Phase 9 or resolve the separately documented verifier-cleanup flake.
