# Independent acceptance check on the hard pack, 2026-09-26

**Result: the rule is not met.** `casper-acceptance` caught 1 of 8 wrong runs (13%, Wilson 95% 2-47%;
the bar is 70%), flagged 29 of 87 right runs (33%; the limit is 20%), and took 1.49× Pi's wall time
(the limit is 1.25×). Tokens were 1.01× Pi. `verification.acceptance` stays off by default, and the
check stays in the code as an experiment.

Pre-registration: the rule and volume were fixed before the run, in `.scratch/acceptance/decision/run.sh`. Decision the same day: Casper
stays its own product, so the check was built into standalone Casper (`src/verify/acceptance.ts`) and not
into a Pi extension. The check makes one separate model call with the same model and effort. The model
writes one test file from the request alone (it also sees `CONTEXT.md`/`AGENTS.md`, the changed code and
two style examples). Casper runs it once with `<verify.test> ./<file>` and deletes it. A failure turns
`verified` into `not_verified`.

Pack: the frozen hard pack (tasks as of `791aa05`), code at `c0fd87e` plus the receipt-status commit.
Models: GLM 5.3 Flash (`--route Together`) and DeepSeek V4.1 Flash (`--route DeepSeek,Together`),
`--time-limit 600`, concurrency 3 per model. Per model: casper, casper-acceptance and pi paired at
repeat 2, then casper-acceptance alone at repeat 6. Raw results and script: `.scratch/acceptance/decision/`.

Reprint: `bun tools/eval.ts --report .scratch/acceptance/decision/glm-paired.json --report .scratch/acceptance/decision/glm-acceptance.json --report .scratch/acceptance/decision/ds-paired.json --report .scratch/acceptance/decision/ds-acceptance.json`

## Receipt honesty

| Harness | Runs | Timeouts | Caught | Flagged | False-verified | Wall × Pi | Tokens × Pi | Rule |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| casper (reference) | 24 | 0 | 0/2 (0-66%) | 0/22 | 2/24 (8%) | 0.83 | 1.06 | not met |
| casper-acceptance (decides) | 96 | 1 | **1/8** (2-47%) | **29/87 (33%)** | 7/65 (11%) | **1.49** | 1.01 | not met: all three |

Per model, casper-acceptance:
- **GLM**: caught 1/5, flagged 27/42 (64%), wall 1.24× Pi.
- **DeepSeek**: caught 0/3, flagged 2/45 (4%), wall 1.69× Pi.

## The misses

| Model | Task | Hidden requirement the grader failed | Acceptance check |
|---|---|---|---|
| GLM | `hard-rate-limiter` | exact wait after an empty bucket | pass (missed) |
| GLM | `hard-rate-limiter` | exact wait after an empty bucket | pass (missed) |
| GLM | `hard-rate-limiter` | a backwards clock adds and loses no tokens | **fail (caught)** |
| GLM | `hard-conditional-http` | `PUT` with `If-None-Match: *` (201/412); `HEAD` mirrors `GET` | not run |
| GLM | `hard-conditional-http` | `HEAD` mirrors `GET` including 304/404 | not run |
| GLM | `hard-job-queue` | (timed out; not scored) | not run |
| DeepSeek | `hard-job-queue` | priority order; pause/resume/onIdle | pass (missed) |
| DeepSeek | `hard-rate-limiter` | exact wait after an empty bucket | pass (missed) |
| DeepSeek | `hard-rate-limiter` | exact wait after an empty bucket | pass (missed) |

- **Rate limiter:** the "exact wait" miss (float drift, 2 ms instead of 1) got past the generated tests
  every time, as it got past the model's own tests in the first hard-pack run. The same model writes both
  and makes the same assumption.
- **Conditional HTTP:** the check never ran on `hard-conditional-http` (0 of 16 runs). Those runs have
  no proof phase: the check is gated on the proof path (auto mode, a code change, a `test` command), and
  this server task's runs end after the checks and smoke. The check could not have caught those two misses.

## Why the right runs were flagged

27 of the 29 flagged right runs were the acceptance tests failing on code the grader accepted; the other 2
were unproven changes. All 27 came from GLM: its generated tests were wrong far more often than
DeepSeek's (27/42 against 2/45). The benchmark records only the check's status and not its output, so
the exact faults (wrong imports, assertions beyond the request) are not attributed here [INFERENCE].
By task, failures on right runs: config-merge 8, money-allocation 6, job-queue 6, dependency-scheduler 4,
rate-limiter 3.

## Cost

The check adds one model call and one test run after the proof. It cost almost nothing in tokens
(1.01× Pi overall) but a lot of time, because the call is a full reasoning-effort answer: 86 s of a
139 s run in the one-task smoke run, and DeepSeek's wall time went to 1.69× Pi.

## What this means

Tests written by the same model from the request alone do not catch the misses that the model's own tests
miss. They add false alarms (GLM) and wall time (DeepSeek). The maintainer's conditions for this experiment
were: signal only, same model, one file, no second design pre-built. Under them, the check does not earn a
place in the default receipt. Directions not tried here, each a separate decision: a different model for
the acceptance tests, a check that runs outside the proof path (server tasks), and recording the check's
output in benchmark runs so its false alarms can be diagnosed.
