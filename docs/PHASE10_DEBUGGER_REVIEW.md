# Phase 10 — local debugger completion and review

## Completion boundary

The user requested completion after multi-provider login and clarified that
CasperCloud is **reference material only**, not an integration deliverable. The
remaining local DAP workflow is now implemented. Together with the completed
browser-first Phase 10A, this closes the scoped Phase 10 debugging work.

This does not claim every historical wishlist item: generic SDK/RPC, collaboration,
remote sessions and additional clients remain optional future work, not acceptance
prerequisites. No CasperCloud code was changed. See [DEBUGGER.md](DEBUGGER.md) for
the as-built debugger interface, configuration and limits, and
[PHASE10_REVIEW.md](PHASE10_REVIEW.md) for browser evidence.

## Delivered

- Lazy `/debug` targets/status; project-only bounded `.casper/debug.json` metadata.
- `/debug start <target>` with fresh exact consent, resolved adapter/program/working
  directory, config/file revalidation and an isolated temporary HOME/environment.
- Source breakpoint replacement, thread/stack/scope/variable inspection, continue
  and stop. Initial breakpoint responses retain actual verified/unverified results.
- Correct asynchronous DAP initialize/launch/initialized/configurationDone ordering.
  Unsupported configuration capability fails before launch. No attach, evaluate,
  variable mutation, memory reads or reverse-request execution.
- Bounded protocol/inspection output, safe terminal JSON and opaque stop-scoped
  handles. Resuming or a new stop revokes previous handles; late results cannot
  publish prior-stop variables. Raw adapter logs/output events are discarded.
- Cancellation, EOF, SIGTERM, adapter crash and explicit stop drain owned resources.
  OS parentage establishes ownership for separately grouped descendants; adapter-
  supplied PIDs are never kill authority. Unknown cleanup is reported and blocks
  new debugger/model/workspace work rather than claiming success.
- Workspace/conversation transitions and model tasks close active debugging first.
  Debug values do not automatically enter prompts, task receipts or stored memory.
  Debug observations and adapter-reported exit remain distinct from verification.

## Release evidence

Final isolated serial `bun run check`: **518 pass / 0 fail / 5,345 assertions**,
**45 files**, **251.47 s**, TypeScript clean.
Log: `/tmp/casper-phase10-final.p1CBnq/check.log`.

All **38 Phase 10 tests** ran (20 existing browser + 18 debugger); no skips.
Chrome was already installed. Real debugger tests used installed **debugpy 1.8.20**
from VS Code extension **2026.6.0**, with `/usr/bin/python3`; no adapter install.
The gate explicitly supplied `CASPER_TEST_DEBUGPY` and `CASPER_TEST_PYTHON` paths
because its HOME is isolated. Elsewhere, missing real adapters produce explicit
skips, not real-adapter acceptance.

Two final debugger repeats: **18 pass / 117 assertions** each, 23.04 s and 22.53 s.
Logs: `/tmp/casper-dap-research/release-repeat-{1,2}.log`.
Existing LSP protocol and stress tests also passed after extracting their byte
framing into `src/protocol/framing.ts`; JSON-RPC and DAP semantics remain separate.

The serial gate used fresh HOME/TMPDIR/Pi directories and an allowlisted environment
with offline/telemetry flags. Provider tests use synthetic transport. No personal
credentials, live/paid model, production debugging, dependency installation,
repository commits or pushes. Temporary fixture Git commits remain isolated.

### Public-interface acceptance

- Synthetic adapter intentionally waits for configurationDone before answering
  launch. Tests verify the real wire sequence, not mocked session methods.
- Real debugpy hits entry and source breakpoints, reports `answer = 42` at the
  expected source line, and cleans up on normal exit, stop and adapter SIGKILL.
- Positive live-PID observations precede cleanup assertions. A TERM-resistant,
  separately grouped synthetic debuggee dies even when disconnect is ignored.
- Forged process events naming an unrelated live process cannot cause its death;
  reverse runInTerminal is rejected without executing the requested command.
- Failed/oversized framing, unsupported capabilities, request deadlines, explicit
  cancellation, malformed frames, stale handles/results and display bounds.
- Denied/changed configuration and redirected program cases spawn nothing.
  Closing an unresponsive approval revokes startup; a late yes cannot launch.
