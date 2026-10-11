# Casper doctor

**What this is:** one command that looks over Casper's own setup, fixes what it
safely can, and names the rest in one plain line each. No model, no tokens.
**When you'd use it:** after installing or updating Casper, when something that
worked stops working, or on a new machine.

```sh
casper doctor
```

Inside Casper, type `/doctor`. It runs the same checks, and also says why an MCP
server this session tried to start did not.

## What it shows

Each line starts with a mark:

- `✓` fine.
- `!` worth knowing; nothing is broken (an optional piece is not set up, a newer
  Casper is out).
- `✗` something to fix. The line under it (`→`) is the one thing to do.

```text
Casper doctor · no model, no tokens
✓ Casper 0.2.32, the newest release
✓ casper on PATH is this one (~/.local/bin/casper)
✗ ~/.casper/config.yaml doesn't load: line 3, column 6: Block collections are not allowed within flow collections
    → fix that line, or move the file away to start fresh
✓ Sign-in: anthropic, openrouter
✗ MCP mist: can't start: uvx is not installed
    → It comes with uv: https://docs.astral.sh/uv/getting-started/installation/
! TypeScript: no language server set up (optional)
    → docs/LSP.md
✓ Sandbox: can hold shell commands here
✓ Disk: 184.3 GB free
2 things to fix (✗), 1 worth knowing (!).
```

## What it checks

| Check | What it looks at |
| --- | --- |
| Casper | This version against the newest published preview (one GitHub lookup; `CASPER_OFFLINE=1` skips it). A `casper` on PATH that is a broken link or an older copy than this one. A Windows update that did not finish (from `~/.casper/update.log`), with the log and the install one-liner |
| Config files | `~/.casper/config.yaml`, `mcp.json`, `lsp.json`, your profile's files, the sign-in and model files in `~/.casper/agent`, and the project's `.casper/project.yaml`, `.casper/mcp.json`, `.casper/lsp.json`, `mcp.json` and `.mcp.json`. A file that does not load is named with its line and column. Then Casper's own settings check, and unknown keys |
| Sign-in | Each provider you signed in to, provider keys in the environment, and providers in `~/.casper/agent/models.json` that have their own key or address (a local server or a company gateway), and model servers Casper finds on this computer or where `OLLAMA_HOST` and the like point (Ollama, LM Studio, llama.cpp, vLLM; not with `localModels: false`). A server a variable points at that doesn't answer is a note saying why (timed out, refused, asked for a key…), with what to set on that computer when it is another one. The model servers you added in `/model` are listed too (with `localModels: false` as well), each with its address and model count, or a note saying why it didn't answer. A sign-in that renews itself is fine; one that has run out and can't renew says `/login <provider>`. Nothing is sent but a look at those servers' model lists, with no key: no request to a model, no tokens. Keys are never shown |
| MCP servers | Each server's program is installed (a missing `uvx`, `npx`, `bunx`, `docker`, `node` or `python` gets its install page), each `${VAR}` it needs is set, and its start folder exists. The doctor never starts a server: starting one is your yes (`/mcp connect`). In a session, a server that failed to start says why |
| Language servers | The project's languages (TypeScript, Python, Go, Rust, from their usual files) against the servers in `lsp.json`. No server for a language is `!` (optional); a server whose program is missing is `✗` |
| Security tools | The pinned tools this project uses (as `/security-review` picks them): not installed yet, or your own copy of another version than Casper pins |
| Sandbox | Whether the sandbox can hold commands on this machine: on Linux, bubblewrap and socat, and ripgrep when Casper has none of its own (with the `sudo apt install` line) and Ubuntu's AppArmor rule; on macOS, `sandbox-exec`. Windows has no sandbox yet (`!`) |
| Disk | Free space where `~/.casper` lives: under 2 GB is `!`, under 512 MB is `✗` |
| Network server | Casper's network server: installed version against the one this Casper pins (or a newer release the daily check found), and which products have a saved login (Mist, Central, ClearPass). Your own network server is named. Not set up is `!`, and not shown once you said Not now to setup |

The project checks (language servers, security tools, project config files) run
when you start the doctor in a project folder.

## Fixes it makes

Only three, each after its own numbered question, where `1` (and Enter) is
always Not now:

| Problem | Question | `2` does |
| --- | --- | --- |
| A newer Casper is out | `1 Not now · 2 Update now` | Runs `casper update` |
| Security tools missing | `1 Not now · 2 Install them` | Installs the pinned tools, every download checked by hash, as `/security-review` does |
| Network server not installed or out of date | The network setup's own question | Runs `/mcp setup network`. From the shell this re-installs or updates it; setting it up the first time needs a session (it connects the server and remembers your yes) |

Everything else is named with the one thing to do. After a fix, the doctor
checks again and lists what is left.

## Scripts

`casper doctor` with no terminal (in a script or a pipe) prints the report and
asks nothing. Exit codes:

- `0` nothing to fix (`!` lines don't count)
- `1` something to fix (a `✗` line)
- `64` usage mistake

The doctor runs outside the shell sandbox, like `casper update`: it fixes your
own install. The only programs it runs itself are `casper --version` (when the
`casper` on PATH is another copy) and the security tools' `--version`.
