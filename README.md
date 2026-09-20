# Casper

Casper is a standalone coding companion CLI built as its own project.

Casper uses Pi as a pinned runtime dependency through a thin adapter layer:

```text
Casper CLI / app
  -> AgentRuntime
  -> PiRuntime
  -> Pi SDK
```

This means:
- Casper is its own program.
- Casper owns its own UX and control layer.
- Pi is a dependency, not the product identity.
- Pi is not forked.
- OMP is not a runtime dependency.

## Current scope (Phases 0–8; Phase 9 started)

- Bun + TypeScript CLI with a pinned Pi runtime dependency
- thin `AgentRuntime` / `PiRuntime` seam
- compact Casper banner and streamed runtime output
- Git root and branch inspection
- deterministic language, framework, package-manager, and command detection
- cached project models under `~/.casper/projects/`
- global, profile, and project policy loading with safe precedence
- selected profiles and profile/project rules
- deterministic task classification and relevant command context
- `/project` summary
- metadata-only skill discovery, deterministic ranking, and selective body loading
- skill provenance, explicit content-bound review, and local `/skills` commands
- Casper-owned typecheck/lint/test/build verification with structured command evidence
- explicit local checks, bounded model-assisted repair, and opt-in model-selected managed checks

- MCP configuration discovery and explicitly authorized stdio/Streamable HTTP connections
- bounded capability discovery, selective direct tools, and router-style MCP preference
- exact-call confirmation for non-read MCP tools and local `/mcp` status

- Casper-owned opt-in LSP connections, symbols, definitions, references, and language-aware rename
- exact interactive rename approval, snapshot preflight, and diagnostics after native edits

- neutral graph IR, `VisualizationProvider` seam, Mermaid fallback, and MindMesh schema-6 file adapter
- read-only `visualize` tool for visualization-intent prompts, deterministic repository dependency graphs, and local `/visualize` commands

- Pi-backed named session branches with `/tree`, `/branch`, and `/switch`
- policy-gated experimental Git worktrees with reviewed verify/apply/discard return-to-main workflows

- bounded read-only explorer/reviewer subagents through `delegate` and `/delegate`
- enforced child tool selection, run/dispatch limits, cancellation, and bounded reports

