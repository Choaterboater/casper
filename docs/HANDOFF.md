# Casper Handoff — Reviewed Checkpoint; Phase 9 Still Partial

## Latest update — coding-loop consolidation, reviewed partial checkpoint

The user paused roadmap expansion to focus on a direct Pi-style coding loop, informed by prior projects rather than recreating SkyN3t. No aggregate scoring gate or mandatory agent pipeline. See `docs/HARNESS_COMPARISON_RESEARCH.md` (including the local project corpus) and `docs/CODING_LOOP_AUDIT.md` for research and the agreed direction.

User-authorized first slice implemented: automatic verification filters to available commands (explicit `/verify` retains missing-command skips); no commands yields explicit incomplete evidence; single-check repair avoids a duplicate passing rerun while multi-check regression sweeps remain. Normal requests print execution/verification receipts and expose a detached `getLastTaskResult()` without changing `runOnce()`'s existing return contract. CLI uses task execution status as well as verification status. Nonthrowing error/abort stops cannot appear successful or trigger automatic post-task repair; failed repair execution is blocked with edits retained.

The user authorized a focused correctness review, fixes, validation, and a partial checkpoint commit before recovery/model work. The review reproduced stale passes after external edits and later verifier mutations, plus incorrect failure reporting after Pi recovered a provider error. The provisional event-counter cache and fabricated shell exit evidence were removed. Casper-run checks now carry bounded before/after filesystem evidence, with later invalidation and reuse only within one verification invocation. New requests and explicit `/verify` calls start fresh. Snapshot limits/unsupported trees disable reuse and disclose unknown freshness; external inputs and post-report changes are not certified. Native edit paths, possible partial tool writes, and exact-command shell diagnostics are reported separately. Raw Pi shell results are **not** verifier passes. See `docs/CODING_LOOP_REVIEW.md` for Standards/Spec findings and limitations.

Final corrective-checkpoint validation: `bun run check` passed **223 tests / 1,298 assertions**, TypeScript passed; `git diff --check` passed. Details are in `docs/CODING_LOOP_REVIEW.md`. Single-agent review/testing, not independent review. No external inference, production service access, or push. The user authorized committing this checkpoint; use `git log -1` for its identity.

Still pending: replacing keyword-based verification selection, trustworthy execution observation/reuse of model-run native checks, progress-aware recovery, reasoning-effort/model controls, and task-level stop/steer. Automatic verification remains opt-in. No new trust policy, changed autonomy defaults, or unrelated phase expansion.

## Prior update — user-authorized debug/review and commit

The user authorized reviewing all changes since `f8bb28e`, correcting defects, and committing the checkpoint. See `docs/REVIEW_CHECKPOINT.md` for separate Standards/Spec findings, limitations, and reproducible performance evidence. This additional pass was single-agent, not an independent parallel review.

Fixed FIFO hangs in memory and MCP/LSP discovery, malformed outcome schema acceptance, and visualization scope symlink escape. Failing regressions were run before each correction. Final `bun run check` passed three times: **204 tests / 1,186 assertions**, TypeScript passed; median wall time **63.024 s**. Same 41-test legacy workload: Phase 3 source median **8.611 s**, current **7.931 s**. No runtime optimization claim is made; the larger full gate includes new safety and real-server tests.

This user-requested commit checkpoints existing Phase 4–9 work and corrections; no push is authorized. Historical “uncommitted”/test-count statements below describe earlier checkpoints. Interactive MindMesh, remaining Phase 9 reference/search/learning/promotion work and independent review, and separately authorized real-HPE acceptance remain open. Do not advance phases based on this checkpoint alone.

## Prior update — independent reviews, corrective follow-ups, and Phase 9's first slice

