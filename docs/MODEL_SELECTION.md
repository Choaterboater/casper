# Casper-owned model selection

**Current behavior:** normal picker Enter and exact `/model` selection now remember
the global Casper default; Ctrl+S or `/model --session` selects only for the current
conversation. `/effort` exposes supported levels with the same remembered/session
choice. `/clear` and `/resume` are now available. See [current terminal guide](TERMINAL_UX.md)
and [daily-use review](DAILY_TERMINAL_REVIEW.md).

The remainder is the historical initial-slice report. Its original Enter/Ctrl+S
semantics, readline implementation, feature exclusions and validation counts are
superseded by the later approved daily-use slice, not statements of current limits.

## Original approved scope

The user approved a reuse-first `/model` slice and iteration through regression
checks and the serial gate. Pi remains the runtime; Casper owns model preferences
and the terminal handoff. This does not approve embedded OAuth, a full-screen TUI,
OMP as a dependency, Phase 9 promotion, Phase 10, live-provider trials, commits, or
pushes. The saved trial candidate remains unapplied.

## User behavior

- `/model` opens Pi's searchable model picker in an editable terminal.
- `/model <id or provider/id>` selects an exact unique match; otherwise an editable
  terminal opens the picker with that search. Ambiguous plain-mode IDs are rejected.
- **Enter** selects for the active conversation. **Ctrl+S** selects **and** saves
  the startup default for new parent conversations. **Escape/Ctrl+C** cancel the
  picker. EOF exits safely. Selection itself does not generate a model response.
- Plain/redirected terminals and `TERM=dumb` list available models instead of
  starting another terminal renderer. Use an exact ID to select. Saving a default
  interactively requires the picker; no invented `/model default ...` command tree.
- `/status` reports the selected provider/model, reasoning level, local auth
  availability, selection source, Casper default, and any blocked-selection reason.
  Before lazy startup it still reports model/auth as uninitialized.
- Changing provider sends subsequent conversation context to that provider, not
  merely the next user message. The terminal discloses this after selection.

“Conversation-only” does not mean “forgotten on process exit.” Pi records the
selection in the conversation transcript, so restoring that conversation restores
its model. Casper's existing named-session/workspace operations determine which
conversation is restored; this slice does **not** make every new CLI invocation
implicitly continue the last unnamed conversation or introduce `/resume`.

### Defaults and restoration

Casper uses Pi's existing settings schema and persistence manager with
`~/.casper/settings.json`:

```json
{
  "defaultProvider": "provider-id",
  "defaultModel": "model-id"
}
```

A recorded conversation model takes priority over the Casper default. Forks inherit
the parent's recorded model; switching to another named conversation restores its
own model. A fresh conversation without a Casper default requires explicit choice.
Shared Pi global/project model defaults are not an implicit fallback and are not
rewritten. Existing **non-model** Pi runtime settings remain an in-memory input to
the adapter; model/thinking defaults and model scopes are excluded from that input.

For existing settings files, saving preserves unrelated keys through Pi's settings
manager. Casper checks its settings location for symlink/hardlink redirection,
reports read/write failures, and waits for Pi's queued persistence before claiming
the default was saved. This is a non-atomic filesystem preflight, not a sandbox or
protection against concurrent malicious path replacement. A failed default write
can leave the explicitly selected conversation model active; the error says so.

If a restored/default model is unavailable or lacks configured authentication,
Casper keeps its requested identity visible and blocks generation instead of
silently choosing another provider. A failed selection does not replace the
current model. Auth availability is not a connectivity or credential-validity test.
`/login` remains setup guidance, not embedded login. Credential sourcing remains
Pi-owned; there is no credential migration, login, logout, or token refresh added
by this slice. Ordinary runtime initialization can create its empty auth container
and catalog cache, as on the pre-existing first-prompt path.

**Scope limit:** delegation and `casper learn` retain their documented global-Pi
model defaults. This parent-conversation slice does not silently change their
provider or introduce OMP-style model roles. The Casper default label means new
parent conversations, not every child invocation; help retains that distinction.

## Reuse evidence and implementation

Checked Casper's installed `@earendil-works/pi-coding-agent` **0.85.1**, not just the
newer global Pi documentation. Relevant package sources:

- `dist/index.d.ts`: public `ModelSelectorComponent`, `SettingsManager`, and SDK exports.
- `dist/modes/interactive/components/model-selector.js`: search, current/default
  badges, keyboard input, cancellation, explicit save callback, catalog refresh.
- `dist/modes/interactive/interactive-mode.js`: `/model` exact-match/search behavior
  and Enter versus Ctrl+S wiring.
- `dist/core/agent-session.js`: `setModel(model, {persist:false})`, auth preflight, transcript
  recording, model-capability-aware reasoning adjustment.
- `dist/core/settings-manager.js`: isolated/in-memory managers, queued writes,
  `flush()` and `drainErrors()`.
- `dist/core/sdk.js`, `dist/core/session-manager.js`: restoration, automatic fallback,
  and deferred first-response transcript persistence.

OMP was inspected at commit `b0651dc551831aa03545f29081a21ccf89829ee8`, not assumed to
match the user's installed binary:

- [Selector controller](https://github.com/can1357/oh-my-pi/blob/b0651dc551831aa03545f29081a21ccf89829ee8/packages/coding-agent/src/modes/controllers/selector-controller.ts):
  a compact temporary picker versus a larger provider/model-role hub.
- [Commands](https://github.com/can1357/oh-my-pi/blob/b0651dc551831aa03545f29081a21ccf89829ee8/packages/coding-agent/src/slash-commands/builtin-modes.ts):
  `/model`, `/models`, and `/switch`; the last conflicts with Casper's workspace command.
- [Model controls](https://github.com/can1357/oh-my-pi/blob/b0651dc551831aa03545f29081a21ccf89829ee8/packages/coding-agent/src/session/model-controls.ts):
  transcript recording separate from persisted role preferences.

Casper imports the actual Pi picker and Pi TUI primitives; it does not copy a new
picker, maintain its own catalog, or reimplement provider matching as a fuzzy
selection engine. `src/runtime/pi-models.ts` holds preference/restoration policy and
activation; `src/runtime/pi-model-picker.ts` hosts the exported picker. Pi-specific
types remain behind the runtime interface. Readline is closed while the picker
owns input, then recreated with the saved draft/cursor/history. Selection is blocked during
active work; cancellation/shutdown cannot complete a late auth-pending selection.

The stock picker normally refreshes remote catalogs. Casper's narrow catalog view
forces this refresh to `allowNetwork:false`. Provider-defined credential checks
can still run configured key-resolution programs, and runtime initialization still
loads its configured extensions as before; “local catalog refresh” is not an OS
sandbox or a blanket promise that arbitrary extensions cannot perform I/O.

### Integration corrections caught before completion

- An early selection implementation exported the whole active branch on every
  change. Regression tests reproduced both **loss of inactive transcript branches**
  and **EEXIST on the first assistant response**. Existing transcripts now use Pi's
  ordinary append path. Only an unwritten conversation is materialized, then
  reopened through Pi's public session manager so its writer knows the file exists.
- A shutdown regression reproduced a pending auth check selecting/persisting after
  disposal. Selection now has a runtime-owned cancellation lifetime and disposal
  drains it before releasing the session.
- The handoff initially lost readline history. A real-PTY regression reproduced
  the loss; history is now retained alongside the draft and cursor.
- The PTY screen decoder needed both BEL- and ST-terminated OSC-8 resets to inspect
  Pi's renderer accurately. Its former display failure was a fixture limitation,
  not evidence that the picker failed to render.
- Older protocol fixtures inherited Pi model defaults. They now explicitly seed
  a Casper parent default; their tool/verification assertions were not weakened.

### Subsequent review correction

A fresh single-agent review reproduced terminal-control injection through Pi's
catalog diagnostics. The authorized correction sanitizes catalog errors, refresh
provider labels/error messages and thrown refresh diagnostics before they enter
Pi's renderer. Renderer controls remain intact. Two permanent regressions were
observed failing before their fixes and passing afterward, covering malformed
local catalogs, refresh failures, OSC/C1/bidi controls and color/NO_COLOR. See
[MODEL_SELECTION_REVIEW.md](MODEL_SELECTION_REVIEW.md) for details and limits.

## Validation

Model regression tests cover selection/default isolation, unavailable and missing-auth
restoration, fork/switch precedence, pre-first-response persistence, inactive
transcript branches, persistence failures, corrupted/aliased settings, cancellation,
shutdown, and concurrent-operation exclusion. A localhost protocol fixture checks
an actual response after selection; no live provider is used.

The production CLI PTY exercise covers Pi search, Enter selection, Ctrl+S persistence,
Escape/Ctrl+C cancellation, empty catalogs/EOF, wrapped draft/cursor and history
restoration, return to readline, NO_COLOR, and plain-mode `TERM=dumb` listing. Existing terminal tests retain streaming,
confirmation freshness, cancellation, and TERM=dumb fail-closed approval coverage.

Original completion serial `bun run check`: **429 tests / 4,708 assertions**, TypeScript clean
(34 files; test portion 136.56 s). Three additional production-model PTY repeats
passed. Isolated installed-`casper` checks passed for listing, exact selection,
Casper startup defaults, lazy status, plain output and shared settings/auth
preservation. `git diff --check` passed. The pre-edit manifest confirms all seven
website files, twenty acceptance-evidence files, unrelated existing work and
dependency pins unchanged; details are in `docs/HANDOFF.md`.

After the diagnostic correction, the latest serial isolated `bun run check` passed:
**431 tests / 4,772 assertions**, TypeScript clean (34 files; 153.06 s test portion).
Three extra repeats of the two diagnostic regressions plus production CLI PTY test
passed. The bounded follow-up Standards/Spec self-review found no further blocking
issue; unrelated dirty work and saved evidence remain preserved.

Standards and scope were self-reviewed; no independent/subagent
review was available. These checks are local integration evidence, not independent
Phase 9 acceptance or a live-provider/product-readiness claim. Windows, very large
pastes, and full terminal resize/reflow behavior remain outside the validated
guarantees.
