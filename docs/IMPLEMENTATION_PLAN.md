# Casper Implementation Plan

## Current checkpoint

Phase 4–8 implementations and Phase 9's initial facts/outcomes slice are checkpointed by user request after an additional debug/review pass. See `docs/REVIEW_CHECKPOINT.md` and the latest `docs/HANDOFF.md` update for current evidence (**204 tests / 1,186 assertions**, three full runs), scope gaps, and review limitations. Later-phase implementation details live in their `PHASE*_IMPLEMENTATION.md` files. Historical phase statements below are not the current commit/review status. Phase 9 remains partial; interactive MindMesh and separately authorized real-HPE acceptance remain open. No push or next-phase expansion is authorized by this checkpoint.

## Phase 0 — Runtime Shell (Complete)

### Scope
Build only the smallest viable Casper runtime shell described in Phase 0 of `docs/CASPER_COMPLETE_PLAN.md`.

### Constraints
- Keep Casper as its own project.
- Use Pi as a pinned dependency through a thin `AgentRuntime` / `PiRuntime` adapter.
- Do not fork Pi.
- Do not add OMP as a runtime dependency.
- Do not implement Pika.
- Do not implement MCP, LSP, MindMesh, subagents, memory, advanced verification, or future profile/skill systems yet.
- Keep the code small and easy to replace.

### Deliverables
1. Bun + TypeScript project scaffold.
2. Pinned `@earendil-works/pi-coding-agent` dependency.
3. Small runtime boundary:
   - `src/runtime/types.ts`
   - `src/runtime/pi.ts`
4. Minimal Casper CLI:
   - startup banner / ghost
   - detect project root and Git branch
   - start one Pi-backed session
   - send prompts and stream responses through Casper-owned output
5. Basic project inspection for current cwd.
6. One end-to-end integration test covering Casper startup + prompt flow with a fake runtime.

### Planned File Layout
```text
src/
  cli.ts
  app.ts
  project/inspect.ts
  runtime/types.ts
  runtime/pi.ts
  tui/banner.ts
tests/
  casper-app.integration.test.ts
```

### Implementation Steps
1. Scaffold `package.json`, `tsconfig.json`, and Bun scripts.
2. Add Pi dependency pinned to `0.85.1`.
3. Implement `inspectProject()`:
   - cwd
   - project root
   - project name
   - Git branch when available
4. Implement `renderBanner()` with a compact Casper ghost/banner.
5. Define a small runtime abstraction with normalized streaming events.
6. Implement `PiRuntime` using Pi SDK `createAgentSession()`.
7. Implement `CasperApp` orchestration:
   - inspect project
   - print banner
   - start runtime
   - subscribe to runtime events
   - run one prompt or a simple REPL
8. Add one integration test using a fake runtime to validate the Phase 0 UX/control path without requiring a live model.
9. Run typecheck and tests.

### Out of Scope
- Custom project config files
- Profile loading
- Skill discovery/selection
- Verification/repair loops beyond what the user manually asks Pi to do
- Custom capability routing
- MCP support
- LSP support
- Session trees/branching UI
- Worktrees

### Acceptance Check
Phase 0 is complete when:
- `bun test` passes.
- The project typechecks.
- `casper` can start, show the Casper banner, detect cwd/root/branch, and create a Pi-backed session.
- Prompts stream through Casper-owned output while Pi performs read/edit/bash/write work in the current repo.

## Phase 1 — Casper-Owned Project/Profile Layer (Complete)

### Scope
Build the deterministic project context Casper supplies to the runtime without adding skills, verification, MCP, LSP, or memory.

### Deliverables
1. Profile/config loader:
   - `~/.casper/config.yaml`
   - `~/.casper/profiles/<profile>/config.yaml`
   - profile selection from explicit option, `CASPER_PROFILE`, project config, global config, then `default`
2. Project-local inputs:
   - `.casper/project.yaml`
   - `.casper/rules.md`
   - profile `rules.md`
3. Minimal policy merge:
   - safe defaults → global → selected profile → project
   - destructive Git confirmation cannot be disabled by lower-precedence configuration
4. Deterministic project model:
   - languages and frameworks
   - package manager
   - build/test/lint/typecheck commands
   - project-authored overrides
5. Project cache:
   - `~/.casper/projects/<project-id>/project.json`
   - fingerprinted deterministic inputs
   - graceful operation when cache persistence is unavailable
