# Platform verification runbook (Windows / Linux)

**What this is:** the steps to test Casper on a new machine (Windows or Linux) and
what proof to keep. **When you'd use it:** before you change a "not tested yet" line
in [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md) to "tested on this machine".

Tests that passed on macOS do not prove anything about Linux or Windows. So far,
there is no recorded full run on a real Linux machine. On Windows, CI drives the
interactive screen in a real Windows console (ConPTY), but no person has checked it in
Windows Terminal yet. A workflow that is set up but has no recorded run is not proof. Windows-only details are in [WINDOWS.md](WINDOWS.md).

You need a source checkout for everything below, not the installed `casper` program.
None of these steps needs a model account, and none of them makes a paid model call.

## Quick version

```bash
bun install --frozen-lockfile     # once; needs network or a warm cache
bun tools/platform-report.ts      # Step 1: must end with exit code 0
bun run typecheck                 # Step 2
bun test tests/platform-processes.test.ts
bun run test                      # full suite, files in parallel (slowest first)
bun tools/terminal-demo.ts        # Step 4: look at the screen yourself
```

Keep the full output of each command. Then read the sections below for what each
result means.

## Prepared host gates — runs still pending

Two GitHub Actions workflows run these checks for you on a GitHub build machine.
You can start either by hand ("Run workflow"), and they also run when relevant
files change on `main` (Linux also on pull requests). Neither one publishes a release
or needs model credentials. The sign-in tests use fake provider answers.

| Workflow | What it runs | Evidence it keeps |
| --- | --- | --- |
| [Linux preview](../.github/workflows/linux-preview.yml) | Ubuntu 24.04, Bun 1.4.0, records `python3` and its PTY modules; locked install; platform probe; typecheck; focused platform/terminal/login/model/debugger suite; full `bun run test` (files in parallel) | `linux-preview-evidence`: host, install, probe, typecheck, focused and full-suite logs, kept 14 days, uploaded even when a check fails |
| [Windows preview](../.github/workflows/windows-preview.yml) | `windows-latest`, Bun 1.4.0, locked install; typecheck; platform probe; ConPTY screen test (`tests/windows-screen.test.ts`, on the source and again on the built `.exe`); release-compile test; release build; installer test under Windows PowerShell 5.1 and PowerShell 7. Beside it, on three more runners at once: the full `bun run test` suite in three parts of about equal time (`tools/test-shard.ts`), the real debugger test, and the eval bench tests (`bun run test:evals`). Defender's live scan is off for the run | `windows-verification-build` and `windows-verification-suite-1..3`: host and per-step logs, full-suite and eval logs included, uploaded even on failure; the built files go to `windows-preview` |

On Linux the Python PTY tests run (Windows skips them). A PTY is a fake terminal a
test can type into. Windows has its own: `tests/windows-screen.test.ts` starts Casper in
a Windows pseudo-console (ConPTY, through Bun's `terminal` spawn option, no extra
package), sends keys the way Windows Terminal does, resizes it and reads the screen. These cover the real login and model pickers and the debugger
command line. The full suite also covers process cleanup, FIFOs (named pipes), file
permissions and the native shell. On Linux, once the install step works, every later
step still runs even if an earlier one failed, and a failed step still fails the job.
`tee` keeps each command's exit code (bash `pipefail`).

Before you change any support claim, download the evidence and write down: the run
URL, the commit (SHA), the OS image, the pass/fail/skip counts, and the names of
failed tests. If the job failed before it made any logs, keep the Actions job log.
The artifacts hold console output, not full terminal recordings. A green Linux run
proves that runner only, not every Linux version, CPU type or desktop terminal.

## Prerequisites

- Bun for your OS (`bun --version`). CI uses **1.4.0**.
- A checkout with dependencies installed once: `bun install --frozen-lockfile`
  (needs network or a warm cache). Install in the same checkout you test: the real
  LSP tests use programs under its own `node_modules`.
- On Linux: `python3` on `PATH` with the standard `pty`, `fcntl` and `termios`
  modules. Ubuntu 24.04's built-in Python works as is. No extra Python packages.
