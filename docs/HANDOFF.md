# Casper — next-session handoff

## Resume here — local checkpoints committed; unrelated/newer work remains

The user authorized a local checkpoint and then the handoff. Two code commits
were created on `main`, without pushing:

| Commit | Scope | Exact committed-code validation |
| --- | --- | --- |
| `624088b` | Existing candidate-only learning, safety/config corrections, lazy capability loading, terminal UX and Casper-owned model selection, including picker diagnostic sanitization and opt-in test runner | **426 tests / 2,828 assertions**, TypeScript clean; 33 files; 139.57 s test portion |
| `254095c` | Separate slash-command/model-task paths and passive task observations, with app-level characterization and design/review docs | **427 tests / 2,843 assertions**, TypeScript clean; 33 files; 138.52 s test portion |

Each code tree was exported directly from its staged Git tree and checked serially
with a temporary HOME, an allowlisted environment and offline Pi settings. The
existing pinned `node_modules` was linked into each export; no install or dependency
change was made. This handoff and archived handoff history are recorded in a
subsequent documentation-only commit; use `git log -3 --oneline` for current HEAD.

The earlier **432 tests / 4,787 assertions** result included the five untracked
website tests. Those files were deliberately excluded from the code checkpoints.
The different counts are different test inventories, not weakened assertions.
Do not call either result a validation of newer work below.

### Still uncommitted — preserve and review separately

- `web/tic-tac-toe/`: all seven user website files, unchanged during checkpointing.
- **User's random Casper test:** `package.json` now adds a `netcalc` script,
  alongside `tools/netcalc/` and `tests/netcalc/`. These appeared while the checkpoint
  trees were being validated; the user confirmed they were just testing Casper.
  This output was not edited, staged, reviewed or tested in this checkpoint.
  Leave it separate; no deletion was requested. Check for an active writer before
  changing it or rerunning a full-tree gate.
- Existing unrelated plan edits: `docs/CASPER_COMPLETE_PLAN.md`,
  `docs/IMPLEMENTATION_PLAN.md`, `docs/PHASE3_VERIFICATION.md`.
- Local trial evidence: `docs/ACCEPTANCE_TRIAL.md`, `docs/acceptance/` (including
  the saved **unapplied** O4 candidate). No evidence was modified or candidate applied.
- Local optimization/benchmark material: `docs/DEBUG_OPTIMIZATION_REVIEW.md`,
  `docs/benchmarks/STARTUP_O2*`, `docs/benchmarks/STARTUP_O3*`, and
  `scripts/benchmark-startup.ts`. These remain outside the checkpoint, including
  any historical-document links to those local files.

Checkpoint preservation snapshot and exact-tree gate logs:
`/var/folders/yj/l1q2ypcj68qck8m_kcrdv26r0000gp/T/casper-checkpoint-ucx73n8x`.
Temporary evidence may disappear; the committed tests and scoped counts above do
not depend on those paths surviving.

**Next session:** read this section first, inspect `git status --short` and
`git log -3 --oneline`, and coordinate around the newer netcalc work. The bounded
app refactor and picker correction are complete; choose a separately scoped next
issue rather than continuing them indefinitely. Review details:
[APP_STRUCTURE_REVIEW.md](APP_STRUCTURE_REVIEW.md) and
[MODEL_SELECTION_REVIEW.md](MODEL_SELECTION_REVIEW.md).

No push, live-provider trial, personal credential change, OAuth work, Phase 9
promotion or Phase 10 expansion was performed. Reviews remain local/single-agent;
Phase 9's independent review/promotion questions and the historical verifier
SIGTERM cleanup flake are not closed by these commits. Statements below about
uncommitted work or earlier HEADs are historical and superseded by this section.

## Previous checkpoint — bounded CasperApp refactor complete

The user authorized reviewing and completing the first structural slice in
[APP_STRUCTURE_PLAN.md](APP_STRUCTURE_PLAN.md). It is implemented and locally
reviewed, still uncommitted. See [APP_STRUCTURE_REVIEW.md](APP_STRUCTURE_REVIEW.md)
for the isolated diff review, validation and limitations.

- `CasperApp` now separates slash-command dispatch from normal model-task execution
  while retaining the existing shared command-lifetime wrapper.
