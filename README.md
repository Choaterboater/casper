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

## Current scope (Phases 0–1)

- Bun + TypeScript CLI with a pinned Pi runtime dependency
- thin `AgentRuntime` / `PiRuntime` seam
- compact Casper banner and streamed runtime output
- Git root and branch inspection
- deterministic language, framework, package-manager, and command detection
- cached project models under `~/.casper/projects/`
- global, profile, and project policy loading with safe precedence
- selected profiles and profile/project rules
- deterministic task classification and relevant command context
- `/project` summary in interactive mode

Not implemented yet: skills, verification/repair, MCP, LSP, visualization, memory, or subagents.

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
