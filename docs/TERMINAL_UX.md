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

The prompt box keeps a fixed two-column gutter: `❯` while idle, `…` while a
command is working, `?` while an exact approval is pending. The box never shifts
horizontally between states, so a draft keeps its wrapping. The footer shows a
state dot (`●` working, `○` idle), then project/branch, provider/model, effort,
estimated context occupancy, runtime-reported session tokens, a positive cost
estimate when available, and idle/working state. `—` means unavailable, `~`
means estimated. Branch is the project inspection snapshot; `/status` refreshes
it after external Git changes. Narrow terminals truncate the footer rather than
wrapping over input. Cost is not an invoice or subscription charge. No green
permission/verification badge is invented, and no unimplemented ASK/PLAN/BUILD
mode is implied.

### Layout stability

Anything that is taller than the prompt box — the `/` command popup, the
`/model` and `/effort` pickers, the login notice — is composited over the
bottom of the transcript instead of appended below it. Opening and closing it
never scrolls the terminal and never leaves blank rows under the footer; the
covered transcript rows return unchanged. Pickers and login run inside the live
surface: the transcript and footer stay visible, the terminal is not stopped,
and no screen clear happens when they finish. Finished transcript entries are
rendered once per width and cached; only the open tail line and the assistant
message still streaming re-render per frame.

Assistant messages are Markdown. The in-progress message is re-rendered whole
through Pi's `Markdown` component on every delta (so lists, fences and wrapped
emphasis are correct across chunk boundaries) and shown as the transcript's
uncommitted tail; when the message ends its rendered lines are committed once.
The source Markdown is kept per message so a width change re-renders it rather
than re-wrapping old output. Headings, links, inline/fenced code and list bullets
use the accent color, fence borders/quotes/rules are dim; with `NO_COLOR` every
theme function is identity. Text still passes `terminalText()` before rendering,
and links print their URL in parentheses instead of hiding it behind an OSC 8
hyperlink.

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
- `/effort`: supported-level picker in an interactive terminal, otherwise a list.
- `/effort high`: apply and remember for that model. Unsupported levels fail.
- `/effort high --session`: do not change the saved preference. Effort also survives
  switching away from a model and back within the current conversation.

Restored conversations retain their recorded model/effort. Missing credentials or
an unavailable model still block sending rather than silently choosing another
provider. Shared Pi defaults are not rewritten. Selecting a model generates no
model response; subsequent requests send context to the selected provider.
Delegation/learning retain their separately documented model-default policy.

### Provider login

`/login` offers Codex and GitHub Copilot device-code login, plus Anthropic/Claude
and OpenRouter API-key or browser sign-in. `/login <provider-id>` skips only the
provider chooser. Every method requires fresh consent to provider-scoped shared
credential replacement; login does not select a model. Browser opening is manual.
Keys and callback codes/URLs use a separate hidden prompt, never chat/history.
Escape/Ctrl-C cancel; EOF and shutdown drain the login lifecycle.

Copilot login may enable account model policies. Pi documents Claude subscription
auth as billed extra usage; OpenRouter browser sign-in mints a permanent key billed
from credits. Callback listeners are loopback-only. Plain terminals remain guidance
only. See [multi-provider review](MULTI_PROVIDER_LOGIN_REVIEW.md) for evidence/limits.

### Input and commands

- Type `/` for a fuzzy list. Tab completes; Enter on a partial choice inserts it,
  and a second Enter submits. An exact command submits literally.
- `@`/Tab offers file-path completion. This inserts a reference; it does **not**
  attach/read the file or grant additional permissions. Unsafe control-bearing
  completion labels are omitted.
- Up/Down recalls current-process prompt history. Shift+Enter where the terminal
  supports it, or Ctrl+J, inserts a newline. Bracketed paste stays in the draft.
- Escape stops active work. Ctrl+C cancels work; when idle it clears a draft, then
  exits when empty. Ctrl+D exits an empty editor. Ctrl+L forces a redraw.
- Enter during work retains the draft, never queues an automatic next request.
  Pickers borrow exclusive input ownership; pretyped text cannot answer a later
  exact approval. NO_COLOR keeps input controls, while TERM=dumb/redirected output
  uses plain line input and retains existing fail-closed cooked-terminal approval.

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

This throwaway demo uses synthetic model/effort choices and fake activity. It makes
no model calls, edits no source files and saves no preferences. Try typing, history,
multiline input, `/model`, `/effort`, resizing and cancellation. It exercises the
same terminal surface; it is not a live-model usefulness trial or human visual sign-off.

### Validation and remaining scope

Latest full isolated serial gate: **518 tests passed / 5,345 assertions**, 45 files,
TypeScript clean. See [Phase 10 release review](PHASE10_DEBUGGER_REVIEW.md),
[login review](MULTI_PROVIDER_LOGIN_REVIEW.md) and
[daily-use review](DAILY_TERMINAL_REVIEW.md) for evidence and corrections. Real POSIX PTYs cover model/effort pickers, login input ownership,
fresh approvals, cancellation, color/NO_COLOR and the demo's resize. Public editor
stream tests cover multiline/history and narrow widths. Windows, exhaustive
terminal compatibility and pathological pastes/very long transcript performance
are not certified. Conversation/token data is not automatically redacted storage.

Deferred: new permission presets, enforced ASK/PLAN/BUILD modes, `/undo`, automatic
`!` shell execution, symbol-reference indexing, external-editor integration,
queued prompts, animations/themes and additional clients. These are not hidden
behind decorative controls. Existing native tools and explicit checks remain usable.