- New internal `src/task/observations.ts` owns bounded edit paths, shell-check
  diagnostics and possible-write flags. It neither verifies results nor owns tool
  authority, cancellation, persistence or repair. It is not barrel-exported.
- Cancellation, consent, runtime/workspace lifetime, edit invalidation, verifier
  evidence, task outcomes and the single repair owner retain their existing owners.
  No router framework or capability caching was added.
- One characterization at the app seam passed before source edits and after the
  refactor. Existing tests were retained. Final serial isolated `bun run check`:
  **432 tests / 4,787 assertions**, TypeScript clean (34 files; 136.61 s test portion).
  The full gate includes CLI/PTY behavior, model diagnostics and shutdown cleanup.
- Standards 0 findings; Spec 0 findings in the bounded **single-agent** review.
  No independent/subagent review was available. A passing cleanup test does not
  diagnose the historical intermittent verifier SIGTERM failure.
- Preservation snapshot:
  `/var/folders/yj/l1q2ypcj68qck8m_kcrdv26r0000gp/T/casper-app-refactor-baseline-42ivg7ee`.
  Website/acceptance evidence, dependencies, CLI mode and unrelated dirty work are
  unchanged. Only app/observation code, one test file and app-structure/handoff docs
  changed.

**Next boundary:** this first structural slice is complete; further architecture
or product work needs separate scope. No live-provider trial, personal credential
change, commit, push, OAuth work or Phase 9 promotion. The saved O4 candidate remains
unapplied. The app remains a substantial control layer; completion is not a claim
that every future maintainability concern has been resolved.

## Previous checkpoint — `/model` review correction complete

The user authorized continuing after the fresh review found one P2 terminal-safety
regression. That issue is now fixed: the picker catalog view sanitizes diagnostic
text, refresh-error provider labels/messages and rejected refresh diagnostics
before Pi adds its renderer controls. Model-selection policy is unchanged.

Two permanent regressions reproduced the failures before their fixes and now pass
for color and NO_COLOR, including malformed local catalogs, refresh failures,
OSC/C1/bidi controls, readable errors and cancellation without selection.
See [MODEL_SELECTION_REVIEW.md](MODEL_SELECTION_REVIEW.md) for the finding,
correction, review limits and evidence.

Latest serial isolated `bun run check`: **431 tests / 4,772 assertions**, TypeScript
clean (34 files; 153.06 s test portion). Three extra repeats of the diagnostic
regressions plus production CLI PTY test passed. Only the picker adapter, model
selection tests and three model/handoff documents changed; all website files,
saved acceptance evidence, dependency pins and unrelated dirty work are preserved.

**Next boundary:** this bounded correction is complete and remains uncommitted.
No outstanding finding from the local single-agent review; this is not independent
Phase 9 sign-off. Agree separate scope before OAuth, child/learning defaults or
Phase 9 promotion. No live-provider trial, personal credential change, commit or push.

## Previous checkpoint — approved Casper-owned `/model` slice locally complete

The user approved continuing the reuse-based model-selection slice and looping
through checks. Implementation and local Standards/Spec self-review are complete,
still uncommitted. No independent/subagent review was available; this is not
Phase 9 promotion. Read [MODEL_SELECTION.md](MODEL_SELECTION.md) for scope,
reuse evidence, integration corrections, defaults/restoration semantics and limits.

- `/model` hosts the **actual Pi 0.85.1 picker**. Exact `/model <id or provider/id>`
  selects directly; other interactive queries prefill search. Enter selects for
  the conversation; Ctrl+S also saves the new-parent default. Plain/redirected
  terminals and `TERM=dumb` list models instead. No OMP dependency or new command tree.
- Casper defaults live in `~/.casper/settings.json` using Pi's settings manager.
  Shared global/project Pi model defaults are neither adopted nor rewritten.
  Restored/forked conversations use their recorded selection; a missing/unavailable
  model blocks generation rather than silently falling back. `/status` reports the
  selected identity, reasoning, local auth, selection source, default and block reason.
- Selection records through Pi's transcript. Tests reproduced and fixed lost
  inactive branches and first-response `EEXIST` in the initial integration.
  Readline yields exclusive input ownership to the picker and restores the draft,
  cursor **and history**. Pending auth cannot select/save after cancellation or disposal.
