# Acceptance trial 01 — self-hosted Git inspection

## Verdict

**Candidate correctness passed the agreed post-run controls; the live workflow did
not pass cleanly.** Casper's managed full suite timed out at its existing 120-second
command limit and the CLI exited **1**, honestly reporting failed verification.
The separate, unchanged candidate passed the host's serial gate in **120.49 s**.
The overall 10-minute task limit was **not** reached. No candidate code was repaired
by the supervising agent, no model rerun occurred, and the patch is **not applied**
to the original working tree.

This is one self-hosted coding trial. It does not complete Phase 9, establish
learning/promotion usefulness, replace independent Standards/Spec review or justify
Phase 10/daily-driver readiness.

## Authorization and setup

The user approved sticking to the original trial plan after clarification that
10 minutes was a proposed wall-clock timeout, not adaptive reasoning effort or a
spending cap. The agreed scope was Casper on a disposable copy of itself, restricted
to `src/project/inspect.ts` and a new `tests/project-inspect.test.ts`, one timed
Codex-subscription task, no post-task model repair/rerun, no commits/pushes or
automatic application. Protected temporary credentials outside the candidate/logs
were approved.

- Source baseline: `c8df223` **plus the then-current uncommitted tree**, 139 source
  files. [Identity](trial-01/identity.json) and [manifest](trial-01/baseline-manifest.json)
  pin the actual snapshot; HEAD alone would omit prior changes.
- Separate frozen runner, baseline and editable candidate copies. Installed
  dependencies were shared read-only by instruction via `node_modules` symlinks;
  this was not an OS sandbox. No original repository metadata/history was copied.
- Pinned Pi 0.85.1, MCP SDK 1.30.0, Bun 1.4.0, macOS arm64.
- Preflight recognized `openai-codex / gpt-6-astra` and reported subscription OAuth
  at the ChatGPT backend, not API-key auth. No custom provider or paid-API fallback.
- Session recorded **medium** thinking, with no later model/effort changes.
- Isolated settings disabled SDK task retry/compaction; trial configuration set
  `repair.maxAttempts: 0`. Only typecheck/test were declared. Scope freshness was
  undeclared and honestly reported unavailable; missing lint/build were not faked.
- Test commands unset the trial's `PI_CODING_AGENT_DIR` and `CASPER_PROFILE`; test
  subprocesses did not inherit the live credential configuration.
- A supervisor imposed 600 seconds plus termination cleanup; only one exclusive
  attempt marker was created. No dollar/token cap was claimed.

[Exact prompt](trial-01/PROMPT.md) · [trial configuration](trial-01/trial-configuration.yaml)
· [provider preflight](trial-01/provider-preflight.json) · [run status](trial-01/run-status.json).

## Baseline evidence — including the failed run

The first isolated gate failed three tests: **386 pass / 3 fail**. Two profile
failures were caused by the supervising harness forcing `CASPER_PROFILE=default`,
which correctly overrode the fixture's project selection. The third reproduced
the previously observed **SIGTERM verifier process-group cleanup failure**: the
`leaked` marker existed. That failure's cause remains **unresolved**.

Removing the erroneous environment override, without any source/test change,
yielded **389 pass / 0 fail / 2,599 assertions**, TypeScript clean, **117.63 s**.
Do not attribute the cleanup failure to the profile override or erase it because
the corrected-environment rerun passed. The public evaluator also passed all six
baseline behavior cases and `/project` before launching the model.

Logs: [initial baseline](trial-01/baseline-check.log),
[corrected environment](trial-01/baseline-check-corrected-env.log),
[baseline evaluator](trial-01/baseline-evaluator.json).

## What Casper did

One CLI task completed in **286.10 s (4m46s)**, with **13 assistant messages** and
**12 tool calls**: 2 reads, 1 list, 1 write, 3 edits, 3 bash calls and 2 managed
checks. No delegation, MCP/LSP connection, credential read, environment dump,
package installation, source commit or provider/effort switch appeared in the
recorded tool inputs. These are observed actions, not sandbox guarantees.

Casper authored eight behavior controls and one Git-invocation test before its
production edit. Its first focused run also hit a fixture error (`git tag` refuses
`HEAD`); Casper corrected that fixture with `update-ref` inside the primary loop.
The next run established passing behavior controls and a red process-count test;
all nine passed after the implementation. No supervising-agent intervention or
code repair was supplied.

The implementation combines the ordinary ref/root query and falls back to the
original probes for unresolved/ambiguous output. The candidate also tests Unicode,
spaces, embedded newline paths and an ambiguous HEAD tag. It explicitly discloses
fallback overhead instead of claiming a universal improvement.

### Managed check result

