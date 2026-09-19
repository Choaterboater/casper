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

## Current scope (Phases 0–3)

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
- explicit local checks, bounded model-assisted repair, and opt-in post-task verification

Not implemented yet: MCP, LSP, visualization, memory, or subagents.

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
bun run src/cli.ts --verify "Fix the login flow"  # post-task checks and bounded repair
```

The same `/verify` commands work interactively. `--verify` with no prompt enables post-task verification for the interactive session. Without this flag, normal prompts retain their existing behavior; Casper does not automatically execute verifier commands. Pi can still use its normal shell tools. The flag and `/verify` are **explicit execution consent, not sandboxing or persisted repository trust**. Use them only in repositories whose commands you trust. Repair also authorizes model edits.

Project `.casper/project.yaml` can specify canonical checks:

```yaml
verify:
  typecheck: bun run typecheck
  lint: bun run lint
  test: bun test
  build: bun run build
verification:
  timeoutMs: 120000 # per command; default 2 minutes, maximum 1 hour
repair:
  maxAttempts: 3   # repair prompts, not initial verification; 0 disables repair, max 10
```

`verify:` is project-local and overrides `commands:` and detected commands by check name. Only nonempty typecheck/lint/test/build commands are accepted. Timeout and repair settings also work in global/profile configuration, with project settings taking precedence. Commands are loaded at startup and frozen during repair; restart after changing configuration or manifests.

Checks run sequentially at the project root using the platform shell and inherited environment. No dependency installation or missing-tool fallback is attempted. Absent commands are visible **skips**, never passes; an unavailable configured executable is a failure. Defaults run typecheck → lint → test → build. Post-task selection uses the existing lexical task classifier: test tasks select test; fix/implement/refactor/configure select all four; read/general/document tasks select none. Use explicit `/verify` when that heuristic is insufficient.

Failures send the exact command, bounded output, exit status, available Git changed-file context, original request, and constraints through `AgentRuntime`. Automatic post-task repair preserves that task's request; explicit `/verify repair` uses the objective of making the selected checks pass, not an unrelated earlier prompt. Failed checks rerun first; after they pass, the full selected suite runs again to catch regressions. The model saying “done” is not a passing result. Up to three repair prompts run by default. Passing selected checks does not imply unselected checks passed.

The terminal shows concise results, not full logs. Programmatic `CasperApp.runOnce()` returns a `VerificationReport` for verification runs, including all rounds. Evidence includes cwd, command, status, exit code/signal, duration, stdout/stderr, failure reason, and truncation. Each stream retains at most 8 KiB of original bytes (head/tail plus a truncation marker); this bounded evidence is what repair receives. No evidence database or unbounded raw-log artifact is created.

One-shot exit codes: **0** passed, **1** failed/blocked, **2** incomplete (one or more skips). Timeouts and cancellation terminate verifier process groups on POSIX; Windows only has direct-process cleanup and has not been validated. SIGINT/SIGTERM cancel checks and prevent further repair; the CLI gives cleanup up to one second, then exits even if runtime startup/abort is stalled. Programmatic `app.close()` drains runtime startup and verification before disposal but has no forced-exit deadline. Command timeouts do not bound model response time. Commands and runtime tools are not sandboxed, and command output may contain secrets—review your checks before sending their failure evidence to a model.

See [`docs/PHASE3_VERIFICATION.md`](docs/PHASE3_VERIFICATION.md) for validation and the live failure → repair → rerun smoke, and [`docs/PHASE3_REVIEW.md`](docs/PHASE3_REVIEW.md) for pre-commit review/debugging/performance findings.

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
