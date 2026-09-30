# Request checklist on the hard pack, 2026-09-27

**Result: the pre-registered rule is met, but only against Casper as shipped.** With `verification.checklist: true`,
one low-effort call lists the concrete cases the request states and hands them to the builder, asking for one
test per case. Wrong runs fell from 7 of 48 (`casper`) to 2 of 48 (`casper-checklist`), which meets the bar of at
most half. Wall time was 1.06× Pi and tokens 1.13× Pi, both within 1.25×. Pi itself had 3 wrong runs of 48, so the
checklist brings Casper to Pi's level, not clearly above it: 2 against 3 is within noise.

Decision source: the maintainer's call after five detection checks failed (docs/evals/2026-09-27-mutation-check.md):
try preventing the missed cases instead of catching them. The rule was fixed in `.scratch/checklist/run.sh`
before the run: continue only if casper-checklist's not-accepted rate is at most half of casper's and its wall
time and tokens are each ≤ 1.25× Pi. Frozen hard pack, `--repeat 4`, casper, casper-checklist and pi side by
side, GLM 5.3 Flash (`--route Together`) and DeepSeek V4.1 Flash (`--route DeepSeek,Together`) in parallel. Code
at the commit adding `src/task/checklist.ts`. Raw data: `.scratch/checklist/`.

Reprint: `bun tools/eval.ts --report .scratch/checklist/glm.json --report .scratch/checklist/deepseek.json`

| Harness | Accepted | GLM | DeepSeek | Wall s (median) | Tokens (median) |
|---|---:|---:|---:|---:|---:|
| casper | 41/48 | 21/24 | 20/24 | 114 | 178k |
| **casper-checklist** | **46/48** | 23/24 | 23/24 | 136 | 182k |
| pi | 45/48 | 22/24 | 23/24 | 129 | 161k |

By task, the checklist fixed `hard-job-queue` (casper 5/8 → 8/8) and `hard-money-allocation` (7/8 → 8/8), and
helped `hard-rate-limiter` (5/8 → 6/8). The rate limiter's "exact wait after a fractional refill" still failed twice.

## Receipt honesty

The checklist does not change the receipt, and it catches nothing: caught 0/7 (casper) and 0/2
(casper-checklist). It reduces the number of wrong runs the receipt calls `verified` (false-verified 15% → 4%) by
reducing wrong runs, not by flagging them.

## Caveats

- In this run `casper` was worse than Pi (7 wrong against 3). Previous hard-pack runs had Casper ahead of or
  level with Pi. The checklist's gain over casper may partly be casper's bad draw; its gain over Pi is not shown.
- 48 runs per harness: 2 against 7 wrong is suggestive, not conclusive (Fisher's exact test, one-sided, p ≈ 0.08) [INFERENCE].

## What this means

Prevention works where detection did not: listing the stated cases for the builder removed most of the missed
cases at little cost. Next, if the maintainer agrees: confirm on a second run (or the harder pack) before making
`verification.checklist` the default in auto mode, and show the checklist to interactive users so they can correct it.

## Confirmation run (same day)

Pre-registered in `.scratch/checklist2/run.sh`: only the 3 tasks that ever failed (`hard-job-queue`,
`hard-money-allocation`, `hard-rate-limiter`), casper vs casper-checklist, repeat 6, concurrency 10, and each model
stopped by `--stop-when-success-decided casper-checklist:casper:0.5`. It took 12 minutes (GLM) and 7 minutes
(DeepSeek), against about 75 for the first run. Pi was not rerun; its saved runs on the same tasks are the baseline.

| On the 3 tasks | Confirmation run | Both runs together |
|---|---:|---:|
| casper not accepted | 9/35 (GLM 5, DeepSeek 4) | 16/59 (27%) |
| casper-checklist not accepted | 4/34 (GLM 3, DeepSeek 1) | 6/58 (10%) |
| pi not accepted (saved) | – | 3/24 (12.5%) |

The rule holds again (4 ≤ 0.5 × 9), though only barely on GLM alone (3 against 5). Both runs point the same way:
the checklist cuts Casper's misses on these tasks by about two thirds, to Pi's level. The larger finding is the
baseline: on these three tasks Casper as shipped misses more often than Pi (27% against 12.5%), mostly on
`hard-rate-limiter` (10 of 20 wrong against Pi's 1 of 8). Something in Casper's own task prompt or loop makes that
task worse, and the checklist mostly repairs it rather than adding value beyond Pi.

The early-stop gate saved almost nothing here: with 10 runs in flight, both models' comparisons were decided only
with 1 or 2 runs left.