6. Deterministic task classification and relevant command injection per prompt.
7. Startup and `/project` output for project, stack, package manager, commands, profile, and branch.

### Implemented File Layout
```text
src/
  config/load.ts
  project/context.ts
  project/inspect.ts
  project/model.ts
  task/classify.ts
  tui/banner.ts
tests/
  casper-app.integration.test.ts
  phase1-project-context.test.ts
```

### Acceptance Check
Phase 1 is complete when:
- Casper reports project, stack, package manager, build/test commands, and selected profile.
- Profile and project rules are included in runtime context.
- Policy precedence is deterministic and safety restrictions remain enforced.
- Unchanged deterministic project facts are restored from cache.
- Prompts carry a compact task classification and only detected relevant commands.
- `bun run check` passes.

## Phase 2 — Skills (Complete)

### Scope
Add a Casper-owned skill registry without changing the runtime boundary or implementing capabilities, verification, or orchestration.

### Deliverables
1. Discover Agent Skills-compatible Markdown from `~/.casper/skills/`, `.casper/skills/`, and compatible Pi/Agents/Claude/Codex skill directories.
2. Index frontmatter metadata only; preserve unknown metadata and report malformed skills without preventing startup.
3. Deterministically rank by task text, tags, intents, and project stack; load at most six relevant bodies per prompt by default (`skills.maxActive`).
4. Track canonical file paths and source. User-owned Casper skills are trusted; project/external skills require explicit, content-hash-bound review. Skill metadata cannot grant trust or tool permissions.
5. Add `/skills`, `/skills inspect <id>`, `/skills trust <id> <sha256>`, and `/skills block <id>` for local inspection and review. No model call for these commands.
6. Inject only selected skill bodies with their base directories, source, and trust state. Disable Pi's independent skill discovery in the adapter.
7. Cover discovery, ranking, trust, changed content, and app prompt integration with isolated filesystem fixtures; run typecheck, tests, and live CLI smoke checks.

### Acceptance
A TypeScript MCP task receives relevant approved skill bodies, but no unrelated or unreviewed bodies. Listing skills shows metadata/provenance only. Missing directories, malformed files, and duplicate names have deterministic outcomes and do not crash startup.

### Implemented Files
- `src/skills/registry.ts`: discovery, provenance, review/block decisions, bounded body loading, and prompt formatting.
- `src/skills/metadata.ts`: bounded frontmatter parsing and validation.
- `src/skills/rank.ts`: deterministic task/stack ranking.
- `src/app.ts`: local skill commands and per-prompt selection.
- `src/config/load.ts`, `src/project/context.ts`: layered `skills.maxActive` setting.
- `src/runtime/pi.ts`: disable independent Pi skill discovery so Casper controls injection.
- `tests/phase2-skills.test.ts`, `tests/casper-app.integration.test.ts`: isolated registry/app coverage.

### Verification
- Phase 1 checkpoint committed as `e9f1f87` before Phase 2 changes.
- `bun run check`: typecheck passed; 19 tests passed, 116 assertions, no failures.
- `git diff --check`: passed.
- CLI `--help`: displays the new local commands.
- Isolated real CLI/Pi smoke: discovered four fixture skills, listed metadata without bodies, inspected and approved the exact project-skill digest, and delivered only the native TypeScript MCP and reviewed project skill to the live model. Unrelated and unreviewed external bodies were excluded. `/skills block`, updated listing, and `/exit` succeeded.
- Smoke fixtures used temporary project/home/trust directories; no real user skill approvals were changed.
- Independent standards/spec review found two issues: eager runtime startup blocked local commands, and project skill symlinks could escape the project. Both were reproduced with failing regression tests, fixed, and independently re-reviewed with no blocking findings.
- Final smoke also verified `/skills` works with empty Pi configuration without creating a model session, rejects out-of-project skill symlinks, and still supports interactive inspection/trust, lazy live-model startup, selective injection, blocking, and exit.
- Review details and remaining intentional limitations: `docs/PHASE2_REVIEW.md`.

### Deliberate Limits
Deterministic ranking only; no embeddings or learning. No built-in skill pack, remote imports, permission grants, or helper-script execution. Trust gates automatic injection and covers `SKILL.md` content, not its referenced assets or general tool access. Already-injected bodies remain in Pi's conversation history. Frontmatter changes require restart/re-indexing. See `README.md` for trust semantics and size limits.