- Optional: Chrome or Edge (Chromium on Linux) installed, for the browser tests and
  the discovery check.
- Optional: Python 3 with debugpy already installed, for the real debugger tests.
  Set `CASPER_TEST_DEBUGPY` and `CASPER_TEST_PYTHON`. CI does not install debugpy;
  missing optional tools cause skips that say why.

## Step 1 — platform probe (required)

```bash
bun tools/platform-report.ts
```

It needs no model, no network and no credentials, and takes a few seconds. It
starts a real child and grandchild process, takes ownership of them, stops them,
and checks that a process it did not start is still alive. The first line shows the
OS, CPU, Bun version and whether process groups are available.

| Check | What a FAIL means |
| --- | --- |
| process listing | `ps` (macOS/Linux) or PowerShell `Get-CimInstance` / `wmic` (Windows) gave no usable list; ownership cannot work |
| descendant observation | the grandchild did not show up through the parent/child links — the main idea behind cleanup does not hold on this machine |
| owned tree cleanup | stopping did not end the child and grandchild, or the result was `unknown` |
| unrelated process control | cleanup reached a process Casper did not start — **stop and report this** |
| environment allowlist | an unexpected variable reached the child, or a credential was passed on |
| state-file read / final-symlink rejection | the file-open flags are wrong for this OS (on Windows the link test SKIPs when the machine does not allow creating links) |
| installed browser discovery | no Chrome/Edge found, so browser tests will skip. A SKIP here is not a bug |
| debugger adapter hint | information only; set the two variables above to run the real debugger tests |

Exit code 0 means every required check passed; 1 means at least one FAIL. Send the
whole output either way.

## Step 2 — typecheck and the platform suite

```bash
bun run typecheck
bun test tests/platform-processes.test.ts
```

You want: no type errors and no test failures. The suite covers live process
ownership on macOS/Linux, a simulated OS with no process groups, shared stop
results, the clean environment and file checks. The live process-group test skips on
Windows; the link test skips where links cannot be made. Write down the real
pass/skip counts with the OS build.

Then the focused terminal set (the same list the Linux workflow runs), then the
full suite:

```bash
bun test tests/platform-processes.test.ts tests/login-picker.test.ts tests/login.test.ts tests/terminal-review.test.ts tests/terminal-ux.test.ts tests/terminal-discovery.test.ts tests/daily-terminal.test.ts tests/model-routing.test.ts tests/auto-effort.test.ts tests/model-selection.test.ts tests/phase10-debugger-app.test.ts
bun run test
```

`bun run test` runs the test files in parallel, slowest first (from
`tests/timings.json`; refresh it with `bun run test:timings`), then the real
debugger file on its own. The evaluation bench's own tests (`tests/eval-*`) are not
part of it: run them with `bun run test:evals` after changing `evals/`. These tests use fake provider and
adapter answers and real local processes, not paid model calls. Do not give them real
provider credentials.

## Step 3 — optional deeper checks

```bash
bun test tests/phase10-browser.test.ts        # needs Chrome/Edge; checks discovery and browser cleanup
bun test tests/phase10-debugger-real.test.ts  # needs CASPER_TEST_DEBUGPY and CASPER_TEST_PYTHON
bun test tests/phase10-debugger.test.ts       # fake adapter, nothing extra needed
```

Command-line smoke test with no model call, from the checkout:

```bash
bun src/cli.ts --help
bun src/cli.ts /project
```

## Step 4 — manual terminal acceptance (still required on both hosts)

The PTY tests check keys and saved state. They do not replace a person looking at
the screen. On Linux use the terminal app you really use; on Windows use Windows
Terminal with the PowerShell version you really use. Write down the terminal app and
version, the window size, color mode and anything odd about the keyboard. Use a
throwaway project folder and a temporary home folder with no real credentials. Do not
change your real accounts, saved settings or installed `casper`.

