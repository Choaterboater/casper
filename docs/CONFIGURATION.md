# Configuration and skills

Casper reads these optional files:

```text
~/.casper/config.yaml
~/.casper/profiles/<profile>/config.yaml
~/.casper/profiles/<profile>/rules.md
<project>/.casper/project.yaml
<project>/.casper/rules.md
```

The two project files are repository-controlled: each must resolve (after symlinks) to a
regular file inside the project, and is capped at 256 KiB (`project.yaml`) or 64 KiB
(`rules.md`). A symlink leaving the project, a special file or an oversized file stops
configuration loading with an error naming the file. User and profile files may link anywhere.

Profile selection precedence is the programmatic `profileName` option → `CASPER_PROFILE` → project `profile:` → global `profile:` → `default`. Names must be 1–64 ASCII letters, digits, underscores, dots or hyphens, starting with a letter or digit. Every supplied selection is validated, even if overridden; malformed values (including empty strings, surrounding whitespace and non-string YAML values) stop configuration loading. Policy precedence is safe defaults → global → selected profile → project.

**Profile trust:** project-local `profile:` is intentionally allowed to select an existing user profile, including its rules, MCP/LSP definitions and reference sources. Inspect an unfamiliar repository's `.casper/project.yaml` before running Casper: selecting a profile can expose configured reference excerpts to model tasks. MCP/LSP discovery remains metadata-only and connection still requires explicit consent. Name validation prevents lexical traversal; it does not confine user-owned profile symlinks or sandbox native tools. Direct MCP/LSP/reference discovery skips invalid profile names rather than loading a profile file.

Casper detects check commands from the repository. For Python it reads `pyproject.toml` and every
`requirements*.txt` (pytest, ruff, mypy), and runs the tools through uv (`uv.lock`), poetry (`poetry.lock`
or `[tool.poetry]`), the project's `.venv`/`venv` interpreter, or the system `python3`, always as
`python -m tool` outside uv and poetry. When `[tool.mypy]` lists `files`, the check is bare `mypy`, which
checks exactly those. Project model fields can be overridden in `.casper/project.yaml`. The `commands:` map (also supported under `project.commands`) admits only string values for `typecheck`, `lint`, `test` and `build`; unknown keys and non-string values are ignored rather than passed into the project model or prompts. Project-local `verify:` overrides these commands and retains stricter validation:

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

Policy values are checked in every file: a value outside its allowed set (for example
`git.push: nevr`, or the string `"false"` for a boolean) stops configuration loading
with an error naming the file, the key and the allowed values. Unknown top-level keys
and unknown keys in the policy sections (`behavior`, `code`, `git`, `workspace`) are
shown as `[config]` warnings at startup and otherwise ignored.

The project file may also declare managed services under `services:` (the command, port,
readiness, deadline, scope and literal environment of each development server Casper may
run). Services are project-only, and invalid values stop loading with their dotted path. See
[SERVICES.md](SERVICES.md).

## Environment variables

| Variable | Meaning |
| --- | --- |
| `CASPER_AGENT_DIR` | Credentials, model catalog, engine resources and transcripts. Defaults to `~/.casper/agent`. Relative paths resolve from the launch directory; `~/` expands to HOME. An explicit directory never receives the legacy import. |
| `CASPER_OFFLINE` | Set to `1` to disable provider catalog fetches and automatic sign-in browser launches. Cached models remain available. This is **not** a network sandbox: requested model calls and authentication still use the network. |
| `CASPER_TELEMETRY` | Set to `0` to send no OpenRouter app attribution (`HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`, `X-OpenRouter-App-Visibility`) on model requests and key checks; the bundled engine's own attribution is turned off with it. Mirrors Pi's `PI_TELEMETRY`: unset keeps attribution, and when set only `1`, `true` or `yes` keep it. An inherited `PI_TELEMETRY` is ignored. |
| `CASPER_OAUTH_CALLBACK_HOST` | Browser sign-in callback bind host; defaults to `127.0.0.1`. Casper refuses browser sign-in for any other value. |
| `CASPER_TUI_WRITE_LOG` | Optional raw terminal-output log file, or an existing directory for timestamped logs. Can contain sensitive output; login is refused while logging is enabled. |
| `CASPER_PROFILE` | Profile selection; precedence and name rules are described above. |

Set these in your shell, not a repository `.env` (the source launcher ignores it).
Casper forwards the five engine settings to the matching `PI_*` variables internally at
startup. Their inherited `PI_*` values are not fallbacks; a conflicting
`PI_CODING_AGENT_DIR` produces a `[config]` warning with the other startup warnings (on
stderr with `--json`, never on its stdout) without reading or writing that directory.
Use `CASPER_AGENT_DIR` for an intentional override. `--version`, `--help` and `--licenses`
return before this setup, create no state and perform no legacy import.

## Provider credentials

Engine state — provider credentials (`auth.json`) and the provider catalog
(`models.json`) — lives in Casper's own store, `~/.casper/agent/`, mode 0700.
No Pi installation is required. On first run with the default store, an existing Pi CLI
installation's API keys (from `auth.json`) and `models.json` are imported once by
copy (the originals stay untouched). OAuth sign-ins are not copied: their refresh
tokens rotate, so a shared copy would let Pi and Casper sign each other out.
Casper names those providers once on stderr; run `/login <provider>` to give
Casper its own sign-in. The two stores are separate after the import.
`CASPER_AGENT_DIR` selects a different Casper store; inherited `PI_CODING_AGENT_DIR`
never selects it. Login writes only the consented provider's credential into that store.

A repository's own Pi project directory is never trusted: `<project>/.pi/`
extensions (executable code), `SYSTEM.md`, `APPEND_SYSTEM.md`, prompt templates,
themes and `settings.json` are not loaded, with or without a model configured.
User-level resources in the engine store (for example `~/.casper/agent/extensions/`)
still load. Project `AGENTS.md`/`CLAUDE.md` context files are still sent to the model,
except one that is a symlink resolving outside the project, which is skipped.

Requests Casper itself sends to OpenRouter — model traffic and API-key
verification — carry app-attribution headers (`HTTP-Referer`,
`X-OpenRouter-Title: Casper`, `X-OpenRouter-Categories: cli-agent`, and
`X-OpenRouter-App-Visibility: hidden`), so the usage is filed under Casper's own
OpenRouter app and analytics instead of under the runtime Casper is built on.
`hidden` keeps an early-preview app out of the public rankings, marketplace, and app
pages; it does not disable attribution. OpenRouter honors that header only when the
request creates a brand-new app. This is static app identity only: it adds no prompt,
file, workspace, user, or credential data to a request, and no other provider
receives it. `PI_TELEMETRY` governs the runtime's own attribution; Casper's identity
headers are sent regardless.

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
configured effort even after role mappings change. Pi CLI and project-local
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

Skills are optional procedures, not a substitute for the repository. Frontend, design, and other domain work use the detected tree (`ui`, `styles`, `design` in the project context) instead of a skill pack. Only selected bodies are read and injected, with their source and base directory. Duplicate names remain inspectable with distinct IDs; selection includes only one per name. Higher relevance wins, then project → user → external, then stable ID. Limits: 16 KiB frontmatter, 256 KiB per skill file, and 64 KiB combined bodies per prompt. Invalid/oversized skills produce diagnostics rather than blocking startup.

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
