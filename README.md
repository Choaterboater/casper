# Casper

[MIT licensed](LICENSE). Third-party dependencies retain their own licenses.

Casper is a terminal coding companion built on Pi, with its own interface, project context, and verification controls.

**Release status:** source checkout available locally; no public binary release yet. macOS is validated here. Linux and Windows still need real-host validation.

After [local installation](#install), run `casper` from the project directory you want to work in. Use `casper --help` or `casper /project` without making a model call.

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

## Current scope (Phases 0–9 and Phase 10 browser/local debugging)

- Bun + TypeScript CLI with a pinned Pi runtime dependency
- thin `AgentRuntime` / `PiRuntime` seam
- scrollback-friendly multiline terminal, persistent status footer and fuzzy command discovery
- globally remembered model/effort, session-only overrides, context/usage and clear/resume controls
- offline interface demo: `bun tools/terminal-demo.ts` ([terminal guide](docs/TERMINAL_UX.md))
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
- read-only local reference search with configured sources and file/line provenance
- `casper learn <local-repo>` with host-checked source citations and inert, inspectable drafts
- digest-bound, create-only human promotion to references/project skills/global skills, plus ignore decisions

- [browser-assisted debugging](docs/BROWSER.md) with disposable installed Chrome/Chromium, bounded inspection and owner-only screenshots
- task-owned development servers, interaction consent, immutable behavior/layout replay and scoped freshness reporting
- browser evidence kept separate from repository verification
- [local DAP debugging](docs/DEBUGGER.md): exact launch approval, source breakpoints, bounded stack/variable inspection and owned-process cleanup
- explicit `/debug` commands; no automatic model injection, remote attach or adapter installation

Not implemented yet: writing subagents. Phase 4 is validated with local generic/HPE-style fixtures and a live model; actual deployment-specific HPE acceptance remains pending. Independent Phase 6–8 reviews and corrective follow-ups are recorded in `docs/PHASE6_REVIEW.md`, `docs/PHASE7_REVIEW.md`, and `docs/PHASE8_REVIEW.md`; runtime findings are resolved. Interactive MindMesh remains a disclosed broader-plan gap, not completed integration. Phase 9's implementation and same-agent Standards/Spec review are complete; no independent reviewer was available, so independent sign-off is not claimed.

## Platform support

Casper targets macOS, Linux and Windows with the same control plane. One shared layer
(`src/platform/`) owns OS differences instead of per-feature platform branches:

- **Process ownership** (`processes.ts`) — POSIX uses `ps` parentage and process
  groups; Windows has no groups, so it lists the process table through PowerShell
  `Get-CimInstance Win32_Process` (legacy `wmic` fallback) and terminates only
  verified descendants, children first. A PID whose OS identity stamp changed is
  never treated as owned. Cleanup results are awaited; an unusable listing is
  reported **unknown**, not success. Affected integrations refuse replacement, and
  Casper blocks subsequent execution while keeping status/help available. POSIX
  callers retain best-effort group signalling; that is not proof every descendant exited.
- **Environment isolation** (`environment.ts`) — spawned adapters, browsers and
  development servers get an allowlisted environment with a temporary user
  directory (`HOME`/`TMPDIR` on POSIX; `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
  `TEMP`/`TMP` plus the Windows loader variables elsewhere). Provider credentials
  are never inherited.
- **State-file access** (`files.ts`) — `O_NOFOLLOW`/`O_NONBLOCK` do not exist on
  Windows; those callers reject a final symlink explicitly there and degrade to a
  non-atomic pre-open observation instead of failing.

| Area | macOS | Linux | Windows |
| --- | --- | --- | --- |
| CLI, terminal, sessions, verification, skills, MCP, LSP | validated here | shared POSIX paths; no host run recorded | implemented; real-host validation pending |
| Browser sessions and owned dev servers | validated against installed Chrome | discovery list implemented; no host run recorded | implemented (Chrome/Edge discovery); real-host validation pending |
| Local DAP debugger | validated with installed debugpy 1.8.20 | shared POSIX paths; no host run recorded | implemented; real-host validation pending |
| Diagram artifact files | validated | implemented via `openat`; no host run recorded | unavailable: diagrams stay in-conversation (fails closed) |
| POSIX-only test fixtures (PTY, symlink, FIFO, mode bits, process groups, native shell commands) | run | no host run recorded | explicit skips with stated reasons; no Windows coverage |

"Implemented; real-host validation pending" means the code path exists and is
covered by simulated-platform tests plus the shared POSIX suite, but no gate has run
on that OS. Process discovery and cleanup are bounded, non-atomic observations, not
a sandbox: unobserved daemonized descendants and PID-reuse races are not certified on
any platform. See [platform support details](docs/PLATFORM_SUPPORT.md),
[debugger limits](docs/DEBUGGER.md) and [browser limits](docs/BROWSER.md). To
validate a host, run the [platform verification runbook](docs/PLATFORM_VERIFICATION.md):
`bun tools/platform-report.ts` plus the typecheck and platform suite.

## Language servers

Configure `.casper/lsp.json`, inspect `/lsp`, then explicitly `/lsp connect <name>` (or use leading `--lsp <name>`). No automatic installation or startup. The single `lsp` tool provides diagnostics, symbols, definitions, references, and approval-gated rename. Native edit/write results include diagnostics from connected servers. Missing or unversioned diagnostics are not proof of clean code.

See [`docs/LSP.md`](docs/LSP.md) for configuration, safety, limits, and diagnostics semantics; [`docs/PHASE5_IMPLEMENTATION.md`](docs/PHASE5_IMPLEMENTATION.md) for completed acceptance, and [`docs/PHASE5_REVIEW.md`](docs/PHASE5_REVIEW.md) for independent review evidence. The subsequent [debug/performance report](docs/PHASE5_PERFORMANCE.md) includes controlled before/after measurements; rerun local benchmarks with `bun run scripts/benchmark-lsp.ts`.

## Local debugger

Configure project `.casper/debug.json`, inspect `/debug`, then `/debug start <target>`.
Casper asks before executing the exact adapter and program. Use `/debug threads`,
`/debug stack <thread>`, `/debug scopes <frame>`, `/debug variables <handle>`,
`/debug continue <thread>` and `/debug stop`. Values may contain secrets; debugging
is not verification. Real installed debugpy is validated on macOS; Linux shares the
POSIX code path and Windows is implemented (PowerShell/wmic parentage) without a
real-host gate yet. See [configuration and limits](docs/DEBUGGER.md) and
[Phase 10 release evidence](docs/PHASE10_DEBUGGER_REVIEW.md).

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

If facts are invalid or unreadable, normal tasks warn and continue without remembered guidance; the facts file is not reset or repaired. Explicit `/memory` reads and changes still fail closed on invalid state. A later prompt rereads repaired facts. Full outcome stores still refuse new records; no automatic pruning or stale-lock removal is performed.

Learning candidate generation and explicit human promotion are available separately below. See [`docs/PHASE9_IMPLEMENTATION.md`](docs/PHASE9_IMPLEMENTATION.md) for storage, validation, and remaining Phase 9 scope.

## Local reference search

```text
/references
/references search router reconnect
/references search * schema routing
```

Declare local sources and explicit search paths in `~/.casper/references.yaml` or the selected profile's `references.yaml`. These commands are local and need no model credentials. Configured sources also enable one read-only `search_references` tool; it returns requested excerpts with source/file/line/digest provenance rather than injecting whole repositories. Current repository evidence and rules remain authoritative. No project execution, remote fetching, model-directed learning, or automatic promotion. The reserved `casper-promoted` source appears only after a human explicitly promotes a candidate as a reference.

See [`docs/REFERENCES.md`](docs/REFERENCES.md) for configuration, source consent, search semantics, incomplete-result qualifications and lifecycle limits. No external source is enabled automatically.

## Learning candidates

```sh
casper learn ~/Projects/example
casper learn list ~/Projects/example
casper learn inspect ~/Projects/example <draft-id>
casper learn promote ~/Projects/example <draft-id> <draft-sha256> <candidate-number> reference
casper learn promote ~/Projects/example <draft-id> <draft-sha256> <candidate-number> project-skill <skill-name>
casper learn promote ~/Projects/example <draft-id> <draft-sha256> <candidate-number> global-skill <skill-name>
casper learn promote ~/Projects/example <draft-id> <draft-sha256> <candidate-number> ignore
```

Generation uses one bounded read-only explorer with global Pi model defaults; source text may reach that provider. It proposes patterns with context, tradeoffs, use/avoid guidance and host-checked file/line/digest citations. Source quotes are not proof that a pattern worked. Owner-only plaintext drafts stay unverified and unaccepted. Generation never activates them. Listing, inspection and promotion are local and need no model credentials. Promotion requires a human to repeat the exact draft digest, candidate number and disposition; one immutable decision is recorded per candidate. Existing destinations are never overwritten.

Generation refuses sources overlapping Pi's writable state before model/auth startup; local listing, inspection and promotion do not start Pi. Promoted references are searchable as `casper-promoted`; project skills remain in per-project Casper state and global skills in user state. See [`docs/LEARNING.md`](docs/LEARNING.md) for consent syntax, limits, storage, recovery semantics and privacy. Read-only tools are not a filesystem sandbox or spending cap. Validation uses scripted localhost providers, not a live-model usefulness trial. Phase 9's same-agent Standards/Spec review found no issues; independent sign-off remains unavailable.

## Configuration

Casper reads these optional files:

```text
~/.casper/config.yaml
~/.casper/profiles/<profile>/config.yaml
~/.casper/profiles/<profile>/rules.md
<project>/.casper/project.yaml
<project>/.casper/rules.md
```

Profile selection precedence is the programmatic `profileName` option → `CASPER_PROFILE` → project `profile:` → global `profile:` → `default`. Names must be 1–64 ASCII letters, digits, underscores, dots or hyphens, starting with a letter or digit. Every supplied selection is validated, even if overridden; malformed values (including empty strings, surrounding whitespace and non-string YAML values) stop configuration loading. Policy precedence is safe defaults → global → selected profile → project.

**Profile trust:** project-local `profile:` is intentionally allowed to select an existing user profile, including its rules, MCP/LSP definitions and reference sources. Inspect an unfamiliar repository's `.casper/project.yaml` before running Casper: selecting a profile can expose configured reference excerpts to model tasks. MCP/LSP discovery remains metadata-only and connection still requires explicit consent. Name validation prevents lexical traversal; it does not confine user-owned profile symlinks or sandbox native tools. Direct MCP/LSP/reference discovery skips invalid profile names rather than loading a profile file.

Project model fields can be overridden in `.casper/project.yaml`. The `commands:` map (also supported under `project.commands`) admits only string values for `typecheck`, `lint`, `test` and `build`; unknown keys and non-string values are ignored rather than passed into the project model or prompts. Project-local `verify:` overrides these commands and retains stricter validation:

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

Discovery locations (at startup; only Casper's own roots are enabled by default):

| Source | Locations | Default activation trust |
| --- | --- | --- |
| User | `~/.casper/skills/` | Trusted when the canonical file is inside this directory |
| Project | `<project>/.casper/skills/` | Untrusted until reviewed |
| Compatible external **(opt-in)** | `~/.pi/agent/skills/`, `~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/`; project `.pi/skills/`, `.agents/skills/`, `.claude/skills/`, `.codex/skills/` | Untrusted until reviewed |

Enable imports explicitly in `~/.casper/config.yaml` or `~/.casper/profiles/<profile>/config.yaml`:

```yaml
skills:
  imports: [pi, agents] # default []; supported names: pi, agents, claude, codex
```

Each enabled name imports its user and project roots from the table. Profile lists replace global lists; `[]` disables imports. Project-authored `skills.imports` is rejected rather than allowed to enable imports. Existing project profile selection still applies (see Profile trust above). Importing is discovery only, not trust; existing digest-bound review requirements remain. No external skill files are modified.

Directories are scanned recursively for `SKILL.md`; standalone `.md` files with skill frontmatter also work. A standalone file declares skill intent with a `name` or `description` frontmatter field; ordinary docs (including title-only frontmatter) are ignored. Malformed declared skills still produce warnings. Startup summarizes new warnings; `/skills diagnostics` retains full detail. Once a directory contains `SKILL.md`, its references and scripts are not indexed as separate skills. Canonical paths deduplicate symlinks. Project discovery starts only at the listed project skill directories (no ancestor scanning) and rejects directory/file symlinks that resolve outside the canonical project root. In-project symlinks remain supported. Pi packages and custom Pi skill paths are not imported.

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

These skill commands are local and work without model credentials or runtime startup; they do not send skill bodies to the model. Pi starts lazily on `/model` or the first non-local prompt:

```text
/skills
/skills diagnostics
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
bun run src/cli.ts                                # interactive: casper_check offered by default
bun run src/cli.ts --no-verify                    # interactive without the managed check tool
```

The same `/verify` commands work interactively. An interactive session (`casper` with no prompt) offers the model a `casper_check` tool for normal requests, including vague requests such as “Continue”; `--no-verify` withholds it. One-shot prompts get the tool only with `--verify` (`CasperApp({ autoVerify: true })` is the programmatic equivalent). Offering the tool runs nothing: the model selects relevant configured checks based on actual work, for example `casper_check({ check: "test" })`; request keywords do not choose checks. Docs-only/no-change work may need none. No selection means **no Casper verification recorded**, not a pass or a mandatory four-check pipeline. Use `/verify` to explicitly select checks yourself.

Without the tool (`--no-verify`, or a one-shot prompt without `--verify`), normal prompts have no managed check tool or automatic verifier commands. **Native bash remains independent of managed verification.** Casper supplies a **120-second default timeout** when a model-issued bash call omits `timeout`; an explicit timeout in seconds is honored for intentionally longer commands. Timeouts use Pi's native process-tree cleanup and return a tool error so the conversation can continue. Esc/Ctrl+C can still cancel active work before the deadline. Repository-search guidance asks the model to stay within the workspace and narrow timed-out searches; this is guidance, not a filesystem sandbox.

This is a managed-check subset, not transparent native-shell reuse: Casper uses its own existing command runner, not Pi's bash prefixes or session environment injection. The interactive default, `--verify` and `/verify` are **explicit execution consent, not sandboxing or persisted repository trust**: a selected check runs that repository's configured command. Use Casper in repositories whose commands you trust, or start with `--no-verify`. Repair also authorizes model edits.

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

The terminal shows concise results, not full logs. Programmatic `CasperApp.runOnce()` returns a `VerificationReport` for verification runs, including all rounds. `getLastTaskResult()` returns a detached result for the last normal request, separating execution (`completed`, `failed`, `cancelled`) from optional verification; local commands clear this result. Coding requests print a factual execution/verification receipt, including bounded observed native edit paths, the workspace files that actually changed during the model turn (before/after tree digest; `no files changed` when nothing did), files that changed afterwards `during checks/repair` (check-script output, repair edits — attributed to the verification round, not the request), plus a bounded `git diff --stat`, and exact-command shell observations. Successful general conversation without observed effects or verification omits that terminal receipt; the structured task result and local outcome are still retained. Failures/cancellation always remain visible. **Shell tool status is diagnostic data, not process-exit evidence:** native shell checks are not reused or counted as verifier passes. Terminal model error/abort stops skip further checks and repair, retain already-executed managed evidence as blocked, and produce CLI exit codes 1/130 rather than success; an intermediate provider error recovered by Pi is not a terminal failure. Otherwise verification exit codes remain 0 for pass, 2 for incomplete, and 1 for failure/blocked; completion without verification exits 0 without claiming verified behavior. Evidence includes cwd, command, status, exit code/signal, duration, stdout/stderr, failure reason, and truncation. Each stream retains at most 8 KiB of original bytes (head/tail plus a truncation marker); this bounded evidence is what repair receives. No evidence database or unbounded raw-log artifact is created.

**Command success, input freshness, declared scope, and behavioral coverage are separate facts.** Reports and receipts say `Checks pass (command execution)`, not that the current files or requested behavior are verified. Stale or unavailable inputs remain explicitly unverified and cannot support reuse; they do not rewrite successful command exits or trigger a new repair/approval loop. Only actual check failures enter the existing bounded repair loop. Saved task outcomes and `/memory outcomes` retain exit codes, scope, freshness and a bounded freshness reason, without storing output or fingerprints. Human acceptance still starts unknown. Legacy outcomes remain readable, are labeled as legacy, and missing freshness stays unavailable.

`verification.scopes` is optional and project-local. Each check may declare literal relative `inputs` (files/directories, recursively; `.` means the project root) and optional `exclude` paths/subtrees. No globs, absolute paths, traversal, or fully excluded input roots; each list has at most 32 paths, each path at most 256 UTF-8 bytes, and each declaration at most 2 KiB. **No declaration means unavailable freshness and no reuse, not a command failure.** `.gitignore` is not an input contract: ignored files inside a declared scope are included unless explicitly excluded. Generated artifacts/coverage outside the input scope or explicitly excluded from it do not make a successful check stale.

Freshness is observed before/after each check and at report time; checks also refresh earlier evidence so one check cannot silently invalidate another. Observed native edit/write paths invalidate matching declared scopes even if later work restores directory membership, including edits overlapping a check. Native path syntax is expanded once before matching filesystem identities (including file URLs, tilde paths and aliases); an actual `@`-prefixed filename is not stripped again. Declared input roots are resolved too, including case aliases on case-insensitive filesystems, while exclusions retain the scope observer's traversal spelling. Observed included symlink entries also invalidate evidence, even when their targets are excluded or outside the scope and the links are later removed. Excluded links do not hide writes to included targets. Failed native writes conservatively invalidate possible partial changes without claiming a completed edit; missing targets retain their path beneath the nearest existing canonical parent. Possible case/Unicode aliases of the first missing entry (including a named input's parent) invalidate conservatively, and a missing suffix cannot establish an exclusion's traversal spelling. This may cause extra executions for ambiguous absent names even on case-sensitive filesystems; resolved prefixes and literal exclusions are not case-folded. Unresolvable or over-budget path observations conservatively invalidate scoped evidence. Resolved observations with neither an included target nor included symlink traversal do not invalidate other scopes, and observations do not select additional checks. Included file bytes/metadata and directory membership/modes are fingerprinted; named input creation/deletion invalidates previous evidence. Directory timestamps caused by excluded outputs do not affect the fingerprint. Included symlinks (including parents of named paths), special files, I/O errors, or limits (1 MiB/file, 16 MiB total, 4,096 work items, 500 ms checked between I/O operations) disable reuse with a specific reason. An unavailable before/after observation cannot later become a fresh check merely because the final observation succeeds.

**Declared scope is an assumption, not discovered dependency coverage.** For example, the sample above does not observe installed `node_modules`, environment variables, external tools or services. A lockfile does not prove installed dependencies are unchanged. If a check depends on excluded/unlisted inputs, changes there can go undetected: include them or leave the scope undeclared to disable reuse. Even a fresh scoped result does not certify behavior. These bounded observations are not atomic snapshots, a sandbox, or a guarantee against transient changes during commands or edits after reporting. See [`docs/CODING_LOOP_EVIDENCE_CONTRACT.md`](docs/CODING_LOOP_EVIDENCE_CONTRACT.md) for this slice's regressions, measurements, and remaining work.

One-shot exit codes: **0** selected commands passed (execution only, even if freshness is stale/unavailable), **1** failed/blocked, **2** incomplete (skips or no commands). Timeouts and cancellation terminate verifier process groups on POSIX; Windows terminates verified descendants through OS parentage, which has no real-host gate yet. One-shot SIGINT and any SIGTERM cancel checks and prevent further repair; the CLI gives cleanup up to one second, then exits even if runtime startup/abort is stalled. Interactive Ctrl-C cancels the active task while keeping the session; it drains existing cleanup without a forced per-task deadline. Programmatic `app.close()` drains runtime startup and verification before disposal but has no forced-exit deadline. Command timeouts do not bound model response time. Commands and runtime tools are not sandboxed, and command output may contain secrets—review your checks before sending their output to a model.

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

**From source:** Bun on your PATH and this checkout's dependencies are required. **Compiled releases:** Bun and dependencies are embedded; neither a Bun installation nor a checkout is required. Model tasks need supported provider authentication; local help and project inspection do not.

In practice, that means you need working model authentication available to Pi, for example through:
- supported environment variables such as `ANTHROPIC_API_KEY`, or
- Pi's stored auth/config

In an interactive terminal, `/login` offers **OpenAI Codex**, **GitHub Copilot**, **Anthropic/Claude** and **OpenRouter**. Exact `/login <provider-id>` skips only the provider chooser. Codex and Copilot use device codes; Claude and OpenRouter offer private API-key entry or browser authorization. Casper never opens a browser automatically or accepts account passwords. Keys and callback URLs/codes belong only in the dedicated hidden login prompt, never chat or command arguments.

Fresh consent discloses replacement of the selected provider in the resolved Pi/Casper shared `auth.json`. Copilot login may enable account model policies; Claude browser sign-in is documented by Pi as billed extra usage, and OpenRouter browser sign-in creates a permanent key billed from credits. Cancellation cannot undo remote changes. Other provider entries and model defaults are preserved. Browser callbacks are loopback-only; GitHub Enterprise hosts are not included. Plain/redirected terminals show local guidance only. Select models afterward with `/model`; local credential availability is not a connection test. See [login review](docs/MULTI_PROVIDER_LOGIN_REVIEW.md) for validation and limits.

## Install

macOS and Linux — one line:

```bash
curl -fsSL https://github.com/Choaterboater/casper/releases/download/v0.1.6/install.sh | sh
```

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://github.com/Choaterboater/casper/releases/download/v0.1.6/install.ps1 | iex"
```

These commands target the planned **v0.1.6 preview** and will resolve only after it
is published. Re-running reinstalls that version in place; a later preview needs
its own release URL. GitHub's `latest/download` route excludes prereleases. It downloads one self-contained executable for your platform, verifies its
SHA-256 against the release's `SHA256SUMS`, installs it to `~/.local/bin/casper`
(`%LOCALAPPDATA%\Programs\casper` on Windows), clears the macOS quarantine flag, and
runs the staged executable's `--version` successfully before replacing an existing installation. **No sudo, no Bun
and no checkout are required on the target machine** — Bun and every dependency are
embedded in the binary.

Installer defaults now target `Choaterboater/casper` at tag `v0.1.6`; the repository
and release have not yet been published. Build with `bun run build:release -- --all`
and upload **every file** in `dist/release/`: all binaries, `SHA256SUMS`, `VERSION`
and both installers. Binaries belong in release assets, not the Git source history.
See [release process](docs/RELEASE.md).

Verification is not optional: if no digest can be obtained, or the digest does not
match, the installer refuses to install and deletes the download. Downloads use a
temporary directory that is cleaned afterward; installation needs no administrator access.

Useful installer options (`sh scripts/install.sh --help`):

```bash
--dir <path>            # install somewhere else
--version 0.1.6         # require this exact installed version
--sha256 <hex>          # verify out of band when SHA256SUMS is unreachable
--force                 # replace a symlink that leaves the install dir (a development link)
```

Offline or internal installs work by pointing at a directory instead of a URL:

```bash
CASPER_BASE_URL=/path/to/dist/release sh scripts/install.sh
```

### From source (development checkout)

```bash
bun install --frozen-lockfile
chmod +x src/cli.ts
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/src/cli.ts" "$HOME/.local/bin/casper"
```

Ensure `~/.local/bin` is on your PATH. The link follows this checkout, so code updates take effect immediately; moving or deleting the checkout breaks the link. This is a local development installation, not a bundled release. `casper --version` prints `casper <version> (<path>)`, where the path is the `cli.ts` (or compiled binary) that actually ran, so a stale link is visible in one command. The installer refuses to overwrite a link that leaves the install directory unless you pass `--force`; a link into a `.scratch/` checkout is reported and never replaced.

## Run

Interactive (offers `casper_check`; see [Verification and repair](#verification-and-repair)):

```bash
casper
casper --no-verify   # without the managed check tool
```

One-shot prompt:

```bash
casper "Summarize this repository"
```

Help and the running location:

```bash
casper --help
casper --version     # casper 0.1.6 (/absolute/path/to/src/cli.ts or the binary)
```

You can still launch directly from this checkout with `bun run dev` if you do not want a PATH link.

`/help` shows the same concise help locally; `/help all` retains the full command/safety reference. Unknown slash commands are rejected without calling a model or recording a task outcome. `/exit` and `/quit` end interactive mode and are successful no-ops in one-shot mode.

### Interactive terminal

- Assistant messages render as Markdown (headings, lists, emphasis, inline code, fenced code, quotes, tables) through Pi's renderer; the in-progress message is re-rendered whole while it streams and committed once when it ends, so lists and fences stay correct across chunk boundaries. Links print their URL in parentheses rather than as hidden hyperlinks. `NO_COLOR` disables color; redirected output and `TERM=dumb` stay plain.
- Streamed output stays above the editable draft. Enter during active work retains the draft rather than queuing another request. Press Enter again once idle to submit it.
- Ctrl-C cancels active work while retaining the session and existing changes. At idle it clears a draft, or exits if empty. Editable-terminal confirmations use a fresh input field and restore the previous draft afterward; Ctrl-C/EOF deny approval. Piped line input discards unfinished fragments at approval transitions. With actual terminal input but `TERM=dumb` or redirected output, exact approval is denied because fresh keystrokes cannot be established safely. `NO_COLOR` alone does not disable approvals.
- Tool activity includes file/command targets, running/completed/failed states and elapsed time, plus bounded error previews. On a rich terminal the `• … — running` line is redrawn in place as `✓`/`✗` when that call finishes, so each tool call occupies one transcript line; any other output in between (assistant text, another tool, a prompt) commits the running line first. Common credentials are redacted from previews; this is not a general secret detector. Tool completion is not a verification pass.
- Interactive sessions offer the model a `casper_check` tool for the project's configured checks (typecheck, lint, test, build). Nothing runs until the model selects a check, and a selected check executes that repository's command, so this is execution consent rather than sandboxing; start with `casper --no-verify` in a repository whose commands you do not trust. One-shot prompts get the tool only with `--verify`. The task receipt says when no Casper verification was recorded.
- The `/` command popup, pickers and the login notice are drawn over the bottom of the transcript, never appended: opening or closing them does not scroll the terminal or leave blank rows. Only a width change or Ctrl+L repaints from the top.
- `/status` shows integration/storage information and host-reported selected provider/model, reasoning level, local credential availability, selection source, and Casper default. Before lazy runtime startup it explicitly says model/auth are not initialized/checked. Credentials configured is **not** a connection test. No defaults or credentials are changed by status.
- `/model` opens Pi's searchable picker inside Casper. **Enter remembers globally** in `~/.casper/settings.json`; **Ctrl+S is session-only**. Escape/Ctrl-C cancel. `/model <id or provider/id>` remembers an exact unique selection; `/model --session [model]` opts out. Plain/redirected terminals and `TERM=dumb` list models; use an exact ID to select.
- `/effort` opens supported reasoning levels; `/effort high [--session]` is the shortcut. Type `/` for fuzzy command discovery, use Tab for completion and `@` for file-path suggestions. Shift+Enter where supported or Ctrl+J inserts a newline.
- `/context` and `/usage` show runtime estimates without inventing billing. `/compact` explicitly invokes model-assisted summarization. `/clear` starts a new conversation, not a file rollback; `/resume [exact-id]` lists/restores conversations in this workspace. `/diff` shows bounded Git changes; `/permissions` explains actual boundaries.
- `/output [n]` prints the full retained output of the last model task's n-th most recent tool call (default 1: tool name, target, status, and the runtime-bounded text). At most 20 calls are retained per task; out-of-range `n` is a usage error.
- Restored conversations retain their recorded model; fresh ones use the Casper default. Without either, choose with `/model`. Missing auth or an unavailable recorded model blocks sending—there is no implicit Pi-default or provider fallback. Selection itself generates no model response; the next request sends conversation context to the selected provider. The picker refreshes local catalogs only, although provider-defined credential checks can run configured key-resolution programs.

The main-screen Pi renderer retains normal terminal scrollback. The prompt box keeps a fixed gutter (`❯` idle, `…` working, `?` awaiting approval) so it never shifts between states. The `/` command popup, the `/model` and `/effort` pickers and the login notice are composited over the bottom of the transcript rather than appended, so opening and closing them never scrolls the terminal or leaves blank rows; pickers and login run inside the live surface without a screen clear. Only a width change and Ctrl+L repaint from the top (clearing the visible screen and scrollback); a rows-only resize keeps scrollback and just realigns the viewport. The persistent footer shows a state dot, the startup-default snapshot or active model, effort, context, runtime tokens and activity; `/status` refreshes the branch snapshot. Unknown usage/cost stays unknown. No permission/verification guarantee is implied by the footer. Plain output remains line-oriented. Delegation and learning retain their separately documented global Pi defaults. See [the terminal guide and offline demo](docs/TERMINAL_UX.md) and [validation](docs/DAILY_TERMINAL_REVIEW.md).

## Checks

Typecheck:

```bash
bun run typecheck
```

Tests (serial fallback; POSIX terminal tests also require `python3` for its standard-library PTY support):

```bash
bun test
```

Parallel tests (four isolated Bun processes, one test file per process):

```bash
bun run test:fast
```

The runner prints each file's diagnostics together and a file-level summary;
any failed file makes the command fail. `bunfig.toml` scopes discovery to `tests/`
so evaluation fixtures under `evals/fixtures/` keep their own test files without
joining this suite. POSIX-only fixtures (Python 3 PTY drivers, symlinks, FIFOs, POSIX mode bits, process groups and
signals, native shell commands the product parses) declare an explicit skip through
`tests/support/platform.ts` instead of failing on a host that cannot run them, and a
fixture's configured check runs the runtime against
`tests/fixtures/check-script.ts` rather than a POSIX shell pipeline. These rewritten
fixtures still need Windows/Linux host runs; portability by construction is not validation.
POSIX assertions are unchanged. See
[platform verification](docs/PLATFORM_VERIFICATION.md) for the per-suite list and
what a Windows run still does not cover.

Parallel testing remains opt-in. The historical SIGTERM cleanup-test flake was
reproduced as an interrupted-sleep marker race; corrected fixtures now also check
TERM-resistant descendants with inherited and closed pipes. See
[`docs/VERIFIER_SHUTDOWN_REVIEW.md`](docs/VERIFIER_SHUTDOWN_REVIEW.md) for diagnosis,
fault-injection evidence and limits. No cleanup assertion or deadline was relaxed;
the default combined check retains serial execution.

Combined check (typecheck + serial tests):

```bash
bun run check
```

## Evaluation suite

Casper's own tests for agent behavior (master plan §48): twelve tasks over nine
dependency-free fixture repositories, measured by task success, independent
verification success, model responses, files touched, repair attempts, tokens and
wall clock. Fixtures are the solved baseline; a per-task setup overlay creates the
unsolved state, and `tests/eval-suite.test.ts` asserts both directions without a
model.

```bash
bun tools/eval.ts --list                                   # task ids
bun tools/eval.ts                                          # every task (uses the configured model)
bun tools/eval.ts --repeat 3 --json /tmp/eval.json         # each task 3x on fresh work directories; pass rate, median/min/max wall clock
bun tools/eval.ts --model github-copilot/claude-fable-5.1  # select the model for this run only (never writes ~/.casper/settings.json)
```

A real run uses the configured provider, so provider billing is the user's; Casper
state is isolated to a temporary home so runs stay comparable. Contract, metrics,
grading and limits: [`docs/EVALUATION.md`](docs/EVALUATION.md).
