# Configuration and skills

**What this is:** the files and settings that change how Casper behaves: config files, profiles,
environment variables, sign-in storage, model roles and skills.
**When you'd use it:** you want to set your check commands, keep separate setups (profiles), pick
a model per job, run Casper from a different state folder, or add your own skills. Every file here
is optional; Casper works with none of them.

## Settings

You don't need to edit a file to change Casper's switches. `/settings` shows seven areas, with
aligned labels and values, one row per setting and help for the highlighted row. It saves into
`~/.casper/config.yaml` for you, keeping your comments and other settings:

```text
────────────────────────────────────────────────────────────────────────────────
Settings · saved for you
[+ Tools]  ◇ Pages   > Checks   $ Models   ◐ Display   ↔ MCP   * Privacy
Tools & browser
❯ Web lookups                           on (DuckDuckGo)
  Browser tool                          on
  Browser clicks                        on
  Starter templates                     on
  Built-in skills                       on
  GitHub tool                           on
  Packs                                 on
  Untrusted-text reader                 on

Web lookups are on (DuckDuckGo).
↑/↓ move · Enter/Space change · ←/→/Tab area · type to search · Esc close
────────────────────────────────────────────────────────────────────────────────
```

The areas are **Tools & browser**, **Pages, pictures & diagrams**, **Commands & checks**,
**Models & cost**, **Display**, **MCP & network** and **Privacy & sign-ins**.
Up/Down moves; Enter or Space flips an on/off at once. Other values open the same small numbered
choice with `1 Keep …` first, then return to the same row. Esc there returns without changing it.
Left/Right or Tab switches areas (Shift+Tab goes back). Typing filters settings across all areas;
Space in a search adds a space; Enter changes the match. Backspace clears the search, and Esc closes the screen. No repeated summary or long numbered list.
Below 80 columns, areas show as a list first: Up/Down picks an area, Enter opens its settings.
Colours follow **Theme**, including light and dark backgrounds; `NO_COLOR` keeps the screen plain.

A plain terminal (`TERM=dumb`) keeps a numbered list grouped by area, with each area beside its
values. `1 Done` closes; a setting asks again with `1 Keep …` first. Past nine rows, type the number
and press Enter. `/settings <name>` opens one setting directly (`/settings Work shown`);
`/theme` still opens Theme on its own.
A change applies from now on (built-in skills, packs, the prompt cache, local models, My MCP servers and My language servers from the next start) and says so:
`[settings] Web lookups: off. Saved in ~/.casper/config.yaml.` Changed while a task runs, it also says when the
task gets it: from its next step, or, for a tool the task already has (web lookups, the reader, the browser,
builders, the spend limits), `The running task keeps what it had; your next request uses it.` A switch turned off is written as
`false` (`packs: false`). In a config you write yourself, `off` works the same for every switch
except `suggestions`, `skills.bundled`, `verification.e2e` and `verification.compose`, which take only `true` or `false`,
and `spend.noteAt`, which takes a dollar amount or `false`. Where Casper can't ask (a one-shot
run), `/settings` lists them. `/details <level>` saves the work shown the same way, like `/effort`.

### Web lookups

The AI can search the web and read public pages, with no question: `web_search` uses DuckDuckGo
by default, and `web_fetch` reads one page. Both reach only public `https` pages, on any port
(`http` is upgraded), checked again on every redirect; a search or address holding a secret is
refused and never sent, and secrets on a page are hidden before the AI sees it. Turn them off with
`/settings` (it writes `web: false`, or `web.enabled: false` when your `web:` sets a provider).
Brave Search (`web: { provider: brave }`, with your key saved as `brave` in
`~/.casper/agent/auth.json`) and your own SearXNG (`web: { provider: searxng, searxngUrl: <address> }`)
are the other choices. A project file can't change `web:`.

### Side questions

A line you start with `?` (`? what does ECONNRESET mean`) is a side question: one separate call to
your `fast` model (the session's model when none is set or signed in), with no tools, idle or during
a task. The answer shows as a side answer; it is never added to the conversation, so the AI that
works on your task never sees it. Each one uses a few tokens, shown in `/usage`. They are on; turn
them off with `/settings` (it writes `sideQuestions: false`), and a `?` line goes to the AI as an
ordinary request; `/btw <question>` still asks on the side, since it is typed on purpose. A project file can't change `sideQuestions:`. See
[TERMINAL_UX.md](TERMINAL_UX.md#words-you-can-use) for the words a request can start with.

### Untrusted-text reader

`casper_read_untrusted` lets the AI read a log, an email or a web form through a separate model call
with no tools; the AI gets back only JSON in the shape it asked for, never the text. It is on, and
costs nothing until the AI calls it (then one small request on your `fast` model, or the session's
model when none is set). Turn it off with `/settings` (it writes `reader: false`, or
`reader.enabled: false` when your `reader:` lists paths). `reader: { untrusted: ["logs/**"] }` names
paths the AI should read only this way; a project file (or a profile it picks) may add paths there
but can't turn the reader on or off. See [READER.md](READER.md).

### Helpers that build

For a big job with separate parts the AI may start builders: each works in its own copy of the
project and its change lands in your folder when it ends (see [CREWS.md](CREWS.md)). They are off by default;
turn them on with `/settings` → Helpers that build (`delegate: { build: true }` in your user settings),
or a user-selected user profile. Like spend limits, only user settings or a user profile may enable them.
A project file may only turn builders off: `delegate: { build: true }` there does not enable them.
Read-only explorers and reviewers stay on; `/crew` is unchanged.

### Browser tool

The AI's own browser opens pages and reads them when a task needs it (see [BROWSER.md](BROWSER.md)).
It is on. Turn it off with `/settings` (it writes `browser: false`): the AI is never offered the
`browser` tool. The page checks after a change still run, since they are Casper's own check, not
the AI's browser; `/browser`, typed by you, still works. A project file (or a profile it picks)
can't turn it on or off.

Its clicks, typing and key presses run without asking, on any page, so it can test what it
built, and so does starting the project's dev server (**Browser clicks**). Turn that off with `/settings` (it writes `browser_clicks: false`) and a
Send or Delete button, an action that isn't a local test, or one on a page elsewhere asks first.
Password, payment and file fields are never filled either way.

### Routine commands

With the sandbox off (the default where you type to Casper), routine shell commands run without
asking, as Claude Code's auto mode does: git's everyday commands and a push to a remote the project
already has, `gh pr create` and the like, installs from the project's own files (`npm ci`, `bun install`,
`pip install -r requirements.txt`), the project's builds, tests, linters and formatters, and making,
copying, moving or removing files in the project. `sudo`, `curl … | sh`, a force push, deleting
outside the project, a new package (`npm install left-pad`) and copying or committing a private file
(`cp .env x`) still ask. It is on. Turn it off with
`/settings` (it writes `routine_commands: false`) and every command that is not a plain read asks.
A project file can't set it. See [SECURITY.md](SECURITY.md) for the full list.

### Slow commands

A shell command the AI runs without its own time limit gets 2 minutes. If it is still running then,
it moves to the background instead of being stopped: the AI gets its output so far and an id
(`cmd-1`), the command keeps running under the same sandbox it started in, `/tasks` lists it, and when it
ends the AI gets a short note with its exit code and last lines of output. Its input is closed, so a
command waiting for you to type ends instead. At most 4 run this way at once; past that a slow command
is stopped at 2 minutes as before. A command the AI gave its own time limit is stopped at it, and servers
still go through the service tool. Every one is stopped, with whatever it started, when Casper exits.
It is on. Turn it off with `/settings` (it writes `slow_commands: false`) and a slow command is
stopped at 2 minutes. A project file can't set it.

### Stalled commands

A shell command the AI runs without its own time limit that prints nothing new for 45 seconds while
it and everything it started use no CPU (under 1%) and move no bytes (on Linux no reads, writes or TCP
traffic, read with `ss`, and a network socket it can't count keeps it going; on macOS no network traffic;
so a quiet `git clone` still downloading keeps going), is waiting
on nothing: a download that hung, or a test run that printed its results but kept a server, timer or
connection open. Casper ends it with what it started, in the foreground or after it moved to the
background, and the AI reads why: `stalled: no output and no CPU for 45 s after: <its last line>`.
When that last output looks like a finished test summary it adds that the tests finished but something
is still open, to close in the test teardown; for `playwright install` it adds that Casper already has
a browser, so the AI uses the browser tool instead. On Windows, where Casper does not read the CPU,
nothing is ended this way, since silence alone would end a quiet build. A command the AI gave its own time limit, a command on Casper's ssh
login, and servers started with the service tool are never ended this way; a command that waits on
another machine on purpose gets a time limit to keep running. It is on. Turn it off with `/settings`
(it writes `stalled_commands: false`) and such a command runs to its limit. A project file can't set it.

### Starter templates

In an empty folder, a first request that fits a template (a NOC dashboard, an MCP server) is built
from it, with one `[new]` line and no question (see [NEW.md](NEW.md)). It is on. Turn it off with
`/settings` (it writes `templates: false`): the request goes straight to the AI. Say "from scratch" in a
request to skip it once. A project file (or a profile it picks) can't turn it on or off.

### Packs

Skill packs you add with `/pack add` (see [PACKS.md](PACKS.md)) are on. Their skills cost no tokens
until a request fits one. Turn them off with `/settings` (it writes `packs: false`): the packs you added
stay in `~/.casper/packs` but no skill of theirs is used, and `/pack add` adds none. It applies from
the next start. A project file (or a profile it picks) can't turn packs on or off or name a pack:
`packs:` in `.casper/project.yaml` stops configuration loading with an error.

```yaml
# ~/.casper/config.yaml or a profile's config.yaml
packs: off # default on
```

### GitHub tool

The AI checks this repo's pull requests and CI through GitHub's `gh` tool when a request names them
(see [GITHUB.md](GITHUB.md)). It is on, and asks nothing: it only acts on the folder's own `origin`. Turn it off with `/settings` (it
writes `github: false`): the AI is never offered the `github` tool. A project file (or a profile it
picks) can't turn it on or off: `github:` in `.casper/project.yaml` stops configuration loading with
an error.