- Real production CLI PTYs exercise pretyped-yes rejection, fresh approval, stop,
  EOF and SIGTERM, with positive adapter/debuggee PID controls and no model/auth
  initialization. Existing login/editor/model/verification PTYs remain green.
- A real Git-worktree app fixture proves debugger processes are gone before the
  destination runtime is exposed; subsequent model work also revokes debugging.

## Corrections and causal evidence

1. The launch tracer failed before implementation. Real source/variable inspection
   then passed with the correct launch/configuration handshake.
2. Closing during an unresponsive approval initially waited for the callback.
   The regression failed, then passed after racing approval against cancellation;
   the late answer is still gated before spawn.
3. The workspace fixture initially failed because its adapter observation files
   made Git dirty. Only those test-harness filenames were added to the fixture's
   committed `.gitignore`; production worktree cleanliness rules were unchanged.
4. The first full gate reached **517 pass / 1 fail / 5,330 assertions**. Immediate
   post-launch cancellation sometimes left the separately grouped debuggee alive.
   Log: `/tmp/casper-phase10-debugger.DpixU1/check.log`.
5. Targeted tracing reproduced the race in the fourth repeated 8-launch test.
   The process scanner had reused a coalesced snapshot taken before the debuggee
   spawned. Disconnect then removed parentage before a newer scan could own it.
   Shutdown now drains the old scan and takes a **fresh** snapshot before disconnect.
   This fixes the observed causal ordering, not a blanket daemon-cleanup guarantee.
6. Ten traced and ten clean repeats after the fix passed: **160 cancellation
   launches**, including **80 without instrumentation**. All temporary trace code
   was removed before the final gate; no deadlines or assertions were weakened.
7. An isolated copied-source fault probe disabled SIGKILL escalation. The positive
   live-process control still passed and the dead-process assertion failed, proving
   the cleanup test can detect that defect. Test teardown removed its own remaining
   fixture process. Log: `/tmp/casper-dap-research/fault-kill.log`.

An installed LLDB probe answered initialize but did not complete launch within its
12-second experimental bound. No developer/security settings were changed to force
it through, and LLDB is **not** claimed as validated adapter support.

## Standards review

**No outstanding blocking findings in the scoped increment.** Same-agent review;
no independent reviewer/sub-agent tool was available. Existing runtime neutrality,
process/consent ownership and the code-review naming/duplication/responsibility
heuristics were applied. No new dependency, provider runtime, speculative generic
RPC framework or competing repair loop was added.

`DebugSession` is the public test/caller interface. Configuration, DAP request
correlation and OS process ownership remain internal. Reused Content-Length byte
framing is the only extracted LSP implementation; debugger events are not treated
as JSON-RPC. UI discovery is local and dynamic debugger loading remains lazy.

## Spec review

**No outstanding blocking findings against the bounded local-DAP acceptance plan**
and `DEBUGGER.md`. Explicit launch authority, bounded inspection, stale-reference
revocation, safe diagnostics and lifecycle tests are implemented. Browser-first
acceptance and normal coding execution remain unchanged. No raw debug transcript,
automatic model injection, remote attach or process-ID-based kill authority was
introduced under the name of debugger support.

## Preservation and limits

HEAD remains `d6e24836c1509188f3e298e8ca4caeb134cd031b`; all work is uncommitted.
Review used the pre-edit hash inventory, direct reads of new files and scoped
working-tree changes, not a commit-only three-dot diff. Before documentation updates,
the only pre-existing files changed were `src/app.ts`, `src/tui/{help,commands}.ts`
and `src/lsp/protocol.ts`. Dependency files, user projects and prior login/browser
source remained unchanged. The unrelated existing Bun process PID 56873 remained
alive. `git diff --check` passed.

POSIX process discovery and config checks are bounded, non-atomic observations,
not a sandbox. Unknown/unobserved daemonized descendants, PID reuse races, host
SIGKILL/power loss and Windows are not certified. Cleanup status refers to tracked
owned processes; adapter-reported debuggee exit is separate. Adapters/debuggees can
execute arbitrary code or perform network/file effects; approval is not confinement.
Debugpy itself may use local sockets behind the stdio interface; Casper exposes no
remote listener. No cross-adapter or live autonomous debugging guarantee is made.
