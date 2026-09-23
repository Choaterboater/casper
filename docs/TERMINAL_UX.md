# Terminal UX — daily-use interface

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
`CASPER <version> · your coding companion` header instead; `NO_COLOR` keeps the
art and drops the color. The wordmark is constant text written past the untrusted
line classifier (`InteractiveTerminal.writeTrusted`), which is never used for
model or tool output.

Transcript lines are inline, not boxed: `✓`/`✗`/`•` tool lines, `[model]`,
`[approval]`, `[task]` and similar bracketed notices, and the `❯ …` echo of each
prompt. Green marks success, red an error, amber a notice or decision, cyan the
accent (banner, prompt echo, Markdown structure), dim the muted status lines.
Bordered panels (`src/tui/presentation.ts`) are used for code-like output and
live work status: every fenced block in an assistant message is boxed and titled
with its language, `/output` replays a tool result in a box, `/diff` boxes `git status` and
the colored unified diff, a failed check boxes the tail of its stderr and stdout
(last 40 lines; the full output stays in the evidence), and exclusive input flows such as `/login` use them.
Prose, notices and tool lines stay inline. Panels never exceed 120 columns: code is
read line by line, and a box spanning a very wide window is only empty border. Color always accompanies a readable label; tool completion
does not mean a check passed. `NO_COLOR` keeps the structure without color, while
redirected output and `TERM=dumb` use plain text.

Assistant text streams through Pi's Markdown renderer, including code and tables.
The in-progress message is shown as the transcript's uncommitted tail. Completed
blocks are reused; only the open tail is re-parsed, and the result matches a full
render (lists, fences and wrapped emphasis stay correct across chunk boundaries).
When the message ends, its rendered lines are committed once. The source Markdown
is kept per message so a width change re-renders it rather than re-wrapping old output. Text still passes
`terminalText()` before rendering. Links show their destination as inert text —
the URL in parentheses instead of an OSC 8 hyperlink. Login URLs and device codes
stay on standalone lines so frames do not become part of a copied value. Captured
tool errors and verifier stdout/stderr remain available with display-only
redaction; this is not a general secret detector, and recorded evidence is unchanged.

Tool activity shows file/command targets (grep/find show their pattern), state and
elapsed time. On a rich terminal the `• … — running` line is redrawn in place as
`✓`/`✗` when that call finishes, so each tool call occupies one transcript line;
any other output in between commits the running line first. A transient `Working`
box starts with `Waiting for <provider/model> · 0s` and ticks elapsed time even
when the provider sends no intermediate progress events. Progress updates change it
to reasoning or tool preparation; tool events show their safe target and state.
It never displays hidden reasoning or generated arguments, and clears when
assistant text streams.

Help and results group related facts instead of one long paragraph. Assistant
instructions favor the answer or action first, numbered human steps when needed,
and one concrete next action when work remains. Unknown checks, estimates and
remaining uncertainty stay explicit. This is guidance, not a guarantee of any
provider's responses.

The prompt box keeps a fixed two-column gutter: `❯` while idle, `…` while a
command is working, `?` while an exact approval is pending. The box never shifts
horizontally between states, so a draft keeps its wrapping. The footer shows a
state dot (`●` working, `○` idle), then project/branch, provider/model, effort,
estimated context occupancy, runtime-reported session tokens, a positive cost
estimate when available, and idle/working state. `—` means unavailable, `~`
means estimated. Branch is the project inspection snapshot; `/status` refreshes
it after external Git changes. Narrow terminals truncate the footer rather than
wrapping over input. Cost is not an invoice or subscription charge.
No green permission/verification badge is invented, and no unimplemented
ASK/PLAN/BUILD mode is implied.

### Layout stability

The `/` command popup and `/model` and `/effort` pickers are composited over the
bottom of the transcript instead of appended below it. Opening and closing them
does not scroll the terminal; covered transcript rows return unchanged.
Login panels instead follow the transcript, keeping standalone authorization URLs
and device codes visible above the current panel. They are transient components,
not transcript entries: navigation replaces rows and completed panels disappear.
Pickers and login share the live surface's renderer and footer; login borrows raw
input without starting a second terminal renderer. Finished transcript entries
are rendered once per width and cached; only the open tail line and the unfinished
tail of a streaming assistant message re-render per frame.

