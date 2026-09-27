# Requirement-to-test tracing, replayed, 2026-09-27

**Result: the rule is not met, and the replay shows why tracing cannot catch these misses.** Tracing checks
that every behavior requirement the request states is mapped to a test that passes with the change and fails
without it. It caught 1 of 7 wrong GLM runs (14%, Wilson 95% 3-51%) and flagged 7 of 29 right ones (24%). On
DeepSeek's runs it flagged 10 of 37 right ones (27%), and 10 DeepSeek tracing answers were unusable. The
early-stop gate ended both replays once the result was decided (5.6 minutes, both in parallel).

Decision source: ADR 0001, decision 3's next candidate. The check is `src/verify/trace.ts`; replay with
`--check trace`. The model maps requirements to tests; Casper runs the tests with and without the change
itself (the tree before the change with the change's tests copied in). Workspaces are the ones from
docs/evals/2026-09-27-acceptance-replay.md; raw data is in `.scratch/replay/trace/`.

| Work and tracing by | Replayed | Caught | Flagged | Errors | Check s | Est. wall × Pi |
|---|---:|---:|---:|---:|---:|---:|
| GLM | 36 | 1/7 (3-51%) | 7/29 (24%) | 0 | 5 | 1.96 |
| DeepSeek | 37 | no wrong runs | 10/37 (27%) | 10 | 53 | 1.37 |

## Why it misses

In every wrong run it missed, the requirement the grader failed did have a test by name, and that test
passed with the change and failed without it. The gap was inside the test: it asserted an easier case than
the one the request states. For example, "invalid amounts throw RangeError" did not try the malformed forms
the request lists, and the rate limiter's wait test did not use a fractional refill. A mapping by test name,
checked for fail-without and pass-with, cannot see which cases an assertion leaves out.

## Pilot adjustment (before the measured replay)

The first pilot counted process instructions ("read CONTEXT.md", "do not add dependencies", "implement
`schedule`") as requirements and flagged 6 of 10 right runs for them. The prompt now asks only for behavior
requirements, which brought the pilot to 3 of 10. The remaining flags name real requirements that no test
checks, on code the grader accepted: true statements, but false alarms for the verdict.

## What this means

Four checks now show the same boundary. Checks, proof, independent acceptance tests (same model and cross-model)
and requirement tracing all confirm that tests exist and pass. None of them catches a test that asserts less
than the requirement states. A check that could: mutate the code a requirement governs and require some
test to fail (mutation testing, host-run, no model judgment on the verdict). Replay measures it against the
same saved misses in minutes. Warn mode (naming requirements with no proving test) stays useful as a
receipt line: it is true when it fires, even when the code happens to be right.
