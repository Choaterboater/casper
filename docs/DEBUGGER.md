# Local debugger — Phase 10 completion scope

Status: implemented and validated. Together with browser-first Phase 10A, this
completes the scoped Phase 10 debugging work. CasperCloud is reference material,
not an integration deliverable. Generic RPC, remote collaboration and additional
clients remain optional future work. See [release review](PHASE10_DEBUGGER_REVIEW.md)
for the **518-test** gate, real-adapter evidence and limitations.

## User contract

One explicitly configured, human-started stdio DAP session per active workspace.
`/debug` is local status/configuration listing, never an automatic adapter launch.
`/debug start <target>` requires fresh exact approval showing the resolved adapter,
arguments, debuggee, working directory and initial breakpoints. Project metadata is
not execution permission. No adapter installation or personal account use.

Configuration is only `<project>/.casper/debug.json` (lazy, at most 64 KiB), with
up to 16 named targets. A target contains `command` (absolute adapter executable),
`args`, `adapterID`, `program` (project-relative regular file), optional project-
relative `cwd`, optional `programArgs`, and optional `breakpoints` mapping source
paths to one-based line arrays. Unknown fields fail closed. Resolve paths and show
the exact normalized definition before consent; re-read it after consent. This is
non-atomic inspection, not a filesystem sandbox or a digest of every executable.

Example using an already installed Python/debugpy adapter (replace both paths):

```json
{
  "targets": {
    "example": {
      "command": "/absolute/path/to/python3",
      "args": ["/absolute/path/to/debugpy/adapter"],
      "adapterID": "python",
      "program": "example.py",
      "breakpoints": { "example.py": [12] }
    }
  }
}
```

Commands:

- `/debug` — targets and actual session state.
- `/debug start <target>` — confirm exact execution and start with stop-on-entry.
- `/debug breakpoints <relative path> <line,line|clear>` — replace that file's list.
- `/debug threads` and `/debug stack <thread-id>` — bounded thread/stack inspection.
- `/debug scopes <frame-handle>` and `/debug variables <variable-handle>` — explicit
  inspection only; use the returned opaque handles, not adapter internals.
- `/debug continue <thread-id>` — resume; all prior frame/variable handles expire.
- `/debug stop` — disconnect/terminate launched debuggee and close owned resources.

No attach, stepping/pause controls, conditional breakpoints, arbitrary evaluate,
variable mutation, memory access, reverse-request execution, remote adapter
connection, external-terminal launch, automatic model
injection or stored raw debug transcript. Native tools retain their existing power;
this debugger interface is not an OS sandbox. Variable inspection can itself invoke
adapter/runtime formatting logic. Values can contain secrets; no secret detector
is claimed. Debugging/adapter exit is not repository verification or acceptance.

## Lifecycle and bounds

State: idle, starting, running, stopped, closing, closed or failed. Adapter exit and
adapter-reported debuggee exit are distinct. A stopped state is not program exit.
References are valid only for the current stop; late responses must not revive
stale state. Launch must not wait for its response before sending configuration:
some adapters respond only after `initialized` and `configurationDone`.

Requests serialize (busy calls reject). Launch/operations have a 15-second deadline;
configuration requests each have 5 seconds. At most 256 operations per session,
32 threads, 32 frames, 16 scopes, 64 variables, 32 breakpoint files/128 lines per file.
Protocol frames at most 1 MiB, header at most 8 KiB, cumulative adapter stdout at
most 16 MiB. Delivered JSON at most 16 KiB after terminal escaping, with truncation
explicit. Adapter stderr/output events are discarded, not printed or persisted.

Cancellation during an active command, EOF, shutdown and workspace/conversation
transitions revoke the session and clean up owned resources. When the editor is
idle with a live debug session, use `/debug stop` explicitly. A normal model task
cannot inherit an active debugger: it must be stopped before handing execution
back to the model. No adapter starts
at ordinary application startup. Adapter environment uses a temporary HOME and an
allowlist, not inherited provider credentials; this does not prevent project code
from reading files or making network requests.

Close requests DAP disconnect, then bounded process cleanup. Never kill a PID just
because an adapter reports it. Any separately grouped descendants must be identified
through OS parentage before cleanup; preserve unrelated processes. Report uncertainty
rather than equating an acknowledgment or adapter death with verified debuggee
termination. Unconfirmed cleanup blocks new debugger/model/workspace work; restart
is not proof that a surviving process is gone. Track at most 4,096 OS identities;
inspection is non-atomic and does not certify unobserved daemonized descendants.

POSIX identifies ownership with `ps` parentage and terminates process groups.
Windows has no process groups: the table comes from PowerShell
`Get-CimInstance Win32_Process` (legacy `wmic` fallback) and cleanup terminates only
records whose creation stamp still matches, children first, root last. A pid whose
stamp changed is a different process and is never signalled. Where that listing is
unusable the session reports **unknown** cleanup and blocks further work instead of
guessing. Windows has not been validated on a real host; Linux shares the POSIX path
and has no recorded host run. Casper exposes no remote listener; an adapter such as
debugpy may use its own local sockets behind its stdio interface.

## Test interfaces and evidence

Tests use the Phase 10 plan's public debugger interface plus Casper app/CLI seam,
real subprocess framing and a deterministic synthetic adapter. Installed debugpy
1.8.20 also passes real breakpoint/variable/exit/stop/crash tests. No external
model/account trial was used. Coverage includes denial, changed config, malformed
and oversized frames, failed requests, timeouts, late replies, stale handles,
reverse-request rejection, bounds, terminal controls and positive owned/unrelated
process controls. Real PTYs cover fresh consent, EOF and SIGTERM; a real worktree
fixture covers capability revocation. See the review for the cancellation race,
160-launch correction loop and isolated cleanup fault probe.

For real-adapter tests outside this host, set `CASPER_TEST_DEBUGPY` to an already
installed debugpy adapter directory and `CASPER_TEST_PYTHON` to its Python executable.
Tests otherwise look for an installed VS Code debugpy extension; absence is an
explicit skip. No automatic installation or universal adapter support is claimed.

## Primary-source inspection

- [DAP overview](https://microsoft.github.io/debug-adapter-protocol/overview): stdio
  framing, asynchronous launch/configuration, stop-scoped references and disconnect.
- [DAP specification](https://microsoft.github.io/debug-adapter-protocol/specification):
  request/response/event types, capabilities, `configurationDone`, `setBreakpoints`,
  `threads`, `stackTrace`, `scopes`, `variables`, `continue`, `disconnect`.
- [OMP DAP client](https://github.com/can1357/oh-my-pi/blob/d716bcf60ab0a2e7ece1fdf382c0d143fef1f307/packages/coding-agent/src/dap/client.ts)
  and [session](https://github.com/can1357/oh-my-pi/blob/d716bcf60ab0a2e7ece1fdf382c0d143fef1f307/packages/coding-agent/src/dap/session.ts):
  useful launch-order, request-lifetime and cleanup patterns; no OMP dependency or
  wholesale copy. OMP's attach/evaluate/reverse requests are not this contract.
- Installed debugpy launcher source: `debugpy/launcher/debuggee.py` creates a
  separate process group. Killing only the adapter's group is insufficient evidence
  of debuggee cleanup; test the real process lifetime.

Throwaway probe evidence: `/tmp/casper-dap-research/`. Installed LLDB answered
initialize but did not complete launch within the probe's 12-second bound; it is
not accepted as validated support. Installed debugpy completed a real breakpoint,
threads/stack and disconnect, and the fixture debuggee was gone afterward.
