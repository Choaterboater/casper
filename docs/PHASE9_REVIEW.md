# Phase 9 final review

## Fresh-session review and correction

The user requested review before Phase 10. The fresh-session review used
`git diff d6e2483 -- <Phase 9 paths>` and the Phase 9 contracts below; unrelated
login/help hunks and user website/netcalc work were excluded from review.
No sub-agent tool was available, so this remains a single-agent review, not
independent sign-off. `docs/agents/issue-tracker.md` is absent; repository specs
were used rather than an external issue. To configure the skill's issue-tracker
workflow later, run `/setup-matt-pocock-skills`.

### Standards

**0 actionable findings.** The correction keeps filesystem validation inside the
existing promotion module and adds no new authority, dependency or abstraction.
No additional documented-standard breach or actionable baseline smell identified.

### Spec

**1 P2 finding, corrected:** `CandidateLibrary.finishArtifact` checked only the
artifact parent, not the active/staged directory itself. The contract requires
redirected state to fail closed. An existing active-directory symlink containing
matching bytes returned `already-decided`; a matching staged-directory symlink
could be renamed into the active destination. Neither case requires a race.
`O_NOFOLLOW` on the final Markdown file does not reject symlinked parent directories.

Two permanent CLI regressions moved the artifact to a temporary external directory
and substituted an active or staged directory symlink. Both initially failed:
expected exit 1, received 0. Recovery now checks both full directories through
`safeDirectory` before reading, removing staging or renaming. Both tests pass,
including unchanged external content and retained redirected paths. Existing
ordinary exact replay/recovery tests still pass. This does not establish atomic
path safety against concurrent same-user replacement.

### Validation after correction

- Targeted red: 2 failures; green: **2 tests / 10 assertions**.
- Isolated HOME/TMPDIR, allowlisted environment, offline serial `bun run check`:
  TypeScript clean; **461 tests / 4,969 assertions**, 36 files, 157.14 s test time.
- Full gate includes unrelated user tests, not a review of their implementation.
- Log: `/tmp/casper-phase9-rereview.AyseGP/check.log` (temporary evidence).
- No live provider, credential change, commit or push. Server PID 56873 preserved.

**Summary:** Standards — 0 findings. Spec — 1 corrected P2, 0 remaining identified
findings. Independent sign-off remains unavailable. Earlier zero-finding results
below are historical and superseded by this review.

## Original review: scope and method

Reviewed the uncommitted Phase 9 working-tree implementation against fixed point
`d6e24836c1509188f3e298e8ca4caeb134cd031b` (`Record local checkpoint handoff and
preserve review history`). Because the phase is still uncommitted, the review used
`git diff HEAD -- <Phase 9 paths>` rather than a three-dot commit diff.

Standards sources: `docs/CASPER_COMPLETE_PLAN.md` design rules, the applicable
trust rules in `docs/IMPLEMENTATION_PLAN.md`, and the repository's established
bounded/fail-closed module patterns. Spec sources: Phase 9 in
`docs/CASPER_COMPLETE_PLAN.md`, `docs/PHASE9_IMPLEMENTATION.md`,
`docs/LEARNING.md`, `docs/REFERENCES.md`, and the approved promotion contract:
local digest-bound human dispositions (`reference`, `project-skill`,
`global-skill`, `ignore`), immutable drafts, inspectable decisions, and activation
through existing reference/skill seams.

The available harness did not provide an independent review sub-agent. The same
agent therefore performed separate Standards and Spec passes after implementation
and tests, without treating earlier self-review as independent sign-off. This is
a disclosed review limitation, not an independent-review claim.

## Standards

**Result: 0 actionable findings.**

- Casper owns the command, consent, state, output and recovery behavior; Pi is used
  only for the already-bounded candidate-generation run. Promotion never starts a
  runtime or provider call.
- Knowledge remains on demand: references are searched explicitly and promoted
  skills still pass through the existing metadata/ranking/body-loading registry.
- Skills teach rather than grant capabilities. Generated text explicitly retains
  current-project authority and non-verification caveats; metadata cannot grant
  tools or execution.
- Proof is not inferred from model prose or historical citations. Draft,
  verification, acceptance and coverage fields remain truthful and unchanged.
- The design is inspectable: immutable draft and decision digests, source/candidate
  identity, dispositions, artifact paths/digests, local list/inspect output, and
  qualified recovery failures are visible.
- Bounded parsing, byte/record limits, nonblocking regular-file reads, exclusive
  staging, atomic ledger replacement, create-only destination activation, locks,
  and symlink/path checks follow existing repository safety patterns.
- Smell pass (Mysterious Name, Duplicated Code, Feature Envy, Data Clumps,
  Primitive Obsession, Repeated Switches, Shotgun Surgery, Divergent Change,
  Speculative Generality, Message Chains, Middle Man, Refused Bequest) found no
  change worth refactoring before release. The closed four-value disposition
  branching is local and expresses materially different destinations rather than
  speculative polymorphism.

## Spec

**Result: 0 actionable findings.**

- All four required dispositions are implemented. Skill names are required only
  for skill dispositions and validated before state access.
- Consent is bound to exact draft ID/digest and one-based candidate number; the
  ledger also binds the host-computed candidate digest. One decision per candidate
  is immutable, exact replay is idempotent, and conflicting replay fails.
- Original drafts are not rewritten. Decisions are separately stored, listed by
  count and returned by inspection.
- `reference` activates through reserved source `casper-promoted`; user/profile
  configuration cannot redirect or disable that ID. The source appears only for a
  real owner-state directory.
- `project-skill` is available only through the matching per-project Casper state;
  `global-skill` uses user skill state. Both use the existing trusted-owner skill
  registry and selective loading path. Neither writes the source checkout.
- `ignore` records the exact review decision and creates no artifact.
- No destination is replaced. Symlinked roots, collisions, changed artifacts,
  malformed/inconsistent ledgers and wrong digests fail closed. A committed stage
  can be completed only by replaying the exact recorded decision and digest.
- Public-interface tests cover provider isolation, terminal-safe output, all
  dispositions, reference/skill activation, unchanged source repositories,
  malformed consent, idempotence/conflicts, concurrent writers, collision,
  symlink refusal, corrupt-state preservation and interrupted-activation recovery.
- No remote retrieval, model-selected promotion, global policy rewrite, Phase 10
  feature, live-provider trial, personal credential mutation, commit or push was
  introduced.

## Validation reviewed

- Phase 9 suites: **85 tests / 650 assertions**, 0 failures.
- Serial full gate: TypeScript clean; **459 tests / 4,959 assertions** across 36
  files, 0 failures; Bun test time 157.44 seconds.
- `git diff --check`: passed.
- Full log: `/tmp/casper-phase9-final-gate.XHwNP4/full-check.log` (temporary;
  permanent tests do not rely on it).

**Summary:** Standards — 0 findings. Spec — 0 findings. Independent reviewer
unavailable; the two same-agent passes and automated gate are complete, with that
limitation explicit.
