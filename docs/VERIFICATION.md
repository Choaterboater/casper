# Verification and repair

Casper runs the project's checks itself after the model edits files, then prints a plain receipt
of what changed and what was verified. Whether it does so depends on the **verification mode**:

| Mode | After a model turn that changed files |
|---|---|
| `auto` | Casper runs the selected checks, hands failures to bounded repair, and records the results. The model may still use `casper_check` while iterating; its fresh passes are reused, not rerun. |
| `offer` | The model may use `casper_check`; nothing else runs. The receipt suggests `/verify`. |
| `off` | No managed checks during tasks. `/verify` still works. |

```bash
casper                               # interactive: auto once checks are known to be fast, else offer
casper --verify "Fix the login flow" # auto for this run
casper --no-verify                   # off for this run
casper "/verify"                     # all configured checks, no model
casper "/verify typecheck test"      # selected checks, in this order
casper "/verify repair test"         # start the model only if a check fails
```

**Choosing the mode.** A flag wins for its run, then `verification.mode`, then the surface default.
Unconfigured interactive sessions use `auto` once Casper has timed the selected checks under
60 seconds in total (any `/verify` or managed check run records the timing, per project and exact
command), and `offer` until then. Unconfigured one-shot prompts use `off`; pass `--verify`.
Embedders pass `CasperApp({ verificationMode })`; `autoVerify: true|false` is shorthand for
`offer`/`off`.

**What auto runs.** The checks in `verification.checks`, or every check with a configured or
detected command. Auto runs nothing when the model changed no files, and skips a check whose
declared scope (below) contains none of the changed files. If Casper could not compare the
workspace, it runs every selected check. Changes but no configured checks is **incomplete**
(one-shot exit 2). Cancellation rules are unchanged.

**Exit codes.** A one-shot run exits 0 when done, 1 when a check or the run failed, 2 when
checks were incomplete, and 130 when cancelled. By default a pass that later went stale, or
changes nobody verified, still exit 0 and the receipt says "Not verified". Add
`--require-verification` (which implies `--verify`) to make those exit 3. See
[SCRIPTING.md](SCRIPTING.md) for the full table and `--json` events.

`--verify`, `verification.mode: auto` and `/verify` are **explicit execution consent, not
sandboxing or persisted repository trust**. Use them only in repositories whose commands you trust.
Repair also authorizes model edits. **Native bash is unchanged:** a model's bash run of a check is
reported but never counted as verification.

## Receipts

```
✓ Changed 1 file: sum.js
✓ Verified by Casper: test passed (npm run test, 0.3s)
✗ Verified by Casper: test failed (exit 1) — log above; /verify repair test to fix
• Not verified — test ran via bash only (npm test: passed). Run /verify test to record a check.
• Not verified — no checks configured. Add verify.test to .casper/project.yaml.
• Not verified — stale: files changed after the last passing test. Run /verify test.
• No files changed, so Casper ran no checks
✓ Proven: test fails without this change (exit 1) and passes with it
✓ Proven, weakly: test passes with this change; without it test crashed or was killed (exit 139) instead of failing
⚠ Not proven: test passes without this change too, and no test was added or changed
```

## Requirements review

When the checks pass on a **code change in auto mode** with a `test` check (see below for what counts), Casper gives
the model one review round before proving the change: check every requirement the request and the
project docs (for example `CONTEXT.md`) state, one case at a time, confirm each is implemented and
tested, and fix any gap. The answer reports only the gaps and a count, not the requirements that were
already covered:

```
Requirements review:
- [x] unknown option exits 2 — tests/cli.test.ts       (a gap the review added a test or fix for)
- [ ] handshake timeout — not implemented              (a gap still open)
Covered: 5 of 6 requirements.
```

With no gaps it is just `Requirements review: all covered.` and `Covered: 6 of 6 requirements.`
(Re-listing every covered requirement made the round 41-44% of the wall time and its answer several
times longer, with no first-time-right gain in pinned runs.) The checks rerun only if the review
changed files. The receipt shows the review as **the model's own claim**, never as Casper's evidence:

```
• The model's review: all 6 requirements covered (1 gap fixed; its own claim, not checked by Casper)
⚠ The model's review says not done: handshake timeout — not implemented
• The model's review returned no checklist
• The model's review stopped at its 12-turn budget (its own claim so far, not checked by Casper)
```

An answer with a full checklist but no `Covered:` line is still read, and reported without the gap count.

An item the model admits is not done makes the change `not_verified`. The review round has its own
budget of 12 model turns (a `--max-turns` at or below 12 wins and stops the task as usual, exit 2).
A review that hits its budget ends there; Casper keeps any checklist from its last answer, marks the
review `incomplete` (receipt line above, `"incomplete": true` in the JSON receipt's `review`) and
goes on as after a finished review: the checks rerun if the review changed files, then the proof.
An incomplete review alone does not make the change `not_verified`; open items it listed still do.
The proof repair round (below) has the same 12-turn budget; the checks and the comparison after it
decide.

The review costs one more model round per such request. Such a change's first turn is the request as the user wrote it,
without Casper's task hints (project facts and selected skills still come first, with the request
labelled, and an under-specified target still gets the clarification nudge). The review then checks
every requirement, one case at a time (each missing option, each malformed value), reusing what
the model already read; if the tests also pass without the change, the proof round asks for one
that fails. In one pinned ablation the request alone was as accurate as the hinted first turn, with
fewer turns. If the work stops before the review (checks still failing after repairs, a turn
limit), no later round asks for tests. With the round off (below), the first turn asks for the
full checklist (`- [x] requirement — test`, `- [ ] requirement — why not done`) and the failing
test instead, and the review runs in no case. To turn the round off entirely:

```yaml
verification:
  review: false   # default true; the first answer's own checklist is still reported, and the change still proven
```

## Proving the change

A passing test check only shows the tests still pass; they may not exercise the change at all. For
a **code change in auto mode** (`--verify`, or `verification.mode: auto`) with a `test` check
configured, Casper also asks whether the tests *prove* the change. A code change is any added,
changed or removed source file (by extension; tests, docs, data and configuration do not count),
made for any request except one Casper classifies as a refactor, docs, inspection, diagram or
configuration request. The work decides, not the wording: "add X; you may add test files" is still a
code change.

1. Before the model starts, Casper copies the workspace (copy-on-write where the file system allows;
   `.git`, `.casper` and `node_modules` are left out, and `node_modules` is linked back in).
2. After the checks pass, it rebuilds the workspace **without the change**: the copy from before,
   with the tests (anything under a test directory, or named like a test) as they are now. It runs the
   `test` check there.
3. If that fails, it runs the same check on a copy of the current workspace. When that passes, the
   change is **proven**: the tests fail without it and pass with it. When it fails too, the copy
   cannot run the tests, and the receipt says Casper could not compare (never a false proof).
   The receipt names the exit code of the run without the change. A run that did not end as a test
   failure is weaker evidence and reads **Proven, weakly**: a timeout, a crash or signal (a shell's
   exit above 128), or a command that could not start (exit 126 or 127). A run with no exit status
   at all (killed before it could report one) is not proof: Casper could not compare.
4. If the check passes without the change, the change is **not proven**. Casper spends one repair
   round (within `repair.maxAttempts`) asking the model to add a test that fails without the change,
   then reruns the checks and the comparison.

An unproven change is not verified: its outcome is `not_verified` (`--require-verification` exits
3). A change Casper could not compare keeps its check result and says why. Test-only, docs-only or data-only changes, and refactor, docs, inspection, diagram and
configuration requests, need no proof. The comparison runs the test check once more
(twice when proven), so it adds that time to the run.

One-shot receipts name the next command as `casper "/verify repair test"`. `/receipt` (or
`--verbose` for a whole run) shows the detailed evidence form: command execution status, input
scope and freshness, reuse, and the "not independently certified" qualification described below.

## Configuration

`.casper/project.yaml` can specify canonical checks:

```yaml
verify:
  typecheck: bun run typecheck
  lint: bun run lint
  test: bun test
  build: bun run build
verification:
  mode: auto         # auto | offer | off; unset = surface default (above)
  checks: [typecheck, test] # checks auto runs; default: all configured
  timeoutMs: 600000  # per command; default 10 minutes, maximum 1 hour
  scopes:            # optional, project-local declarations; NOT inferred coverage
    test:
      inputs: [src, tests, package.json, bun.lock, tsconfig.json]
      exclude: [tests/coverage] # only if this is generated output, not test input
repair:
  maxAttempts: 3     # repair prompts, not initial verification; 0 disables repair, max 10
```

`verify:` is project-local and overrides `commands:` and detected commands by check name. Only nonempty typecheck/lint/test/build commands are accepted. `verification.mode`, `verification.checks`, timeout and repair settings also work in global/profile configuration, with project settings taking precedence. Commands and declared input scopes are loaded at startup and frozen during repair; restart after changing configuration or manifests.

Managed checks run sequentially at the project root using the platform shell and inherited environment. The tool accepts only a check name (`typecheck`, `lint`, `test`, `build`), not a command, scope, cwd, or timeout override. No dependency installation or missing-tool fallback is attempted. Requested absent commands are visible **skips**, never passes; an unavailable configured executable is a failure. `/verify` still defaults to typecheck → lint → test → build. Unselected categories are not required checks; selecting a missing command produces incomplete evidence.

Tool calls and post-task verification share one task-local evidence store. Concurrent managed calls serialize, and unchanged scoped passes are not executed again. At normal completion, selected passes with stale/unavailable freshness are rechecked once; known-invalidated failures are also rechecked before deciding on repair. Unknown/self-mutating inputs remain qualified rather than causing a freshness-seeking loop. Managed calls do not lock out native edits/bash or external writers: run checks after edits settle, and heed the non-atomic observation limits below.

A tool returns execution evidence to Pi's ordinary edit/check loop; it never starts a nested repair prompt. Unresolved actual failures reach the existing bounded repair owner after the main prompt settles, carrying the exact command, bounded output, exit status, available Git changed-file context, original request, and constraints. Post-task repair preserves that task's request; explicit `/verify repair` uses the objective of making the selected checks pass, not an unrelated earlier prompt. Failed checks rerun first; after they pass, multi-check selections revisit the full selection to catch regressions, reusing only passing results with matching **declared-input** evidence. A valid managed pass obtained during repair also avoids a duplicate command. New requests and explicit `/verify` calls always start fresh; captured old check tools are revoked. The model saying “done” is not a passing result. Up to three repair prompts run by default. Passing selected checks does not imply unselected checks passed.

The terminal shows the plain receipt and the tail of a failing check's output, not full logs; `--verbose` adds one evidence line per check run. Programmatic `CasperApp.runOnce()` returns a `VerificationReport` for verification runs, including all rounds. `getLastTaskResult()` returns a detached result for the last normal request, separating execution (`completed`, `failed`, `cancelled`) from optional verification; local commands clear this result. Coding requests print the plain receipt; `/receipt` prints the detailed execution/verification receipt, including bounded observed native edit paths, possible tool writes (including failed/partial writes), and exact-command shell observations. Successful general conversation without observed effects or verification omits that terminal receipt; the structured task result and local outcome are still retained. Failures/cancellation always remain visible. **Shell tool status is diagnostic data, not process-exit evidence:** native shell checks are not reused or counted as verifier passes. Terminal model error/abort stops skip further checks and repair, retain already-executed managed evidence as blocked, and produce CLI exit codes 1/130 rather than success; an intermediate provider error recovered by Pi is not a terminal failure. Otherwise verification exit codes remain 0 for pass, 2 for incomplete, and 1 for failure/blocked; completion without verification exits 0 without claiming verified behavior. Evidence includes cwd, command, status, exit code/signal, duration, stdout/stderr, failure reason, and truncation. Each stream retains at most 8 KiB of original bytes (head/tail plus a truncation marker); this bounded evidence is what repair receives. No evidence database or unbounded raw-log artifact is created.

