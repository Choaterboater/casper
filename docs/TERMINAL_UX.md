# Terminal UX — bounded first slice

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
- Basic Markdown/color, target-bearing tool activity with elapsed time and bounded
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

- Basic line-oriented Markdown, not a complete Markdown renderer. Incomplete
  streamed lines have a one-row preview; complete lines enter scrollback in full.
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
