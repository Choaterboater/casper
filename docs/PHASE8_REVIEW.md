# Phase 8 — Independent Standards / Spec Review

## Method and status

User-confirmed baseline: `f8bb28eaf0b79d3279587f5960657d1023e7555b` → current working tree, including untracked files. `git log f8bb28e..HEAD --oneline` is empty; a three-dot committed diff alone would miss this work. Phase 4/5 standalone changes were excluded.

Separate read-only Codex processes (`gpt-6-astra`, medium reasoning) ran each phase/axis independently, with user config/MCP disabled (`--ignore-user-config`), `--ephemeral`, and `--sandbox read-only`. Subsequent independent follow-ups verified corrections. Reviewers did not edit or run filesystem-writing suites; execution evidence belongs to the coordinator. Authorized reviewer-model calls were made, not production MCP connections or live Casper feature acceptance.

Standards sources: README, `docs/CASPER_COMPLETE_PLAN.md`, implementation documents and applicable safety contracts; no dedicated coding-standards file. Fowler smell baseline was supplied as optional heuristics. Spec source: complete plan and the phase-specific supported contracts.

**Final runtime disposition: reported actionable runtime findings resolved; no new actionable findings in the final follow-up.** Interactive MindMesh remains a separately disclosed broader §17A gap: JSON export is not interactive integration, and full §17A compliance is not claimed. Optional duplication heuristics remain advisory, not blocking violations. No commit or push.

## Standards

### Initial independent report

## Phase 8 — Standards

**Actionable findings**

- **P2 — Workspace exclusion has a race.** [src/app.ts:427–445](/Users/stephenchoate/Documents/Casper/src/app.ts:427) checks `subagents.isBusy` only before awaiting workspace operations; delegation at lines 543–559 has no reciprocal guard. Reproduction: begin `/switch main discard`, pause at confirmation, concurrently invoke `runOnce("/delegate explorer …")`, then approve the discard. The switch can remove the child’s workspace while it is reading. This breaches [PHASE8_IMPLEMENTATION.md:31](/Users/stephenchoate/Documents/Casper/docs/PHASE8_IMPLEMENTATION.md:31): “Workspace-changing commands are refused while child work or late cleanup is active.” Reserve workspace transitions synchronously and exclude delegation until transition and context rebinding finish.

- **P2 — Cancellation during Pi prompt preflight can still launch a model request.** [src/runtime/pi.ts:119–134](/Users/stephenchoate/Documents/Casper/src/runtime/pi.ts:119) checks cancellation before calling Pi’s asynchronous `prompt()`, then relies on a one-shot `session.abort()`. The installed SDK awaits authentication before creating its agent run; aborting during that await has no active run to cancel. Reproduction: delay authentication preflight, cancel the child, then release authentication successfully. Pi proceeds to create a fresh run, with no further caller-signal check before the request. The turn-end guard acts only afterward. This breaches the explicit runtime requirement to “honor cancellation” in [src/runtime/types.ts:81–83](/Users/stephenchoate/Documents/Casper/src/runtime/types.ts:81), supporting the cancellation contract in [PHASE8_IMPLEMENTATION.md:70](/Users/stephenchoate/Documents/Casper/docs/PHASE8_IMPLEMENTATION.md:70). Recheck/link cancellation at the actual agent-run or pre-request boundary.

**Optional heuristics:** None warranted; no speculative refactoring findings.

**Coverage/limitations:** Reviewed the scoped baseline-to-working-tree changes, all scoped new files in full, and relevant session/result/installed-SDK dependencies. Commit log was empty. Findings are from static control-flow inspection; reproduction scenarios were not executed. No tests, edits, commits, pushes, service contacts, or other reviewers’ reports were used. Standalone earlier-phase issues were excluded.

### First independent follow-up

## Phase 8 — Standards

**Resolved findings**

- **P2 — Workspace exclusion race: resolved.** [src/app.ts:288–298](/Users/stephenchoate/Documents/Casper/src/app.ts:288) reserves command/transition admission synchronously through context rebinding. The child factory also rejects captured delegate-tool calls during transitions or failed rebinding (lines 117–122). This satisfies the workspace-exclusion rule in `docs/PHASE8_IMPLEMENTATION.md:31`.

- **P2 — Cancellation during Pi authentication preflight: resolved.** [src/runtime/pi.ts:294–301](/Users/stephenchoate/Documents/Casper/src/runtime/pi.ts:294) checks the caller’s signal immediately before invoking the provider stream. The installed SDK reaches this boundary after asynchronous authentication resolution, closing the reported race and honoring `src/runtime/types.ts:81–83`.

**Remaining/new actionable findings**

No actionable findings within the Phase 8 Standards scope. The revised turn guard also covers truncated tool-call responses; child ownership, cleanup reservations, bounded reports, and read-only tool selection remain enforced.

**Optional heuristics**

None warranted. No speculative refactoring findings.

**Remaining scope limitation**

Interactive MindMesh remains unimplemented under complete-plan §17A. This is the disclosed broader integration gap, not a new Phase 8 runtime defect or a claim of complete specification compliance. Recovery-directory cleanup was assessed against the revised preservation contract, rather than expecting permanent deletion.

**Coverage/limitations**

Reviewed baseline-to-working-tree changes, scoped new files in full, applicable regression files, and relevant installed-SDK/session/worktree dependencies. Commit log was empty. Conclusions are from static inspection; I did not execute reproduction scenarios or tests. The coordinator’s reported 188 tests/1095 assertions were not independently verified. No edits, commits, pushes, service contacts, or other reviewers’ outputs were used. Standalone earlier-phase findings were excluded.