- Picker catalog refresh is local-only. Configured credential-resolution programs
  can still run; configured runtime extensions still load as before. Credential
  availability is not a connectivity test. No embedded OAuth or credential migration.
  Delegation and learning intentionally retain their separately documented global
  Pi defaults; Casper defaults here apply to parent conversations only.
- Final serial `bun run check`: **429 tests / 4,708 assertions**, TypeScript clean
  (34 files; test portion 136.56 s). Three extra production-model PTY repeats and
  isolated installed-`casper` smoke checks passed. Added
  coverage includes isolated preferences/auth fixtures, missing-model/auth guards,
  default-write failures, restoration/forks, alias/corrupt settings, cancellation,
  concurrent work, an actual **localhost-only** reply after model selection, and
  the production CLI in a real PTY. No live providers or personal credentials used.
- The pre-edit preservation baseline is
  `/var/folders/yj/l1q2ypcj68qck8m_kcrdv26r0000gp/T/casper-model-baseline-omh8563k`.
  All seven `web/` files and twenty `docs/acceptance/` files remain hash-identical.
  Existing unrelated dirty work, dependencies/pins and CLI installation are preserved.

**Next boundary:** this bounded parent-model slice is complete, not all future
model/auth UX or Phase 9. Agree separate scope before embedded OAuth, propagating
Casper defaults into child/learning runs, broader terminal controls, or Phase 10.
The saved O4 candidate remains unapplied; no new live-model trial, credentials
change, commit or push was authorized or performed.

## Previous checkpoint — terminal slice complete (historical)

The user approved the bounded **quiet startup / usable prompt** slice, including
color, and asked to iterate until it was complete. Implementation and local
validation and a follow-up single-agent Standards/Spec review are complete, still
uncommitted. Read [TERMINAL_UX_REVIEW.md](TERMINAL_UX_REVIEW.md) for review findings,
fixes and next-phase readiness; [TERMINAL_UX.md](TERMINAL_UX.md) retains the slice's
scope and validation details.

- Skill discovery now defaults to Casper roots only. User/profile `skills.imports`
  enables Pi/shared/Claude/Codex roots explicitly; import is not trust. Ordinary docs
  are ignored; real warnings are summarized and inspectable via `/skills diagnostics`.
- The CLI now has color/basic Markdown, target-bearing tool activity, preserved
  drafts during streaming, busy-Enter protection, Ctrl-C task cancellation, and
  fresh confirmation input. `/status`, `/login` setup guidance and `/help all` are
  local. Active model/auth status comes from the host; startup remains lazy.
- Review reproduced and fixed two plain-mode gaps: pretyped approval reuse and
  buffered/invisible streaming deltas. Cooked TTY input (`TERM=dumb` or redirected
  output) now fails closed on exact approvals; piped-input fragments are discarded.
- Latest serial gate: **411 tests / 4,624 assertions**, TypeScript clean; three
  additional terminal regression repeats passed. PTY coverage includes streaming,
  wrapped input/cursor preservation, cancellation, confirmations (deny/approve/
  Ctrl-C/EOF), color/NO_COLOR, and `TERM=dumb` fail-closed behavior. Auth-preflight
  cancellation is tested against a localhost Pi protocol fixture.
- All seven website files and twenty saved acceptance-evidence files remain
  hash-identical to the pre-edit manifest. Existing unrelated uncommitted files,
  dependency pins, CLI executable mode and installed link were preserved. Website
  game tests passed as part of the gate; no browser acceptance was performed.

**Standing limits remain:** saved O4 trial candidate unapplied; no new live-model
trial, commit, push or Phase 10 expansion. Phase 9's independent review/promotion
questions remain open. A green gate does not diagnose the historical verifier
SIGTERM cleanup flake. The user subsequently confirmed blue output and successful
chat with host status `openai-codex / gpt-6-astra`, reasoning medium; this is human
feedback, not an agent-run trial. They reiterated that Casper should be its own
product: Pi is the runtime, not a long-term setup workflow users must manage.

**Next recommendation:** agree a bounded Casper-owned `/model` slice, including
selection persistence and Casper-specific defaults without rewriting shared Pi
settings. Model switching and embedded OAuth remain unimplemented. This review
makes the terminal slice ready for that planning discussion; it does not authorize
implementation, full-screen TUI expansion, or completion of Phase 9.

## Pre-slice handoff (historical context; superseded above)