1. Run the offline demo: `bun tools/terminal-demo.ts`. It makes no model calls and
   saves nothing. What it has:
   - Type any text and press Enter: it prints three fake tool lines, half a second
     apart, then "Demo complete". Type a new draft while they print. Press Escape
     while they print: it should say `[cancel] Synthetic work cancelled.`
   - `/model` and `/effort` open pickers with made-up choices. `/model` opens on the
     providers on the left; Tab moves to the models. Arrow keys should move the highlight
     in place, Enter picks, Escape cancels.
   - Ctrl+J adds a new line; Up brings back earlier input; `/` shows the command list.
   - `/exit` quits. Any other `/` command just prints the demo's command list. The
     demo has no approval, error or status screens; test those in the real CLI (item 3).
2. Resize the window to normal and narrow widths (for example 100, 40 and 24
   columns), while typing and while a picker is open. Check that the footer and panels
   stay readable, the highlight moves in place with no extra rows added, and your draft
   and cursor come back. Repeat with `NO_COLOR=1`. Check the plain mode with
   `TERM=dumb` or with output sent to a file.
3. In the real CLI (`bun src/cli.ts`, with the temporary home), try `/help`, `/status`
   and `/login`. Move the highlight with the arrows, press Escape, open it
   again and try Ctrl+C. Enter may open the next screen for a provider, but
   **do not paste a real secret or finish a login**. Check that the
   prompt still works after you cancel, and that the shell works normally after exit.
   Linux PTY tests cover the later private-input screens; on Windows the ConPTY
   test covers the hidden API key box, but a person still needs to look at it.
4. Keep screenshots (with private data removed) and exact steps for any problem with
   layout, selection, keyboard input or cleanup. This check is about how the screen
   behaves offline. It does not test a real sign-in or real coding work.

[TERMINAL_UX.md](TERMINAL_UX.md) describes how the screen is meant to behave. Do not
mark Windows PTY or private-input testing done just because the portable picker tests
or the Linux PTY tests pass.

## What to expect on Windows today

Tests that need macOS/Linux features **skip and say why** instead of failing. The
switches are in `tests/support/platform.ts`: `posixOnly`, `needsSymlinks`,
`needsFifos`, `posixSymlinks`, `needsPosixModes`. So on Windows, a failure should
point at a real bug, not a test that cannot run there. But skipped is not tested:
the areas below still have no Windows coverage, and a green Windows run does not
cover them.

**Check commands in tests no longer force a skip.** Tests that used shell tools as
their project checks (`printf`, `test -f`, `touch`, `sleep`, `grep`, `mkdir -p`,
`rm`, `while … done`) now run `tests/fixtures/check-script.ts` through
`tests/support/check-command.ts`: the Bun program plus a script, by full path, with no
shell syntax. They should work on any OS where the product works, so a failure there
needs a look. This has only been run on macOS so far; a failure seen only on another
OS can still be a test bug.

