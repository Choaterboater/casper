# Phase 4 — MCP capability broker verification

## Status

Implementation and fixture acceptance are delivered. Deployment-specific acceptance against an actual HPE MCP remains **pending explicit authorization**. No production MCP connection, network-device write, commit, or push was performed during this phase.

Baseline: clean working tree at `f8bb28e` (Phase 3 code checkpoint `9bad614`). Baseline `bun run check`: 41 tests / 225 assertions, TypeScript passed. The implementation plan was updated before source implementation.

## Delivered modules

- `src/mcp/config.ts`: bounded metadata-only JSON discovery, precedence/provenance, per-entry validation, environment references.
- `src/mcp/manager.ts`: official SDK transports, process-local connection consent, paginated catalogs, deadlines, list-change refresh, failure isolation, bounded on-demand reconnect, cancellation, teardown.
- `src/capabilities/broker.ts`: normalized descriptors, stable IDs, lexical selection, native-router preference, two fallback tools, target-schema validation, exact-call non-read confirmation.
- `src/capabilities/result.ts`: item/byte/depth bounds, error preservation, Unicode-safe previews, explicit truncation.
- `src/runtime/{types,pi}.ts`: runtime-neutral custom tools and selective replacement via Pi's public registration/activation interface.
- `src/app.ts`, `src/cli.ts`, `src/index.ts`: local status/connect/disconnect, leading `--mcp`, prompt selection, confirmation, and cleanup.
- Dependencies: pinned MCP SDK `1.30.0` and explicit `typebox` `1.3.7`; Pi remains pinned at `0.85.1`.

Usage and security limits: [MCP.md](MCP.md).

## Automated validation

Initial implementation `bun run check` (before the optimization/debug follow-up below):

```text
TypeScript passed
57 tests passed
0 failed
335 assertions
```

Three consecutive Phase 4 suite runs:

```text
16 tests passed / 110 assertions each
0 failed
```

`git diff --check`: passed. No temporary debug logging remains in the production modules.

Coverage uses **real local protocol servers**, not transport mocks:

- A 340-tool generic catalog, paginated in 100-tool pages.
- A 340-tool HPE-style catalog with native `find_tool`, `invoke_read_tool`, and consequential `invoke_tool` plus wrappers.
- At most six direct tools plus two fallbacks; metadata search excludes schemas.
- A rare initially unexposed tool can be searched, its schema retrieved, and invoked through fallback.
- Exact routing for colliding/sanitization-similar server names.
- Read, write, destructive router, and unknown classification; one-shot denial and interactive exact-call approval.
- Immutable reviewed arguments, invalid input blocked before approval, changed tool metadata invalidating approval.
- Paginated discovery, notification refresh, late arrival, removal of stale tools, dead-server isolation, bounded reconnection without call replay.
- Timeout, caller cancellation, close during stalled initialization, no late resurrection, idempotent cleanup, uncooperative stdio child termination.
- HTTP authentication headers via environment references; JSON and SSE responses; HTTP notification refresh; redirect refusal; redacted status and failure messages.
- Output item/byte limits, multi-megabyte wire result, intact Unicode, tool errors.
- Local app commands without Pi startup, task-to-task surface replacement, and disconnect revocation.

### Real CLI / Pi adapter, local model-protocol fixture

An isolated CLI subprocess uses the actual pinned Pi adapter and a local OpenAI-compatible streaming fixture. The fixture captures the actual provider payload and requests the search → schema → invocation sequence.

Observed:

- Initial payload: **15 tools = 7 existing Pi coding tools + 8 broker tools** for the 340-tool MCP.
- Rare `inspect_quantum_flux` schema absent from the initial payload.
- Schema appears in the discovery result only when requested.
- Real MCP result appears in the subsequent model request.
- Same real Pi session, three subsequent task states: **15 → 10 → 9 tools** (health selection → rare-tool selection → MCP disconnected with fallbacks only).
- Previous task-selected direct tools are absent after replacement.

This is a deterministic provider-protocol test, not a live-model evaluation.

## Live model smoke

Environment: Bun 1.4.0, Pi 0.85.1, GitHub Copilot `gpt-5.4`, macOS. Temporary project/HOME/Pi settings/session directories; temporary mode-0600 auth copy removed in `finally`. No real user trust or MCP configuration was changed.

Connected **two local stdio fixtures**, each with 340 tools (680 combined), one generic and one HPE-router-shaped. The model was told to use MCP tools only, perform reads only, and exercise both discovery paths.

Successful post-fix tool sequence, independently checked in the saved Pi session:

```text
✓ find_capability       query: quantum flux
✓ find_capability       id: mcp:generic:inspect_quantum_flux
✓ call_capability       site: lab
✓ mcp_find_tool_*       query: quantum flux; include_schema: true
✓ mcp_invoke_read_tool_*  name: inspect_quantum_flux; site: lab
```

Observed generic result: exact invocation identity `generic`, tool `inspect_quantum_flux`, arguments `{ "site": "lab" }`. The generic fixture returns an invocation record, not a real metric.

Observed router result: `{ "counter": 42, "tool": "inspect_quantum_flux" }`.

CLI exit **0**; five tool calls; **zero tool errors**; approximately 14.5 seconds. No shell/filesystem tool calls or consequential MCP calls were recorded. This validates live-model use of local fixtures, **not an actual HPE backend or deployment**.

## Defects found and regression-tested during implementation

| Defect | Failing evidence | Fix |
| --- | --- | --- |
| SDK shutdown budget exceeded CLI deadline | Uncooperative stdio close took ~4,005 ms; required <900 ms | Casper accelerates direct-child TERM/KILL to 200/450 ms; regression now passes |
| Initial Pi allowlist blocked later task-selected tools | Actual next provider payload had 9 tools instead of 10; newly selected tool missing | Use public active-set selection, not a permanent initial registration allowlist |
| Live provider filled unused optional discovery field with empty string | Initial live smoke repeatedly returned `Supply either query or id`; exact `{query: "quantum flux", id: ""}` regression failed | Treat empty unused fields as absent; both direct and real-Pi protocol tests cover it; live smoke rerun passed |

An early HTTP test fixture also incorrectly reused a stateless SDK server transport. The test server now uses a stateful session. This was a fixture defect, not a Casper HTTP fix. A collision test's incidental locale-sort assumption was replaced with assertions on exact source routing.

## Startup measurement

Same machine/dependencies, isolated cached project/HOME; Phase 3 extracted with `git archive f8bb28e`; two warmups and seven alternating `/project` measurements per revision:

| Revision | Median | Range |
| --- | ---: | ---: |
| Phase 3 | 355.71 ms | 351.03–423.65 ms |
| Phase 4 | 401.25 ms | 400.33–410.59 ms |

This sample shows approximately **46 ms additional startup cost**, not zero regression. Startup still performs no MCP subprocess or network connection. No speculative restructuring was applied to remove this import/discovery cost.

## Optimization and debugging follow-up

Requested after the initial implementation. The working tree was snapshotted to an isolated temporary directory, including untracked files, before changing source. The same installed dependencies and local fixtures were used for before/after measurements. No real HPE connection or external model call was made in this follow-up; the real Pi/provider-protocol fixture was rerun locally.

### Measured improvements

Local `/project` command: two warmups followed by nine alternating fresh subprocess measurements per version, with isolated HOME and a cached fixture project:

| Phase 4 revision | Median | Range |
| --- | ---: | ---: |
| Before optimization | 419.25 ms | 407.87–432.20 ms |
| After optimization | 140.91 ms | 134.00–151.30 ms |

Approximately **66% lower local-command startup latency** in this sample. An earlier paired sample also showed 396 → 131 ms. Isolated Pi SDK import measured roughly 306 ms, identifying the main cause. The app now imports Pi only when a model is needed; an asynchronous runtime factory is tracked through startup/shutdown. This defers SDK cost to the first model prompt rather than claiming to eliminate that cost from model execution.

Warm 340-tool local stdio catalog, 10 warmups and 100 measured operations per run, three alternating before/after runs. Values are medians of the three run medians:

| Operation | Before | After |
| --- | ---: | ---: |
| Metadata search | 1.5014 ms | 0.0325 ms |
| Inspect one schema | 0.9260 ms | 0.0028 ms |
| Validated local tool call | 2.3752 ms | 0.1079 ms |

The broker previously cloned/rehashed every schema and retokenized every descriptor on every search, inspection, and call; it also compiled a validator for every call. It now rebuilds on a manager-owned catalog revision, precomputes search terms/schema sizes, and compiles validators once per current capability. Initial discovery/indexing still costs work; these are **warm-catalog local measurements**, not expected real-network latency or model-speed gains. No embeddings, new dependencies, or background indexer were added.

### Reproduced defects and fixes

All five had failing interface-level regressions before the fixes:

1. **Approval survived reconnect.** A confirmation callback disconnected/reconnected the server with an identical schema, then approved; the original call incorrectly executed. Approval fingerprints now include the connection generation.
2. **Cancellation left HTTP work open.** An unanswered `tools/call` POST remained open after the caller received cancellation. Request failures/cancellation now invalidate that connection and abort its I/O, without replay. Both caller cancellation and deadline expiry are tested. Sibling requests on that connection may also be interrupted.
3. **Interactive MCP failure terminated the app.** A failed local connect command rejected the whole input loop. Interactive errors are now displayed and the next command remains usable; one-shot failures retain nonzero exit behavior.
4. **EOF hung the input loop.** Closing input left the question promise pending. EOF now settles the pending question and ends the loop.
5. **Concurrent close skipped in-progress teardown.** A cancelled call cleared the client handle while its uncooperative child was still shutting down; simultaneous `close()` returned with the child alive. Teardown is now deduplicated and joined by all callers.

Additional regression coverage verifies that cached schema validators and safety classifications invalidate together, stale direct wrappers cannot invoke removed/upgraded capabilities, metadata returned to callers cannot mutate cached policy, close during lazy runtime loading cannot start a late session, and an HPE definition in a personal profile does not appear in default/unrelated profiles.

### Current validation

- `bun run check`: **66 tests / 363 assertions**, TypeScript passed.
- Three consecutive Phase 4 suites: **25 tests / 138 assertions** each, no failures.
- Real Pi/provider-payload fixture passed, including search/schema/call and task-to-task exposure replacement.
- `git diff --check`: passed. No production debug logging or benchmark harnesses added.
- No personal HPE setup, credential/configuration changes, commit, or push.

## Independent review follow-up

Two isolated read-only reviewers covered the entire Phase 4 tracked diff and all nine original untracked source/test/document files. Standards reported one P2 contract breach and one P3 duplication heuristic; Spec reported three P2 findings (including the same contract breach). See [PHASE4_REVIEW.md](PHASE4_REVIEW.md) for separate reports and red/green evidence.

Three concrete defects were reproduced with failing tests and fixed: application fields/cursors lost during recursive content normalization; schema arrays truncated during inspection; and unanswered HTTP discovery requests surviving refresh timeout. A fourth test covers shared schema-budget enforcement across inspection/direct/fallback paths. Exact-ID discovery now returns the complete schema as `inputSchemaJson`, with a conservative escaped-string byte budget; MCP data results retain their 50-item/16-KiB bounds.

Independent follow-up reviews confirmed the original findings resolved, with no blocking issues. Spec raised one additional P3: binary omission discarded nonbinary metadata. A failing regression reproduced it; the fix omits only payload fields while retaining budgeted annotations, `_meta`, and resource metadata. Independent targeted re-review confirmed that fix, with no new actionable issue.

Final `bun run check`: **71 tests / 389 assertions**, TypeScript passed. Three repeated Phase 4 suites: **30 tests / 164 assertions each**. Real Pi/local provider-payload coverage and whitespace checks passed. No new external live-model or HPE connection was made. All reported review findings are resolved; detailed verdicts are in the review report.

## Reference study

- Local GreenCLI at `4e1a54d`, `src-tauri/src/mcp/client.rs`: short-lived shared-state access, dead-tool filtering, refresh notifications, credential/renderer separation.
- OMP upstream `packages/coding-agent/src/mcp/manager.ts` (read from `main`, not a dependency): generation checks on teardown, deduplicated/capped reconnects, startup not blocked on all servers.
- Local HPE repository at `0941070`, `docs/tool-router.md`: native minimal surface, schema-on-demand, read/generic dispatcher separation, bounded output, read-only continuation semantics.
- Pi SDK, extension, and dynamic-tool examples: use public registration and activation; Pi has no built-in MCP client.

## Remaining gates and limits

- Actual HPE server acceptance requires separately approved endpoints/credentials and read-only scope. The second HPE branch was not independently exercised; generic and router fixtures cover the two planned exposure styles.
- Independent Standards/Spec review covered Phase 4, including untracked files; findings, regression fixes, and follow-up status are in `PHASE4_REVIEW.md`. Phase 3's sign-off was not reused.
- Configuration/trust is process-local; no OAuth provisioning or persisted MCP approvals. Legacy SSE/config-specific import formats are not implemented.
- Classification relies on reviewed server behavior/annotations, not sandboxing. Pi's ordinary tools remain unsandboxed.
- Results and call arguments may contain secrets and can persist in Pi sessions. No full-result artifact, automatic redaction, or broker-owned continuation store.
- Stdio cleanup covers the direct SDK-owned child; daemonized descendants and Windows behavior are not validated. No periodic HTTP health probes.
- Selection is lexical; schemas over the supported budget cannot be exposed/called. Direct tool registrations can remain inactive inside Pi, but only the current bounded active set is model-facing.
- Ordinary CLI exit 0 is not proof every MCP tool succeeded. Validation checks tool-result evidence, not just process status; the first live smoke was correctly treated as failed despite exit 0.
