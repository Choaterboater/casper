# Terminal UX — daily-use interface

**What this is:** a guide to Casper's terminal screen: what you see, the keys,
and the `/` commands. **When you'd use it:** when you are learning Casper, or
want to know what a symbol, key or command does. `/help` shows a short list in
Casper, `/help <word>` only the lines that mention a word (`/help mcp`), and
`/help all` the full one. A mistyped command gets "Did you mean …?".

## Quick reference

### Keys

| Key | What it does |
| --- | --- |
| Enter | Send the request (during work: the AI reads it at its next step, or it is queued for after the task) |
| Shift+Enter or Ctrl+J | New line in the prompt (Shift+Enter only where the terminal supports it) |
| Up / Down | Earlier prompts from this session |
| `/` | Command list with fuzzy search; Tab completes |
| `@` then Tab | Complete a file path (inserts the path only; it does not attach the file) |
| Shift+Tab | Cycle reasoning effort (`auto`, then the model's levels) and remember it |
| Esc | Stop the current work |
| Ctrl+C | Cancel work; when idle, clear the draft; twice on an empty prompt exits |
| Ctrl+D | Exit when the prompt is empty |
| Ctrl+T | Show the last step in full: an edit's whole diff, what a command printed, or the provider's own words after an `[error]` (works during work too) |
| Ctrl+L | Redraw the screen |
| Ctrl+V (Alt+V on Windows) | Paste a picture from the clipboard; it shows as `[image 1]` and goes with the request. A file you copied in Finder, Explorer or a file manager goes in as its path, and a picture file goes with the request like a dropped one. With neither on the clipboard, its text is pasted |
| Ctrl+O | Turn MCP writes off for every server at once (see [MCP.md](MCP.md)) |

### Commands

These commands run on your machine. Only `/compact`, `/delegate`, `/crew <job>` and
`/verify repair` send a model request. `/model` may fetch provider model lists
over the network, and `/references add` downloads files after asking you.

| Command | What it does |
| --- | --- |
| `/help`, `/help <word>`, `/help all` | Short help, the lines that mention a word (`/help mcp`), or the full reference |
| `/status` | Project, model, sign-in and connections |
| `/doctor` | Check Casper's own setup and fix what it can, each fix after a question (see [DOCTOR.md](DOCTOR.md)) |
| `/model`, `/model big <model>` | Pick a model (remembered; `--session` for this conversation only); your big model for when repairs run out |
| `/effort [level\|auto]` | Reasoning effort, or `auto` per request; Shift+Tab cycles it (see [Model and effort](#model-and-effort)) |
| `/login [provider]` | Sign in to a provider (see [Provider login](#provider-login)) |
| `/context`, `/usage` | Context estimate; session tokens and estimated cost |
| `/compact [instructions]` | Summarize the conversation (**makes a model request**) |
| `/clear` | Start a fresh conversation; files and saved conversations stay |
| `/resume [id]` | Pick a saved conversation from a numbered list, or go back to one (the start of its ID is enough) |
| `/diff [n\|list]` | The last task's changes (also outside git), task n's, or a list to pick from; before any task, git's view |
| `/undo [n]`, `/redo [n]` | Put the last task's (or task n's) files back, or back again (no model; [UNDO.md](UNDO.md)) |
| `/new [name]` | Start a new project in ~/Projects (no model; [NEW.md](NEW.md)) |
| `/plan <request>` | Plan first: the model writes a plan and cases to test, you edit it, then build |
| `/suggestions [on\|off]` | List the suggested next steps, or turn them on or off |
| `/details [quiet\|normal\|detailed]` | How much work shows, remembered like `/effort` (`--session` for this session only); Ctrl+T shows the last step in full |
| `/settings` | Shows every switch and where it stands at a glance, then changes one by number: web lookups, the AI's browser and diagram tools, the new-version notice, suggestions, side questions with ?, built-in skills, spend notes and pause, the prompt cache, page checks, showing the AI the pages, the work shown, the untrusted-text reader, helpers that build, Playwright tests and sending Casper's name to OpenRouter ([CONFIGURATION.md](CONFIGURATION.md#settings)) |
| `/output [n\|all]` | Full command and output of a recent tool call from the last task |
| `/receipt [n\|list]` | The last task's receipt in detail, a saved one, or the last 10 |
| `/verify [checks]`, `/verify repair`, `/verify add <name>` | Run the project's checks; repair failures; save a check Casper found ([VERIFICATION.md](VERIFICATION.md)) |
| `/security-review` | Run the pinned security tools here, then offer an AI review (asks first; [SECURITY_CHECKS.md](SECURITY_CHECKS.md)) |
| `/project [name]` | Project context and checks; open a project folder inside this one |
| `/permissions` | What each tool may do here and when Casper asks you |
| `/sandbox`, `/sandbox forget <host>` | What the shell sandbox holds; forget a host you allowed |
| `/allowed`, `/allowed forget <n, command or all>` | The shell commands you said yes to for this project (saved, and for this session); take one back |
| `/lab`, `/lab import <file>` | Your lab devices; add more from a file ([NETWORK-CHECKS.md](NETWORK-CHECKS.md)) |
| `/skills` | Skills and whether you trust them ([SKILLS.md](SKILLS.md)) |
| `/mcp` | MCP servers: set up Casper's network server (`/mcp setup network`) and its logins (`/mcp login`), add a server over ssh (`/mcp setup ssh`), connect, writes on or off, allow, forget, docs ([MCP.md](MCP.md)). `/mcp` is one line per server; on a normal terminal an arrow-key picker under it connects, disconnects, forgets or shows details, and `/mcp detail [name]` prints the full status |
| `/lsp` | Language servers ([LSP.md](LSP.md)) |
| `/browser` | A disposable browser; screenshots ([BROWSER.md](BROWSER.md)) |
| `/services` | Dev servers the project declares ([SERVICES.md](SERVICES.md)) |
| `/preview` | Your web app on a phone on the same Wi-Fi; a public link only after a yes ([SERVICES.md](SERVICES.md#preview-on-your-phone)) |
| `/tasks [stop <n>\|all]` | What runs in the background; stop one |
| `/pane [on\|off]` | The steps split beside Casper inside tmux or iTerm2 (only on a window 120+ columns wide); saved for every session. See [TMUX.md](TMUX.md) |
| `/debug` | The local debugger ([DEBUGGER.md](DEBUGGER.md)) |
| `/tree`, `/branch <name>`, `/switch <name>` | Named conversations, each with its own workspace ([SESSIONS.md](SESSIONS.md)) |
| `/memory` | Project facts you saved, and task outcomes ([MEMORY.md](MEMORY.md)) |
| `/references` | Search local reference sources; download a vendor spec repo ([REFERENCES.md](REFERENCES.md)) |
| `/secrets` | What Casper hides from the AI ([SECRETS.md](SECRETS.md)) |
| `/visualize [repo [dir]]` | Diagrams ([VISUALIZATION.md](VISUALIZATION.md)) |
| `/delegate <explorer\|reviewer> <goal>` | A read-only helper AI on one goal (uses a model; [DELEGATION.md](DELEGATION.md)) |
| `/crew <job>` | A builder AI does the job in its own copy of the project (uses a model), then 1 Keep the copy · 2 Apply to my folder · 3 Throw it away; bare `/crew` lists copies still here ([CREWS.md](CREWS.md)) |
| `/exit`, `/quit` | Exit |

An unknown `/` command is rejected on your machine. It is never sent to a model.

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

Only what you type counts: text you paste (and files, tool output and the AI's own words) is never
read as a word. A role you have not set up gets one line on how to set it (`/model role reason
<provider/id>`), and the task runs as normal. Automatic effort does not change a word's effort.
Words never grant permission: approvals still ask as always.

## Current interface

Run `casper` in your project. The interactive terminal uses Pi's main-screen
renderer/editor: ordinary scrollback above an anchored multiline prompt and a
persistent footer, with no alternate-screen takeover. Casper owns the terminal
before it prints the startup banner, so the banner, model status and diagnostics
are transcript lines like everything else. A model is not started just to paint
the footer. A saved default is shown as an advisory startup snapshot; after
runtime initialization the footer uses the active conversation's model. Before any
sign-in, the banner and footer say `not signed in · type a request to sign in`, and `/model`
opens sign-in instead of an empty picker. Where sign-in can't open (a plain or piped terminal,
a one-shot run) they say `not signed in · run casper in a terminal and type /login` instead.

Casper opens the folder you started it in. A project, or a folder inside a git repository, opens
with no question. Your home folder or a drive root (`C:\`, `/`) opens exactly there too, with no question: one line
names the project you last had conversations in (the ones `/resume` keeps) as a `casper <folder>` command,
or gives an example, and a second line says `casper new` starts a new project. Temporary, cache,
`node_modules`, benchmark and `scratchpad` folders are never named. Windows shows real paths
(`C:\Users\alex\Projects`) where macOS and Linux show `~/Projects`. Any other folder opens exactly there,
even one that only holds projects (such as `~/Projects`); when it holds two or more, one line
names them (up to four) and the command to open one, such as `casper aibot`.

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

Transcript lines are inline, not boxed: `✓`/`✗`/`•` tool lines, `[model]`,
`[approval]`, `[task]` and similar bracketed notices, and the `❯ …` echo of each
prompt. Green marks success, red an error, amber a notice or decision, cyan the
accent (banner, prompt echo, Markdown structure), dim the muted status lines.
A fenced block in an assistant message copies clean: a title line with its language
(`── ts ────`), then the code exactly as written with no side border and no indent, then a
closing rule. A line wider than the window is cut at the edge only (no character added or
dropped), so a mouse copy of switch config picks up no `│` characters.
Bordered panels (`src/tui/presentation.ts`) are used for other code-like output and
live work status: `/output` replays a tool result in a box, `/diff` boxes `git status` and
the colored unified diff, a failed check boxes the tail of its stderr and stdout
(last 40 lines; the full output stays in the evidence), and exclusive input flows such as `/login` use them.
Prose, notices and tool lines stay inline. Panels span the terminal's current width, like
the prompt rules and footer, and re-lay out at the new width when the window is resized. Color always accompanies a readable label; tool completion
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
acts on (`git status`, `ssh root@10.0.0.5 …`, `python3 -m pytest …`, at most 80 characters);
`/output` shows the whole command, secrets hidden. The `✓` or `✗` says how a call ended, so there
is no "completed".

On a rich terminal the main screen keeps the model's words, questions and receipts. Tool calls live
in a transient `Working` box that shows the last 3 steps, each updated in place (`• read · src/x.ts`
while it runs, `✓ read · src/x.ts` once done), even with calls running side by side. A step still running after 10 s adds its elapsed time (`• bash · python -m pytest · 4m12s`), and a running command shows its latest output line dimly under it (not at `/details quiet`; plain terminals and `--json` get nothing extra). When the model
moves on (its next words, or the end of its turn), the finished steps fold into one line:
`✓ 14 edits · 6 commands · 38s` (`•` instead of `✓` when a step failed), with the changed files on one line under
it (`  changed app.py, tests/test_app.py`, five at most, then `+N more`); a single step prints its own line. A failed command
prints its line and cause above the summary; a failed edit the model tried again at once is counted,
not printed. `/output all` lists every call of the last task on its own line. A command Casper refused before it ran (a private place such as `~/.ssh`, another machine
you said No to, or one a script run can't ask about) is not a failure: it reads
`• bash · cat ~/.ssh/config — not run`, with the reason said to you on the next line, and is not
counted as failed. The box also starts with `Waiting for <provider/model> · 0s` and ticks elapsed time
even when the provider sends no intermediate progress events; progress updates change it to reasoning
or tool preparation. It never displays hidden reasoning or generated arguments, and it is gone when
the receipt or the prompt returns. The plain terminal and scripts print one end line per tool call;
having no box, they also print `… bash · bun test` when a call other than a look or an edit is still running after two seconds,
so a long test run does not look hung.

Help and results group related facts instead of one long paragraph. Assistant
instructions favor the answer or action first, numbered human steps when needed,
and one concrete next action when work remains. Unknown checks, estimates and
remaining uncertainty stay explicit. This is guidance to the model; a provider's replies may not follow it.

The prompt box keeps a fixed two-column gutter: `❯` while idle, `…` while a
command is working, `?` while an exact approval is pending. The box never shifts
horizontally between states, so a draft keeps its wrapping. The footer shows a
state glyph (braille spinner while working, `○` idle, `? waiting for you` while a question,
checklist or approval needs you, with the spinner stopped and the timer paused), then project/branch, provider/model, effort,
estimated context occupancy, the current task's tokens and its cost from the model's price
(`task 48.2k tok · $0.31`; from the second task on, the session's total too, so a new task never
looks like a reset: `task 40.0k tok · session 1.1M tok · $0.04` while working, `session 1.1M tok · $0.04` idle; a free model shows tokens only; a subscription sign-in shows
`sub ≈$0.31`, what the tokens would cost pay-per-token; /usage has the session totals split into
out, new and cached, `44k out · 131k new · 4.9M cached`), and idle/working state. While a task runs, its stages
lead the footer, each marked ✓ once done, then the elapsed time:
`⠋ checklist ✓ · building ✓ · checks · 1m05s │ project…`; in a narrow window only the current stage
and the time (`⠋ checks · 1m05s │ …`). When the AI reads, lists or searches a folder outside the project (temp aside), one line under its
steps says where, once per folder: `[read] outside this project: ~/Projects`. Tool lines print paths relative to the project and fit one row:
narrow, the words go and a path is shortened from the front (`✓ edit · …st_calc.py · +9 -1 · 2.5s`). Each check Casper runs prints one line
as it finishes (`✓ typecheck · 5.9s`, `✗ test · exit 1 · 2.3s`, `✗ test · timed out after 10m`; a check
under a second shows no time), so a
pass is never silent; `--verbose` prints the full evidence line instead. When a request that ran for 10 seconds or
more finishes, or asks you something (a question, an approval, the checklist), Casper rings the
terminal bell; your terminal decides whether that is a sound, a flash or a dock bounce. Scripts,
one-shot runs and `--json` never ring. `—` means unavailable, `~`
means estimated. Branch is the project inspection snapshot; `/status` refreshes
it after external Git changes. Narrow terminals truncate the footer rather than
wrapping over input. Cost is not an invoice or subscription charge.
No green permission/verification badge is invented, and no ASK/BUILD mode is
implied: `/plan` plans one request, it is not a mode.

### Suggested next steps and plan first

After an interactive receipt, the row under it can offer a next step from slot 3 on (1 and 2 stay for
Undo and Show diff): `Next: 3 Add a test that proves this bug stays fixed (uses tokens)`. Each step's
reason is on its own line, and a step that saves something shows the exact text it will write
(`saves verify.test: uv run pytest in .casper/project.yaml`). Nothing waits: a lone number on the empty
prompt picks the step, and anything else you type is simply your next request. Casper's rules are local
and free; only a step marked "uses tokens" asks the model anything.

Two steps ship: "Add a test that proves this bug stays fixed" (a fix whose tests pass without it too)
and "Remember <command> as this project's test command" (the model ran a known test runner, such as
`uv run pytest`, `python -m pytest` or `bun test` with plain test paths, while the project had no test
command; any other command is never offered). A step you leave three times in a row in a project is
hidden there for 14 days; picking it resets that. `/suggestions` lists each step as on, off or faded;
`/suggestions off [name]` and `/suggestions on [name]` switch them; `suggestions: false` in
`~/.casper/config.yaml` turns them all off. One-shot runs and `--json` never show them.

Before work, a build request with several asks can get one extra choice folded into the checklist
panel, so there is still one panel: `Suggested: plan first — this asks for 4 things` with 1 Plan first,
2 Just build (with the listed cases) and 3 Edit the cases first. A typed yes plans first and a typed
no just builds; other typed text is one more case to test. A request that already lists its
requirements (two or more list lines, most with a detail such as a command, number, file or example)
is built as asked, with no question. Plan first (or `/plan <request>`) runs a
plan turn: the model may only read (read, grep, find, ls and look-only shell commands such as `ls`,
`cat` or `git log`); every other tool, MCP and Casper's own tools included, is refused with "Planning
only". This is Casper's gate, not a sandbox, and a file that changed anyway is named on the receipt
(`• Changed while planning: …`). The plan and its cases open in the editor: edit the lines, then Enter
goes on to "Build this plan?" (1 Stop · 2 Build, so Enter builds nothing); Esc stops without
building. The plain terminal shows the plan and asks the same question, and a run that cannot ask
stops after showing the plan.

### Layout stability

The `/` command popup and `/model` and `/effort` pickers are composited over the
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
are rendered once per width and cached; only the open tail line and the unfinished
tail of a streaming assistant message re-render per frame.

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
pinned to `@earendil-works/pi-tui` 0.87.0).
`tests/fixtures/layout-pty.py` drives the offline demo through a bounded 24x80
VT emulator that scrolls, and fails on footer creep, scrollback wipes from
popups/pickers, or a duplicated prompt box (`bun test tests/terminal-layout.test.ts`;
`SHOW=1 python3 tests/fixtures/layout-pty.py $(which bun)` prints every screen).

### Model and effort

- `/model`: Casper's full-screen model browser — a provider sidebar (Tab focuses it;
  Up/Down switch login groups like github-copilot/openrouter), search-backed model rows
  with context, price and capability columns, and a selected-model summary footer.
  **Enter remembers globally** in Casper's settings; **Ctrl+S selects for this session
  only**. Escape/Ctrl+C cancel.
- A fresh interactive session clears the viewport at startup: the new session renders from
  the top of the screen and the previous run's transcript stays in scrollback.
- While a prompt runs or tool activity is on screen, the footer state dot and the Working
  panel title animate (braille spinner) so background work is visibly moving, and the
  footer appends elapsed time (`· 1m35s`); idle shows ○ with no timer.
- `/model provider/id`: exact selection, remembered globally. During a task it applies from the
  model's next step, like `/effort` (see Input and commands).
- `/model --session [provider/id]`: explicitly temporary selection/picker.
- `/effort`: automatic or supported fixed-effort picker in an interactive terminal, otherwise a list.
  `auto` is always a choice. On a rich terminal, **Shift+Tab** cycles that same list and remembers
  the level it stops at (saved once, when you stop pressing). `/effort <level>` remembers too;
  `--session` opts out.
- `/effort high`: apply and remember for that model. Unsupported levels fail.
- `/effort high --session`: do not change the saved preference. Effort also survives
  switching away from a model and back within the current conversation.
- `/effort auto`: classify each raw request before generation. `/status`, the
  `[model]` start line and the footer show `effort auto → <level>`; before the first
  request that reads `auto → <level> for now; your first request picks the level`,
  and `(fallback)`/`(unavailable)` follows when it could not classify, with an `[effort]`
  notice in the transcript). A fixed level disables it.
- `/model roles`: inspect optional `fast`, `build`, `reason`, `review` mappings.
- `/model role review provider/id:high`: save a shortcut without selecting it.
- `/model --session @review:auto`: resolve that shortcut with an explicit effort
  override for this conversation. `@default` resolves the saved concrete model.

Restored conversations retain their recorded model/effort. Missing credentials or
an unavailable model still block sending rather than silently choosing another
provider. Pi CLI defaults are neither read nor rewritten. Selecting a model generates no
model response; subsequent requests send context to the selected provider.
Explorer/reviewer children use Casper roles or its startup default. Auto effort
makes one extra bounded current-request-only classifier call using `fast`, or
the selected model if unset; no history or skills are sent to the classifier.
This can cross providers when `fast` is configured. See [CONFIGURATION.md](CONFIGURATION.md)
for precedence, cancellation, persistence and the four-second fallback policy.
Classifier usage is shown separately in `/usage` for the loaded session instance;
unreported failed-request cost is unknown, not zero.

### Provider login

`/login` shows one numbered list of providers and ways to sign in, OpenRouter first:
1 OpenRouter · paste an API key, 2 OpenRouter · sign in with your browser, 3-4 the same for
Anthropic (Claude), then OpenAI Codex and GitHub Copilot. OpenAI Codex opens your browser on
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
Escape/Ctrl-C cancel; EOF and shutdown drain the login lifecycle. A failed sign-in says the reason
Casper has in plain words (timed out, couldn't reach the provider, the provider refused it) and
never the provider's own text. A model whose provider has no sign-in names that provider, its
`/login` and its key variable (for example `OPENROUTER_API_KEY`); a one-shot run or a plain
terminal with nothing signed in says `Not signed in yet. Run casper in a terminal and type /login.`
A one-shot run with a key set but no model Casper can pick says
`No Casper model selected. Pass --model <provider/model>, or run casper and type /model.`

If you skip `/login`, Casper opens sign-in on your first request and picks that provider's
default model (OpenRouter: `deepseek/deepseek-v4.1-flash`). `/model` picks another; Casper never
replaces a model you chose. Type keys or codes only in the private login prompt, never in chat.
Your provider's plans and charges still apply.

The list reuses Pi's selection list: a digit picks its row at once, Up/Down moves the
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
  and a second Enter submits. An exact command submits literally.
- `@`/Tab offers file-path completion. This inserts a reference; it does **not**
  attach/read the file or grant additional permissions. Unsafe control-bearing
  completion labels are omitted.
- Pictures: Ctrl+V (Alt+V on Windows) pastes the clipboard's picture as `[image 1]`, and
  a picture file dropped or typed as a full path (`/…/shot.png`, `~/…`, `C:\…`) becomes
  `[image N]` when you send, also at the start of the line (then it is a request, not a
  command). PNG, JPEG, GIF and WebP, up to 20 MB each (a pasted picture too) and 8 a
  request. With no picture on the clipboard, files you copied in Finder, Explorer or a
  Linux file manager go in as quoted paths, as if dropped: a picture file among them is
  attached when you send, with the same checks and limits; any other file stays as its
  path. A name with a control or bidi character is left out, and says so. On a Mac the
  copied files are looked for first, since Finder also puts the file's icon on the
  clipboard as a picture. Casper reads the list with the system's own tool (`osascript`,
  Windows PowerShell, `wl-paste` or `xclip`), for at most a few seconds. With neither,
  its text is pasted like any paste, with terminal control codes taken out. A dropped file's
  path stays on a line under the request, so the AI can still copy it. A pasted picture is
  saved to a private temp folder, deleted when Casper closes, and its path goes on the same kind of line. A bare name like
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
  Typing still accepts a custom answer, and Esc skips. A number picks a choice only
  while nothing is typed, so a custom answer cannot start with a choice's number
  (type a letter first); a digit past the last choice is ordinary text.
- A question from the AI's `ask` tool starts with a muted `The AI asks:` line. Casper's own
  questions and approvals never do, so the AI can't pass off a question as a Casper approval.
- Every box takes the same input: approvals (an MCP change, a host, a shell command, a device
  check, `/mcp writes`) are the same numbered panel as any question. Press a choice's number
  (no Enter), or Up/Down and Enter; Esc is No. An approval takes no typed answer: typed words are
  a No. Keys pressed in the first moment after a box opens (about 0.3 s) are ignored, so a key
  typed mid-sentence never answers a box that just appeared.
- Casper's own numbered questions and approvals also work on the plain terminal: it prints the
  choices as numbered lines and reads `Type 1, 2 or 3:`; a number or a choice's words pick
  it. Enter picks choice 1, and at every Casper question choice 1 is the one that does nothing
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
  empty editor the first Ctrl+C only shows `Ctrl-C again to exit`; a second within two
  seconds exits, any other key disarms it. Ctrl+D exits an empty editor at once.
  Ctrl+L forces a redraw.
- Enter during work runs a command that only shows something at once: `/help`, `/status`,
  `/usage`, `/context`, `/permissions`, `/diff`, `/receipt`, `/output`, `/tasks` (and
  `/tasks stop <n>`), `/details`, `/mcp`, `/lsp`, `/skills`, `/sandbox`, `/secrets`, `/tree`,
  `/project`, `/effort` (a bare `/effort` opens its picker; an approval that arrives closes
  it first) and `/model` (the picker, `/model <provider/id>` or `/model --session <provider/id>`:
  the model's next step uses it, `[model] <provider/id> from the model's next step; saved`; the step
  already running keeps its model; an approval that arrives closes the picker first, and so does
  the end of the model's work). `/model role` and `/model big` wait for the task. Typing `/` keeps the command menu; the commands that must wait are dimmed and say
  `waits for this task`. Any other command keeps its draft and says why for a moment
  (`/undo waits until this task ends · draft kept`).
- A line you start with `?` (`? what does ECONNRESET mean`), idle or during work, is a side
  question: one separate call to your fast model (or your model when no fast one is set up) with no
  tools. It gets a short summary of the session (the project name, the task's first line and the
  tool names used lately; no file contents and no secrets). The answer shows as an indented side
  answer that names the model (`? side answer · <provider/id> · not part of the conversation`); it
  is not added to the conversation, so the working AI never sees it. `/usage` counts its tokens
  and cost. A bare `?`, a `?` inside text and a pasted `?` line are ordinary requests, and so is
  every line of a one-shot run. Esc stops one asked while idle. `/settings` → "Side questions
  with ?" turns them off (`sideQuestions: false`).
- Words at the start of a request (`think hard:`, `quick:`, `big model:`, `fast model:`,
  `plan first:`) and `ultrathink` anywhere in it set that task only; see
  [Words you can use](#words-you-can-use).
- Anything else you type during work goes to the AI. While the model is working it reads the
  line at its next step (`↳ sent to Casper · it reads this at its next step`); while Casper
  runs checks or writes the receipt, the line is queued and runs as the next request
  (`↳ queued · runs when this task ends`). A line the AI never got to read runs next too. Esc
  stops the task and puts queued lines back in the prompt instead of running them. Queued
  lines live outside the prompt, so a queued line never answers an approval box.
  Pickers borrow exclusive input ownership; pretyped text cannot answer a later
  exact approval. NO_COLOR keeps input controls, while TERM=dumb/redirected output
  uses plain line input and retains existing fail-closed cooked-terminal approval.
  Plain lines that arrive before the first prompt (a fast typist, or a pipe) are
  read in order once Casper starts reading. On a plain terminal, lines a person types during
  work go to the AI or the queue as above; piped lines that arrive during work are dropped.

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
| `/tree`, `/switch <name>` | Existing named-workspace navigation and its approval policy |
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
`/permissions` explains actual boundaries from the state Casper is in: whether the shell
sandbox holds shell commands and checks here, or (without it) that the AI's shell asks
before each command that changes something (reads like `ls` don't). `/sandbox` lists what it holds and `/allowed` the commands you said yes to. Existing integration-specific
approvals remain in force. Verification is still separate from tool completion.

### Local debugger

`/debug` lists project targets/status without a model or adapter. Configure
`.casper/debug.json`, then `/debug start <target>` for fresh exact execution consent.
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

This offline demo uses synthetic model/effort choices and activity. It makes
no model calls, edits no source files and saves no preferences. Send a message for
streaming Markdown/code/tables; try `/approve`, `/error`, `/status`, `/model` and
`/effort`, then resize while editing a draft. It exercises the production terminal
surface, not live-model usefulness or human visual sign-off.

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
