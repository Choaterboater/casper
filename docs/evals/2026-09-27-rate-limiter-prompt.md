# Is Casper worse than Pi on the rate limiter? 2026-09-27

**No clear evidence that it is, and Casper's task prompt is not the cause.** Two prompt variants, built as throwaway
worktrees of `94adde0`, ran on `hard-rate-limiter` at repeat 10 per model (raw data: `.scratch/prompt-ab/`):
- **plain:** the request exactly as written.
- **proofonly:** the test and checklist instructions without the classification hints or check guidance.

| hard-rate-limiter, right runs | GLM | DeepSeek |
|---|---:|---:|
| casper as shipped (all saved runs) | 8/18 | 14/18 |
| plain request (A/B) | 5/10 | 8/10 |
| proofonly (A/B) | 6/10 | 9/10 |
| casper-checklist (saved) | 7/10 | 8/10 |
| pi (saved) | 4/6 | 6/6 |

Removing Casper's prompt wrapping did not help: the plain request did no better than Casper as shipped. The task is
hard for GLM under every setup, including Pi (4 of 6). Pi's lead rests on 12 runs, too few to show a real gap.
The two requirements that fail are the same everywhere: the exact wait after a fractional refill, and a clock going backwards.

Casper's success rate across today's runs is steady, not falling: 83/96, 22/24, 85/96 and 41/48 (86-92%). Pi's
over the same runs was 21/24, 19/24, 22/24 and 45/48 (79-94%).