- explicit project facts and truthful task outcomes (Phase 9's first slice)

Not implemented yet: reference search, `casper learn`, candidate-to-skill promotion, or writing subagents. Phase 4 is validated with local generic/HPE-style fixtures and a live model; actual deployment-specific HPE acceptance remains pending. Independent Phase 6–8 reviews and corrective follow-ups are recorded in `docs/PHASE6_REVIEW.md`, `docs/PHASE7_REVIEW.md`, and `docs/PHASE8_REVIEW.md`; runtime findings are resolved. Interactive MindMesh remains a disclosed broader-plan gap, not completed integration. Phase 9 is incomplete and awaits its own review.

## Language servers

Configure `.casper/lsp.json`, inspect `/lsp`, then explicitly `/lsp connect <name>` (or use leading `--lsp <name>`). No automatic installation or startup. The single `lsp` tool provides diagnostics, symbols, definitions, references, and approval-gated rename. Native edit/write results include diagnostics from connected servers. Missing or unversioned diagnostics are not proof of clean code.

See [`docs/LSP.md`](docs/LSP.md) for configuration, safety, limits, and diagnostics semantics; [`docs/PHASE5_IMPLEMENTATION.md`](docs/PHASE5_IMPLEMENTATION.md) for completed acceptance, and [`docs/PHASE5_REVIEW.md`](docs/PHASE5_REVIEW.md) for independent review evidence. The subsequent [debug/performance report](docs/PHASE5_PERFORMANCE.md) includes controlled before/after measurements; rerun local benchmarks with `bun run scripts/benchmark-lsp.ts`.

## Visualization

Ask for a diagram (`map out the authentication flow`, `show me the auth flow as a mind map`) and Casper exposes a read-only `visualize` tool that renders a neutral graph through configured providers: Mermaid text inline, plus MindMesh JSON and Mermaid files saved under `~/.casper/visualizations/<project>/` — never inside the repository. `/visualize repo [dir]` renders the project's relative-import dependency graph locally without a model. A diagram never authorizes code changes. See [`docs/VISUALIZATION.md`](docs/VISUALIZATION.md) and [`docs/PHASE6_IMPLEMENTATION.md`](docs/PHASE6_IMPLEMENTATION.md).

## Named sessions and worktree experiments

Use `/tree` to inspect named branches, `/branch <name>` to clone the active Pi conversation, and `/switch <branch>` to resume one. Experimental branches use a managed Git worktree by default and all creation/switching requires exact interactive approval. Return with `/switch main apply` (verify, review the complete diff, apply it uncommitted) or `/switch main discard` (review, then unregister without applying). Candidate changes during approval are preserved. Cleanup retains files in a printed recovery directory rather than force-deleting bytes that an external editor could still be changing.

See [`docs/SESSIONS.md`](docs/SESSIONS.md) for the workflow, policy, safety checks, and limits, [`docs/PHASE7_IMPLEMENTATION.md`](docs/PHASE7_IMPLEMENTATION.md) for implementation evidence, and [`docs/PHASE7_PERFORMANCE.md`](docs/PHASE7_PERFORMANCE.md) for the debug/optimization follow-up.

## Bounded subagents

```text
/delegate explorer Find the authentication entry points and their callers
/delegate reviewer Inspect src/sessions/manager.ts for approval-race risks
```

The primary model can also call `delegate` with a self-contained `role`, `goal`, and optional `context`. Both roles use fresh, read-only Pi sessions with only `read`, `grep`, `find`, and `ls`; no shell, writes, external capabilities, ambient extensions, or recursion. Children inspect the active workspace (including uncommitted work) without creating worktrees. Workspace switches wait for child work to finish.

Limits: 2 concurrent children, 4 delegations per prepared parent prompt, 180 seconds / 12 model turns / 48 tool calls per child. Results are bounded and explicitly report failures, limits, and truncation. Child model defaults come from global Pi settings, not project model overrides. Read-only tool authority is **not an OS sandbox or spending cap**; reports are not verification evidence. See [`docs/PHASE8_IMPLEMENTATION.md`](docs/PHASE8_IMPLEMENTATION.md) for lifecycle, context, safety limits, and real Pi fixture acceptance.

## Project facts and task outcomes — Phase 9 first slice

```text
/memory remember API calls belong in services/
/memory
/memory forget <fact-id>
/memory outcomes
/memory accept <outcome-id> yes
```

Facts are explicit human-entered guidance, included on the next parent prompt; current repository evidence/rules/policy take precedence. Normal model tasks record bounded local task summaries, selected skills, verification/skip status, and repair counts. Model completion is not a verification pass. Human acceptance stays unknown until explicitly recorded. No raw model/tool/check outputs are copied. These owner-only plaintext files may contain sensitive task/fact text; inspect them under the existing `~/.casper/projects/<project-key>/` directory.

Reference search, `casper learn`, and human promotion of learned candidates are **not implemented yet**. See [`docs/PHASE9_IMPLEMENTATION.md`](docs/PHASE9_IMPLEMENTATION.md) for storage, limits, validation, and the remaining Phase 9 scope.

## Configuration

Casper reads these optional files:

```text
~/.casper/config.yaml
~/.casper/profiles/<profile>/config.yaml
~/.casper/profiles/<profile>/rules.md
<project>/.casper/project.yaml
<project>/.casper/rules.md
```

Select a profile with `CASPER_PROFILE`, `profile:` in project/global configuration, or the default profile name `default`. Precedence is safe defaults → global → selected profile → project. Project model fields can be overridden in `.casper/project.yaml`:

```yaml
profile: default
languages: [typescript]
frameworks: [react]
packageManager: bun
commands:
  test: bun test
  build: bun run build
policy:
  behavior:
    autonomy: high
  workspace:
    isolateWhen:
      parallelAgents: true
      riskyRefactor: true
      experimentalBranch: true
```

## Skills

Casper owns skill selection; Pi's independent skill discovery is disabled inside the Casper adapter.

Discovery locations (at startup):

| Source | Locations | Default activation trust |
| --- | --- | --- |
| User | `~/.casper/skills/` | Trusted when the canonical file is inside this directory |
| Project | `<project>/.casper/skills/` | Untrusted until reviewed |
| Compatible external | `~/.pi/agent/skills/`, `~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/`; project `.pi/skills/`, `.agents/skills/`, `.claude/skills/`, `.codex/skills/` | Untrusted until reviewed |

Directories are scanned recursively for `SKILL.md`; standalone `.md` files with valid frontmatter also work. Once a directory contains `SKILL.md`, its references and scripts are not indexed as separate skills. Canonical paths deduplicate symlinks. Project discovery starts only at the listed project skill directories (no ancestor scanning) and rejects directory/file symlinks that resolve outside the canonical project root. In-project symlinks remain supported. Pi packages and custom Pi skill paths are not imported.

Example `~/.casper/skills/mcp-authoring/SKILL.md`:

```markdown
---
name: mcp-authoring
description: Build MCP tools with bounded output and safe schemas.
tags: [mcp, tools]
stacks: [typescript, python]
intents: [implement, fix]
---
Bound responses by both item count and serialized byte size.
See references/examples.md for examples; resolve paths relative to this directory.
```

Unknown frontmatter is preserved. Startup indexes metadata, not instruction bodies. For each prompt, Casper ranks eligible skills using task words, tags/name/description, task intent, and project stack. A broad intent or stack match alone does not activate a skill. `disable-model-invocation: true` excludes a skill from automatic selection, even after review.

Configure the selection limit in global, profile, or project YAML (same precedence as other configuration):

```yaml
skills:
  maxActive: 6 # default; 0 disables automatic loading, maximum 32
```

Only selected bodies are read and injected, with their source and base directory. Duplicate names remain inspectable with distinct IDs; selection includes only one per name. Higher relevance wins, then project → user → external, then stable ID. Limits: 16 KiB frontmatter, 256 KiB per skill file, and 64 KiB combined bodies per prompt. Invalid/oversized skills produce diagnostics rather than blocking startup.

### Inspect and review

These commands are local and work without model credentials or runtime startup; they do not send skill bodies to the model. Pi starts lazily on the first non-local prompt:

```text
/skills
/skills inspect <id>
/skills trust <id> <sha256>
/skills block <id>
```

Use the exact ID from `/skills`. Inspection prints the body and its SHA-256; review it before running the printed trust command. Decisions are stored in `~/.casper/skills-trust.json`, keyed by canonical path. Trust is checked against the current file content on activation; changing a reviewed skill requires another review. Changing its frontmatter requires restarting Casper to rebuild the index. A corrupt/unreadable trust store fails closed with an error.

Trust cannot be granted through project config or skill frontmatter. Native user skills are an intentional user-controlled instruction source—do not copy unreviewed imports there. Symlinks escaping the native user skill directory require explicit review.

**Limits of this protection:** this gates Casper's automatic skill injection, not filesystem or shell access. Skills do not grant permissions, and the registry never executes helper scripts. The runtime's existing read/bash tools are not sandboxed; policy remains prompt guidance. Trust covers `SKILL.md`, not the referenced scripts/assets, which must be inspected separately. Blocking prevents future injection; it does not erase bodies already present in conversation history. `maxActive` bounds new injections, not total session history.

## Verification and repair

Run project-native checks without starting Pi, or explicitly authorize repair:

```bash
bun run src/cli.ts "/verify"                      # all four check kinds
bun run src/cli.ts "/verify typecheck test"       # selected checks, in this order
bun run src/cli.ts "/verify repair test"          # start Pi only if a check fails
bun run src/cli.ts --verify "Fix the login flow"  # model-selected managed checks + repair
```

The same `/verify` commands work interactively. `--verify` (or `CasperApp({ autoVerify: true })`) offers the model a `casper_check` tool for normal requests, including vague requests such as “Continue”. With no prompt, the flag enables it for the interactive session. The model selects relevant configured checks based on actual work, for example `casper_check({ check: "test" })`; request keywords no longer choose checks. Docs-only/no-change work may need none. No selection means **no Casper verification recorded**, not a pass or a mandatory four-check pipeline. Use `/verify` to explicitly select checks yourself.

Without the flag, normal prompts have no managed check tool or automatic verifier commands. **Native bash is unchanged.** This is a managed-check subset, not transparent native-shell reuse: Casper uses its own existing command runner, not Pi's bash prefixes or session environment injection. The flag and `/verify` are **explicit execution consent, not sandboxing or persisted repository trust**. Use them only in repositories whose commands you trust. Repair also authorizes model edits.

Project `.casper/project.yaml` can specify canonical checks:

```yaml
verify:
  typecheck: bun run typecheck
  lint: bun run lint
  test: bun test
  build: bun run build
verification:
  timeoutMs: 120000 # per command; default 2 minutes, maximum 1 hour
  scopes:          # optional, project-local declarations; NOT inferred coverage
    test:
      inputs: [src, tests, package.json, bun.lock, tsconfig.json]
      exclude: [tests/coverage] # only if this is generated output, not test input
repair:
  maxAttempts: 3   # repair prompts, not initial verification; 0 disables repair, max 10
```

`verify:` is project-local and overrides `commands:` and detected commands by check name. Only nonempty typecheck/lint/test/build commands are accepted. Timeout and repair settings also work in global/profile configuration, with project settings taking precedence. Commands and declared input scopes are loaded at startup and frozen during repair; restart after changing configuration or manifests.

Managed checks run sequentially at the project root using the platform shell and inherited environment. The tool accepts only a check name (`typecheck`, `lint`, `test`, `build`), not a command, scope, cwd, or timeout override. No dependency installation or missing-tool fallback is attempted. Requested absent commands are visible **skips**, never passes; an unavailable configured executable is a failure. `/verify` still defaults to typecheck → lint → test → build. Unselected categories are not required checks; selecting a missing command produces incomplete evidence.

Tool calls and post-task verification share one task-local evidence store. Concurrent managed calls serialize, and unchanged scoped passes are not executed again. At normal completion, selected passes with stale/unavailable freshness are rechecked once; known-invalidated failures are also rechecked before deciding on repair. Unknown/self-mutating inputs remain qualified rather than causing a freshness-seeking loop. Managed calls do not lock out native edits/bash or external writers: run checks after edits settle, and heed the non-atomic observation limits below.

A tool returns execution evidence to Pi's ordinary edit/check loop; it never starts a nested repair prompt. Unresolved actual failures reach the existing bounded repair owner after the main prompt settles, carrying the exact command, bounded output, exit status, available Git changed-file context, original request, and constraints. Post-task repair preserves that task's request; explicit `/verify repair` uses the objective of making the selected checks pass, not an unrelated earlier prompt. Failed checks rerun first; after they pass, multi-check selections revisit the full selection to catch regressions, reusing only passing results with matching **declared-input** evidence. A valid managed pass obtained during repair also avoids a duplicate command. New requests and explicit `/verify` calls always start fresh; captured old check tools are revoked. The model saying “done” is not a passing result. Up to three repair prompts run by default. Passing selected checks does not imply unselected checks passed.

The terminal shows concise results, not full logs. Programmatic `CasperApp.runOnce()` returns a `VerificationReport` for verification runs, including all rounds. `getLastTaskResult()` returns a detached result for the last normal request, separating execution (`completed`, `failed`, `cancelled`) from optional verification; local commands clear this result. Normal requests print a factual execution/verification receipt, including bounded observed native edit paths, possible tool writes (including failed/partial writes), and exact-command shell observations. **Shell tool status is diagnostic data, not process-exit evidence:** native shell checks are not reused or counted as verifier passes. Terminal model error/abort stops skip further checks and repair, retain already-executed managed evidence as blocked, and produce CLI exit codes 1/130 rather than success; an intermediate provider error recovered by Pi is not a terminal failure. Otherwise verification exit codes remain 0 for pass, 2 for incomplete, and 1 for failure/blocked; completion without verification exits 0 without claiming verified behavior. Evidence includes cwd, command, status, exit code/signal, duration, stdout/stderr, failure reason, and truncation. Each stream retains at most 8 KiB of original bytes (head/tail plus a truncation marker); this bounded evidence is what repair receives. No evidence database or unbounded raw-log artifact is created.

**Command success, input freshness, declared scope, and behavioral coverage are separate facts.** Reports and receipts say `Checks pass (command execution)`, not that the current files or requested behavior are verified. Stale or unavailable inputs remain explicitly unverified and cannot support reuse; they do not rewrite successful command exits or trigger a new repair/approval loop. Only actual check failures enter the existing bounded repair loop. Saved task outcomes and `/memory outcomes` retain exit codes, scope, freshness and a bounded freshness reason, without storing output or fingerprints. Human acceptance still starts unknown. Legacy outcomes remain readable, are labeled as legacy, and missing freshness stays unavailable.

`verification.scopes` is optional and project-local. Each check may declare literal relative `inputs` (files/directories, recursively; `.` means the project root) and optional `exclude` paths/subtrees. No globs, absolute paths, traversal, or fully excluded input roots; each list has at most 32 paths, each path at most 256 UTF-8 bytes, and each declaration at most 2 KiB. **No declaration means unavailable freshness and no reuse, not a command failure.** `.gitignore` is not an input contract: ignored files inside a declared scope are included unless explicitly excluded. Generated artifacts/coverage outside the input scope or explicitly excluded from it do not make a successful check stale.

Freshness is observed before/after each check and at report time; checks also refresh earlier evidence so one check cannot silently invalidate another. Observed native edit/write paths invalidate matching declared scopes even if later work restores directory membership, including edits overlapping a check. Native path syntax is expanded once before matching filesystem identities (including file URLs, tilde paths and aliases); an actual `@`-prefixed filename is not stripped again. Declared input roots are resolved too, including case aliases on case-insensitive filesystems, while exclusions retain the scope observer's traversal spelling. Observed included symlink entries also invalidate evidence, even when their targets are excluded or outside the scope and the links are later removed. Excluded links do not hide writes to included targets. Failed native writes conservatively invalidate possible partial changes without claiming a completed edit; missing targets retain their path beneath the nearest existing canonical parent. Possible case/Unicode aliases of the first missing entry (including a named input's parent) invalidate conservatively, and a missing suffix cannot establish an exclusion's traversal spelling. This may cause extra executions for ambiguous absent names even on case-sensitive filesystems; resolved prefixes and literal exclusions are not case-folded. Unresolvable or over-budget path observations conservatively invalidate scoped evidence. Resolved observations with neither an included target nor included symlink traversal do not invalidate other scopes, and observations do not select additional checks. Included file bytes/metadata and directory membership/modes are fingerprinted; named input creation/deletion invalidates previous evidence. Directory timestamps caused by excluded outputs do not affect the fingerprint. Included symlinks (including parents of named paths), special files, I/O errors, or limits (1 MiB/file, 16 MiB total, 4,096 work items, 500 ms checked between I/O operations) disable reuse with a specific reason. An unavailable before/after observation cannot later become a fresh check merely because the final observation succeeds.

