# Terminal UX — daily-use interface

## Current interface

Run `casper` in your project. The interactive terminal now uses Pi's main-screen
renderer/editor: ordinary scrollback above an anchored multiline prompt and a
persistent footer, with no alternate-screen takeover. A model is not started just
to paint the footer. A saved default is shown as an advisory startup snapshot;
after runtime initialization the footer uses the active conversation's model.

Messages, tool activity, results and menus use titled panels. Cyan marks commands
and selection, magenta marks assistant content, amber marks caution or a decision,
and red marks an error. Color always accompanies a readable label; tool completion
does not mean a check passed. `NO_COLOR` keeps panel structure without color, while
redirected output and `TERM=dumb` use plain titles and text.

Assistant text streams through Pi's Markdown renderer, including code and tables.
Links show their destination as inert text. Login URLs and device codes stay on
standalone lines so frames do not become part of a copied value. Captured tool
errors and verifier stdout/stderr remain available with display-only redaction;
this is not a general secret detector, and recorded evidence is unchanged.

Help and results group related facts instead of one long paragraph. Assistant
instructions favor the answer or action first, numbered human steps when needed,
and one concrete next action when work remains. Unknown checks, estimates and
remaining uncertainty stay explicit. This is guidance, not a guarantee of any
provider's responses.

The footer shows project/branch, provider/model, effort, estimated context occupancy,
runtime-reported session tokens, a positive cost estimate when available, and
idle/working state. `—` means unavailable, `~` means estimated. Branch is the
project inspection snapshot; `/status` refreshes it after external Git changes.
Narrow terminals wrap footer data below the input so qualifications remain visible. Cost is not
an invoice or subscription charge. No green permission/verification badge is
invented, and no unimplemented ASK/PLAN/BUILD mode is implied.

### Model and effort

- `/model`: Pi's searchable model picker. **Enter remembers globally** in Casper's
  settings; **Ctrl+S selects for this session only**. Escape/Ctrl+C cancel.
- `/model provider/id`: exact selection, remembered globally.
- `/model --session [provider/id]`: explicitly temporary selection/picker.
- `/effort`: automatic or supported fixed-effort picker in an interactive terminal, otherwise a list.
- `/effort high`: apply and remember for that model. Unsupported levels fail.
- `/effort high --session`: do not change the saved preference. Effort also survives
  switching away from a model and back within the current conversation.
- `/effort auto`: classify each raw request before generation; actual effort and
  classified/fallback/unavailable status remain visible. Fixed effort disables it.
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

`/login` offers Codex and GitHub Copilot device-code login, plus Anthropic/Claude
and OpenRouter API-key or browser sign-in. `/login <provider-id>` skips only the
provider chooser. Every method requires fresh consent to provider-scoped shared
credential replacement; login does not select a model. Browser opening is manual.
Keys and callback codes/URLs use a separate hidden prompt, never chat/history.
Escape/Ctrl-C cancel; EOF and shutdown drain the login lifecycle.

Provider and method choices reuse Pi's selection list: Up/Down moves the visible
highlight in place, Enter confirms that item, and Cancel exits without contacting
the provider. Navigation accepts Pi's decoded arrow/Enter sequences, including
fragmented or batched terminal input. Trailing keys cannot answer the next prompt;
pasted text cannot grant consent or submit a private credential.

This picker correction is in source, not the published v0.1.0 binaries. macOS PTY
coverage exercises rendering and complete synthetic login flows; Windows-host
verification of this correction is still pending.

Copilot login may enable account model policies. Pi documents Claude subscription
auth as billed extra usage; OpenRouter browser sign-in mints a permanent key billed
from credits. Callback listeners are loopback-only. Plain terminals remain guidance
only. See [platform support](PLATFORM_SUPPORT.md) for host-validation limits.

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

`/diff` shows Git status and tracked changes against HEAD, without external diff or
textconv drivers. Untracked names are listed, not file contents. Each Git command
has a five-second deadline and 64 KiB output limit; large output is marked truncated.
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
