# Terminal UX — daily-use interface

**What this is:** a guide to Casper's terminal screen: what you see, the keys,
and the `/` commands. **When you'd use it:** when you are learning Casper, or
want to know what a symbol, key or command does. `/help` shows a short list in
Casper, `/help <word>` only the lines that mention a word (`/help mcp`), and
`/help all` the full one. A mistyped command gets "Did you mean …?", and a command that
takes nothing after its name says so (`Usage: /theme, with nothing after it.`).

## Quick reference

### Keys

| Key | What it does |
| --- | --- |
| Enter | Send the request (during work: the AI reads it at its next step, or it is queued for after the task) |
| Shift+Enter or Ctrl+J | New line in the prompt (Shift+Enter only where the terminal supports it) |
| Up / Down | Earlier prompts from this session |
| `/` | Command list with fuzzy search; Tab completes. After a command and a space, its subcommands (`/mcp ` lists `detail`, `connect`, …) |
| `@` then Tab | Complete a file path (inserts the path only; it does not attach the file) |
| Shift+Tab | Cycle reasoning effort (`auto`, then the model's levels) and remember it |
| Esc | Stop the current work |
| Ctrl+C | Cancel work; when idle, clear the draft; twice on an empty prompt exits |
| Ctrl+D | Exit when the prompt is empty |
| Ctrl+T | Show the last step in full: an edit's whole diff, what a command printed, a failed check's log, the provider's own words after an `[error]`, or a plan's optional Details (works during work too) |
| Ctrl+G | In a plan, open its saved Markdown in `VISUAL` or `EDITOR`; reread it and show the plan again on return |
| Ctrl+L | Redraw the screen |
| Ctrl+V (Alt+V on Windows) | Paste a picture from the clipboard; it shows as `[image 1]` and goes with the request. A file you copied in Finder, Explorer or a file manager goes in as its path, and a picture file goes with the request like a dropped one. With neither on the clipboard, its text is pasted |
| Ctrl+O | Open or close crew details (each helper's last steps) while helper rows are shown; otherwise toggle raw/plain steps |
| Alt+O | Toggle raw steps (every tool call on its own row) or plain ones, including while crew details are open (works during work too) |
| Ctrl+X | Turn MCP writes off for every server at once and refuse an open change box (see [MCP.md](MCP.md)); works during work and while a box is open |

### Commands

These commands run on your machine. Only `/compact`, `/delegate`, `/review`, `/crew <job>`,
`/verify repair` and `/btw` send a model request. `/model` may fetch provider model lists
over the network, and `/references add` downloads files after asking you.

| Command | What it does |
| --- | --- |
| `/help`, `/help <word>`, `/help all` | Short help, the lines that mention a word (`/help mcp`), or the full reference |
| `/status` | Project, model, sign-in and connections (`/project` alone shows the same) |
| `/doctor` | Check Casper's own setup and fix what it can, each fix after a question (see [DOCTOR.md](DOCTOR.md)); during a task it only reports |
| `/model`, `/model <words>`, `/model big <model>`, `/model failover <models>` | Pick a model (remembered; `--session`, before or after the model, for this conversation only); words pick the model they name (`/model opus 5.5`), several ask which, none name the closest; your big model for when repairs run out; the models a task goes on with when its model hits a limit |
| `/effort [level\|auto]`, `/thinking` | Reasoning effort (the model's own levels; one it lacks is refused), or `auto` per request; Shift+Tab cycles it (see [Model and effort](#model-and-effort)) |
| `/login [provider]`, `/logout [provider]` | Sign in to a provider: `codex`, `copilot`, `anthropic` or `openrouter` (see [Provider login](#provider-login)), or add a model server on another computer (the list's last row); remove a sign-in Casper saved (`/logout` alone lists them; environment variables stay) |
| `/context`, `/usage`, `/cost` | Context estimate; session tokens and estimated cost (`/cost` is `/usage`) |
| `/compact [instructions]` | Summarize the conversation (**makes a model request**) |
| `/clear`, `/new` | Start a fresh conversation; files and saved conversations stay |
| `/resume [id]` | Pick a saved conversation from a numbered list, or go back to one (the start of its ID is enough) |
| `/continue` | Go back to the most recent other conversation saved in this folder, as `casper --continue` does at startup |
| `/diff [n\|list]` | The last task's changes (also outside git), task n's, or a list to pick from; before any task, git's view |
| `/undo [n]`, `/redo [n]` | Put the last task's (or task n's) files back, or back again (no model; [UNDO.md](UNDO.md)) |
| `/rewind [n]` | Back to just before an earlier prompt (a numbered list, newest first; `/rewind 1` is your last), its words back in the prompt to edit and send; when later tasks changed files, `2 Conversation and files` puts them back too. No model; nothing is deleted ([UNDO.md](UNDO.md#rewind-to-an-earlier-prompt)) |
| `/plan [request]` | Optional plan or first-version spec; at most one round of questions; alone, reopen a recent saved plan |
| `/btw <question>` | A side question, idle or during a task: your fast model answers with no tools, and the conversation never sees it (like a line you start with `?`; works with side questions off) |
| `/suggestions [on\|off]` | List the suggested next steps, or turn them on or off |
| `/details [quiet\|normal\|detailed]` | How much work shows, remembered like `/effort` (`--session` for this session only); alone, the level now; `all` or `everything` means detailed; Ctrl+T shows the last step in full |
| `/settings [name]`, `/config [name]` | Seven areas, aligned values and help for the highlighted row. Up/Down moves; Enter/Space changes; Left/Right or Tab switches areas; type to search; Esc closes. A name opens one setting. Plain terminals keep grouped numbered choices ([CONFIGURATION.md](CONFIGURATION.md#settings)) |
| `/theme` | The Theme row of `/settings` on its own: pick the screen's colours |
| `/hotkeys` | The keys Casper uses, one a line |
| `/copy [n]` | Copy the last answer, or its code or quote block n (numbered together, a quote without its `> `), to the clipboard. Saying `copy that` or `copy the prompt` does `/copy 1` with no model call when the answer has one block. When an answer is mostly one block to paste, the row under it offers `Copy the prompt`, `Copy the command` or `Copy the code` (free) |
| `/export [file]` | Save this conversation (Markdown; a `.jsonl` name saves every message): to `~/.casper/exports` with Casper's other per-user files, or to `file` from the project folder; it says the whole path; never over a file that is there. The Markdown has the whole conversation, also what a compaction took out of the AI's context (marked where it happened, with the summary the AI kept); a prompt Casper sent the AI itself (a repair or review round) is under Casper, folded, never under You. Both formats hide secrets as `<secret hidden>` with the pass bash output gets (secret-named environment values, Casper's own login keys, `KEY=VALUE` secrets, address passwords, private keys, secrets named in prose); a `.jsonl` keeps its format, with only those strings changed, and the line says how many were hidden |
| `/rename <title>` | Name this conversation (the window title and `/resume`) |
| `/trust`, `/trust off` | Trust this folder: Casper runs its checks, and the project's scripts, builds and tests run as routine work; `off` takes it back. "trust this folder" and "stop trusting this folder" do the same ([VERIFICATION.md](VERIFICATION.md)) |
| `/output [n\|all]` | Full command and output of a recent tool call from the last task |
| `/receipt [n\|list]` | The last task's receipt in detail, a saved one, or the last 10; here a card with every line under plain labels |
| `/help receipt` | What each verdict on a receipt's first line means, and what to do about it |
| `/verify [checks]`, `/verify repair`, `/verify add <name>` | Run the project's checks; repair failures; save a check Casper found ([VERIFICATION.md](VERIFICATION.md)) |
| `/review`, `/review <branch\|commit>` | A read-only reviewer AI (your review model) reads your uncommitted changes (staged, unstaged and new text files), the changes since a branch's merge-base, or one commit, and lists real bugs, security issues and missing tests by file:line, most serious first; a finding that names no real line of a changed file is dropped. Key and `.env` files stay out, a big diff is cut and the list says which files were left out, and an empty change asks no model. The numbered list goes to the conversation too, so `fix 1 and 3` works next. It reads the repo's `AGENTS.md`, `CLAUDE.md` and an ADR of deliberate choices when there is one |
| `/security-review` | Run the pinned security tools here, then offer an AI review (asks first; [SECURITY_CHECKS.md](SECURITY_CHECKS.md)) |
| `/project <name>`, `/project new [name]` | Open a project folder inside this one; start a new project in ~/Projects (no model; [NEW.md](NEW.md)); `/project` alone is `/status` |
| `/permissions` | A short screen: whether Casper is asking, one line per kind (state · how to change it) and what stays protected, then the box `Stop asking until you quit?` (`1 Keep asking · 2 Stop asking until I quit`; Enter keeps asking; no box during a task). `details` is the full screen. `all` (or `allowall`, `allow-all`) is the same box on its own (during a task, no box: it takes effect at once), `ask` turns the questions back on, `write <folder>` allows a folder outside the project, `forget <folder>` takes it back. A mistyped word gets `Did you mean /permissions all (it asks first)?` and runs nothing |
| `/sandbox`, `/sandbox forget <host>` | What the shell sandbox holds; forget a host you allowed |
| `/allowed`, `/allowed forget <n, command or all>`, `/allowed keep <n>` | The shell commands you said yes to for this project (saved, and for this session); take one back, or keep a session yes for the project (the Next row's `Always allow …`) |
| `/lab`, `/lab import <file>` | Your lab devices; add more from a file ([NETWORK-CHECKS.md](NETWORK-CHECKS.md)) |
| `/skills` | Skills and whether you trust them ([SKILLS.md](SKILLS.md)) |
| `/pack add <folder or link>`, `/pack list`, `/pack remove <name>` | Skill packs: add one after a box that shows it, list them, take one out ([PACKS.md](PACKS.md)) |
| `/mcp` | MCP servers: set up Casper's network server (`/mcp setup network`) and its logins (`/mcp login`), add a server over ssh (`/mcp setup ssh`), connect, writes on or off, allow, forget, docs ([MCP.md](MCP.md)). `/mcp` is one line per server; on a normal terminal an arrow-key picker under it connects, disconnects, forgets or shows details, and `/mcp detail [name]` prints the full status |
| `/lsp` | Language servers ([LSP.md](LSP.md)) |
| `/browser` | A disposable browser; screenshots ([BROWSER.md](BROWSER.md)) |
| `/look [command] [page or url]` | Review or polish a page in the real browser: `critique`, `audit` and `guidelines` report, `polish`, `layout`, `type`, `colour`, `quieter`, `adapt`, `harden` and `clarify` fix and look again; alone, the numbered list. After a report, `fix` fixes everything it found in one task. In a session, `look adapt` or `look layout and type` without the slash runs the same, on the page the last `/look` looked at (uses a model; [BROWSER.md](BROWSER.md#look-review-and-polish-a-page)) |
| `/services` | Dev servers the project declares ([SERVICES.md](SERVICES.md)) |
| `/preview` | Your web app on a phone on the same Wi-Fi; a public link only after a yes ([SERVICES.md](SERVICES.md#preview-on-your-phone)) |
| `/tasks [stop <n>\|all]` | What runs in the background; stop one |
| `/pages [open\|remove <name>]` | Pages the AI made for this project, with their links ([Pages the AI makes](#pages-the-ai-makes)) |
| `/pane [on\|off]` | The steps split beside Casper inside tmux or iTerm2 (only on a window 120+ columns wide); saved for every session. See [TMUX.md](TMUX.md) |
| `/debug` | The local debugger ([DEBUGGER.md](DEBUGGER.md)) |
| `/branch`, `/branch <name>`, `/switch <name>` | Named conversations, each with its own workspace: list them, make one, switch ([SESSIONS.md](SESSIONS.md)) |
| `/memory` | Project facts you saved, and task outcomes ([MEMORY.md](MEMORY.md)) |
| `/references` | Search local reference sources; download a vendor spec repo ([REFERENCES.md](REFERENCES.md)) |
| `/secrets` | What Casper hides from the AI ([SECRETS.md](SECRETS.md)) |
| `/visualize [repo [dir]]` | Diagrams ([VISUALIZATION.md](VISUALIZATION.md)) |
| `/delegate <explorer\|reviewer> <goal>` | A read-only helper AI on one goal (uses a model; [DELEGATION.md](DELEGATION.md)) |
| `/crew <job>` | A builder AI does the job in its own copy of the project, then 1 Keep the copy · 2 Apply to my folder · 3 Throw it away; bare `/crew` lists copies still here ([CREWS.md](CREWS.md)) |
| `/exit`, `/quit` | Exit; during a task it stops the task first, as Ctrl+C twice does |
| `/<name> [words]` | Your own command: `~/.casper/commands/<name>.md` sent as a request with your words in it (see [Your own commands](#your-own-commands)) |

An unknown `/` command is rejected on your machine, at once, also during work, where the error shows under your
line. It is quoted as you typed it. It is never sent to a model. Only a name that is one of your own commands goes
to the model, as that command's text. A line that starts with a picture file's path is a
request, not a command (see Pictures below).

Taking something back is `forget` everywhere (`/memory`, `/mcp`, `/sandbox`, `/allowed`, `/permissions`); `remove` is the same word, and `/pack forget` is `/pack remove`. `list` is the command alone (`/memory list` is `/memory`). A usage error reads `[error] Usage: …` for every command.

### Your own commands

A Markdown file in `~/.casper/commands` is a slash command named after the file: `hello.md` is `/hello`. Typing `/hello world` sends the file's text as your request, with the words
after the name put in where the file says: `$1`, `$2` for one word each, `$ARGUMENTS` (or `$@`) for all of them,
`${1:-default}` for a word you may leave out. Quotes keep words together (`/hello "big world"`). Optional
frontmatter gives the menu its words:

```markdown
---
description: Say hello to someone
argument-hint: <name>
---
Say hello to $1, warmly.
```

Your commands are in the `/` menu with Casper's and in a "Your commands" group at the end of `/help`. Casper's own
commands always win a name: a `help.md` never takes over `/help`, and `/help` lists it as hidden and says to rename
it. Pi's prompt templates in `~/.casper/agent/prompts` work the same way (a name in `~/.casper/commands` wins). A
repository's own folders (`.pi/prompts`, `.casper/commands`) are not read: a cloned repository is never trusted to
put words in your mouth. During a task, a line with your command keeps its draft until the task ends. A read-only
helper (`/delegate`) gets its goal as written, never expanded.

### Words you can use

Type one at the start of a request, then `:`, `,` or a new line (`think hard: why does the cache
miss`). It applies to that task only, is not sent to the model, and Casper says what it did in one
line, and again when it goes back. Several can lead (`big model, think hard: …`).

| Words | For this task |
| --- | --- |
| `think hard` | The model's top effort (`[effort] xhigh for this task (you asked)`) |
| `quick` | Low effort |
| `big model`, `use the big model` | Your big model, the `reason` role (`[model] big model for this task: <provider/id> (you asked)`) |
| `fast model`, `use the fast model` | Your `fast` role |
| `plan first` | Plan first, like `/plan` |
| `ultrathink` (anywhere in your line) | The model's top effort |
| `? <question>` (start of a line) | A side question: a separate answer that is not added to the conversation (see [Input and commands](#input-and-commands)) |
| `!<command>`, `let me run <command>`, `I'll run <command>` (the whole line) | Runs it yourself, now, in Casper's terminal (see below) |

Only what you type counts: text you paste (and files, tool output and the AI's own words) is never
read as a word. A role you have not set up gets one line on how to set it (`/model role reason
<provider/id>`), and the task runs as normal. Automatic effort does not change a word's effort.
Words never grant permission: approvals still ask as always.

**Commands that need you.** A line you type as `!sudo apt update`, or `let me run sudo apt update` (a program's name
after the words), runs at once with no box: one line says it has the terminal, Casper's screen pauses, the command has
your keyboard and screen, and Casper comes back when it exits (`[run] … exited with code 0`). The AI reads its exit
code and last lines with your next request. A paste never counts. The AI's own commands that need you (an editor, a
login, `docker exec -it`, a y/n prompt, `ssh -t`) get the terminal the same way, right after their usual box and with no
other question: `[terminal] vim notes.txt has the terminal now; Casper comes back when it exits.` Ctrl+C goes to the
command, not to the task. When sudo on this computer asks for a password, Casper's numbered question and its hidden box
`Enter sudo password` come instead ([decision 48](adr/0002/48-sudo-box-and-terminal-hand-over.md)).

## Current interface

Run `casper` in your project. **Since v0.2.36:** `casper "your request"`
starts the same persistent session with that first request when stdin and stdout are both TTYs
(terminals), no forcing flags are given and `CI` is unset. It stays open for follow-ups.
Use `casper -p "your request"` (or `--print`) to run once and exit; use `-p` explicitly in scripts.
Either stream being non-TTY, `--json`, a lone `-` prompt, `--require-verification`, `--max-turns`,
or `CI` set still forces one-shot mode. Receipts and exit codes are unchanged.

The interactive terminal uses Pi's main-screen renderer/editor: ordinary scrollback above an anchored multiline prompt and a
persistent footer, with no alternate-screen takeover. Casper owns the terminal
before it prints the startup banner, so the banner, model status and diagnostics
are transcript lines like everything else. A model is not started just to paint
the footer. A saved default is shown as an advisory startup snapshot; after
runtime initialization the footer uses the active conversation's model. Before any
sign-in, the banner and footer say `not signed in · type a request to sign in`, and `/model`
opens the model picker with `+ Add server`, even when no models are listed: adding a keyless server
needs no sign-in. A request opens sign-in, or the picker when you already added model servers. Where sign-in can't open (a plain or piped terminal,
a one-shot run) they say `not signed in · run casper in a terminal and type /login` instead.

Casper opens the folder you started it in. A project, or a folder inside a git repository, opens
with no question. Your home folder or a drive root (`C:\`, `/`) opens exactly there too, with no question: one line
names the project you last had conversations in (the ones `/resume` keeps) as a `casper <folder>` command,
or gives an example, and a second line says `casper new` starts a new project. Temporary, cache,
`node_modules`, benchmark and `scratchpad` folders are never named. Windows shows real paths
(`C:\Users\alex\Projects`) where macOS and Linux show `~/Projects`. Any other folder opens exactly there,
even one that only holds projects (such as `~/Projects`); when it holds two or more, one line
names them (up to four) and the command to open one, such as `casper aibot`.

A lone command-line word that isn't a folder, from home or a drive root
(`casper myapp`, for example), asks whether you meant a request or a new project of that name.
A new project is not created without your choice. Existing folders still open directly; elsewhere,
or with two or more words, there is no such question. Explicit one-shot runs never ask it.

An empty folder opens the same way, quietly: no question and no kind menu. A first request that fits a
template (a NOC dashboard, an MCP server) builds it there after one `[new]` line; any other request goes to
the model. `/settings` has a **Starter templates** switch ([NEW.md](NEW.md)).

On a rich terminal at least 58 columns wide the transcript opens with the
wordmark — the Casper ghost (bold white) beside a block-letter `CASPER` (accent)
— followed by the `version` / `project` / `/help` lines. Narrower terminals,
`TERM=dumb`, one-shot prompts and redirected output print the one-line
`CASPER <version> · your coding companion` header instead; on a rich terminal the
choice follows the current width, so narrowing the window below 58 columns swaps the
art for that header rather than wrapping it. `NO_COLOR` keeps the
art and drops the color. The wordmark is constant text written past the untrusted
line classifier (`InteractiveTerminal.writeTrusted`), which is never used for
model or tool output.

The transcript is grouped into blocks with exactly one blank row between them, never two: your
request (`❯ …`, bold, on the theme's `userBg` bar across the row), each of the AI's messages (`●` in the
accent colour, its prose hanging two columns in), a group of steps, a crew note, a box, a
receipt. Plain lines (`[model]`, `[approval]`, `[task]` and similar bracketed notices, a closed box's record)
pack together. Steps, tool/edit boxes and crew notes share a two-column left edge, including wrapped crew notes.
Each mark at the start of a line means one thing, in one colour (the `default` theme's):

| Mark | Colour | Means |
| --- | --- | --- |
| spinner, `•` | accent spinner, dim `•` line | running now (a step, Casper's own checks, the prompt while Casper works) |
| `✓` | green | done |
| `–` | grey (dim) | a note: expected (a search that found nothing), skipped, not verified, not checked, recovered (a retry) |
| `◆` | accent, bold | a change that stays in view: config, a device, another machine or the setup on this computer |
| `○` | amber | did not run (refused, stopped at the spend limit) |
| `✗` | amber | a step failed, and the AI is still working |
| `▌ ✗` | red | the task's result failed (the receipt), or an error stopped work (`[error]`) |
| `⚠` | amber | a warning to act on (a secret appeared in a command) |

Red is kept for those two and for removed lines in a diff: a failed step, its box and Casper's own check lines
are amber while the work goes on, and the receipt's edge, its `✗` lines (in `--verbose` and `/receipt` too) and
`[error]` lines are red. Amber also marks a decision (`── Approval ──`), cyan the accent (banner, `●`, Markdown
structure), dim the muted status lines. `└` hangs a
row under the AI's words. A closed box leaves one line, `<question> → <answer>`, with no mark.
A task's receipt is a card: the verdict on line 1 (`✓` green, `⚠` amber, `✗` red only for a failed result) and
labelled rows under an edge of the same colour ([receipts](VERIFICATION.md#receipts)).
Those are the `default` theme's colours; `theme: light` or `high-contrast` (or **Theme** in
`/settings`) swaps the colours of each role (`src/tui/theme.ts`) and nothing else
([CONFIGURATION.md](CONFIGURATION.md#theme)).
A fenced block in an assistant message copies clean: a title line with its language
(`── ts ────`), then the code exactly as written with no side border and no indent (a top-level block
stays at the left edge, full width, while the prose around it hangs under `●`), then a
closing rule. A line wider than the window is cut at the edge only (no character added or
dropped), so a mouse copy of switch config picks up no `│` characters.
Bordered panels (`src/tui/presentation.ts`) are kept for what matters: the edits a group of steps made
(`Edited 3 files`, each file with `+N -M` and at most twelve diff lines per file, then
`… N more lines · Ctrl+T shows all`), a failed step (amber, titled with its line, `✗ bash · git push — failed`,
with the failing lines and test counts preferred over passing tails, secrets hidden and your home folder as `~`), `/output`
replaying a tool result, `/diff` boxing `git status` and the colored unified diff, a failed check boxing the
failure diagnostics from stderr and stdout in amber (the full output stays in the evidence), and exclusive input
flows such as `/login`. Prose, notices and routine steps stay inline. Panels cap at 120 columns (plans at 80)
and re-lay out when resized; prompt rules and the footer still use the window width.
Changes stay in view, marked `◆`, at every `/details` level and never folded into the `└ … ran …` row. A config file the
AI edits (package.json, tsconfig, `.env` files, YAML, TOML, INI, `.conf`/`.cfg`, Dockerfiles and compose files, CI
workflows, `.casper/project.yaml`, Ansible inventories and variables, Junos `.set` files; the same list the receipt uses)
gets a box of its own, `◆ Changed config`, with up to 40 diff rows per file and then `… N more lines · Ctrl+T shows all`,
secrets hidden as in the edit box; a lockfile is one row, `◆ lockfile updated (bun.lock)`. A shell command that changed
another machine or a device shows a row as soon as it ends, `◆ Changed on build-server: installed a service (…)` or
`◆ Changed on sw1: sent 3 config lines`, with the commands it sent in a box (secrets hidden): the receipt's
remote-change rules, or device lines that enter config mode, commit or delete. Plain server reads sent over ssh
(`hostname`, `uname -a`, `uptime`, `df -h`, `docker ps`, `ip a`, `systemctl status` and the like, with `2>&1` or
`2>/dev/null`, or piped into `head`, `tail`, `grep`, `wc` or `sort`) are no config lines and show no row. Each change Casper sends to an MCP server,
also after `Yes to everything`, is a row with what was sent, masked as in its box: `◆ Changed in mist: update_site_setting
site-1`. Setup on this computer gets named rows when the command worked: `◆ installed left-pad`,
`◆ committed "fix port" (a1b2c3d)`, `◆ pushed main to origin`, `◆ switched to fix-port`, `◆ deleted 3 files: a, b, c`.
At `/details quiet` they are rows without their boxes. The old Windows console draws `◆` as `#`.
A missing guessed path, an empty search, a search pattern that didn't parse (`– grep · foo( — pattern not valid`; the AI
still gets the error and rewrites it), a designed refusal or skip, and a confirmed recovered timeout,
service hiccup, merge conflict or test-first failure are dim `–` notes, not failure boxes. A failure that was not
recovered keeps its `✗`, its amber box and Ctrl+T.
A shell command whose exit 1 is its answer is a note too, when the line runs only that kind of program (after a
`cd DIR &&`): a search that found nothing (`grep`, `rg`, `git grep`, `ag`, `ack`, `findstr`: `nothing found`), `diff` or
`cmp` (`files differ`), `git diff --quiet` or `--exit-code` (`changes found`), `test`, `[` or `[[` (`false`), `which`,
`command -v`, `type` or `where` (`not installed`) and `pgrep` (`no process found`). Exit 2 or more, an error it printed
(No such file, Permission denied, an invalid option) and a line that mixes in other programs stay failures. The AI
still gets the exit code; Ctrl+T shows it.
Test statuses name the failing count when known; running checks use human labels such as `Running tests (11 files)`. Color always accompanies a readable label; tool completion
does not mean a check passed. `NO_COLOR` keeps the structure without color, while
redirected output and `TERM=dumb` use plain text.

Assistant text streams through Pi's Markdown renderer, including code and tables.
The in-progress message is shown as the transcript's uncommitted tail. Completed
blocks are reused; only the open tail is re-parsed, and the result matches a full
render (lists, fences and wrapped emphasis stay correct across chunk boundaries).
When the message ends, its rendered lines are committed once. The source Markdown
is kept per message so a width change re-renders it rather than re-wrapping old output. Text still passes
`terminalText()` before rendering, which also drops the emoji presentation selector
(U+FE0F) after text-default symbols such as ⚠️ or ✔️: terminals disagree on that pair's
width (iTerm2 draws one cell, Pi's layout counts two), which pushed box borders and table
columns out of line, so these symbols show in text style, one cell wide. Links show their destination as inert text —
the URL in parentheses instead of an OSC 8 hyperlink. Login URLs and device codes
stay on standalone lines so frames do not become part of a copied value. Captured
tool errors and verifier stdout/stderr remain available with display-only
redaction; this is not a general secret detector, and recorded evidence is unchanged.

Tool activity shows file/command targets (grep/find show their pattern, web_fetch its address,
web_search its query) and state; paths show relative to the project (`~` for home outside it), and
the time shows only from one second up. A shell command shows as a short label, its program and what it
acts on (`git status`, `ssh root@10.0.0.5 …`, `python3 -m pytest …`, at most 80 characters), without a wrapper
such as `sudo -u root` or `env -i` before it; a script of
several commands names its programs and leaves out `cd`, `export`, `echo` headings, loop words and comments
(`git rev-parse, git log, git diff`), and a heredoc script says its program and length (`python3 script (12 lines)`).
`/output` shows the whole command, secrets hidden. The `✓` or `✗` says how a call ended, so there
is no "completed". The AI may give a shell step a title (the shell tool's optional `description`, at most 8 words; one
line, secrets hidden, at most 80 characters). The row then shows the title with the real program,
`✓ Run the unit tests · bun test`, and the folded row names the step by its title, said done:
`└ Checked the port config · Ran the unit tests (12s)` (a title that starts with an uncommon verb is kept as written).
A title never shows alone, and approval boxes, permission checks, receipts, `/output` and `--json` use the real
command only; a step with no title keeps its usual label. The title costs every request about 30 tokens
([decision 25](adr/0002/25-visibility-over-a-smaller-prompt.md)).

On a rich terminal the steps show where they happen: under the AI's words, in plain words updated in
place. Searches, reads and folder listings share one line that counts them,
`⠋ Looking through the code: 14 searches, 9 files read, 3 found nothing (2m)` (`✓ Looked through …` once done;
the time shows from 10 s); the group's edits share one line, `✓ Edited roadmap.html, faq.html`; each command gets a
short line, `✓ Ran the tests` for the project's test command (and the linter, the type check, the build), else
`✓ Ran git status`; a failure reads `✗ The tests failed` or `✗ Couldn't edit a.py`. Alt+O shows the raw steps
instead: every call on its own row (`⠋ read · src/x.ts` while it runs, the spinner
standing for `•`; `✓ read · src/x.ts` once done), even with calls running side by side; Alt+O again goes back to
plain words. A small crew panel above the prompt lists each live builder, reviewer and explorer with what
it is doing now (`⠋ Explorer 1 · read · cad/otto.js · 12s · 3.1k tokens`), working time and tokens (four rows,
then `+N more`). Crew details (Ctrl+O) list every helper with its last five steps under it
(`    ✓ grep · stale · cad`, `•` while a step runs, `✗` when it failed); ↑↓ scroll and Ctrl+O or Esc closes. Completed rows fade after 1.2 seconds and disappear
at six seconds. A helper waiting for approval pauses its own clock and shows `waited` separately;
other helpers keep working. Plain terminals retain the existing `[crew]` lines.
Ctrl+O does the same when no helper rows are shown; while helpers run or their completed rows remain,
it opens or closes crew details instead. Applied builder changes and failures to apply stay in the transcript;
a failure names the reason and says to use `/crew` to find the retained copy. The steps pane in tmux or iTerm2 always logs the raw steps. A step still running after 10 s adds its elapsed time (`bash · python -m pytest · 4m12s`), and a running command shows its latest output line dimly under it (not at `/details quiet`; plain terminals and `--json` get nothing extra). When the model's
next words arrive, or its turn ends, the finished steps fold under its words: one muted row naming what
was done, `└ read AGENTS.md, CONTEXT.md · ran git status, bun test (2m05s)` (a command that ran 10 s or more says how long),
then the group's edits in one box with a short diff and each failure in a box with what it printed.
A row that does not fit names file names instead of paths, then gives each kind of step a row of its own
(`read 13 files: a.ts, b.ts +11 more`), so it names what was done rather than only counting it. Steps with no
words between them stay one group: a turn of only tool calls, blank space before the words, or words held for
the plan screen does not fold them. A group with no words above it gets a `●` row of its own. Edits with no diff
to show (a new file written whole) are named in the row (`edited new.py`). A failed edit the model tried again
at once is shown nowhere. Ctrl+T shows the last box in full (the group's whole diff, or everything the failed
step printed), or else the last step. `/output all` lists every call of the last task on its own line. A command Casper refused before it ran (a private place such as `~/.ssh`, another machine
you said No to, or one a script run can't ask about) is not a failure: it reads
`○ bash · cat ~/.ssh/config — not run`, with the reason said to you on the next line, and is not
counted as failed. A skipped check keeps its `○ … — skipped` line.

One status row sits above the prompt while work runs: the spinner, what Casper is doing or waiting for,
and `Esc stops`. It reads `Waiting for <provider/model> · 0s` as soon as a request is
sent, and ticks elapsed time even when the provider sends nothing back yet or no intermediate progress events; progress updates change it to reasoning
or tool preparation (`Reasoning · 3.0k chars · 12s`, `Preparing write · 1.2k chars · 3s`); when the provider sends readable reasoning, the row shows a short headline of it instead, its summary's title or latest sentence (`Planning the port fix · 12s`, at most 60 characters, secrets hidden; not at `/details quiet`; **Reasoning headline** in `/settings` turns it off). When nothing has arrived for 10 s it reads `Waiting for <provider/model> · 14s`. While a step runs it names the newest one (`Running bun test · 4s (+1 more)`, `Reading src/x.ts · 1s`); while Casper's own check runs, `Checking test · 1m10s`. When the AI wrote a line before the running group of tool calls, the row starts with it: `Fixing the port test · Running bun test · 4s · Esc stops` (the line's last sentence, secrets hidden, gone when the group folds). A narrow window drops that line first, then cuts the words, never `Esc stops`. A provider retry is one dim `–` line in the transcript, `– Can't reach <provider> · trying again in 4s (1 of 3) · Esc stops`, not repeated in the status row; it names the cause: `<provider> is busy` for a rate limit, `<provider>'s host for this model failed` when one of OpenRouter's hosts fails, `<provider> answered with an error` for another error. A check Casper runs itself (typecheck, lint, test and the rest) adds a live row `• test · 3m05s` after 10 s with the last line it printed dimly under it (not at `/details quiet`); a plain terminal prints `[checks] test still running · 3m` once a minute for a long check, and `--json` prints nothing extra. It never displays the reasoning itself or generated arguments (the headline is the status row's alone: never the transcript, the steps pane, the receipt, an export or `--json`; [decision 24](adr/0002/24-reasoning-headline.md)); the live rows and the status row step aside while a question or picker waits for you, never show more rows than fit above the prompt, and are gone when
the receipt or the prompt returns. The plain terminal and scripts print one end line per tool call;
having no live rows, they also print `• bash · bun test` when a call other than a look or an edit is still running after two seconds,
so a long test run does not look hung.

Help and results group related facts instead of one long paragraph. Assistant
instructions ask for one short line before each group of tool calls (what the AI will do and why) and one line after
it changes config, a device or another machine; the final answer favors the answer or action first, numbered human
steps when needed, and one concrete next action when work remains. Unknown checks, estimates and
remaining uncertainty stay explicit. This is guidance to the model; a provider's replies may not follow it
([decision 25](adr/0002/25-visibility-over-a-smaller-prompt.md)).

The prompt box keeps a fixed two-column gutter: `❯` while idle (also for the first command-line request), a dim `type to queue a message` on an empty working prompt (a draft keeps its gutter), `?` while an exclusive line input waits for you. An open choice box replaces the prompt entirely:
there is no empty `?` input row. Typed answers appear inline in the Other row once it is picked; an approval's note appears in its No row. An open question's
top rule names who asks, in the box's colour: `── Approval ──` (amber) for Casper's approvals,
`── Question ──` for the AI's questions and `── Choose ──` for Casper's own pickers. The box never shifts
horizontally between states, so a draft keeps its wrapping. The footer shows a
state on the left: spinner plus `working 1m05s`, `? waiting for you` during a question or picker (no spinner or timer), or `idle`. On the right: folder/branch (the name only once when they match), `provider/model · effort`, the context (`ctx ━━━━━━──── 20.6k / 32k · 63%~`: a ten-cell bar, the tokens in the model's window out of its size, and the estimated share; `ctx — / 32k` until the next answer after a compaction) the task figure, its tokens and cost: `task 48.2k tok · $0.31`, `task 48.2k tok · sub ≈$0.31` (API-equivalent, not a subscription charge), or `task 48.2k tok` for a free model; and from the second task on, the session's running total (`session 180k tok · $1.40`, tokens only when no cost was counted), which never goes down when a task starts or stops ([decision 34](adr/0002/34-session-total-in-the-footer.md)). Groups use ` │ `; items within a group use ` · `. The bar's filled cells are the accent colour, the warning colour from 80%, and the rest of the right side stays muted (`tests/footer-context-bar.test.ts`); the old Windows console draws them as `=`. Narrow windows drop the bar first, then cut a long model name in the middle (to no less than 24 columns, keeping its start, tag and effort: `ollama/hf.co/mra…F:Q3_K_M · high`) when that keeps everything else; otherwise they drop the session total, then the task figure, then context, then model, never wrapping. `asking off` stays in warning colour beside the state, with `/permissions ask` only on first display. `/status` and `/usage` have the session totals in full; /usage splits tokens into out, new and cached. Update notices have their own
single, right-aligned row just above the prompt, idle or working, in the success colour. After an update is
installed (including one installed by `casper update` or `/doctor`) it reads `✔ Update installed · restart to use it`.
A narrow window shortens that to `✔ restart to update`, then hides it rather than cutting or wrapping it.
Other update notices keep their text, dropping the detail after `·` when needed; they never become restart
advice. `NO_COLOR` keeps the words and alignment without colour. The row yields to questions, pickers and
screens too short to keep the prompt, live steps and footer visible; it never takes room from the footer's
folder, model or state. Without an install it says `Casper 0.3.10 is out · casper update` (or
`Casper update ready · casper update` for a checkout). A checkout Casper didn't fast-forward by itself says why in
a few words, such as `Casper update ready · checkout has uncommitted changes · casper update`;
a narrow window keeps `Casper update ready`. A quiet failure says `update failed · casper update`.
Plain terminals print one `[update] …` line instead, once per session. **Updates: off** in `/settings`
(`updates: off`, also legacy `updates: false`) hides the row
([Configuration](CONFIGURATION.md)). The footer uses one plain phase word, `working`, not the internal checklist/build/check/repair rail. Working time excludes questions and pickers. When the AI reads, lists or searches a folder outside the project (temp aside), one line under its
steps says where, once per folder: `[read] outside this project: ~/Projects`. With no sandbox, a plain shell read in your own folders (`cat ~/Documents/notes.txt`) runs without the box and leaves `[read] outside this project, no box (a plain read in your own folders): cat ~/Documents/notes.txt` ([decision 46](adr/0002/46-home-reads.md)). Tool lines print paths relative to the project and fit one row:
narrow, the words go and a path is shortened from the front (`✓ edit · …st_calc.py · +9 -1 · 2.5s`). Each check Casper runs prints one line
as it finishes (`✓ typecheck · 5.9s`, `✗ test · exit 1 · 2.3s`, `✗ test · timed out after 10m`; a check
under a second shows no time; every time on screen reads the same way: `0.4s` and `5.9s` under ten seconds, then
`14s`, `1m05s`, `10m`, `1h02m`), so a
pass is never silent; `--verbose` prints the full evidence line instead. When a request that ran for 10 seconds or
more finishes, or asks you something (a question, an approval, the checklist), Casper rings the
terminal bell; your terminal decides whether that is a sound, a flash or a dock bounce. iTerm2, WezTerm,
Ghostty and kitty also show a desktop notification (OSC 9), and foot too (OSC 777), saying what happened:
`Casper finished the task` or `Casper has a question for you`; inside tmux it goes through to the outer
terminal (foot only outside tmux). Casper asks the terminal to say when it comes to the front or goes behind (focus reports), and
rings only while it is behind, as Codex CLI does: a terminal that never says rings as before.
**Notifications** in `/settings` (`notifications: off`) turns the bell and the notification off. Scripts,
one-shot runs and `--json` never ring. `—` means unavailable, `~`
means estimated. Branch is the project inspection snapshot; `/status` refreshes
it after external Git changes. Narrow terminals truncate the footer rather than
wrapping over input. Cost is not an invoice or subscription charge.
No green permission/verification badge is invented. `/plan <request>` plans one request; `/plan on` plans
every request until `/plan off`, and the footer badge says `PLAN · /plan off` while it is on.

### Suggested next steps and plan first

After an interactive receipt, the row under it starts suggestions at 1 when there is no diff or
undo: `Next: 1 Add a test that proves this bug stays fixed (uses tokens)`. Under a receipt card the row joins the
card's Next row, on its edge, without the `Next:` word. On the rich terminal each number is a key cap, so the row
reads as something to press: a bold, reversed ` 1 ` in the theme's selection colour, the steps spaced apart, then a
grey `· press a number` (`[1] Show diff   [2] Undo   · press a number` with `NO_COLOR`); the plain terminal keeps
`Next: 1 Show diff · 2 Undo` as written ([`tests/next-keycaps-ansi.test.ts`](../tests/next-keycaps-ansi.test.ts)). With diff or undo offered,
1 stays Show diff, 2 stays Undo, and other steps start at 3. Each step's reason is on its own line as `Why 3: …`
(`Why: …` in a row of one step), never a bare `3:` that would read as a second choice; the key caps are on the
step's row only. A step that saves something shows the exact text it will write
(`saves verify.test: uv run pytest in .casper/project.yaml`). Nothing waits: a lone number on the empty
prompt picks the step, and anything else you type is simply your next request. Casper's rules are local
and free; only a step marked "uses tokens" asks the model anything. No row comes after a task that ends asking you
something or paused after saying what it does next: its numbers could pass for the options the AI just offered
([When a task is not done yet](VERIFICATION.md#when-a-task-is-not-done-yet)).

After a `/look` report that names fixes for its issues, the row is `Next: 1 Fix all of it (uses tokens)`, also under a
plain answer with no receipt: `1` runs `/look fix`, everything it found in one task. It waits until the report's
questions are answered, also when they close the answer as a numbered list
([BROWSER.md](BROWSER.md#look-review-and-polish-a-page)).

Two steps ship: "Add a test that proves this bug stays fixed" (a fix whose tests pass without it too)
and "Remember <command> as this project's test command" (the model ran a known test runner, such as
`uv run pytest`, `python -m pytest` or `bun test` with plain test paths, while the project had no test
command; any other command is never offered). A step you leave three times in a row in a project is
hidden there for 14 days; picking it resets that. `/suggestions` lists each step as on, off or faded;
`/suggestions off [name]` and `/suggestions on [name]` switch them; `suggestions: false` in
`~/.casper/config.yaml` turns them all off. One-shot runs and `--json` never show them.

Before work nothing waits: a build request with several asks is built at once, with one line first:
`– Big job (this asks for 4 things): /plan first next time to see the steps before any change`. The
line is the `plan-first` suggestion, so it fades the same way and `/suggestions off plan-first` or
Suggestions off in `/settings` leaves it out. A request that already lists its requirements (two or
more list lines, most with a detail such as a command, number, file or example) gets no line, and the asks
in a pasted terminal transcript don't count.
`/plan <request>` (or `plan first:` at the start of a request) runs a
plan turn: the model may only read (read, grep, find, ls and look-only shell commands such as `ls`,
`cat` or `git log`); every other tool, MCP and Casper's own tools included, is refused with "Planning
only" and shown as `— not run`, not as a failed step (the receipt does not count it). A refused shell command
names its first part that is not a look command (`npm is not one.`). This is Casper's gate, not a
sandbox, and a file that changed anyway is named on the receipt (`– Changed while planning: …`). Planning is optional, not a mode or a new gate on ordinary build requests.

**One optional question round.** A clear request goes directly to a plan. Only when choices change the build
may the initial answer ask at most 3 questions in one round. Each has 2-4 options with a label and a
description; Casper uses the normal picker, including **Type your own**. The host parses the initial answer as
JSON in this shape (not a tool call):

```json
{"questions":[{"question":"Where should tasks be kept?","options":[{"label":"This device","description":"Local storage, no sign-in"},{"label":"Shared","description":"Accounts and a shared database"}]}]}
```

The next prompt contains the answers and must return a plan without more questions. Remaining unknowns go
under Open questions, not into another interview. A plain-word change request also rewrites the plan directly.

**A plan or a first-version spec.** For an existing project the sections are Title, Goal, What I found,
What you'll see, numbered Steps, Done means, and Open questions only for genuine unknowns. Details is optional.
What you'll see puts prose above a small dim box containing the mock-up (at most 60 columns and 12 lines).
Bullets hang under their text when wrapped. Each numbered step shows its main file, when known, dimmed and
right-aligned; narrow terminals wrap the file below rather than cut it. Frame edges use the theme's accent;
paths and mock-up boxes stay explicitly faint even with the high-contrast theme (not with `NO_COLOR`).
Open questions contains only questions;
statements move to What I found, and no questions means no section.
Done means lists concrete acceptance criteria including checks, not just a promise to test.

For a new/empty folder or a request to make an app, site or game, the spec uses Goal, Screens, Data, Look
(a named style), First version, Later and Done means, with a short Title. No implementation Steps are forced
into a spec. Later stays out of the build; unknowns and optional Details can still be included.

The plan is written for you, not for the code, and shown once by Casper (the model's answer is not streamed
as well). For example, an existing-project plan on a rich terminal looks like this:

```text
╭─ Plan · A cleaner, animated header ──────────────────────────────────────────╮
│                                                                              │
│  Goal                                                                        │
│    Make the name easy to read.                                               │
│                                                                              │
│  What I found                                                                │
│    - One function draws the header.                                          │
│                                                                              │
│  What you'll see                                                             │
│    Accent colour, brief fade-in:                                             │
│    ┌────────────────┐                                                        │
│    │ CASPER · ready │                                                        │
│    └────────────────┘                                                        │
│                                                                              │
│  Steps                                                                       │
│    1. Restyle the header.  src/tui/banner.ts                                 │
│    2. Add a brief fade-in.  src/tui/banner.ts                                │
│                                                                              │
│  Done means                                                                  │
│    1. Plain output stays readable.                                           │
│    2. Fade respects reduced motion.                                          │
│    3. Header checks pass.                                                    │
│                                                                              │
╰─────────────────────────────────────────────── Ctrl+T details · Ctrl+G edit ─╯
```

On a rich terminal the plan has an accent frame as wide as the window, with
paths dimmed. A step that fits on one line has its file at the right; a longer step keeps the full width and its
file goes on the line under it. A link shows its text and bold loses its `**`. Plain terminals and `NO_COLOR` show the same sections, unframed and without colour:

```text
Casper plan · A cleaner, animated header

Goal
  Make the name easy to read.

What I found
  - One function draws the header.

What you'll see
  Accent colour, brief fade-in:
  ┌────────────────┐
  │ CASPER · ready │
  └────────────────┘

Steps
  1. Restyle the header.  src/tui/banner.ts
  2. Add a brief fade-in.  src/tui/banner.ts

Done means
  1. Plain output stays readable.
  2. Fade respects reduced motion.
  3. Header checks pass.

Ctrl+T details · Ctrl+G edit
```

Both have one blank row between sections and none inside a section. Long lines wrap; nothing is cut.
Ctrl+T shows optional Details. Ctrl+G opens the saved Markdown using `VISUAL`, falling back to `EDITOR`;
on return Casper rereads it and shows the plan again. This is separate from choice 3, which stays plain words.
Both terminals ask "Build this plan?": `1 Stop · 2 Build · 3 Change the plan`. Enter chooses Stop, never Build.
A plan with an open question puts it second, `2 Answer the question` with the question beside it: it opens one
line for the answer (Esc goes back to the plan), and the model rewrites the plan with it. Build and Change the
plan move to 3 and 4. A plan with several open questions offers `2 Answer the questions`: each is asked in turn
(`Question 2 of 3`; an empty answer leaves that one open, Esc goes back to the plan with nothing sent), and the
model rewrites the plan once with every answer, not once per question.

Choice 3 opens one empty line: type what to change in plain words, such as "drop steps 1 and 4" or "also test X".
A line ending in `?` ("why step 3?") is a question: the model answers it in words under the same planning gate,
the plan stays as it is, and the same choices come back. While planning, besides look commands and web lookups,
the AI may read GitHub (pull requests, one pull request, CI; not a rerun), make MCP calls Casper labels as reads
(a call that would ask, such as a change, waits for Build) and send read-only explorer and reviewer helpers to
research; builders wait for Build.
The model rewrites the whole plan under the same planning gate and shows it again with the same choices. A plan
longer than the screen is not printed again: Casper shows what changed, section by section (`+` a line added,
`-` one removed; a step that only moved number is not a change), and where the whole plan is
(`Plan rewritten: 2 lines added, 1 removed · the whole plan: .casper/plans/….md`, which Ctrl+G opens). You
can ask for another change; only an explicit Build starts work. Empty Enter returns to the choices without
calling the model; Esc stops without building. Choice 3 is not a raw multi-line plan editor. On the plain
terminal, `4 Show the details` is offered when there are details; it lists them and asks again. A run that
cannot ask lists everything and stops.

Casper saves Markdown in `.casper/plans/date-slug.md`, gitignored. This host-owned save does not let the
model write during planning. Because the save leaves `.casper` behind, a folder that held nothing else is no
longer empty, and `git clone <url> .` refuses it. While a folder holds only Casper's own entries, each request
tells the model to fetch a repository in place instead (`git init`, `git remote add`, `git fetch`,
`git checkout -t`) rather than clone it into a subfolder. `/plan` alone lists recent saved plans; selecting one reopens it for the same
Stop/Build/Change choices, not an automatic build.

Build gives the model the whole revised plan, including its Details and Done means checklist. While working,
the status names the current step, for example `Step 2 of 4 · Draw the header`. After the build the screen says
the plan in one line, with the reason the model gave for a step it stopped on, so a question it is waiting on
stays near the bottom: `– Plan: 0 of 7 steps done (model report) — Waiting for the repository path; /receipt lists
them`. `/receipt` reports each item from Steps (or First version in a spec): completed items as done, not-done
items with reasons, labelled **model report**. This is not check proof: recorded checks still decide verification
(see [VERIFICATION.md](VERIFICATION.md)).

The planning guidance never asks what the repository answers, never offers a choice that means typing (Type your
own covers that), says first when the work waits on an open PR or branch, and gives small changes few steps.
It skips steps that only re-confirm known facts or an established cause (including reviewer
agents re-checking it); it investigates only a specific unresolved question. Older `Plan:` and `Tests:` answers
still read as before. A spec without numbered steps is a valid plan. If no usable plan comes of an answer,
Casper prints what the model wrote, so nothing it said is lost.

### Layout stability

The `/` command popup, the `/model` browser and the `/effort` picker are composited over the
bottom of the transcript instead of appended below it. Opening and closing them
does not scroll the terminal; covered transcript rows return unchanged.
Login panels instead follow the transcript, keeping standalone authorization URLs
and device codes visible above the current panel. They are transient components,
not transcript entries: navigation replaces rows and completed panels disappear.
A clarification question also follows the transcript, so the model's lead-in
above it stays visible; once answered, the question and its options are recorded
in the transcript.
Pickers and login share the live surface's renderer and footer; login borrows raw
input without starting a second terminal renderer. Finished transcript entries
are rendered once per width and cached; only the open tail line, the unfinished
tail of a streaming assistant message and the live step rows under it re-render per frame. Nothing
committed ever changes: the blank row before a block is decided when it commits, a streaming message
and the same message committed draw the same rows, and the live rows are the transcript's last rows,
capped so that they, the prompt and the footer fit on screen (a row ticking above the screen's top would
make the terminal redraw everything).

Ctrl+L and a width change still repaint from the top, matching Pi's renderer:
both clear the visible screen and the terminal's scrollback and reprint the whole
transcript at the new width. A rows-only resize does not clear: terminals re-fit a
shorter or taller screen differently (xterm.js drops the rows below the cursor, which
are the prompt's lower border and the footer), so `StableMainScreen`
(`src/tui/surface.ts`) takes the last screenful of lines as visible and writes each
of those rows again in place. Scrollback is kept; a terminal that neither kept nor
restored those rows may show a few of them twice in scrollback
(`tests/daily-terminal.test.ts` asserts no `ESC[3J` and a rewrite of every visible
row for a rows change, and a repaint for a columns change; the field access is
pinned to `@earendil-works/pi-tui` 1.4.0).
`tests/fixtures/layout-pty.py` drives the offline demo (steps ticking in, then folding into a row, an edit
box and a failure box) through a bounded 24x80
VT emulator that scrolls, and fails on footer creep, scrollback wipes from
live rows, popups or pickers, or a duplicated prompt box (`bun test tests/terminal-layout.test.ts`;
`SHOW=1 python3 tests/fixtures/layout-pty.py $(which bun)` prints every screen).

### Model and effort

- `/model`: Casper's full-screen model browser. Typing searches the models; each row shows the
  context size, price and `reasoning`/`vision` tags, in the usual order the current model first and your default
  next, and the line under the list sums up the highlighted one. In one provider's list the rows leave out its
  name, which the header says (the line under the list keeps the full id). **Under `openrouter` the left list has
  four more rows**: `free` (only its free models, newest first), `cheapest`, `newest` and `smartest` (by AA score).
  Down onto one shows OpenRouter's models that way, and the header says which (`openrouter · free, newest first
  (20)`). A model with nothing to order by (no price, date or score) goes last, ties keep the usual order, and a row
  shows only when OpenRouter's list has something to order it by. The next `/model` opens on the row you left it on,
  until you quit Casper; words you give `/model` search every model. OpenRouter's rows also show `AA 55`, the Artificial Analysis Intelligence
  Index from OpenRouter's list, named once under the header (higher is smarter; `—` means not rated, never a low
  score), and the line under the list adds the model's coding and agentic indexes, its Design Arena coding rank
  and the day OpenRouter added it. A router such as `openrouter/auto` costs what the model it picks costs, so its
  price reads `varies`, not `free`. A model the engine's catalog lists that OpenRouter's own list doesn't have (a picture maker or a classifier) shows no price and isn't counted as free. Each OpenRouter row also shows 🔒 when at least one host keeps nothing of a
  request (OpenRouter's zero-data-retention list) and ⚠ when every host may keep your prompts; most free models
  are ⚠. The marks only show what the hosts do: Casper doesn't change where a request goes, and OpenRouter may
  still pick a host that keeps prompts. The line under the list names the hosts that keep nothing. A narrow
  terminal drops the score column first, then the tags, then the price; the 🔒/⚠ mark stays. It opens on the providers on the
  left (`All models`, then each provider): Up/Down there picks whose models show, and Enter, Tab or
  Right moves to the list (Tab goes back). Typing searches from either side. `/model <part of a
  name>` opens it already searched, on the list, so Enter picks at once. The left list's last row,
  `+ Add server`, adds a model server on another computer (Ollama, LM Studio, llama.cpp, vLLM): type its
  address, name it, and its models show at once ([Add a model server](CONFIGURATION.md#add-a-model-server-on-another-computer)).
  A server you added shows on the left even when it doesn't answer (`off`, with why on the right; `0`
  when it answered with no models yet); Ctrl+X on its row asks `1 Keep · 2 Forget` and forgets it (while an MCP server
  has writes on, Ctrl+X turns writes off instead; press it again once they are off), and
  what an add or forget said shows at the top of the right side when the picker opens again.
  It looks for your model servers first and then refreshes the provider lists in the background (a server found
  while a refresh runs would cancel it), and keeps the saved rows when that fails,
  saying why in a few words: `Your anthropic sign-in expired. Run /login to sign in again; showing
  saved models.`, or `Could not refresh openrouter (HTTP 503); showing saved models.`, never the
  provider's URL or stack. With an OpenRouter sign-in it also reads OpenRouter's own model list, so a
  model OpenRouter added today is listed before the engine's catalog has it
  ([OpenRouter's model list](CONFIGURATION.md#provider-credentials)). With a ChatGPT or Copilot plan sign-in it reads
  your plan's own list too ([Your plan's own model list](CONFIGURATION.md#provider-credentials)). A provider's header
  says where its list comes from and its date (`openai-codex (8) · your account's list, Oct 29`). When the refresh is
  done the header says `Model catalogs refreshed.` only if no signed-in provider's list is out of date; otherwise it
  names them (`openai-codex list out of date`) with a line each saying why, for example `openai-codex: list from
  Oct 15; pi.dev's is from Oct 29, but this Casper's engine (version 1.4.0) is given the older one. Update Casper.`, or
  `Your github-copilot plan also offers gpt-9, which this Casper can't call yet. Update Casper.`
  **Enter remembers globally** in Casper's settings; **Ctrl+S selects for this session
  only** (from the providers too: it picks the list's marked model). Esc cancels from either side. `/effort` with no level is the same numbered list as every other
  choice: press a level's number (or Up/Down and Enter) to remember it; Ctrl+S picks it for
  this session only.
- `/model failover <provider/id> …`: when a task's model hits a rate or usage limit, or can't run right
  now, the task goes on with the first of these models that is signed in, calls tools and can take the
  conversation (compacted to fit its window first when needed), and one line says so:
  `Switched to provider/model-b because provider/model-a hit its rate limit. Your next request tries provider/model-a again.`
  After a free OpenRouter model the newest free OpenRouter models follow your list; Casper never adds a
  paid model, or moves another model's conversation to a free one, by itself. `/model failover` shows
  the list and `/model failover clear` removes it ([Failover](CONFIGURATION.md#failover)).
- A fresh interactive session clears the viewport at startup: the new session renders from
  the top of the screen and the previous run's transcript stays in scrollback.
- While a prompt runs or tool activity is on screen, the footer spinner, the status row and a running
  step's mark animate (braille spinner) so background work is visibly moving, and the
  footer shows one phase and elapsed time (`⠋ working 1m35s`); idle has no spinner or timer.
- The old Windows console (conhost: no `WT_SESSION`, `TERM_PROGRAM` or `ConEmuANSI`) has no braille,
  rounded corners or most symbols in its fonts, so every mark is drawn in ASCII there, one column each:
  `|/-\` spinner, square corners, `>` for `❯` and `→`, `+` for `✓`, `x` for `✗`, `*` for `•` and `●`, `o` for `○`,
  `-` for `–`, `!` for `⚠`, `|` for `▌`, `└` for `↳`, `~` for `…` (`└` itself draws there). Windows Terminal and other terminals keep the symbols.
- `/model provider/id`: exact selection, remembered globally. During a task it applies from the
  model's next step, like `/effort` (see Input and commands).
- `/model <words>` (`/model opus 5.5`, `/model sonnet 5`, `/model opus`, `/model qwen3`): the
  model the words name among the ones you can pick, with no model call, said in one line
  (`[model] anthropic/claude-opus-5-5 (from "opus 5.5")`). Case, dots, spaces and a leading provider
  do not matter. The words must appear whole and in order in the id; the best match wins: the whole
  id, then an id the words end (`opus 5` is `claude-opus-5`, not `claude-opus-5-5`), then the newest
  version (`opus` is the newest Opus; a size such as `8b` or `2.4t` is no version). A dated copy ranks
  below its undated alias, and the provider you are on comes first. Several equally good (`qwen3` with
  two sizes), words that name several families (`claude`: Opus, Sonnet, Haiku), matches on several
  other providers, or a better match only on another provider while yours has one too, ask which by
  number (more than four open the browser on the words); words never move you to another provider
  by themselves. None says
  `No model matches "opus 9"; closest: …. /model to see all. Model unchanged.` Part of a word
  (`/model secon`) opens the browser already searched. Exact ids, `@role`, `:effort` and `--session`
  work as before, also with words (`/model opus 5.5:high`).
- A typed line that only asks to change the model (`change model to opus 5.5`, `switch to sonnet 5`,
  `use opus`, `set model to <id>`) is done the same way, with no model call, idle or during a task,
  and says so first: `[model] Handled here, no model call: /model opus 5.5 does the same.` It counts
  only when you typed the whole short line (nothing pasted, no file name, path or code in it) and
  its words start the name of a model you can pick; without the word "model" in the line they must
  also be a model family (`opus`, `qwen`, `gpt` …) or carry a version (`sonnet 5`), so `use next`,
  `switch to main` and `use the 70b model` stay requests. Anything else (`change the model class in
  models.py to …`) goes to the AI as before. To ask the AI instead, say it another way.
- A typed line that only asks to save this conversation (`export this session`, `save the chat to my
  desktop`, typos such as `explort` included) runs `/export` the same way, with no model call, idle or
  during a task, and says so first: `[export] Handled here, no model call: /export <file> does the
  same.` It may name the Desktop, Documents or Downloads (on Windows the known folder, so one moved
  to OneDrive; under WSL the Windows one; on Linux the XDG folder), a file name (`as notes.md`) or
  `as jsonl`; with a folder and no name the file is `casper-conversation-<id>.md`, and a file that is
  there is never written over. Anything else (`export the CSV function`, `how do I export a model`,
  `save the session token`) goes to the AI as before.
- The first time a session opens a folder, Casper asks `Trust <folder>? It would run: …` with
  `1 Not now · 2 Trust this folder`; Enter is Not now and asks again next time. A typed line that
  only says to trust it or stop (`trust this folder`, `I trust this repo`, `stop trusting this folder`)
  runs `/trust` or `/trust off` the same way, with no model call, idle or during a task:
  `[trust] Handled here, no model call: /trust does the same.` A question (`do you trust this
  repo?`) or code (`trust the user's input in this folder`) goes to the AI. Your home folder and the
  top of a drive are never trusted.
- `/model --session [provider/id]`: for this conversation only; the browser opens with Enter
  choosing for this session only.
- `/effort`: automatic or supported fixed-effort picker in an interactive terminal, otherwise a list.
  `auto` is always a choice. On a rich terminal, **Shift+Tab** cycles that same list and remembers
  the level it stops at (saved once, when you stop pressing). `/effort <level>` remembers too;
  `--session` opts out.
- `/effort high`: apply and remember for that model. Unsupported levels fail.
- `/effort high --session`: do not change the saved preference. Effort also survives
  switching away from a model and back within the current conversation.
- `/effort auto`: classify each raw request before generation. `/status` and the footer show
  `effort auto → <level>`; before the first request `/status` reads `auto → <level> for now; your
  next request picks the level` (the footer keeps it to `<model> · auto`), and `(fallback)`/`(unavailable)`
  follows when it could not classify, with an `[effort]` notice in the transcript. A fallback says why, in the
  notice and in `/status` (`auto → high (fallback: no answer within 4 s)`): no answer within 4 s, the provider returned
  an error, the answer was cut off, the answer wasn't a level, couldn't reach the provider, or the classifier model
  isn't signed in. Never the provider's own text. A fixed level
  disables it. The banner's model line says the model and its effort once
  (`fixture/demo · effort auto (starts on your first request; /model to change)`); the first
  request adds a short `[model] <model> · effort <level>` line only when that differs from the banner
  or the credentials are missing.
- `/model roles`: inspect optional `fast`, `build`, `reason`, `review` mappings.
- `/model role review provider/id:high`: save a shortcut without selecting it.
- `/model --session @review:auto`: resolve that shortcut with an explicit effort
  override for this conversation. `@default` resolves the saved concrete model.

Restored conversations retain their recorded model/effort. Missing credentials or
an unavailable model still block sending rather than silently choosing another
provider. Pi CLI defaults are neither read nor rewritten. Selecting a model generates no
model response; subsequent requests send context to the selected provider.
Explorer/reviewer children use Casper roles or its startup default (the conversation's model when none is saved or signed in), then at low/medium effort. Auto effort
makes one extra bounded current-request-only classifier call using `fast`, or
the selected model if unset; no history or skills are sent to the classifier.
This can cross providers when `fast` is configured. See [CONFIGURATION.md](CONFIGURATION.md)
for precedence, cancellation, persistence and the four-second fallback policy.
Classifier usage is shown separately in `/usage` for the loaded session instance;
unreported failed-request cost is unknown, not zero.

### Provider login

`/login` shows one numbered list of providers and ways to sign in, OpenRouter first:
1 OpenRouter · paste an API key, 2 OpenRouter · sign in with your browser, 3-4 the same for
Anthropic (Claude), then OpenAI Codex and GitHub Copilot, and last **Model server on another
computer**, which adds one instead of signing in ([Add a model server](CONFIGURATION.md#add-a-model-server-on-another-computer)). OpenAI Codex opens your browser on
a desktop; over SSH or on Linux with no display it shows a code to enter at openai.com
instead (some accounts must turn that on first). GitHub Copilot always uses a code. Press a number, or Up/Down and
Enter (Enter alone picks 1); Esc cancels. `/login <provider-id>` lists only that provider's
ways, and opens the only one straight away. When Casper opens sign-in by itself (a request
with nothing signed in, or a model whose sign-in is missing), the list shows even for a provider
with one way, so you see what is about to start. Picking a row is your go-ahead, as in Claude Code
and Codex: no confirm screen follows. The list says where the key goes (`Saved in
~/.casper/agent/auth.json, only on this computer.`), and the next screen says what the provider
charges. Only that provider's saved sign-in is replaced. Browser sign-in opens the system
browser automatically; offline mode (CASPER_OFFLINE=1) suppresses the launch and keeps the URL
printed for manual opening.
Typed API keys are verified with the provider before they are stored; a rejected
key is never saved, and a key that cannot be verified (network or provider error)
can be retried, saved explicitly, or cancelled. Keys and callback codes/URLs use a
separate hidden prompt (live character count, contents never rendered), never chat/history.
Esc or Ctrl+C cancels; EOF and shutdown drain the login lifecycle. A failed sign-in says the reason
Casper has in plain words (timed out, couldn't reach the provider, the provider refused it) and
never the provider's own text. A model whose provider has no sign-in names that provider, its
`/login` and its key variable (for example `OPENROUTER_API_KEY`); a one-shot run or a plain
terminal with nothing signed in says `Not signed in yet. Run casper in a terminal and type /login.`
A one-shot run with a key set but no model Casper can pick says
`No Casper model selected. Pass --model <provider/model>, or run casper and type /model.`

**Sign-ins from other tools.** On a new computer where Claude Code, Codex CLI or GitHub CLI is
already signed in, `/login` (and the sign-in Casper opens by itself) first says
`Found a Codex CLI sign-in on this computer` and offers one row per sign-in found (such as
`1 Codex CLI · use its OpenAI API key`), then `Sign in separately` and `Not now`. Only providers with no sign-in yet are offered, and
`/login <provider>` offers only that provider's sign-ins. Finding one reads no key; the key is read only after you
pick it. Claude Code's or Codex CLI's API key is checked with Anthropic or OpenAI first, then copied (a key
works in both tools). GitHub CLI's sign-in (`gh auth token`) is used for GitHub Copilot the same way
Copilot's own sign-in is: exchanged for a Copilot token, then the models your plan offers but hasn't turned
on yet are turned on (the list says it may turn on model policies on your GitHub account). gh stays signed
in; a classic `ghp_` token is refused, because Copilot doesn't take it. A Claude or ChatGPT plan sign-in is never copied: its refresh token changes on use, so
a shared copy would sign the other tool out. Picking it starts Casper's own sign-in to the same
account instead. Casper looks in `~/.claude.json`, `~/.claude/.credentials.json` (`CLAUDE_CONFIG_DIR`),
`~/.codex/auth.json` (`CODEX_HOME`) and gh's `hosts.yml` (`GH_CONFIG_DIR`, `%APPDATA%\GitHub CLI` on
Windows). The AI's tools can't read any of these, moved or not. **Sign-ins from other tools** in `/settings`
(`other_logins: off`) turns the offer off.

If you skip `/login`, Casper opens sign-in on your first request and picks that provider's
default model (OpenRouter: `deepseek/deepseek-v4.1-flash`); with model servers you added, it opens
`/model` on them instead and you pick. `/model` picks another; Casper never replaces a model you chose: [failover](CONFIGURATION.md#failover) only carries a task that hit a limit on to another model, says so, and goes back for your next request. Type keys or codes only in the private login prompt, never in chat.
Your provider's plans and charges still apply.

`/logout` lists the sign-ins `/login` saved (provider and kind, never the key), and
`/logout <provider>` removes one from that file, like Pi's and Claude Code's `/logout`. A key in an
environment variable is not touched; unset it yourself.

The list reuses Casper's shared picker: a digit picks its row at once, Up/Down moves the
visible highlight in place, Enter confirms that item, and Esc exits without contacting
the provider. Navigation accepts Pi's decoded arrow/Enter sequences, including
fragmented or batched terminal input. Trailing keys cannot answer the next prompt;
pasted text cannot pick a row or submit a private credential.
All login panels render through the host surface; terminal-control bytes never
pass through the untrusted-text sanitizer or get appended as transcript text.

macOS PTY tests cover rendering and complete synthetic login flows; this picker
has not yet been checked on a real Windows machine.

Copilot login may enable account model policies. Pi documents Claude subscription
auth as billed extra usage. OpenRouter API usage is billed from credits, and its
browser sign-in exchanges an authorization code for a user-controlled API key.
Callback listeners are loopback-only for browser sign-in. Plain terminals remain guidance
only. See [platform support](PLATFORM_SUPPORT.md) for host-validation limits.

### Input and commands

- Type `/` for a fuzzy list. Tab completes; Enter on a partial choice inserts it,
  and a second Enter submits. An exact command submits literally. A row shows what may
  follow the name (`[n|list]`), and a space after a command lists its subcommands for Tab.
  Each command is one row: an alias finds its command and the row says which (`/cost` shows
  `usage (cost)`, `/q` shows `exit (quit)`), and Enter on an alias typed whole runs it as typed.
  A label too wide for its column ends with `…` (`role <fast|build|reason|…`), never cut with no mark.
- `@`/Tab offers file-path completion. This inserts a reference; it does **not**
  attach/read the file or grant additional permissions. Unsafe control-bearing
  completion labels are omitted.
- Pictures: Ctrl+V (Alt+V on Windows) pastes the clipboard's picture as `[image 1]`, and
  a picture file dropped or typed as a full path (`/…/shot.png`, `~/…`, `C:\…`) becomes
  `[image N]` when you send, also at the start of the line (then it is a request, not a
  command). During work a line with a picture goes to the AI with it, read by the same rules
  (`↳ sent to Casper with your picture`); a picture on another computer's Windows share isn't
  opened then, since Casper can't ask during work. A line that is queued keeps a pasted picture
  for when it runs; Esc gives the line back but not the pasted picture, and says so. A macOS screenshot's name, with its
  narrow space before AM or PM, is read whole. PNG, JPEG, GIF and WebP, up to 20 MB each (a pasted picture too) and 8 a
  request. With no picture on the clipboard, files you copied in Finder, Explorer or a
  Linux file manager go in as quoted paths, as if dropped: a picture file among them is
  attached when you send, with the same checks and limits; any other file stays as its
  path. A name with a control or bidi character is left out, and says so. On a Mac the
  copied files are looked for first, since Finder also puts the file's icon on the
  clipboard as a picture. Casper reads the list with the system's own tool (`osascript`,
  Windows PowerShell, `wl-paste` or `xclip`), for at most a few seconds. With neither,
  its text is pasted like any paste, with terminal control codes taken out. A dropped file's
  path stays on a line under the request, so the AI can still copy it. A pasted picture is
  saved to a private temp folder (on Windows under `~/.casper/pasted`, since Windows keeps your profile to you
  but not always the temp folder), deleted when Casper closes, and its path goes on the same kind of line. A bare name like
  `logo.png` stays a word. On Windows, a path on another computer's share (`\\nas\shots\pic.png`),
  typed, dropped or copied, asks first, `Attach this picture?` with `1 No · 2 Yes, this once`, once per computer: opening it
  sends your Windows login (a hash of it) there. A no leaves the path as words.
  When the model can't see pictures, one question:
  `1 Send without it · 2 Switch to <a model you set up that can> for this request` (the switch is
  for the build turn only, then back to your model; a plan turn stays on your model). With no such model, or in a one-shot run, one line says the request went
  without them.
- Clarification questions keep the question on its own line. The question and every
  option wrap in full at the current width (a description that does not fit beside
  its label goes on indented lines under it); nothing is truncated. When all of it
  would be taller than the screen, only the highlighted option shows its description,
  so the question stays in view. Each choice shows its number: press 1-9 to pick it
  (or toggle it in a multi-select), or use Up/Down and Enter; Space also toggles.
  Esc skips. A question that takes a typed answer (the AI's, a new project's name) ends
  with one more numbered row that Casper adds, never the AI: `Other — type your own answer`.
  Picking it (its number, or Up/Down and Enter) highlights it; the answer appears inline beside Other,
  in full as it wraps. When the box can't hold all of it, the part where the cursor is shows (the end, while
  you type on) with `…` for the rest, and a box too small for the words after the whole label keeps only
  `Other —`. Enter sends all of it, and Esc (or Up/Down on an empty answer) goes back to the list; the hint there is
  `Enter to send · Esc to go back`. Letters typed on the list go nowhere: they never start an answer, and a short hint
  names the keys and the Other row's number (`Pick with 1-5 or ↑↓ Enter · 5 to type your own answer`), as in Copilot
  CLI, Claude Code and Codex. Pickers that take keys only have no Other row; an approval's No row takes its note
  (below). On the answer line numbers are words, so an answer can start with one; on the list a digit past the last
  row picks nothing. A list longer than nine numbers every row: type the number and press Enter; a plain terminal says `Type 1-16:`.
- `/settings` on a rich terminal is a screen, not a numbered list: seven tabs at 80 columns or more,
  an area list first below that. Up/Down moves; Enter/Space flips an on/off at once or opens a small
  Keep-first choice. Left/Right or Tab switches areas, typing searches all of them, Backspace clears
  the search and Esc closes (inside a choice, Esc goes back). While searching, Space adds a space;
  Enter changes the match. Values update at once; colours follow
  Theme, with no colours under `NO_COLOR`.
- Every numbered list uses the same component: accent `❯`, `1.` numbering and aligned dim descriptions.
  Choice descriptions and the approval's Command frame stay explicitly faint even with the
  high-contrast theme; `NO_COLOR` leaves them plain.
  Arrows and Enter are primary; digits are immediate shortcuts up to nine choices. The hint is
  `Enter to choose · Esc to skip`; specialized actions such as Ctrl+S remain available. An approval has no hint under
  its rows: its numbers are the keys.
  Approvals, plan choices, `/model`, `/settings` choices, sign-in and startup questions share these rows.
- A quote in the AI's answer is indented and grey with no `│` gutter, so a prompt it quoted for you to paste later
  copies with only its words (`tests/markdown-stream.test.ts`). A code block's title line (`── bash ──`) is never part
  of its code; a first line that says `bash` is one the AI wrote.
- A question from the AI's `ask` tool starts with a muted `The AI asks:` line. Casper's own
  questions and approvals never do, so the AI can't pass off a question as a Casper approval. Markdown escapes in its
  words come off (`\`GET\`` shows as `` `GET` ``), and its `code` shows bold without backticks (with them under
  `NO_COLOR`); `tests/ai-ask-render.test.ts` checks this.
- A closed box leaves one line and nothing else: `<question> → <answer>` (`Pick a server → network`,
  `network → Connect`, `Make this change? → Yes, this once`), or `<question> — skipped` after Esc
  (`… — skipped (No)` for an approval). The question is its first line; the choices, the hint and the
  lines under the question go with the box. The rich `/settings` screen leaves only its save notes, not its rows. A
  long question is cut with `…` so the answer always shows. One exception: the no-sandbox `Run this command?` box
  leaves nothing after a yes (the command's own line shows it ran), one muted `✓ allowed until you quit: npm test` line
  after 3, and the usual line after a No or Esc. `/allowed keep` (the Next row's `Always allow …`) prints
  `✓ allowed always in this project: npm test`. That line is the only record: no `[ask]`,
  `[approval]` or `[server question]` line and no `✓ ask` step under it. The plain terminal prints the
  same line after its numbered lines.
- A command approval always starts with Casper's own question (`Run this command?`). Only the last sentence of the model's reason
  follows, dimmed and labelled `The model says:`: at most 100 characters then `…`, clipped to one row without wrapping.
  Multi-line commands sit in a dim frame with a head/gap/tail preview: about eight head lines, `… N more lines`, then the final three. Consequential middle lines (push, remove, download, sudo, install and redirects) stay below the gap; the count includes only omitted command lines. Secrets stay hidden. The activity list remains above the box.
  A session yes for `bun test` covers different project test files and log tails in the same folder; other commands
  and permanent approvals keep exact matching.
- Approval boxes for a shell command, a host, another machine, a write outside the project, your GitHub login and
  checks outside the sandbox have the same short rows and nothing beside them: `1 No · 2 Yes, this once · 3 Yes, for
  this session` (the no-sandbox `Run this command?` box adds `4 Yes to everything this session`, which does what
  `/permissions all` does: the one-key way out when auto mode's judge asks). After a task in which you answered 3, the Next row offers to keep it for this project:
  `Next: 3 Always allow npm test in this project`, which runs `/allowed keep <n>`. Each is offered once; `/allowed`
  lists what is kept and `/allowed forget` takes it back ([decision 45](adr/0002/45-three-row-approvals.md)).
  `stop asking` (or `don't ask again`) typed alone at the prompt opens the `/permissions all` box, as if typed.
- A list taller than the window shows the rows around the highlighted one, with `… 12 more below`
  (and above), so the box never scrolls its own top away.
- While a picker or approval is open, there is no prompt input row: keys go to the box (a number past
  nine rows is still typed), and the footer says `waiting for you`. A paste waits as the draft for
  after the box closes, so a 60-line paste never lands in the box. Typing and pastes go in only on the line a row
  opens once it is picked: Other on a question that takes a typed answer, or an approval's No.
- Auto mode (on in a folder you trust, with the sandbox off): before `Run this command?` shows, a model judge looks at the
  command. When it lets the command run, one dim line says what it does (`✓ judge: runs the project's tests`); when it
  wants you to decide, the box shows as usual with `The judge says: …` on its dim line instead of the model's. Type
  `auto mode off` (or use `/settings`) to go back to the box for every such command
  ([decision 47](adr/0002/47-auto-mode-judge.md)).
- Every box takes the same input: approvals (an MCP change, a host, a shell command, a device
  check, `/mcp writes`) are the same numbered panel as any question. Use Up/Down and Enter, or a digit shortcut
  (no Enter); Esc skips without approval. Letters typed on the list go nowhere and never answer it: a short hint names
  the keys and that 1 takes a note. An approval's No (`1`, or Enter on it) opens a line for a note, shown like a typed answer (in full, or the part where
  the cursor is); an empty Enter there is a plain No, and Enter with words declines and sends the note as direction for Casper (or keeps it in the draft when no task can take it); the hint
  there is `Enter sends No · type to tell the AI what to do instead · Esc goes back`, and Esc goes back to the list. Even a note that spells a granting choice is a No
  ([decision 43](adr/0002/43-boxes-take-keys.md), [decision 45](adr/0002/45-three-row-approvals.md)). Keys pressed in the first moment after a box opens (about 0.3 s) are ignored, so a key
  typed mid-sentence never answers a box that just appeared. Ctrl+X still denies an open approval.
- Casper's own numbered questions and approvals also work on the plain terminal: it prints the
  choices as numbered lines and reads `Type 1, 2 or 3:` (`Type 1-24:` past nine); a number or
  a choice's words pick it. A question that takes a typed answer lists `Other — type your own answer`
  as its last number; picking it asks `Your answer: `. `/settings`, `/preview` and the question after a check times out
  ask there too, as numbered lines. Enter picks choice 1, and at every Casper question choice 1 is the one that does nothing
  risky (Stop, Not now, Use this folder, Leave it, No, Keep writes off, Keep the
  default): building, installing, downloading, spending tokens, running a check again, saving a
  choice, approving or reaching a lab always takes a deliberate 2 or 3, so a stray Enter is harmless.
  One-shot runs, `--json` and piped input never get these questions: each takes the safe answer,
  and the new-project, lab and security ones say what they did instead.
- Up/Down recalls current-process prompt history. Shift+Enter where the terminal
  supports it, or Ctrl+J, inserts a newline. Bracketed paste stays in the draft.
- Shift+Tab cycles reasoning effort (`auto`, then the model's supported levels) without
  opening `/effort`, and saves the level it stops at, like `/effort`. During work the
  model's next step uses it (`[effort] high from the model's next step; saved`); while an approval or a
  question is open it only shows `effort unchanged · answer first`.
  It is not available on a plain terminal.
- Escape stops active work. Ctrl+C cancels work; when idle it clears a draft. On an
  empty editor the first Ctrl+C only shows `Ctrl+C again to exit`; a second within two
  seconds exits, any other key disarms it. Ctrl+D exits an empty editor at once.
  Ctrl+L forces a redraw.
- Enter during work runs any command at once, with whatever follows it, as when idle:
  `/permissions all`, `/settings`, `/login`, `/memory remember …`, `/mcp writes …`, `/details quiet`,
  `/tasks stop 2` and the rest. A setting or permission you change applies from the task's next
  step or question, and the command says so (`The running task uses it from its next step.`); a tool
  the task already has (web lookups, the reader, builders) changes from your next request
  (`The running task keeps what it had; your next request uses it.`).
  `/doctor` only reports during a task (its fixes ask after it); `/exit` and `/quit` stop the
  task and leave; `/mcp`, `/tasks` and `/diff list` print their lists instead of a picker, and
  `/permissions` (and `/permissions details`) shows its screen without the stop-asking box.
  `/effort` and `/model` (the picker, `/model <provider/id>`, `/model <words>` or `/model --session <provider/id>`)
  apply from the model's next step (`[model] <provider/id> from the model's next step; saved`); the
  step already running keeps its model; the `/model` picker also closes when the model's work ends.
  `/permissions all` typed during a task opens no box: the command is the answer, from the task's next question.
  A picker, question or numbered box (`/mcp writes`) a command opens during a task
  gives way: when the task asks you something (an approval or the AI's question) it never waits behind
  the command's box, which closes first and leaves
  `… — closed for the task's question; type the command again`. A private box for a key or a
  password (`/login`, `/mcp login`) is never closed under you: the task's box waits until it is done.
- Only the commands that would change what the task works on, or start model work of their own
  (one at a time), wait: `/clear` and `/new`, `/resume`, `/continue`, `/compact`, `/undo`, `/redo`, `/rewind`,
  `/branch <name>`, `/switch`, `/project <name>`, `/project new`, `/plan`, `/verify`,
  `/review`, `/security-review`, `/delegate` (it stops the debugger the task may use), `/crew` (its list
  applies copies to your folder; `/crew drop` runs) and a picked suggestion. They keep their draft
  and say why for a moment (`/undo waits until this task ends · draft kept · Esc stops the task`).
  Typing `/` keeps the command menu; the commands and subcommands that wait are dimmed and say
  `waits for this task` (one table, `src/tui/commands.ts`, decides both the menu and what runs).
- A line you start with `?` (`? what does ECONNRESET mean`), idle or during work, is a side
  question: one separate call to your fast model (or your model when no fast one is set up) with no
  tools. It gets a short summary of the session (the project name, the task's first line and the
  tool names used lately; no file contents and no secrets). The answer shows as an indented side
  answer that names the model (`? side answer · <provider/id> · not part of the conversation`); it
  is not added to the conversation, so the working AI never sees it. It asks with thinking off,
  since side questions are quick, or at the lowest effort a model allows when it can't stop
  thinking (the newest Claude models: low); a fast role with its own effort (`/model role fast
  <provider/model>:low`) sets it instead. A request that thinks gets 4,096 tokens of room to think
  on top of the answer's 1,024. An answer with no text says why
  (`… used its whole 1,024-token limit thinking and wrote no answer`). `/usage` counts its tokens
  and cost. A bare `?`, a `?` inside text and a pasted `?` line are ordinary requests, and so is
  every line of a one-shot run. Esc stops one asked while idle. `/settings` → "Side questions
  with ?" turns them off (`sideQuestions: false`). `/btw <question>` asks the same way, idle or
  during work, and still works with side questions off: it can't be meant as a request.
- Words at the start of a request (`think hard:`, `quick:`, `big model:`, `fast model:`,
  `plan first:`) and `ultrathink` anywhere in it set that task only; see
  [Words you can use](#words-you-can-use).
- Anything else you type during work goes to the AI, as part of the task it is doing: it reads the line after a short
  note to answer it or act on it, then carry on with the task unless the line says to stop or change it. A quick
  question mid-build no longer ends the build. Only the model sees the note; the line shows, waits and is saved as you
  typed it. While the model is working it reads the
  line when its current step ends (`↳ sent to Casper · it reads this when its current step ends`),
  which can be a while for a long step (a step that only waits ends at once, as below). Before the model's first step
  (while Casper sets up a server or reads the workspace), the line joins the request: the first prompt lists it under
  `Later instructions the user typed during this task, oldest first:` (`↳ added to your request · the AI reads it with
  it`); if the task stops before the model starts, it is queued instead. While Casper runs checks or writes
  the receipt, the line is queued and runs as the next request (`↳ queued · runs when this task
  ends`). Until the AI reads it, each line shows above the prompt as `↳ waiting: …` (the newest 3),
  and the row goes when the AI has read it. ↑ on an empty prompt (or Alt+Up) takes the newest
  waiting line back into the prompt, unsent. A line sent to the AI stays part of the task: a repair, proof or acceptance
  round restates the request with it, under `Later instructions the user typed during this task, oldest first:`, and a
  line taken back is left out. The line is echoed once (`❯ …`, after the words
  shown so far) when you type it, not again when it runs. A line the AI never got to read runs next too. Esc
  stops the task and puts every waiting line back in the prompt instead of running it: Casper
  takes them out before it stops anything, so a stopped step never adds them to the conversation.
  Queued lines live outside the prompt, so a queued line never answers an approval box.
  Pickers borrow exclusive input ownership; pretyped text cannot answer a later
  exact approval. NO_COLOR keeps input controls, while TERM=dumb/redirected output
  uses plain line input and retains existing fail-closed cooked-terminal approval.
  Plain lines that arrive before the first prompt (a fast typist, or a pipe) are
  read in order once Casper starts reading. On a plain terminal, lines a person types during
  work go to the AI or the queue as above; piped lines that arrive during work are dropped.
- A line you send while the AI's step only waits ends that wait, so the AI reads the line now. A slow shell command
  (one the AI gave no time limit, with **Slow commands** on) moves to the background and keeps running, as it would
  at its limit. The browser's sign-in window closes as if you had closed it, and a sign-in you finished there is kept
  (`[browser] Closing the sign-in window so Casper reads your line; …`). A service start stops waiting for readiness
  and keeps starting. Other steps finish first, as before: a command with its own time limit or on Casper's ssh login,
  a slow command when 4 already run in the background, MCP calls, helpers (`delegate`) and checks (`casper_check`).

Daily commands include `/help`, `/status`, `/project`, `/diff`, `/verify`, `/skills`,
`/mcp`, `/lsp`, `/browser`, `/permissions`, `/model`, `/effort` and:

| Command | Effect |
| --- | --- |
| `/context` | Runtime context estimate and counts; no invented per-file token attribution |
| `/usage` | Tokens split into out, new and cached plus the raw counts; catalog cost estimate for the whole session, or the subscription name with the pay-per-token figure; not billing |
| `/compact [instructions]` | Explicit cancellable model-assisted summary; **can make a model request** |
| `/clear` | Fresh saved conversation; files stay as they are (`/undo` puts a task's files back); the earlier conversation stays resumable |
| `/resume` | Pick a saved conversation from a numbered list (title · when · messages; 1 stays here); then the last few turns show |
| `/resume <id>` | Go back to that conversation; the first few characters of its ID are enough |
| `/continue` | Go back to this folder's most recent other conversation (not the one you are in, nor an empty one `/clear` left); then the last few turns show. With none it says so and nothing changes. In the conversation `/continue` or `--continue` opened, it stays there and says so |

Each start in a folder is a new conversation, as in Claude Code, Codex, Copilot CLI and Pi; only a `/branch`
experiment's folder reopens its branch's own. When the folder has an earlier conversation, the start offers one row,
`Next: 1 Continue the Oct 21 conversation (<title> · 12 messages)` (or `Continue today's conversation`,
`Continue yesterday's conversation`) with `Anything you type starts a new conversation.`
under it: a lone `1` on the empty prompt runs `/continue` (sent before the row shows, it waits up to 3 s for it), and so does a
first line that only asks to go back (`continue`, `continue session`, `pick up where we left off`); anything else typed is the new conversation's first request, and
Enter runs nothing ([decision 42](adr/0002/42-a-plain-start-is-new.md)).
| `/branch`, `/switch <name>` | Existing named-workspace navigation and its approval policy |
| `/output [n]` | Full command and output of the last task's n-th most recent tool call (1 = latest; 20 retained per task); out-of-range n is a usage error |

`/diff` shows the last task's changes in this folder, also outside git (`/diff 12` a
saved task's, `/diff list` picks one). Before any task it shows Git status and tracked
changes against HEAD, without external diff or textconv drivers; untracked names are
listed, not file contents, each Git command has a five-second deadline and 64 KiB
output limit, and large output is marked truncated. `/undo` puts the last task's files
back and `/redo` undoes that (see [UNDO.md](UNDO.md)).
After a task that changed files, the receipt names the changed paths (from a before/after
tree digest), or how many past three. The per-file table (a bounded `git diff --stat`) is shown
with `--verbose`; `/diff` shows the task's full changes.
`/permissions details` explains actual boundaries from the state Casper is in: whether the shell
sandbox holds shell commands and checks here, or (without it) that the AI's shell asks
before commands beyond reads and routine work. Reads are in the project or in your own folders under home (not hidden ones, app data or private places). Reads include individual public config lookups (`git config <key>`, `--get`, `--global`),
`command -v`/`type`/`which`, `ps`, `date`, and `uname`. Config `--list`/`-l` and keys naming credential/token/password/extraheader
or `url.*.insteadof`/`pushinsteadof` ask. So do `ps` environment-output groups containing `E` or BSD bare words containing `e`;
Linux `ps -e` remains a read. Routine work includes project tests, `git commit`, safe `git fetch`
(no pruning, forced or deleting refspecs), project-file output redirects, and `result=$?; …; exit $result`.
Outside/private/`.git` redirects, substitutions, scripts, `sudo`, `curl … | sh`, force pushes and new packages still ask.
Builder reads and checks use the builder's own copy as the project root. `/sandbox` lists what it holds and `/allowed` the commands you said yes to.
With the sandbox on, a plain `git push` or `gh pr create` the AI runs asks `Run outside the sandbox with your GitHub
login?  git push -u origin main` (1 No · 2 Yes, this once · 3 Yes, for this session, which the Next row offers to keep;
Esc is No; a `gh pr merge`, `close`, `reopen`, `ready`, `review` or `checkout`, `gh issue close` or `reopen`,
`gh run rerun` or `cancel`, or a command that types its own address, offers 1 and 2 only, every time), and
`/permissions details` shows that rule in one line. Existing integration-specific
approvals remain in force. Verification is still separate from tool completion.

### Pages the AI makes

When a picture answers better than text (options side by side, a mock-up, a dashboard of
results, a report someone else will read), the AI makes a page by itself with its
`casper_page` tool, and you see it in your browser at once. You don't have to ask for one.
Plain answers stay in the terminal. A diagram from the diagram tool (or `/visualize repo`) opens as
a page too, one Casper makes from the diagram itself with no model time: `diagram-<title>`
(see [Visualization](VISUALIZATION.md#using-it)). A network diagram is drawn there like one, with device icons in
tiers, links at right angles and port labels ([Network diagrams](VISUALIZATION.md#network-diagrams)).

```text
[page] db-options → http://127.0.0.1:52144/db-options.html
[page] db-options updated → http://127.0.0.1:52144/db-options.html
```

- **One file per page**, in `~/.casper/pages/<project>/<name>.html` (the same project key as
  Casper's state folder, `~/.casper/projects/<project>`). Names are short: `a-z`, `0-9` and `-`,
  up to 40; a near miss from the AI is fixed, not refused (`Ghost_Options` is saved as
  `ghost-options`). The same name again replaces the page, and its open tab reloads itself.
- **Opening.** The first time a page is made in a session, Casper opens it in your default browser
  (`open` on macOS, the URL handler on Windows, `xdg-open` on Linux). Later changes reload the
  tab instead of opening another one. Over SSH, in CI, or on Linux with no display, Casper prints
  the link only (the address is on that computer: forward the port to see it). **Open pages in
  the browser** in `/settings` (`open_pages: off`) prints the link only everywhere.
- **The page server** starts with the first page of a session: `127.0.0.1` only, on a free port,
  and it stops when Casper quits. A one-shot run (`casper -p "<request>"`) starts no server: the page
  is saved and its file address printed; `/pages open <name>` in a session shows it.
- **`/pages`** lists this project's pages with their links; `/pages open <name>` shows one (also
  with opening turned off: you asked); `/pages remove <name>` deletes one, and its open tab says
  `(removed)`. They run at once, also during a task. No model.
- **Cost.** The tool is one short line in each request. How to build a good page (one
  self-contained file, light and dark, phone width, real data, nothing private) comes back from
  the tool itself the first time it is used in a conversation (again after `/clear` or `/resume`),
  so it costs nothing until a page is made.
  **Pages the AI makes** in `/settings` (`ai_pages: off`) takes the tool away; `/pages` still
  lists the pages already made.
- **What a page can do** is held tight: it can't fetch, post, or load images from other sites, it
  runs with an origin of its own (no cookies or storage shared with other apps on `127.0.0.1`), and
  the server serves nothing outside the pages folder. WebRTC is taken away too, best effort (see
  [SECURITY.md](SECURITY.md#pages-the-ai-makes)). Sharing a page beyond this computer is not
  part of Casper yet.

### Pictures the AI makes

For a page that needs photos or illustrations, the AI makes them with its `make_picture` tool and
saves them in the project. It uses your ChatGPT plan through your own Codex CLI first, then a free
OpenRouter model; a paid model only when you name one ("with FLUX 3"). With neither it draws SVG.
The picture is made in the background while the AI works on; anything that would use the file
waits for it, and a failure shows as `[picture] ... failed: ...`.
No question is asked. See [CONFIGURATION.md](CONFIGURATION.md#pictures-the-ai-makes) for the order,
`pictures.models` and the off switch (`pictures: off`).

### Local debugger

`/debug` lists project targets/status without a model or adapter. Configure
`.casper/debug.json`, then `/debug start <target>` launches as typed (it prints what it runs, no box).
`/debug breakpoints <path> <1,2|clear>`, `threads`, `stack <thread>`, `scopes <frame>`,
`variables <handle>`, `continue <thread>` and `stop` provide bounded local inspection.
Handles expire when execution resumes. Values may contain secrets; they are neither
verification nor automatic model context. Use `/debug stop` when the editor is idle;
active-command cancellation, session/workspace/model transitions and sending a normal model request stop debugging.
See [DEBUGGER.md](DEBUGGER.md). No adapter installation, remote attach or evaluate.

### Offline interactive demo

```sh
bun tools/terminal-demo.ts
```

This offline demo uses two made-up models and synthetic activity. It makes no model
calls, edits no source files and saves no preferences. Send any line: made-up runtime events
play through Casper's own event view a moment apart (`CASPER_DEMO_PACE` sets the pause in ms): the AI's
words, steps ticking in under them with the status row above the prompt, then the fold into a named row,
an edit box and a failure box, and a short answer; Esc stops them. `/model` opens the real model browser over the made-up models and `/effort` the
real effort picker; `/exit` quits, and any other `/` command only lists these three.
Resize while editing a draft. Approvals, errors and `/status` are only in the real CLI.
It exercises the production terminal surface, not live-model usefulness or human
visual sign-off.

## Compatibility

macOS terminal behavior is exercised with real PTYs. Windows and Linux need host
runs; exhaustive terminal compatibility is not claimed. Conversation/token storage
is not automatically redacted. `/undo` puts back the files a task changed (see
[UNDO.md](UNDO.md)); there is no automatic shell shortcut or enforced permission-mode
selector. A line typed during a task steers the AI at its next step or waits in the
queue and runs when the task ends (see Current interface above); Esc gives queued
lines back to the prompt.

## Design references and reuse

The layout is inspired by [OMP](https://github.com/can1357/oh-my-pi) and uses the
installed Pi renderer, editor, Markdown and selectors. Wording guidance is informed
by [i-have-adhd](https://github.com/ayghri/i-have-adhd), without assuming a diagnosis
or installing its plugin. Both references publish MIT licenses; attribution and
license notices are retained in `THIRD_PARTY_NOTICES.txt`. Casper keeps its own
identity and does not bundle OMP as another runtime.
