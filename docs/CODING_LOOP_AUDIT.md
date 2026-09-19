# Casper coding-loop audit

2026-09-19. Baseline implementation audit with a reviewed partial-checkpoint update. The original findings below describe the pre-slice behavior unless a status note says otherwise; they are not all current defects. See `CODING_LOOP_REVIEW.md` for corrections and scope limits.

## Agreed direction

Keep Pi's direct working loop. Other projects are references and learning experiences, not a blueprint for recreating SkyN3t. No aggregate score, mandatory council, or factory pipeline. Relevant checks supply repair feedback; failed checks do not erase useful work or automatically justify another approval ceremony. Report uncertainty rather than claim success. The measure is less supervision on real tasks.

This supersedes the earlier emphasis on a mandatory proposed-finish gate in `HARNESS_COMPARISON_RESEARCH.md`. Truthful reporting remains necessary; adding another blocking acceptance subsystem is not the recommendation.

## What actually runs today

```text
request
  → keyword classification + selected skills + project memory
  → prepare tools
  → Pi prompt: inspect / edit / shell / repeat as the model decides
      → native edit/write optionally awaits connected LSP diagnostics
  → Pi stops
  → only with --verify and a matching modification classification:
      selected applicable checks, sequentially
      → within this verification run only, reuse passes with matching filesystem evidence
      → failures → another prompt in the same session
      → rerun failed checks
      → if all those pass, rerun the whole selected set, reusing still-fresh passes
      → repeat up to configured repair count
  → print verification report; record model/check outcomes separately
```

The reviewed checkpoint uses bounded before/after filesystem fingerprints for Casper-run checks, not an event counter. Later file changes (including external, partial, and verifier writes) make previous evidence stale. Unsupported or oversized trees disable reuse and disclose unavailable freshness, without preventing command execution. There is no cache across requests. Native edits and bounded exact-command shell results are observed separately: a Pi tool success is not an exit code or reusable pass. The earlier provisional shell-harvesting/revision-cache implementation was unsafe and has been replaced.

Sources: `src/app.ts`, `src/runtime/pi.ts`, `src/runtime/observation.ts`, `src/task/classify.ts`, `src/verify/repair-loop.ts`, `src/verify/workspace-state.ts`.

**Important correction:** normal Casper coding is not currently a score-gated factory. The parent gets native read/bash/edit/write tools and Pi drives their loop. The default policy is high autonomy and questions only when blocked (`src/config/load.ts`). The parent is not forced through subagents, worktrees, or verification. Do not manufacture a rewrite to remove machinery that is not in the default path.

## Findings

### 1. Verification is disconnected from observed work

`autoVerify` defaults false (`src/app.ts:140`; CLI enables it with `--verify`). When enabled, the decision still depends on initial request words, not whether files changed or checks already ran.

Read-only classification probes reproduced:

| Request | Current classification | Automatic checks |
|---|---|---|
| Make the login button work | general / read | none |
| Continue | general / read | none |
| Fix the typo in README | fix / modify | typecheck, lint, test, build |
| Explain why the build fails | document / modify | none |

These labels are prompt guidance, not parent-tool restrictions. Pi may still do the right work; the outer verification policy is what misses it or adds unnecessary work. `tests/phase3-app.integration.test.ts` confirms opt-in behavior.

**Slice status (partial):** command selection still depends on classification. Casper-run passes can be reused only within one verification invocation when bounded local filesystem evidence matches. Raw shell observations cannot satisfy verification. Replacing keyword authority and safely reusing model-run native checks remain pending.

**Recommendation:** keep classification advisory for context/skill hints, not authoritative for deciding what was changed or verified. The next refinement should replace keyword selection with edit/check relevance, without turning this into a general acceptance engine.

### 2. Missing optional commands become an “incomplete” result

**Status:** corrected for automatic verification by filtering to available commands. Explicit missing checks remain skips; no available commands remains incomplete. The following is the baseline finding.

