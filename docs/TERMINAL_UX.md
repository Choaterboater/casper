# Terminal UX — daily-use interface

**What this is:** a guide to Casper's terminal screen: what you see, the keys,
and the `/` commands. **When you'd use it:** when you are learning Casper, or
want to know what a symbol, key or command does. `/help` shows a short list in
Casper, and `/help all` the full one.

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
| Ctrl+L | Redraw the screen |
| Ctrl+O | Turn MCP writes off for every server at once (see [MCP.md](MCP.md)) |

### Commands

These commands run on your machine. Only `/compact`, `/delegate` and
`/verify repair` send a model request. `/model` may fetch provider model lists
over the network, and `/references add` downloads files after asking you.

| Command | What it does |
| --- | --- |
| `/help`, `/help all` | Short help, or the full reference |
| `/status` | Model, login, integrations and local storage |
| `/model`, `/effort` | Pick a model or reasoning effort (see [Model and effort](#model-and-effort)) |
| `/login [provider]` | Sign in to a provider (see [Provider login](#provider-login)) |
| `/context`, `/usage` | Context estimate; session tokens and estimated cost |
| `/compact [instructions]` | Summarize the conversation (**makes a model request**) |
| `/clear`, `/resume [id]` | New conversation; list or reopen a saved one |
| `/diff` | Git status and tracked changes against HEAD |
| `/output [n]` | Full output of a recent tool call from the last task |
| `/pane [on\|off]` | The steps split beside Casper inside tmux or iTerm2 (only on a window 120+ columns wide); saved for every session. See [TMUX.md](TMUX.md) |
| `/receipt` | Detailed evidence behind the last task's receipt |
| `/verify [checks]`, `/verify repair` | Run the project's checks; repair failures |
| `/project`, `/permissions` | Project context; what is and is not enforced |
| `/skills`, `/references`, `/memory`, `/secrets` | Skills; local reference search; saved facts ([MEMORY.md](MEMORY.md)); secret hiding ([SECRETS.md](SECRETS.md)) |
| `/mcp`, `/lsp` | MCP servers ([MCP.md](MCP.md)); language servers ([LSP.md](LSP.md)) |
| `/browser`, `/services`, `/debug` | Browser ([BROWSER.md](BROWSER.md)); dev servers ([SERVICES.md](SERVICES.md)); debugger ([DEBUGGER.md](DEBUGGER.md)) |
| `/tree`, `/branch`, `/switch` | Named sessions and worktrees ([SESSIONS.md](SESSIONS.md)) |
| `/delegate <explorer\|reviewer> <goal>` | Read-only helper agent ([DELEGATION.md](DELEGATION.md)) |
| `/visualize [repo [dir]]` | Diagrams ([VISUALIZATION.md](VISUALIZATION.md)) |
| `/exit`, `/quit` | Exit |

An unknown `/` command is rejected on your machine. It is never sent to a model.

## Current interface

Run `casper` in your project. The interactive terminal uses Pi's main-screen
renderer/editor: ordinary scrollback above an anchored multiline prompt and a
persistent footer, with no alternate-screen takeover. Casper owns the terminal
before it prints the startup banner, so the banner, model status and diagnostics
are transcript lines like everything else. A model is not started just to paint
the footer. A saved default is shown as an advisory startup snapshot; after
runtime initialization the footer uses the active conversation's model.

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
while it runs, `✓ read · src/x.ts` once done), even with calls running side by side. When the model
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
- `/model provider/id`: exact selection, remembered globally.
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

`/login` offers Codex and GitHub Copilot device-code login, Anthropic/Claude and
OpenRouter API-key or browser sign-in. `/login <provider-id>` skips only the
provider chooser. Every method requires fresh consent to provider-scoped
credential replacement in Casper's store (`~/.casper/agent/auth.json`); login does not select a model. Browser sign-in opens the system
browser automatically; offline mode (CASPER_OFFLINE=1) suppresses the launch and keeps the URL
printed for manual opening.
Typed API keys are verified with the provider before they are stored; a rejected
key is never saved, and a key that cannot be verified (network or provider error)
can be retried, saved explicitly, or cancelled. Keys and callback codes/URLs use a
separate hidden prompt (live character count, contents never rendered), never chat/history.
Escape/Ctrl-C cancel; EOF and shutdown drain the login lifecycle.

Provider and method choices reuse Pi's selection list: Up/Down moves the visible
highlight in place, Enter confirms that item, and Cancel exits without contacting
the provider. Navigation accepts Pi's decoded arrow/Enter sequences, including
fragmented or batched terminal input. Trailing keys cannot answer the next prompt;
pasted text cannot grant consent or submit a private credential.
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
- Casper's own numbered questions (a new project, one more repair on your big model, a lab check,
  security tools and ignores, Build this plan?) also work on the plain terminal: it prints the
  choices as numbered lines and reads `Type 1-3 (Enter for 1)`; a number or a choice's words pick
  it. Enter picks choice 1, and at every Casper question choice 1 is the one that does nothing
  risky (Stop, Skip, Not now, Use this folder, Leave it, No, Just this time, Keep writes off, Keep the
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
  `/project`, and `/effort` (a bare `/effort` opens its picker; an approval that arrives closes
  it first). Typing `/` keeps the command menu; the commands that must wait are dimmed and say
  `waits for this task`. Any other command keeps its draft and says why for a moment
  (`/undo waits until this task ends · draft kept`).
- Anything else you type during work goes to the AI. While the model is working it reads the
  line at its next step (`↳ sent to the AI · it reads this at its next step`); while Casper
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
| `/clear` | Fresh saved conversation, no workspace rollback; prior conversation remains resumable |
| `/resume` | Pick a saved conversation from a numbered list (title · when · messages; 1 stays here); then the last few turns show |
| `/resume <id>` | Go back to that conversation; the first few characters of its ID are enough |
| `/tree`, `/switch <name>` | Existing named-workspace navigation and its approval policy |
| `/output [n]` | Full command and output of the last task's n-th most recent tool call (1 = latest; 20 retained per task); out-of-range n is a usage error |

`/diff` shows Git status and tracked changes against HEAD, without external diff or
textconv drivers. Untracked names are listed, not file contents. Each Git command
has a five-second deadline and 64 KiB output limit; large output is marked truncated.
After a task that changed files, the receipt names the changed paths (from a before/after
tree digest), or how many past three. The per-file table (a bounded `git diff --stat`) is shown
with `--verbose`; `/diff` shows the task's full changes.
`/permissions` explains actual boundaries from the state Casper is in: whether the shell
sandbox holds shell commands and checks here, or (without it) that the AI's shell asks
before each command. `/sandbox` lists what it holds. Existing integration-specific
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
is not automatically redacted. There is no workspace rollback, automatic shell
shortcut, queued prompt execution or enforced permission-mode selector.

## Design references and reuse

The layout is inspired by [OMP](https://github.com/can1357/oh-my-pi) and uses the
installed Pi renderer, editor, Markdown and selectors. Wording guidance is informed
by [i-have-adhd](https://github.com/ayghri/i-have-adhd), without assuming a diagnosis
or installing its plugin. Both references publish MIT licenses; attribution and
license notices are retained in `THIRD_PARTY_NOTICES.txt`. Casper keeps its own
identity and does not bundle OMP as another runtime.