The user confirmed `f8bb28e` → current working tree (including untracked files) as the review baseline and authorized the next phase afterward. Six independent read-only reviewers (`gpt-6-astra`, medium reasoning; user config/MCP disabled) covered Standards and Spec separately for Phases 6, 7, and 8. Further independent follow-ups verified corrections. **Reported runtime findings are resolved; no new actionable runtime findings remained in final follow-ups.** Optional duplication heuristics are advisory. **Interactive MindMesh remains an explicitly unimplemented broader §17A requirement; file export is not full interactive integration and that scope gap was not waived.** Reports: `docs/PHASE6_REVIEW.md`, `docs/PHASE7_REVIEW.md`, `docs/PHASE8_REVIEW.md`. Reviewed pre-Phase9 source hashes: `docs/reviews/phase678-source-hashes.json`.

Fixes include collision-safe graph projection, correct visualization-vs-modification classification, bounded repository IR, cancellation/draining, and descriptor-relative artifact directory/file creation (Bun-native POSIX bridge; macOS tested, Linux not acceptance-tested here). Session fixes preserve restart linkage, revoke capabilities before transitions, block failed-rebind prompts, preserve the winning concurrent worktree creator, and leave ignored main files intact. **Cleanup now retains candidate files by atomic rename into a recovery directory**, then unregisters only the owned worktree through a private placeholder; it does not force-delete candidate bytes or globally prune unrelated worktrees. Administration backlink/branch checks prevent redirected `.git` pointers from selecting another index. Recovery paths survive partial cleanup and restart. Child-run fixes cover workspace-admission races, truncated-tool-loop budgets, and cancellation during authentication preflight.

Review acceptance: **194 tests / 1123 assertions**, TypeScript and `git diff --check` passed. Earlier measured Phase 6/7 performance numbers are historical; no new optimization/benchmark claim is made for these changed safety paths. Reviewer-model calls were authorized; no production MCP/HPE access, Casper commits, or pushes.

**Phase 9 is started, not complete.** Its first slice adds `src/memory/store.ts`, explicit local `/memory remember|forget` facts, bounded guidance on subsequent parent prompts, task-outcome summaries with exact verification/skip status, and explicit `/memory accept <id> yes|no`. Human acceptance starts unknown and model completion is never a verification pass. Files are owner-only JSONL under the existing workspace-specific project state path, bounded and atomically updated under a lock; corrupt state fails closed. Reference-project search, `casper learn`, and digest-bound candidate-to-reference/skill promotion remain pending. See `docs/PHASE9_IMPLEMENTATION.md`. Latest full check: **199 tests / 1157 assertions**, TypeScript passed. Phase 9 has not had its own independent review; prior reviews do not approve these new edits.

## Prior update — Phase 8 resumed, hardened, and validated with real Pi fixtures

After the interrupted/wrong-model session, the user explicitly requested resuming Phase 8. The provisional implementation was treated as unverified and hardened rather than merely repeating its completion claim. Casper exposes only `explorer` and `reviewer` through `delegate` and `/delegate <explorer|reviewer> <goal>`, both read-only.

An app-owned manager now enforces concurrency (2), dispatch count (4 per prepared parent prompt), wall time (180 seconds), bounded incremental report collection, cancellation/shutdown, fresh child ownership, and late-start prevention. The runtime seam now uses an explicit optional `startReadOnly` capability, not the provisional `allowedToolNames` hint. Actual Pi startup selects only `read`/`grep`/`find`/`ls`, disables ambient executable resources and persistence, and enforces 12-turn/48-tool-call budgets. Model errors, truncated/empty replies, and incomplete cleanup are disclosed. Child model defaults come from global Pi settings; no model preferences/credentials were changed. Read-only authority is not an OS sandbox or token/dollar cap.

