# Release process and installers

**What this is:** what changed in each Casper release, how releases are built and
published, and what the installers promise. **When you'd use it:** to see what is new
before you upgrade, or when you build or publish a release yourself.

Casper distributes an unsigned **v0.2.31 preview**, not a stable release. The installers
download from `https://github.com/Choaterboater/casper/releases/download/v0.2.31`,
because GitHub's `latest/download` link skips preview releases. The first published
preview was **v0.1.0**. A published release is never changed; every fix ships under a
new version.

## v0.2.31: steps under the AI's words, the sandbox off unless you turn it on, and Pi 1.1.0

The screen groups the work: the AI's steps tick in under its words, then fold into one row that names what was
done, with edits and failures in a box. The shell sandbox is off unless you turn it on: until then the AI's shell
asks before commands that change things, and your checks run with your own permissions. Casper runs on Pi 1.1.0, a
Claude plan sign-in works with Opus 5.5 (and with newer models once the Claude Code installed here knows them),
`/model` opens on the providers, and a model server on another computer is found, or Casper says why.

- Steps tick in under the AI's words, then fold into one row naming what was done, with edits and failures in a box
- One status row above the prompt says what runs and that Esc stops it; the Working box is gone
- The receipt says a session's notes in full once, then in one line; a warning marked `⚠`, such as a secret in a command, comes right after the verdict
- The shell sandbox is off unless you turn it on (`sandbox: on`, `/sandbox on`); until then the AI's shell asks before commands that change things, and your checks run with your own permissions without asking
- Pi 1.1.0: Claude Sonnet 5.5, Claude Haiku 5.5 and GPT-6.1 Sol in `/model`, and a busy provider is tried again
- A Claude plan sign-in works with Opus 5.5, and its requests name the Claude Code installed here when it is newer
- `/model` opens on the providers; `/model <words>` still opens on the list
- A model server on another computer (`OLLAMA_HOST` and the like) gets 10 s to answer, and Casper says in plain words why one didn't
- casper-network-mcp 0.1.3 is the version Casper ships with
- A file or branch name with `login` in it is not taken for a login, words in a link don't pick a skill, the contrast note reads Tailwind v4 colours, and a test that timed out in the middle of a long run asks instead of starting a repair

**Steps under the AI's words.** The AI's words lead with `●` and sit two columns in. A code block stays at the
left edge, full width, so it still copies clean. Your request shows again in bold on a bar: grey in the default
theme, white in `light`, none in `high-contrast`. A theme file sets the bar with `userBg` (`default` or `dim` means
no bar), and a theme file without `userBg` gets the grey bar. One blank row sits between blocks, never two. Each
step ticks in under the words that led to it. When the AI's next words come, the steps fold into one row that
names what was done: `└ read AGENTS.md · ran git status, bun test (2m05s)` (a command that ran 10 s or more says
how long). The edits go in one box, `Edited 2 files`, with a short diff: ten rows at most, then
`… 11 more lines · Ctrl+T shows all`. A failed step gets a box with its line as the title
(`✗ bash · git push — failed`) and the last lines it printed, with secrets hidden and your home folder as `~`.
Ctrl+T shows the last box in full. A file written whole has no diff to show: when no other edit in the group has
one, there is no box and the row names it (`edited new.py`). `/details quiet` shows only what failed or did not
run, and `/details detailed` shows every step and each edit's whole diff. Inside tmux or with an iTerm2 split, the
steps still show in the side pane; the main screen now also keeps the status row, the row they fold into and the
boxes. Plain terminals, pipes and `--json` still print one line per step.

**One status row.** The Working box is gone. While work runs, one row above the prompt says what Casper is doing
and that Esc stops it: `Running bun test · 4s · Esc stops`. It steps aside while a question or a picker waits for
you. A script names its programs (`git rev-parse, git log, git diff`), and a heredoc says how long it is
(`python3 script (12 lines)`). An open question's top border says who asks: `── Approval ──` for Casper's
approvals, `── Question ──` for the AI's questions, and `── Choose ──` for Casper's own pickers.

**A shorter receipt.** A warning to act on, marked `⚠`, comes right after the verdict, such as
`⚠ Not proven: …`. A secret in a command now gets `⚠` too:
`⚠ A secret appeared in a command; change it after this task.` Two notes are about the session, not the task: the
sandbox being off, and `Changes unknown: not a project folder (…)`. The first receipt of a session says them in
full. Later receipts say them in one line, such as `– Same as before: not sandboxed (/receipt)`. A note is said in
full again when its reason changes. `/receipt`, `--verbose` and `--json` always say every note in full.

**The sandbox is off unless you turn it on.** Where you type to Casper, the shell sandbox now starts off. Until you
turn it on, the AI's shell asks before each command that changes something (`Run this command?`; reads like `ls`
don't ask), and a write outside the project asks first. Your checks, services and dev servers run with your own
permissions, and checks still run without asking: for code you don't trust, turn the sandbox on or use
`--no-verify`. A command you say yes to runs with your own permissions too. When it is off, the banner and
`/status` say
`not sandboxed (off unless you turn it on: /sandbox on) · Casper asks before AI shell commands that change things`,
and the receipt says
`Shell commands and checks were not sandboxed (off unless you turn it on: /sandbox on, or sandbox: on in ~/.casper/config.yaml)`.
`sandbox: on` in `~/.casper/config.yaml` turns it on for every session, `/sandbox on` turns it on until Casper
exits, and `/sandbox off` turns it off again. A `sandbox:` block that only lists hosts, folders or `checks` does
not turn it on: add `enabled: true` to it to keep the sandbox you had. While it is off by default, `/sandbox off`
changes nothing and the shell keeps asking: `The sandbox is already off: it is off unless you turn it on. Casper
asks before shell commands that change things.` To stop the questions without the sandbox, use `/permissions all`,
`sandbox: off` or `--no-sandbox`.

**Where the sandbox stays on.** A one-shot or `--json` run can't ask, so it keeps the sandbox where one can run,
and so do `casper security` and `casper mcp check`. Casper's network server keeps its own sandbox where one can
run, also after `/sandbox off`; only `sandbox: off` or `--no-sandbox` turns that off. After `/sandbox on`,
`/sandbox off` works as in v0.2.30: commands run with your own permissions without asking. While the sandbox is off
by default and the shell asks, the AI starts no builders, and a `/crew` builder's commands that change things are
refused, since a builder can't ask; `/sandbox on` brings them back. `casper doctor` says
`Sandbox: off unless you turn it on (sandbox: on in ~/.casper/config.yaml, or /sandbox on); it can run here`, and a
missing bubblewrap is a note, not something to fix, until you turn the sandbox on. Windows is unchanged.

**Pi 1.1.0.** Casper now runs on Pi 1.1.0, up from 0.87.0. `/model` adds Claude Sonnet 5.5 and Claude Haiku 5.5
under `anthropic` (and under `claude-subscription`, as `Claude Haiku 5.5 (Claude subscription)`), and GPT-6.1 Sol
under `openai`, `openai-codex` and `github-copilot`. When a provider says it is busy or at capacity, Pi now tries
again, with the usual line `– Can't reach <provider> · trying again in 4s (1 of 3) · Esc stops`. Before, the turn
ended. `/login anthropic` with **Anthropic (Claude) · sign in with your browser** works as before: Pi now asks
whether to use the browser or copy a code, and Casper picks the browser for you. You can still paste the code or
redirect URL. The AI's shell commands and Casper's checks no longer see the variables for Anthropic's federation
sign-in (`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`,
`ANTHROPIC_IDENTITY_TOKEN_FILE`, `ANTHROPIC_WORKSPACE_ID`) or `TYPESAFE_API_KEY`, and `casper doctor` lists them on
its `Sign-in:` line. Pi renamed the `azure-openai-responses` provider to `azure`, so pick a remembered Azure model
again in `/model`.

**Opus 5.5 and new Claude models with a Claude plan.** With a Claude plan sign-in (`/login anthropic`, then
**Anthropic (Claude) · sign in with your browser**), each request names a Claude Code version, and Anthropic
refuses newer models to an old one. Casper 0.2.30 named 2.1.251, so Opus 5.5 was refused:
`Claude Code 2.1.251 does not support this model; version 2.1.280 or newer is required`. Requests now name 2.1.280,
so Opus 5.5 works. When Claude Code is installed on this computer and is newer, Casper names the installed one, so
a new model works once Claude Code knows it, with no new Casper. Casper asks `claude --version` (`claude.exe` on
Windows) once a run, at the first such request, and waits at most 3 seconds; `CASPER_CLAUDE_PATH` names the program
when it is not on your PATH. Casper's own one-off calls (the checklist, `/btw` answers) still name 2.1.280. An API
key and `claude-subscription` were never affected.

**`/model` opens on the providers.** `/model` now opens on the providers on the left: `All models`, then each
provider. Up/Down there picks whose models show, and each provider starts at its first model. Enter, Tab or Right
moves to the list, and Tab goes back. Typing searches from either side, and Esc cancels from either side with one
press. Ctrl+S on the providers picks the list's marked row for this session only. The line under the list shows
the keys for the side you are on, such as `Up/Down providers · Enter or Tab models · type to search · Esc cancels`
on the left. Picking from a plain `/model` takes one more key, since Enter on the providers moves to the list. When
`/model <words>` opens the picker, it still opens on the list, already searched, so Enter picks at once.

**A model server on another computer.** Ollama, LM Studio, llama.cpp or vLLM on another computer (a box on your
network or a Tailscale peer) shows in `/model` when you point its variable at it, in the shell that starts Casper:
`OLLAMA_HOST=192.0.2.10`, `LM_STUDIO_BASE_URL=http://192.0.2.10:1234`, `LLAMA_CPP_BASE_URL=…` or `VLLM_BASE_URL=…`.
A server on another computer gets 10 s to answer, one on this computer keeps 0.8 s, and each is looked at on its
own, so a slow or switched-off box never holds up the others, a line you type, or a start whose saved model is a
cloud one. When one doesn't answer, Casper says why in plain words, such as
`Ollama at http://192.0.2.10:11434 (OLLAMA_HOST) refused the connection (nothing is listening on that port).`:
at your first request, under the header in `/model`, in `casper doctor`, and as the reason a saved model is
unavailable. For another computer it adds what to set there (`OLLAMA_HOST=0.0.0.0 ollama serve`, LM Studio's
**Serve on Local Network**, `--host 0.0.0.0`, the firewall), and that these servers have no password by default. A
model typed by name
(`/model ollama/qwen3:8b`), a `/model` with nothing to list, and a request on a saved model whose server was
asleep at the start (a VPN not up yet) look once more. A found server that answers with a redirect gets an error,
so your conversation is never sent on to another address (a provider you set up in `models.json` is not covered).
A server on another computer is never picked as your model for you; pick it in `/model`.

**Network server 0.1.3.** Casper now ships with casper-network-mcp 0.1.3 and its hash lock. Setting it up says
`Casper can set up its network server (casper-network-mcp 0.1.3, about 60 MB from pypi.org, installed with uv into ~/.casper/tools).`
If Casper set up 0.1.2 for you, your first request in a session asks
`Casper's network server has an update (0.1.2 → 0.1.3, about 60 MB from pypi.org).` with `1 Not now · 2 Update it`,
even with **Network server updates** off, because 0.1.3 is now the version Casper ships with. `/mcp` shows
`network: update ready (0.1.2 → 0.1.3) — /mcp setup network`. If you already took 0.1.3 from the daily offer,
nothing changes. If you said Not now to it, Casper doesn't ask again at start, and `/mcp setup network` still
updates it.

**Smaller fixes.** A file or branch name with `login`, `sign-in` or `account` inside it (`tests/login.test.ts`,
`fix/login-expired`) no longer hides the next name as a password or makes the receipt say a secret appeared in a
command; `login admin / <secret hidden>` is still hidden. Words inside a link in your request (`https://…`,
`github.com/owner/repo`) no longer pick one of your skills, or a project's or a pack's: a repository named
`casper-network-mcp` doesn't load a skill tagged `mcp`, while `the mcp server` written out still does. The page
check's contrast note now reads colours written as `oklch()`, `lab()` or `color(display-p3 …)`, so faint text in
Tailwind v4's palette is reported (`1 text item has very low contrast (1.6:1)`), and text on an `oklch` background
is measured against that background, not the page behind it. A test that hit its own time limit is now found
anywhere in a check's output, not only in the start and end Casper keeps, so a long run with the timeout in the
middle asks `1 Stop · 2 Retry · 3 Fix it anyway` instead of starting a repair. For contributors, the fetched-pack
tests are one test per case, so a busy machine no longer times them out.

## v0.2.30: Claude through your Claude Code sign-in, pages the AI makes, and fewer wasted repairs

Claude models can run through the Claude Code installed and signed in on this computer, the AI makes a page in
your browser when seeing beats reading, and a check that failed for a reason the code can't fix (the sandbox, a
busy computer) asks you instead of starting paid repairs. `/sandbox off` turns the sandbox off for a session,
`/model opus 5.5` takes a model by its name in words, and the network server updates between Casper releases.

- `claude-subscription`: Claude models through Claude Code's own sign-in, on Mac, Linux and Windows
- Pages the AI makes: options side by side, a mock-up, a dashboard, a report; `/pages` lists, opens and removes them
- A check the sandbox blocked asks at once to run outside it; a test that hit its own time limit asks Stop, Retry or Fix it anyway
- `/sandbox off` and `/sandbox on` for this session
- `/model opus 5.5` and a typed `change model to opus 5.5` pick the model, with no model call
- `/plan` shows a plan for a person: what you'll see, plain steps, one line for the tests
- casper-network-mcp updates between Casper releases, from the hash lock attached to its release
- Helpers work with models that send unused tool fields as `null` (GPT models through GitHub Copilot)

**Claude through your Claude Code sign-in.** `/model claude-subscription/claude-opus-4-8` (or any Claude model
under that provider) sends requests through the official Claude Agent SDK and the `claude` program (`claude.exe` on
Windows) already installed and signed in on this computer. Claude Code keeps the sign-in, its renewal and its own
request details; Casper never reads or stores them, and `CASPER_CLAUDE_PATH` names the program when it is not on
your PATH. The models show as available only when `claude auth status` says Claude Code is signed in. API key,
gateway and cloud settings in the environment are cleared for that program, so a request never falls back to API
billing. Casper still runs every tool itself, with its approvals and sandbox: the SDK sees the tool list, and each
tool call comes back to Casper. The `anthropic` provider is unchanged. Each turn replays the conversation as text
rather than keeping one Claude Code conversation open. How your plan counts these requests is Anthropic's
decision; Claude's usage page shows it.

**Pages the AI makes.** When a picture answers better than text, the AI makes a page by itself and it opens in
your browser: `[page] db-options → http://127.0.0.1:52144/db-options.html`. A change reloads the open tab.
`/pages` lists them, and `/pages open` and `/pages remove` also work during a task. Pages stay on this computer: a
local server on `127.0.0.1`, a policy that keeps a page from fetching from other sites, and nothing served outside
the pages folder. Over SSH or with no desktop, Casper prints the link. **Pages the AI makes** and **Open pages in the
browser** in `/settings` (`ai_pages: off`, `open_pages: off`) turn them off; a project file can't.

