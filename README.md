# Casper

[MIT licensed](LICENSE). Third-party dependencies retain their own licenses.

A terminal coding companion built on Pi, with its own interface, project context,
and verification controls.

**Early preview.** macOS is validated locally; Windows x64 installation and startup
are tested in CI under PowerShell 5.1 and 7. Linux still needs host testing. Binaries
are unsigned, and interactive UI issues remain. See [release details](docs/RELEASE.md).

## Install

No Bun installation or source checkout is required.

**Windows x64 — PowerShell:**

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Choaterboater/casper/releases/download/v0.2.12/install.ps1 | iex
```

Then run `casper` from your project folder. If an existing terminal does not find it,
open a new terminal.
Windows ARM64 does not have a release artifact yet.

**macOS / Linux:**

```sh
curl -fsSL https://github.com/Choaterboater/casper/releases/download/v0.2.12/install.sh | sh
```

The installer verifies the executable's SHA-256 and runs the staged executable's
`--version` successfully before replacing an existing installation; a rejected
download leaves the previous installation untouched. It needs no administrator
access. These commands pin **v0.2.12**: re-running reinstalls that preview. For a
newer preview, use its release URL; GitHub's `latest/download` route excludes
prereleases. Useful `install.sh` options: `--dir <path>`, `--version 0.2.12`,
`--sha256 <hex>` and `--force` (replace a development symlink that leaves the
install directory). [Installer details](docs/RELEASE.md).

## Start coding

```sh
cd your-project
casper
casper --no-verify   # without the managed check tool
```

Inside Casper:

```text
/login
/model
```

Sign in with a supported provider, choose a model, then describe the work you want
done. Login supports OpenAI Codex, GitHub Copilot, Anthropic/Claude, and OpenRouter.
Provider eligibility, subscriptions and usage charges still apply. Enter keys or
callback codes only in the dedicated private login prompt, never in chat.

```sh
casper "Explain this project"
casper --verify "Fix the failing tests"
casper --version     # casper 0.2.12 (/absolute/path/of/the/binary/or/cli.ts)
```

An interactive session offers the model a `casper_check` tool for the project's
configured checks (typecheck, lint, test, build); `--no-verify` withholds it, and
one-shot prompts get it only with `--verify`. Offering the tool runs nothing: the
model selects relevant checks based on actual work, and a selected check executes
that repository's configured command. This is execution consent, not sandboxing —
use it only in trusted projects, or start with `--no-verify`. No selection means
**no Casper verification recorded**, not a pass. Native bash stays independent of
managed verification: a model-issued bash call without `timeout` gets a 120-second
default and returns a tool error on expiry so the conversation can continue.
A model saying “done” is not a passing test or human acceptance.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `/help` | Short command guide; `/help all` includes the full reference |
| `/status` | Project, model and integration status |
| `/model`, `/effort` | Choose a model and a supported reasoning level, or `/effort auto` |
| `/model roles` | Inspect optional `fast`, `build`, `reason`, `review` model shortcuts |
| `/verify` | Run configured checks without a model |
| `/verify repair test` | Authorize bounded repair of a failing test check |
| `/diff` | Inspect Git changes |
| `/output [n]` | Full retained output of the last task's n-th most recent tool call (20 retained) |
| `/clear`, `/resume` | Start fresh or restore a conversation; not a file rollback |
| `/context`, `/usage` | Runtime estimates and reported usage |
| `/permissions` | Explain actual boundaries |

The editor supports multiline input, command/path completion, scrollback and a
persistent status footer. Ctrl+C cancels active work without undoing existing
changes; when idle it clears the draft, and on an empty editor a second Ctrl+C
within two seconds exits (Ctrl+D exits at once). Model selection normally
remembers your choice; `--session` opts out.
`/effort auto` classifies each request with one bounded extra model call and shows
the effort actually used; a fixed level turns it off.

Assistant messages render as Markdown through Pi's renderer, re-rendered whole while
they stream so lists and fences stay correct; fenced code blocks are boxed in a
bordered panel titled with their language, as are `/output` replays and the `/diff` status and
colored diff; prose stays inline. Each tool call occupies one transcript
line: `• … — running` is redrawn in place as `✓`/`✗` when it finishes, and a dim
`… thinking · 1.5k chars` line keeps the screen live while the model produces output
that is not yet visible. The `/` popup, pickers and the login notice are drawn over
the bottom of the transcript, never appended, so opening them does not scroll the
terminal. After a coding request the receipt names the files that actually changed
(before/after tree digest), files changed later during checks/repair, and a bounded
`git diff --stat`. See the [terminal guide](docs/TERMINAL_UX.md).

## Optional capabilities

Nothing here requires installing or connecting a server automatically.

- [Project configuration, model roles and skills](docs/CONFIGURATION.md)
- [Verification, freshness and repair](docs/VERIFICATION.md)
- [MCP tools](docs/MCP.md) and [language servers](docs/LSP.md)
- [Browser-assisted debugging](docs/BROWSER.md) and [local DAP debugging](docs/DEBUGGER.md)
- [Diagram export](docs/VISUALIZATION.md)
- [Named sessions and worktrees](docs/SESSIONS.md)
- [Read-only explorer/reviewer agents](docs/DELEGATION.md)
- [Explicit project memory](docs/MEMORY.md), [reference search](docs/REFERENCES.md), and [learning drafts](docs/LEARNING.md)

## Safety and privacy

Casper is **not a sandbox**. Native coding tools can read/write files and run shell
commands with your permissions. Worktrees, read-only agent roles and integration
consent do not provide OS isolation.

Source text, tool output and conversation history may reach your selected model
provider or remain in local plaintext state. Do not use sensitive repositories
without an appropriate provider and environment. There is no comprehensive secret
detector or enforced parent-task spending cap.

Checks establish command results, not complete behavioral correctness. Missing or
stale evidence is not a pass. Review important changes yourself.

## Platform testing

See [platform support](docs/PLATFORM_SUPPORT.md) and the
[Windows preview checklist](docs/WINDOWS.md). Please report the OS/Bun version,
command, actual error and whether an optional browser/debugger adapter was installed.
Remove secrets and sensitive paths before sharing logs.

## Develop from source

Requires Bun, Git, and Python 3 for the POSIX terminal tests:

```sh
git clone https://github.com/Choaterboater/casper.git
cd casper
bun install --frozen-lockfile
bun run dev
bun run check
```

For a PATH command that follows the checkout, link `src/cli.ts` to
`~/.local/bin/casper` (`chmod +x src/cli.ts` first). `casper --version` prints
`casper <version> (<path>)`, where the path is the `cli.ts` or compiled binary that
actually ran, so a stale link is visible in one command; the release installer
refuses to replace such a link without `--force`, and never replaces a link into a
`.scratch/` checkout.

Tests use isolated fixtures; no paid model is needed for `bun run check`. Browser
and real-debugger tests need already installed tools and explicitly skip when
unavailable. `bunfig.toml` scopes discovery to `tests/`, so evaluation fixtures under
`evals/fixtures/` keep their own test files. POSIX-only fixtures declare an explicit
skip through `tests/support/platform.ts` on hosts that cannot run them, and a
fixture's configured check runs `tests/fixtures/check-script.ts` rather than a POSIX
shell pipeline; portability by construction is not host validation.
[Host verification](docs/PLATFORM_VERIFICATION.md).

Build the host executable with `bun run build:release`, or all five release targets
with `bun run build:release -- --all`. Build output is ignored by Git and belongs
in release assets.

The optional [evaluation suite](docs/EVALUATION.md) runs real model tasks against
dependency-free fixture repositories and can incur provider usage:

```sh
bun tools/eval.ts --list                                   # task ids
bun tools/eval.ts                                          # every task (uses the configured model)
bun tools/eval.ts --repeat 3 --json /tmp/eval.json         # each task 3x on fresh work directories; pass rate, median/min/max wall clock
bun tools/eval.ts --model github-copilot/claude-fable-5.1  # select the model for this run only (never writes ~/.casper/settings.json)
```