Ctrl+L and a width change still repaint from the top, matching Pi's renderer:
both clear the visible screen and the terminal's scrollback and reprint the whole
transcript at the new width. A rows-only resize does not: `StableMainScreen`
(`src/tui/surface.ts`) shifts Pi's remembered viewport by the height delta before
delegating, the same adjustment Pi's Termux branch makes, so shrinking or growing
the window keeps scrollback intact (`tests/daily-terminal.test.ts` asserts no
`ESC[3J` for a rows change and a repaint for a columns change; the field access is
pinned to `@earendil-works/pi-tui` 0.85.1).
`tests/fixtures/layout-pty.py` drives the offline demo through a bounded 24x80
VT emulator that scrolls, and fails on footer creep, scrollback wipes from
popups/pickers, or a duplicated prompt box (`bun test tests/terminal-layout.test.ts`;
`SHOW=1 python3 tests/fixtures/layout-pty.py $(which bun)` prints every screen).

### Model and effort

- `/model`: Pi's searchable model picker. **Enter remembers globally** in Casper's
  settings; **Ctrl+S selects for this session only**. Escape/Ctrl+C cancel.
- `/model provider/id`: exact selection, remembered globally.
- `/model --session [provider/id]`: explicitly temporary selection/picker.
- `/effort`: automatic or supported fixed-effort picker in an interactive terminal, otherwise a list.
  `auto` is always a choice. On a rich terminal, **Shift+Tab** cycles that same list for this
  conversation only (it does not save). `/effort <level>` remembers; `--session` opts out.
- `/effort high`: apply and remember for that model. Unsupported levels fail.
- `/effort high --session`: do not change the saved preference. Effort also survives
  switching away from a model and back within the current conversation.
- `/effort auto`: classify each raw request before generation. `/status`, the
  `[model]` start line and the footer show `reasoning auto → <level>` plus the
  classifier state while it is not simply classified (`pending` before the first
  request, `fallback`/`unavailable` when it could not classify, with an `[effort]`
  notice in the transcript). A fixed level disables it.
- `/model roles`: inspect optional `fast`, `build`, `reason`, `review` mappings.
- `/model role review provider/id:high`: save a shortcut without selecting it.
- `/model --session @review:auto`: resolve that shortcut with an explicit effort
  override for this conversation. `@default` resolves the saved concrete model.

Restored conversations retain their recorded model/effort. Missing credentials or
an unavailable model still block sending rather than silently choosing another
provider. Shared Pi defaults are not rewritten. Selecting a model generates no
model response; subsequent requests send context to the selected provider.
Explorer/reviewer children use Casper roles or its startup default. Auto effort
makes one extra bounded current-request-only classifier call using `fast`, or
the selected model if unset; no history or skills are sent to the classifier.
This can cross providers when `fast` is configured. See [CONFIGURATION.md](CONFIGURATION.md)
for precedence, cancellation, persistence and the four-second fallback policy.
Classifier usage is shown separately in `/usage` for the loaded session instance;
unreported failed-request cost is unknown, not zero.

### Provider login

`/login` offers Codex and GitHub Copilot device-code login, Anthropic/Claude API-key
or browser sign-in, and OpenRouter API-key login. `/login <provider-id>` skips only the
provider chooser. Every method requires fresh consent to provider-scoped shared
credential replacement; login does not select a model. Browser opening is manual.
Keys and callback codes/URLs use a separate hidden prompt, never chat/history.
Escape/Ctrl-C cancel; EOF and shutdown drain the login lifecycle.

Provider and method choices reuse Pi's selection list: Up/Down moves the visible
highlight in place, Enter confirms that item, and Cancel exits without contacting
the provider. Navigation accepts Pi's decoded arrow/Enter sequences, including
fragmented or batched terminal input. Trailing keys cannot answer the next prompt;
pasted text cannot grant consent or submit a private credential.
All login panels render through the host surface; terminal-control bytes never
pass through the untrusted-text sanitizer or get appended as transcript text.

