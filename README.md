# Casper

A coding helper for your terminal. Build web apps, APIs, command-line tools and scripts in the language
your project uses, and Casper checks the AI's work before it tells you "done". Network engineers get
extra care built in (Aruba, Juniper, Mist, MCP servers with writes off).

**Preview, unsigned.** This is an early preview, not a stable release. The programs are
not signed, so your system may warn you. macOS is tested by hand; Windows x64 install and
startup are tested in CI (PowerShell 5.1 and 7); Linux still needs testing on a real machine.
Some screen issues remain. See [release details](docs/RELEASE.md).

[MIT licensed](LICENSE). Casper is built on the Pi SDK. Other parts keep their own licenses
([THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)).

## Why Casper

Casper does not trust the AI when it says the job is done. It runs your project's own checks
(tests, lint, build) and, where it can, proves the tests fail without the change.
It is careful around network gear: MCP servers (tool servers the AI can call) start with
writes off, a login counts as read-only only when the product itself says so, risky actions
ask you, and the AI cannot approve anything for you.
Known device secrets (passwords, keys, SNMP communities) are swapped for `<secret hidden>`
before the AI sees them (best effort, known formats only).
Many things cost zero tokens: the checks Casper runs, `/verify`, `/mcp`, `/diff`, `/receipt`
and local reference search make no model call.
You can sign in with OpenAI Codex, GitHub Copilot, Anthropic (Claude) or OpenRouter, so you
are not tied to one model company.

## Highlights

