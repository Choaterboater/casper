# Platform support — macOS, Linux, Windows

**What this is:** what Casper 0.2.21 does on each operating system, and what has
really been tested on each. **When you'd use it:** before you run Casper on a new
kind of machine, or when something works on your Mac but not on Windows or Linux.

## Status at a glance

| OS | What is tested | What is not |
| --- | --- | --- |
| macOS | Tested by hand, plus the full test suite | See **Limits** below |
| Windows x64 | Install and startup, in CI (a GitHub build machine), under PowerShell 5.1 and 7 | The interactive screen, process cleanup on a real desktop, browser and debugger |
| Linux | Release build runs `casper-linux-x64 --version` on Ubuntu when a release is published | No recorded run of the full test suite or the interactive screen on a real Linux machine |
| Windows ARM64 | Nothing | There is no release file for it |

To test a machine yourself, run `bun tools/platform-report.ts` from a source checkout.
The step-by-step guide is [PLATFORM_VERIFICATION.md](PLATFORM_VERIFICATION.md).
Windows details are in [WINDOWS.md](WINDOWS.md).

All OS-specific code lives in one folder, `src/platform/`. It is plain Bun/TypeScript
that calls normal OS tools (`ps`, PowerShell). It does not use OMP or other `pi-*` code.

## Process ownership — `src/platform/processes.ts`

Casper starts helper programs: a debugger adapter, a browser, your dev server or
other services, check commands, language servers (LSP), MCP servers, the
`casper mcp check` server probe, and netconan (an optional secret checker). One piece
of code keeps track of all of them so it can stop them later.

- **macOS/Linux** — Casper lists processes with `ps -axo pid=,ppid=,pgid=,lstart=`
  (it tries `/bin/ps`, then `/usr/bin/ps`, then `ps` on `PATH`). It follows parent and
  child links down from the program it started. It stops a whole process group (a
  set of processes that can be signalled together) only when the group's leader is
  one of its own children.
- **Windows** — Windows has no process groups. Casper reads the process table with
  PowerShell `Get-CimInstance Win32_Process`, and falls back to `wmic`. It stops
  children first and the parent last, one at a time, and only if each one's start
  time still matches what it saw.
- **Identity** — each process is known by its PID plus its start time (`lstart` on
  macOS/Linux, `ToFileTimeUtc()` on Windows). If a PID was reused by some other
  program, Casper sees a different process and does not touch it. A PID that a
  debugger adapter reports is never enough on its own to stop a process.
- **When unsure, stop and say so** — if the process list is empty or unreadable,
  cleanup is marked **unknown**. The debugger then blocks new debugger, model and
  workspace work. The browser, LSP and MCP managers keep the cleanup error and will
  not start a replacement. A failed cleanup after a check blocks further checks and
  stops the repair loop. Local `/status` and `/help` still work.
- **Limits in the code** — at most 1,024 live processes, 4,096 tracked identities and
  64 parent levels.

### Long-running programs — `src/platform/managed-process.ts`

The browser's dev server and the services Casper runs (see [SERVICES.md](SERVICES.md))
share one runner. It:

- starts the shell command in its own process group, with the clean environment below;
- keeps the last 16 KiB of output;
- waits for an HTTP answer or a log line, up to a deadline;
- stops the program with TERM, then KILL, and reports an error if the result is unknown;
- can tell whether a local port is in use, and pick a free one.

It only accepts `localhost`, `127.0.0.1` or `[::1]` as the address to wait on.
Your own settings cannot replace the clean `PATH`/`HOME`/`TMPDIR` (and the Windows
profile variables), or the offline settings `BUN_INSTALL_AUTO=disable` and
`npm_config_offline=true`. Any HTTP answer on the port counts as "ready", so the
browser and the service manager both check that the port is free before they start.

### How a tree of processes is stopped

One shared function does it. On macOS/Linux it signals the process group (or just
the one process if it does not lead a group). On Windows it stops each child it has
checked. If several parts of Casper ask to stop the same program, they share one
cleanup and one result. On macOS/Linux this is a best-effort signal. It does not
separately confirm that every child has exited.

Tests cover the real browser-server, check, app, LSP and MCP cleanup paths with a
simulated broken process list. They run on macOS/Linux only. They are not a Windows
host run.

## Clean environment — `src/platform/environment.ts`

Debugger adapters, the browser, dev servers and netconan get a short, fixed list of
environment variables and their own temporary home folder:

- **macOS/Linux:** `PATH`, `HOME`, `TMPDIR`.
- **Windows:** `PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`,
  plus the variables Windows needs to start any program (`SystemRoot`, `windir`,
  `SystemDrive`, `ComSpec`, `PATHEXT`, `NUMBER_OF_PROCESSORS`,
  `PROCESSOR_ARCHITECTURE`, `OS`, `ProgramData`, `ProgramFiles`, `ProgramFiles(x86)`).

Your model provider keys are not passed to these programs on any OS. (MCP servers
and your project's check commands are started differently; see [MCP.md](MCP.md) and
[VERIFICATION.md](VERIFICATION.md).)

## Shell sandbox — `src/sandbox` (since v0.2.17)

