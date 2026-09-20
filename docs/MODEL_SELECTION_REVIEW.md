# Model-selection review — fresh single-agent pass

## Scope and comparison

Reviewed the bounded parent `/model` slice against `docs/MODEL_SELECTION.md`,
README's interactive-terminal contract, and the existing terminal safety behavior.
Standards sources: the complete plan's runtime-adapter boundary, implementation
plan's pinned-dependency/no-fork rules, and adjacent code. No dedicated coding
standards or issue-tracker configuration exists. Fowler smell heuristics were
considered as judgments, not hard requirements.

This is a fresh **single-agent** Standards/Spec review, not independent/subagent
review, Phase 9 acceptance, or promotion. No live-provider calls were made.

Baseline: HEAD `c8df2235209a2d74e5f5a4a8765c798ec2226cbf` plus the saved
`casper-model-baseline-omh8563k/baseline.patch`. Reconstructed tracked files in a
temporary directory, verified their hashes against `manifest.json`, and compared
those files with the working tree using `diff -u`. This isolates the slice from
older uncommitted work; a HEAD-to-working-tree diff alone would not.

The baseline has hashes but no old contents for six changed, previously untracked
files: `docs/TERMINAL_UX.md`, `src/tui/{format,help,terminal}.ts`, and
`tests/fixtures/{pi-interactive-cancel.ts,terminal-pty.py}`. Their current contents
were inspected where relevant; a complete before/after comparison is unavailable.
New model modules, regression tests and the production-picker PTY fixture were
reviewed directly.

## Standards

**No confirmed documented-standard violations or actionable smell findings.**
Pi imports remain within runtime adapters; the public picker-host contract does
not expose Pi types. The actual pinned picker/settings/session machinery is reused,
not forked or replaced with a parallel implementation. Dependency pins are unchanged.

## Spec

**One confirmed issue — P2: catalog diagnostics bypass terminal sanitization
(fixed in the follow-up below).**

Pre-fix location: `src/runtime/pi-model-picker.ts:81–89` (catalog view), with the raw-output
sink at line 53. The view sanitizes catalog model labels but forwards `getError()`
and refresh error data unchanged. Pi's picker displays those diagnostics as Text,
and `PickerTerminal.write()` passes their control sequences to the terminal.
`NO_COLOR` removes SGR styling only; it does not prevent this behavior.

Reproduced using the actual pinned `ModelRuntime` and `pickPiModel`, an isolated
HOME, and malformed local `models.json`. A provider key containing
`\u001b]0;CASPER_REVIEW_INJECTION\u0007` with an invalid numeric `api` value becomes
part of Pi's schema-error path. Capturing picker output confirms that the complete
raw OSC title-setting sequence reaches the output stream, with color disabled.
No provider request or real credential was involved.

This is a regression against the existing terminal safety contract in
`src/tui/format.ts`: “Untrusted output cannot move the cursor, set a title, or
conceal text with bidi controls.” The new picker bypasses the normal app-output
sanitizer. This probe proves terminal-control injection, not shell execution.

Recommended correction: sanitize diagnostic text at the catalog-to-picker boundary,
including `getError()` and refresh error/exception messages and provider labels.
Do not strip renderer control sequences indiscriminately at the terminal sink:
the renderer needs them. Add a permanent picker-output regression using malformed
local catalog input, covering color and NO_COLOR.

The documented selection/default/restoration and cancellation paths otherwise
matched the reviewed requirements. The initial review left this finding open;
the user subsequently authorized the correction recorded below.

## Initial review validation and preservation

- TypeScript plus focused model/terminal regressions: **26 tests, 117 assertions,
  all passed** (20.55 s test portion).
- Full serial `bun run check`, with a fresh HOME, empty inherited environment
  except PATH and explicit offline Pi settings: **429 tests, 4,708 assertions,
  TypeScript clean** (34 files; test portion 136.96 s).
- The diagnostic-injection probe independently reproduced the uncovered defect;
  a green existing suite does not cover or negate it.
- All seven `web/` files and twenty `docs/acceptance/` files remain hash-identical
  to the preservation baseline. Existing implementation changes were not edited.
- No live-provider trials, personal credential changes, commits, pushes, OAuth
  implementation, saved O4 application or Phase 9 promotion.

## Authorized correction — complete

`src/runtime/pi-model-picker.ts` now sanitizes `getError()` text, refresh-error
provider labels/messages, and rejected refresh diagnostics at the catalog view.
It reuses Casper's `terminalText()` before Pi adds renderer styling. The terminal
sink, model-selection behavior, catalog network policy and credential handling
are unchanged.

Two permanent tests in `tests/model-selection.test.ts` were each observed red
before their corresponding fix, then green:

- Real malformed local catalog → runtime selection → real Pi picker/output, in
  color and NO_COLOR. Diagnostic text remains readable; OSC title changes, C1
  controls and bidi controls cannot pass through; renderer controls still work.
- Single/multiple refresh-error provider labels and thrown Error/string messages,
  in both color modes. This test fault-injects the external Pi SDK refresh API in
  an isolated subprocess; it does not mock Casper's picker or renderer. Cancellation
  returns without selecting a model.

Final serial isolated `bun run check`: **431 tests / 4,772 assertions**, TypeScript
clean (34 files; test portion **153.06 s**). Three additional repeats of the two
regressions plus the production CLI PTY test passed (**3 tests / 66 assertions**
per repeat). `git diff --check` passed.

The correction baseline is
`/var/folders/yj/l1q2ypcj68qck8m_kcrdv26r0000gp/T/casper-picker-fix-baseline-i1f9dkit`.
Only the picker adapter, model-selection test file and the three model/handoff
documents changed. Website files, acceptance evidence, dependency pins and all
other existing dirty work remain unchanged.

Follow-up Standards/Spec self-review found no additional blocking issue in this
bounded correction. This remains single-agent local evidence, not independent
Phase 9 review or a claim that all terminal input is safe. No live-provider trial,
personal credential change, commit or push occurred.

**Current summary:** Standards 0 findings; Spec 1 confirmed P2, now corrected and
regression-tested; no outstanding finding from this review. The bounded correction
is complete. Embedded OAuth, child/learning defaults and Phase 9 promotion still
require separate scope.
