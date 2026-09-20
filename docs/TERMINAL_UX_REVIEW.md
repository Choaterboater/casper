# Session review — terminal UX

## Scope and method

Reviewed this session's approved quiet-discovery/interactive-CLI slice, not all
older uncommitted Phase 9 work. Fixed point: `c8df223` plus the pre-session dirty-tree
snapshot recorded before implementation. Tracked baseline files were reconstructed
with `git archive c8df223` and the saved baseline patch; every reconstructed file
was verified against the session-start SHA-256 manifest. Per-file comparisons used
`git diff --no-index <reconstructed-file> <working-file>`. New terminal modules,
fixtures, tests and documentation were read in full. There are no session commits.

The approved proposal/conversation and `docs/TERMINAL_UX.md` are the spec. Standards
sources are README's architecture/trust rules, `docs/IMPLEMENTATION_PLAN.md`'s pinned
thin-adapter constraints, and `docs/CODING_LOOP_EVIDENCE_CONTRACT.md`'s preservation
rules, plus the review skill's Fowler smell baseline. This is **single-agent review
in two separate passes**, not independent sub-agent acceptance; no review-agent tool
was available and no live-model review was initiated.

There is no `docs/agents/issue-tracker.md`. `/setup-matt-pocock-skills` can add the
issue-linked review workflow if wanted; this session's conversational spec was
sufficient and no setup was performed.

## Standards

**No actionable hard violations or blocking smell findings.** Pi remains pinned
behind the runtime interface. Casper owns terminal rendering and skill discovery;
no new runtime/UI dependency or second repair owner was added. Native bash, command
execution/evidence semantics, trust decisions and digest review are preserved.
Output presentation is separate from stored evidence. New status reads expose only
host identity and a local auth availability flag, never credential values.

The review corrections stay in `src/tui/terminal.ts` and its tests. Documentation
now distinguishes interactive cancellation from one-shot signal shutdown. PTY
fixture decoding now handles split UTF-8 chunks, and its timeout signal runs child
cleanup through the existing finally blocks.

## Spec

Two reproducible findings were corrected before readiness sign-off:

1. **P1 — residual fresh-consent gap in plain input.** The spec says confirmations
   “require fresh, explicit input.” `replaceDraft()` previously returned immediately
   outside editable TTY mode. A previously buffered `yes`, followed by a fresh empty
   Enter after the question appeared, approved the operation. Regression:
   `tests/terminal-review.test.ts`, “redirected interactive input cannot reuse a
   pretyped yes.” It returned **true**, expected **false**, before correction.
   Plain readline fragments are now discarded at both approval transitions,
   including cancellation. Actual cooked TTY input may still be hidden in the OS
   until Enter; with `TERM=dumb` or redirected output, exact approvals now fail
   closed with a clear explanation. This variant also failed before its guard and
   is now exercised in both the module test and a real `TERM=dumb` PTY. Fresh piped
   `yes` and normal editable-terminal approvals still work; NO_COLOR is supported.
2. **P2 — redirected streaming regression.** The spec calls for usable streamed
   output and plain redirected output. `assistant()` applied Markdown line buffering
   to non-TTY streams, withholding text until newline/completion. Regression:
   “plain redirected output still streams incomplete assistant text before
   completion” observed **empty output** after `assistant("Hello")`. Plain output
   now emits safe deltas immediately; completion adds only a needed separator.

No remaining blocker was found within the approved slice. `/model`, embedded OAuth,
multiline editing, themes and full-screen TUI were explicitly excluded, not missed
acceptance requirements. They remain unimplemented.

## Validation and preservation

- `bun run check`: TypeScript clean; **411 passed, 0 failed, 4,624 assertions**,
  33 test files; test portion **124.59 s**.
- Three additional repeats of `terminal-review.test.ts` + `terminal-ux.test.ts`:
  **8 passed / 33 assertions each**, including real PTY checks. Approximately
  5.4–5.6 seconds per repeat.
- Installed `casper` smoke from an unrelated isolated temporary HOME/project:
  `--help`, `/status`, `/skills diagnostics` exit 0; `/model` rejects locally with
  exit 1. Plain output has no terminal escapes; no auth file was created.
- The original website's five game tests pass in the full gate. No website source
  was edited and no browser/UI acceptance is claimed.
- Session-start and pre-review hash/mode audits preserve all seven website files,
  all twenty saved acceptance-evidence files, unrelated existing dirty-tree work,
  dependency pins, `src/project/inspect.ts`, CLI executable mode and installed link.
  The trial candidate remains unapplied and its proposed test file absent.
- No agent-run live-model trial, provider switch, credential/default change, commit
  or push. The user's successful greeting and report of blue color are separate
  human feedback, not an agent-run trial or general reliability certification.

## Readiness and next phase

**Ready to scope the next bounded terminal/product slice.** Recommend Casper-owned
`/model` selection and explicit Casper-specific defaults, without rewriting shared
Pi settings. Agree selection persistence, provider/auth UX and how restored sessions
interact with model choice before implementation. Pi remains an implementation
runtime, not the intended user-facing product workflow; the current trip into Pi
for auth/model setup is an interim limitation.

This review is not authorization to start that feature, apply O4, conduct another
live-model trial, or expand Phase 10. Phase 9's independent review/promotion decision
remains pending. Very large pastes, terminal resize/reflow, Windows, and the historical
SIGTERM verifier cleanup flake remain outside this slice's validated guarantees.
The cleanup test passed here; the earlier flake is **not diagnosed or declared fixed**.

**Summary: Standards 0 actionable findings; Spec 2 findings, both fixed (highest: P1 fresh-consent gap). No remaining blocker within the reviewed slice.**
