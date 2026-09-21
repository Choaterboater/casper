# Acceptance trial plan — Casper inspecting its own repository

**Status: approved and executed once; no further run or patch application authorized.**
The user confirmed the original limits after the timeout/effort clarification.
[Trial 01 results](acceptance/TRIAL_01.md): the saved candidate passes the separate
behavior controls and serial gate, but Casper's managed full suite hit its
120-second command timeout and the live task exited 1. The 10-minute task limit
was not reached. Temporary credentials were removed; original code/settings were
preserved. The candidate patch remains unapplied.

The plan below is retained as the original scope and acceptance criteria. Its
“proposed”/approval wording describes preparation, not authorization for another
attempt. This was a self-hosted coding trial, not independent Phase 9 acceptance
or broad real-project validation.

## One task, performed by Casper

Use a disposable snapshot of the current Casper working tree. Ask the existing
Casper CLI—not this supervising agent—to reduce redundant Git subprocesses in
`inspectProject`, while preserving its project-root and branch behavior. This is
report item O4 used as a bounded evaluation task, **not authorization to continue
the optimization backlog**. Do not give Casper a prewritten implementation.

Proposed model-edit allowlist:

- `src/project/inspect.ts`
- one new `tests/project-inspect.test.ts`

No other production files, dependency changes, configuration changes, commits,
pushes, credential access, external integrations, delegates or skill/reference
promotion. Tests may initialize/commit temporary Git fixtures outside the candidate
repository; this does not authorize committing the user's repository.

These are supervised instructions and post-run diff checks, not a filesystem or
network sandbox. Native tools remain unsandboxed. Do not run on sensitive source
without a separately agreed environment that provides the required isolation.

## Baseline and proposed acceptance criteria

Last serial working-tree gate before preparation: **389 tests / 2,599 assertions**,
TypeScript clean, 118.66 s. This is historical evidence; rerun against the frozen
snapshot before the trial. `HEAD` is `c8df223`, but that alone is **not** the baseline:
the current uncommitted learning, fixes and optimization slices must be included.

Before any model invocation, preserve a file manifest/digests and the original
snapshot, plus exact provider/model selection, runtime/dependency versions,
configuration and the task prompt. Keep runtime code frozen in a separate runner
copy; execute against a candidate copy so candidate edits cannot change the agent
that is evaluating them. Keep personal project state and the original working tree
out of the trial's write targets. Do not copy credentials into evidence or model-
readable candidate files. Proposed credential handling, requiring explicit approval:
create one mode-0600 copy of the existing provider auth file in isolated runner
state outside the candidate; leave original credentials/settings unchanged, never
print the contents, and remove the temporary credential copy afterward. Copy only
the provider/model settings needed for the approved run, not executable extensions
or unrelated personal configuration.

Proposed public test seams: `inspectProject(cwd)` and the real CLI `/project`
output. Confirm these with the user before creating an evaluator test suite.

A successful candidate must:

1. Preserve `ProjectInfo` fields and meanings: resolved cwd, canonical Git root,
   root-derived name, Git/non-Git status, branch name or `null`.
2. Correctly handle a normal committed repository, an unborn branch (new repo),
   detached HEAD, a nested working directory, a linked worktree and a non-Git
   directory. Include a directory name containing spaces/Unicode.
3. Demonstrate fewer redundant Git invocations for ordinary Git inspection;
   subprocess observations are performance evidence, separate from behavioral
   correctness. Do not require a particular command string or implementation.
4. Pass the evaluator's behavior controls, candidate-written tests, TypeScript
   and the entire existing **serial** suite, with no weakened/removed assertions.
5. Stay inside the edit allowlist. No dependency changes, external calls beyond
   the approved model provider, source-tree commits/pushes, or unrelated edits.
6. Produce an understandable receipt: what changed, checks actually run, command
   exits, known limitations and remaining uncertainty. Model completion or CLI
   exit zero alone is not success or human acceptance.

Use fresh-process ABBA measurements before/after on the **same Git fixture**.
The existing startup benchmark uses a non-Git directory, so it cannot establish
savings from removing the second Git command. Preserve raw samples; report no
material speedup if ranges overlap. Correctness and measured process-count
reduction matter more than a promised millisecond target.

## Run limits — proposed, not yet authorized

- One Casper CLI task, supervised, at most **10 minutes wall clock**; terminate
  on expiry and preserve partial evidence. A task may include multiple provider
  turns/tool calls; this is not a one-request token bound.
- No rerun or supervising-agent code repair if it fails. Capture the failure,
  evaluate the candidate and ask for a new decision. Test failures are evidence,
  not permission to expand scope.
- Use existing `--verify` behavior; in disposable trial-only configuration set
  `repair.maxAttempts: 0` so the trial does not add post-task model repair turns.
  Allow the existing primary coding loop to run tests. Freeze that configuration
  before the task; the candidate must not change it.
- Declare only the intended typecheck/test commands. Missing lint/build checks
  must remain honestly unrecorded/skipped; do not invent fake passing commands.
  Run acceptance checks separately regardless of what the model selects.
- No MCP/LSP connection, external reference source, research activation or
  automatic delegation. Keep candidate data and logs separate from ordinary
  human facts, learning drafts and acceptance records.
- **Provider/account and usage allowance are undecided.** Proposed: the user's
  existing Codex subscription for this one timed task, with no separately paid
  API provider. Confirm availability/billing behavior before launch.
- Casper currently has **no enforced dollar/token cap** for parent tasks and its
  runtime-neutral events do not expose usage totals. If a strict dollar ceiling
  is required, use an approved provider-side limit or do not launch. Wall-clock
  limits are not spending caps. Record provider-reported usage/cost if available;
  otherwise mark them unavailable rather than estimate or call the run free.

## Evidence and decision afterward

Save the frozen baseline identity, exact prompt, candidate diff, test logs and
exit statuses, ordered timing samples, elapsed time, tool/turn counts if available,
interventions, and provider-reported usage/cost (or unavailable). Summarize:

- **Correctness:** evaluator results and scope compliance.
- **Usability:** understandable output, questions/blockers and human intervention.
- **Cost/time:** observed elapsed time and available usage—not speculative savings
  versus a human or another assistant.
- **Acceptance:** explicit human decision, separate from checks.

Do not apply the candidate to the original working tree without approval. A
successful self-hosted trial does not validate learning/promotion quality,
production integrations, arbitrary repositories or daily-driver readiness.

Independent Standards/Spec review of the complete Phase 9 working-tree delta is
still required. No independent review-agent tool is available in this session;
this supervising agent cannot satisfy that gate by reviewing its own work again.
Arrange separate reviewers/tools and any needed budget explicitly. The existing
`docs/DEBUG_OPTIMIZATION_REVIEW.md` is not independent acceptance.

Human promotion remains unimplemented and paused. This trial neither completes
it nor silently removes it from Phase 9. After evaluation, explicitly decide
whether to implement it or formally revise the phase scope. Phase 10 stays paused.

## Approval needed to launch

Confirm **Casper as the candidate project**, the task/allowlist/seams above, and
**one supervised 10-minute task using the existing Codex subscription**, no reruns
or separately paid API provider. Alternatively specify a different real project
or provider allowance. This approval must also cover the temporary owner-only
credential copy described above, outside the candidate and evidence and removed
after the run.
