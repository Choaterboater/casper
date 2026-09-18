# Casper

Casper is a standalone coding companion CLI built as its own project.

For Phase 0, Casper uses Pi as a pinned runtime dependency through a thin adapter layer:

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

## Phase 0 includes

- Bun + TypeScript project
- pinned Pi dependency
- `AgentRuntime` interface
- `PiRuntime` implementation
- `casper` CLI
- compact Casper ghost/banner
- current project root detection
- Git branch detection when available
- Pi-backed session startup
- response streaming through Casper output
- read/edit/run-code capability in the current repo through Pi tools
- one end-to-end integration test

## Phase 0 does not include

- profiles
- project config
- verification / repair loop
- MCP
- LSP
- MindMesh
- memory
- subagents
- advanced TUI

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