- **Receipts with a verdict.** Every coding task ends with a short receipt; line 1 says
  `Verified`, `Checks passed — not proven`, `Failed` and so on. [Receipts](docs/VERIFICATION.md#receipts)
- **Proof, not just a pass.** `Verified` means the checks pass and a test fails without the
  change. [Proving the change](docs/VERIFICATION.md#proving-the-change)
- **Auto checks and repair.** After the AI edits files, Casper runs the project's checks and
  sends real failures back for a few repair tries (3 by default). A check that timed out or
  could not start is never sent to a paid repair. In a chat, checks that take a minute or more
  are offered as `/verify` instead. [Verification](docs/VERIFICATION.md)
- **MCP for network servers.** Works with hpe-networking-mcp, junos-mcp-server, Mist, NetBox
  and others. Every server starts with writes off; presets for known servers send their own
  read-only settings where one exists. Every change asks you in plain words: `1 No · 2 Yes, this
  once · 3 Yes, for this session`, or last `Yes to everything on <product> this session`;
  otherwise destructive changes always ask. Firmware, delete and admin changes stay off until
  you allow them (in the box or with `/mcp allow`). Only you can answer.
  [MCP](docs/MCP.md) · [Presets](docs/MCP.md#presets)
- **Casper sets up its network server.** Ask about Mist, Central or ClearPass (or type
  `/mcp setup network`) and Casper offers `1 Not now · 2 Set it up` once. `2` installs a pinned,
  hash-locked [casper-network-mcp](https://github.com/Choaterboater/casper-network-mcp) (and uv
  first, with uv's own installer, when it is missing) and connects it read-only. Each product's login is asked the first time it is used, typed by you
  (never the AI), and kept in Casper's own private file. Central is new Central (GreenLake)
  only for now. [Casper's network server](docs/MCP.md#caspers-network-server)
- **Read-only only when the product says so.** A server's `access_check` tool can confirm a
  read-only login; anything else shows `access not checked`. [Access check](docs/MCP.md#access-check)
- **Check your own MCP server.** `casper mcp check [repo]` runs its tests and checks its
  labels, schemas and example configs. It runs the repo's code, so use it on repos you trust.
  [Check a server you built](docs/MCP.md#check-a-server-you-built)
- **Secrets hidden from the AI.** Known formats in MCP results and config files are hidden
  (best effort, not every secret). [Secrets](docs/SECRETS.md)
- **References.** Search local copies of vendor specs and SDKs (Junos YANG, pycentral, mistapi)
  without a model call. [References](docs/REFERENCES.md)
- **Scripting and CI.** `--json` streams events, and exit codes tell a script what happened
  (for example 3 = not verified with `--require-verification`). [Scripting](docs/SCRIPTING.md#exit-codes)
- **Services, browser, language servers, debugger.** Optional: run your dev server,
  debug in an installed Chrome/Edge, use a language server (LSP) for code smarts, or a local
  debugger (DAP). [Services](docs/SERVICES.md) · [Browser](docs/BROWSER.md) · [LSP](docs/LSP.md) · [Debugger](docs/DEBUGGER.md)
- **Sessions.** Pick up a past chat (`--continue`, `/resume`) or try an idea in a named
  branch with its own Git worktree (a separate folder). [Sessions](docs/SESSIONS.md)
- **Numbered choices.** Questions show numbered answers; press the number to pick.
  [Terminal guide](docs/TERMINAL_UX.md)
- **Rich or plain terminal.** A live footer, colors and lines that update in place, or plain text with
  `NO_COLOR`, `TERM=dumb` or redirected output. [Terminal guide](docs/TERMINAL_UX.md)
- **tmux, automatic.** Inside tmux (or iTerm2, after one question) the busy steps go to a view-only side
  pane on a wide window that Casper opens and closes itself; `/pane off` turns it off. `/tasks` lists
  what runs in the background. [tmux](docs/TMUX.md)

## What a receipt looks like

```text
✓ Verified · test passed · changed sum.js
```

When all is well it is one line. `Verified` means the checks pass and a test fails without the
change. Anything less says why on its own line, for example:

```text
• Not verified — no configured check covers the changed files.
✓ changed README.md
```

`/receipt` shows the full detail behind the last receipt.

## Install

No Bun install or source checkout is needed.

**Windows x64 — PowerShell:**

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Choaterboater/casper/releases/download/v0.2.22/install.ps1 | iex
```

Then run `casper` from your project folder. If your terminal does not find it, open a new
terminal. Windows ARM64 has no release file yet.

**macOS / Linux:**

```sh
curl -fsSL https://github.com/Choaterboater/casper/releases/download/v0.2.22/install.sh | sh
```

The installer checks the file's SHA-256 and runs the new program's `--version` before it
replaces an older install. If the download is rejected, your old install stays as it was.
It needs no admin rights. These commands pin **v0.2.22**: running them again reinstalls that
preview. After the first install, `casper update` gets the newest preview (it runs that
release's own installer, with the same checks), and `casper update --check` only says whether
there is one. A session also tells you when one is out: one `[update]` line at the start, from a
check it makes in the background at most once a day (no model, no tokens). Turn it off with
`/settings` (New-version notice) or `CASPER_NO_UPDATE_CHECK=1`. If GitHub says it is limiting requests, set `GITHUB_TOKEN` (or `GH_TOKEN`) to a
GitHub token for a higher limit. Useful `install.sh` options: `--dir <path>`, `--version 0.2.22`, `--sha256 <hex>`
and `--force` (replace a development symlink). [Installer details](docs/RELEASE.md).

## Quick start

```sh
cd your-project
casper
```

If you start Casper in your home folder or a folder that only holds projects (such as
`~/Projects`), it asks which project to open: press its number, or Esc to stay.

**Sign in.** Type `/login` and press a number: one list of providers and ways to sign in,
OpenRouter first (Enter picks it), then Anthropic, OpenAI Codex and GitHub Copilot. If you skip this, Casper opens sign-in on your first request and picks that
provider's default model (OpenRouter: `deepseek/deepseek-v4.1-flash`). `/model` picks another;
Casper never replaces a model you chose. Type keys or codes only in the private login prompt,
never in chat. Your provider's plans and charges still apply.

**A first task.** Type what you want, for example `Fix the failing test in sum.js`. Casper
works, runs the checks, and ends with a receipt.

One-shot runs from the shell:

```sh
casper "Explain this project"
casper --verify "Fix the failing tests"
casper --no-verify   # no Casper-run checks this run
casper --version     # casper 0.2.22 (/absolute/path/of/the/binary/or/cli.ts)
```

**About checks.** A check runs your project's own command without asking first, and it is not
in a sandbox (a sealed-off area). Use Casper only in projects you trust, or start with
`--no-verify`. `verification.mode` in `.casper/project.yaml` sets `auto`, `offer` or `off`.

### Everyday commands

| Command | What it does |
| --- | --- |
| `/help` | Short command guide; `/help <word>` searches it, `/help all` shows everything |
| `/status` | Project, model and connections |
| `/model`, `/effort` | Pick a model and how hard it thinks (`/effort auto` lets Casper choose) |
| `/verify` | Run the checks with no model |
| `/verify repair test` | Let the AI fix a failing test check, with a limit |
| `/receipt` | Full detail behind the last receipt |
| `/diff`, `/undo` | The last task's changes; put its files back |
| `/output [n]` | Full output of a recent tool call |
| `/clear`, `/resume` | Start fresh or bring back a chat (does not undo file changes) |
| `/mcp` | MCP servers: status, connect, writes on/off |
| `/secrets` | What secret hiding is doing |
| `/permissions` | What Casper can and cannot do |
| `/settings` | Turn web lookups, spend notes and other switches on or off by number |

Ctrl+C stops the current work but keeps changes already made. On an empty prompt, a second
Ctrl+C within two seconds exits; Ctrl+D exits at once.

## Safety and privacy

Every shell command Casper runs (the AI's shell, your checks, services and dev servers) goes
through one sandbox on Linux (bubblewrap) and macOS (`sandbox-exec`): it writes only the project,
temp and package caches and can't read `~/.ssh` or cloud logins. The AI's shell and your checks
reach only listed hosts (others ask first); services and dev servers keep the machine's network on
Linux (on macOS they reach only listed hosts too), and you can reach them on localhost either way.
On Windows, or Linux without bubblewrap, nothing holds the shell: the AI's shell asks before each
command that changes something (reads like `ls` or `git status` don't), and your checks run with your permissions. Worktrees, read-only agent roles and
connection prompts do not isolate anything at the OS level. See [SECURITY.md](docs/SECURITY.md).

Your code, tool output and chat may go to the model provider you picked, and may stay on
disk as plain text. Secret hiding covers known formats only ([SECRETS.md](docs/SECRETS.md));
there is no full secret scanner and no hard spending cap.

A passing check shows a command passed, not that the code is fully right. Missing or old
results are not a pass. Review important changes yourself.

## Learn more

| Doc | What it covers |
| --- | --- |
| [VERIFICATION.md](docs/VERIFICATION.md) | Checks, receipts, proof and the repair loop |
| [MCP.md](docs/MCP.md) | Connecting MCP servers, presets, writes on/off, `casper mcp check` |
| [SECRETS.md](docs/SECRETS.md) | Which secrets are hidden from the AI, and the limits |
| [REFERENCES.md](docs/REFERENCES.md) | Local search of reference code and vendor specs |
| [SCRIPTING.md](docs/SCRIPTING.md) | One-shot runs, `--json`, exit codes, CI |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | Config files, model roles and skills |
| [TERMINAL_UX.md](docs/TERMINAL_UX.md) | The terminal screen, keys and commands |
| [TMUX.md](docs/TMUX.md) | tmux and iTerm2: the side pane, reattaching, `/tasks` |
| [SESSIONS.md](docs/SESSIONS.md) | Named sessions and worktree experiments |
| [SERVICES.md](docs/SERVICES.md) | Dev servers Casper starts and stops for you |
| [BROWSER.md](docs/BROWSER.md) | Debugging with an installed browser |
| [LSP.md](docs/LSP.md) | Language servers for errors, lookups and renames |
| [DEBUGGER.md](docs/DEBUGGER.md) | Local step debugger (DAP) |
| [DELEGATION.md](docs/DELEGATION.md) | Read-only helper agents that explore or review |
| [MEMORY.md](docs/MEMORY.md) | Project facts you save and past task results |
| [LEARNING.md](docs/LEARNING.md) | `casper learn`: draft patterns from a repo, you decide |
| [VISUALIZATION.md](docs/VISUALIZATION.md) | Diagrams of code and systems |
| [EVALUATION.md](docs/EVALUATION.md) | Casper's test suite with real model tasks |
| [RELEASE.md](docs/RELEASE.md) | What is in each release, and the installers |
| [PLATFORM_SUPPORT.md](docs/PLATFORM_SUPPORT.md) | macOS, Linux and Windows status |
| [PLATFORM_VERIFICATION.md](docs/PLATFORM_VERIFICATION.md) | How to test Casper on a new machine |
| [WINDOWS.md](docs/WINDOWS.md) | Windows preview checklist |
| [NEW.md](docs/NEW.md) | `casper new`: new projects from templates with no model |
| [NETWORK-CHECKS.md](docs/NETWORK-CHECKS.md) | Ansible, Junos and lab checks |
| [SECURITY_CHECKS.md](docs/SECURITY_CHECKS.md) | `/security-review` and `casper security` |
| [UNDO.md](docs/UNDO.md) | `/undo`, `/redo`, `/diff` per task and saved receipts |
| [SECURITY.md](docs/SECURITY.md) | The shell sandbox, what Casper keeps from the AI, and what it doesn't |
| [SKILLS.md](docs/SKILLS.md) | The built-in network skills, adding your own and turning them off |

Project notes (for people working on Casper): [design decision](docs/adr/0001-casper-own-product.md),
[eval results](docs/evals/),
[pre-release review](docs/PRE_RELEASE_REVIEW.md).

When you report a problem, include your OS, the command, the exact error, and whether a
browser or debugger was installed. Remove secrets and private paths from logs first.

## What's new since v0.2.15

v0.2.21 shipped everything from v0.2.16 to v0.2.20 in one release; v0.2.22 is the newest, and the
install commands above give it. What each version changed, in more detail:
[RELEASE.md](docs/RELEASE.md).

**v0.2.16: build new things.**
- `casper new` (and `/new`) starts a new project from a template (Python tool, MCP server for
  your network, Mist scripts, web app, NOC dashboard, Aruba CX and Junos Ansible) with no model
  and zero tokens. [NEW.md](docs/NEW.md)
- Page checks: in a web project Casper starts the dev server and opens the changed pages
  (`✓ /dashboard loads · 0 console errors`); SQLite migrations run on a throwaway database.
  [Page checks](docs/VERIFICATION.md#page-checks)
- When repairs run out, one more try on your big model, only if you pick it; Enter stops.
  Suggested next steps under the receipt, and "plan first" for bigger requests.
- Network checks (Ansible syntax, Junos render, Junoser, hier_config, and lab checks you start
  yourself) and security checks (`/security-review`, `casper security`: gitleaks, semgrep and
  more, no model). [Network checks](docs/NETWORK-CHECKS.md) · [Security checks](docs/SECURITY_CHECKS.md)
- Enter is always the safe choice at Casper's numbered questions: choice 1 never builds,
  spends tokens, remembers or reaches a lab.
- Safety fixes: the AI's file tools stay out of `~/.ssh` and login files and don't follow links
  out of the project; `.env` and credential file values are hidden from the AI; checks and dev
  servers run without AI provider keys.

**v0.2.17: undo and a real safety net.**
- `Next: 1 Show diff · 2 Undo` after each task; `/undo`, `/redo`, `/diff` and `/receipt` work on
  any saved task, also after a restart and outside git. Undo never overwrites a file you changed
  since. [UNDO.md](docs/UNDO.md)
- A shell sandbox on Linux (bubblewrap, socat and ripgrep: `sudo apt install bubblewrap socat ripgrep`) and macOS:
  the AI's shell, checks, services and dev servers write only the project, temp and package
  caches, can't read `~/.ssh` or cloud logins, and reach only listed hosts (others ask). On
  Windows, or Linux without bubblewrap, the AI's shell asks before each command that changes something (reads like `ls` don't).
  [SECURITY.md](docs/SECURITY.md)
- A stricter "verified": `--require-verification` exits 3 unless the change is proven, so
  `• Checks passed — not proven` exits 3 too; the JSON `checksPassed` field still says the
  checks passed. [Exit codes](docs/SCRIPTING.md#exit-codes)
- An optional AI security review after `/security-review`, which asks first and shows its cost.
- The plan editor asks "Build this plan?" before it builds.

**v0.2.18: network skills.**
- Short built-in how-to files for Mist, Central (new and classic), AOS-CX, Junos and ClearPass,
  loaded only for a request that names the product, with no model call to pick them. Each one
  tells the AI to stop and ask you before any change. `skills.bundled: false` turns them
  off. [SKILLS.md](docs/SKILLS.md)
- More SDKs for local search: `/references add pyaoscx`, `pyclearpass`, `mistapi` and
  `junos-pyez`. [References](docs/REFERENCES.md)

**v0.2.19: asks before reaching other machines.**
- Before the AI's shell reaches another machine (`ssh`, `scp`, `rsync`, `nc` …), Casper asks
  `Reach 198.51.100.20 (build-server)?` with No first; a script run refuses it and never waits.
  [SECURITY.md](docs/SECURITY.md)
- `~/.ssh` stays private in the shell too, with the sandbox off; lab logins in notes, Proxmox
  tokens and passwords typed into commands are hidden from the AI and the screen.
  [SECRETS.md](docs/SECRETS.md)
- The receipt lists what the AI changed on other machines, and what Casper stopped before it got
  there; when the work lands in a project inside the folder, that project's tests run and Casper
  offers to switch there. [VERIFICATION.md](docs/VERIFICATION.md)
- A quieter screen, each task's tokens and cost in the footer (notes at $1 and $5; set `spend.pauseAt` for a pause), and
  tmux and iTerm2 support with nothing to set. [TMUX.md](docs/TMUX.md)

**v0.2.20: fewer layers.**
- `casper new` asks the kind first (Network, MCP server, Web app or dashboard, Python tool, My
  own), then which one, with Back first. My own is an empty folder with git.
- The AI does the next step in your project itself instead of telling you to edit a file, builds
  things on by default (with an off switch), and keeps risk notes to one line.
- A write outside the project asks once, naming the folder: `1 No · 2 Yes, this once · 3 Yes, for this session`. This covers
  the AI's shell and its edit and write tools.
- `web_search` and `web_fetch`: the AI can look things up (DuckDuckGo by default, no key). Public
  pages only; a lookup holding a secret is refused. `web: off` turns them off.
- Quieter receipts: no repeated "not verified" lines, and no receipt for a question.
- Honest usage: `/usage` shows `44k out · 131k new · 4.9M cached`, and a subscription sign-in
  says `sub ≈$0.31` in the footer instead of showing a list price as the cost.
- Swift packages get `swift test` and `swift build`; a Python build check needs the build tool.
- Caching: the long cache only where it costs nothing extra, one tool list per session (MCP tools
  included) so the cache isn't thrown away, and the cache hit rate in `/usage`.

**v0.2.21: a clearer screen, and pages checked on a phone.**
- The window title names the conversation (`Casper · subnet calculator`, `◐` while it works).
  `display: quiet|normal|detailed` in your config, `/details` for the session; Ctrl+T shows the
  last step in full. When detailed, a small diff shows under each edit. The task's result gets a
  colored edge: green for a pass, red for a failure, yellow in between.
  [Display](docs/CONFIGURATION.md#display)
- Page checks open each page at phone width (390px) too and fail a page that scrolls sideways or
  squashes a text field; a plain Bun or Node site (an `index.html` and a `dev` or `start` script
  that runs its own server file, `bun run server.ts` or `node server.js`) gets a page check too.
  [Page checks](docs/VERIFICATION.md#page-checks)
- A request typed at the empty-folder question runs in that folder.
- Browser fill works on number, email, date, time and range fields; `no-horizontal-overflow` can
  name one element; replay accepts the placeholder scenario some models attach to every call.
  [BROWSER.md](docs/BROWSER.md)
- The receipt's browser line says so when the answer claims the browser checks passed and
  Casper's record says they failed, or none of them finished.

**v0.2.22: one box for every yes, and a network server Casper sets up.**
- Casper sets up its network server for Mist, Central and ClearPass with one question
  (`1 Not now · 2 Set it up`): casper-network-mcp 0.1.1, hash-locked, connected with writes off.
  Each product's login is asked the first time the AI uses it, typed by you, and a login the
  product turns down asks to be replaced. [Casper's network server](docs/MCP.md#caspers-network-server)
- Every approval is one numbered box (`1 No · 2 Yes, this once · 3 Yes, for this session ·
  4 Yes, always for this project`, only the answers that fit); nothing asks you to type `yes`.
- The MCP change box says what changes and where the login reaches. Firmware, deletes and admin
  changes are off by default; `/mcp allow` picks them ahead of time. "Yes to everything" covers
  every change on that product, those included, and shows `ALLOW ALL` until ctrl+o. [Change kinds](docs/MCP.md#change-kinds-and-mcp-allow)
- Device checks reach any device, only after your answer; the box names devices not marked lab.
  `/lab import <file>` fills your lab list. [Your lab](docs/NETWORK-CHECKS.md#your-lab)
- The receipt lists risky config lines a task added (`reload`, `shutdown`, `erase` …), as a
  report, never a pass or a fail.
- With no sandbox, plain reads (`ls`, `grep`, `git status`) don't ask, and a command prefix such
  as `npm test` can be allowed for the session or the project.
- Enter during a task steers the AI or queues the line for after it; look-only commands run
  during work, and provider retries show as they happen.
- `/login` is one numbered list, model errors say the cause and one next step, `/settings` turns
  switches on or off by number, and `casper update` installs the newest preview.
- Windows fixes: undo, session worktrees and browser sign-in, and the installer keeps your PATH as it was.

## Planned next

**v0.3: crews** (planned, not started).
- For a big job, the AI splits the work on its own: builders in their own copies of the project,
  a reviewer for each part, a fixer, then one merge and the full tests. No command needed.
- The status bar shows the crew (`crew 2/3 building · 1 reviewing · $0.40`), and `/crew` shows
  each part. You keep chatting while it works, and it reports when the parts land.
- A crew adds no spending limit: the cost is shown as it runs, and a limit said in your request
  ("keep it under $2", "no crew for this") holds for the whole crew. `crew: off` turns crews off.

Later, not scheduled: vendor packs (`casper pack add aruba` sets up a vendor's MCP server,
read-only preset, references and skill in one step), chat that investigates your infrastructure,
a reader for untrusted text that hands back only strict JSON, scheduled jobs with an AI on call, `casper doctor` (Casper checks and fixes its
own setup), a terminal check (Casper tries a command-line program like a person), community lessons (fixes proven by passing checks, shared as a pack) and tool rules you
write (for example, bounces only on lab sites in a maintenance window). See the [roadmap](https://choaterboater.github.io/casper/roadmap.html#later).

## Develop from source

Needs Bun, Git, and Python 3 (for the POSIX terminal tests):

```sh
git clone https://github.com/Choaterboater/casper.git
cd casper
bun install --frozen-lockfile
bun run dev
bun run check
```

To run the checkout as `casper`, link `src/cli.ts` to `~/.local/bin/casper` (run
`chmod +x src/cli.ts` first). `casper --version` prints `casper <version> (<path>)`, so a stale
link is easy to spot. The release installer will not replace such a link without `--force`.
In a checkout, `casper update` pulls (fast-forward only, never forced) and runs
`bun install --frozen-lockfile` when `bun.lock` changed. A session in a checkout says how many
changes it is behind, the same way.

`bun run check` needs no paid model. Browser and debugger tests skip when those tools are not
installed. Build the program for this machine with `bun run build:release`, or all five
release targets with `bun run build:release -- --all`. [Host testing](docs/PLATFORM_VERIFICATION.md).

The optional [evaluation suite](docs/EVALUATION.md) runs real model tasks and may cost
provider usage: `bun tools/eval.ts --list` shows the tasks.
