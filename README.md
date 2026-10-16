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
Sign in with OpenRouter, Anthropic (Claude API or your Claude Code plan), OpenAI Codex or GitHub Copilot, so you are not tied
to one model company, or run a model on your own computer: Ollama, LM Studio, llama.cpp and vLLM show in `/model` by themselves, and one on another computer is added from `/model` by its address ([Local models](docs/CONFIGURATION.md#local-models)). Many things cost zero tokens: the checks, `/verify`, `/mcp`, `/diff`,
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
curl -fsSL https://github.com/Choaterboater/casper/releases/download/v0.2.37/install.sh | sh
```

Windows (x64 or ARM64), in PowerShell:

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Choaterboater/casper/releases/download/v0.2.37/install.ps1 | iex
```

No admin rights, Bun or source checkout needed. The installer checks the file's SHA-256 (with
`gh` signed in, also where it was built; for releases signed with the
[release key](docs/RELEASE.md#the-release-key), none yet, the signature too) and keeps your old install
if anything is wrong. These commands pin **v0.2.37**; after that,
`casper update` gets the newest preview. `install.sh` takes `--dir <path>`, `--version 0.2.37`,
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

Type `/login` and press a number: OpenRouter is first (Enter picks it), then the Anthropic API, your
Claude Code plan, OpenAI Codex (ChatGPT plan) and GitHub Copilot. Already signed in to Claude Code, Codex CLI or GitHub CLI on this computer?
`/login` offers that first; a plan sign-in is never copied, so the other tool stays signed in. If you skip it, Casper opens sign-in on your first request (or `/model`, on model servers you added). Then ask for what you want, for example `Fix the failing test in sum.js`.
Casper works, runs the checks, and ends with a receipt:

```text
✓ Verified · test passed · changed sum.js
```

From the shell:

```sh
casper "Explain this project"  # start a session with this first request
casper --no-verify   # no Casper-run checks this run
casper --version     # casper 0.2.37 (/absolute/path/of/the/binary/or/cli.ts)
casper doctor        # check Casper's own setup and fix what it can (no model)
```

**Since v0.2.36:** when stdin and stdout are both terminals, no forcing flags are given and `CI` is unset,
`casper "Explain this project"` sends the first request and stays open for follow-ups. A lone word that
isn't a folder, at home or a drive root, asks whether you meant a request or a new project of that name;
elsewhere, or with two or more words, there is no such question.

### One-shot runs and scripts

Use `casper -p "Explain this project"` (or `--print`) to run once and exit.
Use `-p` explicitly in scripts. Existing scripts stay one-shot when either stdin or stdout is not
a terminal, or with `--json`, a lone `-` prompt, `--require-verification`, `--max-turns`, or `CI` set.
Exit codes and receipts are unchanged. [Scripting](docs/SCRIPTING.md).

A check runs your project's own command without asking, inside the sandbox when you have turned it on.
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
  each box shows only the answers that fit. Nothing asks you to type `yes`. For a shell command, 3 and 4 remember
  that exact command, never a prefix: a yes to `rm -rf build` never covers `rm -rf ~`. [Terminal guide](docs/TERMINAL_UX.md)
- **Plans you change in words.** `/plan <request>` is optional: a clear request gets a plan directly;
  only choices that change the build get up to 3 questions in one round. Existing projects get numbered steps
  and Done means checks; new apps, sites and games get a first-version spec, not forced steps. Then
  `1 Stop · 2 Build · 3 Change the plan`: say what to change ("drop step 2") and the model rewrites it. Enter never
  builds. Ctrl+T shows Details; Ctrl+G opens saved Markdown in `VISUAL` or `EDITOR` and rereads it on return.
  `/plan` alone reopens recent gitignored plans. Build gets the checklist; progress is a **model report**.
  The receipt reports each item from Steps (or First version in a spec): completed items as done, not-done
  items with reasons, labelled **model report**, not check proof.
  [Plans](docs/TERMINAL_UX.md)
- **Work you can follow.** While Casper works, the steps read in plain words (`Looking through the code: 14 searches,
  9 files read`, `Ran the tests`); Ctrl+O shows every raw tool call, Ctrl+T the last step in full.
- **Crews for big jobs.** For a job with separate parts the AI starts builders, each in its own copy of your folder;
  reviewers check each part, the full checks run on the combined result, and one `/undo` takes it all back. Say
  "split this up" to ask for them, or `/crew <job>` for one by hand. [Crews](docs/CREWS.md)
- **Undo.** `Next: 1 Show diff · 2 Undo` after each task; `/undo`, `/redo` and `/diff` work on any
  saved task, also outside git; `/rewind` goes back to just before an earlier prompt to edit it. A task that rebases
  or pulls counts only its own edits, and Undo leaves what git brought in alone. [Undo](docs/UNDO.md)
- **Sessions.** Pick up a past chat (`--continue`, `/resume`), or try an idea in a named branch with
  its own folder. [Sessions](docs/SESSIONS.md)
- **Pages in your browser.** When seeing beats reading (options side by side, a mock-up, a
  dashboard, a report for others), the AI makes a page by itself and it opens in your
  browser; a change reloads it. Local only, with an off switch in `/settings`.
  [Pages](docs/TERMINAL_UX.md#pages-the-ai-makes)
- **Services, browser, LSP, debugger.** Run your dev server, debug in Chrome or Edge, use a language
  server or a step debugger. [Services](docs/SERVICES.md) · [Browser](docs/BROWSER.md) · [LSP](docs/LSP.md) · [Debugger](docs/DEBUGGER.md)
- **Scripting.** `--json` streams events, and exit codes tell a script what happened (3 = not proven
  with `--require-verification`). [Scripting](docs/SCRIPTING.md#exit-codes)
- **References.** Search local copies of vendor specs and SDKs (Junos YANG, pycentral, mistapi)
  with no model call. [References](docs/REFERENCES.md)
- **Pull requests and CI.** Ask which pull requests are open or why a check failed; Casper reads
  the failing step through `gh`, and the AI never sees your GitHub login. [GitHub](docs/GITHUB.md)
- **Skill packs and themes.** `/pack add` a folder or a GitHub commit of skills after a box that
  shows every file; pick a colour theme in `/settings`, one grouped screen you can search. [Packs](docs/PACKS.md)
- **New projects.** `casper new` starts a project with tests and a first commit, with no model
  call. [New projects](docs/NEW.md)

## For network engineers

- **Casper's network server.** Ask about Mist, Central or ClearPass (or type `/mcp setup network`)
  and Casper offers `1 Not now · 2 Set it up` once. It installs a pinned, hash-locked
  [casper-network-mcp](https://github.com/Choaterboater/casper-network-mcp) with writes off. You
  type each login yourself. A newer casper-network-mcp release is offered between Casper releases,
  installed from that release's checked hash lock. [Casper's network server](docs/MCP.md#caspers-network-server)
- **Change boxes and change kinds.** Each change says what changes and where the login reaches.
  Firmware, deletes and admin changes stay off until you allow them. [Change kinds](docs/MCP.md#change-kinds-and-mcp-allow)
- **Device checks and `/lab`.** Device checks can reach any device, only after your answer; the box
  names any device not in your lab list. [Your lab](docs/NETWORK-CHECKS.md#your-lab)
- **Risky config lines.** The receipt lists lines a task added such as `reload` or `shutdown`, as
  a report, never a pass or a fail. [Risky lines](docs/NETWORK-CHECKS.md#risky-config-lines-in-the-receipt)
- **MCP presets.** Works with hpe-networking-mcp, junos-mcp-server, Mist, NetBox and others; presets
  send a known server's own read-only settings. [MCP](docs/MCP.md) · [Presets](docs/MCP.md#presets)

## Safety and privacy

- **Sandbox, off unless you turn it on.** Until you do, the AI's shell asks before each command that changes
  something, but routine work runs as in Claude Code's auto mode (`npm test`, `git commit`, a push without force,
  `bun install`; **Routine commands** in `/settings`), and a write outside the project asks first. `sudo`,
  `curl … | sh`, a force push, deleting outside the project and a new package still ask. `sandbox: on` in `~/.casper/config.yaml` (or `/sandbox on`
  for a session) turns it on, on macOS and Linux: then the AI's shell and your checks write only the project, temp and
  package caches, can't read `~/.ssh` or cloud logins, and reach only listed hosts. Casper's network server runs in a
  sandbox of its own either way, reaching only your login hosts. A one-shot or `--json` run, which can't ask, keeps the
  sandbox where one can run (Linux needs `sudo apt install bubblewrap socat`). [Sandbox](docs/SECURITY.md)
- **Private ssh passwords.** When an `ssh` or `scp` you allowed asks for a password or a key's passphrase, Casper
  shows its own hidden box (1 No · 2 Yes, this once · 3 Yes, for this session) and the password goes to ssh only,
  never to the AI, and is hidden wherever the AI reads. Nothing is saved; `ssh_login: off` turns it off.
  [Private ssh passwords](docs/CONFIGURATION.md#private-ssh-passwords)
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
| Tools | [GitHub](docs/GITHUB.md) · [Services](docs/SERVICES.md) · [Browser](docs/BROWSER.md) · [LSP](docs/LSP.md) · [Debugger](docs/DEBUGGER.md) · [Diagrams](docs/VISUALIZATION.md) · [Helpers](docs/DELEGATION.md) · [Crews](docs/CREWS.md) · [Learn](docs/LEARNING.md) |
| Setup | [Doctor](docs/DOCTOR.md) · [Configuration](docs/CONFIGURATION.md) · [Scripting](docs/SCRIPTING.md) · [Secrets](docs/SECRETS.md) · [Security](docs/SECURITY.md) · [Reader](docs/READER.md) |
| Platforms | [Support](docs/PLATFORM_SUPPORT.md) · [Testing a machine](docs/PLATFORM_VERIFICATION.md) · [Windows](docs/WINDOWS.md) · [Releases](docs/RELEASE.md) · [Evals](docs/EVALUATION.md) |
| Contributing | [How Casper is built](docs/ARCHITECTURE.md) · [Working on Casper](docs/DEVELOPING.md) |

## What's new

v0.2.37: helpers that build are off by default (turn them on in `/settings`; a project can only turn them off); when on, independent builders start together and substantial parts are reviewed before the receipt; receipts and `--json` runs show input, cached input, cache-write and output tokens, overall and per helper; and a debugger target that names a macOS command shim such as `python3` launches that command. See [release notes](docs/RELEASE.md).

v0.2.36: `casper new` opens an empty project without questions; terminal requests stay open for follow-ups (`-p` / `--print` runs once); optional plans ask only about build-changing choices, save editable specs and carry a checklist into the build; SGLang and MLX servers are discovered locally or by address; command approvals, pickers, the footer and live crew rows are clearer; verified background updates are on by default; and checks use related tests during work, then the unchanged configured test once at the end. See [release notes](docs/RELEASE.md).

v0.2.35: the live steps read in plain words, with Ctrl+O for the raw ones (MCP writes off moves to Ctrl+X); `/plan` numbers its steps and cases and takes changes in plain words; `/settings` is one grouped screen with search; a yes to a shell command covers that exact command; a task that rebases counts only its own edits and Undo leaves git's changes alone; Crews is complete, with full checks on the combined result and crews from any worktree; and on Windows `casper update` now works from the next update on (install 0.2.35 with the PowerShell line once). See [release notes](docs/RELEASE.md).

v0.2.34: `/login claude-subscription` reuses Claude Code's verified plan login or starts its browser sign-in; the model picker separates Claude Code plan from Anthropic API; login refreshes models without changing your current model or default, and an unavailable provider cannot report refresh success. Bulky old tool output becomes a history stub, and a failed final browser replay gets one bounded repair turn. See [release notes](docs/RELEASE.md).

v0.2.33: Casper asks less, as Claude Code does: with the sandbox off, routine shell commands such as `git commit`, `npm test` and `bun install` run without a box, and the AI's browser clicks, types, starts the project's dev script and serves a folder of plain files itself (each with a switch in `/settings`); a slow command moves to the background instead of being stopped, and a stalled one ends with the reason; browser checks end honestly on apps that work and page checks note what feels wrong to use; pictures come from your ChatGPT plan or a free model; Ollama models run as their Modelfile says; and your own slash commands, `/rewind` and `/review` are new.
[Release notes](docs/RELEASE.md#v0233-fewer-interruptions-a-browser-the-ai-drives-itself-and-slow-commands-that-keep-running) ·
[Roadmap](https://choaterboater.github.io/casper/roadmap.html).

## Contributing

See [docs/DEVELOPING.md](docs/DEVELOPING.md). To work from source (needs Bun, Git and Python 3):

```sh
git clone https://github.com/Choaterboater/casper.git
cd casper
bun install --frozen-lockfile
bun run check
```

## License

[MIT](LICENSE). Casper is built on the Pi SDK. Other parts keep their own licenses
([THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)).