| OS | What holds shell commands and checks |
| --- | --- |
| Linux | bubblewrap with seccomp (Unix sockets blocked) and a proxy that lets only listed hosts through; needs `bubblewrap`, `socat` and `ripgrep` (`sudo apt install bubblewrap socat ripgrep`). Casper tries bubblewrap once at startup; if it can't start (one missing, or Ubuntu 24.04's AppArmor user-namespace block: `Ubuntu blocks it (AppArmor restricts user namespaces …)`, fixed by `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`), the banner says why and the AI's shell asks before each command that changes something (reads like `ls` don't). |
| macOS | `sandbox-exec` with the same host proxy. |
| Windows | Nothing yet: the AI's shell asks before each command that changes something (reads like `ls` don't), and checks, services and dev servers run with your permissions. |

The compiled Linux executable carries the seccomp helper and writes it to
`~/.casper/bin/apply-seccomp-<sha256>` (0700) after a hash check. Linux CI installs bubblewrap,
socat and ripgrep and runs the live sandbox tests; see [SECURITY.md](SECURITY.md).

## Opening state files — `src/platform/files.ts`

On macOS/Linux, Casper opens its own state files with `O_NOFOLLOW` (refuse a file
that is a symbolic link) and `O_NONBLOCK`. Those flags do not exist on Windows.
`openNoFollow`, `openNoFollowUpdate` and `openFollowed` pick the right flags for
each OS. On Windows, Casper checks with `lstat` that the file is not a link just
before opening it. That is a separate check, not atomic: something could swap the
file in between. (The macOS/Linux callers document the same kind of gap.)

Code that uses these helpers: reference search, the memory store, LSP settings and
workspace snapshots (and rename writes), MCP settings, remembered MCP approvals,
imported MCP servers and the MCP docs copy, debugger settings, check state, the
changed-files list, and the saved startup model.

## Git calls — `src/platform/git.ts`

Every git command Casper runs itself adds `-c core.fsmonitor=false` and
`-c core.hooksPath=<null device>`. A cloned repo's `.git/config` can name programs
that git would run on its own; this stops them from running through Casper's own
git calls. It does not change the git commands the AI runs in its shell.

## Things that differ by OS

- **Debugger and browser** run on Windows too; cleanup comes from the shared code
  above.
- **Finding an installed browser:** macOS `/Applications` (Chrome, Edge); Linux
  `/usr/bin` and `/snap/bin` (Chrome, Chromium); Windows `ProgramFiles`,
  `ProgramFiles(x86)` and `LOCALAPPDATA` (Chrome, Edge). Set
  `CASPER_BROWSER_EXECUTABLE` to a full path to use another one.
- **Diagram files** are made on macOS and Linux only. On Windows the diagram is shown
  in the conversation instead, with a note saying files need macOS or Linux, and
  `/visualize` says the same. Casper does not fake file output on Windows.
- **Servers from your other tools (new in 0.2.15):** Casper looks for VS Code's
  `mcp.json` and `settings.json` in `~/Library/Application Support/Code/User` (macOS),
  `~/.config/Code/User` (Linux) and `%APPDATA%\Code\User` (Windows), plus the
  Insiders edition. See [MCP.md](MCP.md).
- **Remembered MCP approvals (new in 0.2.15):** on macOS/Linux, Casper ignores
  `~/.casper/mcp-consent.key` if other users can read it, and asks again for each
  server. Windows does not have those permission bits, so that check is skipped there.
- **netconan** (optional secret checker): on Windows Casper also looks for
  `netconan.exe`, `.cmd` and `.bat`.

## Limits

- **Checks run in your OS's own shell.** `src/verify/command.ts` runs each check with
  `shell: true`: `sh` on macOS/Linux, `cmd.exe` on Windows. A check written with
  POSIX tools (`printf`, `test -f`, `grep`, `sleep`, `mkdir -p`) only works on
  macOS/Linux. If a project must be checked on both, write checks that both shells
  understand, for example `bun some-script.ts` (this repo's test fixtures do that
  through `tests/support/check-command.ts`).
- **"Owner only" file permissions are a macOS/Linux thing.** State files, memory logs,
  learning state, sign-in files, the MCP approval key and browser screenshots are
  written owner-only with `chmod`. Windows does not store or enforce those bits. Tests
  that expect `0o600`/`0o700` are skipped on Windows (the `posixModes` probe in
  `tests/support/platform.ts`) instead of failing.
- **Windows testing covers install and startup only.** CI checks the compiled
  program, image reading, `PATH`, `--version`, `--help`, `--licenses`, `/project` and
  inline diagrams. It does not show that the PowerShell/`wmic` process list, signals,
  the interactive screen, or the optional browser and debugger work on a real desktop.
- **Linux has no recorded full run.** All recorded test runs were on macOS. Linux uses
  the same macOS/Linux code paths (`ps`, process groups), but that is not the same as
  a test run. The [Linux preview workflow](../.github/workflows/linux-preview.yml) is
  set up for that run.
- **Process tracking is not perfect.** It looks at the process list at one moment and
  has size limits. A program that detaches itself before Casper sees it, a PID reused
  in between two looks, or a hard kill or power loss are not covered on any OS.
- **Approval is not a sandbox.** Debugger adapters, programs being debugged, and web
  page scripts can still run any code, read files and use the network.
- **Nothing is installed for you.** Casper never installs a debugger adapter,
  browser or other tool on any OS.