## Phase 3 — Verification + Repair (Complete)

### Scope and execution contract
- A Casper-owned registry of typecheck/lint/test/build command adapters; no Pi imports outside the runtime adapter.
- Project `verify:` commands override detected/model commands. Missing commands remain visible skips, never passes.
- `/verify [typecheck|lint|test|build ...]` runs independently of the model. `/verify repair [checks ...]` explicitly permits bounded repair through the existing session boundary.
- CLI `--verify` explicitly authorizes automatic verification/repair after relevant modifying prompts. Startup, read-only prompts, and default prompts do not automatically execute repository verification scripts. This is execution consent, not a sandbox or a persisted repository-trust system.
- Structured per-run evidence: command, cwd, status, exit code/signal, bounded stdout/stderr, truncation, duration, and timeout/spawn errors. Commands run sequentially at the project root with timeouts and process cleanup.
- Default maximum three repair prompts (`repair.maxAttempts`, 0–10). Feed exact failing commands/output, original request/constraints, and available Git changed-file context to the same runtime session. Rerun failed checks first; require a fresh full selected suite before reporting success after repair.
- Concise check/repair/final output; retain structured history through the app result. Missing checks yield incomplete verification; exhausted failures yield failure and a nonzero one-shot CLI exit.

### Implementation sequence
1. Configuration, evidence types, bounded shell command adapter, registry.
2. Bounded repair runner and concise result formatting.
3. Local commands and opt-in post-task integration, preserving lazy Pi startup.
4. Isolated command/config/repair/app tests covering failures, skips, limits, timeouts, output bounds, and regression gates.
5. `bun run check`, diff checks, and a real CLI/Pi smoke demonstrating failure → repair → successful rerun in a temporary repository.

### Implemented files
- `src/verify/{evidence,command,registry,repair-loop}.ts`: structured evidence, bounded command adapters, registration, and repair policy.
- `src/config/load.ts`, `src/project/context.ts`: canonical project verification commands and layered timeout/attempt limits.
- `src/app.ts`, `src/cli.ts`, `src/index.ts`: local commands, opt-in post-task verification, reports, exit codes, and cancellation.
- `tests/phase3-verification.test.ts`, `tests/phase3-app.integration.test.ts`: command, configuration, repair, app, and real-CLI coverage.
- `README.md`, `docs/PHASE3_VERIFICATION.md`: execution contract, usage, limits, and live smoke evidence.

### Acceptance evidence
- Initial working tree was clean at Phase 2 checkpoint `c8603ce`; baseline `bun run check` passed (19 tests, 116 assertions).
- Final `bun run check`: TypeScript passed; 41 tests, 225 assertions, no failures.
- `git diff --check` and CLI help passed.
- Live isolated CLI/Pi smoke: Casper observed a failing Bun test, passed exact evidence to Pi, Pi repaired subtraction to addition without modifying tests/config/rules, and Casper's targeted/full selected-suite reruns passed. One repair attempt; CLI exit 0. A separate `bun test` passed (1 test, 2 assertions).
- Existing `AgentRuntime`/`PiRuntime` files and dependency pins remain unchanged. Independent standards/spec reviews identified stale explicit-repair context and stalled-startup termination; both have regression-tested fixes and both independent follow-up reviews report no blocking findings. Targeted debugging also fixed post-shutdown verification, abort-error disposal, and intact UTF-8 evidence. Review/follow-up results and performance measurements: `docs/PHASE3_REVIEW.md`.
- Three repeated Phase 3 test runs passed (22 tests / 109 assertions each). Startup benchmarking showed no clear regression; output stress checks retained bounded evidence for up to 256 MiB of command output. No speculative performance refactoring was needed.
- Detailed live smoke evidence and deliberate limits: `docs/PHASE3_VERIFICATION.md`.

### Exclusions
No Pika, MCP, LSP, new tool framework, persistence database, subagents, or other later-phase features.

## Phase 4 — MCP Capability Broker (Implemented; deployment acceptance pending)

