# Casper Implementation Plan

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
