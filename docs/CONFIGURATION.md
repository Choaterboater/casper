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

## Model roles and automatic effort

The normal path remains `/model` → describe the task. Roles are optional shortcuts,
not required profiles or an automatic keyword-based model switcher.

```text
/model role fast provider/small-model
/model role review provider/reasoning-model:high
/model roles
/model --session @review
/model @review:auto
/effort auto
/effort high --session
Shift+Tab          # cycle auto and supported levels; this conversation only
/model role review clear
```

`fast`, `build`, `reason`, and `review` accept exact catalog IDs, `provider/id`,
`@default`, or another configured role, optionally suffixed with effort. Qualified
IDs win over bare IDs; literal IDs containing colons win over suffix parsing.
Ambiguous IDs, missing aliases, cycles and unsupported fixed effort fail.
An outer explicit suffix overrides a role's suffix. `max` is available only when
the selected model supports it; automatic effort never selects `off` or `max`.

Casper owns `~/.casper/settings.json`: concrete startup defaults and per-model
effort, optional `modelRoles`, and `autoEffortModels` (qualified model IDs).
Role changes do not select a model or send a request. `/model` saves a concrete
default unless `--session` precedes the selector; `/effort` saves its preference
unless `--session` follows the level. Shift+Tab cycles the same choices, including
`auto`, for the current conversation only and does not save. Explicit suffixes take precedence, then
the current branch's remembered per-model preference, then the saved per-model
preference. Existing conversations and forks retain their concrete model and
configured effort even after role mappings change. Shared Pi and project-local
Pi model preferences are neither inherited nor rewritten.

Cancelling model selection before activation leaves the prior choice intact. If
Pi has already activated the model while a selection extension is finishing,
Casper retains that actual model/effort in the conversation and on resume; late
cancellation still prevents the pending save to startup defaults.

**Automatic effort is opt-in and makes an extra provider request per prompt.**
It uses the configured `fast` role, otherwise the selected model, to classify
only the current raw request (up to 8 KiB UTF-8); no history, injected skills,
project context or tools are included in that classification. A user request may
itself contain sensitive text. Configuring `fast` may send this bounded request
to a different provider. The selected generation model does not change.

The classifier has a four-second deadline, a 128-output-token limit and no
retries. It chooses low/medium/high/xhigh, constrained to supported levels.
Failure visibly retains the last resolved level (initially supported high);
models without controllable reasoning skip classification. Cancellation prevents
generation and late classification results cannot change effort. The automatic
result never replaces the saved preference. Selecting fixed effort disables
automatic classification for that model/conversation.

Status/footer distinguish configured `auto` from actual effort and show pending,
classified, fallback or unavailable. `/usage` reports classifier usage separately
for the currently loaded session instance; reloading does not restore those
counters. Received usage is retained even when a malformed or truncated classifier
answer causes fallback. Transport failures may consume unreported tokens; that
missing usage stays unknown. Estimates are not bills. Explorer children use `fast`, reviewers use `review`, and unset roles use
the Casper startup default; see [DELEGATION.md](DELEGATION.md).

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
