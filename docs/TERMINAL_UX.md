# Terminal UX — daily-use interface

## Current interface

Run `casper` in your project. The interactive terminal now uses Pi's main-screen
renderer/editor: ordinary scrollback above an anchored multiline prompt and a
persistent footer, with no alternate-screen takeover. A model is not started just
to paint the footer. A saved default is shown as an advisory startup snapshot;
after runtime initialization the footer uses the active conversation's model.

The footer shows project/branch, provider/model, effort, estimated context occupancy,
runtime-reported session tokens, a positive cost estimate when available, and
idle/working state. `—` means unavailable, `~` means estimated. Branch is the
project inspection snapshot; `/status` refreshes it after external Git changes.
Narrow terminals truncate the footer rather than wrapping over input. Cost is not
an invoice or subscription charge. No green permission/verification badge is
invented, and no unimplemented ASK/PLAN/BUILD mode is implied.

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

This throwaway demo uses synthetic model/effort choices and fake activity. It makes
no model calls, edits no source files and saves no preferences. Try typing, history,
multiline input, `/model`, `/effort`, resizing and cancellation. It exercises the
same terminal surface; it is not a live-model usefulness trial or human visual sign-off.

## Compatibility

macOS terminal behavior is exercised with real PTYs. Windows and Linux need host
runs; exhaustive terminal compatibility is not claimed. Conversation/token storage
is not automatically redacted. There is no undo, automatic shell shortcut, queued
prompt execution or enforced permission-mode selector.
