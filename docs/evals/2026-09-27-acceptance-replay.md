# Acceptance check replayed on saved workspaces, and Codex as the builder, 2026-09-27

**Result: no version of the acceptance check meets the rule, and the replay shows why.** The false alarms
depend on which model writes the tests: GLM's tests flag 50-77% of correct runs, DeepSeek's 6-10%. The
catches are too few: at most 2 of 8 wrong runs in any replay. Replay made each measurement take about 3
minutes instead of about 2 hours, and the early-stop gate ended three of the four replays as soon as the
result was decided. Separately, Casper's checks, proof and acceptance check wrapped the Codex CLI with no
Casper changes, and its receipt stayed honest, but it missed Codex's one wrong run.

Decision source: ADR 0001; round 2 (replay first, then an agent-independent prototype). Code: `phase/round2` at
`b6bde6b` (the check is a low-effort call with a 24,000-token output cap, runs outside the proof path, and has a warn mode).

## Workspaces

The frozen hard pack was run with Casper as shipped (acceptance check off) and Pi. For each model, Casper and
Pi ran side by side at repeat 2, then Casper alone at repeat 6, with every workspace kept (`--keep-workspaces`,
concurrency 6). The two models were GLM 5.3 Flash (`--route Together`) and DeepSeek V4.1 Flash
(`--route DeepSeek,Together`). Raw data: `.scratch/replay/collect/`.

| Harness | Runs | Caught | Flagged | False-verified | Wall × Pi | Tokens × Pi |
|---|---:|---:|---:|---:|---:|---:|
| casper, as shipped | 96 | 1/11 (2-38%) | 3/85 | 10/92 (11%) | 1.25 | 0.94 |

## Replays (`bun tools/eval.ts --replay … --stop-when-decided`)

Each replay reruns only the acceptance check on the kept trees, and only on runs whose receipt said `verified`
(the only runs the check can change). The grader's verdicts are the saved ones. Raw data: `.scratch/replay/results/`.

| Work by | Tests by | Replayed | Caught | Flagged | Check s (median) | Est. wall × Pi | Stopped |
|---|---|---:|---:|---:|---:|---:|---|
| GLM | GLM | 16 | 1/3 | 10/13 (77%) | 15 | 1.50 | yes: flagged |
| GLM | DeepSeek | 37 | 2/8 (7-59%) | 3/29 (10%) | 25 | 2.29 | yes: caught |
| DeepSeek | DeepSeek | 48 | no wrong runs | 3/48 (6%) | 21 | 1.08 | no, all replayed |
| DeepSeek | GLM | 20 | no wrong runs | 10/20 (50%) | 11 | 1.18 | yes: flagged |

- **The noise follows the test writer.** GLM's tests flagged 50-77% of correct runs whichever model did the
  work. DeepSeek's flagged 6-10%. The false alarms in the previous run
  (docs/evals/2026-09-27-cross-model-acceptance.md) were mostly GLM's tests too.
- **The quiet writer misses.** DeepSeek's tests caught 2 of the 8 wrong GLM runs replayed. All of this
  pack's DeepSeek runs were right, so DeepSeek-written work gave no catch data.
- **The cost is lower.** The low-effort, capped call took a median 11-25 s, down from 50-90 s. The wall-time
  ratio stays estimated (about 1.1-1.5× Pi, with one 2.29), not measured.

## Codex as the builder (prototype)

The prototype `evals/prototype-any-agent.ts` lives on branch `prototype/any-agent` (`f88d191`); raw data is in
`.scratch/any-agent/hard/`. Codex CLI (the user's config: gpt-6-luna, maximum effort) does the work. Casper
snapshots the tree before and after, runs its checks with repairs through `codex exec resume`, then the proof,
then the acceptance check with DeepSeek writing the tests, and grades the result.

- 12 runs (6 tasks at repeat 2): 11 right, 1 wrong (`hard-rate-limiter`, the same "exact wait" float bug).
  Casper said `verified` on the wrong one (0/1 caught) and flagged 1 of 11 right ones (`hard-job-queue`, acceptance fail).
- With the user's default config, Codex first stopped to ask for approval and changed nothing. Casper's
  receipt said `unchanged`, not `verified`. Codex runs are 3-10 minutes each at maximum effort.
- Wrapping took no Casper changes. The only coupling is the tree snapshots and `repair(prompt)` → `codex exec resume <thread>`.

## Claude Code as the builder (prototype)

Same prototype with `--agent claude` (`claude -p`, repairs through `--resume <session>`). Claude Code ran Opus 5.5
(`claude-opus-5-5`) at the user's default effort, and DeepSeek wrote the acceptance tests. Raw data:
`.scratch/any-agent/claude-hard/`.

- 12 runs (6 tasks at repeat 2): 10 right, 2 wrong (`hard-conditional-http` #1, `hard-rate-limiter` #2; both failed the
  hidden acceptance tests). Casper said `verified` on both (0/2 caught) and flagged 1 of 10 right ones
  (`hard-money-allocation`, acceptance fail).
- Runs took 51-89 s at medium effort. `hard-config-merge` #1 took 573 s, before the user switched Opus 5.5's
  default effort down.
- Six Claude sessions at once on one subscription all hit the 600 s limit and produced nothing (`aborted/`). Two
  at a time worked. The run was paused once to protect the subscription.

## What this means

1. Tests written by one model from the request alone are not a verdict any of these models can deliver on
   this pack. The noisy writer catches more (see the previous run); the quiet one catches little. No replay reached
   caught ≥ 70% with flagged ≤ 20%.
2. Replay plus the early-stop gate are the lasting result: a new check now costs minutes against the same 11
   saved misses. The next candidate (ADR 0001: requirement-to-test tracing) is measured this way first.
3. "Casper checks any agent" works mechanically for both Codex and Claude Code, and the receipt stayed honest
   about what it checked. It added no catches on strong builders: Codex was wrong on 1 of 12 runs, Claude Code on 2 of 12,
   and Casper said `verified` on all 3. These are the same misses as before: stated requirements no test caught.
