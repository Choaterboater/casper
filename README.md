<p align="center">
  <a href="https://choaterboater.github.io/casper/">
    <img alt="Casper logo" src="site/assets/icon-192.png" width="96">
  </a>
</p>

# Casper

A coding helper for your terminal that checks the AI's work before it says "done", with network
care built in.

Build web apps, APIs, command-line tools and scripts in the language your project uses. When the
AI says it is done, Casper runs your project's own checks (tests, lint, build) and, where it can,
proves a test fails without the change. You get a short receipt that says what was proven.

Network engineers get extra care: MCP servers (tool servers the AI can call) start with writes
off, every change asks you in one numbered box, and the AI can't approve anything for you.
Sign in with OpenRouter, Anthropic (Claude), OpenAI Codex or GitHub Copilot, so you are not tied
to one model company, or run a model on your own computer ([Local models](docs/CONFIGURATION.md#local-models)). Many things cost zero tokens: the checks, `/verify`, `/mcp`, `/diff`,
`/receipt` and local reference search make no model call.

Casper itself is free and open source. A task spends money only with your own model provider
(OpenRouter, Anthropic, OpenAI or Copilot, whichever you sign in with). Casper has no prices of its own.

> **Preview, unsigned.** This is an early preview. The programs are not signed, so your system
> may warn you. macOS is the best tested. Windows and Linux are tested less: Windows x64 and Linux run
> the test suite in CI, but nobody has tried the interactive screen on a real Windows desktop or a real
> Linux machine, and Windows ARM64 is only built, started and installed in CI. See
> [what is tested and the limits](docs/RELEASE.md#known-preview-limits) and
> [PLATFORM_SUPPORT.md](docs/PLATFORM_SUPPORT.md).

**Found a bug or have feedback?** [Open an issue](https://github.com/Choaterboater/casper/issues).

## Install

macOS / Linux:

```sh
curl -fsSL https://github.com/Choaterboater/casper/releases/download/v0.2.26/install.sh | sh
```

Windows (x64 or ARM64), in PowerShell:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Choaterboater/casper/releases/download/v0.2.26/install.ps1 | iex
```

No admin rights, Bun or source checkout needed. The installer checks the file's SHA-256 (with
`gh` signed in, also where it was built; for releases signed with the
[release key](docs/RELEASE.md#the-release-key), none yet, the signature too) and keeps your old install
if anything is wrong. These commands pin **v0.2.26**; after that,
`casper update` gets the newest preview. `install.sh` takes `--dir <path>`, `--version 0.2.26`,
`--sha256 <hex>` and `--force`. [Installer details](docs/RELEASE.md#installer-contract).

Use the one-line command above rather than downloading a program in your browser: the installer
checks the file and clears the macOS quarantine flag for you. If you did download one in a browser
and macOS refuses to open it, run `xattr -d com.apple.quarantine <file>` on it.

**Uninstall.** There is no uninstaller and nothing is installed system-wide. On macOS / Linux,
run `rm ~/.local/bin/casper` (or the folder you gave `--dir`). On Windows, delete the folder
`%LOCALAPPDATA%\Programs\casper` and remove it from your user PATH (the installer added it).
Your settings, sign-ins and saved chats are in `~/.casper` (`rm -rf ~/.casper` on macOS / Linux;
the `.casper` folder in your user folder on Windows). Delete it only if you want those gone.

## Get started

```sh
cd your-project
casper
```

Type `/login` and press a number: OpenRouter is first (Enter picks it), then Anthropic, OpenAI
Codex and GitHub Copilot. If you skip it, Casper opens sign-in on your first request. Then ask for what you want, for example `Fix the failing test in sum.js`.
Casper works, runs the checks, and ends with a receipt:

```text
✓ Verified · test passed · changed sum.js
```

From the shell:

```sh
casper "Explain this project"
casper --no-verify   # no Casper-run checks this run
casper --version     # casper 0.2.26 (/absolute/path/of/the/binary/or/cli.ts)
casper doctor        # check Casper's own setup and fix what it can (no model)
```

A check runs your project's own command without asking, inside the sandbox where there is one.
Use `--no-verify` for code you don't trust.

Type `/help` for the commands. Ctrl+C stops the current work but keeps changes already made;
Ctrl+D on an empty prompt exits. [Keys and commands](docs/TERMINAL_UX.md#quick-reference).

## What it does

- **Receipts and proof.** Line 1 says `Verified`, `Checks passed — not proven`, `Failed` and so on.
  `Verified` means the checks pass and a test fails without the change. [Receipts](docs/VERIFICATION.md#receipts)
- **Checks and repair.** After an edit, Casper runs the checks and sends real failures back for
  three repair tries by default. Web pages are opened and checked too. [Verification](docs/VERIFICATION.md)
- **One numbered box for every yes.** `1 No · 2 Yes, this once · 3 Yes, for this session ·
  4 Yes, always for this project`, and network boxes add `Yes to everything on <product> this session`;
  each box shows only the answers that fit. Nothing asks you to type `yes`. [Terminal guide](docs/TERMINAL_UX.md)
- **Undo.** `Next: 1 Show diff · 2 Undo` after each task; `/undo`, `/redo` and `/diff` work on any
  saved task, also outside git. [Undo](docs/UNDO.md)
- **Sessions.** Pick up a past chat (`--continue`, `/resume`), or try an idea in a named branch with
  its own folder. [Sessions](docs/SESSIONS.md)
- **Services, browser, LSP, debugger.** Run your dev server, debug in Chrome or Edge, use a language
  server or a step debugger. [Services](docs/SERVICES.md) · [Browser](docs/BROWSER.md) · [LSP](docs/LSP.md) · [Debugger](docs/DEBUGGER.md)
- **Scripting.** `--json` streams events, and exit codes tell a script what happened (3 = not proven
  with `--require-verification`). [Scripting](docs/SCRIPTING.md#exit-codes)
- **References.** Search local copies of vendor specs and SDKs (Junos YANG, pycentral, mistapi)
  with no model call. [References](docs/REFERENCES.md)

## For network engineers

- **Casper's network server.** Ask about Mist, Central or ClearPass (or type `/mcp setup network`)
  and Casper offers `1 Not now · 2 Set it up` once. It installs a pinned, hash-locked
  [casper-network-mcp](https://github.com/Choaterboater/casper-network-mcp) with writes off. You
  type each login yourself. [Casper's network server](docs/MCP.md#caspers-network-server)
- **Change boxes and change kinds.** Each change says what changes and where the login reaches.
  Firmware, deletes and admin changes stay off until you allow them. [Change kinds](docs/MCP.md#change-kinds-and-mcp-allow)
- **Device checks and `/lab`.** Device checks can reach any device, only after your answer; the box
  names any device not in your lab list. [Your lab](docs/NETWORK-CHECKS.md#your-lab)
- **Risky config lines.** The receipt lists lines a task added such as `reload` or `shutdown`, as
  a report, never a pass or a fail. [Risky lines](docs/NETWORK-CHECKS.md#risky-config-lines-in-the-receipt)
- **MCP presets.** Works with hpe-networking-mcp, junos-mcp-server, Mist, NetBox and others; presets
  send a known server's own read-only settings. [MCP](docs/MCP.md) · [Presets](docs/MCP.md#presets)

## Safety and privacy

- **Sandbox.** On macOS and Linux, the AI's shell and your checks write only the project, temp and
  package caches, can't read `~/.ssh` or cloud logins, and reach only listed hosts. Casper's network
  server runs in it too, reaching only your login hosts. On Windows, or
  Linux without bubblewrap (`sudo apt install bubblewrap socat ripgrep`), the AI's shell asks before
  each command that changes something. [Sandbox](docs/SECURITY.md)
- **Secrets hidden, best effort.** Known device secrets (passwords, keys, SNMP communities) are
  swapped for `<secret hidden>` before the AI sees them. Known formats only. [Secrets](docs/SECRETS.md)
- **Untrusted text, read at arm's length.** The AI can read a log, an email or a web form through
  a separate model call with no tools and get back only JSON in its shape, never the text. It lowers
  the risk of hidden orders; it doesn't remove it. [Reader](docs/READER.md)
- **Only you can approve.** The AI can't answer a box for you. What goes to your model provider,
  and what is not held back: [SECURITY.md](docs/SECURITY.md).

## Docs

| | |
| --- | --- |
| Checking work | [Verification](docs/VERIFICATION.md) · [Undo](docs/UNDO.md) · [Security checks](docs/SECURITY_CHECKS.md) |
| Network | [MCP](docs/MCP.md) · [Network checks](docs/NETWORK-CHECKS.md) · [Skills](docs/SKILLS.md) · [Packs](docs/PACKS.md) · [References](docs/REFERENCES.md) |
| Everyday use | [Terminal](docs/TERMINAL_UX.md) · [tmux](docs/TMUX.md) · [Sessions](docs/SESSIONS.md) · [Memory](docs/MEMORY.md) · [New projects](docs/NEW.md) |
| Tools | [Services](docs/SERVICES.md) · [Browser](docs/BROWSER.md) · [LSP](docs/LSP.md) · [Debugger](docs/DEBUGGER.md) · [Diagrams](docs/VISUALIZATION.md) · [Helpers](docs/DELEGATION.md) · [Crews](docs/CREWS.md) · [Learn](docs/LEARNING.md) |
| Setup | [Doctor](docs/DOCTOR.md) · [Configuration](docs/CONFIGURATION.md) · [Scripting](docs/SCRIPTING.md) · [Secrets](docs/SECRETS.md) · [Security](docs/SECURITY.md) · [Reader](docs/READER.md) |
| Platforms | [Support](docs/PLATFORM_SUPPORT.md) · [Testing a machine](docs/PLATFORM_VERIFICATION.md) · [Windows](docs/WINDOWS.md) · [Releases](docs/RELEASE.md) · [Evals](docs/EVALUATION.md) |
| Contributing | [How Casper is built](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md) |

## What's new

v0.2.26: local models (a written recipe for Ollama, LM Studio, llama.cpp and vLLM, with plain errors), `casper update` working on Windows, and Casper opening where you launched without asking, even from your home folder.
[Release notes](docs/RELEASE.md#v0225-a-stricter-plain-read-check-verification-that-is-harder-to-fool-reviewers-for-builders-and-a-calmer-start) ·
[Roadmap](https://choaterboater.github.io/casper/roadmap.html).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To work from source (needs Bun, Git and Python 3):

```sh
git clone https://github.com/Choaterboater/casper.git
cd casper
bun install --frozen-lockfile
bun run check
```

## License

[MIT](LICENSE). Casper is built on the Pi SDK. Other parts keep their own licenses
([THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)).