Regressions reproduced pre-cancelled runtime startup and ignored unknown/write-authorizing arguments before fixes. Added lifecycle/concurrency/Unicode/error coverage and real pinned-Pi subprocess acceptance against a local deterministic provider fixture: safe reads, refused write/shell/recursion, hostile ambient-resource isolation, primary-to-child result delivery, budgets, cancellation, provider failure, and branch → child in worktree → reviewed discard → child in main with fresh context. **`bun run check`: 172 tests / 1020 assertions, TypeScript passed.** Three additional Phase 8 runs each passed 24 tests / 155 assertions; `git diff --check` passed. See `docs/PHASE8_IMPLEMENTATION.md` for scope and limits. No external live-model request, personal/production service access, Casper commit, or push was performed.

At this earlier checkpoint, independent Phase 6–8 reviews were pending. They are now recorded in the latest update above; the interactive MindMesh scope gap remains open.

## Prior update — Phase 7 sessions/branches/worktrees implemented, debugged, and optimized

The user explicitly authorized Phase 7 and requested a final debug/optimization pass, while leaving Phase 6's pending independent-review gate unchanged. Phase 7 now has Pi-backed named session branches (`/tree`, `/branch`, `/switch`), policy-gated experimental Git worktrees, exact interactive approvals, and verify/review/apply-or-discard return-to-main workflows. Pi owns conversation JSONL and runtime switching; Casper stores only branch/workspace relations under `~/.casper/sessions/`. Applying transports an exact bounded candidate patch and leaves it uncommitted; no commit or push behavior was added.

Real temporary-Git tests cover clean-source/race/tamper checks, byte-exact tracked/untracked/binary transport, concurrent manifests, failed verification, approval-time mutations, apply/discard, and cleanup. An isolated subprocess exercises actual Pi SDK 0.85.1 session clone/name/context/switch persistence without a model call. The final hardening pass fixed 12 safety/correctness defects and parallelized independent read-only Git probes; controlled 100-file A–B–B–A measurements reduced capture median 306.18 → 203.09 ms, apply 511.31 → 348.50 ms, and remove 492.45 → 344.68 ms. `bun run check`: TypeScript passed, **148 tests / 865 assertions**; two additional Phase 7 runs and five focused race repeats passed. See `docs/SESSIONS.md`, `docs/PHASE7_IMPLEMENTATION.md`, and `docs/PHASE7_PERFORMANCE.md`. Independent Phase 7 Standards/Spec review remains pending. **Phase 6's independent review is also still pending; Phase 7 authorization did not waive or complete it.**

All Phase 1–7 work remains uncommitted and unpushed. No personal/production service was contacted.

## Prior update — Phase 6 debug/performance pass complete

Five reproduced defects fixed with regressions: `buildRepoGraph` crash on >1 MiB files, EEXIST on same-title concurrent renders (now suffixed, never overwritten), invalid Mermaid from `:`/`"` titles and empty labels, quadratic import matching (1919 → 0.49 ms on an adversarial 1 MiB file), and `/visualize repo` not cancellable by `close()`. Batched scanning cut a 2000-file scan 293 → 52 ms. `bun run check`: TypeScript passed, **137 tests / 794 assertions**; Phase 6 suites ×3: 20 tests / 198 assertions each. Details: `docs/PHASE6_PERFORMANCE.md`. Independent review still pending.

## Prior update — Phase 6 visualization implemented

The user authorized Phase 6 ("read and start phase 6"). The Phase 6 contract from `docs/CASPER_COMPLETE_PLAN.md` (generic graph IR, `VisualizationProvider`, Mermaid fallback, MindMesh adapter; acceptance `map out the authentication flow` without affecting the workspace) is implemented and locally validated. **Independent Standards/Spec review has not yet been run for Phase 6.**