This picker correction is in source, not the published v0.1.0 binaries. macOS PTY
coverage exercises rendering and complete synthetic login flows; Windows-host
verification of this correction is still pending.

Copilot login may enable account model policies. Pi documents Claude subscription
auth as billed extra usage. OpenRouter API usage is billed from credits. Callback
listeners are loopback-only for Claude browser sign-in. Plain terminals remain guidance
only. See [platform support](PLATFORM_SUPPORT.md) for host-validation limits.

### Input and commands

- Type `/` for a fuzzy list. Tab completes; Enter on a partial choice inserts it,
  and a second Enter submits. An exact command submits literally.
- `@`/Tab offers file-path completion. This inserts a reference; it does **not**
  attach/read the file or grant additional permissions. Unsafe control-bearing
  completion labels are omitted.
- Clarification questions keep the question on its own line. Use Up/Down and Enter
  to choose; Space toggles multi-select choices. Typing still accepts a custom
  answer, and Esc skips.
- Up/Down recalls current-process prompt history. Shift+Enter where the terminal
  supports it, or Ctrl+J, inserts a newline. Bracketed paste stays in the draft.
- Shift+Tab cycles reasoning effort (`auto`, then the model's supported levels) without
  opening `/effort` and without changing the saved preference. It does nothing while work,
  an approval, or a clarification is in progress, and it is unavailable on a plain terminal.
- Escape stops active work. Ctrl+C cancels work; when idle it clears a draft. On an
  empty editor the first Ctrl+C only shows `Ctrl-C again to exit`; a second within two
  seconds exits, any other key disarms it. Ctrl+D exits an empty editor at once.
  Ctrl+L forces a redraw.
- Enter during work retains the draft, never queues an automatic next request.
  Pickers borrow exclusive input ownership; pretyped text cannot answer a later
  exact approval. NO_COLOR keeps input controls, while TERM=dumb/redirected output
  uses plain line input and retains existing fail-closed cooked-terminal approval.
  Plain lines that arrive before the first prompt (a fast typist, or a pipe) are
  read in order once Casper starts reading; lines typed during work are dropped.

Daily commands include `/help`, `/status`, `/project`, `/diff`, `/verify`, `/skills`,
`/mcp`, `/lsp`, `/browser`, `/permissions`, `/model`, `/effort` and:

| Command | Effect |
| --- | --- |
| `/context` | Runtime context estimate and counts; no invented per-file token attribution |
| `/usage` | Input/output/cache/session tokens and optional catalog cost estimate, not billing |
| `/compact [instructions]` | Explicit cancellable model-assisted summary; **can make a model request** |
| `/clear` | Fresh saved conversation, no workspace rollback; prior conversation remains resumable |
| `/resume` | List saved conversation IDs in this workspace |
| `/resume <exact-id>` | Restore one of those conversations, keeping named workspace linkage consistent |
| `/tree`, `/switch <name>` | Existing named-workspace navigation and its approval policy |
| `/output [n]` | Full retained output of the last task's n-th most recent tool call (1 = latest; 20 retained per task); out-of-range n is a usage error |

`/diff` shows Git status and tracked changes against HEAD, without external diff or
textconv drivers. Untracked names are listed, not file contents. Each Git command
has a five-second deadline and 64 KiB output limit; large output is marked truncated.
After a task that changed files, the receipt names the changed paths (from a before/after
tree digest) and a git workspace appends a bounded `git diff --stat` under the same limits.
`/permissions` explains actual boundaries: native coding tools are not sandboxed
and there is no universal shell confirmation gate. Existing integration-specific
approvals remain in force. Verification is still separate from tool completion.

### Local debugger

`/debug` lists project targets/status without a model or adapter. Configure
`.casper/debug.json`, then `/debug start <target>` for fresh exact execution consent.
`/debug breakpoints <path> <1,2|clear>`, `threads`, `stack <thread>`, `scopes <frame>`,
`variables <handle>`, `continue <thread>` and `stop` provide bounded local inspection.
Handles expire when execution resumes. Values may contain secrets; they are neither
verification nor automatic model context. Use `/debug stop` when the editor is idle;
active-command cancellation and session/workspace/model transitions revoke debugging.
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