Most non-test modification classifications request all four check categories. The registry produces `skip` for undefined commands; `verificationStatus()` treats any skip as incomplete. In one-shot mode that maps to exit code 2.

The integration test explicitly expects incomplete after a successful repair because other categories are missing. A repository without a build or lint command is not necessarily missing required verification.

Sources: `src/task/classify.ts`, `src/verify/registry.ts`, `src/verify/evidence.ts`, `src/cli.ts:105–107`, `tests/phase3-app.integration.test.ts:100–121`.

**Recommendation:** distinguish not-applicable categories from a required check that could not run. Show exactly which checks ran and their scope. Do not silently count missing evidence as success; equally, do not demand four categories from every repository. Explicit `/verify build` with no build command should still explain that it cannot run.

### 3. Repair feedback exists; adaptive recovery does not

The repair prompt includes the original request, rules, changed-file names, and actual failing command output. It reuses the session. Those are useful existing mechanisms worth retaining.

But each iteration uses the same basic repair instruction. There is no failure fingerprint, evidence-of-progress comparison, strategy-change policy, or effort/model-control interface in `RuntimeSession`. `maxAttempts` defaults to three. Missing executables, timeouts, and code failures all enter the same `fail` collection; cancellation is separately recognized by the outer loop.

Sources: `src/verify/repair-loop.ts`, `src/verify/command.ts`, `src/runtime/types.ts`.

**Recommendation:** retain bounded diagnostic feedback, but distinguish environment/provider/code failures and repeated unchanged failures. For repeated failures, ask the model for a different hypothesis and relevant inspection—not another identical repair prompt. Expose supported effort changes through the thin adapter when this behavior is implemented. Model switches remain user-approved unless separately preauthorized. Do not assume a particular vendor or higher reasoning is always better.

### 4. Duplicate work can increase verification latency

**Status:** single-check duplicate rerun removed; multi-check regression selections now reuse filesystem-matched passes within the same invocation. Unknown state disables reuse. Native shell-check reuse remains pending. The following is the baseline finding.

Checks run sequentially. After a targeted repair passes, the full selected set includes that same check again. With one selected test, the current sequence is fail → pass → pass without an intervening repair. Existing tests assert this. Tests run by Pi's own bash tool are not harvested as Casper verification evidence, so a successful model-run check can also be repeated afterward.

Connected LSP servers are awaited after each native edit/write, with diagnostic waits using a default 10-second manager timeout; matching servers are visited serially. This can delay the next model step when servers are slow. Shell-written files do not use this particular edit hook.

Sources: `src/verify/repair-loop.ts:run/targeted`, `src/verify/registry.ts:run`, `src/runtime/pi.ts:tool_result`, `src/lsp/manager.ts:afterEdit/waitReport`; verification tests.

**Recommendation:** reuse fresh, equivalent evidence and run only checks still needed. Preserve regression coverage without rerunning the identical successful check on unchanged relevant state. Measure LSP wait time before choosing a batching/coalescing change. Do not blindly parallelize commands: checks can share build state or mutate files.

### 5. Casper cannot yet reason richly about progress through its adapter

**Status:** correlated, bounded identity fields and shell output are now exposed; no arbitrary edit bodies or raw result database. Tool-reported status is kept separate from process exit evidence. Progress-based recovery remains pending.

Tool events expose only tool name and error flag, not call identity, arguments, outputs, source changes, or check attribution. Runtime state exposes cwd/streaming only. The underlying Pi conversation has richer information, but Casper's interface does not surface it for recovery policy.

Sources: `src/runtime/types.ts`, `src/runtime/pi.ts:bind`.

**Recommendation:** expose only the observations needed for freshness and recovery, with bounded/redacted diagnostics. Keep Pi in charge of tool execution. Avoid building a parallel transcript database, generalized event platform, or a second agent orchestrator.

### 6. Completion and evidence are partly honest but not tied together

**Status:** task execution receipts/CLI status and filesystem freshness reporting are now implemented. Terminal error/abort is distinguished from Pi-recovered provider errors. Requested behavior and human acceptance remain uncertified. The following is the baseline finding.

