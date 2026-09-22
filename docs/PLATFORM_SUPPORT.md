# Platform support — macOS, Linux, Windows

Status: implemented. macOS is the only platform with recorded host validation;
Linux shares the POSIX code paths without a recorded host run, and Windows is
implemented with simulated-platform tests. See **Evidence** and **Limits** below,
and [PLATFORM_VERIFICATION.md](PLATFORM_VERIFICATION.md) for the runbook that
validates a host (`bun tools/platform-report.ts`).

Casper's OS differences live in one Casper-owned layer, `src/platform/`. No OMP or
`pi-*` code is used: OMP solves these problems in native Rust, while Casper stays a
Bun/TypeScript program whose control plane calls only documented OS interfaces.

## Process ownership — `src/platform/processes.ts`

One model owns every process Casper spawns (debugger adapter, browser, development
server, verifier command, LSP server, MCP stdio server):

- **POSIX** — `ps -axo pid=,ppid=,pgid=,lstart=` (trying `/bin/ps`, `/usr/bin/ps`,
  then `PATH`). Ownership follows parentage from the spawned root; process groups
  are signalled as a unit when a group leader is itself a proven descendant.
- **Windows** — no process groups exist, so the table comes from PowerShell
  `Get-CimInstance Win32_Process` with a `wmic` fallback. Descendants are
  terminated individually, children first and the root last, and only after their
  creation stamp still matches the observed record.
- **Identity** — records are keyed by PID plus an OS identity stamp (`lstart` on
  POSIX, `ToFileTimeUtc()` on Windows). A reused PID is a different process and is
  never signalled. A pid reported by an adapter is never kill authority.
- **Fail closed** — an unusable or empty listing marks cleanup **unknown**. The
  debugger blocks new debugger/model/workspace work. The other managed callers now
  await cleanup too: browser/LSP/MCP retain a cleanup error and refuse replacement;
  verifier cleanup failure blocks further checks and aborts repair. Casper retains
  these failures before subsequent execution, while local status/help remains
  available. Budgets (1,024 live / 4,096 tracked identities, 64 parentage levels)
  are unchanged.

Termination policy for spawned trees is one shared function: POSIX signals the
process group (falling back to the direct process when the root is not a group
leader), Windows terminates verified descendants. POSIX consumers therefore keep
their previous exact and cheap behavior, while Windows no longer degrades to
killing only the direct child. An owner's repeated TERM/escalation/close requests
share one cleanup promise and its result. The POSIX wrapper remains best-effort
signalling, not an independent observation that every descendant has exited.

Regression coverage includes the actual browser-server, verifier, app, LSP and MCP
caller lifecycles with an unavailable simulated non-group process table. Those
cases run in isolated Bun processes; their POSIX-only teardown cleans up the
fixture processes deliberately left alive by the simulated failed listing. This
is not a Windows host run.

## Environment isolation — `src/platform/environment.ts`