### Scope and execution contract
- Preserve the Pi seam. Add runtime-neutral custom-tool definitions and replacement of Casper-owned tools; only the Pi adapter translates these into SDK registrations.
- Use the pinned official MCP TypeScript SDK for stdio and Streamable HTTP, not a second hand-written protocol stack. Pi has no built-in MCP manager. No OMP runtime dependency.
- Discover `~/.casper/mcp.json`, selected-profile `mcp.json`, project `mcp.json`, `.mcp.json`, and `.casper/mcp.json` in that precedence order. Accept the common `mcpServers` map. Keep source information; validate entries independently; report malformed/unsupported definitions without leaking credentials.
- Discovery/status never executes commands or contacts servers. Every definition starts disconnected. `/mcp connect <name>` or leading CLI `--mcp <name>` explicitly authorizes that loaded definition for this process only. Project config cannot self-grant trust. No credential/config writes, OAuth flow, or production connections during development.
- MCP manager owns bounded connection/request deadlines, paginated tool discovery, list-change refresh, dead-connection invalidation, bounded reconnect attempts/cooldown, cancellation, and idempotent teardown. Never transparently replay a tool call after failure.
- Broker owns stable collision-safe IDs, schema-free metadata indexing, lexical task ranking, router-style preference, and a small direct surface (at most six MCP tools, with a total schema budget). Keep `find_capability` (search or inspect one schema) and `call_capability` as discovery/invocation fallback, so uncommon tools remain usable without exposing the catalog.
- Conservative classification: explicit read-only annotations permit reads; diagnostic annotations are visible; unknown tools require confirmation like writes. Generic router dispatchers are consequential even when their names sound safe. Skills and tool descriptions cannot grant permission. Interactive exact-call confirmation for non-read calls; fail closed without a confirmation UI. Runtime shell tools remain unsandboxed.
- Bound every model-facing MCP result by items and serialized bytes, including errors. Preserve error status, disclose truncation, retain provider continuation data when possible; do not invent replay/continuation for consequential calls. No raw-result persistence in this slice.
- `/mcp` shows redacted status/counts; local connect/disconnect commands work without Pi. Startup stays lazy.

### Implementation and acceptance sequence
1. Configuration discovery and MCP lifecycle module; filesystem fixtures plus real local stdio/HTTP protocol servers.
2. Broker metadata/ranking/safety/result bounds; a 340-tool generic fixture plus an HPE-style `find_tool` / `invoke_read_tool` / `invoke_tool` fixture.
3. Runtime custom-tool seam, app commands, and CLI connection opt-in; test through the existing app/runtime seam and a real Pi SDK session with no remote server access.
4. Acceptance: at most eight additional model-facing tools for a 340-tool catalog; an initially unselected rare tool can be searched, its schema loaded, and called. Router-style fixture prefers its native router surface. Verify collision routing, annotations/confirmation, invalid arguments, bounded Unicode/large results, partial failures, timeout/cancel, refresh/removal, reconnect, and shutdown.
5. Run `bun run check`, repeated Phase 4 tests, diff checks, isolated real CLI smoke, and (if model authentication is available) a live Pi read-only fixture workflow. Record fixture versus live-HPE evidence honestly; actual production HPE acceptance requires separate authorization.

### Reference findings
- Pi SDK/docs: public dynamic `registerTool` and `setActiveTools` allow selective tools without a fork; Pi explicitly does not provide MCP itself.
- GreenCLI local `src-tauri/src/mcp/client.rs`: keep status locks short, filter dead tools, refresh on list-change, and separate credential material from renderer state.
- OMP upstream `packages/coding-agent/src/mcp/manager.ts`: connection generations prevent late resurrection; deduplicate reconnects and cap reconnect storms; never gate startup on all servers.
- Local secure-ssid HPE `docs/tool-router.md`: prefer native discovery/read dispatch, treat generic dispatch as consequential, keep schemas on demand, and bound both items and bytes. Its native cursors apply only to reads. These repositories are design references, not dependencies.