## Historical readline checkpoint

The remainder records the earlier implementation and its then-current limits.
Its old keybindings/counts do not override the current interface above.

Scope: quiet opt-in skill discovery and a usable readline-based CLI. This is not
Phase 9 acceptance, a full TUI rewrite, or a live-model usefulness trial.

This is the historical first-slice report. The subsequent
[Casper-owned model selection slice](MODEL_SELECTION.md) adds a temporarily hosted
Pi picker; the “no model picker” limit below describes this earlier checkpoint.

## Shipped behavior

See [README Skills](../README.md#skills) for import configuration and trust policy,
and [Interactive terminal](../README.md#interactive-terminal) for controls.

- Casper-only discovery by default. User/profile `skills.imports` explicitly
  enables compatible roots. Ordinary Markdown is ignored; malformed declared
  skills retain diagnostics behind one startup summary and `/skills diagnostics`.
- `src/tui/terminal.ts` owns transcript rendering, draft/cursor state, busy Enter,
  cancellation and exclusive confirmation input. App output goes through this
  module; the execution, consent and evidence owners remain unchanged.
- Markdown assistant messages, target-bearing tool activity with elapsed time and bounded
  redacted errors, concise help/startup, `/help all`, `/status` and `/login` guidance.
- Runtime identity comes from the active Pi session and its local auth snapshot.
  Startup remains lazy: status before a model session explicitly says unchecked.
  Status does not resolve credentials, refresh OAuth, or test provider connectivity.
- Ctrl-C retains the session and existing changes. Cancellation at auth preflight
  is checked again before provider execution. A pretyped draft is never an answer
  to a later approval. Ctrl-C/EOF deny pending confirmations. Plain piped-input
  fragments are discarded at approval transitions; actual cooked TTY input with
  `TERM=dumb` or redirected output cannot grant exact approval (fails closed).
- General successful conversation without observed effects/checks omits only the
  terminal task receipt. Structured task results and outcomes remain; coding,
  mutation, verification, failure and cancellation receipts remain visible.

## Regression loops

```sh
bun test tests/terminal-discovery.test.ts tests/phase2-skills.test.ts
bun test tests/terminal-ux.test.ts tests/terminal-review.test.ts
bun test tests/phase8-pi.integration.test.ts -t 'parent cancellation'
bun run check
```

The discovery fixture includes AionUi/paperclip-like ordinary docs, title-only
frontmatter, legacy standalone skills (including flow mappings), malformed
`SKILL.md`, malformed declared standalone skills and oversized descriptions.
Assertions cover warning counts/details as well as discovery and configuration.
It reproduced the old startup noise before the fix (3 failing tests).

The PTY exercise launches `CasperApp` with a scripted runtime and an isolated local
MCP fixture. It checks the rendered screen and received requests, not just process
exit: typing during streaming, busy Enter, wrapped drafts with a middle cursor,
Ctrl-C during work and immediately after Enter, fresh deny/approve/cancel, EOF at
approval, local status/login, color/NO_COLOR, and fail-closed `TERM=dumb` approval. Python 3's standard-library PTY
support is required on POSIX; Windows is not validated. No provider credentials or
live-model calls are used. The test exposed and locked down wrapped-input redraw
and EOF-confirmation cleanup defects during implementation.

The Pi preflight test uses an isolated localhost protocol provider. It proves a
cancelled preflight makes no request and a subsequent prompt still works. Existing
Pi integration also asserts the displayed identity comes from the host session.

## Limits

- Markdown rendering is Pi's component: no syntax highlighting; a partial fence or
  emphasis marker looks literal until its closer streams in.
- Single-line readline editing/history; no multiline editor, queue/steering,
  themes, animations, model picker or embedded OAuth. Very large pastes and terminal
  resize/reflow are not covered by the PTY acceptance exercise.
- Redaction is conservative display-only pattern matching, not a secret detector.
  It does not rewrite tool arguments, stored evidence or exact approval previews.
  Tool completion is diagnostic status, never an authoritative shell exit or test pass.
- A cancelled operation still drains its existing cleanup. This slice introduces
  no forced per-task deadline; the existing CLI SIGTERM shutdown deadline remains.
- Existing unrelated SIGTERM verifier cleanup flakiness remains a separate finding;
  a passing gate does not diagnose it.

## Validation

Post-implementation checkpoint: TypeScript clean; **407 tests passed, 0 failed,
4,615 assertions** across 32 files (test portion 120.24 s).

The subsequent [session review](TERMINAL_UX_REVIEW.md) reproduced and corrected
plain-input fresh-consent handling and redirected-output streaming. Its final
`bun run check` passed **411 tests / 4,624 assertions**, TypeScript clean, with
three extra terminal/PTY regression repeats. See that report for current readiness
and next-phase scope. This includes the website's
five existing game tests; no browser/UI acceptance is claimed. `git diff --check`
also passed.

The first gate reached 404 passing tests and two obsolete startup presentation
assertions; those assertions were updated to inspect `/visualize` without weakening
graph, artifact or workspace-preservation checks. The final gate is separate from
the historical baseline and unapplied trial candidate.

A pre-edit file hash/mode manifest confirmed all seven `web/` files and all twenty
saved `docs/acceptance/` files unchanged. Existing files outside the intended UX
source/test/docs set were unchanged; no files were removed or modes changed.
`src/project/inspect.ts`, dependency manifests/pins, the installed CLI link and
executable mode were preserved; `tests/project-inspect.test.ts` remains absent.
The saved trial patch was not applied. No live-model trial, commit or push occurred.
