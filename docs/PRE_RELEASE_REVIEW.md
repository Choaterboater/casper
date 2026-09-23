# Uncommitted source review — 2026-09-22

Status: four implementation bugs corrected; focused/full gates and independent
follow-up reviews complete. **Not a release approval.**

The reserved preparation-cleanup pilot described below was later scrapped. A
missing fixture now removes harness-owned temporary directories. Do not refreeze
that pilot or treat phases 12–18 as a queue.

## Scope and method

Reviewed all uncommitted work in the public checkout against
`d4cb0419597a8fd414faf9b41cd636f2155f9005`, including regular untracked files.
There were no intervening commits: a three-dot HEAD comparison alone would have
missed the work. The captured comparison was `git diff d4cb041 --`, supplemented
with new-file diffs. The initial snapshot contained 253 regular files; the existing
shared `node_modules` link was recorded separately, not treated as new source.

Three independent, read-only reviewers ran in parallel: Standards, runtime/terminal
Spec, and evaluation/platform Spec. They used the repository's domain contracts,
local implementation/terminal/daily-driver plans, and the fixed review snapshot.
No issue-tracker configuration was installed. The optional setup questionnaire was
set aside at the user's request. Standards and Spec findings remain separate below.

Main reproduced actionable behavior before changing production code. Source and
original-development test files were preserved first. Every test HOME/TMPDIR was
outside Git repositories; the broad gates ran in external source snapshots, with
isolated environments and existing dependencies. Review agents used the current
configured review model; this was not a live Casper acceptance trial.

## Standards

The reviewer found **no conclusive hard documented-standard violation**, and two
judgement calls:

1. **P2 — Removed behavioral receipt coverage.** Some changed tests retained
   execution assertions but dropped the rendered freshness/scope qualifications.
   This conflicts with the spirit of the existing public app/CLI test-seam guidance:
   structured results alone cannot catch misleading user-facing receipts.
   **Corrected:** restored assertions for unavailable/unscoped evidence, stale
   overlapping edits, and actual one-shot CLI freshness/scope output. Execution
   success remains distinct from current-file verification.
2. **P3 — Positional coupling to Pi's selector layout.** The model-picker adapter
   edits `Container.children` to replace the pinned selector's frame/footer.
   **Retained integration risk:** this is already localized to one adapter and
   documented as Pi-0.85.1-specific. Existing production picker regressions remain;
   an upstream upgrade requires layout revalidation. No speculative wrapper or
   plugin framework was added merely to relocate those same assumptions.

## Spec

### Runtime and terminal reviewer

1. **P2 — Cancellation after model activation left stale Casper state.** Pi records
   and activates a model before awaiting `model_select` extension handlers. A late
   abort previously skipped Casper's bookkeeping, displaying the old model as
   unavailable while the transcript already held the new one.
   **Fixed:** reconcile the committed conversation model/effort before observing
   that abort; cancellation still prevents the pending startup-default save.
   The regression uses a real asynchronous Pi extension and checks current state,
   resume and unchanged defaults. Existing pre-activation cancellation behavior is
   retained.
2. **P2 — Invalid classifier answers discarded observed usage.** Malformed or
   output-limited responses could report tokens/cost but leave classifier accounting
   at zero when effort fell back.
   **Fixed:** record received usage independently of answer validation. Malformed
   and length-limited responses retain their observed usage/cost; late cancelled
   responses cannot update accounting or effort. Unreported transport usage remains
   unknown, and estimates remain separate from billing.

### Evaluation and platform reviewer

1. **P1 — Legacy provider-run isolation is incomplete.** The one-shot evaluator's
   default `PiRuntime` can load ambient Pi resources and persist transcripts outside
   its temporary Casper home.
   **Retained live-run prerequisite, not an isolation fix:** this behavior already
   exists at the comparison base; new offline preparation/grading starts no runtime.
   Corrected `docs/EVALUATION.md` and CLI wording to remove the overly broad isolation
   claim. A live trial still requires an explicitly isolated HOME/XDG/Pi launch,
   approved account/model configuration and transcript locations. No credentials
   were copied and no second runtime/configuration owner was introduced.
2. **P2 — Path aliases bypassed external-observation validation.** Lexical comparison
   accepted candidate-owned records when either path used a symlink or canonical
   alias.
   **Fixed:** resolve both locations before comparing. CLI regressions reject
   aliased candidate records before writing results, while genuine external records
   still grade successfully. This is a logical boundary, not an OS sandbox or a
   guarantee against concurrent filesystem tampering.
3. **P2 — Fulfillment tasks accepted out-of-scope changes.** A correct implementation
   plus an unrelated README/script could pass because only selected paths were
   forbidden.
   **Fixed:** explicit `allowedChanges: ["src/"]` enforces the production-only
   contract for both tasks and their derived scenarios. Regressions show independent
   behavior verification can pass while acceptance correctly rejects unrelated
   root files, scripts and similarly prefixed sibling directories.

## Verification

- Before corrections: TypeScript clean; **583 pass / 3 skip / 0 fail**,
  **3,569 assertions**, 586 tests across 50 files. The skips were optional installed
  debugpy acceptance, not missing native-platform proof hidden as passes.
- Reproduction gate: **six failing cases** spanning the four implementation bugs,
  observed before production edits. Original failures are retained.
- The same six cases passed after correction: **6 pass / 45 assertions**;
  TypeScript clean.
- Focused corrections gate: **110 pass / 0 fail / 644 assertions**, five files,
  covering evaluation, classifier, model selection, coding evidence and app checks.
- Final isolated `bun run check`: TypeScript clean; **588 pass / 3 skip / 0 fail**,
  **3,624 assertions**, 591 tests across 50 files, 294.46 seconds test time
  (299.31 seconds including typecheck). Same three optional debugpy skips.
- macOS ARM64 platform probe: **8 pass / 0 fail / 1 optional adapter-hint skip**.
  Evaluation CLI `--help` and `--list` both exited 0; neither starts a provider.
- Both independent follow-up reviewers found no new actionable defect in the
  corrections. The Standards coverage finding is resolved; pinned-layout coupling
  remains a judgement call. Spec confirms all four code fixes while explicitly
  retaining the live-run isolation prerequisite. Reviews were static, not substitute
  execution evidence. The new cancellation regression resumes in the same process;
  existing separate persistence coverage is not a new live restart-acceptance claim.
- Both checkout whitespace checks passed. Original development source/test bytes
  match their pre-review preservation copy. All tested source/test files match the
  active checkout; the final review report and handoff are documentation-only additions.

Maintainer-local evidence includes fixed source manifests, before/after source
snapshots, reviewer prompts/reports, command/exit records and all red/green logs.
Raw diagnostic evidence remains local rather than entering release assets.

## Remaining gates before distribution

- Native Windows/Linux source and terminal acceptance are still unperformed.
  Prepared workflows and macOS results do not close those gates.
- Representative live Casper acceptance still needs provider/account, exact model
  and effort, allowance, credential/configuration isolation and authorization.
- The evaluation preparation-cleanup leak was reserved for a frozen repair pilot
  at the time of this review. That reservation is closed; do not refreeze it.
- Pi's version-specific picker integration remains an upgrade revalidation point.
- Select a new version and validate its rebuilt assets before any release. Published
  v0.1.0 binaries/tags remain unchanged; there was no commit, push or publication.

**Axis totals:** Standards — 2 judgement calls (coverage corrected; layout coupling
retained). Spec — 5 findings (4 implementation bugs corrected; legacy live-run
isolation remains a prerequisite). Worst retained issue within Standards: pinned
layout coupling; within Spec: ambient Pi resources in an unisolated provider run.
