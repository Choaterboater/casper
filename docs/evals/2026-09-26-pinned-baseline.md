# Pinned benchmark baseline, 2026-09-26

Casper against Pi 0.87.0 and oh-my-pi (omp) 18.2.11, all on the same model and the same OpenRouter
host. Five tasks (`core-portcheck-cli`, `core-mcp-tool`, `core-log-parser`, `net-interface-parser`,
`net-radius-test`), medium effort (both models run it as high), 600 s per attempt, up to one
follow-up. A short baseline by the owner's instruction (5 of 17 tasks), not the full packs.

## Why every OpenRouter run is pinned (`--route`)

OpenRouter keeps a conversation on one host, and its hosts for the same model differ tenfold in
speed. Unpinned, GLM 5.3 Flash sessions that landed on an fp4 host answered in about 3 s per call
and made the model report "corrupted" tool output that was never sent (it then reread the same files
until the time limit); sessions on Together answered in about 0.3 s. Unpinned comparisons measured
which host each harness drew. Casper then timed out 17 times across two models; pinned, not once.
`tools/eval.ts` now refuses an OpenRouter benchmark without `--route` (`--route any` is recorded as
unpinned).

## Results (5 tasks x 1 run, first attempt; infrastructure runs excluded)

| Model (host) | Harness | First-time right | False done | Median wall | Median tokens |
|---|---|---:|---:|---:|---:|
| GLM 5.3 Flash (Together) | Casper | 4/4 (+1 infra) | 0 | 307 s | 468k |
| | Casper, review off | 4/4 (+1 infra) | 0 | 179 s | 234k |
| | omp | 4/5 | 1 | 159 s | 424k |
| | Pi | 3/5 | 2 | 226 s | 256k |
| DeepSeek V4.1 Flash (DeepSeek) | Casper | 5/5 | 0 | 174 s | 677k |
| | Casper, review off | 5/5 | 0 | 125 s | 288k |
| | omp | 5/5 | 0 | 71 s | 446k |
| | Pi | 4/5 | 0 | 65 s | 173k |

"infra": both Casper GLM portcheck runs failed on Together 429s ("rate-limited upstream") before any
tool call, twice each; such runs are rerun once and then left out of every denominator.

The earlier pinned comparison (5 tasks x 2 runs, Casper and Pi only): DeepSeek 10/10 each; GLM
Casper 7/10 (one infra, one killed in the review with correct code on disk, one false done fixed by
a follow-up) and Pi 9/10. Casper took about 2x Pi's wall time and 2-3x its tokens per correct result.

## What it says

- **Casper is never wrong about being done; Pi and omp sometimes are.** Across both short runs,
  Casper and Casper with the review off had no false done; Pi had 2 and omp 1.
- **The requirements review is where Casper's extra time goes** (41-44% of its wall time, 98-123 s
  median per run in the two-run comparison). On these runs it bought no extra first-time-right
  over Casper with the review off, which is 30-40% faster and uses half the tokens. One earlier
  ablation (GLM, `core-mcp-tool`, 2 runs) had the review-off variant fail both: the evidence is
  thin in both directions, n is 1-2 per cell.
- **omp is the fastest correct harness here**, near Pi's speed with Casper-like accuracy on DeepSeek.

## Files

Local, gitignored: `.scratch/phase-3-close/short-{glm,deepseek}.json`, `.scratch/phase-4/pinned-*.json`,
`.scratch/phase-4/ablate/`. Reprint any of them with `bun tools/eval.ts --report <file>`.

## Phase 4a: review off by default (2026-09-26)

Owner decision after the runs above: the requirements review is **off by default**
(`verification.review: true` turns it on, now with a short answer of only its gaps and a 12-turn
budget). The checks and the proof stay on. Acceptance (`core-mcp-tool` + `net-radius-test`, 2 runs
each, pinned):

| Model | Harness | First-time right | False done | Median wall | Median tokens |
|---|---|---:|---:|---:|---:|
| GLM 5.3 Flash (Together) | Casper (default) | 3/4 | 1 | 146 s | 123k |
| | Pi | 4/4 | 0 | 153 s | 122k |
| DeepSeek V4.1 Flash (DeepSeek) | Casper (default) | 4/4 | 0 | 131 s | 382k |
| | Pi | 4/4 | 0 | 128 s | 332k |

Casper's wall time went from about 2x Pi's to parity (target: at most 1.4x). Its one false done
(GLM `core-mcp-tool`, the model stopped after 49 s) is the first in the pinned runs; the same
configuration was 4/4 as `casper-no-review` in the run before, so watch it rather than conclude
from one run. With the review on (`casper-review`), the short answer cut the review from 98-123 s
to 69-88 s median, still not enough to pay for itself on these tasks.