### Diagram tool

The AI draws a diagram when a task asks for a map, chart or flow (see
[VISUALIZATION.md](VISUALIZATION.md)). It is on. Turn it off with `/settings` (it writes
`visualize: false`, or `visualize.enabled: false` when your `visualize:` lists providers): the AI is
never offered the `visualize` tool. `/visualize`, typed by you, still works. A project file may pick
`visualize.providers` but can't turn the tool on or off.

### Pictures the AI makes

When a request asks for pictures or to build a web page, the AI may make photos and illustrations
with the `make_picture` tool and save them in the project (`assets/` unless it names a path). It
uses what you already have, in this order, with no question: your ChatGPT plan through the Codex CLI
you installed and signed in to (`codex login status` says ChatGPT; included in the plan), then the
free OpenRouter model `inclusionai/ming-image-0.1-design` with your OpenRouter sign-in. With
neither, or when both fail or hit their limits, no picture is made and the AI draws SVG. Nothing
paid runs on its own: a paid model runs only when your request names one ("make the images with FLUX
3") or you list models in `pictures.models`, which are tried after Codex in place of the free one.
Casper checks this itself: when the AI names a model that your request does not name (its id or
its distinctive name, such as "flux") and your list does not hold, it is ignored, the usual order
runs, and the AI is told why. A
`gpt-image-*` model uses your OpenAI key when you have one. The receipt counts what a picture cost.
Codex runs read-only and only makes the picture; Casper copies the one its image tool saved under
`$CODEX_HOME/generated_images` (default `~/.codex`) and leaves Codex's copy there. A picture wider
or taller than 1600 px or over 400 KB is shrunk for the web with macOS's `sips` or ImageMagick, as
a `.jpg` unless you ask for `.png` or transparency; with neither it is kept and the AI is told.
The tool returns the path at once and makes the picture in the background, up to 3 at once, so
the AI keeps working on other files. A read, edit or write of that file and every other tool but
grep, LSP and web search (a shell command or build, a listing, the browser, `casper_check`, a
helper) wait for it first, and so do the checks after the task and after each repair round. When a
picture fails, the call that waited is told why (`picture assets/hero.jpg failed: ...`); when
nothing waited, the AI is told once with its next tool result, and you see a `[picture]` line.
The tool is offered only when Codex is signed in with ChatGPT (checked once a session) or you are
signed in to OpenRouter. Turn it off with `/settings` (it writes `pictures: false`). A project file
can't turn it on or off or list models.

```yaml
# ~/.casper/config.yaml or a profile's config.yaml
pictures:
  models: [black-forest-labs/flux-3-image] # may cost money; default: none
```

### Suggestions

The numbered next steps under a task's receipt, and the line before a big job that says `/plan` first
next time, cost no tokens. They are on. Turn them all off with
`/settings` (it writes `suggestions: false`); `/suggestions off <name>` turns off just one. A project
file can't change `suggestions:`.

### Prompt cache

`/settings` picks `cache:` with the current value as 1, then the others: `auto` (the long cache
where it costs no more, the short one elsewhere), `long` (about an hour, or a day where offered;
writing it can cost more), `short` (a few minutes) and `off` (no cache, so every request costs
more). It applies from the next start. See [Prompt cache](#prompt-cache-1).

### Lean guidance

Automatic by default (`lean_guidance: auto`). Model servers Casper finds or you add, loopback model
addresses, and any model with a known context window of **32,768 tokens or less** get shorter system
text and tool descriptions. Big hosted models keep the full text unchanged. The same essential rules,
all tools and abilities stay; Pi's own tools and edit rules, your instructions and project rules are
not shortened. It costs fewer prompt tokens, with no extra model turn or question.

`/settings` **Lean guidance** chooses `auto` or `off` (saved as `lean_guidance: off`). Off gives every
model the full wording. A change applies from the next model step, as does switching models; saved
history is unchanged. Only your own config or a profile you chose can set it, never a project file
or a project-selected profile. See [Local models](#local-models).

### Hide old tool output

On by default. Old reads and successful command output of at least 8,000 characters, and old tool
screenshots, become short permanent stubs **only in requests to the AI**. This waits until hiding pays:
the hideable output fills a fifth of the model's context window (and eight rounds have passed since the
last time), or the prompt passes 60% of the window, and it is more than the cache has to re-read after the
first stub. So a short task never pays a cache rebuild, and one rebuild takes several old reads at once.
The last four rounds, errors, unfinished or stopped commands and recently referenced output stay visible.
Browser check text stays; only its old pictures can be hidden. User pictures, writes, MCP responses
and verification results are not hidden. References are conservatively detected from the latest
user request and recent model text, thinking and tool arguments (paths, call IDs, quoted lines,
source symbols and vague mentions of earlier output); semantic references can still be missed.

Each time changes the cached prefix once from its first replaced result. In between, every request
repeats the earlier messages, the system prompt and the tools byte for byte; existing stubs are never
rewritten or restored. If the model needs hidden content later, it reads it again (commands should only
be re-run if safe). The full original output stays in saved history, exports, `/output` and receipts.
Mask decisions are branch-local and survive resume, forks and restarts; rewind before a checkpoint leaves
the original visible. Compaction starts a new checkpoint epoch.

Turn it off with `/settings` **Hide old tool output** (it writes `hide_tool_output: false`).
The next model step stops creating new stubs, but keeps existing ones so turning it off does not
invalidate the prefix again. A project file cannot set it, including through a project-picked profile.
This is separate from `cache: off`, which controls provider cache retention, not history hiding.
`bun run scripts/measure-tool-history.ts` replays a synthetic session against a local Ollama model, with
hiding off and on, and prints each request's prompt size and time.

### Page checks

After a UI change Casper opens the changed pages in its own headless browser and checks they load
(see [VERIFICATION.md](VERIFICATION.md#page-checks)). They are on. Turn them off for every project
with `/settings` (it writes `pages: false` in your own config). A project file can still turn them off
for itself (`pages: off`), but its list of pages doesn't turn them back on for you, and neither does
a profile it picks. In your own config `pages:` takes only on or off; the list of pages is the
project's.

### Send Casper's name to OpenRouter

On requests to OpenRouter Casper sends only the app name and site, so OpenRouter files the use under
Casper (kept out of its public rankings for now); nothing about your code. It is on. Turn it off with
`/settings` (it writes `telemetry: false`) or `CASPER_TELEMETRY=0`; either one off is off. A project
file can't change `telemetry:`. See [OpenRouter app attribution](#provider-credentials).

### When an OpenRouter host fails

OpenRouter runs a model on several hosts and can keep sending every try to the same one. When it answers
`Upstream error from <host>: ...`, Casper tries again, and that host goes on the model's OpenRouter `ignore`
list for the rest of the session, so the next try goes to another host. Hosts you pinned with `only`
(`modelOverrides` in `~/.casper/agent/models.json`) are respected: the failed one leaves your list, and the
last one left is never dropped.

### My MCP servers and My language servers

Your own MCP servers (`~/.casper/mcp.json`, your profile's, and the ones found in Claude Code and
VS Code files) connect when the session starts, with no `/mcp connect`. One that isn't a network
product starts with writes on, and its changes run without the change box; firmware, delete and
admin changes still ask. A network product's server (Mist, Central, ClearPass, Junos…) keeps writes
off and its yes/no box, and a project's server keeps its review (see
[MCP.md](MCP.md#your-own-servers-start-by-themselves)). Your own language servers
(`~/.casper/lsp.json` and your profile's) start with the session too (see [LSP.md](LSP.md)). Both are
on. Turn them off with `/settings` (**My MCP servers** writes `mcp_autoconnect: false`, **My language
servers** `lsp_autostart: false`): every server then waits for `/mcp connect` or `/lsp connect`, and
an MCP server starts with writes off with every change asking in the box. They apply from the next
start. A project file can't set them.

### Asking less: /permissions

`/permissions` prints a short screen: whether Casper is asking, one line per kind (state · how to change it) and what stays protected, then the numbered box
`Stop asking until you quit?` (`1 Keep asking` first, so Enter changes nothing). `/permissions details` is the full screen: where each permission came from (this
session, remembered for this project, your config) and every way to be asked less. `/permissions all` (also `allowall` or `allow-all`) is the same box on its own (typed during a task it opens none and takes effect at once);
2 stops the shell's own questions until you quit and shows `asking off` in the footer. `/permissions ask` turns asking back on. A mistyped word is suggested, never run. `/permissions write <folder>` allows a folder outside the project for this project ahead of time, `/permissions forget <folder>`
takes it back, and the write box's `4 Yes, always for this project` does the same. Protected places (`~/.ssh`, `~/.casper`, shell start-up files, git's files, your
home folder itself, system folders) are never offered and never allowed. See [SECURITY.md](SECURITY.md#asking-less).

### Private ssh passwords

When an `ssh` or `scp` you allowed (the "Reach this machine?" question) asks for a **password** or a key's
**passphrase**, Casper shows its own box, with its own numbered choices, and hides what you type:

```text
ssh to 192.0.2.10 asks for a password. Type it in Casper's hidden box? The AI never sees it.
  1 No
  2 Yes, this once
  3 Yes, for this session
```

2 forgets the password when the next command starts. 3 (offered for a `user@host's password:` prompt only, not for a
passphrase) keeps it in Casper's memory for that one login (user and machine) until you clear the conversation, change
workspace or quit; it is never written to disk. Esc or 1 gives ssh nothing, and the AI is told you said no and
not to ask for the password in chat. What you type goes to ssh and nowhere else: not into the command, not to the
model, not into the conversation, and Casper hides it from then on in everything the AI reads (even a short one).
Nothing to turn on: it is on, and there is no command for it. It needs OpenSSH 8.4 or later, which current macOS, Linux, WSL
and Windows 10/11 have; an older one may not ask.

Only a plain `ssh` or `scp` that runs on its own gets it: the same commands that already run outside the sandbox
with your keys, typed as the bare word `ssh` or `scp` and found outside every place a sandboxed command may write (not `./ssh`, and
not a script in the project). From a source checkout on Windows there is no box; the installed Casper has it. A command with a pipe, `;`, `&&`, `sudo`, `sshpass`, `-L` or `-o ProxyCommand` does not. Only
password and passphrase questions are answered; "Are you sure you want to continue connecting" (a new host key) and
one-time codes are not, and ssh fails with a line saying so. A command that sets `-o BatchMode=yes` tells ssh never to
ask, and Casper leaves that alone: the AI is told to run it again without it. A run that can't show the box (a
one-shot run, piped input, a helper) refuses with a plain line instead of asking.

When ssh's own words say a login was refused (`Permission denied (publickey,password)`, `Authentication failed`, no
authentication methods left), the AI reads one more line in the command's result, also when the command ended with
`; echo done`. If ssh was not the whole command (a pipe, `;`, `2>&1`, `sudo`), it says: Casper can only ask for a
password when ssh is the whole command, so run a plain `ssh user@host command` with no BatchMode, and never ask for the
password in chat or use plink, sshpass or another window. A BatchMode=yes command gets the same words. A plain
command whose box was offered gets only the "never in chat" part. On Windows `ssh.exe` is the same plain command as `ssh`.

Turn it off with `ssh_login: off` in `~/.casper/config.yaml` (or a profile you chose), or **Private ssh passwords** in
`/settings`; ssh then gets no box and a login that needs a password fails as it always did. A project file can't
change `ssh_login:`. See [SECURITY.md](SECURITY.md) and [SECRETS.md](SECRETS.md).

### ripgrep

Casper's file search and (on Linux) the shell sandbox need `rg`. A `rg` on your PATH is used as it is. The release
program carries the official ripgrep inside itself: with none on your PATH, the first start unpacks it once to
`~/.casper/bin/` after checking its sha256, with nothing downloaded and no line printed. Only a run from a source
checkout, or a program built without it, fetches the official ripgrep once (about 5 MB, a pinned version checked
against its sha256) into `~/.casper/tools/` and says so in one line; if it can't, Casper carries on without. Turn the
download off with `tools:` then `downloads: off` in `~/.casper/config.yaml` (or a profile you chose); `CASPER_OFFLINE=1`
also skips it. Both switches stop only the download, never the copy inside the release program. When Casper ends up without its own ripgrep (downloads off, offline, or the download failed its
check), it also keeps the engine's grep tool from downloading one: Casper sets `PI_OFFLINE=1` for itself,
so nothing unchecked is fetched. This also stops the engine's other automatic downloads in that session
(for example its model-list refresh); Casper says so once at start. The engine has no switch for tool downloads alone. `downloads: off` also stops the daily look for network server releases ([MCP.md](MCP.md)). A project file can't change `tools:`. See [SECURITY.md](SECURITY.md).

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
decisions), `~/.casper/packs/`, `~/.casper/packs.json` and `~/.casper/packs.key` (the packs you added
and what you were shown; see [PACKS.md](PACKS.md)), `~/.casper/agent/` (sign-ins and conversations; see
[Provider credentials](#provider-credentials)) and `~/.casper/projects/` (per-project state).

**Started with sudo.** `sudo casper` keeps your home, so these files, and `~/.claude.json` that
Claude Code rewrites when Casper starts it, would belong to root and the next Casper or Claude
Code run as you could not read them. A Casper running as root in a home that is not root's gives
every root-owned file in `~/.casper`, `~/.claude` and Claude Code's `~/.claude.json` files back to
the home's owner: at start, after each Claude Code run and at exit; it says so with a `[home]`
line. Files of any other user are never changed. Run as you, Casper checks the few files that
matter at start and, when root owns any, names them in a `[home]` line with the one `sudo chown`
command that gives them back.

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
its rules, MCP/LSP server definitions, reference sources and the settings a project file may set
anyway. Your own settings (`sandbox`, `shell`, `web`, `lab`, `spend`, `cache`, `display`, `theme`,
`showPages`, `hide_tool_output`, `reasoning_headline`, `lean_guidance`, `suggestions`, `updates`, `sideQuestions`, `localModels`, `modelServers` (from `~/.casper/config.yaml` only), `telemetry`, `ssh_login`, `other_logins`, `network_updates`, `ai_pages`, `open_pages`, `tools.downloads`, `pages: off`, `browser`, `packs`, `skills.imports`, `skills.bundled`, `repair.bigModelLastTry`, `delegate.build`, `mcp_autoconnect`, `lsp_autostart`, `notifications`)
stay those of the profile you chose yourself (or `~/.casper/config.yaml`), so a repository can't
turn your sandbox off or your web lookups on by picking or naming a profile; the banner says
`[config] .casper/project.yaml picked profile lab: …`. `CASPER_PROFILE=lab` (or `profile: lab` in
`~/.casper/config.yaml`) uses all of a profile. Look at an unfamiliar repository's
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
- `visualize:` picks the diagram providers; see [VISUALIZATION.md](VISUALIZATION.md). Turning the AI's
  diagram tool on or off is yours only (see [Diagram tool](#diagram-tool)).

### Detected check commands

When no `verify:` or `commands:` entry sets a check, Casper looks for one in the repository:

| Project | What Casper runs |
|---|---|
| Node (`package.json`) | The `test`, `lint`, `build` scripts, and `typecheck`, `check-types` or `tsc` for typecheck, run with the package manager (`bun run test`, `npm run test`, …). A `check` script fills the check it runs when no script of that name does: the tests when it (or a script it runs) starts a test runner (`bun test`, `vitest`, `jest`, …), else typecheck (`tsc`, `svelte-check`, …), else lint (`eslint`, `biome`, …); one Casper can't read runs as the test check. The package manager comes from `packageManager` in `package.json`, else the lockfile, else npm. |
| Bun tests (`*.test.ts`, `*_test.js`, `*.spec.tsx`, …) | `bun test` when no script runs the tests, in a Bun project or wherever the test files import `bun:test`. |
| Python (`pyproject.toml` or any `requirements*.txt`) | `pytest`, `ruff check .` and `mypy .` when those names appear in those files; bare `mypy` when `[tool.mypy]` lists `files`. A build (`python -m build`, `uv build`, `poetry build`) when `pyproject.toml` has `[build-system]`. |
| Rust (`Cargo.toml`) | `cargo test`, `cargo clippy`, `cargo build` |
| Go (`go.mod`) | `go test ./...`, `go build ./...` |

Test files are looked for at the top of the project and in `tests`, `test`, `__tests__`, `spec`, `src` and
`lib`, a few folders down. When Casper finds tests but no command runs them, the receipt, `/status` and `/verify`
say `Casper found tests but no command that runs them` instead of "no tests yet".

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
- The model's bash may not run `git reset --hard`, `git checkout --`/`.`/`-f`, `git restore`
  of the working tree, `git switch -f`, `git clean` (other than `-n`) or `git stash drop`/`clear`,
  because each can throw away your uncommitted work. `git stash`, its `pop` and `apply`, and
  `git reset --keep`/`--merge` run without asking. This is a
  check of the command text, not a sandbox. It applies whatever the policy says.

## The shell sandbox

New in v0.2.17. The shell sandbox (see [SECURITY.md](SECURITY.md)) is set only in your own files
(`~/.casper/config.yaml` or a profile). Since v0.2.31 it is **off unless you turn it on** where you type to Casper:
`sandbox: on` (or `sandbox: { enabled: true }`) turns it on for every session, and `/sandbox on` for one. While it is
off, the AI's shell asks before each command that changes something, except routine work (**Routine commands** above),
and a write outside the project asks first.
A one-shot or `--json` run can't ask, so it keeps the sandbox where one can run, as before. Casper's network server
keeps its own sandbox either way.

```yaml
sandbox:
  allowedDomains: [api.mist.com, "*.central.arubanetworks.com"]  # reached without asking
  allowWrite: [~/shared-build-cache]                              # more folders commands may write
  allowUnixSockets: [/var/run/docker.sock]                        # macOS only; Linux can't filter by path
  checks: ask                                                     # ask (default) | outside | inside
shell:
  keepEnv: [OPENAI_API_KEY]   # an AI provider key your own tests need
```

`sandbox.checks` says where your project's own test, typecheck and lint commands run. `ask` (the default) keeps them in the
sandbox and, when one fails because the sandbox blocked something (`EPERM`), asks whether to run the checks outside it
(`/allowed` lists and forgets a saved "always for this project"); `outside` always runs them outside; `inside` never does
and never asks. A project file cannot set it.

Your GitHub login (`~/.config/gh`, `~/.git-credentials` and the like) stays hidden from sandboxed commands, and there is no
setting that opens it. Instead the AI's plain `git push`, `pull`, `fetch`, `clone` or `ls-remote`, or `gh pr`, `issue`,
`run`, `repo view|clone`, `api` (GET) or `auth status`, asks `Run outside the sandbox with your GitHub login?` and, after
your yes, runs as typed outside the sandbox with your own login; the AI reads only its output. 3 and 4 at that box cover
that kind of command (`git push`) for the session or for this project; `/allowed` lists a saved one and
`/allowed forget <n>` takes it back. A command that types its own address, and `gh pr merge`, `close`, `reopen`, `ready`,
`review` or `checkout`, `gh issue close` or `reopen`, and `gh run rerun` or `cancel`, offer only No and Yes, this once,
every time. Nothing to configure; see [SECURITY.md](SECURITY.md) for what counts as plain.

`sandbox: off` turns it off for every run, one-shot runs and the network server's sandbox too, and the AI's shell
then doesn't ask (like `--no-sandbox` for one run, or `/sandbox off` until Casper exits); the receipt then says shell
commands and checks were not sandboxed. A project's `.casper/project.yaml` can only
add denies:

```yaml
sandbox:
  denyRead: [secrets, ~/work/deploy-key]
  denyWrite: [docs/released]
```

`denyRead` places are private to the AI's file tools too (read, grep, find, ls, edit, write) and to its
helpers, like `~/.ssh`. A `denyRead` folder inside the project doesn't stop a search of the whole project; shell
commands can't see into it, but the file tools' own search of the project may still match
inside it. Keep secrets outside the project where you can.

Any other `sandbox` or `shell` key in a project file is named at startup and ignored, and a repo's
`.pi/sandbox.json` is never read.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `CASPER_AGENT_DIR` | Folder for sign-ins, the model catalog, engine resources and conversations. Defaults to `~/.casper/agent`. Relative paths resolve from the folder you start Casper in; `~/` expands to your home folder. A folder you set here never receives the one-time import from Pi. Shell commands can't write it, as with `~/.casper`. |
| `CASPER_OFFLINE` | Set to `1` to stop provider catalog downloads and automatic sign-in browser launches. Cached models remain available. This is **not** a network block: model calls and sign-in still use the network. |
| `CASPER_NO_UPDATE_CHECK` | Set to `1` to disable background Casper update checks, notices and installs, regardless of `updates:`. `CI` disables them too. Explicit `casper update` still works. |
| `CASPER_TELEMETRY` | Set to `0` to send no OpenRouter app attribution headers (`HTTP-Referer`, `X-OpenRouter-Title`, `X-OpenRouter-Categories`, `X-OpenRouter-App-Visibility`) on model requests and key checks; the bundled engine's own attribution is turned off with it. Works like Pi's `PI_TELEMETRY`: unset keeps attribution, and when set only `1`, `true` or `yes` keep it. An inherited `PI_TELEMETRY` is ignored. `telemetry: off` in your own config (**Send Casper's name to OpenRouter** in `/settings`) does the same; either one off is off. |
| `CASPER_OAUTH_CALLBACK_HOST` | Address the browser sign-in listens on; defaults to `127.0.0.1`. Casper refuses browser sign-in for any other value. |
| `CASPER_TUI_WRITE_LOG` | Optional log file of raw terminal output, or an existing folder for timestamped logs. It can contain sensitive output, so `/login` is refused while it is set. |
| `CASPER_PROFILE` | Picks the profile; see [Profiles](#profiles). |
| `CASPER_BROWSER_EXECUTABLE` | Absolute path to the Chrome/Chromium/Edge program for browser tasks, instead of auto-detection. See [BROWSER.md](BROWSER.md). |
| `CASPER_LOCAL_MODELS` | `off` (or `0`, `false`, `no`) looks for no model server at all for this run: not on this computer (Ollama, LM Studio, llama.cpp, vLLM, SGLang or MLX), and not the ones you added (`localModels: false` keeps those). See [Local models](#local-models). |
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
it). The AI's tools and shell can't read `auth.json`, `models.json` or the saved conversations
there. No Pi installation is needed. `CASPER_AGENT_DIR` selects a different store; an inherited
`PI_CODING_AGENT_DIR` never does. `/login` writes only the provider you agreed to into that store. A home that makes every new file
readable by all (a NAS whose folders hand down a 777 ACL) is no reason to stop: before saving, Casper
sets its own `auth.json` back to 0600 and the folder to 0700. A link, a hard-linked copy or a file
someone else owns is still refused.

**One-time import from Pi.** On first run with the default store, an existing Pi CLI install's API
keys (from `auth.json`) and `models.json` are copied once (the originals stay untouched). OAuth
sign-ins are not copied: their refresh tokens change on use, so a shared copy would let Pi and
Casper sign each other out. Casper names those providers once on stderr; run `/login <provider>` to
give Casper its own sign-in. The two stores are separate after the import.

**Sign-ins from other tools.** `/login` offers sign-ins that Claude Code, Codex CLI or GitHub CLI
left on this computer: API keys are checked, then copied. GitHub CLI's sign-in is used for Copilot.
A Claude or ChatGPT plan sign-in is never copied, and Casper starts its own sign-in instead.
Nothing is taken without your pick (see [Provider login](TERMINAL_UX.md#provider-login)).
`other_logins: off` in your own config, or **Sign-ins from other tools** in `/settings`, turns
the offer off. A project file can't change it.

**Pages the AI makes.** When seeing beats reading, the AI makes a page on this computer and it
opens in your browser (see [Pages the AI makes](TERMINAL_UX.md#pages-the-ai-makes)).
`ai_pages: off` in your own config, or **Pages the AI makes** in `/settings`, takes the tool away
from the AI, so it costs no tokens; `/pages` still lists the pages made. `open_pages: off`, or
**Open pages in the browser**, keeps them from opening: Casper prints the link only. A project
file can't change either.

**Repository Pi files are ignored.** A repository's own Pi project folder is never trusted:
`<project>/.pi/` extensions (program code), `SYSTEM.md`, `APPEND_SYSTEM.md`, prompt templates,
themes and `settings.json` are not loaded. User-level resources in the engine store (for example
`~/.casper/agent/extensions/`) still load, and so do your own slash commands in `~/.casper/commands` and
`~/.casper/agent/prompts` ([Your own commands](TERMINAL_UX.md#your-own-commands)). Project `AGENTS.md`/`CLAUDE.md` context files are still
sent to the model, except one that is a symlink pointing outside the project, which is skipped.

**OpenRouter app attribution.** Requests Casper itself sends to OpenRouter — model traffic, the
one-off calls for the checklist, reviews and automatic effort, and API-key checks — carry
app-attribution headers (`HTTP-Referer: https://choaterboater.github.io/casper/`, `X-OpenRouter-Title: Casper`,
`X-OpenRouter-Categories: cli-agent`, and `X-OpenRouter-App-Visibility: hidden`), so the usage is
filed under Casper's own OpenRouter app instead of the engine Casper is built on. `hidden` keeps an
early-preview app out of OpenRouter's public rankings and app pages; it does not turn attribution
off, and OpenRouter honors it only when the request creates a brand-new app. The headers are a
fixed app name only: they add no prompt, file, workspace, user or credential data, and no other
provider receives them. `CASPER_TELEMETRY=0`, or **Send Casper's name to OpenRouter** in
`/settings` (`telemetry: off` in your own config), turns them off along with the engine's own
attribution; `PI_TELEMETRY` has no effect. OpenRouter shows the icon of the referer's site, so the
referer is Casper's site (its ghost icon) rather than the GitHub page. OpenRouter keys apps by
referer, so after this change your usage may show under a new Casper app entry.

## Claude subscription through Claude Code

`claude-subscription` is an enabled, separate model provider backed by the official Claude Agent
SDK. It uses an installed native Claude Code executable and Claude Code's existing Pro, Max,
Team or Enterprise login. A separate Pi installation is not needed, and no Claude credentials
are copied into Casper. Claude Code must already be installed and signed in on the same OS:
a Windows installation and a WSL installation have separate executables and login state.

Starting signed out: choose **Claude Code plan** in `/login`, or type `/login claude-subscription`
(`/login claude` is an alias). Casper runs native `claude auth login --claudeai`, lets you finish in
your browser or forward a code through the private login prompt, then verifies the subscription
and refreshes its models without a restart. An existing valid login is checked without starting
browser sign-in again. If Claude Code is missing, the screen links to native installation instructions.
Claude Code keeps its credentials; Casper never saves them in its own auth file. Login does not
change your conversation model or saved default. Cancellation stops the login process, but Claude Code
may already have updated its own login; retrying `/login claude-subscription` checks that state first.

Select `/model claude-subscription/claude-opus-4-8` to remember this route, or add `--session`
to try it without changing the default. Other Claude models appear under `claude-subscription`
in `/model` once Claude Code's `auth status` reports a signed-in subscription on this OS.
Without that login, the provider remains registered but is not offered as authenticated.
The existing `anthropic` provider, `/login anthropic`, and saved defaults are
unchanged. `/logout` in Casper does not sign out Claude Code.

The model picker labels the routes **Claude Code plan** (`claude-subscription`) and
**Anthropic API** (`anthropic`). Claude Code rows say **plan**, not **free** or an API token price.
For Sonnet through the existing Claude Code login, select
`/model claude-subscription/claude-sonnet-5-5`. Selecting an `anthropic` model keeps the direct API
route and shows the equivalent subscription command; it never silently changes the provider.
An “out of extra usage” error describes that failed request, not all Claude use in Casper.

With a Claude plan sign-in through the `anthropic` provider, requests name a Claude Code version, and
Anthropic refuses newer models to an old one (`Claude Code 2.1.251 does not support this model`). When
Claude Code is installed here and newer than the version Pi names, Casper names the installed one, so a
Claude Code update keeps new models working without a Casper release. Without Claude Code here, Pi's
version is used.

Executable discovery uses `claude` on macOS/Linux and `claude.exe` on native Windows. The Windows
npm `.cmd` shim is not supported: use the native Claude Code installation. `CASPER_CLAUDE_PATH`
can name the installed executable explicitly, including a path with spaces. Compiled Casper uses
this external executable too; it does not rely on finding an SDK binary inside Bun's embedded files.

Casper appends its exact system instructions to Claude Code's default `claude_code` prompt preset,
rather than replacing that preset with a custom prompt. It keeps its tools, permissions, sandbox,
compaction and saved conversations. The SDK receives tool declarations through an in-process MCP
server, but cannot execute them; proposals return to Casper's normal approval/execution path. Each
completion starts one SDK query with one model turn and replays the visible conversation as labelled
text, retaining images and actual tool results but not historical thinking. Replay instructions tell
Claude to continue after the final message rather than repeat a call whose result is already present.
A completed tool proposal
hands control back to Casper at the SDK's terminal result, including the expected one-turn limit;
later CLI shutdown errors do not discard it. This avoids manipulating Claude Code's
private session files; it is not native alternating-turn replay and long conversations can increase
input usage. New instructions and tool lists take effect on the next completion. Steering applies
at Casper's next tool boundary, not inside an already-running completion.

API keys, endpoint overrides and cloud-provider switches are cleared from the Claude Code child's
environment; user/project Claude settings and inherited MCP servers are not loaded. The provider
checks the SDK-reported account before releasing the user prompt and rejects API-key or gateway
accounts instead of falling back. Both short plan names (`max`) and SDK display names (`Claude Max`)
are accepted; the SDK's optional `apiKeySource` may be absent, but an explicit API-key source is
rejected. Claude Code itself owns request identity and billing headers.
The footer's token cost is an API-equivalent estimate, not a charge. Subscription limits, model
entitlements and any server-side extra-usage routing remain Anthropic's decisions; this adapter
cannot guarantee billing or override plan limits. Anthropic's SDK documentation also requires
approval for third-party products offering Claude plan login/rate limits; technical compatibility
is not that approval.

## Local models

Casper can use a model that runs on your own computer. Start the server and its models show in
`/model`, with no sign-in and no file to edit. Casper looks on loopback at five usual ports:
11434, 1234, 8080, 8000 and 30000. SGLang adds port 30000; MLX shares the existing 8080 probe
with llama.cpp, so it needs no extra port.

| Server | Provider name | Address Casper tries | Use another address |
| --- | --- | --- | --- |
| Ollama | `ollama` | `http://127.0.0.1:11434` | `OLLAMA_BASE_URL` or `OLLAMA_HOST` |
| LM Studio | `lm-studio` | `http://127.0.0.1:1234/v1` | `LM_STUDIO_BASE_URL` |
| llama.cpp (`llama-server`) | `llama.cpp` | `http://127.0.0.1:8080` | `LLAMA_CPP_BASE_URL` or `LLAMA_BASE_URL` |
| vLLM | `vllm` | `http://127.0.0.1:8000/v1` | `VLLM_BASE_URL` |
| SGLang | `sglang` | `http://127.0.0.1:30000/v1` | `+ Add server` in `/model` |

MLX LM and vllm-mlx are servers built on MLX, not the MLX framework on its own. A server on
8080 can appear through the existing OpenAI-style probe; use **MLX** in **`+ Add server`** if
you want to name its kind explicitly. These are server kinds, not new `/login` providers;
no API key or separate sign-in is needed.

- **When.** In the background from the start, so the start never waits for it, and again each time you
  open `/model`, so a model you just pulled appears there. Each server is looked at on its own: one on this
  computer gets 0.8 s, one on another computer 10 s, and a slow one never holds up the others. Only a start
  whose saved model is a found server's waits, and only for that server. Helpers use what the main session found.
- **Looked for again.** A model you ask for by name (`/model ollama/qwen3:8b`), a `/model` with nothing to
  list, and a request on a saved model whose server didn't answer at the start (a VPN not up yet, a
  computer asleep) each look once more before they give up, when the last look ended over 15 seconds ago
  (one that just timed out isn't repeated at once).
- **Just started.** A model named on a server on this computer (`--model ollama/qwen3:8b` right after
  Ollama starts) is waited for up to 6 seconds, looking again, before Casper gives up. Then it says the server
  didn't answer on this computer and may still be starting; a server Casper finds never needs a key.
- **Nothing signed in?** A server found on this computer counts: the start doesn't say "not signed in", and
  your first request picks the first model found (Ollama's first) and saves it as your default. A server on
  another computer is never picked for you, and doesn't count as signed in: `/model` picks it. A saved model
  name (`ollama/qwen3:8b`) goes to wherever the variable points when Casper starts.
- **Quiet when absent.** A server that isn't running is skipped without a word. If you set its variable
  and nothing answers there, Casper says why in plain words: it didn't answer in time, refused the
  connection, asked for a key, couldn't be found by that name, isn't that kind of server, tried to send
  Casper elsewhere, or has a certificate this computer doesn't trust. It says so once at your first request,
  under the header in `/model`, in `casper doctor`, and as the reason a saved model is unavailable.
- **The model name** is the provider name, a slash and the server's own id: `ollama/qwen3:8b`,
  `lm-studio/qwen2.5-coder-7b`. Use it with `casper --model ollama/qwen3:8b` or `/model`.
- **Context window.** Casper reads it where the server tells: for Ollama a loaded model's window, else a
  `num_ctx` in the model's settings, else `OLLAMA_CONTEXT_LENGTH`; a loaded LM Studio model's window
  (one not loaded yet: the most it takes, until LM Studio loads it); llama.cpp's `-c`; vLLM's
  `--max-model-len`. Otherwise it uses the usual 128k (never more than the model was trained for), so set
  the window yourself if you can (see the limits below).
- **Lean guidance.** These model servers get shorter system text and tool descriptions automatically,
  even when their window is large or unknown. Any model with a known window of 32,768 tokens or less
  gets it too. No extra call, question or missing tool; big hosted models keep full text.
  `/settings` **Lean guidance: off** restores full wording (`lean_guidance: off` in your own config).
  See [Lean guidance](#lean-guidance).
- **The window Ollama really serves.** Ollama often runs a model with less than it takes (its own
  default is 4k, 32k or 256k, by the computer's memory) and silently drops the start of a longer
  prompt, Casper's instructions and tools first. Ollama's OpenAI-style address ignores a request's
  `num_ctx`, so Casper can't ask for more: after every answer it reads the window Ollama loaded the
  model with (LM Studio's too), and keeps the conversation inside it. A model loaded again with another
  window (Ollama's context setting changed, or a smaller one when memory is short) is followed either
  way, never past what the model takes, so the footer's figure and compaction measure the real window. If that
  is under half of what the model takes and under 32,768 (32k is enough for Casper), Casper says so
  once per session, with how to raise it: start
  Ollama with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve`, or set `PARAMETER num_ctx 32768` in a
  Modelfile (`ollama create`).
- **Models without tools.** Ollama says which models can take tools. One that can't (`dolphin3`, `gemma3`)
  is marked `no tools · can't edit or run commands` in `/model` and can't be picked: Casper sends its tools
  with every request, so such a model can't answer here, not even a question. A first model is never picked
  from them for you.
- **A tool call written as words.** A model that writes a `<tool_call>` tag in its answer instead of
  making the call doesn't get the tag (or what it wraps) shown; nothing in it is run.
- **Ollama's model settings.** Ollama's OpenAI-style address runs every model at temperature 1.0 and top_p
  1.0 unless a request says otherwise, so Casper sends the `temperature` and `top_p` the model's Modelfile
  sets (`ollama show <model> --parameters`), and nothing it doesn't set. It also sends `keep_alive: 30m`,
  so the model stays loaded through a pause instead of Ollama's 5 minutes; `OLLAMA_KEEP_ALIVE` in the shell
  that starts Casper changes it (`2h`, seconds, or `-1` for ever). A model Ollama lists as thinking takes
  your effort (`/effort`): off sends `reasoning_effort: none`, minimal is sent as low.
- **Reply length.** A found server is sent its output limit as `max_tokens`, the field Ollama's
  OpenAI-style address reads (it ignores `max_completion_tokens`), so a reply can't run past it.
- **Embedding models** (`nomic-embed-text` and the like) are left out: they can't chat.
- **No key leaves for it.** A found server is sent the word `local` as its key, and nothing else: keys
  are kept per provider, so no other provider's key is ever sent to it. The look itself sends no key.
- **No redirects.** A found server that answers a request with a redirect gets an error, not a second
  request: your conversation is never sent on to another address. (A provider you set up in `models.json`
  is not covered by this.)
- **Off switch.** `/settings` **Local models** (it writes `localModels: false` in `~/.casper/config.yaml`;
  a project file can't change it). A change applies from the next start. Servers you added yourself (below)
  stay. `CASPER_LOCAL_MODELS=off` in the environment looks for none at all, yours included, for one run
  (a script or CI).

**A server on another computer.** Point the server's variable at that computer, in the shell that starts
Casper: `OLLAMA_HOST=192.0.2.10` (the usual port is added), `LM_STUDIO_BASE_URL=http://192.0.2.10:1234`,
`LLAMA_CPP_BASE_URL=…` or `VLLM_BASE_URL=…`. A server on this computer of the same kind is then not looked
for. Most servers only listen on their own computer at first, so on *that* computer:

- Ollama: `OLLAMA_HOST=0.0.0.0 ollama serve` (there `0.0.0.0` means "listen on the network"; on the computer
  running Casper it means "this computer", so don't copy it across).
- LM Studio: turn on **Serve on Local Network** in its server settings.
- llama.cpp: `llama-server --host 0.0.0.0`; vLLM: `vllm serve <model> --host 0.0.0.0`.
- Let the computer running Casper through that computer's firewall, on the server's port.

These servers have no password by default, so open them only on a network you trust. Plain `http` on a
home network or Wi-Fi can be read by others on that network; Tailscale or `https` keeps it private. If
nothing answers, `/model` and `casper doctor` say why and repeat these lines.

### Add a model server on another computer

The easy way: no variable and no file to edit. In `/model`, go to the last row of the list on the left,
**`+ Add server`**, and press Enter. Or type `/login` and pick the last row, **Model server on another
computer** (when `/login` first offers a sign-in it found on this computer, pick **Sign in separately** to
see that list). This also works for a server on this computer at another port: use `localhost`. One at its
usual port here (Ollama on 11434) is found by itself: Casper says so, lists its models (`ollama/…`) and saves
nothing. Both open the same steps:

1. **Model server type.** Keep **Detect automatically**, or choose a kind: **Ollama**, **LM Studio**,
   **llama.cpp**, **vLLM**, **SGLang**, **MLX (MLX LM / vllm-mlx)** or **OpenAI-style server**.
   All kinds are offered as fallbacks when detection can't identify yours; a kind the server's own answers
   contradict is not kept (llama.cpp chosen where Ollama answers is saved as Ollama). Start that server separately first;
   Casper doesn't install a backend or download a model. SGLang and MLX use the server's OpenAI-compatible API.
2. **Where is the server?** Type its address: `192.0.2.10`, `myserver`, `myserver:11434` or
   `http://myserver:8000` (a copied API address such as `…/v1/models` works too). With **Detect automatically**
   and no port, Casper tries five usual ports (11434 Ollama, 1234 LM Studio, 8080 llama.cpp / MLX,
   8000 vLLM, 30000 SGLang) and finds every server that answers, waiting up to 10 seconds. It works out
   which kind each one is; any other server with an OpenAI-style model list is added as one.
   With **SGLang**, a bare address instead uses port **30000**; with **MLX**, **8080**. Include `:port` if
   yours is different. An `https://` address still uses 443 by default. Add the server once and Casper remembers it.
   In automatic remote detection, vllm-mlx's `owned_by` marker is recognized as **MLX**. MLX LM exposes no
   reliable identity marker, so it stays **OpenAI-style server**; choose **MLX** explicitly to label it.
3. **No model server there?** Casper says why for each port (refused, didn't answer in time, can't find
   that name, answered but isn't a model server…), and when nothing answered at all, what to set on that
   computer (above). It offers `1 Cancel · 2 Try another address`; the address stays in the box to fix.
4. **A server that asks for a key** (llama-server or vLLM started with `--api-key`, or a proxy) is not
   added: Casper says so and points to `~/.casper/agent/models.json` (below), where a server with a key is
   set up. Other servers on the same computer that need no key are still added.
5. **Name it.** The box starts with a name made from the kind and the computer: `ollama-myserver`,
   `ollama-192-0-2-10`. Enter keeps it; typing replaces it. The name is the first half of its models' names
   (`ollama-myserver/qwen3:8b`). Lowercase letters, numbers and dashes; a name a provider already uses
   (`openai`, `openrouter`, `brave`…, or one in your `models.json`) is refused.
6. Saved, and its models show in `/model` at once. Nothing is picked for you: pick a model there. From
   `/login`, `/model` opens on the new server.

Each server is saved when its own steps end; Esc stops there and saves nothing more (with two found on one
computer, the first is kept if you press Esc on the second). Several servers of one kind are
fine (two Ollama computers, or one here and one there): each has its own name. A server you added that
doesn't answer still shows in `/model`'s list, marked `off`, with why; one that answered with no models
yet shows `0`, with what to do on that computer.

**Forget one.** In `/model`, highlight it in the list on the left and press **Ctrl+X**; Casper asks
`1 Keep ollama-myserver · 2 Forget ollama-myserver`. (While an MCP server has writes on, Ctrl+X turns them off
first; press it again to forget the server.)

**Where it is kept.** The name, address and kind go in `~/.casper/config.yaml` (Casper writes them,
keeping the rest of the file, its comments and your other entries as they are):

```yaml
modelServers:
  - name: ollama-myserver
    address: http://192.0.2.10:11434
    kind: ollama        # ollama, lm-studio, llama.cpp, vllm, sglang, mlx, or openai (other OpenAI-style servers)
```

Only `~/.casper/config.yaml`: a project file can't add one, and a profile's list is ignored. A bad entry is
skipped with a warning, never a reason Casper won't start. The AI can read that file, so a key never goes
there (an entry with a key is skipped). Casper never asks for, keeps or sends a key for a server you
added: each request to it carries only the word `local`, even if a sign-in in the login file has the same
name. A server that needs a key goes in `models.json` (below).

- **When.** Your servers are looked at with the others: in the background, each on its own, 10 seconds
  for one on another computer. `localModels: false` doesn't stop them.
- **At a usual address here.** One you added at a local kind's usual address on this computer is used
  instead of the automatic look there. If it was saved as another kind (llama.cpp where Ollama answers), the
  one that answers is found too (`ollama/…`), and its row in `/model` and `casper doctor` say so: forget yours
  to list them once.
- **Never picked for you.** A server you added never becomes your model by itself; with no model yet, a
  request opens `/model` on your servers.

**Your models.json still works, and wins.** A provider you set up yourself in `models.json` with the
same name (`ollama`), or one that points at the same address under another name, is used as you wrote
it and the found one is not added. Most servers on another computer are easier to add in `/model` (above);
use the file for a server that needs a key, exact windows, extra headers, or a server Casper can't detect.

**Where the file is.** `~/.casper/agent/models.json` (create it if it isn't there). If you moved
Casper's store with `CASPER_AGENT_DIR`, it is `models.json` in that folder. Pi's own docs say
`~/.pi/agent`; that is not where Casper reads. Only you can set this up: a project can't add a
server address, and the AI's tools can't read or change the file (the AI can read `modelServers` in
`~/.casper/config.yaml`, which holds no key).

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [{ "id": "qwen2.5-coder:7b", "contextWindow": 32768 }]
    }
  }
}
```

- `ollama` is a name you choose. It becomes the first half of the model name (`ollama/qwen2.5-coder:7b`).
- `baseUrl` (the address ending in `/v1`), `api` and `models` are required. Keep `"api": "openai-completions"`.
- `apiKey` is required too, but a local server ignores it: any text works. Without the line Casper says
  `<name> at <address> needs an apiKey line in models.json`.
- The two `compat` lines stop Casper sending parts of the request that most local servers don't know
  (found servers get them too). Leave them in unless your server handles them.
- `contextWindow` is optional; set it to what you started the server with so the footer's context
  figure is right. A local model shows as free.
- The id is the name the server itself uses, exactly: `ollama list`, or open `<baseUrl>/models`.

**Privacy.** A model on the same computer sends nothing off it. A server that forwards your request
elsewhere does send it: Ollama's `:cloud` models run on Ollama's servers, and a `baseUrl` or a variable
above that points at another machine goes there. Check what the model really is before you rely on this.

**Know the limits.**
- SGLang and MLX use streaming OpenAI-compatible chat completions, including tool calls when the model
  and server support them. Tool support depends on the model and startup flags, not the server's name:
  SGLang may need `--tool-call-parser <parser>` with a parser suited to the model. MLX LM / vllm-mlx
  likewise need a tool-capable model and the appropriate server options; not every model can edit files.
- Small models often can't use tools. Casper sends its tools with every request, so such a model can't
  answer here, not even a question: Casper says so; pick another with `/model`. Tool use needs a model made for it
  (look for "tools" on the model's page) and, on some servers, a switch to turn it on.
- Context size matters most. Casper's fixed request, before your words, is about 4,600 tokens. Start
  the server with a window of 16k (16,384) tokens or more: Ollama's default is smaller and will cut the
  request off without warning. Set it with `num_ctx` in Ollama, the context field in LM Studio, `-c` in
  `llama-server` and `--max-model-len` in vLLM.
- Helpers (up to 2 read-only ones, and up to 3 builders) and your main conversation all send to the same
  server. A single computer answers one at a time, so expect them to wait for each other.

### Small context windows

Casper's own instructions and tool list take about 4,600 tokens of every request. Local models
often have a window of 4k to 32k, so Casper says so once per session when the model you picked has a
window under 16,000 tokens; expect short tasks only, or pick a model with 16k or more.

A window too small for those instructions and tools plus a short turn (Ollama's own default of 4,096,
for one) can't work: the server cuts the request and the reply comes back cut short. Casper stops before
calling the model and says the window, what it needs, and the fix: start Ollama with
`OLLAMA_CONTEXT_LENGTH=32768 ollama serve`, or set `PARAMETER num_ctx 32768` in a Modelfile.

For a window under 32,000 tokens, Casper also keeps a quarter of the window (at least 2,000 tokens)
free for the reply when it decides whether to compact, instead of the usual 16,384. Without that, an
8k model would compact on every turn. Windows of 32,000 and up are unchanged, and a
`compaction.reserveTokens` you set yourself is kept.

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
  colon as an effort suffix. A colon in a name no model has (`ollama/qwen3.5:9b` not pulled yet) is an
  unknown model, not an unknown effort.
- Ambiguous IDs, roles that are not set, and loops between roles are errors.
- An effort suffix you type (`@review:auto`) overrides the role's own suffix.
- An effort level a model lacks runs as the nearest level above it, else below (so `max` on a
  model without `max` runs at its highest level). Automatic effort never picks `off` or `max`.

Where roles are used: explorer subagents and the [untrusted-text reader](READER.md) use `fast` (the
reader falls back to the session's model), reviewer subagents and the
[acceptance check](VERIFICATION.md#independent-acceptance-check-experimental) use `review`, and
roles that are not set fall back to Casper's startup default. See [DELEGATION.md](DELEGATION.md).
An explorer or reviewer whose role is not set works at `low` or `medium` effort (never above
your saved effort); set the role, with or without `:effort`, to choose instead. The
[`/security-review` AI review](SECURITY_CHECKS.md) keeps your effort.

**What is saved.** Casper owns `~/.casper/settings.json`: your default model and per-model effort,
optional `modelRoles`, and `autoEffortModels` (full model IDs).

- Changing a role does not select a model or send a request.
- `/model` saves a new default unless `--session` comes before the model name.
- `/effort` saves its choice unless `--session` comes after the level.
- Shift+Tab cycles the same choices, including `auto`, and saves the level it stops at, once, like
  `/effort`: each press only moves the footer, and when the presses rest (under a second) Casper saves and
  says it in one line, so going round the ring never leaves a line per press. The `--effort` command-line flag is for one run and never saves.
- Which effort applies: a suffix you typed, then this conversation's remembered choice for the
  model, then the saved choice for the model.
- Existing conversations and branches keep their model and effort even if you change roles later.
- Pi CLI and project-level Pi model settings are neither used nor changed.

Cancelling a model pick before it takes effect keeps your previous choice. If Pi has already
switched the model while a selection is finishing, Casper keeps that real model and effort in the
conversation and on resume; a late cancel still stops it being saved as the default.

**Automatic effort is opt-in and makes an extra provider request per prompt** (a helper uses it
only when its role is set; builders always can). It uses the `fast`
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
updates: off         # no background update checks, notices or installs; default: auto, notices only: notify
sideQuestions: false # a line starting with ? is an ordinary request, not a side question
localModels: false   # don't look for Ollama, LM Studio, llama.cpp or vLLM on this computer
modelServers:        # servers you added in /model (+ Add server); Casper writes it; ~/.casper/config.yaml only
  - name: ollama-myserver
    address: http://192.0.2.10:11434
    kind: ollama
pages: off           # no page checks after a UI change, in any project
telemetry: off       # don't send Casper's name to OpenRouter (same as CASPER_TELEMETRY=0)
ssh_login: off       # ssh never gets Casper's hidden password box (see Private ssh passwords)
other_logins: off    # /login never offers sign-ins from Claude Code, Codex CLI or GitHub CLI
network_updates: off # only a new Casper brings a new network server version (see MCP.md)
ai_pages: off        # the AI is never offered casper_page: no pages, and no tokens for it
open_pages: off      # pages the AI makes are not opened in your browser; Casper prints the link
pictures: off        # the AI is never offered make_picture; it draws SVG
notifications: off   # no bell and no desktop notification when a long task ends or a question waits
```

`network_updates: off` (or **Network server updates** in `/settings`) stops Casper looking for
casper-network-mcp releases newer than the one it pins; see [MCP.md](MCP.md). `tools: { downloads: off }`
and `CASPER_OFFLINE=1` stop it too.

**Updates** in `/settings` replaces **New-version notice** and saves `updates:` as one of:

- `auto` (the default): check and install updates in the background, with no model or tokens.
  Restart Casper to use an installed update.
- `notify` (**notify only**): check for a newer Casper and show the live notice row (one `[update]`
  line on plain terminals), but never install it in the background. Use `casper update` when you want to install it.
- `off`: no background checks, notices or installs.

Checks normally happen at most once a day, shared across sessions, plus one extra probe about
three minutes into an interactive session to catch a release published since startup. A busy task or
its checks postpone that probe until idle. Installs are attempted at most once a day, never during
checks, never in one-shot or `--json` runs, and never restart or reload Casper.
A release install asks GitHub for the newest release and uses the same verified `casper update`
path. A checkout only fast-forwards a clean `main` (or default branch) tracking that branch on
origin, with no local commits or untracked files; it never stashes, rebases or switches branches.
Only a changed `bun.lock` triggers `bun install --frozen-lockfile`. Otherwise the notice says
`Casper update ready · casper update`. Quiet failures go to `~/.casper/update.log` and show
`update failed · casper update`. `CASPER_NO_UPDATE_CHECK=1` and `CI` disable all background update checks, notices and
installs in every mode. `casper update` still installs or pulls explicitly, even with updates off;
`casper update --check` only says whether there is one.

Set `updates:` only in `~/.casper/config.yaml` or a profile you chose yourself. A project file
cannot set it, and a project-selected profile cannot change it. Old `updates: false` means `off`;
old `updates: true` (or `on`) means `auto`. A change in `/settings` applies from now on; choosing
`off` removes the update note at once.

### What a task spends

Nothing to set up. The footer shows one current-task figure: cost (`task $0.31`, or `task sub ≈$0.31` for a subscription), or tokens for a free model (`task 48.2k tok`). Session totals are in `/status` and `/usage`. With OpenRouter the cost is what
OpenRouter reports it charged for each response; other providers get the catalog's estimate, not a
bill. By default a task only gets notes and never stops for money:

- At about **$1**, one quiet line: `… This task has used $1.03 so far (312k tok).` At about **$5**,
  one more. A subscription or a free model gets neither.
- Want a limit? Say it in your request ("keep it under $2"), or set `spend.pauseAt`. Then the task
  pauses before its next step and asks `This task has used $5.02.` with `1 Stop here · 2 Keep
  going`. Stop here is first, so Enter stops; the work so far is kept and the receipt says
  `– Incomplete — stopped at $5.02, the $5 limit for one task`. Keep going asks again at the next
  multiple.
- With `spend.pauseAt` set, one-shot runs and `--json` never wait: they stop at the same point, say
  so on one line, and the receipt says it (exit 2, JSON `spendLimit`).

The pause comes before the AI's next step (a tool call), so a turn that ends in words only ends the
task instead. The shown cost leaves out the small automatic-effort call and `/delegate` helpers until
they report back, so it can be a little under the real figure.

To change the limits, or turn one off, use `/settings` (Spend notes, Spend pause), or set them in
your own config (a project cannot):

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
pay off on Anthropic if you often pause for more than five minutes. `cache: off` keeps no cache, so
every request costs more. To change it, pick **Prompt cache** in `/settings` or set it in your own
config; a project's `.casper/project.yaml` cannot:

```yaml
# ~/.casper/config.yaml or a profile's config.yaml
cache: short   # auto (default), long, short, or off
```

## Display

How much of the work shows on screen while Casper works. The model's reasoning is never printed: at most the status
row shows a short headline of it (below).

- `normal` (default): the steps tick in under the AI's words, then fold into one row naming what was done
  (`└ read AGENTS.md · ran git status, bun test (2m05s)`) when its next words arrive; the edits go in one box
  with a short diff (ten rows at most) and each failure in a box with the last lines it printed.
- `quiet`: the model's words, failures (in their box) and the receipt; successful steps leave no row.
- `detailed`: every step on its own line, and every edit's whole diff in the edit box.

`/details quiet|normal|detailed` switches and remembers it (it writes `display:` for you, like
`/effort`); `--session` (before or after the level) keeps it to this session, and `/details` alone shows the level
now and changes nothing. Ctrl+T shows the last box in full at any level (the group's whole diff, or everything a
failed step printed), or else the last finished step: an edit's whole diff, or what a command printed. The window title names the conversation from its first request
(`Casper · subnet calculator`) and shows `◐` while Casper works.

```yaml
# ~/.casper/config.yaml or a profile's config.yaml
display: detailed   # quiet, normal (default), or detailed
```

**Reasoning headline.** While the model reasons and its provider sends readable reasoning, the status row shows a short
headline of it instead of `Reasoning · 3.0k chars`: the reasoning summary's title (`Planning the port fix · 12s`), or
else its latest finished sentence, at most 60 characters, secrets hidden. It is in the status row only: never the
transcript, the steps pane, the receipt, an export or `--json`, and not at `/details quiet`. A provider that sends no
readable reasoning keeps `Reasoning · 3.0k chars`. `/settings` **Reasoning headline** turns it off (it writes
`reasoning_headline: false`); a project file can't set it ([decision 24](adr/0002/24-reasoning-headline.md)).

```yaml
# ~/.casper/config.yaml
reasoning_headline: false   # on (default) or off
```

## Theme

The screen's colours. A theme changes colours only: the words, glyphs, bold text and layout stay
the same, and nothing goes to the model. `NO_COLOR`, a pipe and `TERM=dumb` still show no colour,
whatever the theme.

- `default`: Casper's own look, cyan for structure and faint text for what is secondary, your request on a grey bar.
- `light`: for a light terminal background; blue and magenta in place of cyan and yellow.
- `high-contrast`: bright colours and no faint text (and no bar behind your request).

Pick **Theme** in `/settings`, or set it in your own config. A project's `.casper/project.yaml`
can't set it, so a repository can't make a warning or an approval hard to read. A name Casper has
no theme for uses `default`, and one `[config]` line at start (and `casper doctor`) says so;
`/settings` shows it as written, with every theme to pick instead.

```yaml
# ~/.casper/config.yaml or a profile's config.yaml
theme: light   # default, light, high-contrast, or a theme a pack you added brings
```

A pack you added can bring one theme (see [PACKS.md](PACKS.md#a-theme)). It shows in `/settings`
next to these, marked with its pack, and `theme:` can name it. It is there only while packs are on
and the pack is still what you saw; otherwise `theme:` that names it uses `default`, with the line
above. Its name can't be a built-in theme's or another pack's theme's.

A theme file, which a pack can carry, is YAML (or JSON) with a `name` (lowercase letters, numbers
and single hyphens, like a skill's) and `colors`, by role: `accent`, `muted`, `border`,
`selection`, `success`, `warning`, `error`, `diffAdded`, `diffRemoved`, `diffHunk` and `userBg` (the bar behind
your request where Casper shows it again: a background colour; `default` or `dim` is no bar). A colour is
`"#rrggbb"` (in quotes: YAML reads a bare `#` as a comment) or one of `default`, `dim`, `black`,
`red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, `gray`, `bright-red`,
`bright-green`, `bright-yellow`, `bright-blue`, `bright-magenta`, `bright-cyan` and
`bright-white`. A role left out takes the default theme's colour. Nothing else is read: another
field, any character but plain printable ASCII (so no escape, control or invisible character, not
even in a comment), a backslash, YAML anchors, aliases and tags, and a file over 8 KiB are
refused, so a theme can't build on another, pull in a file or run anything. A `#rrggbb` colour
is drawn exactly where the terminal says it can (`COLORTERM=truecolor`, Windows Terminal), and as
the nearest of 256 colours elsewhere.

```yaml
name: ocean
colors:
  accent: "#3399ff"
  selection: bright-cyan
  warning: magenta
```

## Showing the AI the pages

After a UI change in a web project, the page check saves a desktop and a phone screenshot of each
changed page (no tokens). `showPages` says whether a model that can see pictures is shown them once,
so it can fix what loads but looks wrong (see [VERIFICATION.md](VERIFICATION.md#page-checks)). Each
look uses tokens. `off` also leaves the picture out of the model's own browser checks, which
otherwise bring the final page's picture (see [BROWSER.md](BROWSER.md)). `/settings` changes it by
number; a project file can't set it.

```yaml
# ~/.casper/config.yaml or a profile's config.yaml
showPages: ask   # ask (default: once a session, 1 No · 2 Yes, show the AI the pages), on, or off
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
| Packs | `~/.casper/packs/<name>/`, added only by your `/pack add` | Yes, while every file is what the add box showed you; on unless `packs: off`. See [PACKS.md](PACKS.md) |

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
keeps the bundled layout and its "Changing things" opening line; otherwise the bundled text is used
and `/skills diagnostics` says why. A project's same-name skill never replaces a bundled one. See
[SKILLS.md](SKILLS.md).

Skills are optional procedures, not a substitute for the repository: frontend, design and other
work use the project's own files. Only the selected skills' bodies are read and added, with their
source and folder. When two skills share a name, both show in `/skills` with different IDs, but
only one is used: the more relevant, then project → user → other tools, then ID. A pack's skill is
never used when any other skill has its name. Limits: 16 KiB of
frontmatter, 256 KiB per skill file, and 64 KiB of skill bodies per request. A bad or oversized
skill gives a warning; it does not stop Casper from starting.

### Inspect and review

These skill commands run locally and work without a model or sign-in; they never send skill
bodies to the model:

```text
/skills
/skills diagnostics
/skills inspect <id>
/skills trust <id>
/skills block <id>
```

Use the exact ID from `/skills`. `trust` prints the body and its SHA-256 hash, then asks
`1 No · 2 Trust it`; 2 trusts exactly what it showed. `/skills trust <id> <sha256>` still works for
scripts. Decisions are stored in `~/.casper/skills-trust.json`, keyed
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