| macOS/Linux only because | Test files |
| --- | --- |
| Python 3 PTY tests (Windows runs `windows-screen` through ConPTY instead) | `daily-terminal`, `terminal-ux`, `terminal-layout`, `login`, `model-selection`, `phase10-debugger-app` |
| Native shell commands the pinned Pi runs, whose text Casper reads — `rm`, `ln -s`, `test -f … && rm …`, `kill -TERM $$` | `phase8-pi*.integration` (4 gates + 2 `!caseInsensitiveFilesystem \|\| !POSIX`), `work-driven-checks` (signal stop, cancel with `& wait`), `phase3-app` (process group, a child that ignores TERM, tests that match the configured command in the model's reported text), `pi-gate.integration`, `secrets-pi.integration` (hiding device secrets in file reads and command output) |
| Shell scripts and shebang runs | `release-install` (the POSIX installer and its `#!/bin/sh` stand-in), `cli-flags` (`--version` through a PATH-style link; the source CLI run through its shebang) |
| Creating symbolic links | `phase2-skills`, `phase5-lsp`, `phase6-review`, `phase6-visualize`, `phase9-learn`, `phase9-memory`, `phase9-references`, `phase10-browser`, `phase10-debugger`, `phase8-pi*.integration`, `work-driven-checks`, `model-selection`, `eval-suite`, `context-files` |
| FIFOs (`mkfifo`) | `phase9-learn`, `phase9-memory`, `phase9-references`, `review-config`, `coding-loop-evidence` |
| Owner-only file permissions (`needsPosixModes`, `posixModes`, or checked inside a gated test) | `model-selection`, `coding-loop-evidence`, `phase9-learn`, `phase9-memory`, `phase10-browser`, `login`, `phase5-lsp`, `phase7-sessions`, `cli-flags` |
| Process groups and POSIX signals | `platform-processes`, `phase3-app` |

`phase3-verification`, the non-FIFO tests in `phase9-references`, and the rest of
`work-driven-checks`, `phase3-app`, `coding-loop-evidence` and
`phase8-pi*.integration` run on Windows with no macOS/Linux-only test setup.

The tests left on the list are macOS/Linux-only **by subject** (PTY, FIFO, link
rights, permissions, process groups, signals), or because they check a native shell
command whose text Casper reads. Moving them to Windows needs a Windows machine: you
cannot swap a native command for the test script without changing what Casper sees.

Send the failure list either way, with the failing file and machine details. Judge a
failure by what it does and how to repeat it, not by the test file's name.

## Linux assumptions to record, not hide

- PTY tests run `python3` from `PATH`, not `CASPER_TEST_PYTHON`. They use POSIX
  terminal calls and signals and set a rich `TERM` themselves, so CI does not need a
  real terminal around them. `CASPER_TEST_PYTHON` is only for the real debugpy tests.
- Process and native-command tests need `/bin/sh`, `ps`, normal POSIX tools, process
  groups and signals. FIFO tests need `mkfifo`. Link and permission support is probed.
  Ubuntu 24.04 has all of this; a minimal Linux container may not. One ownership test
  writes a marker to a temp path without shell quoting, so use a temp path with no
  spaces (the GitHub runner's default is fine).
- Tests for case-insensitive file systems probe first and skip on a normal
  case-sensitive Linux disk. Those skips are expected; they do not test Linux on a
  case-insensitive disk.
- Browser discovery and a real debugpy are optional. Running Python PTY tests does not
  run debugpy. Record skips; do not install extra tools to make them go away, and do
  not claim browser or debugger coverage you did not run.

## Evidence to capture

- The workflow run URL, commit SHA and evidence artifact, or each command you ran by hand.
- The full output of Step 1 and of the test runs you did.
- `bun --version`, the OS build (`winver` / `uname -a`), and on Windows whether
  Developer Mode is on (it decides whether the link tests can run).
- On Linux, `python3 --version` and its path. Whether Chrome/Edge and debugpy were
  there, and their real paths if used.
- For each failure: the command, the failing check or test name, pass/fail/skip totals
  and the log file. Do not throw away a failed run because a rerun passed.
- What you saw in the manual terminal check, with captures, and which checks you did
  not do.

## Interpretation and follow-up

- Green probe plus green Step 2 = proof for the platform layer on that OS build. Only
  then update the platform-layer line in PLATFORM_SUPPORT.md, with the machine and run
  details. It does not sign off the terminal screen or a Linux distribution.
- The terminal and login screens also need the focused tests and the manual check in
  Step 4. A test skipped on Windows is still a gap.
- Every FAIL needs a decision: product bug or test bug? Decide that before claiming the
  feature works. Do not hide a failure, and do not treat a passing rerun as the answer.
- Linux also exercises the shared process-group and `ps` code. Sharing code with macOS
  does not mean Linux behaves the same.

## Limits of these runs

The probe covers the platform layer only. For browsers and debugger adapters it only
checks discovery. Process tracking looks at one moment and has size limits: a program
that detaches before Casper sees it, a reused PID, or a hard kill or power loss are not
covered on any OS. Real Windows signal behavior and Windows browser/debugger behavior
are only shown by the Step 3 tests running on Windows.