**Declared scope is an assumption, not discovered dependency coverage.** For example, the sample above does not observe installed `node_modules`, environment variables, external tools or services. A lockfile does not prove installed dependencies are unchanged. If a check depends on excluded/unlisted inputs, changes there can go undetected: include them or leave the scope undeclared to disable reuse. Even a fresh scoped result does not certify behavior. These bounded observations are not atomic snapshots, a sandbox, or a guarantee against transient changes during commands or edits after reporting. See [`docs/CODING_LOOP_EVIDENCE_CONTRACT.md`](docs/CODING_LOOP_EVIDENCE_CONTRACT.md) for this slice's regressions, measurements, and remaining work.

One-shot exit codes: **0** selected commands passed (execution only, even if freshness is stale/unavailable), **1** failed/blocked, **2** incomplete (skips or no commands). Timeouts and cancellation terminate verifier process groups on POSIX; Windows only has direct-process cleanup and has not been validated. SIGINT/SIGTERM cancel checks and prevent further repair; the CLI gives cleanup up to one second, then exits even if runtime startup/abort is stalled. Programmatic `app.close()` drains runtime startup and verification before disposal but has no forced-exit deadline. Command timeouts do not bound model response time. Commands and runtime tools are not sandboxed, and command output may contain secrets—review your checks before sending their output to a model.