**Command success, input freshness, declared scope, and behavioral coverage are separate facts.** Detailed reports (`/receipt`, `--verbose`) say `Checks pass (command execution)`; the plain receipt's "Verified by Casper" means the same: the named command passed on the files as they were when it ran, not that the requested behavior is certified. Stale or unavailable inputs remain explicitly unverified and cannot support reuse; they do not rewrite successful command exits or trigger a new repair/approval loop. Only actual check failures enter the existing bounded repair loop. Saved task outcomes and `/memory outcomes` retain exit codes, scope, freshness and a bounded freshness reason, without storing output or fingerprints. Human acceptance still starts unknown. Legacy outcomes remain readable, are labeled as legacy, and missing freshness stays unavailable.

`verification.scopes` is optional and project-local. Each check may declare literal relative `inputs` (files/directories, recursively; `.` means the project root) and optional `exclude` paths/subtrees. No globs, absolute paths, traversal, or fully excluded input roots; each list has at most 32 paths, each path at most 256 UTF-8 bytes, and each declaration at most 2 KiB. **No declaration means unavailable freshness and no reuse, not a command failure.** `.gitignore` is not an input contract: ignored files inside a declared scope are included unless explicitly excluded. Generated artifacts/coverage outside the input scope or explicitly excluded from it do not make a successful check stale.

Freshness is observed before/after each check and at report time; checks also refresh earlier evidence so one check cannot silently invalidate another. Observed native edit/write paths invalidate matching declared scopes even if later work restores directory membership, including edits overlapping a check. Native path syntax is expanded once before matching filesystem identities (including file URLs, tilde paths and aliases); an actual `@`-prefixed filename is not stripped again. Declared input roots are resolved too, including case aliases on case-insensitive filesystems, while exclusions retain the scope observer's traversal spelling. Observed included symlink entries also invalidate evidence, even when their targets are excluded or outside the scope and the links are later removed. Excluded links do not hide writes to included targets. Failed native writes conservatively invalidate possible partial changes without claiming a completed edit; missing targets retain their path beneath the nearest existing canonical parent. Possible case/Unicode aliases of the first missing entry (including a named input's parent) invalidate conservatively, and a missing suffix cannot establish an exclusion's traversal spelling. This may cause extra executions for ambiguous absent names even on case-sensitive filesystems; resolved prefixes and literal exclusions are not case-folded. Unresolvable or over-budget path observations conservatively invalidate scoped evidence. Resolved observations with neither an included target nor included symlink traversal do not invalidate other scopes, and observations do not select additional checks. Included file bytes/metadata and directory membership/modes are fingerprinted; named input creation/deletion invalidates previous evidence. Directory timestamps caused by excluded outputs do not affect the fingerprint. Included symlinks (including parents of named paths), special files, I/O errors, or limits (1 MiB/file, 16 MiB total, 4,096 work items, 500 ms checked between I/O operations) disable reuse with a specific reason. An unavailable before/after observation cannot later become a fresh check merely because the final observation succeeds.

**Declared scope is an assumption, not discovered dependency coverage.** For example, the sample above does not observe installed `node_modules`, environment variables, external tools or services. A lockfile does not prove installed dependencies are unchanged. If a check depends on excluded/unlisted inputs, changes there can go undetected: include them or leave the scope undeclared to disable reuse. Even a fresh scoped result does not certify behavior. These bounded observations are not atomic snapshots, a sandbox, or a guarantee against transient changes during commands or edits after reporting.

One-shot exit codes: **0** selected commands passed (execution only, even if freshness is stale/unavailable) or nothing needed verifying, **1** failed/blocked, **2** incomplete (skips, or auto mode with changes and no configured checks), **130** cancelled. Timeouts and cancellation terminate verifier process groups on POSIX; Windows terminates verified descendants through OS parentage, which has no real-host gate yet. One-shot SIGINT and any SIGTERM cancel checks and prevent further repair; the CLI gives cleanup up to one second, then exits even if runtime startup/abort is stalled. Interactive Ctrl-C cancels the active task while keeping the session; it drains existing cleanup without a forced per-task deadline. Programmatic `app.close()` drains runtime startup and verification before disposal but has no forced-exit deadline. Command timeouts do not bound model response time. Commands and runtime tools are not sandboxed, and command output may contain secrets—review your checks before sending their output to a model.
