# Configuration and skills

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