Spawned adapters, browsers and development servers receive an allowlisted
environment with a temporary user directory: `PATH`, `HOME`, `TMPDIR` on POSIX, and
on Windows `PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`
plus the loader variables Windows needs to start a process at all (`SystemRoot`,
`windir`, `SystemDrive`, `ComSpec`, `PATHEXT`, `NUMBER_OF_PROCESSORS`,
`PROCESSOR_ARCHITECTURE`, `OS`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`).
Provider credentials are never inherited on any platform.

## State-file access — `src/platform/files.ts`

`O_NOFOLLOW` and `O_NONBLOCK` do not exist on Windows; composing them there yields
`NaN` access flags, which fails every open. `openNoFollow`, `openNoFollowUpdate` and
`openFollowed` centralize the flags: POSIX keeps the atomic no-follow and
non-blocking guarantees, Windows performs an explicit pre-open `lstat` rejection of
a final symlink. That fallback is an observation, not an atomic guarantee — the same
non-atomic caveat the POSIX callers already document. Converted callers: reference
search, memory store, LSP configuration and workspace snapshots plus rename writes,
MCP configuration, debugger configuration, verification workspace state, and the
startup model preference.

## Removed platform blocks

- `src/debug/session.ts` no longer refuses to start on Windows; ownership and
  cleanup come from the shared layer.
- `src/browser/server.ts` and `src/browser/session.ts` no longer refuse Windows.
  Installed-browser discovery now covers macOS `/Applications`, Linux `/usr/bin`
  and `/snap/bin`, and Windows `ProgramFiles`, `ProgramFiles(x86)` and
  `LOCALAPPDATA` Chrome/Edge locations. `CASPER_BROWSER_EXECUTABLE` still overrides.
- Diagram artifact files stay macOS/Linux only (POSIX `openat` through Bun FFI). The
  router now degrades **explicitly** there — the diagram renders in conversation, the
  note says artifact files need macOS or Linux, and `/visualize` reports the same —
  instead of failing the whole request. Artifact writes are not emulated on Windows.

## Test-suite hygiene

The suite explicitly gates known POSIX-only fixtures; remaining fixture portability
problems can still appear on a host that has not run it. POSIX-only
fixtures (Python 3 PTY drivers, symlinks, FIFOs, POSIX mode bits, `/bin/sh` hooks,
process groups and signals) declare an explicit skip through
`tests/support/platform.ts` instead of failing, and the whole-test `return` guards
became visible skips. That module is the one place that decides whether a fixture can
run here, and every capability it gates on is *probed* (`needsSymlinks` creates a
link, `needsFifos` runs `mkfifo`, `needsPosixModes` checks that a mode is both
reported and enforced) rather than inferred from the OS name.

**A fixture check command no longer needs a shell.** Casper executes a configured
check through the platform shell, so a fixture whose check was `printf x >> test-runs`
could only run on a POSIX host. Those checks are now built by
`tests/support/check-command.ts` and run `tests/fixtures/check-script.ts` through the
runtime executable by absolute path — no redirection, globbing or quoting, so the
same command string parses as ordinary argv in `sh` and `cmd.exe`. Five suites
(`phase3-verification`, `work-driven-checks`, `phase3-app`, `coding-loop-evidence`,
`phase8-pi.integration`) were converted; their POSIX assertions are unchanged and
every one still runs on macOS.

What is left is POSIX by subject — PTY, FIFO, symlink privilege, mode bits, process
groups, signals, the POSIX installer — or a native command the *product* parses as
text (a model-issued `rm`/`ln -s`/`test -f … && rm …`), which cannot be replaced by
the fixture script without changing what the product observes.

That is hygiene, not coverage. The rewritten fixtures have not run on Windows or
Linux, Windows still has no run of those suites, and the remaining categories need
platform-neutral fixtures written and verified on a Windows host — see
[PLATFORM_VERIFICATION.md](PLATFORM_VERIFICATION.md) for the per-suite list.

## Evidence

- `tests/platform-processes.test.ts` — real POSIX descendant/group cleanup with a
  live unrelated-process control; simulated non-group platform proving children-first
  ordering, root last, reused-PID rejection, unrelated processes untouched, and
  fail-closed `unknown` on an untrustworthy listing; grouped-ownership verification
  with an unrelated group ignored; allowlisted-environment contract; final-symlink
  rejection.
- Existing suites cover the converted callers (references, memory, LSP, MCP,
  verifier, debugger, browser, visualization) on POSIX.
- Final isolated serial gate on the frozen tree: **525 pass / 0 fail / 5,364
  assertions**, 46 files, 249.39 s, TypeScript clean, no skips, with installed Chrome
  and installed debugpy 1.8.20 (`/tmp/casper-xplat-final.KvGyZy/check.log`).

## Review and corrections

Same-agent Standards/Spec review; no independent reviewer was available, so no
independent sign-off is claimed. Two gaps were found and corrected during review
rather than left in place:

1. The first shared `terminateTree` swallowed a POSIX `ESRCH`, which silently dropped
   the existing direct-child fallback used when a root is not a process-group leader
   (managed development servers, the launched browser). It now signals the group and
   falls back to the exact process only on `ESRCH`.
2. The MCP stdio transport spawns through the SDK, so it initially kept the old
   direct-child kill. It now owns the stdio server's tree through the same policy
   (the SDK spawn is not detached, so POSIX is unchanged and Windows gains descendant
   cleanup).

Known deliberate asymmetries, not findings: diagram artifacts stay POSIX-only rather
than emulating `openat`; MCP and launched-browser children on POSIX remain
direct-child kills because those spawns are not detached; Windows pays one process
listing per owned spawn and per debugger operation.

## Limits

- **A verification command is a shell command, and the shell is the platform's.**
  `src/verify/command.ts` spawns checks with `shell: true`, so a configured check runs
  through `sh` on macOS/Linux and through `cmd.exe` on Windows. Checks written with POSIX
  utilities (`printf`, `test -f`, `grep`, `sleep`, `mkdir -p`) therefore only work on a
  POSIX host; a project that must be checked on both writes commands the platform shell
  understands (for example the runtime executable with a script, as
  `tests/support/check-command.ts` does for this repository's fixtures).
- **Mode bits are a POSIX guarantee.** State files, memory logs, learning state,
  credentials and browser screenshots are written owner-only with `chmod`, which Windows
  neither stores nor enforces; the fixtures that assert `0o600`/`0o700` are gated by the
  `posixModes` probe in `tests/support/platform.ts` instead of failing there.
- **Windows has no recorded host run.** Its behavior is implemented and covered by
  simulated process tables plus the shared POSIX suite; the PowerShell/wmic listing,
  Windows signal semantics and Windows browser/adapters are not host-validated.
- **Linux has no recorded host run either.** All recorded gates ran on macOS; Linux
  exercises the same POSIX branches and the same `ps`/group semantics.
- Process discovery is non-atomic and bounded. Unobserved daemonized descendants,
  PID-reuse races and host SIGKILL/power loss are not certified on any platform.
- Approval and consent are not confinement; adapters, debuggees and page scripts can
  still execute arbitrary code, read files and use the network.
- No adapter, browser or dependency is installed automatically on any platform.