- New module `src/visualize/` (`types.ts`, `mermaid.ts`, `mindmesh.ts`, `router.ts`, `repo.ts`, `tools.ts`), a `visualize` task intent, `visualize.providers`/`visualize.outputDir` configuration, `/visualize` and `/visualize repo [dir]` commands, and a `visualize` runtime tool exposed only for visualization-intent prompts.
- MindMesh output is a schema-6 canonical map written to a file; Casper never connects to or starts a MindMesh server. Graph→tree projection is deterministic with cross edges disclosed in `lossiness`, notes, and `extensions.casper`.
- Artifacts default to `~/.casper/visualizations/<project-slug>/` with exclusive create. Project configuration may disable but not redirect the directory.
- `bun run check`: TypeScript passed, **132 tests / 781 assertions**. Real CLI `/visualize repo src` against Casper wrote both artifacts with no model session. One-off external acceptance: MindMesh's actual `jsonImporter` accepted the emitted file with 0 migration notes and 0 invariant issues (not a test dependency).
- Two defects were found and fixed during implementation (synthetic-root id collision; cyclic-fixture root assumption). Details: `docs/PHASE6_IMPLEMENTATION.md`; usage/limits: `docs/VISUALIZATION.md`.

Next for Phase 6: run the independent Standards/Spec review gate (as in `docs/PHASE4_REVIEW.md` / `docs/PHASE5_REVIEW.md`), resolve findings, optionally run a live-model smoke where a real model authors a graph. Not started for visualization: Graphviz, image rendering, or interactive MindMesh. Phase 8 is now implemented (see latest update); Phase 9+ remains unstarted.

All work remains uncommitted and unpushed. No personal/production server connections were made.

## Prior update — debug/performance follow-up complete

The user requested a full debug, speed-test, and optimization pass. Full repository validation and focused LSP stress/benchmarks are complete, with separate independent Standards/Spec reviews finding no actionable issues.

- Fixed reproduced late server startup after immediate disconnect, queued cancellation blocked behind approval, and mixed post-rename diagnostic snapshots.
- Linear bounded protocol framing, file-sized snapshot buffers (no persistent cache), and bounded batched diagnostic collection with shared wait budget and final whole-batch validation.
- Controlled A–B–B–A local-fixture medians: 100-file rename **4700.62 → 319.46 ms** (~93% lower); 100-open-file diagnostics **77.08 → 38.12 ms**; 1 MiB/256-byte-chunk framing **372.70 → 0.583 ms**. Startup stayed roughly unchanged (~175 → 171 ms); these are local workload measurements, not external model/compiler speed claims.
- `bun run check`: TypeScript passed, **117 tests / 596 assertions**. Three repeated Phase 5 suites: **46 tests / 207 assertions each**, all passed. Benchmark script separately typechecked; `git diff --check` passed.
- Evidence: `docs/PHASE5_PERFORMANCE.md`; raw samples/source hashes: `docs/benchmarks/phase5-lsp.json`; rerun: `bun run scripts/benchmark-lsp.ts`.

All existing work is preserved uncommitted and unpushed. No personal/production server connections, configuration, or later-phase features were added.

## Phase 5 delivery (prior completion evidence)

Phase 5 implementation, real-server rename acceptance, and independent Standards/Spec review gates are complete within the documented scope.

- Casper-owned opt-in LSP: diagnostics after native edits, symbols, definitions, references, language-aware rename, bounded stdio lifecycle, and local `/lsp` commands.
- Exact interactive rename approval, full-workspace snapshot/membership validation, native Pi mutation queues, cancellation, and honest partial-write/diagnostic evidence.
- Real Pyright repository-wide rename: declaration/import/call updated, unrelated text preserved, fresh zero diagnostics across all three files, independent CLI check passed. Real TypeScript navigation/rename and before/after compiler checks also passed; its unversioned reports are not counted as strict fresh-diagnostic evidence.
- Actual Pi/local-provider protocol coverage includes native-write diagnostics, one-shot denial, and interactive approved rename.
- Independent reviews and follow-ups complete; all findings resolved. `bun run check`: TypeScript passed, **109 tests / 541 assertions**. Three final Phase 5 repeats: **38 tests / 152 assertions each**, all passed. `git diff --check` passed.

