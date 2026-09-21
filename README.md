# Casper

[MIT licensed](LICENSE). Third-party dependencies retain their own licenses.

A terminal coding companion built on Pi, with its own interface, project context,
and verification controls.

**Source preview — no binary release published yet.** Core macOS paths are validated
locally; Windows and Linux still need real-host testing. Binary publication is blocked
on image-resource packaging and third-party notices. See [release status](docs/RELEASE.md).

## Planned binary installation

**The commands below are not live yet.** Until a release is published, use
[Develop from source](#develop-from-source). The planned compiled application will
not require Bun or a source checkout.

**Windows x64 — PowerShell:**

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://github.com/Choaterboater/casper/releases/download/v0.1.0/install.ps1 | iex"
```

Open a new terminal after installation, then run `casper` from your project folder.
Windows ARM64 does not have a release artifact yet.

**macOS / Linux:**

```sh
curl -fsSL https://github.com/Choaterboater/casper/releases/download/v0.1.0/install.sh | sh
```

The installer verifies the executable's SHA-256 and requires a successful version
probe before replacing an existing installation. It needs no administrator access.
These commands pin **v0.1.0**: re-running reinstalls that preview. For a newer
preview, use its release URL. [Installer details](docs/RELEASE.md).

## Start coding

```sh
cd your-project
casper
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
```

`--verify` offers Casper-managed project checks and bounded repair. It authorizes
execution of the project's configured commands; use it only in trusted projects.
A model saying “done” is not a passing test or human acceptance.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `/help` | Short command guide; `/help all` includes the full reference |
| `/status` | Project, model and integration status |
| `/model`, `/effort` | Choose a model and supported reasoning level |
| `/verify` | Run configured checks without a model |
| `/verify repair test` | Authorize bounded repair of a failing test check |
| `/diff` | Inspect Git changes |
| `/clear`, `/resume` | Start fresh or restore a conversation; not a file rollback |
| `/context`, `/usage` | Runtime estimates and reported usage |
| `/permissions` | Explain actual boundaries |

The editor supports multiline input, command/path completion, scrollback and a
persistent status footer. Ctrl+C cancels active work without undoing existing
changes. Model selection normally remembers your choice; `--session` opts out.
See the [terminal guide](docs/TERMINAL_UX.md).

## Optional capabilities

Nothing here requires installing or connecting a server automatically.

- [Project configuration and skills](docs/CONFIGURATION.md)
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

Tests use isolated fixtures; no paid model is needed for `bun run check`. Browser
and real-debugger tests need already installed tools and explicitly skip when
unavailable. [Host verification](docs/PLATFORM_VERIFICATION.md).

Build the host executable with `bun run build:release`, or all five release targets
with `bun run build:release -- --all`. Build output is ignored by Git and belongs
in release assets. The optional [evaluation suite](docs/EVALUATION.md) runs real
model tasks and can incur provider usage.