See [`docs/PHASE3_VERIFICATION.md`](docs/PHASE3_VERIFICATION.md) for validation and the live failure → repair → rerun smoke, and [`docs/PHASE3_REVIEW.md`](docs/PHASE3_REVIEW.md) for pre-commit review/debugging/performance findings.

## MCP capabilities

MCP configuration is discovered as metadata only. Servers start disconnected; neither project configuration nor skills can grant connection or write permission. **No HPE server is bundled or enabled for everyone.** Personal integrations belong in a user/profile MCP file (for example `~/.casper/profiles/stephen/mcp.json`); the HPE-named test fixtures do not configure real servers.

```text
/mcp                         # local redacted status, no Pi startup
/mcp connect <name>           # explicitly authorize this server for this process
/mcp disconnect <name>        # disconnect and revoke consent
```

```bash
bun run src/cli.ts --mcp docs "Find the pagination documentation"
```

Casper accepts common `mcpServers` JSON maps from user, selected-profile, and project files. It supports stdio and Streamable HTTP with environment/header authentication. A large catalog contributes at most six selected direct tools plus `find_capability` and `call_capability`, not all its schemas. Native router surfaces are preferred. Results are bounded to 16 KiB; non-read calls require exact interactive confirmation and are denied in one-shot mode. Connection consent and annotations are not sandboxing; existing Pi tools remain unsandboxed.

See [MCP configuration, usage, safety, and limits](docs/MCP.md) and [Phase 4 validation](docs/PHASE4_VERIFICATION.md).

## Requirements

Casper depends on Pi's SDK package and whatever model/provider auth Pi can access.

In practice, that means you need working model authentication available to Pi, for example through:
- supported environment variables such as `ANTHROPIC_API_KEY`, or
- Pi's stored auth/config

## Install

```bash
bun install
```

## Run

Interactive:

```bash
bun run src/cli.ts
```

One-shot prompt:

```bash
bun run src/cli.ts "Summarize this repository"
```

Help:

```bash
bun run src/cli.ts --help
```

## Checks

Typecheck:

```bash
bun run typecheck
```

Tests:

```bash
bun test
```

Combined check:

```bash
bun run check
```