Read `docs/LSP.md`, `docs/PHASE5_IMPLEMENTATION.md`, and `docs/PHASE5_REVIEW.md` for usage, safety limits, evidence, and review fixes. TypeScript Language Server `6.0.0` and Pyright `1.1.414` are pinned test-only devDependencies; no personal server configuration was created.

All Phase 4 and Phase 5 changes remain preserved, uncommitted, and unpushed. Personal HPE acceptance still requires separate authorization. Phase 6 is implemented pending review (see top). The Phase 4 evidence below remains historical.

Repository: `/Users/stephenchoate/Documents/Casper`

## Start here

1. Check `git status --short` and `git log -1`; the user requested a Phase 4–9 review checkpoint commit. Preserve any subsequent work. Read `docs/REVIEW_CHECKPOINT.md` first.
2. Run `bun run check`.
3. Read:
   - `docs/PHASE9_IMPLEMENTATION.md` — implemented facts/outcomes slice and remaining reference/learning/promotion scope.
   - `docs/PHASE6_REVIEW.md`, `docs/PHASE7_REVIEW.md`, `docs/PHASE8_REVIEW.md` — independent axes, corrections, follow-ups, and remaining scope limitation.
   - `docs/PHASE8_IMPLEMENTATION.md` — Phase 8 delegated explorer/reviewer scope, design, limits, and validation.
   - `docs/PHASE7_PERFORMANCE.md` — Phase 7 debug fixes, controlled measurements, and final validation.
   - `docs/PHASE7_IMPLEMENTATION.md` — Phase 7 architecture, delivery, validation, and remaining gates.
   - `docs/SESSIONS.md` — named-session/worktree usage, policy, and safety limits.
   - `docs/PHASE6_PERFORMANCE.md` — Phase 6 debug fixes, measurements, validation.
   - `docs/PHASE6_IMPLEMENTATION.md` — Phase 6 delivery, design decisions, validation, remaining gates.
   - `docs/VISUALIZATION.md` — graph IR, providers, configuration, tree projection, limits.
   - `docs/PHASE5_PERFORMANCE.md` — latest debug fixes, controlled measurements, validation, and independent review.
   - `docs/PHASE5_IMPLEMENTATION.md` — delivered LSP scope and real-server acceptance.
   - `docs/PHASE5_REVIEW.md` — independent review fixes, final validation, and remaining limits.
   - `docs/LSP.md` — configuration, consent, rename safeguards, and diagnostics semantics.
   - `docs/PHASE4_REVIEW.md` — independent Standards/Spec findings, regression fixes, and follow-up status.
   - `docs/IMPLEMENTATION_PLAN.md` — Phase 4 contract and delivered evidence.
   - `docs/MCP.md` — configuration, connection consent, broker behavior, safety, limits.
   - `docs/PHASE4_VERIFICATION.md` — fixture/live evidence and regression fixes.
   - `docs/CASPER_COMPLETE_PLAN.md` — Phase 4 scope and later phases.

Historically, no commit or push was requested/performed in Phases 4 or 5. This review's baseline was `f8bb28e` (Phase 3 handoff), with Phase 3 implementation at `9bad614`. The latest user request authorizes committing the combined checkpoint, not pushing.

## What is implemented

- Metadata-only discovery of user/profile/project MCP JSON configuration with provenance and deterministic overrides.
- Explicit process-local connection consent: `/mcp connect <name>` or leading repeatable `--mcp <name>`. Startup and `/mcp` never execute/contact a server.
- Pinned official MCP SDK stdio and Streamable HTTP support, environment/header authentication, bounded paginated discovery, notification refresh, cancellation, dead-server isolation, capped on-demand reconnect, cleanup.
- Local capability descriptors/search and lexical task selection: at most six direct MCP tools plus `find_capability`/`call_capability`. Native HPE-style routing is preferred.
- Exact IDs survive collisions; schemas load on demand; all invocations validate target arguments. Runtime-neutral tools translate to Pi only in `src/runtime/pi.ts`.
- Reads need a reviewed server/read-only annotation. Non-read/unknown tools require exact interactive approval; one-shot calls fail closed. No model-controlled authorization flag.
- Bounded result envelopes: 16 KiB and 50 global array entries, error preservation, Unicode-safe preview, explicit truncation. No raw-result artifact.
- `/mcp` status and connect/disconnect work without Pi startup.

