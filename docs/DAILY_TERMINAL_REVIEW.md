# Daily-use terminal — implementation and scoped review

## Scope

The user approved a usable daily coding interface, global remembered model/effort,
normal scrollback with anchored input/status, and an interactive demo, then asked
for completion without further approval rounds. The agreed contract is
[TERMINAL_UX_SPEC.md](TERMINAL_UX_SPEC.md); current controls are in
[TERMINAL_UX.md](TERMINAL_UX.md). Local tickets: `.scratch/terminal-ux/issues/`.

This slice covers the terminal surface/editor ownership, model/effort policy,
telemetry and conversation controls, their app wiring, help, tests and offline demo.
It does not implement the entire example wishlist: enforced modes, permission
presets, undo, queueing and richer clients remain explicitly deferred.

Baseline HEAD remains `d6e24836c1509188f3e298e8ca4caeb134cd031b`. The tree already
contained browser, login, model-selection and other uncommitted work. Review used
tracked working-tree diffs against that HEAD plus direct reads of new files,
scoping findings to this daily-use increment. A commit-only three-dot diff would
omit it; unrelated prior changes are not claimed as this slice's work.

## Release evidence

Final isolated serial `bun run check`: **491 tests passed, 0 failed, 5,121
assertions**, 41 files, **203.42 seconds** test time. TypeScript passed.
Log: `/tmp/casper-terminal-complete.FFhpap/check.log`.
After this gate, the two picker/login draft assertions were tightened to remove
only known continuation indentation, not arbitrary spaces. Both production CLI
PTY tests passed again (**2 tests / 4 assertions**); production code was unchanged.

The gate used fresh HOME, TMPDIR and Pi directories, an allowlisted PATH and
offline/telemetry flags. No inherited personal provider credentials, paid/live
models, new dependency installation, repository commits or pushes were used.
Fixture Git commits are confined to disposable test repositories.

Acceptance includes:

- Real isolated Pi catalogs/CLI prove global model restart persistence, explicit
  session-only selection, supported effort validation, per-model persistence and
  same-conversation model switching. Shared Pi settings remain unchanged.
- Production CLI PTYs exercise Pi's actual model picker and supported-effort
  chooser, cancellation, history/cursor preservation, EOF, NO_COLOR and TERM=dumb.
  The saved-default footer appears before auth/runtime initialization, with a
  positive assertion that no auth container was created.
- Existing real terminal tests retain exact received-request checks, busy Enter,
  wrapped drafts, interruption during work and immediately after Enter, fresh
  approve/deny/cancel, EOF and cooked-terminal fail-closed consent.
- Synthetic login PTYs retain their credential-file permissions, consent/paste
  rejection, expected provider-protocol calls, draft/history, cancellation and
  termination assertions. No real login occurred.
- Public terminal tests cover partial-command insertion without execution,
  multiline input/history, narrow resizing, preserved drafts during output and
  immediate one-shot streaming with a final line break.
- The offline demo runs in a real PTY with model/effort choices, native window
  resizing/SIGWINCH, cancellation and exit, without an alternate screen or model.
- Real local Pi protocol responses exercise successful explicit compaction and
  persisted summary evidence. Pre-aborted compaction makes no request; an active
  compaction is cancelled after a positive request-arrival control. This proves
  lifecycle/protocol behavior, not semantic summary quality.
- Local context/usage and clear/list/resume exercise real Pi persistence. Source
  settings remain unchanged. A large real temporary Git diff produces a bounded,
  visibly truncated view instead of failing or changing files.

## Corrections and fixture changes

1. The normal-selection restart test failed before changing the app's default
   persistence policy. The original session-only adapter test now requests that
   policy explicitly; it still verifies shared settings/auth preservation.
2. Effort and context commands initially failed as unknown commands; the public
   CLI regressions passed after their end-to-end implementations.
3. A newly remembered effort was lost when switching away and back within one
   session. A regression returned `off` instead of `high`; updating the session's
   Casper-owned in-memory preference map fixed it without writing shared Pi state.
4. Busy typing could race a stale slash completion and turn `/status` into
   `/ststatus`. Completion is disabled while work/approval owns submission; exact
   commands submit literally and command completion replaces the full command token.
5. One-shot TTY assistant output lost its final line separator. The regression
   failed before adding the non-editor streaming state and passed afterward.
6. `/diff` exceeded its output budget and failed on ordinary large changes. A real
   Git regression failed, then passed with explicit truncation. Timeouts and other
   Git errors still propagate rather than masquerading as a complete diff.
7. Review removed the now-unreachable readline rich-editor implementation and
   consolidated the raw-input lease shared by editor/model/effort surfaces.
   Local commands refresh working status immediately, not only on runtime events.

The first gate reached **485 pass / 1 fail** (`/tmp/casper-daily-ux.1JVc7F/check.log`):
a login PTY assertion assumed unindented readline wrapping. Assertions were adapted
to the new editor's padding/footer, preserving the exact draft/cursor and history
checks and all consent/storage assertions. A subsequent gate passed **490/5,114**.

After adding real compaction coverage, a gate reached **490 pass / 1 fail**
(`/tmp/casper-daily-ux-release.8UH32o/check.log`). An EOF fixture sent input after
the banner but before raw editor ownership. The fixture now waits for the actual
idle footer, like the other raw-editor cases. Three focused PTY repeats passed,
then the final full gate above passed. Fixtures send CR for physical Enter;
Ctrl+J/LF is now correctly tested as multiline input. These fixture changes do not
claim that typing before editor readiness is an executable queued command.

## Standards review

**No outstanding blocking standards findings identified.** This was direct
same-agent review, not independent sign-off; no sub-agent tool was available.
The review applied the existing module/runtime boundaries and the code-review
skill's duplication, naming, responsibility and speculative-abstraction checks.

Casper retains command/consent/evidence ownership. Pi supplies its renderer,
editor, model catalog, model picker, usage calculation and session/compaction
machinery. Plain terminals remain separate from raw TTY ownership. The reusable
raw lease replaces copied lifecycle code; no new renderer framework, provider
catalog, settings schema or dependency was introduced.

## Spec review

**No outstanding blocking findings for the agreed daily-use slice.** The full
example command/mode wishlist was deliberately not the contract. Current controls,
what persists, what sends a model request and what remains unavailable are explicit.

Limits remain:

- Native tools are not an OS sandbox; `/permissions` explains current boundaries,
  not SAFE/NORMAL/YOLO enforcement. Completion and a passing tool display are not
  authority or verification evidence.
- Footer context is an SDK estimate, token totals are runtime-reported session
  statistics, and positive cost values are catalog estimates, not subscription
  bills. Unknown/zero-cost pricing is shown as unavailable rather than free.
  Branch reflects inspection; `/status` refreshes it after external Git changes.
- The startup-default display is an advisory bounded settings snapshot, not auth
  validation or a promise that a resumed conversation uses that model.
- Clear/resume preserve workspace files; they are not undo. Resume is restricted
  to saved conversation IDs listed for the current workspace. Named workspaces
  remain under the original switch/approval lifecycle.
- File completion inserts a path; it does not attach/read it. Symbol indexing,
  automatic shell shortcuts and external-editor execution are not included.
- Automated PTYs are not human visual sign-off or exhaustive terminal certification.
  Windows, pathological paste sizes and very long transcript performance remain
  unvalidated. History is current-process history; no separate prompt-history
  persistence or queue was added.

All changes remain uncommitted. The offline demo is retained at
`tools/terminal-demo.ts`, rather than creating a prototype commit/branch against
the user's no-commit constraint.
