# Configuration and skills

**What this is:** the files and settings that change how Casper behaves: config files, profiles,
environment variables, sign-in storage, model roles and skills.
**When you'd use it:** you want to set your check commands, keep separate setups (profiles), pick
a model per job, run Casper from a different state folder, or add your own skills. Every file here
is optional; Casper works with none of them.

## Config files

Casper reads these files if they exist:

```text
~/.casper/config.yaml                     # your global settings
~/.casper/profiles/<profile>/config.yaml  # settings for one profile
~/.casper/profiles/<profile>/rules.md     # extra instructions for the model, per profile
<project>/.casper/project.yaml            # settings for one repository
<project>/.casper/rules.md                # extra instructions for the model, per repository
```

Casper also keeps its own files, which you normally do not edit by hand:
`~/.casper/settings.json` (default model, effort and model roles; see
[Model roles](#model-roles-and-automatic-effort)), `~/.casper/skills-trust.json` (skill review
decisions), `~/.casper/agent/` (sign-ins and conversations; see
[Provider credentials](#provider-credentials)) and `~/.casper/projects/` (per-project state).

**Which file wins.** Settings apply in this order, later ones winning: safe defaults → global →
selected profile → project. So a repository's `.casper/project.yaml` can override your global
settings for that repository.

**Project files are limited.** The two project files come from the repository, so each must
resolve (after symlinks) to a regular file inside the project, and is capped at 256 KiB
(`project.yaml`) or 64 KiB (`rules.md`). A symlink leaving the project, a special file or an
oversized file stops configuration loading with an error naming the file. Your user and profile
files may link anywhere.

**Mistakes are reported.** A value outside its allowed set (for example `git.push: nevr`, or the
string `"false"` for a true/false setting) stops configuration loading with an error naming the
file, the key and the allowed values. An unknown top-level key, or an unknown key in a policy
section (`behavior`, `code`, `git`, `workspace`), is shown as a `[config]` warning at startup and
otherwise ignored.

### Profiles

A profile is a named set of settings in `~/.casper/profiles/<name>/` (for example one for work
and one for a lab). Casper picks the profile from the first of these that is set:

1. the programmatic `profileName` option (for programs that embed Casper);
2. the `CASPER_PROFILE` environment variable;
3. `profile:` in the project's `.casper/project.yaml`;
4. `profile:` in `~/.casper/config.yaml`;
5. otherwise `default`.

Names must be 1–64 ASCII letters, digits, underscores, dots or hyphens, starting with a letter or
digit. Every value given is checked, even one a higher source overrides; a bad value (including
an empty string, surrounding spaces, or a YAML value that is not a string) stops configuration
loading.

**Profile trust.** A repository's `profile:` may select one of your existing profiles, including
its rules, MCP/LSP server definitions and reference sources. Look at an unfamiliar repository's
`.casper/project.yaml` before running Casper there: selecting a profile can send your configured
reference excerpts to the model during tasks. Casper only lists MCP and language servers from a
profile; connecting one still needs your explicit yes (an MCP server you said yes to before can
be remembered; see [MCP.md](MCP.md#remembered-servers)). Name checks stop `../` tricks in the name;
they do not stop a profile folder you made a symlink, and they do not sandbox the model's tools.
MCP, LSP and reference lookups skip a bad profile name instead of loading a file for it.

## Project settings

`.casper/project.yaml` describes one repository. Everything is optional:

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

- `languages`, `frameworks`, `packageManager`, `architecture` (a map of names to text) and
  `conventions` (a list of text) replace what Casper detects about the project.
- `commands:` sets check commands. It accepts only text values for `typecheck`, `lint`, `test`
  and `build`; other keys and non-text values are ignored, never passed to the model.
- These project fields may also sit under a `project:` block. If a `project:` block exists, Casper
  reads these fields only from it and ignores the top-level copies.
- `verify:` also sets check commands, wins over `commands:`, and is checked more strictly (a bad
  entry stops loading). It and the other check settings (`verification:`, `repair:`) are described
  in [VERIFICATION.md](VERIFICATION.md#configuration).
- `services:` declares managed services: the command, port, readiness check, deadline, scope and
  literal environment of each development server Casper may run. `smoke:` declares HTTP checks
  against them. Both are project-only (they are an error in a global or profile file), and invalid
  values stop loading with their dotted path. See [SERVICES.md](SERVICES.md) and
  [VERIFICATION.md](VERIFICATION.md#smoke-checks).
- `visualize:` controls diagrams; see [VISUALIZATION.md](VISUALIZATION.md).

### Detected check commands

When no `verify:` or `commands:` entry sets a check, Casper looks for one in the repository:

| Project | What Casper runs |
|---|---|
| Node (`package.json`) | The `test`, `lint`, `build` scripts, and `typecheck`, `check-types` or `tsc` for typecheck, run with the package manager (`bun run test`, `npm run test`, …). The package manager comes from `packageManager` in `package.json`, else the lockfile, else npm. |
| Python (`pyproject.toml` or any `requirements*.txt`) | `pytest`, `ruff check .` and `mypy .` when those names appear in those files; bare `mypy` when `[tool.mypy]` lists `files`. A build (`python -m build`, `uv build`, `poetry build`) when `pyproject.toml` has `[build-system]`. |
| Rust (`Cargo.toml`) | `cargo test`, `cargo clippy`, `cargo build` |
| Go (`go.mod`) | `go test ./...`, `go build ./...` |

Python tools run through uv (`uv.lock`: `uv run pytest`), poetry (`poetry.lock` or
`[tool.poetry]`: `poetry run pytest`), else the project's `.venv` or `venv` interpreter
(`.venv/bin/python -m pytest`), else the system `python3` (`python` on Windows), always as
`python -m tool` outside uv and poetry.

`/project` shows the commands Casper found.

### Policy

Policy settings shape how the model works. They can go under `policy:` or at the top level
(`behavior:`, `code:`, `git:`, `workspace:`); in the same file, the `policy:` copy wins.

| Key | Values | Default |
|---|---|---|
| `behavior.autonomy` | `low`, `medium`, `high` | `high` |
| `behavior.askQuestions` | `beforeChanges`, `onlyWhenBlocked` | `onlyWhenBlocked` |
| `behavior.inspectBeforeEditing` | `true`, `false` | `true` |
| `code.reuseExistingPatterns`, `code.preserveArchitecture`, `code.avoidOverengineering`, `code.avoidUnnecessaryDependencies`, `code.preferSmallChanges` | `true`, `false` | `true` |
| `git.commit`, `git.push` | `never`, `neverUnlessRequested` | `neverUnlessRequested` |
| `git.confirmDestructive` | always `true` | `true` (no file can turn it off) |
| `workspace.isolateWhen.parallelAgents`, `.riskyRefactor`, `.experimentalBranch` | `true`, `false` | `true` |

**What policy really does.** Most of these are instructions in the model's prompt, not blocks:
the model's bash can still run `git commit`, `git push` or `rm`. Two things are enforced by
Casper itself:

- `askQuestions: beforeChanges`: in an interactive rich terminal, when a build or configure
  request does not name a clear target, the model must ask you once before its first edit.
- The model's bash may not run `git stash` (other than `list`/`show`), `git reset --hard`,
  `git checkout --`/`.`/`-f`, `git restore` of the working tree, `git switch -f` or `git clean`
  (other than `-n`), because each can set aside or throw away your uncommitted work. This is a
  check of the command text, not a sandbox. It applies whatever the policy says.

## The shell sandbox

New in v0.2.17. The shell sandbox (see [SECURITY.md](SECURITY.md)) is
set only in your own files (`~/.casper/config.yaml` or a profile):

```yaml
sandbox:
  allowedDomains: [api.mist.com, "*.central.arubanetworks.com"]  # reached without asking
  allowWrite: [~/shared-build-cache]                              # more folders commands may write
  allowUnixSockets: [/var/run/docker.sock]                        # macOS only; Linux can't filter by path
shell:
  keepEnv: [OPENAI_API_KEY]   # an AI provider key your own tests need
```

`sandbox: off` turns it off for every run (like `--no-sandbox` for one run); the receipt then
says shell commands and checks were not sandboxed. A project's `.casper/project.yaml` can only
add denies:

```yaml
sandbox:
  denyRead: [secrets, ~/work/deploy-key]
  denyWrite: [docs/released]
```

Any other `sandbox` or `shell` key in a project file is named at startup and ignored, and a repo's
`.pi/sandbox.json` is never read.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `CASPER_AGENT_DIR` | Folder for sign-ins, the model catalog, engine resources and conversations. Defaults to `~/.casper/agent`. Relative paths resolve from the folder you start Casper in; `~/` expands to your home folder. A folder you set here never receives the one-time import from Pi. |
| `CASPER_OFFLINE` | Set to `1` to stop provider catalog downloads and automatic sign-in browser launches. Cached models remain available. This is **not** a network block: model calls and sign-in still use the network. |
| `CASPER_TELEMETRY` | Set to `0` to send no OpenRouter app attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`, `X-OpenRouter-App-Visibility`) on model requests and key checks; the bundled engine's own attribution is turned off with it. Works like Pi's `PI_TELEMETRY`: unset keeps attribution, and when set only `1`, `true` or `yes` keep it. An inherited `PI_TELEMETRY` is ignored. |
| `CASPER_OAUTH_CALLBACK_HOST` | Address the browser sign-in listens on; defaults to `127.0.0.1`. Casper refuses browser sign-in for any other value. |
| `CASPER_TUI_WRITE_LOG` | Optional log file of raw terminal output, or an existing folder for timestamped logs. It can contain sensitive output, so `/login` is refused while it is set. |
| `CASPER_PROFILE` | Picks the profile; see [Profiles](#profiles). |
| `CASPER_BROWSER_EXECUTABLE` | Absolute path to the Chrome/Chromium/Edge program for browser tasks, instead of auto-detection. See [BROWSER.md](BROWSER.md). |
| `CASPER_NETCONAN` | `off` turns the extra netconan secret check off; a path picks the netconan program. See [SECRETS.md](SECRETS.md). |

Set these in your shell, not in a repository `.env` file (Casper does not read it). At startup
Casper copies five of them (`CASPER_AGENT_DIR`, `CASPER_OFFLINE`, `CASPER_TELEMETRY`,
`CASPER_OAUTH_CALLBACK_HOST`, `CASPER_TUI_WRITE_LOG`) to the matching `PI_*` settings the bundled
engine reads. Inherited `PI_*` values for these are not used as fallbacks. A different
`PI_CODING_AGENT_DIR` gives a `[config]` warning with the other startup warnings (on stderr with
`--json`, never on its stdout), and Casper neither reads nor writes that folder. Use
`CASPER_AGENT_DIR` to choose a folder on purpose. `--version`, `--help` and `--licenses` finish
before this setup: they create no state and import nothing.

## Provider credentials

**Where sign-ins live.** Provider credentials (`auth.json`) and the provider catalog
(`models.json`) live in Casper's own store, `~/.casper/agent/`, mode 0700 (only your user can read
it). No Pi installation is needed. `CASPER_AGENT_DIR` selects a different store; an inherited
`PI_CODING_AGENT_DIR` never does. `/login` writes only the provider you agreed to into that store.

**One-time import from Pi.** On first run with the default store, an existing Pi CLI install's API
keys (from `auth.json`) and `models.json` are copied once (the originals stay untouched). OAuth
sign-ins are not copied: their refresh tokens change on use, so a shared copy would let Pi and
Casper sign each other out. Casper names those providers once on stderr; run `/login <provider>` to
give Casper its own sign-in. The two stores are separate after the import.

**Repository Pi files are ignored.** A repository's own Pi project folder is never trusted:
`<project>/.pi/` extensions (program code), `SYSTEM.md`, `APPEND_SYSTEM.md`, prompt templates,
themes and `settings.json` are not loaded. User-level resources in the engine store (for example
`~/.casper/agent/extensions/`) still load. Project `AGENTS.md`/`CLAUDE.md` context files are still
sent to the model, except one that is a symlink pointing outside the project, which is skipped.

**OpenRouter app attribution.** Requests Casper itself sends to OpenRouter — model traffic, the
one-off calls for the checklist, reviews and automatic effort, and API-key checks — carry
app-attribution headers (`HTTP-Referer: https://choaterboater.github.io/casper/`, `X-OpenRouter-Title: Casper`,
`X-OpenRouter-Categories: cli-agent`, and `X-OpenRouter-App-Visibility: hidden`), so the usage is
filed under Casper's own OpenRouter app instead of the engine Casper is built on. `hidden` keeps an
early-preview app out of OpenRouter's public rankings and app pages; it does not turn attribution
off, and OpenRouter honors it only when the request creates a brand-new app. The headers are a
fixed app name only: they add no prompt, file, workspace, user or credential data, and no other
provider receives them. `CASPER_TELEMETRY=0` turns them off (along with the engine's own
attribution); `PI_TELEMETRY` has no effect. OpenRouter shows the icon of the referer's site, so the
referer is Casper's site (its ghost icon) rather than the GitHub page. OpenRouter keys apps by
referer, so after this change your usage may show under a new Casper app entry.

## Model roles and automatic effort

The normal path is still: pick a model with `/model`, then describe the task. Roles are optional
shortcuts for "the model I use for X". They do not switch models on their own based on keywords.

```text
/model role fast provider/small-model
/model role review provider/reasoning-model:high
/model roles
/model --session @review
/model @review:auto
/effort auto
/effort high --session
Shift+Tab          # cycle auto and supported levels; the level it stops at is remembered
/model role review clear
```

**Roles.** The four roles are `fast`, `build`, `reason` and `review`. Each accepts an exact catalog
ID, `provider/id`, `@default` (your saved default model), or another role, optionally followed by
`:effort`.

- `provider/id` wins over a bare ID; an ID that really contains a colon wins over reading the
  colon as an effort suffix.
- Ambiguous IDs, roles that are not set, and loops between roles are errors.
- An effort suffix you type (`@review:auto`) overrides the role's own suffix.
- An effort level a model lacks runs as the nearest level above it, else below (so `max` on a
  model without `max` runs at its highest level). Automatic effort never picks `off` or `max`.

Where roles are used: explorer subagents use `fast`, reviewer subagents and the
[acceptance check](VERIFICATION.md#independent-acceptance-check-experimental) use `review`, and
roles that are not set fall back to Casper's startup default. See [DELEGATION.md](DELEGATION.md).

**What is saved.** Casper owns `~/.casper/settings.json`: your default model and per-model effort,
optional `modelRoles`, and `autoEffortModels` (full model IDs).

- Changing a role does not select a model or send a request.
- `/model` saves a new default unless `--session` comes before the model name.
- `/effort` saves its choice unless `--session` comes after the level.
- Shift+Tab cycles the same choices, including `auto`, and saves the level it stops at, once, like
  `/effort`. The `--effort` command-line flag is for one run and never saves.
- Which effort applies: a suffix you typed, then this conversation's remembered choice for the
  model, then the saved choice for the model.
- Existing conversations and branches keep their model and effort even if you change roles later.
- Pi CLI and project-level Pi model settings are neither used nor changed.

Cancelling a model pick before it takes effect keeps your previous choice. If Pi has already
switched the model while a selection is finishing, Casper keeps that real model and effort in the
conversation and on resume; a late cancel still stops it being saved as the default.

**Automatic effort is opt-in and makes an extra provider request per prompt.** It uses the `fast`
role if set, otherwise the selected model, to rate only your current request (up to 8 KiB); no
history, skills, project context or tools are sent with it. Your request may itself contain
sensitive text, and if `fast` is a different provider, this short request goes to that provider.
The model doing the work does not change.

- The rating call has a four-second limit, a 128-token answer limit and no retries. It picks
  low, medium, high or xhigh, limited to what the model supports.
- On failure Casper says so and keeps the last level it used (at first, high or the nearest
  supported level). Models without adjustable reasoning skip the rating.
- Cancelling stops the task, and a late rating cannot change the effort. The automatic result
  never replaces your saved choice. Picking a fixed effort turns automatic rating off for that
  model and conversation.

The status line and footer show `auto` separately from the level actually used, and whether the
rating is pending, done, fell back or is unavailable. `/usage` reports rating calls separately,
for the current session only (reloading does not bring those counters back). Usage from a bad or
cut-off rating answer is still counted. A network failure may use tokens that are never reported;
that usage stays unknown. Cost figures are estimates, not bills.

### Your big model

New in v0.2.16. `/model big <provider/model>` (the same as
`/model role reason …`) sets your big model; `/model big clear` forgets it. When checks still
fail after the last repair in an interactive session, Casper asks once:
`test still fails after 3 repairs. What now?` with 1 Stop here and 2 Retry with your big model,
which names the model and what it reads (`about 48k tokens, at least ≈ $0.72`; only the
conversation it reads is counted, so the price is a lower bound). The free answer is first, so
Enter or Esc never spends. Retry switches this conversation to the big model for one more repair,
then back: `[model] Back on provider/model for your next request.` The receipt says
`↻ Casper tried 4 repairs (the last on your big model provider/model)`. A big model that cannot
hold the conversation is not offered. With no big model set, a rich terminal offers
"Retry with a bigger model", opens the model picker and asks whether to remember your pick. A
pick you do not save is named plainly (`↻ repair 4/4 on provider/model`), never called your big
model, and a pick that cannot hold the conversation is not tried. One-shot runs and `--json`
never ask.

To run the last repair on the big model without being asked, set it in your own config. A
project's `.casper/project.yaml` cannot (it would choose to spend your money); Casper stops
loading with an error if it tries.

```yaml
# ~/.casper/config.yaml or a profile's config.yaml
repair:
  bigModelLastTry: true
suggestions: false   # no suggested next steps anywhere
updates: false       # no "a newer Casper is out" line at the start of a session
```

A session checks for a newer Casper at most once a day, in the background (no model, no
tokens), and shows what the last check found as one `[update]` line at the start. A release
install asks GitHub for the newest release; a source checkout fetches and counts how far its
branch is behind. `updates: false`, `CASPER_NO_UPDATE_CHECK=1` or `CI` turns it off; a project
cannot. `casper update` installs or pulls it.

### What a task spends

Nothing to set up. The footer shows the current task's tokens and its cost from the model's
price (`task 48.2k tok · $0.31`); a free model shows tokens only. The cost is the catalog's
estimate, not a bill. By default a task only gets notes and never stops for money:

- At about **$1**, one quiet line: `… This task has used $1.03 so far (312k tok).` At about **$5**,
  one more. A subscription or a free model gets neither.
- Want a limit? Say it in your request ("keep it under $2"), or set `spend.pauseAt`. Then the task
  pauses before its next step and asks `This task has used $5.02.` with `1 Stop here · 2 Keep
  going`. Stop here is first, so Enter stops; the work so far is kept and the receipt says
  `• Incomplete — stopped at $5.02, the $5 limit for one task`. Keep going asks again at the next
  multiple.
- With `spend.pauseAt` set, one-shot runs and `--json` never wait: they stop at the same point, say
  so on one line, and the receipt says it (exit 2, JSON `spendLimit`).

The pause comes before the AI's next step (a tool call), so a turn that ends in words only ends the
task instead. The shown cost leaves out the small automatic-effort call and `/delegate` helpers until
they report back, so it can be a little under the real figure.

To change the limits, or turn one off, set them in your own config (a project cannot):

```yaml
# ~/.casper/config.yaml or a profile's config.yaml
spend:
  noteAt: 2        # dollars per task (a second note at 5x); false turns the notes off
  pauseAt: 20      # dollars per task; off unless set; false turns it off again
```

## Prompt cache

Providers keep the start of the conversation (instructions, tools, earlier turns) for a while, so
the next request reads it back cheaply. By default (`cache: auto`) Casper keeps the long cache only
where it costs nothing extra:

- OpenAI, and non-Anthropic models on OpenRouter, get the long cache, about a day, which costs no
  more to write than the short one.
- Anthropic models, whether direct or through OpenRouter, Bedrock or Vertex, get the short cache
  (about five minutes). Their hour-long cache costs about twice the normal input price to write,
  against about 1.25 times for the short one.
- Any other provider, including other OpenAI-style and local servers, gets the short cache, so it
  never sees a request it might reject or charge extra for.

Casper's own tools stay offered once they appear, and tools from connected MCP servers are picked
once per session, because a changed tool list throws the cache away. Connecting or removing an MCP
server can still start it over. `/usage` shows how much input came from the cache:
`Cache: 97% of input read from cache this session`.

`cache: long` asks every provider for the long cache (Bedrock still gets the short one), which can
pay off on Anthropic if you often pause for more than five minutes. To change it, set it in your own
config; a project's `.casper/project.yaml` cannot:

```yaml
# ~/.casper/config.yaml or a profile's config.yaml
cache: short   # auto (default), long, short, or off
```

## Display

How much of the work shows on screen while Casper works. The model's thinking is never printed.

- `normal` (default): the latest steps in the Working box, folded into one line when the model moves
  on (`✓ 14 edits · 6 commands · 38s`); failures keep their own line.
- `quiet`: the model's words, failures and the receipt; successful steps leave no line.
- `detailed`: every step on its own line, with a small diff (up to 12 changed lines) under each edit.

`/details quiet|normal|detailed` switches for the session, and `/details` alone goes to the next
level. Ctrl+T shows the last finished step in full at any level: an edit's whole diff, or what a
command printed. The window title names the conversation from its first request
(`Casper · subnet calculator`) and shows `◐` while Casper works.

```yaml
# ~/.casper/config.yaml or a profile's config.yaml
display: detailed   # quiet, normal (default), or detailed
```

## Skills

A skill is a Markdown file of instructions (a `SKILL.md`) that Casper adds to the model's prompt
when a request matches it — for example "how we write MCP tools in this team". Casper chooses
skills itself; Pi's own skill discovery is turned off inside Casper.

**Where Casper looks** (at startup; only Casper's own folders are on by default):

| Source | Locations | Trusted by default? |
| --- | --- | --- |
| User | `~/.casper/skills/` | Yes, when the real file is inside this folder |
| Project (your copy) | `~/.casper/projects/<project>-<id>/skills/` (where `casper learn promote … project-skill` writes) | Yes, when the real file is inside this folder |
| Project | `<project>/.casper/skills/` | No, until you review it |
| Bundled with Casper (since v0.2.18) | Inside the `casper` binary (source: `skills/network/*/SKILL.md`) | Yes; on unless `skills.bundled: false`. See [SKILLS.md](SKILLS.md) |
| Other tools **(opt-in)** | `~/.pi/agent/skills/`, `~/.agents/skills/`, `~/.claude/skills/`, `~/.codex/skills/`; in the project `.pi/skills/`, `.agents/skills/`, `.claude/skills/`, `.codex/skills/` | No, until you review it |

To use other tools' skill folders, turn them on in `~/.casper/config.yaml` or
`~/.casper/profiles/<profile>/config.yaml`:

```yaml
skills:
  imports: [pi, agents] # default []; supported names: pi, agents, claude, codex
```

Each name adds its user and project folders from the table. A profile list replaces the global
list; `[]` turns imports off. `skills.imports` in a project file is an error: a repository cannot
turn imports on. (A project can still select one of your profiles; see
[Profile trust](#profiles).) Importing only finds skills; it does not trust them, and review is
still needed. Casper never changes skill files in those folders.

**How files are found.**

- Folders are searched (up to 12 levels deep) for `SKILL.md`. A standalone `.md` file also counts
  when its frontmatter (the `---` block at the top) has a `name` or `description`; ordinary docs,
  including ones with only a title, are ignored.
- Once a folder has a `SKILL.md`, the other files in it (references, scripts) are not treated as
  separate skills.
- Symlinks to the same file count once. In a project, only the listed skill folders are searched
  (not parent folders), and a symlink leading outside the project is refused. Symlinks inside the
  project work.
- Pi packages and custom Pi skill paths are not imported.
- A declared skill with mistakes still produces a warning. Startup summarizes new warnings;
  `/skills diagnostics` shows the full detail.

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

`name` must be 1–64 lowercase letters, numbers or single hyphens; `description` 1–1024 characters.
Other frontmatter keys are kept. At startup Casper reads only the frontmatter, not the body.

**How skills are picked.** For each request, Casper ranks eligible skills by the request's words,
the skill's tags, name and description, the kind of task, and the project's languages. A broad
task-kind or language match alone does not load a skill. `disable-model-invocation: true` keeps a
skill out of automatic selection, even after review.

Set how many skills load per request in the global, profile or project file:

```yaml
skills:
  maxActive: 6 # default; 0 turns automatic loading off, maximum 32
```

**Bundled network skills (since v0.2.18).** The bundled skills (Mist, Central new and classic,
AOS-CX, Junos, ClearPass) use a stricter rule: a request must name the product (for example
"mist api", "pyez", "clearpass"), or use a looser word ("mist", "junos", "central") together with
a network word ("site", "switch", "api", "script"), or be a change request in a project whose
Python packages include that product's SDK. At most two bundled skills load per request. Turn
them all off in `~/.casper/config.yaml` or a profile (a project file cannot):

```yaml
skills:
  bundled: false # default true
```

A skill in `~/.casper/skills/` with the same name as a bundled one replaces it only while it
keeps the bundled layout and the "Stop and ask the user" line; otherwise the bundled text is used
and `/skills diagnostics` says why. A project's same-name skill never replaces a bundled one. See
[SKILLS.md](SKILLS.md).

Skills are optional procedures, not a substitute for the repository: frontend, design and other
work use the project's own files. Only the selected skills' bodies are read and added, with their
source and folder. When two skills share a name, both show in `/skills` with different IDs, but
only one is used: the more relevant, then project → user → other tools, then ID. Limits: 16 KiB of
frontmatter, 256 KiB per skill file, and 64 KiB of skill bodies per request. A bad or oversized
skill gives a warning; it does not stop Casper from starting.

### Inspect and review

These skill commands run locally and work without a model or sign-in; they never send skill
bodies to the model:

```text
/skills
/skills diagnostics
/skills inspect <id>
/skills trust <id> <sha256>
/skills block <id>
```

Use the exact ID from `/skills`. `inspect` prints the body and its SHA-256 hash; read it before
running the printed `trust` command. Decisions are stored in `~/.casper/skills-trust.json`, keyed
by the real file path. Trust is checked against the file's current content each time the skill
is used, so changing a reviewed skill needs another review. Changing its frontmatter needs a
Casper restart to rebuild the list. A damaged or unreadable trust file is an error, and nothing is
trusted.

Trust cannot be granted by a project file or by skill frontmatter. Your own user skills are
instructions you control — do not copy unreviewed skills there. A symlink leading outside your
user skill folder needs an explicit review.

**What this does not protect.** Review controls which skills Casper adds to the prompt, not what
the model can read or run. Skills grant no permissions, and Casper never runs a skill's helper
scripts. Since v0.2.17 the model's file tools stay out of private places and its shell runs in
the shell sandbox where one can run (see [SECURITY.md](SECURITY.md)); policy is prompt guidance.
Trust covers `SKILL.md` only, not the scripts or files it points to; check those yourself.
Blocking a skill stops future use; it does not remove text already in a conversation.
`maxActive` limits new skills per request, not the whole conversation.