## Spec

### Initial independent report

## Phase 8 — Spec

- **P2 — Truncated tool calls bypass the model-turn limit.** [src/runtime/pi.ts:295–300](/Users/stephenchoate/Documents/Casper/src/runtime/pi.ts:295). Requirement: complete plan calls for “bounded explorer/reviewer roles”; Phase 8’s enforced bounds specify “Model turns | 12.” The limit check requires `stopReason === "toolUse"`. However, the installed Pi loop continues after `length` responses containing truncated tool calls, returning tool errors without invoking the tool preflight counter. **Reproduction scenario:** a provider repeatedly returns a truncated tool call with `finish_reason: "length"`. Casper permits request 13 and subsequent requests until another bound intervenes. Recording `limited` in the report collector does not stop execution. Enforce the turn ceiling independently of stop reason.

- **P2 — Workspace exclusion has a check/use race.** [src/app.ts:427–445](/Users/stephenchoate/Documents/Casper/src/app.ts:427), [550–559](/Users/stephenchoate/Documents/Casper/src/app.ts:550). Requirement: README states, “Workspace switches wait for child work to finish”; Phase 8 specifies that workspace-changing commands are refused while children or cleanup remain active. The busy check runs only before asynchronous workspace lookup, verification, and approval; delegation has no reciprocal transition guard. **Reproduction scenario:** an embedder starts `runOnce("/switch main discard")`, starts a concurrent `/delegate` while approval is pending, then approves discard. The switch proceeds and can remove the child’s worktree while it is reading. Serialize workspace transitions against child admission through completion of context rebinding. This affects concurrent app API calls; the sequential CLI loop does not itself trigger it.

Coverage: reviewed the scoped working-tree changes, all scoped new files in full, relevant complete-plan component sections, and adjacent Pi/session dependencies. Checked tool restrictions, cancellation, ownership, bounds, untrusted inputs, and mutation safety. No additional missing requirements or Phase 8 scope creep identified.

Static review only; no tests, model calls, service connections, edits, commits, or pushes performed. Prior review sign-offs were not used as evidence.

### First independent follow-up

## Phase 8 — Spec

- **Resolved — P2 truncated-tool-call turn-limit bypass.** Requirement: “bounded explorer/reviewer roles” and “Model turns | 12.” [src/runtime/pi.ts:302–307](/Users/stephenchoate/Documents/Casper/src/runtime/pi.ts:302) now checks tool-call content independently of stop reason. The installed Pi loop invokes this hook after handling truncated calls, preventing the previously described thirteenth request. The regression fixture covers repeated `length` responses.

- **Resolved — P2 workspace exclusion race.** Requirement: “Workspace switches wait for child work to finish.” [src/app.ts:288–298](/Users/stephenchoate/Documents/Casper/src/app.ts:288) reserves command/transition admission synchronously through rebinding; [src/app.ts:117–121](/Users/stephenchoate/Documents/Casper/src/app.ts:117) also blocks captured delegate callbacks during transitions or failed rebinding. Existing children retain capacity through cleanup. The pending-approval/concurrent-delegation scenario is blocked.

- **Remaining — P3 broader §17A integration gap, outside Phase 8 runtime defects.** Requirement: “MindMesh available? yes → interactive MindMesh.” With MindMesh available, requesting a visualization still produces serialized JSON through [src/visualize/mindmesh.ts:38–58](/Users/stephenchoate/Documents/Casper/src/visualize/mindmesh.ts:38), without interactive integration. This disclosed optional-live-integration gap remains; it is not complete compliance with §17A.

**No actionable findings** newly identified in Phase 8. No additional Phase 8 missing requirements or scope creep found.

Coverage: reviewed current scoped working-tree changes, scoped new files in full, relevant specification sections, regression files, and adjacent Pi/session/workspace dependencies. Checked cancellation after auth preflight, tool restrictions, bounds, ownership, transition admission, and failed-rebind behavior. Examined recovery-directory cleanup as deliberate byte preservation rather than permanent deletion.

Static review only: no tests, model calls, service connections, edits, commits, or pushes performed. The coordinator’s reported test results were not independently reproduced. No other reviewer’s outputs were read.

## Coordinator regression and validation evidence

- Reproduced creation contender deleting the winner, main ignored-file apply failure, and restart losing conversation linkage with failing temporary-Git regressions before fixes.
- Real Pi fixtures reproduced truncated tool loops exceeding the turn limit and cancellation during auth preflight still sending a model request; both now pass.
- Visualization tests cover collision IDs, action-vs-subject classification, output bounds, cancellation, swapped output directories and missing-directory ancestors. Descriptor-relative persistence includes a small Bun-native POSIX bridge, documented in `VISUALIZATION.md`.
- Cleanup now retains bytes by atomic rename, unregisters only the approved relation through an owned placeholder, validates the admin backlink/branch, and persists partial recovery metadata. Tests preserve unrelated offline worktree indexes and reject redirected `.git` pointers. See `SESSIONS.md`.
- App regressions cover failed-rebind consent revocation, blocked prompts until recovery, and concurrent delegation during workspace approval.
- Final `bun run check`: **194 tests / 1123 assertions**, TypeScript passed. `git diff --check` passed. Three earlier review-fix repeats passed 51 tests / 301 assertions each; later focused follow-ups and the final full check cover the additional fixes.

Phase 9 is a separately authorized next phase and needs its own review. These reviews do not sign off future Phase 9 edits to shared files.