- Typecheck passed (and completion-time recheck passed).
- Full serial test command **timed out at 120,000 ms**, receiving SIGTERM; output
  was bounded/truncated. This is **not a passing full-suite result**.
- Casper's receipt retained that failure, unavailable input freshness and zero
  repair attempts. CLI exit **1**. It did not extend the timeout, edit the check
  configuration, request higher effort or initiate another model attempt.

The initial baseline was already close to that default command deadline. The
post-run candidate gate taking 120.49 seconds demonstrates insufficient headroom
in this trial configuration; it does not prove the candidate caused a general
performance regression or diagnose the earlier cleanup failure.

[Captured task/receipt](trial-01/trial-stdout.log) · [stderr](trial-01/trial-stderr.log)
· [session summary](trial-01/session-summary.json).

## Separate evaluation of the unchanged candidate

- **Scope:** only the two permitted files changed; the original source tree and
  original user auth/settings were unchanged at the end-of-run audit.
- **Behavior:** committed repository, nested directory, unborn branch, non-Git
  directory, detached HEAD and linked worktree all matched independently specified
  `ProjectInfo` values. Real CLI `/project` showed the expected root/branch.
- **Serial gate:** **398 tests / 2,609 assertions**, 0 failures, TypeScript clean,
  **120.49 s**. This host gate is distinct from the failed managed check.
- **No patch application:** only review artifacts were added to the original
  repository. `git apply --check` accepts the saved patch; it was not applied.

| Case | Baseline Git starts | Candidate Git starts |
| --- | ---: | ---: |
| Ordinary committed | 2 | 1 |
| Nested directory | 2 | 1 |
| Detached HEAD | 2 | 1 |
| Linked worktree | 2 | 1 |
| Unborn branch | 2 | 3 |
| Non-Git directory | 1 | 2 |

The extra non-Git call is a real trade-off not stated specifically in the model's
receipt; its general fallback warning is not a universal speedup claim.

Five ABBA blocks, ten fresh-process samples per variant, on the same committed
Git fixture: **89.11 → 60.05 ms median** (ranges **80.73–112.21 → 56.04–65.82 ms**).
This measures an inspection subprocess plus Git tracing/result collection, **not
whole CLI startup**, cold-disk latency or a human productivity comparison.

An initial timing run overlapped the host full gate and is retained separately as
[confounded samples](trial-01/candidate-evaluator-concurrent-check.json). The reported
comparison comes from a subsequent evaluator run with that gate finished, no code
changes and no additional model invocation. Do not combine the two samples.

[Canonical evaluator results](trial-01/candidate-evaluator.json) ·
[evaluator source](trial-01/evaluator.ts) · [candidate serial gate](trial-01/candidate-check.log)
· [scope audit](trial-01/scope-audit.json) · **[unapplied patch](trial-01/candidate.patch)**.

## Usage, privacy and limits

Session-reported usage: **75,819 total tokens**, including 18,705 input, 53,888
cache-read and 3,226 output tokens. It also reports 759 reasoning tokens; do not
add that again to the total. Actual subscription charge/remaining allowance is
**unavailable**. SDK cost estimates would not establish billing, and subscription
auth does not mean zero resource usage.

The temporary owner-only auth copy was removed immediately after the task. A
scan found no copied access/refresh token values remaining in the trial directory.
Original auth and settings hashes matched the preflight audit. Raw sessions remain
local outside the repository; published artifacts omit credential contents and
account identifiers. Source/task text is still plaintext.

Local runner/baseline/candidate snapshots and raw session evidence remain at
`/tmp/casper-acceptance-sgTCoi/` and may later be absent. The permanent patch,
manifest, prompt, evaluator and logs survive that directory. The evaluator records
that original temporary root; recreating the fixture requires pointing its `trial`
constant at replacement baseline/candidate directories with matching source.

The unresolved cleanup failure means a passing rerun is not proof of universally
reliable cancellation. Read/write/shell tools were not sandboxed, and an external
wall-clock supervisor is not a provider-side spending limit.

## Next decision

1. Review the candidate and its fallback costs; explicitly approve application or
   reject it. No automatic promotion/apply has occurred.
2. Before another trial, agree appropriate per-command timeout headroom (for
   example 180 seconds for this suite) separately from the overall task timeout.
   Do not raise timeouts mid-run or retroactively label this managed check passed.
3. The reproduced SIGTERM cleanup failure remains a bounded investigation candidate;
   do not expand into another open-ended audit or claim it resolved.
4. Arrange independent Phase 9 Standards/Spec review. Promotion remains paused and
   Phase 9 scope still needs its own decision. Do not advance to Phase 10 on this
   result alone.