### Delivered evidence
- `src/mcp/{config,manager}.ts`, `src/capabilities/{broker,result}.ts`, runtime custom-tool support, app commands, CLI `--mcp`, and public exports are implemented.
- `bun run check` after optimization/debugging: TypeScript passed; **66 tests / 363 assertions**, no failures. Three repeated Phase 4 runs: **25 tests / 138 assertions** each, all passed. Diff whitespace checks passed.
- Real local stdio and Streamable HTTP fixtures (JSON and SSE); 340-tool generic and router catalogs; strict small-surface, schema/search/call, refresh, collision, safety, cancellation, reconnect, and teardown coverage.
- Real Pi/provider-payload fixture proves a 15-tool initial surface (7 existing + 8 broker), discovery of an initially hidden rare tool, and same-session active-set replacement/removal.
- Live Pi read-only smoke against two local 340-tool MCP fixtures passed with five calls and zero tool errors after fixing the discovered empty-optional-field compatibility bug. No production MCP/device access.
- Regression-tested fixes also cover SDK child cleanup exceeding Casper's CLI deadline and Pi's permanent initial allowlist excluding later selected tools.
- Initial startup sample showed ~46 ms added cost. Follow-up profiling removed eager Pi SDK import from local commands: paired Phase 4 startup median **419 → 141 ms** (~66% lower). Warm 340-tool search **1.5014 → 0.0325 ms**, schema lookup **0.9260 → 0.0028 ms**, validated local call **2.3752 → 0.1079 ms**, via revision-bound indexing/validator caches. No startup MCP connections.
- Follow-up regressions fixed approval surviving reconnect, unanswered HTTP POSTs after cancellation, interactive command failures terminating the session, EOF hangs, and close skipping concurrent teardown. Cache invalidation and lazy runtime shutdown have regression coverage.
- HPE is an optional user/profile configuration, never a bundled global integration. Fixture coverage proves personal-profile definitions do not leak into unrelated/default profiles.
- Detailed evidence and limits: `docs/PHASE4_VERIFICATION.md`; usage/safety: `docs/MCP.md`.
- Independent Standards/Spec review covered the full tracked diff and every original untracked file. Three concrete defects were reproduced and fixed (lossy schema inspection, recursive application-data normalization, and refresh-timeout HTTP cleanup); shared schema-budget policy also has boundary coverage. Follow-ups found no blocking issues; an additional P3 binary-metadata omission was regression-tested, fixed, and independently re-reviewed as resolved. Final check: **71 tests / 389 assertions**, TypeScript passed; three Phase 4 repeats: **30 tests / 164 assertions each**. All reported findings resolved. Reports: `docs/PHASE4_REVIEW.md`.
- **Pending:** separately authorized real-HPE deployment acceptance for the optional personal integration. Changes remain uncommitted; no push.

### Exclusions
No Pika, LSP, visualization, sessions/worktrees, subagents, memory, embeddings, code-mode sandbox, remote credential provisioning, or device/network writes were part of Phase 4.

## Phase 5 — LSP (complete)

The user explicitly authorized Phase 5. Delivered the smallest Casper-owned stdio language-server layer for diagnostics after native edits, document/workspace symbols, definitions, references, and language-aware rename. OMP was studied as reference only; no runtime dependency or fork added.

- Metadata-only layered LSP configuration; explicit `/lsp connect` / leading `--lsp` consent, local status/disconnect, no automatic server installation or startup.
- Bounded protocol framing, initialization, UTF-16 synchronization, deadlines, cancellation, failure isolation, and process-group teardown.
- One runtime-neutral `lsp` tool. Pi-only diagnostics hooks and native mutation-queue translation stay in `src/runtime/pi.ts`.
- Exact interactive rename approval; one-shot denial; bounded whole-workspace snapshots, path/range/version/membership preflight and revalidation; honest partial-write reporting without rollback/replay.
- Fresh versus unversioned/unavailable/timeout diagnostics. Two-phase content/version synchronization prevents stale dependency reports from masquerading as fresh.
- Actual TypeScript language-server navigation/rename plus before/after compiler checks. Actual Pyright repository-wide rename returned fresh zero diagnostics across all three files, preserved unrelated text, and passed its independent CLI check.
- Independent Standards/Spec review and follow-ups complete; all findings resolved. **109 tests / 541 assertions**, TypeScript passed. Three repeated Phase 5 suites passed (**38 tests / 152 assertions each**).

Configuration/limits: `docs/LSP.md`. Implementation/acceptance: `docs/PHASE5_IMPLEMENTATION.md`. Review evidence: `docs/PHASE5_REVIEW.md`.

Subsequent debug/performance pass: startup-consent and queued-cancellation fixes, coherent diagnostic batches, linear framing, and bounded file-sized buffers. Paired local-fixture 100-file rename median **4700.62 → 319.46 ms**; evidence and reproducible benchmark in `docs/PHASE5_PERFORMANCE.md`. Current validation: **117 tests / 596 assertions**, TypeScript passed; three repeats **46 tests / 207 assertions each**; both independent follow-up reviews found no actionable issues.

Changes remain uncommitted and unpushed. Optional personal HPE acceptance remains separately pending authorization. Phase 6 and other later features were not started.