**Previous direction: preserve the coding capability; make the interactive terminal
usable.** The user launched `casper`, asked it to build a polished tic-tac-toe
website, and said **“it did built the app well though.”** They also said the
terminal does not feel like Pi, OMP, Codex or Copilot: no colors, opaque activity,
noisy startup and missing expected controls. This is broader than a cosmetic fix.
The latest request was this handoff, not authorization for a full TUI rewrite.

1. Check `git status --short` and preserve all existing changes, especially the new
   **`web/tic-tac-toe/`** app. HEAD remains **`c8df223` — Add read-only local reference
   search**. Substantial work is uncommitted. If the user's Casper session is still
   writing in this checkout, coordinate before editing the CLI it runs.
2. Start with the real-use findings below, not another optimization pass. Agree a
   bounded interactive-UX slice and skill-source policy with the user. Basic input,
   activity visibility and onboarding should not be deferred behind advanced phases.
   No discovery, color, input, login or model-display fix has been implemented yet.
3. For a discovery fix, reproduce with a realistic temporary skill tree (ordinary
   docs alongside valid/invalid skill entries); assert warning behavior, not just
   successful launch. For input/rendering work, include a real TTY/PTY exercise of
   typing during streaming, cancellation and confirmations. Empty-HOME smoke tests
   alone missed the actual startup experience.
4. The older O4 candidate remains an independent pending decision, **unapplied**.
   If resuming it, read [trial 01](acceptance/TRIAL_01.md) and its
   [patch](acceptance/trial-01/candidate.patch), review fallback costs, and obtain
   application approval. It is not a prerequisite for terminal UX work.

**No automatic candidate application, agent-initiated live-model run, promotion,
Phase 10 expansion, commit or push.** The user's own website-building session is
new human feedback, not renewed authorization for agent-run trials. Before another
trial, agree command-timeout headroom and a new provider allowance. Independent
Phase 9 Standards/Spec review remains pending.

## Human real-use feedback — successful task, rough interface

The user ran the installed command in this repository. Chat worked and Casper
built the requested website; the user liked the result. The new untracked
`web/tic-tac-toe/` contains `index.html`, `style.css`, `app.js`, `game.js`,
`game.test.js`, `serve.ts` and `README.md`. Preserve it as user work. This handoff
only inventories those files: no website review, browser validation, test run or
independent acceptance was performed. The pasted transcript ends during writes;
do not invent its final verification status, usage or exact runtime model.

Observed interface problems and proposed next behavior:

- **Startup flood:** 44 skills were indexed, followed by many warnings about normal
  Markdown files under `~/.claude/skills/AionUi` and `paperclip`. The user explicitly
  objected that Claude is not what they are using. Two actual Codex `SKILL.md`
  entries also failed description-length validation; retain genuine diagnostics.
- **Discovery cause is visible in code:** `src/skills/registry.ts:scan` automatically
  adds Pi, shared `.agents`, Claude and Codex roots independently of provider. It
  recurses through every `.md` file unless that directory contains `SKILL.md`;
  ordinary repo docs therefore become invalid skill candidates. This is Casper's
  scanner, not Claude running or evidence of a provider switch. No corrective
  reproduction/test or implementation was completed in this session.
- **Recommended discovery policy:** make other tools' roots explicit opt-in and
  keep ordinary docs out of rejection logs. Confirm the exact default roots/import
  configuration before changing them. Standalone frontmatter `.md` skills are
  currently documented and tested behavior; distinguish them from ordinary docs
  rather than silently breaking compatibility. Summarize genuine warnings at
  startup and retain inspectable detail. Leave the user's external skill files alone.
- **Activity:** output such as `• read` / `✓ write` hides the file, command and result.
  Show meaningful operation targets, progress and useful result/error summaries,
  with appropriate redaction; this does not require exposing private reasoning.
- **Input and rendering:** no readable color/Markdown presentation; the transcript
  includes `/hHey!` while text streams. Treat input/output interference as a reported
  symptom requiring reproduction, not a diagnosed readline race. Provide an input
  area that survives streamed output and supports cancellation/approval safely.
- **Identity and auth:** `/login` is currently unknown. Chat nevertheless worked
  with existing authentication. Asking the model its identity produced only a vague
  “OpenAI model” answer. Display authoritative provider/model information from the
  host runtime and provide a clear login/status path; do not guess identity from
  generated prose or change the user's defaults/credentials implicitly.
