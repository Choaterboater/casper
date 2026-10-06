# Release process and installers

**What this is:** what changed in each Casper release, how releases are built and
published, and what the installers promise. **When you'd use it:** to see what is new
before you upgrade, or when you build or publish a release yourself.

Casper distributes an unsigned **v0.2.22 preview**, not a stable release. The installers
download from `https://github.com/Choaterboater/casper/releases/download/v0.2.22`,
because GitHub's `latest/download` link skips preview releases. The first published
preview was **v0.1.0**. A published release is never changed; every fix ships under a
new version.

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
a failed update keeps the old one running.

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
  or `This download doesn't match a Casper build from GitHub. Nothing installed.` The shell installer's
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
  published digest for the file and its pinned download address, and runs it on the
  folder of the running program with the new version pinned. Once there is a release
  key, Casper first checks `SHA256SUMS.sig` itself (no `ssh-keygen` needed) and that the
  signed list names the installer with a matching digest; when `gh` is signed in, it
  also checks the installer's build provenance. It then hands the installer the running
  program's own file (`CASPER_OS`/`CASPER_ARCH`) and its SHA-256 from the list it checked
  (`CASPER_SHA256`), so the installer fetches no list of its own; a signed list that does
  not name that file installs nothing. Any failure says why in one line and
  runs nothing; on Windows the running
  `casper.exe` is renamed to `casper.old.exe` first and put back if the installer fails.
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

1. `/model` opens the full-screen browser with the provider sidebar (Tab focuses the
   sidebar; Up/Down switch login groups); the footer ends with Casper's hint line
   (`Enter: remember globally · Ctrl+S: session only · …`) followed by the selected-model
   summary. Startup clears the viewport once (a fresh session fills the screen).
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
- Windows ARM64 (from the release after v0.2.22): `casper-windows-arm64.exe` is built, started
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