Memory correctly separates model completion, verification, and human acceptance; `accepted` starts null. There is no aggregate quality score. However:

- Verification evidence has command/output/timing but no source identity or ongoing freshness contract.
- Task outcome persistence keeps check names/statuses, not full command evidence.
- The frozen command string does not freeze the test implementation or a package script's contents. The repair prompt asks the model not to weaken checks; that is not enforcement.
- Assistant text streams before the optional post-task checks, so a confident final statement can precede a failing verification report.
- A nonthrowing runtime error stop sets an internal task flag, but `runOnce()` returns only a verification report or undefined. CLI exit status uses that report, not the task flag. Thus there is no general task-failure exit contract for that path.

Sources: `src/verify/evidence.ts`, `src/verify/registry.ts`, `src/app.ts:handlePromptCommand/handleRuntimeEvent`, `src/memory/store.ts:recordOutcome`, `src/cli.ts`.

**Recommendation:** finish with a compact factual receipt: changed work, checks actually run, unresolved problems, and whether execution was interrupted/failed. Use a small structured task result for CLI/programmatic consumers. Preserve edits; do not introduce a score or block handoff simply because some evidence is unavailable. Make relevant check changes visible and invalidate evidence after relevant edits.

### 7. Steering and local permission behavior lag the desired daily-driver loop

Interactive input waits for `handlePrompt()` to finish; the runtime interface exposes no steering/follow-up operation. SIGINT closes the whole app, not just the active task. Cleanup exists, but “stop this attempt, keep my session, change direction” is not a first-class Casper action.

Native local writes run directly, while LSP rename requires exact interactive confirmation and is refused when no readline is active. Workspace rebinding disconnects MCP/LSP and demands fresh explicit connection consent. These are inconsistencies with a persistent approved-repository workflow, not evidence that every normal edit is currently blocked.

Sources: `src/app.ts:runInteractive/confirmRename/confirmExact/rebindWorkspace`, `src/cli.ts:installShutdownHandlers`, `src/runtime/types.ts`.

**Recommendation:** task-level stop/steer without app teardown; coherent persistent repository approval for ordinary local work and local refactors. Keep consequential external actions separate. Retain cancellation, stale-result checks, and changed-endpoint/config awareness rather than removing them as “friction.” Parent tool policy is currently partly prompt guidance, not a sandbox.

## Minimal implementation sequence for agreement

1. **Correct reporting and eliminate unnecessary checks.** Small task-result contract, applicable-vs-required check distinction, truthful final receipt, no automatic duplicate single-check rerun. Keep explicit verification commands useful.
2. **Connect check feedback to the direct loop.** Observe actual edits/checks, freshness and scope; let relevant checks guide repair without forcing a four-stage pipeline. Avoid expensive broad checks on every edit. Decide default automatic behavior from this narrow implementation, not by simply turning on today's `--verify`.
3. **Recover based on evidence.** Differentiate failure kinds, recognize repeated nonprogress, change approach, support justified effort adjustment and approved model switching. Keep one recovery owner, not nested retry loops.
4. **Remove control friction.** Task stop/steer and consistent approved-repository behavior; measure LSP latency. No MCP expansion or new visualization work in this slice.

Keep each increment independently usable. No new scoring subsystem, mandatory review agent, full acceptance DSL, or factory architecture.

## Baseline validation (historical; current evidence is in CODING_LOOP_REVIEW.md)

Executed:

`bun test tests/phase3-verification.test.ts tests/phase3-app.integration.test.ts tests/casper-app.integration.test.ts`

Result: **25 passed, 0 failed, 151 assertions; 7.92 seconds**. These include real temporary command execution and fake runtime repair integration. They establish current behavior, not live-model coding quality or an end-to-end performance improvement. Classification examples above were executed against `classifyTask` without modifying files.

No live inference, production MCP calls, dependency changes, or implementation edits. Future validation should use representative daily coding tasks with comparable models; measure accepted results, interventions, useful elapsed work, and cost—not a new quality score.
