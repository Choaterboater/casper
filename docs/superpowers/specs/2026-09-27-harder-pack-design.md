# Harder pack: confirm the request checklist against Pi

Date: 2026-09-27. Status: design approved in chat; spec awaiting owner review.

## Why

`verification.checklist: true` (src/task/checklist.ts) cut Casper's wrong runs on the hard pack from 7/48 to
2/48 and, on the three tasks that ever failed, from 16/59 to 6/58 (docs/evals/2026-09-27-request-checklist.md).
That brings Casper to Pi's level; it does not show Casper ahead of Pi, because Pi misses only about 6% of
hard-pack runs. The hard pack was meant to make Pi fail 25-60% of runs and missed that band twice: adding 2-3
stated requirements per task made Pi fail less, not more (docs/evals/2026-09-26-hard-pack.md).

This spec is Next item 2 of docs/HANDOFF-2026-09-27.md: a new pack hard enough for Pi that a lead over Pi is
measurable, and a pre-registered run that decides whether the checklist becomes the default.

## Goal and decision rule

The checklist becomes the default (auto mode, interactive and one-shot) only if, on the frozen new pack:

- casper-checklist's not-accepted rate is at most 2/3 of Pi's, and
- casper-checklist's median wall time and median tokens are each at most 1.25× Pi's.

Otherwise it stays opt-in, and the result is recorded either way. `casper` (as shipped) runs alongside for
reference; it does not enter the rule.

## The pack

A new pack, `harder`, of 6 tasks in `evals/packs.ts`, each with its own new fixture and setup. Nothing is reused
from existing packs. The structure is the hard pack's (docs/EVALUATION.md, "Quality-benchmark packs"):

- The fixture is the reference solution plus `acceptance/` (hidden tests). The setup's `remove.json` removes
  `acceptance/` and the reference source; its `files/` overlay a stub that fails the visible tests.
- Visible tests in `tests/` cover the basic path only.
- The frozen evaluator runs `bun test ./tests` and `bun test ./acceptance` as separate checks.
- The prompt says hidden acceptance tests exist but not where, and tells the model to read `CONTEXT.md` first.

What makes it harder (approach A, chosen by the owner):

1. **20-30 stated cases per task**, against 8-12 in the hard pack. A case is one concrete behavior: an input and
   its output, an error and its exact message, a boundary, an order, a format.
2. **Every case is stated in the prompt.** The checklist call sees only the request (it does not read project
   files), so a case stated only in a file would test a different design. `CONTEXT.md` holds project rules
   (layout, no new dependencies, `tests/` conventions), not behavior cases.
3. **Prompts are prose**, written as a person writes a request: paragraphs that state the cases, not a numbered
   list. A numbered list would do the checklist's job for it.
4. **One hidden test per stated case**, named after the case, so each miss maps to exactly one case. No hidden
   test checks anything the prompt does not state.
5. **Several deliberate departures from a well-known convention per task**, each stated plainly in the prompt
   (for example, a quoting rule that differs from RFC 4180). A model that falls back on the convention it knows
   omits a stated case, which is the failure being measured.

Candidate tasks (single module, deterministic, Bun + TypeScript, no network, no timers):

| Task | Fixture | What the cases cover |
|---|---|---|
| `harder-csv-reader` | `csv-reader` | delimiter and quote options, header mapping, trimming, comment lines, typed columns, errors with line and column |
| `harder-cron-next` | `cron-next` | next fire time in UTC: lists, ranges, steps, names, day-of-month/day-of-week combination, invalid fields |
| `harder-semver-range` | `semver-range` | parsing, comparison, caret/tilde/x-ranges, hyphen ranges, prerelease matching rules |
| `harder-url-router` | `url-router` | params, optional segments, wildcards, route precedence, trailing slash, decoding, 404 vs 405 with `Allow` |
| `harder-invoice-totals` | `invoice-totals` | discount order, per-line vs total rounding, tax-inclusive prices, currency minor units, rejects |
| `harder-text-wrap` | `text-wrap` | width rules, long words, hyphenation, tabs, blank lines, indentation |

A candidate may be swapped for another of the same shape during building if it cannot reach 20 clean,
independently testable cases.

## Calibration (Pi only), then freeze

Calibration runs Pi alone, so the tasks are not tuned toward Casper.

- Models: GLM 5.3 Flash (`--route Together`) and DeepSeek V4.1 Flash (`--route DeepSeek,Together`), the same
  two models as the earlier hard-pack and checklist runs.
- Round: `--pack harder --harness pi --repeat 4` per model, so 8 runs per task and 48 in total.
- Band: 25-60% not accepted across the pack. A task at 0/8 or 8/8 is adjusted (cases added, reworded or
  removed), and the hidden tests change only to match the prompt.
- At most 2 rounds. If round 2 is still out of band, stop and report to the owner instead of tuning further.
- Freeze: one commit containing the final pack and a calibration record in `docs/evals/`. No pack change after
  it, except under the bug rule below.

## Decision run

Pre-registered: the run script and this rule are committed (in `docs/evals/`, with the script under `.scratch/`)
before launch.

- Harnesses: `casper-checklist`, `pi`, `casper`. The same two models, run in parallel.
- Volume: `--repeat 10` (up to 60 runs per harness per model, 120 across both), `--concurrency 10`.
- Early stop: `--stop-when-success-decided casper-checklist:pi:0.67` on each model's run.
- Report: accepted per harness and per model, median wall time and tokens, per-task misses, receipt honesty
  (caught, flagged), and a one-sided Fisher exact test of casper-checklist against Pi, labeled as inference.

## Bug rule (owner's)

If a major bug shows up during calibration or the decision run, stop the run, fix it, record the fix in the
eval record, and rerun every harness from scratch. Partial results from the stopped run are kept on disk but
are not reported as results. A major bug is:

- a hidden test that is wrong or checks something the prompt does not state;
- a grader or harness fault (a wrong result, a crash, a lost run);
- a harness failing for reasons other than the model's work in 5% or more of its runs.

A fix to a hidden test or a prompt after the freeze is a new freeze: the pack is recommitted, and the decision
run starts over.

## Testing

- `tests/eval-packs.test.ts` and the fixture/setup matrix in `tests/eval-suite.test.ts` cover the new tasks as
  they do every pack: the reference is accepted, the stub is rejected, hidden tests never reach the candidate,
  and the reference satisfies every predicate.
- Per task, while building: remove one stated behavior from the reference at a time and check that exactly its
  hidden test fails. This is a manual building step, not a permanent test.
- `bun run typecheck` and the full suite (`bun run test:fast`) pass before the freeze commit.

## Documentation

- docs/EVALUATION.md: the `harder` pack in the packs table and a short section on how it differs from the hard
  pack.
- docs/evals/: a calibration record and a decision-run record.
- docs/HANDOFF: update Next.

## Out of scope

- Changing the checklist itself (prompt, limits, reading project files).
- Casper's default beyond `verification.checklist`.
- Tasks spanning several existing modules (approach C) and subtle-semantics-only tasks (approach B).

## Prerequisite

The auto-mode classifier denied a read of `evals/packs.ts`. Building the pack edits that file, so the owner
must allow access to it first.
