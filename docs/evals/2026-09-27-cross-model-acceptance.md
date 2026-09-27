# Cross-model acceptance check on the hard pack, 2026-09-27

**Result: the rule is not met, but the explanation holds.** When a different model writes the acceptance
tests, `casper-acceptance-cross` catches 5 of 10 wrong runs (50%, Wilson 95% 24-76%). The same-model check
caught 1 of 8 (docs/evals/2026-09-26-acceptance-check.md). So "same model, same blind spot" is supported.
The check still misses the bar on all three counts: caught 50% against 70%, flagged 34 of 85 right runs
(40%) against 20%, and wall time 1.78× Pi against 1.25×. Tokens were 1.10× Pi. `verification.acceptance`
stays off by default.

Decision source: ADR 0001, decision 3. Pre-registration: `.scratch/acceptance/cross/run.sh`. GLM 5.3 Flash's
work was tested by DeepSeek V4.1 Flash, and DeepSeek's by GLM (the `review` role). The frozen hard pack ran
with `--time-limit 600` and concurrency 3 per model. Per model: casper-acceptance-cross and pi paired at
repeat 2, then casper-acceptance-cross alone at repeat 6. Code at `541bbbd`.

Reprint: `bun tools/eval.ts --report .scratch/acceptance/cross/glm-paired.json --report .scratch/acceptance/cross/glm-cross.json --report .scratch/acceptance/cross/ds-paired.json --report .scratch/acceptance/cross/ds-cross.json`

## Receipt honesty

| Work by → tests by | Runs | Caught | Flagged | False-verified | Wall × Pi | Tokens × Pi |
|---|---:|---:|---:|---:|---:|---:|
| GLM → DeepSeek | 48 | 2/7 (8-64%) | 9/41 (22%) | 5/37 | 2.23 | 1.65 |
| DeepSeek → GLM | 48 | 3/3 (44-100%) | 25/44 (57%) | 0/19 | 1.53 | 1.22 |
| **Both** | 96 | **5/10** (24-76%) | **34/85 (40%)** | 5/56 (9%) | **1.78** | 1.10 |
| Same-model check (previous run) | 96 | 1/8 | 29/87 | 7/65 | 1.49 | 1.01 |

## The misses

| Work by | Task | Hidden requirement failed | Check |
|---|---|---|---|
| DeepSeek | `hard-rate-limiter` | exact wait after an empty bucket (×2) | **caught** |
| DeepSeek | `hard-rate-limiter` | a backwards clock adds and loses no tokens | **caught** |
| GLM | `hard-job-queue` | cancel a queued job; size vs pending | **caught** |
| GLM | `hard-config-merge` | file values must have the default's type; null never valid | **caught** |
| GLM | `hard-rate-limiter` | exact wait after an empty bucket (×3) | missed (DeepSeek's tests passed) |
| GLM | `hard-conditional-http` | `PUT` with `If-None-Match: *` (×2) | not run (no proof phase on this server task) |
| DeepSeek | `hard-job-queue` | (timed out; not scored) | — |

The float-drift "exact wait" bug was caught every time GLM wrote the tests (2 of 2) and never when
DeepSeek did (0 of 3). Each model's blind spot is its own.

## Why right runs were flagged

All 34 false alarms are assertion failures, not broken test files. The typical flagged run passes all
but one of 15-18 generated tests. The failing test asserts a reading of the request that the grader
does not hold (issue order across sources, what path a `__proto__` issue reports, which message wins
when a key is both unknown and mistyped). GLM-written tests raised most of them: 25 of 44 DeepSeek runs.
One wrong test out of about 17 is enough to flag a run, so the false-alarm rate follows the number of
tests a model writes and how literally it reads the request [INFERENCE]. This observation comes after the
run and is not a tuned rule.

## Cost

A second model call of 50-90 s per run puts wall time far over the bar. GLM's runs also spent 1.65× Pi's
tokens: DeepSeek writes long test files.

## Stopping early

The first 24 paired runs already showed flagged 8/22 (36%) and wall 1.61× Pi. Neither could come back
under the bar with more runs. The volume phase ran only because the plan fixed the volume without a
futility rule. Future runs stop early (see docs/EVALUATION.md).

## What this means

A second model finds real misses the first model's own tests cannot. That is the first evidence in
three runs of a check that catches wrong-but-tested changes. As a receipt verdict it is too noisy and
too slow: 40% of correct runs would be told "not verified". Candidates for the next step (ADR 0001),
each a separate decision:
- **Report, don't downgrade:** a failing acceptance test becomes a named "unconfirmed requirement" line,
  and `verified` is unchanged (ADR 0001 decision 2).
- **Require agreement:** only a failure both models' tests share downgrades.
- **Requirement-to-test tracing**, the next candidate named in the ADR.