**Fewer wasted repairs.** A check the sandbox blocked is now found in its whole output, not only the start and end
Casper keeps: an `EPERM` in the middle of a long test run, or `out of pty devices`, asks `Run this project's checks
outside the sandbox?` after the first run instead of after three repairs. A check that ran to the end but in which
a test hit its own time limit (bun's `this test timed out after`, Jest, Vitest, Mocha, pytest-timeout) is
unfinished, not a bug: `test: a test in it timed out (often a busy machine, not the code). Casper did not try to
fix it. What now?` with `1 Stop · 2 Retry · 3 Fix it anyway`.

**`/sandbox off` and `/sandbox on`.** `/sandbox off` turns the shell sandbox off until Casper exits: shell commands
and checks run with your own permissions. While it is off, the status line and receipt say `not sandboxed (/sandbox
off for this session; /sandbox on puts it back)`. `/sandbox on` can't undo `sandbox: off` in your config or `--no-sandbox`, and
says why.

**A model by its name in words.** `/model opus 5.5` picks the model the words name; case, dots and spaces don't
matter, and `/model opus` is the newest Opus. Words that name several ask which by number; words that name none
list the closest few. A typed line that only asks to change the model (`change model to opus 5.5`) is done with no
model call, also during a task.

**A plan you can read.** `/plan` shows what you'll see first (a small mock-up when the change is on screen), plain
steps and one line for the tests; the files and functions stay one key away (Ctrl+T). After Edit the plan, only
what you changed and your note are shown.

**Network server updates.** Once a day Casper asks GitHub whether casper-network-mcp has a release newer than the
one installed and offers it: `network: update ready (0.1.2 → 0.1.3)` with `1 Not now · 2 Update it`. It installs
from the hash lock attached to that release, checked first; the version Casper ships with stays the floor and the
offline fallback. **Network server updates** in `/settings` (`network_updates: off`), `tools: { downloads: off }` or
`CASPER_OFFLINE=1` turns it off.

**Helpers with GPT models.** Some models send every tool field and fill the unused ones with `null`; `delegate`
refused `of: null`, so the AI lost its explorers, reviewers and builders. A field sent as `null` now counts as not
given. For contributors, `CASPER_LOCAL_MODELS=off` keeps a run from looking for a model server on this computer,
and the test suite sets it.

## v0.2.29: commands during a task, models on this computer with no setup, and sign-ins from other tools

Every command now runs during a task, a model server on your own computer shows in `/model` by itself,
and `/login` offers a sign-in Claude Code, Codex CLI or GitHub CLI left on this computer (an API key or
GitHub CLI's sign-in is used; a plan sign-in starts Casper's own sign-in to the same account). Without a sandbox
(Windows, or Linux without bubblewrap), everyday read-only lines no longer ask, and `/permissions` is a short
screen.

- Every command runs at once during a task, with whatever follows it; only the few that would change the task wait
- `/btw <question>` asks a side question, also with side questions off
- Ollama, LM Studio, llama.cpp and vLLM show in `/model` with no sign-in and no `models.json`
- `/login` offers a sign-in Claude Code, Codex CLI or GitHub CLI left on this computer
- With no sandbox, a `cd` into the project, globs, `2>&1` and `--version` are plain reads, and a yes to a line covers its one real command
- `/permissions` is short, with the Stop asking box under it; `/permissions details` is the full screen
- A sign-in that can't be renewed says `/login`; a helper stopped by its limit hands back what it found

**Commands during a task.** Enter during work runs any command at once, with whatever follows it, as when
idle: `/permissions all`, `/settings`, `/login`, `/memory remember …`, `/mcp writes …`, `/details quiet`,
`/tasks stop 2` and the rest. A setting or permission you change applies from the task's next step, and the
command says so (`The running task uses it from its next step.`); a tool the task already has (web lookups,
the reader, the browser, builders, the spend limits) changes from your next request (`The running task keeps
what it had; your next request uses it.`). `/mcp`, `/tasks` and `/diff list` print their lists instead of a
picker, and `/permissions` shows its screen without the box. A picker or question a command opens gives way
when the task asks you something: it closes and says `… — closed for the task's question; type the command
again`. A private box for a key or a password (`/login`, `/mcp login`) is never closed under you: the task's
box waits. Only the commands that would change what the task works on, or start model work of their own,
wait: `/clear` and `/new`, `/resume`, `/compact`, `/undo`, `/redo`, `/branch <name>`, `/switch`, `/project
<name>`, `/project new`, `/plan`, `/verify`, `/security-review`, `/delegate`, `/crew` and a picked suggestion.
They keep their draft and say why (`/undo waits until this task ends · draft kept · Esc stops the task`).

**`/btw <question>`.** A side question, idle or during a task, the same as a line you start with `?`: your
fast model answers with no tools, and the conversation never sees it. It still works with side questions
off, since it is typed on purpose.

**Models on this computer with no setup.** Start Ollama, LM Studio, llama.cpp's `llama-server` or vLLM and
its models show in `/model`, with no sign-in and no file to edit. Casper looks at their usual addresses
(`127.0.0.1:11434`, `:1234`, `:8080`, `:8000`, or where `OLLAMA_HOST`, `LM_STUDIO_BASE_URL`,
`LLAMA_CPP_BASE_URL` or `VLLM_BASE_URL` points) in the background from the start and again each time you
open `/model`, so the start never waits. A server that isn't running is skipped without a word. With nothing
signed in, a found server counts: your first request picks its first model and saves it. Model names are
`ollama/qwen3:8b`, `lm-studio/…`, `llama.cpp/…` and `vllm/…`; Casper reads the context window where the
server tells it, leaves embedding models out, and sends the server only the word `local` as its key. Your
own `models.json` entry for the same server still wins. `casper doctor` lists the servers it finds. The
**Local models** row in `/settings` (`localModels: false`) turns it off. See
[CONFIGURATION.md](CONFIGURATION.md#local-models).

**Sign-ins from other tools.** On a computer where Claude Code, Codex CLI or GitHub CLI is already signed in,
`/login` (and the sign-in Casper opens by itself) first says `Found a Codex CLI sign-in on this computer` and
offers one row per sign-in found (such as `1 Codex CLI · use its OpenAI API key`), then `Sign in separately`
and `Not now`. Only providers with no sign-in yet are offered, and
finding one reads no key. An API key from Claude Code or Codex CLI is checked with Anthropic or OpenAI, then
copied. GitHub CLI's sign-in is exchanged for GitHub Copilot the way Copilot's own sign-in is, and gh stays
signed in (a classic `ghp_` token is refused: Copilot doesn't take it). A Claude or ChatGPT plan sign-in is
never copied, because its refresh token changes on use and a shared copy would sign the other tool out:
picking it starts Casper's own sign-in to the same account. `~/.codex/auth.json`, and those tools' sign-in
files wherever their folder setting moves them, join the private places the AI's tools can't read. **Sign-ins
from other tools** in `/settings` (`other_logins: off`) turns the offer off. See
[TERMINAL_UX.md](TERMINAL_UX.md#provider-login).

**Fewer questions with no sandbox.** On Windows, and on Linux without bubblewrap, more lines count as plain
reads and run without a box: a leading `cd` into a folder in the project (on Windows also a Git Bash path such
as `/c/Users/me/project`), `*` and `?` globs that Casper expands and checks file by file, `find … | xargs wc`,
`--version` alone for a few toolchains, a `<` or `>` inside quotes (`grep -n "<div" x.html`), and reads joined by `|`, `&&`, `;`, `2>&1` or `2>/dev/null`. A line whose
other commands are all plain reads counts as its one command that is not, so a yes to `npm test` covers
`cd app && npm test 2>&1 | tail -25`; `python -m pytest` and `python -m unittest` are a prefix of their own. A
glob that picks a private file, `xargs` with anything but `wc`, and a remembered command followed by a file
read still ask. An answered `Run this command?` box leaves no line after a yes (the command's own line shows
it ran), or one short line after 3 (`✓ allowed until you quit: npm test`) or 4 (`✓ allowed always in this
project: npm test`); after the third yes Casper says
once that `/permissions all` stops the questions until you quit. See [SECURITY.md](SECURITY.md).

**A short `/permissions`.** `/permissions` now says whether Casper is asking, one line per kind (state · how to
change it) and what stays protected, then the box `Stop asking until you quit?` (`1 Keep asking` first, so
Enter changes nothing). `/permissions details` is the full screen of where each permission came from and
every way to be asked less. `allowall` and `allow-all` are `/permissions all`, which still asks first, and a
mistyped word gets a suggestion (`Did you mean /permissions all (it asks first)?` for `allow` or `yolo`) and
runs nothing.

**Smaller fixes.** When a saved sign-in can't be renewed, `/model` says `Your anthropic sign-in expired. Run
/login to sign in again; showing saved models.`, and other refresh failures read in a few words (`HTTP 503`,
`timed out`, `can't reach it`), never the provider's URL or stack; a request with such a sign-in says the same,
with `/login` as the next step. A Claude sign-in out of extra usage says to add more at
claude.ai/settings/usage, or `/model` to pick another model. A helper or builder now also gets its last
turn to report when it is 30 seconds from its time limit, not only when it uses up its turns or tool calls,
and the main AI gets that report marked partial (`partial: stopped at its 12-turn limit`); one still on a
step at its time limit hands back its last words or the files it looked at.

**Not done yet.** `/login` still has no "a model on this computer" row; a running server now shows in
`/model` without one. A server on another machine, or one that needs a key, still goes in `models.json`.
Windows still has no shell sandbox.

## v0.2.28: one table of commands, screens that say things once, and `git push` with your GitHub login

Commands now do what `/help` says, the names you know from other coding tools work, and every box,
picker and footer says each thing once, in one style. With the sandbox on, a plain `git push` or `gh pr`
can run with your own GitHub login after you say yes. `/permissions` is one screen, and a check the
sandbox blocked is no longer "fixed" in your code.

- One table of commands: the menu, completion, help and what runs during work all read it
- The peers' names: `/new`, `/theme`, `/hotkeys`, `/copy`, `/export`, `/rename`, `/logout`, and `/config`, `/cost`, `/thinking`
- A closed box leaves one line, `question → answer`; one picker style; each mark means one thing
- An Other row in the AI's questions, and the AI asks with the picker instead of in prose
- `git push`/`pull`/`fetch` and `gh pr`/`issue`/`run` with your GitHub login, after a yes
- `/permissions` on one screen; checks the sandbox blocked say "could not check"
- ripgrep inside the release program

**One table of commands.** The `/` menu, Tab completion, `/help`, the "Did you mean" hint and the rule for
what runs during a task now read one list. The menu shows each command once; typing another name finds it
(`/cost` shows `usage (cost)`), and a long label ends with `…`. A command that takes nothing after its name says so
(`Usage: /settings, with nothing after it.`) instead of suggesting itself. The menu lists `/quit`, shows what
can follow each name, completes subcommands (`/mcp ` lists `detail [name]`, `connect <name>` …) and dims the
ones that wait for the task. An unknown command during work is refused at once instead of waiting.

**The names you know from other tools.** `/new` starts a new conversation, like `/clear`; new projects are
now `/project new [template] [name]` (and `/new <name>` says so). `/config`, `/cost` and `/thinking` run
`/settings`, `/usage` and `/effort`. New: `/theme` (the Theme row of `/settings`), `/hotkeys` (the keys),
`/copy [n]` (the last answer, or its code block n), `/export [file]` (the conversation as Markdown, or every
message with a `.jsonl` name; with no name it goes to `~/.casper/exports` and says the whole path; it never
writes over a file), `/rename <title>`, and `/logout [provider]` (lists
or removes a sign-in `/login` saved; environment variables are left alone). Bare `/branch` lists the
workspaces; `/tree` still works.

**Commands do what the help says.** `/login codex` and `/login copilot` sign in. `/exit` or `/quit` during a
task stops it and leaves. `/browser`, `/services`, `/debug`, `/lab`, `/memory`, `/references` and `/visualize`
alone run during work, and `/doctor` during work reports without fixing. `--session` goes before or after the
value for `/model`, `/effort` and `/details`. Every usage error reads `[error] Usage: …`. `forget` and `remove`
mean the same everywhere, and `list` is the command alone. Bare `/details` shows the level instead of
changing it; `/model` with an id no model matches and `/effort` with a level the model lacks say so and
change nothing; `/project` alone is `/status`.

**Screens say things once.** A picker, question or approval you answered leaves one line,
`Run this command? → Yes, this once`, or `— skipped` on Esc; there is no extra `[approval]` or `[ask]` line.
`/mcp` is the picker alone: each server says where it came from (`from ~/.claude.json`, `from VS Code`,
`from this project`), and Casper's network server says what it covers. The footer names the folder (and the
branch only when there is one) and the model once, and its time sits right after the spinner. A turn that
only answered a question has no receipt. A check that timed out is said once, in the receipt. A line typed
during work is echoed once, a provider retry is one amber line, and a paste never lands in an open picker:
it waits as your draft.

**One picker style.** The AI's questions, approvals, `/login`, `/effort` and the plain terminal share one
numbered style and one hint. A list longer than nine numbers every row (type `12` and Enter), so every
`/settings` row has a number. `/settings`, `/preview` and the question after a timed-out check work on a plain
terminal. Keys are spelled one way (`Ctrl+O`, `Ctrl+C`), and a list taller than the window scrolls.

**Each mark means one thing.** `•` is running, `○` did not run, `–` is a note, and an answered box marks only
the choice. On the old Windows console (outside Windows Terminal) every mark is ASCII. Times, tokens and
costs have one format everywhere (`1m05s`, `2.6k`, `$0.31`), and the Working box says `Waiting for
<model>` as soon as a request goes out.

**The AI's questions.** Its question box ends with `Other — type your own answer`. The AI now asks with the
picker whenever it needs a choice or a yes, before, during or at the end of a task, instead of ending its
reply with a question in prose, and after your answer it says only what is new.

**`git push` with your GitHub login.** With the sandbox on, your GitHub login (`~/.config/gh` and git's
saved logins) is hidden from the AI's commands, so a `git push` failed. Now a plain `git push`, `pull`,
`fetch`, `clone` or `ls-remote`, or `gh pr`, `issue`, `run`, `repo`, `api` (reads only) or `auth status`, asks
`Run outside the sandbox with your GitHub login?` (`1 No · 2 Yes, this once · 3 Yes, for this session · 4 Yes,
always for this project`; a command that types its own address offers only 1 and 2). A command that changes
something on GitHub (`gh pr merge`, `close`, `reopen`, `ready`, `review` or `checkout`, `gh issue close` or
`reopen`, `gh run rerun` or `cancel`) offers only 1 and 2, every time: no earlier "session" or "always" answer
covers it. After a yes Casper runs
exactly that command outside the sandbox. The AI reads only its output and never your token, and GitHub
tokens are hidden in what it reads. A command with a pipe, `;`, `-c`, a local remote and the like stays in the
sandbox, and a git or gh command that failed for want of the login tells the AI how to run it. On Windows,
which has no sandbox, nothing changes. See [SECURITY.md](SECURITY.md).

**`/permissions` on one screen.** It says what Casper may do, what you said yes to, and for each one how to
be asked less, and what stays protected whatever you pick. `/permissions all` (a box; `1 Keep asking` is
first) answers the shell's four questions (a command, a host, a write outside the project, another machine)
with "Yes, for this session" until you quit; the footer shows `ASKING OFF · /permissions ask`. A write
outside the project can be allowed for good (`4 Yes, always for this project`, kept in `~/.casper`, never in
the repo; `/permissions forget <folder>` takes it back).

**Checks the sandbox blocked.** A project check that fails because the sandbox blocked it (`EPERM`,
`Operation not permitted`) now reads "could not check", and Casper no longer tries to repair your code for
it. It asks `Run this project's checks outside the sandbox?`; `sandbox: { checks: ask | outside | inside }`
in your own config sets the answer (a project file can't). An edit to documentation only runs no checks.

**ripgrep inside the release program.** The release program now carries the pinned official ripgrep for its
own system and unpacks it once, after its sha256 matches the pin, so a normal install downloads nothing. A
source checkout still downloads the same pinned release.

**Smaller fixes.** `/plan` shows the plan once, with a summary line and `1 Stop · 2 Build · 3 Edit the plan`
(3 on a rich terminal), and a call blocked while planning reads "not run". When an ssh login is refused, the AI is told to run plain
`ssh` so Casper can ask for the password, and `ssh.exe` counts as `ssh` on Windows. On Windows the
`casper update` helper writes `~/.casper/update.log`, and a failed update is said by `casper update`,
`casper doctor` and the start of a session. The Mist skill reads RF and DFS settings the right way and finds
the org first.

**Not done yet.** `/login` has no "a model on this computer" choice.

## v0.2.27: skill packs, colour themes, checking pull requests, `/mcp` you can click through, and nothing extra to install

You can add a pack of skills someone else wrote, from a folder or a GitHub commit, after a box that shows
every file, and pick a colour theme. `/mcp` is now one line per server with an arrow-key picker, a picture
you paste is saved where the AI can open it, a file you copied can be pasted, and the network server it
installs returns far less text per answer. Casper can also look at this repo's pull requests and CI on GitHub, and it starts quietly on Linux and in WSL with nothing extra to install.

**Skill packs.** A pack is one folder of skills with a `pack.yaml` that lists them.
`/pack add <folder>` or `/pack add https://github.com/<owner>/<repo>@<commit>` (one full commit; a branch
or tag is not taken) shows one box per pack in Casper's own words, counted from the files:
`1 No · 2 Yes, add it · 3 Show me what's inside`, and 3 prints every file in full. Enter is No. A commit
must be on the repository's own branches or tags, so a fork's commit served at its address is refused.
A pack holds plain text files only and nothing in it runs; a file changed later stops the pack until you
look again. Packs are yours only: just you can type `/pack`, they live in `~/.casper/packs`, a project
file can't add one or set `packs:`, and `packs: off` (or `/settings`) turns them all off. A pack costs no
tokens until a request fits one of its skills. See [PACKS.md](PACKS.md).

**Colour themes.** `theme: light` (for a light background) or `theme: high-contrast` in your own config,
or **Theme** in `/settings`, changes Casper's colours and nothing else; `default` looks as before. A
project file can't set it, so a repository can't make a warning hard to read. A pack can bring one
theme, colours only: the add box shows it in full, and it is used only if you pick it in `/settings`.
`NO_COLOR`, pipes and `TERM=dumb` still show no colour.

**`/mcp` in one screen.** Before, each server took four to six lines and `/mcp connect` printed the whole list
again. Now `/mcp` prints one line per server (name, state, tools, writes, sandbox, where it was found). On a
normal terminal an Up/Down picker sits under it: choose a server, then Details, Connect (or Reconnect),
Disconnect, Forget, Writes on, Writes off (all servers), or Sandbox on or off. Each choice runs the same code
as the typed command, so every approval box and safety message is unchanged. `/mcp detail [name]` prints the
full output as before, `/mcp connect` prints one result line, and one "Heads up" line appears only when a
connected server is not sandboxed or writes are on. Plain terminals, scripts and `--json` keep the list with
command hints and no picker.

**Pasted pictures.** A picture pasted with Ctrl+V (Alt+V on Windows) already went to the model. It is now also
saved in a private temp folder (only you can read it) and a line under your request says
`[image 1] is the file <path>`, the same as for a dragged file, so a model that cannot see pictures, or a task
that needs the file, has something to point at. The folder is deleted when the session closes; a crash can
leave a `casper-pasted-*` folder in your temp directory. Requests without a pasted picture are unchanged.

**Pasting a copied file.** With no picture on the clipboard, the same key now takes files you copied in
Finder, Explorer or a Linux file manager: each goes in as its path, as if dropped, and a picture file
among them goes with the request with the same checks and limits. On Windows a picture on another
computer's share still asks first. A name with a control or text-direction character is left out, and
Casper says so.

**Pull requests and CI, without handing the AI your login.** Inside Casper's sandbox `gh` could not run
at all, so Casper could not look at a pull request. A new `github` tool gives the AI four fixed actions:
`prs` (open pull requests with their CI state), `pr N` (the checks, and which failed), `ci N` (the failing
step and the last 40 lines of each failed job's log, with secrets removed) and `rerun N` (re-run the failed
checks: asks first, once per pull request per 10 minutes). Casper's own code runs `gh` with arguments it
builds from checked values; the AI only chooses an action and a number, never sees your token or `gh`'s
config, and gets back text from GitHub marked as other people's words. Pull request and comment text is
never returned. The first use in a repository asks in plain words (`1 No · 2 Yes this once · 3 Yes for this
session`); a run that cannot ask refuses. It is offered only when a request mentions pull requests, CI or
GitHub, so it costs no tokens otherwise, and `github: off` in your own config removes it. It needs `gh` signed
in (`gh auth login` in your own terminal). Pushing, opening and merging pull requests are not part of it.
See [GITHUB.md](GITHUB.md).

**A quiet start on Linux and in WSL.** Without bubblewrap, socat and ripgrep Casper still works and asks
before shell commands that change things. The start-up line now says that
(`asks before commands that change things · /sandbox for the full sandbox`) instead of listing what is
missing; `/sandbox` and `casper doctor` still show the exact install line for anyone who wants the full
sandbox. [WINDOWS.md](WINDOWS.md) has a short "Windows with WSL" section: a separate install with its own
`~/.casper` and sign-in.

**ripgrep with nothing to install.** When no `rg` is on your computer, Casper downloads ripgrep 15.2.0 (one
time, about 5 MB) from the official release into `~/.casper/tools`, after checking its fingerprint against
a pinned value, for Linux, macOS and Windows on Intel and ARM. A ripgrep you installed is always used
first. Offline, or if the check fails, Casper carries on without it and says why. `tools: downloads: off` in
your own config (a project file cannot set it) turns the download off.

**Two Caspers sharing a home folder.** A second Casper now waits for the settings lock instead of failing,
and the macOS stall dump shows which worker is stuck.

**An org is "the org".** `login: can change <name> org` showed the organisation's name in `/mcp` and in the
change box. A single org now shows as "the org". Site and site group names still show.

**Network server 0.1.2.** Casper now installs casper-network-mcp 0.1.2: Central alerts, clients, events and
radios return short rows by default (the full data is one option away and each tool's description says how),
so one answer costs far fewer tokens; `trigger_device_upgrade` writes the firmware policy Central accepts, and
its dry run now catches a body the endpoint would reject; an accepted firmware change says "queued, not
applied yet". Installs on 0.1.1 are offered the update by `/mcp setup network`.

**An older `gh` no longer stops an install.** `gh` can check where a download was built only from 2.56. A signed-in
`gh` from 2.47 to 2.55 has an `attestation` command that cannot do that check, and `install.sh`, `install.ps1` and
`casper update` read its failure as "this download isn't a Casper build". They now ask `gh` for its version first;
an older one is skipped: the SHA-256 and signature checks still run, and they say "This gh is too old to check
where it was built (gh 2.56 or newer can)." A `gh` that can check and says the file does not match still stops
the install.

**Sandbox: after `/branch` and `/switch`, worktrees, and ssh.** After `/branch` or `/switch` the AI's shell
always goes through the session's current sandbox and the private places follow the folder you are in; a
sandbox that was replaced or closed refuses a command instead of running it as it is. On macOS a `/branch`
session folder under `~/.casper` is writable again, while your keys, settings, packs and other sessions' folders
stay out of reach. A linked git worktree keeps its pointer files read-only, in both directions, so a sandboxed
command cannot change what git runs in another checkout. Only the system's own `ssh` and `scp` run outside the
sandbox after your yes; a program of that name in a project, or one in Casper's own folder, stays inside it. One
limit on macOS: a brand-new file created directly in `~/.casper` during a `/branch` session is not blocked (the
existing entries are); [SECURITY.md](SECURITY.md) has the detail.

**Private ssh passwords.** When an `ssh` or `scp` you allowed asks for a password or a key's passphrase, Casper
shows its own hidden box (`1 No · 2 Yes, this once · 3 Yes, for this session`; a passphrase is asked every time).
What you type goes to `ssh` only: never to the AI, the command, the questions or the saved conversation, and it
is hidden wherever the AI reads, whatever its length. Only the system's own `ssh` and `scp` to a host you
approved can ask; a program of that name in a project gets nothing, and a prompt for another user or machine is
refused. Nothing is saved to disk. `ssh_login: off` in your own config (or **Private ssh passwords** in
`/settings`) turns it off; a run that cannot ask you (a one-shot, a builder) refuses in plain words. A command
you or the AI wrote with `-o BatchMode=yes` is left as it is, and the AI is told to run it again without. Not
yet tried against every kind of server, and on Windows only the installed Casper (not a source checkout) has it.
A carriage return in tool output is now a line break instead of the text `\u{d}`. See
[CONFIGURATION.md](CONFIGURATION.md#private-ssh-passwords).

**Casper shows what it is doing while it waits.** A check Casper runs itself (typecheck, lint, test and the rest)
adds a line such as `test · 3m05s` after 10 seconds, with the last line it printed dimly under it. If the model
has said nothing for 10 seconds the box reads `Waiting for <provider/model> · 14s`, and during a provider retry
`Retrying <provider> · attempt 2 of 3`. A plain terminal prints `[checks] test still running · 3m` once a
minute; `--json` and `/details quiet` print nothing extra. A check's result is unchanged.

**`/security-review update` with the sandbox on.** The advisory download always failed with the shell
sandbox on, which has no network and can't write `~/.casper`. It now runs outside the sandbox, like
Casper's own installs, but only with the osv-scanner Casper installed and checked, Casper's own arguments,
no passwords or tokens, and osv-scanner's call analysis off, so nothing of the repo runs. Your own
osv-scanner on PATH stays in the sandbox, where it can't download. The scans still run sandboxed.

**For contributors.** A known flaky test (listed in `tests/flaky-list.test.ts`) gets one more try on the
OS it flakes on, and only when the first try ran out of time; the log shows a `(retry)` line. A wrong
result still fails at once. [DEVELOPING.md](DEVELOPING.md) says how to add one.

**Not done yet.** `/login` has no "a model on this computer" choice; a pack brings only skills and one theme (no MCP servers, logins or slash commands),
and from GitHub only a public repository.

## v0.2.26: local models, updating on Windows, and opening where you launched

Casper can now be pointed at a model running on your own computer (Ollama, LM Studio, llama.cpp or vLLM)
with a written recipe and plain errors when something is missing. `casper update` works on Windows,
and Casper no longer asks which project to open when you start it in your home folder.

**Local models.** `docs/CONFIGURATION.md` has a "Local models" section with the exact lines for Ollama,
LM Studio, llama.cpp and vLLM: the address, a placeholder key, and the setting that fits each. Some
messages are now plain words:
- A model that cannot use tools says so, and says what to do, instead of a bare provider error.
- A provider that needs a key and has none says which provider and where the key goes. A local server
  on this computer needs no real key and is not asked for one.
- A model with a small context window is told so once, and Casper no longer tidies up the
  conversation (compaction) on every turn.
- A model that writes its tool call as ordinary text (some small models do) is told so. Before, the
  run ended with a silent "unchanged".

**Opening where you launched, always.** From your home folder or the top of a drive, Casper opened with a
question, "Work in which project?". It now opens right there and asks nothing. One line says where it
opened and the command that opens the project you last worked in (`casper new` starts a new one). Those
folders are broad, so the AI can see and change files anywhere in them; open a project folder when you
want it kept to one. The line skips temporary and scratch folders and shows real Windows paths.

**Updating on Windows.** `casper update` could stop with "Windows would not let Casper move its own
program aside". It now hands the checked installer to a separate process that waits for Casper to
exit, then runs it. The installer is still checked against its published SHA-256 first, as before.

**Network server setup with the sandbox on.** `/mcp setup network` stopped with "uv could not make a
Python >=3.12 environment" whenever the shell sandbox was on, which is the default on macOS and Linux:
Casper's install ran inside the sandbox, which cannot write `~/.casper` or reach pypi.org. The install
now runs outside it (it only runs Casper's own steps on hash-checked files), and when uv cannot make a
Python environment the message says why: a blocked download from github.com, downloads turned off, or
no Python found.

**Plainer wording.** A line you type while Casper works now says "sent to Casper", not "sent to the
AI". Dependabot no longer proposes moving the pinned Pi packages or the TypeScript and Node type
majors.

**Not done yet.** `/login` has no "a model on this computer" choice; you edit `models.json` as the
recipe shows. Builders the AI starts are still not shown as a panel with one row each.

## v0.2.25: a stricter "plain read" check, verification that is harder to fool, reviewers for builders, and a calmer start

The check that lets harmless reads run without a question is stricter, several ways the checks could
report a pass they hadn't earned are closed, the AI's builders can get a reviewer and one fix round,
and starting Casper in a folder no longer asks which project or what kind.

**Safer: what counts as a plain read.** On Windows, and anywhere the sandbox is off, shell lines that
only read files in the project run without a question. Testing against real bash and dash found lines
that were accepted as plain reads but did more. This affects v0.2.24 (the cases below were checked
against it; older versions were not checked). Each case was reproduced with a harmless marker file
first, and each fix has a test that failed before it:
- A `#` comment could hide a second command.
- A link inside the project followed by `..` (`cat link/../notes.txt`) read outside the project,
  including `~/.ssh`. A repository can ship such a link. A `..` after a name now asks.
- A backslash at the end of a line joined two words, and a carriage return, no-break space or form feed
  inside a file name read files the check never saw.
- `printf -v PATH bin; ls` ran a program the project ships. `printf` now takes no options, and a format
  with `%n` asks.
- `diff` on folders read through a link inside them. `diff` takes plain files only.
- git in a repository that contains another repository (or has submodules) ran the inner repository's
  own configured program. git now asks there.
- git printed private files through a `*` or `?` in a path (`-- '.en*'`), through a path starting with
  `::` (`-- ::.npmrc`), through `git grep --cached`, and through words with a colon such as
  `HEAD:file`, including a colon hidden inside braces. All of those now ask.
- A file name with a colon, or ending in a space or a dot, asks on every OS: Windows can open the same
  file under such a name.

The check is now a strict list of safe characters before any parsing, not a model of the shell. What
newly runs without a question: `2>/dev/null`, `2>&1` and `>/dev/null` (they asked before; `&>/dev/null`
still asks, because `sh` reads it differently). What still runs: `grep -rn 'foo\.ts' src`,
`find . -name '*.ts'` and plain `git log`, `git diff` and `git status`. What now asks: comments, a
backslash or `$` outside quotes, `..` after a name, `printf` with options, `diff` on folders,
`git show HEAD:file` and other colon words, `*` in a git path, and every git command in a repository
with submodules.

**Not changed (the trust you give a repository you open).** A project's own `.git/config` can set a
program for git to run (`core.fsmonitor`, a text converter, an external diff), and a folder laid out as
a bare repository does the same; git runs it when the AI runs `git status` or `git log -p` there.
`git log -p`, `git show` and `git diff` with a revision and no path, `git grep` for a file that exists
only in history, and `git cat-file -p <hash>` print committed content, including a tracked `.env`. The
Windows file-name rules are covered by unit tests only, not on a real Windows machine.

**Checks that could pass without earning it.** Found by an outside review of the verification code:
- Independent acceptance added its test file to the end of the project's test command, so
  `bun test x && true` handed the file to `true` and reported a pass. It now refuses compound or
  filtered commands and says so. `python -m pytest` and `python -m unittest` still work.
- A smoke check passed a whole-body pattern on a response cut at 64 KiB when the start matched. It now
  says "could not check".
- Pointing a link that the test command runs (`scripts/check.js`) at another file wasn't a change to the
  test command. It is now.
- On a drive that ignores upper and lower case, a check declared on `SRC` was skipped when `src/`
  changed.
- Making a file executable, or not, wasn't a change. (Windows has no such setting, so it never counts
  there.)
- The proof that tests fail without the change used the *changed* code through a Python project that was
  installed from its own folder, so it said "not proven" for tests that did fail. It now uses the
  copy's own source, also where Python reads that setting from the environment's top folder (as on
  Windows). Installs recorded some other way are not covered. A dependency folder that is itself a
  relative link now works in the proof copy.

**Reviewers for builders.** After a builder's part lands, the AI can start a read-only reviewer on it.
Casper gives the reviewer the part's diff, goal and files, with secrets hidden, so the AI doesn't relay
them. If the reviewer finds real problems, one fix builder can follow: up to 6 first builds plus the
fix builders, at most 9 builders in a task and 3 at once. The footer reads
`1 reviewer · 2 builders · $0.19`, the Working box lists the builders and reviewers, and the receipt
says in one line which landed parts were never reviewed. All of it uses the same spend limit, sandbox
and `/undo`. `delegate: { build: false }` turns builders and part reviews off together; read-only
helpers still work. Builders aren't offered in a repository with no commits, and finished copies are
removed one at a time. See [CREWS.md](CREWS.md).

**Starting Casper.** Casper opens the folder you launched in. At startup it asks only from your home
folder or a drive root (`C:\`, `D:\`, `/`), where a whole-folder workspace is too broad. Any other
folder, even one that only holds projects, opens there, with one line naming the projects when there
are two or more. The startup menus for kind and name are gone: an empty folder starts quietly, and
when your first request fits a template (NOC dashboard, MCP server, Mist, Ansible plus a vendor, web
app, Vite) Casper says so and builds it. Any other request goes straight to the AI. Say "from scratch"
to skip a template, or turn it off in `/settings` (Starter templates). "New project" from the home or
drive-root question starts in `~/Projects` and builds on your first request. A build request in a
folder that isn't a project and isn't empty, such as Documents, still gets one question: use this
folder, make a new project, or another kind.

**`/allowed`.** Lists what you've said "always" or "this session" to, scrubbed of secrets, and forgets
one entry by number or words, or all of them. On Windows a saved `npm test` also covers `npm.cmd test`.

**Windows.** The lock folders Casper uses (memory, `learn`, saved sessions, worktrees, undo) now retry
when Windows says "not permitted" because another process is deleting the lock, instead of failing.

**Fixed from v0.2.24's known issues.** Switching back after a `big model:` task works while the
`/model` picker is open, and builders aren't offered with no commits. (`/model` during work already
said where the context goes in v0.2.24; that line was listed as a known issue by mistake.) Correction:
the v0.2.24 notes said a spend pause can't stop a builder in the middle of a tool call. Reading the
code, "Stop here" cancels every running builder the way Esc does, and each keeps its copy; no test
covers it yet, and I haven't tried a builder stuck in a long command.

**For contributors and testers.** The README says where to report a bug, how to install safely and
uninstall, and that tasks spend your own model provider's money. Runs on `main` finish instead of being
cancelled by the next push (a pull request still cancels its older run). On Linux and macOS a stalled
test run is cut off in about 3 minutes with a dump of what every worker was doing; Windows only got the
new time limits. All job limits come from real run times. The cause of the rare stalls is still
unknown. Test servers the service tests left running are cleaned up. Templates no longer generate a
line too long for their own lint when the project name is long.

## v0.2.24: builders the AI starts, plain words, an off switch for every default, and fewer tokens

The AI can now split a big job across builders on its own, you can steer a task with plain words
instead of commands, every default has an off switch in `/settings`, and every request carries
about 790 fewer fixed tokens.

**Builders the AI starts itself, as Claude Code and omp do.** For a job with separate parts, the AI
starts up to 3 builders at once (6 in one task) with the `delegate` tool's new `builder` role. Each works in its own
copy of your project (a Git worktree) that starts from your folder as it is now, unsaved work
included, with its commands in Casper's sandbox. They don't talk to each other. When a builder
finishes, its change is applied to your folder uncommitted, through the same path as the main AI's
edits, so the checks, the receipt and dev servers see it, and one `/undo` takes the whole task back.
Nothing is forced: if you changed a file meanwhile, that builder's work stays in its copy, `/crew`
lists it, and the AI is told. A builder that was stopped or failed keeps its copy. Anything that
would need your OK is not run and is listed in its report. A change containing a marker Casper uses to hide secrets is never applied, and the spend pause counts builders while they run. Your words steer it:
"run a crew", "use a crew", "split this up" or "do these in parallel" ask for builders; "by
yourself" or "no helpers" mean none for that request. Words *about* crews ("run the crew tests")
don't count. The status bar shows `2 builders · $0.12`, and their cost counts toward the task.
`/settings` (Helpers that build) turns it off; a project file can turn builders off for itself,
never back on for you. Outside a Git repository, or with no sandbox, builders aren't offered and
Casper says why. `/crew` stays as the manual way. See [CREWS.md](CREWS.md).

**Plain words for things people typed commands for.** Every slash command works as before.
- **Just ask.** A read-only `casper_session` tool answers "which model am I on?", "how much have I
  spent?" and "what changed last task?": model and effort, usage and cost, context, the last task,
  background tasks, and MCP on or off. No secrets, hosts or private paths; no network call; no cost.
- **Words at the start of your request, for that task only.** `think hard:` (or `ultrathink` as its
  own word) is top effort, `quick:` is low effort, `big model:` uses your big model, `fast model:` your
  fast one, `plan first:` is `/plan`. Casper reads them only from what you typed, never from pasted
  text, files or the AI; it strips them, says what each did in one line, and says again when it goes
  back. Words never grant permission.
- **`/model` during a task** takes effect from the AI's next step, as `/effort` already did.
- **Side questions.** A line starting with `?`, such as `? what does ECONNRESET mean`, goes to your
  fast model on the side with no tools, while idle or during a task. The answer isn't added to the
  conversation and the working AI never sees it. `/usage` counts it, and `sideQuestions: false` (or `/settings`) turns it off. `ultrathink` counts only as its own word
  (`src/ultrathink.ts` stays as typed), and pasted text never triggers a word or a side question.

**Every default has an off switch, in one list.** `/settings` first shows every setting with its
state in 80 columns, then the numbered list. New rows: the browser tool (`browser: off`), the diagram
tool (`visualize: off`), suggestions (now applied without a restart), the prompt cache
(`cache: auto|long|short|off`), page checks for every project (`pages: off`, which a project file
can't turn back on), and whether Casper sends its name to OpenRouter (`telemetry: off`; only the app
name and site are sent, nothing about your code). Page checks and `/browser` and `/visualize` still
work with the AI's tool off. A project file, or a profile it picks, can't turn any of these back on. `/status` says when the browser
or diagram tool is off, and `CASPER_TELEMETRY=0` still turns the OpenRouter name off. See [CONFIGURATION.md](CONFIGURATION.md).

**Fewer fixed tokens on every request.** Casper without MCP sends 3,996 tokens before your task, down
from 4,782 (−16%); with its network server, 4,824 from 5,709. The browser and the reader have shorter
descriptions, the diagram tool arrives with a diagram word instead of on every request, and the
check advice is said once. Every instruction the model acts on stays, and a budget test now fails if
the fixed part grows.

**The home-folder question lists your recent projects first.** Started in your home folder, Casper
asks "Work in which project?" with the projects from your latest saved conversations first, then the
others by newest change, instead of an alphabetical list. The question keeps its shape (up to 6
projects, stay in home, New project), and a plain terminal's hint names your most recent project.

**`/mcp setup ssh`.** Adds an MCP server that runs on another machine over ssh (a build box, a lab
host) with no config editing: pick a host from your `~/.ssh/config` or type one, give the command,
or type `/mcp setup ssh <host> <command…>`. The name question shows the exact line it saves to your own
`~/.casper/mcp.json` (`ssh -T -o BatchMode=yes -- <host> "<command>"`; the `--` stops a command starting
with `-` from being read as an ssh option). It connects with writes off, like every server, and runs
the server's `access_check` if it has one. A server's built-in settings can now mark a tool as more
risky, never less.

**One question before two risky opens.** The AI's browser asks before opening a cloud metadata address
(`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`, `169.254.170.2` and
`100.100.100.200`, in other spellings too): `1 No · 2 Yes, this once · 3 Yes, for this session`. On
Windows, a picture on another computer's share (`\\nas\shots\pic.png`) asks `1 No · 2 Yes, this once`,
because opening it sends your Windows login hash there. Choice 3 covers that one address. A picture or fetch by a host name that points there isn't caught. Your
LAN and loopback are untouched, and the automatic page check is not the AI's browser.

**Already in v0.2.23, missing from its notes.** The second part of the independent security review
shipped inside v0.2.23, but its notes didn't list it. It isn't new in this release, and it is here so
the record is complete:
- **Casper's own files are private to the AI.** The read tool and the sandboxed shell can't open
  `~/.casper/mcp.json` and profiles, saved conversations, `models.json`, or the MCP consent and skill
  trust records.
- **Secret scrub gaps closed:** key bodies read without their BEGIN line, PGP private keys, `.pgpass`
  passwords, Docker login `auth` values and Authorization headers in any case. The scrub also covers
  MCP results, browser page text, `lsp` results, reference excerpts and check replies. Quoted search
  words and ordinary words after "password" stay readable; a real value after `name= ` is still hidden.
- **Pasted text and pictures:** Ctrl+V text can't put terminal control codes into the editor, pasted
  pictures have a 20 MB cap, and page screenshots are labelled `[screenshot N]` so they never clash
  with your `[image N]`.
- `lsp` rename counts as an edit, so it goes through the same gates, and the reader's file source
  honours a moved `CASPER_AGENT_DIR`.

**For contributors.** Every test file cleans up its temp folder with `removeTempDir`, which retries
Windows `EBUSY` (a process, often git's launcher, can still hold a file there for a moment), so
Windows CI is much less likely to fail on random tests while they delete their folder (up to 2 s of
retries).

**Known, not done yet.** A spend pause can't stop a builder in the middle of a tool call; a repository
with no commits still offers builders; `/model` during work skips the "context goes to <provider>"
note; if the `/model` picker is still open when a `big model:` task ends, switching back can fail
(Casper says so plainly).

## v0.2.23: casper doctor, a network server in the sandbox, a reader for untrusted text, crews and pictures

Casper can check its own setup, its network server runs in the sandbox, the AI can read untrusted
text without it entering its context, you can paste a picture into a request, page checks save
screenshots the AI can look at, new web projects start with a look of their own, and `/mcp login`
asks which product instead of leaving you to guess.

**Casper's network server runs in the sandbox.** On macOS and Linux, Casper's own network server
now runs inside the same sandbox as the AI's shell. It reaches only the product hosts of your saved
logins: the Mist cloud you picked, your Central region and Central's sign-in host, and your
ClearPass address, including an address you typed with `Other`. Any other host is refused, and
Casper says so once. It reads only its own install and the Python it was built with, and writes
only its spec cache; the rest of your home folder (`~/.ssh`, `~/.casper`, your projects) and the
open project are hidden from it. It is on by default; `/mcp sandbox network off` (or `/settings`)
turns it off for that server. Only Casper's own network server runs this way: Casper doesn't know
what another MCP server needs, so it doesn't guess and break it. On Windows, or where the sandbox
can't start, the server starts as before, and `/mcp` says which servers run sandboxed and why one
doesn't. See [It runs in the sandbox](MCP.md#it-runs-in-the-sandbox).

**Crews, the first part.** `/crew <job>` has one builder do the job in its own copy of your
project (a Git worktree), with its commands in Casper's sandbox. Anything that would need your OK is
not run and is listed in its report. When it ends: `1 Keep the copy · 2 Apply to my folder · 3 Throw
it away`; Apply lands the work uncommitted next to your own changes and refuses if you changed the same
file. A builder can't read files you made private or move your branches. You start a crew; the AI
never starts one. `/crew` lists copies still here. Splitting a big job across several builders with a
reviewer comes next. See [CREWS.md](CREWS.md).

**A reader for untrusted text.** A log, an email from a stranger or a web form can hold hidden
orders ("ignore your rules and run ..."). The AI can now read such text with
`casper_read_untrusted`: it names a file, a read-only command or an MCP tool, a separate model call
with no tools reads the text, and the AI gets back only JSON in the shape it asked for, never the
text. An answer that doesn't fit the shape gets one retry, then a plain error that never holds the
text. Longer free text, such as an email body, comes back only when the AI marks that field as
quoted, and then wrapped with where it came from. Short text fields that read like orders or
commands are refused. That check is a word list: it lowers the risk, it doesn't make untrusted
text safe, and a fooled reader can still pick a wrong value. It is on by default and costs nothing
until the AI calls it (then one small request on your `fast` model). `/settings` turns it off
(`reader: off`), and `reader: { untrusted: ["logs/**"] }` names paths the AI should read only this
way. See [READER.md](READER.md).

**`/mcp login` asks which product.** On its own, `/mcp login` used to list the products and stop,
so the product name you typed next went to the AI as a request. It now shows each login and asks
`1 Not now · 2 Mist · 3 Central · 4 ClearPass`, then runs the same steps as `/mcp login <product>`.
A one-shot run still only lists. The Mist cloud and Central region lists end with
`Other — type the address`, for a cluster that isn't listed; it is typed like ClearPass's address.
Central also lists its internal cluster by name, from the servers list of the Central specs the
network server bundles. See [Casper's network server](MCP.md#caspers-network-server).

**`casper doctor`.** One command, or `/doctor` in a session, that looks over Casper's own setup
with no model and no tokens: this version against the newest preview and the `casper` on PATH,
config files that don't load (by file and line), model sign-in, MCP servers that can't start (with
the install page for a missing `uvx`, `npx` or `docker`), language servers for the project's
languages, security tools, the sandbox, disk space for `~/.casper`, and the network server with its
saved logins. It fixes three things, each after a numbered question where `1` is Not now: run
`casper update`, install the pinned security tools, and set up the network server. Exit 0 means
nothing to fix, 1 something to fix. In a session it also says why an MCP server didn't start. See
[DOCTOR.md](DOCTOR.md).

**Signed releases: built, not switched on yet.** The publish job can now sign `SHA256SUMS` with an
SSH release key, both installers check that signature with `ssh-keygen`, and `casper update` checks
it in its own code. No release key is pinned yet, so this release is not signed and nothing checks
a signature; the SHA-256 checks decide, as before. The release that pins a key will say so in its
notes. What already works: `SHA256SUMS` now lists both installers, and `casper update` checks that
the installer it runs is a GitHub build of Casper when `gh` is signed in (the installers already
checked the program that way). The programs themselves are still not code-signed or notarized, so
SmartScreen or Gatekeeper may still warn. See [The release key](#the-release-key).

**Pictures in a request.** Ctrl+V (Alt+V on Windows) pastes the clipboard's picture as
`[image 1]`, and a picture file dropped or typed as a full path becomes `[image N]` when you send.
PNG, JPEG, GIF and WebP, up to 8 a request. When the model can't see pictures, one question:
`1 Send without it · 2 Switch to <a model you set up that can> for this request`. The switch is for
the build turn only, then you are back on your model.

**The AI can see the pages.** After a UI change, each checked page saves a desktop (1280 px) and a
phone (390 px) screenshot, listed under the page's line, at no token cost (not on Windows yet).
When the checks pass and the model can see pictures, Casper can show it the screenshots of up to
2 pages once, so it can fix what loads but looks wrong. That uses tokens, so the first time in a
session it asks `1 No · 2 Yes, show the AI the pages`; `/settings` makes it always or never. What
the model thinks of a picture is advice, never a check, and never makes a change **Verified**. Page
checks also note accessibility basics (images with no alt text, fields with no label, buttons with
no name, very low contrast, no `lang`) as one note under the page line, never a failure. With
Chrome or Edge installed, the AI has the browser tool from the first request.

**New web projects with a look of their own.** `casper new web-app` starts with Tailwind and a small
theme file (colors with dark mode, a type scale, spacing, corners), a labeled form with empty and
error states, and 44px tap targets. New `casper new vite-react`: Vite, React and TypeScript with
the same theme, `bun test` with happy-dom, `tsc -b` and oxlint. A built-in `web-frontend` skill
guides UI work in a project that has no styles of its own yet; when the project has a look, that
wins and the skill stays out. `/skills block web-frontend@bundled` stops it. See
[NEW.md](NEW.md) and [The frontend skill](SKILLS.md#the-frontend-skill).

**Your Playwright tests as a check.** When a project already has Playwright tests, Casper runs them
as an `e2e` check after each change, next to typecheck, lint and test. It never installs Playwright
or its browsers: when they are missing the check skips and says how to get them. `/settings`
(Playwright tests) turns it off. See
[End-to-end tests](VERIFICATION.md#end-to-end-tests-playwright).

**`/preview` on your phone.** `/preview` puts the web app on your network and prints an address a
phone on the same Wi-Fi can open; you typed it, so it asks nothing. A public link needs a tunnel
tool you already have (`cloudflared` or Tailscale Funnel; Casper never installs one) and asks
first: `1 No · 2 Yes, make a public link`. The AI can't start either one. `/preview stop`, or
leaving Casper, ends both. See [Preview on your phone](SERVICES.md#preview-on-your-phone).

**Windows ARM64.** The first release with `casper-windows-arm64.exe`. `install.ps1` picks it on an
ARM64 PC, also from an x64 PowerShell running under emulation. It is built, started and installed
in CI on GitHub's ARM64 runner; the full test suite and the screen have not run on ARM64, and no
one has tried it on a real ARM64 PC.

**Safer, from an independent review.** An outside review of Casper's safety promises found places
where Casper didn't keep its own word, and this release fixes them:
- **ssh:** the host question names the machine ssh really reaches.
- **The read-only list** used when there's no sandbox checks every file a git command can read or
  write.
- **The sandbox** keeps git's rebase to-dos, `diff.external` and a moved agent store out of reach.
- **Installs:** hash-locked tool installs use Casper's own cache, and `casper update` refuses an
  installer it can't verify.
- **"✓ Verified"** now needs your own test command, unchanged: when a change rewrites what the test
  command runs (a `package.json` script, the files it names, a test config), the result is "could not
  compare".
- **A rewritten `.casper/project.yaml`** doesn't change the checks of the session that's running.
- **A repository can't change your own settings:** a profile it picks can't turn the sandbox or the
  reader off, or replace your lab, web or spend settings.
- **Lab boxes** are bound to what they showed.

Nothing here asks more than Claude Code would. Choices you made on purpose (the browser reaching your
LAN, remembering a program after "Yes, for this session") are unchanged. See [SECURITY.md](SECURITY.md).

**Fixes.** Two `casper learn` runs at once no longer fail when one creates a state file while the
other is looking for it. On macOS, a `commondir` file a sandboxed command adds to the project's
`.git` folder is removed when the command ends, even when the file watch missed it. On Windows the installer tries again for about 5
seconds when antivirus or a `casper.exe` that just closed still holds the file, and when removing
its staged download.

**For contributors.** `app.ts` is split into 14 modules under `src/app/` (code moved, not
rewritten), `bun run lint` runs oxlint with only the rules that catch real bugs (`bun run check`
and the Linux CI job run it), and 42 non-null assertions the types made unneeded are gone. The full
test suite and eval tests pass on Windows CI again and block a merge, and Casper's screen is tested
there in a real Windows console (ConPTY). Tests wait for the real signal (a file, the prompt, a
server's first answer) by a deadline instead of fixed pauses, so they pass on a loaded machine,
and CONTRIBUTING says what to do when CI is red on your PR. New
[ARCHITECTURE.md](ARCHITECTURE.md) shows how Casper is built: the pieces, one request end to end,
and every promise with the code and tests that keep it.

## v0.2.22: one box for every yes, and a network server Casper sets up

Every question that lets something happen is now the same numbered box, Casper can set up its own
network server for Mist, Central and ClearPass, device checks ask before they touch anything, and
the screen keeps up with you while the AI works.

**Casper sets up its network server.** Ask about ClearPass, Marvis or an SSID, or about Mist,
Central or Wi-Fi next to a network word, or type `/mcp setup network`, and Casper asks once: `1 Not now · 2 Set it up`. `2` installs
[casper-network-mcp](https://github.com/Choaterboater/casper-network-mcp) 0.1.1 into
`~/.casper/tools`, every package checked against a hash lock that ships inside Casper, and
connects it with writes off. Without uv the question shows uv's own installer and offers
`2 Install uv, then set it up`. `1` is kept, and Casper doesn't offer when you already have
hpe-networking-mcp, casper-network-mcp or a server named `network`. A web app's "central logging"
never brings it up. `casper new network-mcp` now builds your own server the same way: a
`--read-only` start flag, a change kind on every tool that changes things, and a login check that
says where the login can change things (and lists no places when it can't see them all). See
[Casper's network server](MCP.md#caspers-network-server).

**Logins asked on first use, by you only.** The first time the AI uses a product with no login,
Casper asks you (`1 Not now · 2 Add a login`), the secret typed hidden and kept in Casper's own
private file; the AI never sees it, and a login the server echoes back is hidden too. Casper then
says where it reaches: `Mist login: can change Branch-12 (checked)`. Mist and ClearPass are checked;
Central shows `saved (not checked)`, and means new Central (GreenLake) only for now. When the
product turns a saved login down, Casper asks `1 Not now · 2 Replace the login`. `/mcp login`
changes or forgets one. When Casper pins a newer server version it asks `1 Not now · 2 Update it`;
a failed update keeps the old one running. (Since then a newer casper-network-mcp release is offered
the same way between Casper releases; see [MCP.md](MCP.md).)

**One box for every yes.** Every approval is the same numbered panel: `1 No · 2 Yes, this once ·
3 Yes, for this session · 4 Yes, always for this project`, offering only the answers that fit. One
key picks, Esc is No, and a key pressed just as the box opens is ignored. Nothing asks you to type
`yes` any more: browser actions and debugger launches use the box, a project's MCP server asks
`1 No · 2 Yes, this once`, `/skills trust <id>` shows the skill and asks `1 No · 2 Trust it`, and
`/references add` asks `1 No · 2 Download`. A Junos show command's box offers `3 Yes, show commands
on <server> for this session`; commits and other commands still ask.

**The change box says what changes.** An MCP change shows the product, the change in plain words
and where the login can change things (from the server's own login check). Answering `2` or `3`
turns writes on for that server; `2` turns them off again afterwards. Each change has a kind:
config, troubleshoot, disruptive, firmware, delete or admin. Firmware, deletes and admin changes
are off by default on every server: a first box allows the kind, then the change box still asks
about each call. `3 Yes, for this session` never covers a disruptive or risky change or a tool
that runs commands, so one yes to a harmless command can't let a later reboot run. A tool the
server's own tool list never named, and a link check (cable test, ping, iperf), always ask. A
server can make a kind stricter, never safer. `/mcp allow <server>` picks kinds ahead of time from
a numbered list, for the session or remembered. The box's last answer, `Yes to everything on
<product> this session`, asks once more, then no box asks about any change on that product,
firmware, deletes, admin and reboots included, until ctrl+o or the session ends; the footer shows
`ALLOW ALL`. See [Change kinds](MCP.md#change-kinds-and-mcp-allow).

**Device checks ask, then reach any device.** A lab check no longer needs a lab list. When the
work needs one, the AI asks for it and Casper shows a box naming every device, with
`Not marked lab: core-r1 (10.1.2.3).` for the rest, and warnings when a playbook or jump host can
reach others. Only your answer starts it; it is never rerun or repaired on its own. `/lab import
<file>` adds devices to your lab list (GreenCLI's lab export, or one host per line) after
`1 No · 2 Add them`. The AI's `ssh` to a device on your lab list doesn't ask; `/lab ssh off`
makes it ask. The network skills push safely: on AOS-CX a checkpoint, confirm, then save; on Junos
and AOS-CX one device first, then one at a time, stopping at the first error. See
[Your lab](NETWORK-CHECKS.md#your-lab).

**Risky config lines in the receipt.** After a task changes config files, the receipt lists each
dangerous line it added and what it does: `risky configs/sw1.cfg:6 reload (reboots the switch)`.
Reload, shutdown, erase, `load override`, rollbacks and the like; saving is not risky. It is a
report, never a pass or a fail. The checker is GreenCLI's. See
[Risky config lines](NETWORK-CHECKS.md#risky-config-lines-in-the-receipt).

**Fewer questions with no sandbox.** On Windows, or Linux without bubblewrap, commands that only
read files in the project (`ls`, `cat`, `grep`, `git status` …) run without a box. The shell box
offers `3` and `4` for a command prefix such as `npm test`. A search over a folder that holds a
`.env` or key file still asks. `ssh` to a machine can be allowed for good (`4 Yes, always for this
project`; `/sandbox forget` undoes it). Script runs take `--allow-host`, `--allow-write` and
`--allow-reach` for that run only. See [SECURITY.md](SECURITY.md) and
[SCRIPTING.md](SCRIPTING.md).

**Tighter in a few places.** A project's `sandbox.denyRead` now also holds for the AI's file
tools and helpers, not only shell commands, and a refusal says why. When the sandbox fails to
start on a service the AI started, Casper asks first: `1 No · 2 Yes, this once · 3 Yes, don't ask
again`. ansible-lint gets file names after `--`, so a file name is never read as an option. A test
script the AI wrote in the project can become a check, and a read outside the project shows one
line: `[read] outside this project: ~/Projects`.

**Talk to it while it works.** Enter during a task steers: the AI reads your line at its next
step, or it waits in the queue for after the task (`↳ queued · runs when this task ends`); Esc
gives queued lines back, and a queued line never answers a box. The `/` menu stays open during
work and look-only commands run (`/diff`, `/receipt`, `/mcp`, `/details` …). Provider retries show
as they happen: `Can't reach openrouter · trying again in 4s (1 of 3) · Esc stops`. From the
second task on the footer keeps the session total. See [TERMINAL_UX.md](TERMINAL_UX.md).

**A plainer first run.** `/login` is one numbered list, OpenRouter first. Model errors say the
cause and one next step (bad key: `/login`; no credits: top up; rate limit: wait; too long:
`/compact`); the provider's own words are behind Ctrl+T. `/settings` turns web lookups, the
new-version notice, built-in skills, spend notes and the work shown on or off by number and saves
them for you. `/help <word>` searches the help, and a mistyped command gets "Did you mean".
`What are you building?` lists My own first. A check that timed out offers `Allow more time from
now on`.

**`casper update`.** A release binary installs the newest preview with that release's own
installer and checks; a checkout pulls fast-forward only. A session says when a new version is
out, from a check made in the background at most once a day (no model, no tokens). `/settings` or
`CASPER_NO_UPDATE_CHECK=1` turns the notice off.

**Smaller things.** The receipt's row is now `1 Show diff · 2 Undo`, so a stray `1` never undoes.
The folded steps line names the changed files. `/resume` is a numbered picker. Code blocks copy
clean, with no side borders. With OpenRouter the cost is what OpenRouter says it charged. The tab
title shows the conversation's name in macOS Terminal and iTerm2. Opening your home folder takes
half a second, not half a minute. Presets for a local Mist server (`mist_mcp`) and GreenCLI's
server. A project's MCP server may run from an absolute folder inside the project, and an entry
that is turned down says why. `/pane on|off` turns the steps pane on or off. OpenAI Codex sign-in
opens the browser on a desktop; the device code stays for SSH. Flowchart labels with `<` and `>`
(`List<T>`) show in full. AOS-CX REST secrets and webhook and DSN addresses (not local ones) are
hidden from the AI; a ternary's
`"pass" : "fail"` no longer is. The `mist-openapi` reference is gone (it gave nothing to search);
use `mistapi` or the network server. An MCP server or security tool that fails to install or start
says why.

**Windows.** Undo saves its copy before each task again (git couldn't open its empty config).
Session worktrees work, sign-in opens the whole address in the browser, the installer keeps your
`%USERPROFILE%` PATH entries as they were, and the receipt's undo and diff commands show the folder
as you'd type it. The old console gets an ASCII spinner. Windows CI now also runs the undo,
project root, sign-in, receipt and network server update tests; the full suite does not pass on
Windows yet.

## v0.2.21: a clearer screen, and pages checked on a phone

This is the first published preview since v0.2.15. It also brings everything built since then and
never published: v0.2.16 (build new things), v0.2.17 (undo and a real safety net), v0.2.18 (network
skills), v0.2.19 (asks before reaching other machines) and v0.2.20 (fewer layers); each has its own
section below. What v0.2.21 adds on top:

**The window title names the conversation.** The first request names it, with plain text rules and
no model call: "Build a small web app in this empty folder: an IPv4 subnet calculator." gives
`Casper · IPv4 subnet calculator`, and the title shows `◐ Casper · …` while Casper works. A resumed
conversation keeps its name, and the old window title comes back when Casper exits.

**How much of the work shows: `quiet`, `normal` or `detailed`.** `normal` (the default) is today's
screen: steps fold into one summary line when the model moves on, and failures keep their own line
(an edit that failed and was retried at once folds too). `quiet` prints the model's words, failures
and the receipt; a step that went well leaves no line. `detailed` prints every step, with a small
diff (up to 12 changed lines) under each edit, then `… 8 more lines · ctrl+t`. `/details
quiet|normal|detailed` switches for the session; `/details` alone goes to the next level. `display:`
in `~/.casper/config.yaml` or a profile sets the default; a project file that sets it is refused
(`display is a user setting`). On the rich terminal Ctrl+T shows the last finished step in full at
any level: an edit's whole diff, or what a command printed. See
[CONFIGURATION.md](CONFIGURATION.md#display).

**A colored edge on the result.** On the rich terminal the receipt gets a `▌` edge down its left
side: green for a pass, red for a failure, yellow for anything in between. The plain terminal and
`--verbose` print the lines as they were.

**Every page is also checked at phone width.** The page check opens each page a second time at
390px. A page wider than the screen fails with `✗ /wide at phone width (390px): the page is 650px
wide, so it scrolls sideways`; a text field that keeps less than 60% of its height there, or can't
show a line of text, fails with `✗ /tight at phone width (390px): input#address is squashed (20px tall;
49px on a wider screen)`; the verdict names `/wide doesn't fit a phone screen`. A page that fits
reads `✓ /ok loads · 0 console errors · fits a phone`. See
[Page checks](VERIFICATION.md#page-checks).

**Plain Bun and Node sites get the page check.** A project with no framework, whose dev or start
script runs its own server file (`bun --watch src/server.ts`, `bun run server.ts`, `node server.js`)
and has an `index.html` (also under `public/`, `static/` or `src/`), is a web project: Casper starts
that server with `PORT` set and opens `/`. An API with no page is not one, and a missing
`node_modules` says `Run bun install first` as before. A `package.json` whose scripts run `bun` is a
Bun project before its first lockfile, so its checks run with `bun run test`, not npm.

**A request at the empty-folder question runs.** At `This folder is empty. Start a new project
here?`, a request typed or pasted (three words or more) is not a wrong answer any more: it runs in
this folder as the first request. A short slip like `webb` still gets `isn't one of the choices`.

**Browser tools: more fields, one-element overflow, replay fixed.** `fill` now types into `number`,
`email`, `date`, `time` and `range` fields (also `datetime-local`, `month`, `week` and `color`);
password and file inputs stay out. `no-horizontal-overflow` takes an optional `selector` to check one
element instead of the whole page. `replay` accepts the nameless, url-less placeholder scenario some
models attach to every call (it used to refuse it, so no recorded check was ever replayed); a
scenario with a name or a url is still refused with `replay runs the recorded scenario unchanged;
send only action and id`. See [BROWSER.md](BROWSER.md).

**The receipt answers a claim about browser checks.** When the answer says the browser checks
passed and Casper's record says otherwise, the browser line says so: `✗ Browser checks failed: phone
— the answer above says they passed`, or `• Browser checks did not finish — the answer above says
they passed; Casper saw no passing browser check`. When some passed, the receipt counts them and
names the rest: `• Browser checks: 2 of 3 passed; not finished: Calculate a subnet`. Only a sentence
about checking in a browser counts as the claim; "bun test … serves the page and browser assets"
does not.

## v0.2.20: fewer layers

Fewer questions, fewer lines and fewer settings between a request and the work. The AI does the next
step itself, the receipt is one line when all is well, and the numbers on screen say what you are
charged.

**`casper new` asks the kind first.** `What are you building?` offers Network, MCP server, Web app or
dashboard, Python tool and My own, then, for a kind with more than one template, which one, with Back
first. My own is an empty folder with git and no template; `casper new empty <name>` is the
command-line way, and `casper new --list` lists it. Words typed at `Name it?` that aren't a name become
the next Enter choice: `Press Enter for config-backup-tool, or type another name.` See [NEW.md](NEW.md).

**The AI does the next step itself.** The project context now says what autonomy means in words: at
`high`, the default, the AI edits files, runs the tests and changes settings you asked for inside the
project, never tells you to hand-edit a file it can edit, and asks one numbered question only when
something outside the project is needed. What it builds is on by default, not disabled, hidden or
dry-run unless you asked; code that changes network devices still starts with writes off, said in one
line. Risk gets at most one short line, and answers lead with the result, with no requirements
checklist unless you ask.

**The AI can look things up.** `web_search` and `web_fetch` are on with nothing to set: DuckDuckGo by
default, no key; `web: { provider: brave }` uses Brave Search with your key saved as `brave` in Casper's
login file, and `web: { provider: searxng, searxngUrl: <address> }` your own SearXNG. They never ask,
and reach only public https pages on ports 80 and 443 (http is upgraded), checked again on every
redirect; private, local and cloud-metadata addresses are refused, and a query or address holding a
secret is refused, never sent. A search returns up to 8 results; a page comes back as plain text, up
to 12 KB. The Working box shows the query or address. `web: off` in your own config turns them off; a
project file can't change `web:`.

**A write outside the project asks.** Before the AI's shell, or its `edit` and `write` tools, write
outside the project, Casper asks `The AI wants to write to ~/Library/Application Support/SomeApp.`
(for the shell: `A shell command wants to write to …`) with `1 No · 2 Allow <folder> for this
session`; Enter writes nothing, one shell command asks once for all its folders, and nothing is kept
past the session. `/`, system folders, git's own folders and private places are refused without a
question; temp and package caches never ask. The receipt says `• Wrote outside the project: … (you
allowed it; no undo copy)`. See [SECURITY.md](SECURITY.md).

**Honest usage.** `/usage` splits tokens into `44k out · 131k new · 4.9M cached` and says how much
came from the cache: `Cache: 97% of input read from cache this session`. A subscription sign-in pays
no per-token price, so the footer says `sub ≈$0.31`, what the tokens would cost pay-per-token, and a
subscription or a free model is never noted, paused or stopped for money it isn't charged. See
[TERMINAL_UX.md](TERMINAL_UX.md).

**Spend notes, no pause by default.** A task gets one quiet line at about $1 (`… This task has used
$1.03 so far (312k tok).`) and one more at about $5, and keeps going. A limit said in the request
("keep it under $2") or `spend.pauseAt` adds the pause: `This task has used $5.02.` with `1 Stop here ·
2 Keep going`, and Enter stops. See [CONFIGURATION.md](CONFIGURATION.md#what-a-task-spends).

**The prompt cache is kept.** `cache: auto` (the default) asks for the long cache only where it costs
nothing extra: OpenAI, and non-Anthropic models on OpenRouter; Anthropic models and every other
provider get the short one. Casper's own tools stay offered once they appear and MCP tools are picked
once per session, because a changed tool list throws the cache away. `cache: long`, `short` or `off`
in your own config change it; a project file cannot. See
[CONFIGURATION.md](CONFIGURATION.md#prompt-cache).

**More projects get checks.** A Swift package gets `swift test` and `swift build`. uv and poetry
projects run unittest through their own Python (`uv run python -m unittest discover`). A Python build
check is set only when the `build` package is there (listed, or in the `.venv`), so `python -m build`
never fails with "No module named build". When the model sets up a project in this turn (writes a
`package.json`, say), its checks run on that turn; a result recorded before the change is kept while
its command is the same and runs again if the command changed. The AI is never offered a check that
can only skip.

**Browser calls with extra blank fields run.** A `serve` call that also carries `width`, `height` and
a placeholder `scenario` runs, and the result names what was not applied; an unknown field or action
still gets an error that says what to send. A loopback address without a scheme (`127.0.0.1:3000`)
opens as http.

**A detailed request builds as asked.** A request that already lists its requirements (two or more
list lines, most of them six words or more or with a detail such as a command, number, file or
example) gets no `Suggested: plan first` question. The checklist's cases are made quietly, no longer
printed before work; the receipt names one only when it is not met or could not be confirmed, and
`/receipt` lists them all. With the review round off, the model ends its answer with only the
requirements still open, not a full ticked list. See [TERMINAL_UX.md](TERMINAL_UX.md) and
[VERIFICATION.md](VERIFICATION.md).

**One-line receipt when all is well.** `✓ Verified · test passed · lint passed · 15 files changed ·
after 1 repair`. Anything else puts the verdict on line 1 and each problem on its own line; the
per-file table is behind `/diff` and `--verbose`, and `/receipt` shows the full form. A question that
changed nothing and ran no tests gets no receipt. The no-checks how-to is said in full once a session
and short after that. See [VERIFICATION.md](VERIFICATION.md).

**Smaller things.** The window or tab title said `casper`, not the bun or node that runs it (v0.2.21
now names it after the conversation). `/output all` lists every call of the last task on its own
line. The plain terminal prints `… bash · bun test` when a call is still running after two seconds,
so a long test run does not look hung. CI cancels an older run when a newer push lands and waits for
"Ready for review" on a draft pull request.

## v0.2.19: asks before reaching other machines

What v0.2.19 adds:

**Asks before the AI reaches another machine.** Before the AI's shell runs `ssh`, `scp`, `sftp`,
`rsync`, `nc`, `telnet` or `socat` to another machine, Casper asks `Reach 198.51.100.20 (build-server)?`
with `1 No · 2 Yes, this time · 3 Yes, for this session`, with the sandbox on or off. Casper reads
`~/.ssh/config` itself to name the real address; the AI never sees it. Enter runs nothing. It also
finds ssh inside `bash -c`, `$(...)`, loops and `xargs`, and a host in a variable asks every time.
A one-shot or `--json` run never waits: it refuses and says so. See [SECURITY.md](SECURITY.md).

**~/.ssh stays private in the shell too.** A shell command that reads `~/.ssh` or another private
place is refused before it runs, even with the sandbox off. Casper reads the words the way the shell
does, so `cat ../.ssh/config` from `~/Documents`, `cd; cat .ssh/config`, a glob, a quoted name,
`grep -r … ~`, a copy of your whole home folder and `ssh -G` are refused too. On screen a refused
command reads `— not run`, not failed.

**Secrets in notes and commands stay hidden.** Lab logins written the way people write them
(`root / X`, `root@pam / X`, `**Password:** X`, a Password column, `pw: X`), Proxmox tokens
(`user@realm!name=<uuid>`, `PVEAPIToken=…`, the secret `pveum` prints once) and passwords typed into
commands (`sshpass -p`, `curl -u`, `--password`) are hidden before the AI or the screen sees them.
When the AI typed a secret into a command, the receipt says to change it. See [SECRETS.md](SECRETS.md).

**An honest receipt about other machines.** The receipt lists what the AI's ssh commands changed
there, read from the command text: `• Changed on 198.51.100.20 (build-server) (from the commands Casper
saw): made an API token …; installed a service …`. An alias and its address are one line. Commands
that ran with no change Casper can read still get a line, and commands Casper stopped say
`• Not run on … : 3 commands Casper stopped before they reached it`, so "nothing changed on the
server" never stands alone. A task with stopped host commands is never a clean pass: the verdict
reads `• Incomplete — commands to 198.51.100.20 (build-server) did not run` and a one-shot run exits 2. The JSON receipt carries `remoteChanges`, `remoteNotRun` and
`secretInCommand`.

**The work in a folder inside.** When the work lands in a project inside the open folder, Casper
runs that project's own checks for the receipt (`✓ test passed (checks from sample-tools · python3 -m
unittest discover -s tests)`) and asks `The work is in ~/Documents/sample-tools.` with `1 Stay here ·
2 Switch there`. Python projects with unittest tests and no pytest are now found. `/verify` with
nothing to run says so in one line and names a folder with tests; `/project <name>` opens a project
folder inside this one; a typed folder name that isn't there offers to make it (Stay first).
"new project sample tools" makes `sample-tools`. In a huge folder that isn't a project, the receipt says
why changes are unknown and lists what Casper's own edit and write tools changed. See
[VERIFICATION.md](VERIFICATION.md).

**A quieter screen.** One line per tool call in a Working box that folds into `✓ 14 edits · 6
commands · 38s` when the AI moves on; times only from one second up, on checks too; short command
labels, with `/output` for the whole command. The box is gone before the receipt. See
[TERMINAL_UX.md](TERMINAL_UX.md).

**What a task costs.** The footer shows the task's tokens and cost from the model's price. At about
$1 one quiet line; at about $5 the task pauses with `1 Stop here · 2 Keep going` (Enter stops). A
one-shot run stops there and exits 2. `spend.noteAt` and `spend.pauseAt` in your own config change
the limits. See [CONFIGURATION.md](CONFIGURATION.md#what-a-task-spends).

**tmux and iTerm2, with nothing to set.** Inside tmux (or iTerm2) the busy steps go to a view-only
pane beside Casper that closes when Casper exits; the pane title and done bell follow. `/tasks` lists
what runs in the background (dev servers, the browser, the debugger) and stops one, with `1 Keep
them` first. See [TMUX.md](TMUX.md).

**Smaller fixes.** Every call to OpenRouter now carries Casper's name (some showed as "Unknown"), and the link it sends points at Casper's site, which now has the ghost icon; OpenRouter may list it as a new app. A task whose check
has a label or its own name is recorded in project memory again (it printed `[memory] Task outcome
was not recorded`). From source, a pull that added a package no longer stops the start with a
module error: Casper prints `New parts were added. Run: bun install  (in <folder>)` and exits 1, and
macOS never loads the Linux sandbox helper.

**Not done yet.** With the sandbox off, a program that opens its own connection (`curl` or `pvesh`
to a Proxmox API, a Python script) reaches other machines with no question. Casper doesn't follow
`Include` or `Match` in `~/.ssh/config`. ssh through the sandbox on macOS, and the iTerm2 split, have
not been tried on a real Mac yet.

## v0.2.18: network skills

**Network skills pack.** Six short how-to files for network automation are built into Casper:
Juniper Mist API, new HPE Aruba Networking Central, classic Central, AOS-CX REST API, Junos (PyEZ,
NETCONF, `| display set`, `commit check` and `commit confirmed`) and ClearPass REST API. A request
that names the product ("list APs per site in Mist", "commit confirmed on an MX") gets that skill
for that one request, picked by a local word match with no model call; other requests pay zero
tokens. At most two load per request. Each skill teaches the calls that ask for data first, marks
every change call `WRITE:` and tells the AI to stop and ask you before any change, keeps
credentials in environment variables, and shows how to test with saved sample data instead of live
calls. `/skills` lists them as `[bundled; trusted]`; `/skills block <id>` stops one;
`skills.bundled: false` in your own config turns them all off (a project file cannot). A skill of
your own with the same name replaces a bundled one only while it keeps the stop-and-ask wording.
Projects whose Python packages include `mistapi`, `pycentral`, `pyaoscx`, `pyclearpass`,
`junos-eznc` or `ncclient` are now detected. See [SKILLS.md](SKILLS.md).

**More reference repos.** `/references add pyaoscx`, `pyclearpass`, `mistapi` and `junos-pyez`
fetch those public SDKs for local search; the pycentral entry now says MIT (it said Apache-2.0) and
searches its largest file. The `mist-openapi` entry gives nothing to search today (its repo layout
changed and the spec file is over the 4 MiB search limit); use `mistapi` or `lookup_api`. See
[REFERENCES.md](REFERENCES.md).

**Facts not checked against vendor docs.** The vendor doc sites could not be reached while the
skills were written; facts come from the public SDK repositories, and anything else says "check the
current docs".

## v0.2.17: undo and a real safety net

**Undo, redo and diff per task.** Casper keeps a private copy of the folder before and after each
task, in its own git folder under `~/.casper` (never your `.git`), also in folders that are not git
repositories. The receipt row offers `1 Undo · 2 Show diff`; Enter runs nothing. `/undo` never
touches a file you changed since the task (it asks, with `1 Cancel` first; a one-shot run changes
nothing and exits 1), `/redo` puts the files back, and `/diff` shows only this task's changes. The
conversation is rewound only when nothing was said since; otherwise the model gets one short note.
Undo says what it can't reach: secret files and files over 8 MB (never copied), ignored files,
nested repositories, MCP servers and devices. A file that was there before the task but had no copy
(git ignored it then, or it was over 8 MB) is never deleted, a file saved while Casper asks is left as
it is, and a file made again gets your usual permissions. A file the task made over 8 MB is named, not
counted as deleted, and an undo or redo that put nothing back can be tried again. `casper --json /undo`
lists the files it put back. `/status` shows the copies' disk size. Saving a remembered test command is undoable. The
change summary after a receipt now lists only the task's files, not your own earlier edits. See
[UNDO.md](UNDO.md).

**Saved receipts.** `/receipt` shows the last receipt after a restart, `/receipt 12` and
`/receipt list` older ones. They are saved with no check output and with secrets hidden.

**Stricter "verified" (design decision).** The JSON `outcome` is `verified` only when the receipt's
first line is `✓ Verified` (a proven change). "Checks passed — not proven" is now `not_verified`,
so `--require-verification` exits 3 for it; `checksPassed` still says the checks passed. The JSON
receipt fills `task` and `undo`. Evaluation scores that count `verified` move with it; re-score
saved runs with a free replay. See [SCRIPTING.md](SCRIPTING.md).

**Command-line traps.** An option after the prompt (`casper fix the bug --verify`) exits 64 before
anything runs; put options first, or quote the whole
request (`casper "fix the bug --verify"`) to send them as words. `casper <folder>` opens that folder, and a
single word that can only be a path but is not a folder exits 64 with "Not a folder" (a quoted
request such as `casper "fix src/app.py"` is still a prompt). A one-shot receipt run with `--cd`
prints its undo command with the same `--cd`.

**The shell sandbox.** Every shell command Casper runs now goes through one sandbox: the AI's
shell, your checks (proof and trace copies too), services and dev servers, network and security
tool runs, and `uv`/`bun` in `casper new`. On Linux it is bubblewrap with seccomp (install
`bubblewrap` and `socat`); on macOS `sandbox-exec`. A command can write only the project, temp and
package caches, can't read `~/.ssh`, cloud logins or Casper's own approvals, can't change git's
hooks or config (a submodule's too), and reaches only listed package registries and code hosts. Any other host asks
`1 No · 2 Allow for this session · 3 Always for this project` (Enter keeps it blocked; a run that
can't ask blocks it and says so). Dev servers and services keep the machine's network so you can
reach them; network and security tools get none (Linux). A check the sandbox stopped reads
`✗ test — blocked by the sandbox (wanted to write …)` and is never sent for repair. While planning
the project is read-only to the shell. The banner and `/status` show a `shell` line; `/sandbox`
shows what it holds and `/sandbox forget <host>` takes a host back. On Windows, or Linux without
bubblewrap, nothing holds the shell: it says so, and the AI's shell asks `Run this command?` before
each command (`1 No` first; a one-shot run refuses and names `--no-sandbox`). `--no-sandbox` (or
`sandbox: off` in your own config) turns it off; the receipt and the JSON `sandbox` field say so.
Only you can widen it (`sandbox.allowedDomains`, `sandbox.allowWrite`, `shell.keepEnv` in
`~/.casper/config.yaml`); a project can only add denies, and a repo's `.pi/sandbox.json` is
ignored. The AI's shell no longer gets AI provider keys, and Pi's long-output logs go in a private
folder removed at exit. The service tool refuses the same git commands as bash. The compiled Linux
executable carries the seccomp helper. See [SECURITY.md](SECURITY.md), which now names the test
behind each claim (a test checks the doc against the code).

**The AI security review.** After its tools, `/security-review` now offers
`1 Stop here · 2 Run the AI review`, with the files it would read (this branch's changes against
the default branch, else your changes since the last commit), the model and a lower-bound cost.
Enter stops and spends nothing. The review is one read-only child on your review model with its own
bounds (30 steps, 120 reads, 10 minutes): no shell, no edits. Key files, `.env` files and files
gitleaks flagged are never opened for it and its greps leave their lines out; everything else it
reads is scrubbed, device configs included whatever `/secrets files` says. A finding is shown only
with a real `file:line` here and an example input, labelled `(the AI's opinion, not checked by a
tool)`; the rest are counted as not shown, and the tokens used are named. Nothing the AI says can
approve or hide an ignore. A one-shot or `--json` run never starts it by itself; `casper
"/security-review ai"` runs it without asking. `casper security` still never calls a model. See
[SECURITY_CHECKS.md](SECURITY_CHECKS.md#the-ai-review).

**Where a release was built.** The release job now signs GitHub build provenance over every file in
`SHA256SUMS`, and waits for the Linux, macOS and Windows previews to pass on the same commit. When
`gh` is installed and signed in, `install.sh` and `install.ps1` check it after the SHA-256:
`Verified: built by GitHub Actions from Choaterboater/casper.`, or `This download doesn't match a
Casper build from GitHub. Nothing installed.` Without `gh` they say `Checked SHA-256. Install gh to
also check where it was built.` A macOS preview workflow runs the suite and the live sandbox tests;
Linux CI installs bubblewrap and runs them too. Dependabot keeps the workflow pins current.

If the sandbox can't start when first used, Casper says so once, the AI's shell asks from that
command on, and checks go ahead not sandboxed, as the receipt says. On a busy Linux machine a command
now waits for the sandbox's network relay before it runs, so its first request is not lost. The empty
stand-in files the Linux sandbox puts in the folder you started Casper in (`.bashrc`, `.gitconfig`,
`.vscode` and the like) are removed as soon as no command runs, so they no longer show in `git status`
or in a receipt's changed files.

**Limits of the sandbox.** MCP servers, language servers, the debugger, the browser and lab checks
are not in it; a receipt whose lab check ran says it ran outside the sandbox. Dev servers keep the machine's network on Linux, and inside the Linux sandbox
`localhost` is the sandbox's own. Windows has no sandbox yet.

**Plan editor asks before it builds.** On the rich terminal, Enter in the plan editor (plan first
or `/plan`) no longer builds straight away: it goes on to "Build this plan?" with `1 Stop · 2 Build`,
as the plain terminal already did, so Enter never starts a build that uses tokens. Esc still stops.
One-shot and `--json` runs are unchanged: they show the plan and build nothing.

## v0.2.16: build new things

Start new projects, see pages load after edits, retry a stuck repair on a bigger model, and run
network and security checks, all without spending tokens unless you pick a paid choice. See
[NEW.md](NEW.md), [VERIFICATION.md](VERIFICATION.md), [NETWORK-CHECKS.md](NETWORK-CHECKS.md),
[SECURITY_CHECKS.md](SECURITY_CHECKS.md) and [SECURITY.md](SECURITY.md).

**New projects (`casper new`).** `casper new` asks the kind and the name, builds the project in
`~/Projects/<name>` with `uv` or `bun`, runs its own tests, makes the first commit with your git
settings, then opens Casper there. No model is called. `casper new <template> <name>` asks
nothing; `casper new --list` shows the templates: Python tool, MCP server for your network, Mist
Python scripts, web app, NOC dashboard (Streamlit), Aruba CX Ansible and Junos Ansible. The last
line says `Ready: … tests passed`, never "verified". Exit codes: 0 ready, 1 created but not ready
(or nothing created), 64 usage. Inside Casper, `/new` does the same. Started in an empty folder,
Casper asks once whether to start a project there. A request like "build a tool that lists Mist
APs per site" outside a project asks `Build this as a new … in ~/Projects/<name>? 1 Use this folder
· 2 Yes · 3 Other kind` before the model starts (Enter keeps the folder). One-shot, `--json` and piped runs never ask:
they keep the folder and print the `casper new` command.

**Page checks.** In a web or Streamlit project, after the model edits files that reach a page,
Casper starts the dev server (it says so first, because it runs your project's code), opens the
changed pages and reports `✓ /dashboard loads · 0 console errors`. A failing page is line 1 of the
receipt and goes to the repair. Without Chrome the page is fetched over HTTP, and the receipt says
the console was not checked. `pages:` in `.casper/project.yaml` picks up to 8 pages, or `off`.
SQLite migrations are applied to a throwaway database after a change to the migrations folder
(Postgres is never run on its own).

**Your big model.** When repairs run out, an interactive session asks once: `1 Stop here · 2 Retry
with your big model` with the model and a lower-bound cost (`at least ≈ $0.72`). Enter stops. It
is not offered when you are already on it or when it can't hold the conversation. Casper switches
back afterwards. `/model big <model>` sets it; `repair.bigModelLastTry: true` in your own config
runs the last repair on it without asking.

**Suggested next steps.** Under the receipt, the row of numbered steps can include suggestions from
slot 3: add a test that proves the bug stays fixed, remember a test command (only a known test
runner the model ran and passed, with the exact line saved), or save an Ansible check Casper
found. Nothing blocks and nothing runs until you press a number. A suggestion you ignore 3 times
in a project is hidden there for 14 days. `/suggestions off` or `suggestions: false` turns them off.

**Plan first.** A request that asks for several things offers "plan first" inside the checklist
panel, so there is still one question before work. `/plan <request>` plans straight away. While
planning, only look-only tools run: edits, MCP tools and Casper's own tools are refused, and a file
that changes anyway is named on the receipt. The plan opens in the editor: Enter builds, Esc stops.

**Network checks.** Casper finds Ansible playbooks and offers ready-made checks (Aruba CX and Junos
syntax, Junos render); they run only after you save one with `/verify add <name>`, and never with
the repo's own `ansible.cfg`. Junoser, yanglint and hier_config checks can be named under
`verify.checks`. hier_config gives a report (a diff), never a pass. **Lab checks** (`junos-commit`,
AOS-CX `ansible --check`) run only when you type `/verify <name>` and pick Run on the lab (Skip is 1, so Enter
sends nothing); the hosts must be in
the lab list in `~/.casper/config.yaml`. A lab dry run that passes is shown but never makes a run
Verified. The AI can't start a lab check.

**Security checks.** `/security-review` and `casper security [folder]` run gitleaks, ruff S,
semgrep with Casper's own rules, zizmor, osv-scanner and ansible-lint on your project, with no
model call. Missing tools are installed only after you pick Install, from pinned hashes. An ignore
added since the last commit counts only after you approve it (Enter leaves it flagged), and approvals are kept in
`~/.casper`, never in the repo. The report says what the tools found; it never calls code safe or
secure. `casper security` exits 0 with no problems, 1 with problems, 64 on a usage mistake;
`--mcp-tools <file>` turns on mcp-scanner.

**Enter is the safe choice.** Enter picks choice 1 at Casper's numbered questions, and choice 1
now never builds, installs, downloads, spends tokens, remembers or reaches a lab: Stop, Not now, Use
this folder, Leave it, Just this time or Keep writes off. `Build this plan?`, the new-project, model
failure, timeout, already-failing and security-install questions were reordered, and in the `/mcp`
boxes `2` now remembers a server or turns writes on. The AI's own questions are unchanged.

**Safety fixes.** The AI's file tools no longer open private places (`~/.ssh`, login files),
follow links out of the project or change git's own files. Values in `.env` and credential files
are hidden from the AI. Repo checks, services and dev servers run without AI provider keys.
Questions from the AI start with `The AI asks:`. Casper's release workflow pins every action to a
commit, and the job that publishes runs no project code. See [SECURITY.md](SECURITY.md).

**Scripts.** `--json` adds check fields `kind`, `label`, `hosts`, `summary`; the `pages` phase; and
receipt fields `pages`, `checksPassed`, `repairModels`, `bigModel`, `security`, `task`, `undo`,
`changedWhilePlanning` and `pageNotes`, all within `v: 1`. `outcome` and exit codes are unchanged.
See [SCRIPTING.md](SCRIPTING.md).

**Decisions still open.**
- Lab checks ship now, started by you only. The design review moved them to v0.2.18, behind the
  sandbox's network allowlist, because Casper can't block other network traffic yet. The question
  before each run says so.
- The SQL migrations check ships now; the design review had moved it to a later list.
- All seven templates are listed as ready.

**Moved to v0.2.17, with the reason.**
- The security *model* review (a model reading code for security problems): it must wait for the
  shell sandbox and the wider secret hiding, so the model can't read files the tools flagged.
- Undo, `/diff` per task and saved receipts (`task` and `undo` stay `null` in JSON until then);
  the remembered test command is not yet undoable.
- The shell sandbox: the AI's shell, dev servers, checks and lab checks are not held back by the
  operating system yet. Pi's temporary shell logs get private permissions with it.

**Limits.**
- None of the new checks is sandboxed. Dev servers and checks run the repository's code with your
  permissions and network. Use `--no-verify` in a repository you don't trust.
- The plan turn's look-only list is a list, not a sandbox (for example `git diff` honours a
  repository's own `diff.external`).
- The AI's shell can still write your approvals and lab "Always" answers in `~/.casper`.
- ansible-lint loads the repository's own Ansible plugins; only `ansible.cfg` is kept out.

## v0.2.15: MCP for network servers, with writes off by default

This release is about MCP servers (tool servers the AI can call) for network gear:
hpe-networking-mcp, junos-mcp-server, Mist, NetBox and others. The goal: the AI can
read from your network by default; MCP write tools stay off until you turn them on,
and other risky calls ask you first. See
[MCP.md](https://github.com/Choaterboater/casper/blob/main/docs/MCP.md) and
[SECRETS.md](https://github.com/Choaterboater/casper/blob/main/docs/SECRETS.md).

**Behaviour change: every MCP server starts with writes off.**
- Write and delete tools are hidden. If the AI calls one anyway, it gets
  `Not executed (<server> writes are off. Only the user can turn them on with /mcp writes <server>.)`
- To turn writes on, type `/mcp writes <server>` and pick `1`. Only you can do this.
- While writes are on, the footer starts with `WRITES: <servers> · ctrl+o`. Press
  ctrl+o (or type `/mcp writes off`) to turn them off at once.
- Other tools that may change things (tools with no label, tools that run commands)
  stay visible unless a preset hides them, and they ask you every time.

**Read-only only when the product says so.**
- Casper calls a login read-only only when the product itself says so, through an
  `access_check` tool. Without that, `/mcp` shows `access not checked`.
- A tool marked `readOnlyHint: true` still runs without asking, as in 0.2.14. That is
  the server's own label, not a check.
- Casper's own labels, word lists, presets and guesses can only make things stricter
  (ask more, hide more). They never skip an approval and never claim read-only.

**Presets for known servers.** While writes are off, Casper starts known servers with
their own read-only settings (for example `HPE_MCP_ACCESS_PROFILE=safe-read-only`).
`/mcp` says whether the server confirmed them.

**Servers you already set up.**
- Servers in `~/.claude.json`, `~/.mcp.json` and VS Code's `mcp.json` show up in
  `/mcp`. Each needs one `/mcp connect` the first time.
- After that, Casper can remember the server (a keyed hash in
  `~/.casper/mcp-consent.json`), so it connects on its own next time, always with
  writes off. If the server's settings change, Casper asks again.
  `/mcp forget <name>` drops it.
- Project servers, and `npx`/`uvx`-style servers without a pinned version, are never
  remembered.

**Approvals.**
- Each tool gets the strictest of: the server's labels, Casper's word rules, and the
  0.2.14 label. Words like `bounce`, `reboot`, `delete` and `rollback` always ask,
  even on a tool marked read-only.
- A call through a router tool is judged by the real tool behind it.
- If the AI sets `confirm`, `force` or `dry_run=false` itself, in any spelling,
  Casper asks.
- The approval box shows the mode (`EXECUTE` or `preview`) and hides passwords and
  keys. When the tool has a preview switch, it offers `p` to run a preview first.
- Only your typed `yes` runs a call.
- Questions from a server (MCP "elicitation") go only to you, and only during a call
  you approved.

**Device secrets hidden from the AI.**
- Passwords, RADIUS/TACACS keys, Wi-Fi PSKs, SNMP communities, other device keys
  and login tokens are shown to the AI as `<secret hidden>`. This covers MCP results,
  config files, and command output that looks like a config.
- A change that carries `<secret hidden>` back is refused.
- `/secrets` shows the state. `/secrets files off` turns file hiding off for the
  session.
- If netconan (a config anonymizer) is installed, it runs as an extra check.

**Calls and results.**
- Each server can have its own time limits: `connectTimeout` and `callTimeout`.
- Progress messages from the server restart the call's clock.
- Failures come back in plain words and tell the AI not to retry. When a server
  fails, `/mcp` shows its last output lines, with secrets hidden.
- Long results: each list is cut on its own, the next-page cursor is always kept, and
  repeated text is dropped.
- Tool search matches plurals, `find_capability({ query: "*" })` lists every tool,
  and bad arguments name the wrong field.

**Docs and references.**
- hpe-networking-mcp's docs tools (`lookup_api`, `search_docs`, `ask_docs`) are
  always offered to the AI.
- `/mcp docs` adds a docs-only copy of that server with no credentials, after you
  type yes.
- `/references add` downloads a vendor spec repo (Mist OpenAPI, Junos YANG,
  pycentral) so you can search it locally, after you type yes.

**New command: `casper mcp check [repo]`.** It checks an MCP server you built: runs
its doctor and tests, compares its labels with its tool names, and checks its
schemas, its example configs, and whether it starts cleanly. By default it tries to
run offline (best effort: it drops credentials it can see and blocks web proxies, but
a program can still reach the network on its own) and calls no tools. `--live` makes a
few read calls. It runs the repo's own code, so
use it only on repos you trust. See
[MCP.md](https://github.com/Choaterboater/casper/blob/main/docs/MCP.md#check-a-server-you-built).

**Limits (please read).**
- Labels and the Junos `show` check look at names and command text (word lists).
  They do not know what a tool really does. A server that marks a tool that changes
  things as `readOnlyHint: true`, under a read-style name, is trusted.
- Secret hiding knows common formats only. It is best effort and will miss some
  secrets. Secrets the AI already saw, and text that `casper learn` reads, are not
  hidden.
- The `<secret hidden>` check stops the marker itself, not every rewrite: a script
  can still overwrite a config file. It also stops edits and commands that only
  mention the marker.
- Hiding values in the approval box is for your screen only. The server still gets
  the real values.
- Remote (HTTP) servers cannot get read-only settings from Casper; Casper can only
  hide their write tools.
- MCP gives no link between a server question and the call it belongs to. A question
  that arrives while exactly one approved call runs on that server is shown under
  that call.
- If an LSP or browser approval is open when an MCP approval comes in, the MCP call
  can be refused as `you said no` without asking you.
- None of this is a sandbox. The AI's shell and file tools are unchanged. They can
  still reach MCP settings files or run commands.

## v0.2.14: see it build, trust the result

**Receipt:** line 1 is the verdict: `✓ Verified — the checks pass, and the tests fail without the
change`, `✓ Checks passed — not proven: <why>`, `✗ Failed`, `Incomplete`, `Not verified`, or
`✗ Stopped — cancelled; changes already made are kept`. Check lines read `✓ test passed (npm test,
0.4s)`. `--json` receipts add `verdict` and `proofSkipped`; `outcome` and exit codes are unchanged.
See [VERIFICATION.md](VERIFICATION.md#receipts).

**Unfinished checks:** a check that timed out or could not start is marked as unfinished (`--json`
check events carry `ended: "timeout"` or `"no_start"`), not as the code failing, and it is never handed
to a paid repair. The terminal asks: 1 Retry · 2 Fix it anyway · 3 Allow more time (four times the
limit, at least a minute, at most an hour), and the receipt says `✗ Not checked`, not `✗ Failed`. While a
question or the checklist waits for you, the footer says `? waiting for you` instead of spinning.

**Already failing:** before a repair, Casper checks whether the failing test also failed before the
change; if so it says so, and the terminal asks before paying to fix it.

**Model errors:** a provider failure such as an empty response is retried once on its own, and then
the terminal asks whether to retry or stop. When the model fails after editing, Casper still runs the checks on its edits (no
repair) and the receipt says how they fared and suggests another model.

**Watching it work:** the footer shows the task's stages (`checklist ✓ · building ✓ · checks ·
1m05s`); each check prints one line as it finishes; edit and write lines show their size (`+18 -4`); a
bell rings when a request that ran 10 seconds or more finishes or needs you (rich terminal only).
Question choices show numbers, and pressing a number picks it. The banner and `/status` say which
checks run after a change, and `/receipt` is in the command list. Shift+Tab remembers the effort
level it stops at, like `/effort`.

**Sign-in:** with no model set, Casper opens sign-in on your first request instead of printing a
failed receipt, then picks a model for that provider (OpenRouter: `deepseek/deepseek-v4.1-flash`).
It never replaces a model you chose.

**Repositories:** Python detection covers uv, poetry, `.venv`, `python3 -m`, `requirements*.txt`
and `[tool.mypy] files`. In a git repository the change list comes from git, and the proof copy
links `.venv`/`venv` like `node_modules` instead of copying it, so a 30,000-file virtualenv no
longer slows every task. Launched from a folder of projects, Casper asks which one to open. A
request that opens with a build verb ("add a config loader") is treated as building.

**Tools:** Pi's own read/edit/write rules are back in the model's prompt (Pi drops them when a
custom prompt is set). A bash timeout above one hour is capped at one hour. Calls that ask you or
drive shared state (ask, MCP calls that may need approval, browser, LSP) run one at a time, and a
delegate turned away as busy no longer spends the task's delegation budget.

**Security:** the `--json` receipt redacts secrets in the proof's failing output and review items.
The proof step never deletes or writes through a folder the change turned into a link. Your own
MCP servers (user and profile config) start in your home folder unless their `cwd` says otherwise,
and a project server's review names each variable it sends and where (`sends $TOKEN to
https://example.com (header Authorization)`).

**Git safety:** the model's bash may not run `git stash`, `git reset --hard`, `git checkout --`,
`git restore`, `git switch -f` or `git clean`, which can set aside or discard your uncommitted work.

**Docs:** git commit/push policy and "ask before destructive operations" are described as what
they are, instructions in the model's prompt, and auto checks as running the repository's
commands without asking (`--no-verify` opts out for a run).

## v0.2.13

The first published build since v0.1.0. It carries every change below. The 0.2.12 build was never
published: its binary could not use stored OAuth sign-ins (fixed here, see below), and the installer
URLs that pointed at it returned 404.

**Request checklist:** before an interactive code change (implement, fix or test), Casper lists the
cases the request states and shows them in the prompt editor, where you can edit them or press Esc to
skip; the model then writes one test per case. On by default for interactive code changes,
`verification.checklist: false` turns it off, `true` also enables it for one-shot runs. Long requests
work: up to 80 cases, a 24,000-token answer, bullet-list answers accepted, and a cut list says how many
cases were left out. The requirements list no longer drops open items past its 50th line, so an
admitted gap always makes the change not verified. See [VERIFICATION.md](VERIFICATION.md#request-checklist).

**Casper checks its own work by default:** a new project's first change runs the checks and repairs
failures with no command from the user (before, it only suggested `/verify` until the checks had been
timed, and one-shot prompts needed `--verify`). `--no-verify` opts out for a run.

## v0.2.13: scripting surface

Phase 2: one-shot runs are scriptable. `--model <provider/id[:effort]>` and `--effort` choose
the model and effort for one run and never change the saved default. `--json` streams JSON Lines
events (`"v": 1`) on stdout and moves human output to stderr. `--continue` and
`--resume <id-prefix>` pick up a conversation, `--cd <path>` opens a folder, and `--max-turns <n>`
bounds each request. `--require-verification` makes unverified changes exit 3. **Exit code
change:** command-line mistakes (unknown options, conflicting flags, bad `learn` arguments) now
exit **64** instead of 2 or 1, so 2 always means incomplete. See [SCRIPTING.md](SCRIPTING.md).

## v0.2.13: Casper runs the checks

Phase 1: after the model edits files, Casper runs the project's checks itself
(`verification.mode: auto`), repairs failures within `repair.maxAttempts`, and ends each
task with a plain receipt ("✓ Verified by Casper: test passed"). `--verify` now means
`auto` for the run and `--no-verify` means `off`. Unconfigured sessions, interactive and one-shot,
use `auto` from the first change (Casper checks its own work by default); interactive sessions offer
checks measured at 60 seconds or more instead. The detailed evidence
receipt moved to `/receipt` and `--verbose`. `verification.checks` selects the checks, and
the default per-check timeout is now 600 seconds. See [VERIFICATION.md](VERIFICATION.md).

**Compiled-binary sign-in fix:** the unpublished 0.2.12 binary could not use any stored OAuth sign-in
(OpenAI Codex, GitHub Copilot, Anthropic, OpenRouter): model requests failed with
`OAuth auth derivation failed … Cannot find module './github-copilot.js'`. The OAuth flows are now
embedded in the binary. The source CLI was unaffected.

## v0.2.13: independence and review fixes

Phase 0 lands the full review fixes, including untrusted project-resource isolation,
side-effect-free informational flags, terminal sanitization, explicit project-server
consent, bounded cleanup, and release builds without stray `.bun-build` files.

**Environment migration:** use `CASPER_AGENT_DIR`, `CASPER_OFFLINE`,
`CASPER_OAUTH_CALLBACK_HOST` and `CASPER_TUI_WRITE_LOG`. Inherited matching `PI_*`
settings are no longer fallbacks. A conflicting `PI_CODING_AGENT_DIR` is ignored
with a `[config]` startup warning, so Casper does not silently use another agent's credentials
or conversations. Explicit Casper stores receive no legacy import. See
[CONFIGURATION.md](CONFIGURATION.md#environment-variables).

Runtime copy now uses Casper/conversation terminology. Synthetic MCP fixtures use
neutral vendor/router-catalog names. Saved evaluation reports redact home and temp
prefixes; the committed historical reports are scrubbed too.

## Changes since v0.1.0

Correction: `/login` now mounts every provider/method, consent
and private-input panel in Casper's existing renderer. Previously a second
renderer sent cursor controls through the transcript sanitizer, printing literal
`\u{d}` and appending navigation updates. Login panels no longer become transcript
entries; standalone authorization URLs/device codes remain visible above them.

Source replaces the login selection log with Pi's `SelectList` and renderer.
Provider/method highlights redraw in place; parsed application arrows, fragmented
and batched navigation, and encoded Enter are handled without carrying keys into
consent or private submission. macOS production-CLI PTY and login/security tests
cover the correction. Windows CI includes keyboard regressions, but a Windows-host
run of this change is still pending.

Source also includes a coordinated terminal presentation update: width-aware
message/result/approval panels, semantic colors, Pi Markdown streaming, grouped
help/status/verification output and action-first assistant instructions. Exact
approval uses a separate input editor and restores the original draft/cursor.
The offline demo covers streaming, tables, Unicode, resize, approval and errors.

Terminal layout is stabilized: the `/` popup and model/effort pickers are
composited over the transcript instead of appended, a rows-only resize keeps
scrollback, the prompt gutter and footer state dot never shift, tool lines are
redrawn in place with a live progress line, and `/output [n]` recalls a tool
call's full retained output. Coding receipts name the files that actually changed
(before/after tree digest, plus changes made later during checks/repair) and append
a bounded `git diff --stat`. Interactive sessions offer `casper_check` by default;
`--no-verify` withholds it, and model-issued bash without `timeout` gets a
120-second default. `casper --version` prints `casper <version> (<path>)`.
See [TERMINAL_UX.md](TERMINAL_UX.md) and the bundled reference notices.

Source adds optional fast/build/reason/review aliases, explicit effort suffixes,
and model-backed automatic effort through the existing Pi session owner.
Automatic effort is opt-in, exposes its effective level/fallback, preserves
conversation preferences, and reports classifier usage separately. Read-only
children now route through Casper roles/defaults instead of shared Pi defaults.
See [CONFIGURATION.md](CONFIGURATION.md) for request-sharing and precedence.
Local fixture/terminal checks do not establish live-model classification quality
or lower cost.

The [evaluation suite](EVALUATION.md) gains `--repeat`/`--model`, three harder
single-module tasks, two multi-module fulfillment tasks and credential-free
preparation/grading.

None of this is in the published v0.1.0 binaries; Windows/Linux host validation of
these changes remains pending.

## Build

Build with Bun **1.4.0**, the runtime used for this preview:

```sh
bun install --frozen-lockfile
bun run check
bun run build:release                 # host target
bun run build:release -- --all         # all six release targets
bun run build:release -- --target bun-windows-x64
```

`scripts/build-release.ts` uses the shared compiler in `scripts/compile.ts` and
writes a fresh `dist/release/`. A host-only build replaces that directory with only
the host artifact; publish the complete `--all` output, not a partial rebuild. A
first `--all` needs network: Bun downloads the target runtimes into its cache.

| Artifact | Platform |
| --- | --- |
| `casper-darwin-arm64` | macOS, Apple silicon |
| `casper-darwin-x64` | macOS, Intel |
| `casper-linux-x64` | Linux, x86-64 |
| `casper-linux-arm64` | Linux, arm64 |
| `casper-windows-x64.exe` | Windows, x86-64 |
| `casper-windows-arm64.exe` | Windows, ARM64 |

The directory also contains both installers (copies of `scripts/`, so one upload
makes `<base>/install.sh` reachable), `SHA256SUMS` (in `sha256sum -c` format),
`VERSION`, `LICENSE` and `THIRD_PARTY_NOTICES.txt`. `SHA256SUMS` lists the executables
and both installers: an installer cannot verify itself, but `casper update` checks the one
it runs against the list. Once there is a release key, the publish job adds
`SHA256SUMS.sig` (see [The release key](#the-release-key)). Each executable embeds the
notices, available through `casper --licenses`, so copying the executable alone
retains its notices. Third-party components keep their own licenses.

The compiled binary embeds Bun and every dependency, so the installed `casper` needs
neither the checkout nor Bun on the target machine. The build fails if
`package.json`'s version and `src/version.ts` (what `casper --version` prints) drift
apart — a compiled binary cannot read `package.json`, so the version lives in code.

## Standalone resource handling

- `src/standalone.ts` explicitly starts the CLI. Relying on the source CLI's
  `import.meta.main` guard produced silent exits in compiled Windows builds.
- The compiler embeds Photon's WASM using Bun's file loader. An in-memory build
  plugin replaces only the pinned package's absolute-path loader, without modifying
  installed dependency files. A changed upstream loader causes the build to fail
  for review rather than silently producing an incomplete executable.
- The native image regression compiles Pi's actual read tool, denies external WASM
  reads and processes/resizes a generated PNG outside the checkout.
- The C artifact bridge is embedded too. TinyCC cannot open Bun's virtual
  filesystem directly, so on supported POSIX hosts the fixed source is briefly
  materialized in a private temporary directory for compilation, then removed. No
  system headers or compiler are needed.
- Pi's release scripts supplied the resource-packaging reference; OMP's build and
  installer scripts supplied cross-platform implementation examples. Like those
  builds, x64 targets use baseline CPU compatibility. Executables do not autoload
  a project's Bun configuration or preload scripts.

## Installer contract

`scripts/install.sh` (macOS, Linux) and `scripts/install.ps1` (Windows) share it:

- **No administrator access.** Installation goes to `~/.local/bin` on macOS/Linux, or
  `%LOCALAPPDATA%\Programs\casper` on Windows; `CASPER_INSTALL_DIR` overrides it.
  `install.sh` aborts before staging anything when that directory cannot be created
  or written.
- **Verify or refuse.** Downloads must match `SHA256SUMS` (or an explicit
  `--sha256`/`CASPER_SHA256` override for out-of-band verification); a missing or
  mismatched digest aborts and nothing is installed.
- **Checks the release signature.** Once a [release key](#the-release-key) is pinned,
  `SHA256SUMS` must carry its signature, `SHA256SUMS.sig`, checked with `ssh-keygen -Y
  verify` (OpenSSH 8.1 or newer: macOS, most Linux, Windows 10 and 11). A bad signature
  is always refused: `The release signature doesn't match the Casper release key. Nothing
  installed.`, and the old `casper` stays as it was. A missing one is refused from the
  release's own address and said from another `CASPER_BASE_URL` (a local build or a
  mirror: `No signature (SHA256SUMS.sig) at …; checking SHA-256 only.`). With no
  `ssh-keygen`, or one too old, the installer says so and the SHA-256 still decides. Too
  old is asked of `ssh-keygen` alone, before the check, never read from the check's own
  output (which can echo text from the signature file); once it can check, any failure is
  a refusal. An out-of-band `--sha256` skips the list and so its signature. `install.ps1`
  also finds Windows' own `ssh-keygen` from a 32-bit PowerShell, and Windows CI runs every
  case with throwaway keys (`scripts/test-install-signature-windows.ps1`).
- **Checks where it was built, with gh.** When `gh` is installed and signed in, the
  binary's GitHub build provenance must match (`gh attestation verify --repo
  Choaterboater/casper`): `Verified: built by GitHub Actions from Choaterboater/casper.`,
  or `This download doesn't match a Casper build from GitHub. Nothing installed.` A `gh` older
  than 2.49 has no `attestation` command; the installers and `casper update` then go on with the
  SHA-256 (and signature) checks, and the installers say `This gh is too old to check where it was
  built (gh 2.49 or newer can).` A `gh` that has the command but whose check fails is still a
  refusal; Windows CI runs both cases for `install.ps1` with a stand-in `gh`
  (`scripts/test-install-signature-windows.ps1`). The shell installer's
  `CASPER_BASE_URL` accepts an `http(s)` URL, a `file://` URL or a local directory for
  offline/internal installs. PowerShell downloads through `Invoke-WebRequest`; use an
  HTTP(S) base URL there.
- **Requires a successful version probe before replacement.** The download is staged
  inside the install directory and run there for `--version`. It must exit 0 and print
  `casper <version> (<path>)`; only the version token is compared, so an optional
  `--version`/`CASPER_VERSION` pin must match it exactly while the path suffix is
  ignored. Matching output with a nonzero exit is still a failure. The success line
  `Installed casper <version> to <target>` comes from that staged probe; neither
  installer executes the final path again.
- **Preserves an existing installation on any rejection.** A rejected checksum,
  failed executable or mismatched version leaves the previous binary byte-identical
  and removes staging on every exit path, including a signal. The final step is a
  single rename within the install directory, so an interrupted update cannot leave
  a half-written `casper`; once renamed, the new binary is installed and is not
  rolled back automatically. On Windows, antivirus or a `casper.exe` that just closed can
  hold the file for a moment, so `install.ps1` tries the rename, and removing a staged
  download it did not install, again for about 5 seconds before it gives up.
- **Idempotent, per version.** Re-running a versioned installer reinstalls that
  preview, not an automatically selected newer release. Use a newer release's URL
  to upgrade.
- **Protects a development link.** On POSIX, an existing `casper` symlink that leaves
  the install directory (the checkout install described in the README) is reported
  and left alone unless `--force` is given; a link resolving into a `.scratch/`
  checkout is never replaced, even with `--force`. On Windows an existing
  `casper.exe` reparse point pointing outside the install directory is reported and
  never replaced.
- **Flag parity is deliberately asymmetric.** `install.sh` accepts `--dir`,
  `--version`, `--sha256`, `--force`, `--print-target` and `--help` (and reads the
  same `CASPER_*` variables, plus `CASPER_OS`/`CASPER_ARCH` to override detection);
  `install.ps1` takes no flags and reads `CASPER_BASE_URL`, `CASPER_INSTALL_DIR`, `CASPER_VERSION`,
  `CASPER_SHA256` and `CASPER_ARCH` (`x64` or `arm64`) from the environment.
- **Does not edit shell dotfiles.** macOS/Linux print the exact `export PATH=…` line
  when the install directory is not on `PATH`. Windows requires PowerShell 5.1 or
  newer, enables TLS 1.2, suppresses slow per-chunk download progress, and updates
  both the user PATH and the current PowerShell process PATH. Running through a child
  `powershell -c` still requires reopening the parent terminal. Close a running
  Casper before replacing its exe.
- **`casper update` reuses it.** A release binary asks GitHub for the newest release
  (previews included), downloads that release's installer, checks it against GitHub's
  published digest for the file (with neither that nor a list naming it, it is not run) and its pinned download address, and runs it on the
  folder of the running program with the new version pinned. Once there is a release
  key, Casper first checks `SHA256SUMS.sig` itself (no `ssh-keygen` needed) and that the
  signed list names the installer with a matching digest; when `gh` is signed in, it
  also checks the installer's build provenance. It then hands the installer the running
  program's own file (`CASPER_OS`/`CASPER_ARCH`) and its SHA-256 from the list it checked
  (`CASPER_SHA256`), so the installer fetches no list of its own; a signed list that does
  not name that file installs nothing. Any failure says why in one line and
  runs nothing. On Windows the
  running `casper.exe` cannot be replaced, so after the same checks Casper saves the checked
  installer to a private temporary folder and starts a separate, hidden, detached PowerShell
  (arguments only, no command text built from the release) that waits up to five minutes for
  Casper's process id to exit, checks the file still has the checked SHA-256, runs it on the
  install folder with the version pinned, and removes the folder. Casper prints one line and
  exits 0; if the detached start fails it prints the `irm ... | iex` line and exits 1. The
  hand-off is covered by tests with a fake spawner; it is unverified on a real Windows machine.
  A token in `GITHUB_TOKEN` or `GH_TOKEN` is sent with the release lookup only (not the
  downloads), for GitHub's higher limit.
- **Clears the macOS quarantine flag** on the staged binary before it is run (best
  effort), so the first run is not blocked by Gatekeeper.
- Windows has an x64 and an ARM64 artifact. `install.sh` picks the artifact by `uname`;
  `install.ps1` by the PC's own `PROCESSOR_ARCHITECTURE` (read from the registry, so an
  x64 PowerShell running under emulation on an ARM64 PC still gets the ARM64 file).
  Artifacts are per-platform builds, not universal binaries.

## Local verification (no release host required)

```bash
bun run build:release
(cd dist/release && python3 -m http.server 8731 --bind 127.0.0.1) &
CASPER_BASE_URL=http://127.0.0.1:8731 sh scripts/install.sh --dir /tmp/casper-install
/tmp/casper-install/casper --version
```

A host-only build holds only your own platform's file, which is what `install.sh`
picks on the same machine. A local build has no `SHA256SUMS.sig`; from a
`CASPER_BASE_URL` that is not the release's own address the installer says so and goes on. Stop the local server (`kill %1`) when you are done.

The published shape itself is checkable the same way: serve `dist/release` and pipe the
*served* installer into a shell, which is the documented one-liner minus the real host.

```bash
env -i PATH=/usr/bin:/bin HOME=/tmp/casper-home TMPDIR=/tmp \
  CASPER_BASE_URL=http://127.0.0.1:8731 sh -c 'curl -fsSL "$CASPER_BASE_URL/install.sh" | sh'
```

`tests/release-install.test.ts` covers the installer without a compiler: artifact-name
agreement with the release build, successful install of a verified artifact, checksum
mismatch failing closed, missing digest failing closed, out-of-band digest plus version
pinning (including that a rejected pin installs nothing and leaves no staged file),
development-symlink protection, and unsupported-platform reporting. A failing executable
that prints the expected version is rejected while preserving an existing installation.
The suite also compiles the real CLI, runs it outside the checkout with no Bun on PATH,
and asserts Mermaid and MindMesh artifact files are created. This catches missing runtime
assets that `--version` and `--help` cannot exercise.

## Pi upgrade revalidation

Casper pins `@earendil-works/pi-coding-agent` exactly, and the engine packages it imports
directly (`pi-ai`, `pi-agent-core`, `pi-tui`) at the same version;
`tests/package-dependencies.test.ts` fails when an imported one is undeclared or drifts. The interactive model browser
(`src/runtime/pi-model-browser.ts`) is Casper-owned, but the adapter
(`src/runtime/pi-model-picker.ts`) still couples to Pi: the `ModelRuntime` snapshot and
`ModelsRefreshResult` shapes, the `app.models.save` keybinding id, `AgentSession["model"]`
and pi-tui rendering primitives. A Pi bump can degrade these silently. After changing the
pin, run:

```bash
bun run typecheck && bun test tests/pi-picker-coupling.test.ts tests/ask.test.ts tests/daily-terminal.test.ts && bun run check
```

and confirm, in a real interactive session against a configured provider:

1. `/model` opens the full-screen browser on the provider sidebar (Up/Down switch
   providers; Enter, Tab or Right moves to the list); the footer shows the selected-model
   summary, then the hint for the side that has the keys (`Up/Down providers · …` on the
   left, `Tab providers · Enter remember · Ctrl+S this session only · …` on the list).
   Startup clears the viewport once (a fresh session fills the screen).
2. Filtering to one model and pressing Enter selects it; Esc cancels; Ctrl+S selects for
   the session only.
3. `/effort` opens the effort picker (plain `SelectList`; no Pi internals beyond
   `Container`/`Text`/`matchesKey`).
4. The transcript, editor gutter and the browser/debug/MCP approval prompts still render
   (surface compositing over Pi's `TuiMainScreen`).

`tests/pi-picker-coupling.test.ts` fails on keybinding (`app.models.save`),
refresh-result or browser render-contract changes; if it fails, update the adapter and
the test together, and re-verify steps 1–4 by hand before publishing.

## Validation

For v0.1.0, the macOS serial test run passed **543 tests / 0 failures / 3,556
assertions**, with TypeScript clean. ARM64 and Intel-through-Rosetta installs,
version/help, diagram files and keeping the old version on a rejected install were
checked against a locally served release folder, without Bun on the installed
program's PATH. At that time nothing had run a Linux file on Linux.

Today, the [Publish release](../.github/workflows/publish-release.yml) workflow runs
`casper-linux-x64 --version` on Ubuntu 24.04 before it uploads anything. That shows
the Linux x64 file starts; it is not a full Linux test. `casper-linux-arm64` is built
but not run anywhere.

The [Windows ARM64 workflow](../.github/workflows/windows-arm64.yml) runs on GitHub's
Windows 11 ARM64 runner: it builds `casper-windows-arm64.exe`, starts it (`--version`,
`--help`, `/project`, an inline diagram) and runs `scripts/test-install-windows.ps1`
under Windows PowerShell 5.1, PowerShell 7, and an x64 PowerShell 7 under emulation.
The full test suite does not run there.

The [Windows CI workflow](../.github/workflows/windows-preview.yml) installs locked
dependencies on a Windows runner, typechecks, tests standalone startup and native
image reads, builds the Windows executable, and tests served installation under
**Windows PowerShell 5.1 and PowerShell 7**. It checks PATH updates, version/help,
embedded licenses, project inspection, inline diagrams, and rejection of bad
checksums/version pins without replacing an existing installation, and the release
signature check with throwaway keys.

The [published-release workflow](../.github/workflows/verify-release.yml) ("Verify
published Windows installer") installs on Windows from the real public GitHub URL,
with no checkout or Bun on PATH, under both PowerShell versions, and checks
`--version`, `--help`, `--licenses`, `/project` and an inline diagram. You start it by
hand with the tag. These are install and startup checks, not a full Windows desktop
test. Linux files are built on another machine type (cross-compiled) and still need a
test on a real Linux machine. There is no automatic check of the published
`install.sh` one-liner; do that by hand (step 5 below).

## Publish

**From GitHub Actions (the usual way):** run the
[Publish release](../.github/workflows/publish-release.yml) workflow on `main` with the
tag, for example `v0.2.15`. It:

- checks that the tag looks like `vX.Y.Z`, matches `package.json`, and does not exist yet;
- installs the locked dependencies and runs `bun run typecheck` (it does **not** run the
  test suite, so run `bun run check` yourself first);
- builds all six targets and checks `SHA256SUMS` and that it lists every one;
- runs `casper-linux-x64 --version` and checks it prints the tag's version;
- refuses files that contain personal build paths;
- publishes a prerelease titled `Casper <tag> — preview` with every file in
  `dist/release`.

From v0.2.16 (not used for a release yet) the workflow has two jobs. The **build** job can
only read: it does the checks and the build above, and it also stops unless the Linux, macOS
and Windows preview workflows and the Windows ARM64 workflow passed on this exact commit (run
them first), and stops while
the tag's section below still says "Not released yet". The **publish** job is the only one
that can write; it runs no project code, signs GitHub build provenance over every file in
`SHA256SUMS`, signs `SHA256SUMS` with the release key (below), checks the files again and
publishes the prerelease. Every action in every
workflow is pinned to a full commit (`tests/release-workflows.test.ts` fails otherwise).

The release notes come from this file: everything under the heading that starts with
`## <tag>` (for example `## v0.2.15: ...`) down to the next `## v` heading, plus install
commands for that tag. If there is no such heading, the workflow stops. Then do step 5
below.

**By hand:**

1. Run the gates above and review source/notice changes. Build from a neutral path;
   scan final binaries for personal build paths before uploading them.
2. Keep `package.json`, `src/version.ts`, both installer defaults and documented
   release URLs aligned. The build rejects application-version drift. Edit
   `scripts/`, never the copies in `dist/release/`; any installer change needs a
   rebuild and re-upload before the served one-liner contains it.
3. Commit/push the approved source. Create a draft GitHub prerelease for the exact
   intended tag/commit and upload every file in `dist/release/`: the artifacts,
   `SHA256SUMS`, `VERSION` and both installers go to the same place, so
   `<base>/install.sh` and `<base>/install.ps1` resolve next to the binaries they
   download.
4. Verify uploaded assets/checksums, then publish the prerelease. Draft assets cannot
   serve the anonymous one-liner. Do not put executable binaries in Git history.
5. Run the published-release workflow and verify the anonymous installer URLs; on a
   clean machine, `casper --version` and `casper /visualize repo` inside a small
   source project. On Windows, verify the PowerShell installer and inline
   visualization separately on that host.

## The release key

`SHA256SUMS.sig` is an SSH signature over `SHA256SUMS`, made in the publish job with the
release key. Its public half is pinned in three places (`src/update/release-key.ts`,
`scripts/install.sh`, `scripts/install.ps1`); the private half is only in the
`RELEASE_SIGNING_KEY` Actions secret. So someone who can replace release files, but does
not have that secret, cannot make a list that `casper update` or the installers accept.

Why SSH signatures: `ssh-keygen` already ships with macOS, most Linux and Windows 10 and
11, so users install nothing; minisign or GPG would need an extra tool. Casper checks the
signature in its own code. It is free.

Until the key exists, the pinned key is empty and nothing is signed or checked; the publish
job warns. **One-time setup (owner):**

```sh
ssh-keygen -t ed25519 -C casper-release -N '' -f ~/casper-release-key
gh secret set RELEASE_SIGNING_KEY --repo Choaterboater/casper < ~/casper-release-key
bun scripts/release-key.ts ~/casper-release-key.pub   # pins it in all three places
bun run check                                           # then commit and merge
```

Then keep `~/casper-release-key` somewhere safe and offline (a password manager), and
delete it from the laptop. The next release is signed; the publish job checks the signature
against the pinned key and stops if the secret and the pinned key are not a pair, or if
only one of them is set.

**Changing or losing the key.** Each Casper trusts the key it was built with. To change
keys, pin the new one with `bun scripts/release-key.ts` and update the secret in the same
release: Casper builds before it still expect the old key, so their `casper update` refuses
that release (`The release signature on Casper … doesn't match the Casper release key`), and
those users run the install line from the README once. A lost key is the same. A leaked key
is worse: change it at once and say so in the release notes.

**What it does not cover.** The very first `curl … | sh` trusts the installer it downloads
(as every curl-to-shell install does); the signature protects every `casper update` after
that, and anyone who downloads by hand can check it with the key from
`src/update/release-key.ts` in the repository (not from the download itself):

```sh
printf 'casper-release %s\n' 'ssh-ed25519 AAAA…' > allowed_signers
ssh-keygen -Y verify -f allowed_signers -I casper-release -n casper-release \
  -s SHA256SUMS.sig < SHA256SUMS && sha256sum -c --ignore-missing SHA256SUMS
```

## Known preview limits

- Some screen issues remain.
- Binaries are not code-signed or notarized. SmartScreen (Windows) or Gatekeeper
  (macOS) may warn. `install.sh` clears the macOS quarantine flag. The release key signs
  the list of files, not the programs, so it does not stop these warnings; see
  [Paid code signing](#paid-code-signing-owner-decision).
- Windows x64 is tested in CI: install and startup under PowerShell 5.1 and 7, and the
  full test suite and eval tests. The run fails if the suite fails, and the owner merges
  only after it is green. Tests that need a PTY, POSIX signals or file modes, or a tool
  that is not installed, skip there. The interactive screen has not been tried on a real
  Windows desktop.
- Linux: the full test suite runs in CI on an Ubuntu build machine, and the published
  `casper-linux-x64` is started once (`--version`) before upload. Nothing has been run on a
  real Linux machine, and `casper-linux-arm64` is not run anywhere. See
  [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md).
- Windows ARM64 (from v0.2.23): `casper-windows-arm64.exe` is built, started
  and installed in CI on a GitHub ARM64 runner. The full test suite and the interactive
  screen have not run on ARM64, and no one has tried it on a real ARM64 PC.
- Published v0.1.0 appends login selection messages instead of moving the highlight,
  and lacks every change listed above. Those corrections ship in v0.2.13.
- Windows diagram output is inline; screenshot/diagram artifact files require the
  POSIX bridge. Optional browser/debugger/LSP/MCP behavior is not fully host-tested.
- There is no npm/Homebrew distribution channel. `casper update` installs a newer preview
  when you run it; nothing updates on its own, and there is no rollback to an older one.
- Installation does not install project language tools, browser/debugger adapters or
  Git Bash. Pi's model-facing Bash tool needs an available Bash on Windows; Casper's
  own verification commands use the Windows shell.

### Paid code signing (owner decision)

Not done; both cost money every year and the release key above is free. What each would
change for users:

| Option | Cost | What changes for users | What it takes |
| --- | --- | --- | --- |
| Apple Developer ID + notarization | about $99 a year (Apple Developer Program) | A downloaded `casper` opens with no Gatekeeper warning, also when someone downloads it by hand in a browser. Today `install.sh` already clears the quarantine flag, so users of the install line or `casper update` see no warning either way. | Sign both macOS files with `codesign` (hardened runtime; Bun needs JIT entitlements), send them to `notarytool` from a macOS job, keep the certificate and an app password as secrets. A bare program can't be stapled, so the first run checks with Apple online. |
| Windows code-signing certificate | about $200–400 a year (OV) or a cloud service such as Azure Trusted Signing (about $10 a month) | SmartScreen shows a named publisher instead of "Unknown publisher"; a new certificate still warns until it builds reputation. `install.ps1` downloads with PowerShell, which adds no Mark of the Web, so install-line users rarely see SmartScreen today. | Sign both `.exe` files with `signtool` in the build; the key lives in a hardware token or the cloud service, not a plain secret. |

Neither changes what the installers check. Recommendation: wait until people download the
programs by hand often, or a company asks for signed programs; Apple first, as it is
cheaper and the macOS warning is harder to get past.