Main new files:

```text
src/mcp/config.ts
src/mcp/manager.ts
src/capabilities/broker.ts
src/capabilities/result.ts
tests/fixtures/mcp-server.ts
tests/phase4-mcp.test.ts
tests/phase4-app.integration.test.ts
docs/MCP.md
docs/PHASE4_VERIFICATION.md
docs/PHASE4_REVIEW.md
```

Existing app/CLI/runtime/public exports and README were updated. Pi stays pinned at `0.85.1`; new direct pins are MCP SDK `1.30.0` and `typebox` `1.3.7`.

## Validation

- Full check after independent-review fixes: **71 tests / 389 assertions**, TypeScript passed.
- Three repeated Phase 4 suites: **30 tests / 164 assertions** each, all passed.
- Real local stdio and HTTP fixtures, both JSON and SSE HTTP responses.
- Actual Pi/provider payload test: 340-tool catalog → 8 additional tools, with initially hidden rare-tool search/schema/call. Same-session tool replacement/removal also verified.
- Live model: GitHub Copilot `gpt-5.4` via real Pi, two local 340-tool fixtures (generic and router), five successful read-only tool calls, zero errors, CLI exit 0. Temporary auth copies removed. No production MCPs or devices accessed.
- Reproduced and fixed: slow SDK child cleanup versus CLI deadline; initial Pi allowlist suppressing later task-selected tools; live-provider empty optional discovery fields.
- Optimization follow-up: local `/project` startup **419 → 141 ms** in a paired sample (~66% lower latency) by deferring Pi's SDK import until a model is needed. No startup MCP connections.
- Warm 340-tool search **1.5014 → 0.0325 ms**, schema inspection **0.9260 → 0.0028 ms**, local validated call **2.3752 → 0.1079 ms**. Index/validator caches are tied to catalog revisions and connection identity.

Details: `docs/PHASE4_VERIFICATION.md`. The first live run was not counted as passing despite process exit 0; its discovery tool failures were fixed and the live workflow rerun successfully.

## Optimization/debugging follow-up

The user asked to optimize/debug and clarify whether HPE is personal. **The core is generic; no HPE server/credentials are bundled or connected for other users.** Put personal definitions in a selected user profile such as `~/.casper/profiles/stephen/mcp.json`, not a shared project file. A new fixture regression proves default/unrelated profiles do not inherit personal HPE definitions. No actual personal configuration was created.

Five defects were reproduced with failing regressions and fixed:
- Pending approval surviving disconnect/reconnect with an identical schema.
- HTTP cancellation returning while its unanswered POST remained in flight.
- Interactive MCP command failures terminating the session.
- EOF leaving the input loop pending.
- Concurrent close returning before teardown already initiated by a cancelled call completed.

`MCPManager.catalogRevision` and per-connection generations now govern broker cache invalidation and approval identity. Metadata/schema/validator changes and removals invalidate together. Request failure/cancellation closes the affected server connection (including sibling requests), rather than only sending a protocol notification; it never replays the call. Cleanup callers share the same teardown promise. The app runtime factory can now be asynchronous, and shutdown drains that load/start operation without launching a late model session.

Current follow-up validation used local fixtures only, including the actual Pi adapter with a local model-protocol fixture. The live model evidence above belongs to the initial Phase 4 smoke; no fresh external model or HPE connection was made for the optimization pass.

## Independent review follow-up

Two separate read-only reviewer processes covered all ten tracked changes and all nine original untracked source/test/document files. Standards found a P2 result-integrity breach and a P3 duplicated-budget heuristic. Spec found three P2 defects, including the same result-integrity breach. Three concrete defects were reproduced with failing regressions and fixed:

- Schema inspection truncated `enum`/`required` arrays; exact-ID discovery now returns a lossless `inputSchemaJson` string. The schema budget counts its escaped representation, shared across inspection/direct/fallback paths and tested at the boundary.
- Application records resembling MCP content lost fields/cursors; only top-level protocol blocks are decoded, preserving metadata and ordinary application fields.
- Refresh timeout left unanswered HTTP discovery work open; failed refresh now releases the connection.

Independent follow-up reviews found no blocking issues. Spec identified one additional P3 (binary omission discarded nonbinary metadata); it was reproduced, fixed, and independently re-reviewed as resolved. All reported findings are resolved. Full check and three repeats passed at the counts above. No fresh external live-model smoke or actual HPE connection was performed. Review reports and coverage: `docs/PHASE4_REVIEW.md`.

## Remaining Phase 4 gates

1. **Review gate complete:** independent Standards/Spec reviews and focused follow-ups completed; all reported findings resolved. See `docs/PHASE4_REVIEW.md`. Phase 3's sign-off was not reused.
2. **Actual HPE deployment acceptance is pending for the user's optional personal integration**, not a requirement for every Casper user. Local fixtures validate generic and router exposure styles; they are not actual HPE servers. Obtain explicit endpoint/credential/read-only authorization before connecting. Do not infer permission for network/device writes from this handoff.
3. Commit only if requested. Nothing is pushed.

Phase 5 is complete. Phases 6–8 are implemented and independently reviewed with runtime findings resolved; interactive MindMesh remains a broader-plan gap. Phase 9's facts/outcomes slice is implemented; its reference/search/learning/promotion work and independent review remain pending. Do not infer authorization for writing/swarm expansion or actual HPE access from fixture success.

## Off-topic TypeSafe/Jev follow-up — deferred

The user subsequently said **no Jev** when authorizing Phase 5. Do not resume the experiment unless explicitly requested. Previously, the user chose to test Jev later, not integrate it into Casper. No TypeSafe API calls or paid evaluations were made. Casper source/dependencies were not changed for TypeSafe.

Personal setup outside this repository: the user saved a key in `~/.config/typesafe-ai/.env` (owner-only permissions). Do not print/read it into agent context. An unfinished helper exists at `~/.pi/agent/extensions/typesafe/client.ts`; there is no `index.ts` entry point and no registered TypeSafe tool. Do not describe the extension as installed/working. Resume that separate experiment only when requested, with explicit evaluation scope and a small spending cap. Jev is a structured-decision model, not a drop-in replacement for Pi's main coding model.

## Important limits

- MCP connection consent is not sandboxing; read-only annotations are claims by the reviewed server. Pi's normal shell/filesystem tools remain unsandboxed.
- No persisted MCP trust, OAuth provisioning, config writes, automatic server installation, or legacy SSE transport. Restart to reload configuration.
- No blanket write authorization. Interactive confirmation requires complete arguments within 4 KiB and an explicit `yes`.
- Credentials stay out of status and controlled errors, but server results/call arguments can contain secrets and persist in Pi conversation history.
- No generic continuation/replay for consequential calls; no full raw artifact. Provider read cursors survive only when the bounded result permits.
- Reconnect is on demand with a two-attempt/30-second per-server cap, not continuous background healing. No periodic HTTP health probes.
- Direct SDK-owned stdio children are terminated within the CLI cleanup window; escaped/daemonized descendants and Windows behavior are not validated.
- Tool selection remains lexical. Oversized input schemas are blocked; inactive registrations can remain inside Pi, while the active model-facing set is bounded.

Earlier phase evidence remains in `docs/PHASE2_REVIEW.md`, `docs/PHASE3_REVIEW.md`, and `docs/PHASE3_VERIFICATION.md`.