- **Information hierarchy:** startup prints unused MCP/LSP/visualization status;
  `/help` dumps a long command/safety reference. A casual “hey” gets
  `[task] Execution completed; no Casper verification recorded.` Prefer concise
  startup/help and task-appropriate summaries, retaining detailed status, audit
  evidence and safety disclosures where they matter. Never imply checks passed
  merely by removing a noisy disclaimer.

The agreed conversational direction is **basic terminal usability before more
advanced features**, not merely adding colors. Themes/animations can wait. The
coding result is positive human evidence; it neither erases the UX gaps nor proves
general reliability. Preserve working execution, trust, consent and verification.

### Entry points for the next slice

- Discovery and warnings: `src/skills/registry.ts`,
  `src/app.ts:reportSkillWarnings`, `tests/phase2-skills.test.ts`,
  [README Skills](../README.md#skills).
- Interaction/rendering: readline and runtime event handling in `src/app.ts`,
  `src/tui/banner.ts`, `src/tui/help.ts`, `src/cli.ts`,
  `tests/casper-app.integration.test.ts`.
- Existing event data: `src/runtime/types.ts` and `src/runtime/pi.ts` already carry
  tool-call IDs and input observations, with output observations for bash. Inspect
  the actual contracts before proposing a new event interface. If using Pi's TUI
  or SDK APIs, read the installed Pi documentation/examples first; no library or
  renderer replacement has been selected.

## Local `casper` command is installed

The user authorized this setup. `src/cli.ts` is now executable (`0755`), and
`~/.local/bin/casper` links to
`/Users/stephenchoate/Documents/Casper/src/cli.ts`. That directory was already on
PATH; no shell settings, Bun package registration, credentials or dependencies
were changed. `command -v casper` also resolves in a login zsh.

From any project directory, **`casper` starts interactive mode**. `casper --help`
and `casper /project` work locally without model calls. Those two commands and an
interactive `/exit` smoke test all exited 0 from an unrelated temporary project
with isolated HOME and no credentials. No live-model call was made for installation.

This is a development link to the current main checkout, **not** the trial
candidate, a packaged release or a readiness sign-off. Moving/deleting the checkout
breaks the link. Preserve it unless the user asks otherwise. README Install/Run
instructions now explain setup. The installation changed only the executable
mode bit in source; CLI contents were checked against the saved baseline manifest.
Subsequent user work added the website; it was not part of the installation.

## Latest user preference: task progress, not a countdown

The user said that prominently calling out a “10 min timer” could scare people
away. Treat that limit as an **internal acceptance-experiment safeguard**, not a
Casper product requirement or normal task-duration promise. Lead with what Casper
is doing, checks/results, completion and requests for input. Keep exact limits in
engineering evidence; explain a reached limit honestly when relevant.

No customer-facing countdown or general ten-minute task cap was implemented.
Configurable limits in advanced settings are a possible UX direction, not a newly
shipped feature or authorization to implement one. Do not hide material spending
limits or failures. The user explicitly chose the original trial rather than
adaptive reasoning-effort escalation; that feature remains unimplemented.

## Trial outcome — keep these three results separate

| Evidence | Result |
| --- | --- |
| Frozen pre-website baseline | **389 tests / 2,599 assertions**, TypeScript clean; corrected isolated serial gate 117.63 s |
| Live Casper task | **286.10 s**, CLI exit **1**: managed full suite timed out at its existing **120-second command limit**; managed typecheck passed; zero repair attempts |
| Unchanged candidate, separately evaluated afterward | **398 tests / 2,609 assertions**, TypeScript clean, serial gate 120.49 s; all six evaluator cases and real `/project` check passed |

The outer experiment timeout was **not reached**. The separately passing host gate
does not turn the failed managed check into a pass. The last validated main-code
baseline was 389 tests, not the unapplied candidate's 398. The user has since added
website files including a test file; today's full-tree count has not been measured.
No supervising-agent code repair or model rerun occurred in the approved trial.

The candidate changes only `src/project/inspect.ts` and adds
`tests/project-inspect.test.ts`. Git process counts:

- Ordinary committed, nested, detached and linked-worktree inspection: **2 → 1**.
- Unborn branch: **2 → 3**; non-Git directory: **1 → 2**. These are real costs to
  consider before application, not a universal startup improvement.
- Controlled fresh-process inspection median: **89.11 → 60.05 ms**. This is a
  traced inspection fixture, not whole CLI startup or general productivity.

Provider: approved **Codex subscription / gpt-6-astra**, fixed **medium** effort.
Session reports 13 assistant messages, 12 tool calls and 75,819 total tokens
including cache reads. Actual subscription charge/remaining allowance is
unavailable; no hard dollar/token cap was claimed. No separately paid API provider
was used. Temporary protected auth was removed; original source/auth/settings
were unchanged at the end-of-run audit. Preserve the user's existing Pi defaults.

### Unresolved cleanup evidence

The first isolated baseline failed two profile tests because the harness forced
`CASPER_PROFILE=default`; removing that override corrected the setup. It also
reproduced the existing **SIGTERM verifier cleanup failure** (`leaked` marker
present). The later gate passed, but the cleanup cause remains unresolved. It has
now occurred in a **serial** gate as well as the earlier parallel run.

Keep `bun run check` serial and `test:fast` opt-in. Preserve cleanup assertions and
deadlines. A bounded investigation of this concrete failure is reasonable if
approved; another open-ended path/scope audit is not the next task. Do not attribute
the cleanup failure to the profile override or claim that rerunning diagnosed it.

## Evidence to read on demand

- **Trial assessment, usage, logs and limitations:**
  [acceptance/TRIAL_01.md](acceptance/TRIAL_01.md). Its `trial-01/` directory contains
  the permanent prompt, patch, manifests, evaluator, samples and separate gate logs.
- **Original agreed trial scope:** [ACCEPTANCE_TRIAL.md](ACCEPTANCE_TRIAL.md), now
  marked executed. Historical approval wording is not permission for another run.
- **Raw local snapshots/session:** `/tmp/casper-acceptance-sgTCoi/`, possibly absent
  later. No copied access/refresh token values remained after cleanup. The saved
  evaluator names that temporary root; recreating it requires matching baseline
  and candidate directories. Do not depend on temporary paths surviving.
- **Prior fixes/optimization details:**
  [DEBUG_OPTIMIZATION_REVIEW.md](DEBUG_OPTIMIZATION_REVIEW.md#follow-up-implementation-status).
- **Earlier checkpoints and historical validation only:**
  [HANDOFF_HISTORY.md](HANDOFF_HISTORY.md). Its old “next” instructions are superseded.

## Existing uncommitted work to preserve

- Phase 9 candidate-only learning and corrections: read [LEARNING.md](LEARNING.md)
  before changing generation, provenance or persistence. Drafts remain unpromoted,
  unverified and unaccepted; read-only tools are not an OS sandbox or spending cap.
- Opt-in fast tests; local `/help`, one-shot exit and unknown-command rejection.
- Shared profile validation; optional-facts fallback; bounded, right-sized memory
  reads; supported project-command keys only. Lock recovery and outcome pruning
  remain deferred pending explicit ownership/retention rules.
- O2 deferred MCP/validator loading and O3 shared parallel workspace discovery.
  O2 showed a local startup gain; O3 did not establish a material speedup. Preserve
  consent, cancellation, catalog identity and cleanup behavior.

The trial added evidence, **not O4 production code**. `src/project/inspect.ts` is
still unchanged and `tests/project-inspect.test.ts` absent in the main tree. The
saved patch previously passed `git apply --check`; it remains unapplied.

Agent handoff/install work changed documentation and the CLI executable mode only;
the user subsequently generated the website with Casper. This latest handoff update
is docs-only. `git diff --check` passed, and the earlier three installed-command
smoke tests passed. No full suite or live model was run for this update. Full-gate
counts above are historical; the user's own successful task is separate evidence.

## Phase readiness and standing limits

Phase 9 is incomplete: independent Standards/Spec review and a decision on human
promotion remain pending. The self-hosted coding trial does not validate learning
quality, production integrations or general daily-driver readiness. Phase 10,
research activation and further feature expansion stay paused.

Preserve native bash, dependency pins, the verification command runner and the
single post-primary repair owner. The earlier filesystem/evidence correction is
closed within its documented limits; reopen only for a concrete reproducible
contract regression or an approved affecting change. Scope observations and reads
remain non-atomic; Windows remains unvalidated.
