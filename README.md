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

## Current scope (Phases 0–2)

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

Not implemented yet: verification/repair, MCP, LSP, visualization, memory, or subagents.

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
