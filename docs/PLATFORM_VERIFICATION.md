# Platform verification runbook (Windows / Linux)

How to turn "implemented; real-host validation pending" into "validated on this
host" for [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md). Existing macOS gate and PTY
evidence does not establish Linux or Windows behavior. The revised terminal/login
source has not yet been host-validated on Linux or Windows; prepared CI is not a
completed run, and published v0.1.0 still contains the older UI.

## Prepared host gates — runs still pending

Run these workflows from a checkout containing the revised source. Both accept
manual dispatch and watch relevant source, fixtures, configuration and workflow
changes. Neither publishes a release or requires provider credentials/model calls.
Dependency installation needs network or a warm cache; the login fixtures use
synthetic provider responses, not real account login.

| Workflow | Prepared checks | Evidence |
| --- | --- | --- |
| [Linux preview](../.github/workflows/linux-preview.yml) | Ubuntu 24.04, Bun 1.4.0, installed `python3`/PTY-module identity; frozen-lockfile install; platform probe; typecheck; focused platform/terminal/login/debugger-CLI suite; full serial `bun test` | `linux-preview-evidence`: host, install, probe, typecheck, focused and full-suite console logs, retained for 14 days even on check failure |
| [Windows preview](../.github/workflows/windows-preview.yml) | Windows runner, Bun 1.4.0, frozen-lockfile install; platform probe; typecheck; focused platform/terminal/login suite; existing release-compile/build and Windows PowerShell 5.1/PowerShell 7 installer checks | `windows-verification`: host/check console logs, uploaded even on failure; successful release artifacts remain in `windows-preview` |

Linux runs the existing Python PTY fixtures that Windows skips, including the
production login/model picker and debugger CLI. The focused log makes those
results easy to find; the full serial suite also exercises POSIX cleanup, FIFO,
mode-bit and native-shell behavior outside the terminal suites. After dependency
installation succeeds, Linux check steps run even if an earlier check fails, while
the failed step still fails the job. Bash pipe failure propagation preserves each
command's exit status through `tee`.

Download the evidence artifact and record the run URL, checkout SHA, actual OS
image/build, pass/fail/skip counts and failing names before updating support
claims. A runner/setup failure can precede log creation; retain the Actions job
log in that case. Artifacts contain console diagnostics, not guaranteed raw PTY
transcripts: existing fixtures clean their temporary directories. A green Linux
runner is evidence for that runner, not every distribution, architecture or
desktop terminal. Windows-specific details remain in [WINDOWS.md](WINDOWS.md).

## Prerequisites

- Bun for the target OS (`bun --version`); prepared CI pins **1.4.0**.
- A checkout with dependencies installed once (`bun install --frozen-lockfile`;
  needs network or a warm cache). Install in the checkout being verified: real LSP
  fixtures resolve executable scripts under its own `node_modules`.
- On Linux, `python3` on `PATH` with standard-library `pty`, `fcntl`, and `termios`.
  Ubuntu 24.04's installed Python is used as-is; no Python packages are installed.
- Optional: Chrome or Edge installed — needed for browser suites and the discovery
  check. Headless-browser success is separate from desktop-terminal acceptance.
- Optional: Python 3 with an already installed debugpy adapter
  (`CASPER_TEST_DEBUGPY`, `CASPER_TEST_PYTHON`) for real-adapter tests. The prepared
  gates do not install debugpy; absent optional prerequisites cause stated skips.

## Step 1 — platform probe (required)

```bash
bun tools/platform-report.ts
```

Self-contained: no model, no network, no credentials, ~1 second. It spawns a real
child plus grandchild, owns them, terminates the tree, and checks that an unrelated
process survived.

| Check | What a failure means |
| --- | --- |
| process listing | `ps` (POSIX) or PowerShell `Get-CimInstance` / `wmic` (Windows) did not return a usable table; ownership cannot work |
| descendant observation | the spawned grandchild was not visible through OS parentage — the core ownership assumption is broken on this host |
| owned tree cleanup | termination did not stop the root and grandchild, or returned `unknown` |
| unrelated process control | cleanup reached a process Casper did not spawn — **stop and report** |
| environment allowlist | an unexpected variable reached the child environment, or a credential was forwarded |
| state-file read / final-symlink rejection | the platform flag path is wrong (Windows symlink rejection SKIPs when the host denies symlink creation) |
| installed browser discovery | no Chrome/Edge found; browser suites will skip. Discovery SKIP is not a defect |
| debugger adapter hint | informational; set the two variables to run real-adapter tests |

Exit code 0 means every required check passed. Send the whole output either way —
the platform/Bun/process-group line identifies the host.

## Step 2 — typecheck and the platform suite

```bash
bun run typecheck
bun test tests/platform-processes.test.ts
```

Expected: typecheck clean and no failures. The suite includes live POSIX ownership,
simulated non-group ownership, shared termination results, environment and file
checks. The live POSIX group test skips on Windows; the symlink test skips on hosts
without symlink privilege. Record actual pass/skip counts with the OS build.

For the prepared Linux terminal gate, then the complete serial regression suite:

```bash
bun test tests/platform-processes.test.ts tests/login-picker.test.ts tests/login.test.ts tests/terminal-review.test.ts tests/terminal-ux.test.ts tests/terminal-discovery.test.ts tests/daily-terminal.test.ts tests/model-selection.test.ts tests/phase10-debugger-app.test.ts
bun test
```

Keep the full suite serial; `test:fast` is opt-in and not this acceptance gate.
These suites include synthetic provider/adapter responses and real local child
processes, not paid model requests. Do not supply real provider credentials.

## Step 3 — optional deeper checks

```bash
bun test tests/phase10-browser.test.ts        # installed Chrome/Edge; validates discovery + browser cleanup
bun test tests/phase10-debugger-real.test.ts  # with CASPER_TEST_DEBUGPY / CASPER_TEST_PYTHON
bun test tests/phase10-debugger.test.ts       # synthetic adapter, no external adapter needed
```

CLI smoke without a model call, from the source checkout being verified:

```bash
bun src/cli.ts --help
bun src/cli.ts /project
```

## Step 4 — manual terminal acceptance (still required on both hosts)

CI PTYs check interaction and persisted state, not human visual acceptance. On
Linux use the terminal emulator intended for distribution; on Windows use Windows
Terminal with the intended PowerShell version. Record emulator/version, dimensions,
color mode and keyboard behavior. Use a disposable workspace and isolated temporary
HOME/USERPROFILE/Pi state, with no real credentials; do not change existing accounts,
saved preferences or the installed launcher.

1. From the source checkout run `bun tools/terminal-demo.ts`. This is offline and
   synthetic. Exercise streamed Markdown/code/tables, draft editing during output,
   `/approve`, `/error`, `/status`, `/model`, `/effort`, cancellation and `/exit`.
   Ensure an in-progress draft is retained rather than submitted after work ends.
2. Resize at normal and narrow widths (for example 100, 40 and 24 columns), including
   while editing and while a picker is open. Check readable panels/footer, in-place
   highlight movement, no appended navigation rows, and draft/cursor restoration.
   Repeat with `NO_COLOR=1`; inspect plain fallback with `TERM=dumb` or redirection.
3. In the isolated source CLI, check `/help`, `/status` and `/login`. Move the
   provider highlight with arrows, choose Cancel, reopen and test Escape/Ctrl+C.
   Enter may open the selected provider's next screen, but **do not grant consent,
   paste any real secret or complete login**. Check EOF/shutdown and confirm the
   normal prompt remains usable afterward when cancellation keeps the CLI open.
   Synthetic Linux PTYs cover later private-input/fresh-consent flows; Windows
   still needs native equivalent evidence for these POSIX-skipped cases.
4. Save redacted captures and exact reproduction steps for layout, selection,
   input ownership or cleanup failures. Distinguish this offline visual sign-off
   from real provider authentication and live-model usefulness; neither is
   authorized or proved by this checklist.

See [TERMINAL_UX.md](TERMINAL_UX.md) for the existing interaction contract. Do not
mark native Windows PTY/private-input coverage complete because portable picker
tests or Linux PTYs pass.

## What to expect on Windows today

The POSIX-only fixtures **skip with a stated reason** instead of failing
(`tests/support/platform.ts`: `posixOnly`, `needsSymlinks`, `needsFifos`,
`posixSymlinks`, `needsPosixModes`), so a Windows run should end with failures that
name a real defect, not a fixture limitation. Skipped is not validated: these
categories still have no Windows coverage, and a green Windows run does not certify
them.

**Fixture check commands are no longer a reason to skip.** The five suites that used
POSIX shell utilities as their configured checks (`printf`, `test -f`, `touch`,
`sleep`, `grep`, `mkdir -p`, `rm`, `while … done`) now run those effects through
`tests/fixtures/check-script.ts` via `tests/support/check-command.ts` — the runtime
executable plus a script, invoked by absolute path, with no shell syntax in the
command. Those suites therefore run on any host whose *product* behavior works; a
failure there needs investigation rather than an automatic skip. This is verified
on macOS only: the rewritten fixtures have not run on a Windows or Linux host yet,
so a newly observed host-only failure can still be a fixture defect.

| POSIX-only because | Suites |
| --- | --- |
| Python 3 PTY fixtures | `daily-terminal`, `terminal-ux`, `terminal-layout`, `login`, `model-selection`, `phase10-debugger-app` |
| Native (model-issued) shell commands the pinned Pi executes, whose text the product parses for paths — `rm`, `ln -s`, `test -f … && rm …`, `kill -TERM $$` | `phase8-pi.integration` (4 gates + 2 `!caseInsensitiveFilesystem \|\| !POSIX`), `work-driven-checks` (signal termination, cancellation with `& wait`), `phase3-app` (process group, TERM-resistant descendant, observation tests that match the configured command against model-reported text) |
| The POSIX installer and its `#!/bin/sh` stand-in artifact | `release-install` |
| Symlink creation | `phase2-skills`, `phase5-lsp`, `phase6-review`, `phase6-visualize`, `phase9-learn`, `phase9-memory`, `phase9-references`, `phase10-browser`, `phase10-debugger`, `phase8-pi.integration`, `work-driven-checks`, `model-selection`, `eval-suite` |
| FIFOs (`mkfifo`) | `phase9-learn`, `phase9-memory`, `phase9-references`, `review-config`, `coding-loop-evidence` |
| POSIX mode bits: enforced (`needsPosixModes`, `posixModes`) or asserted inside a gated test | `model-selection`, `coding-loop-evidence`, `phase9-learn`, `phase9-memory`, `phase10-browser`, `login`, `phase5-lsp`, `phase7-sessions` |
| Process groups and POSIX signal semantics | `platform-processes`, `phase3-app` |

`phase3-verification`, `phase9-references`' non-FIFO tests and the rest of
`work-driven-checks`, `phase3-app`, `coding-loop-evidence` and `phase8-pi.integration`
now run on Windows with no fixture-level POSIX dependency.

The remaining POSIX-only fixtures are POSIX **by subject** (PTY, FIFO, symlink
privilege, mode bits, process groups, signals) or because they exercise a native
command the product parses as text. Restoring those needs a Windows host: a native
command cannot be replaced by the fixture script without changing what the product
observes.

Send the failure list either way, including the failing file and host details.
Classify the failure from its behavior and reproduction, not the suite name alone.

## Linux assumptions to record, not hide

- PTY tests invoke literal `python3` on `PATH`, not `CASPER_TEST_PYTHON`. They use
  POSIX ioctls/signals and set a rich `TERM` themselves; CI does not need an
  interactive outer terminal. `CASPER_TEST_PYTHON` selects only real debugpy tests.
- Ownership/native-command fixtures need `/bin/sh`, `ps`, ordinary POSIX utilities,
  process groups and signals. FIFO checks need `mkfifo`; symlink/mode-bit support is
  probed. Ubuntu 24.04 supplies those assumptions, unlike an arbitrary minimal
  Linux container. The ownership marker command uses a temporary path without
  shell quoting, so use the hosted runner's ordinary space-free temporary path.
- Case-aliased filesystem regressions probe case-insensitivity and skip on a
  case-sensitive Linux filesystem. Their skips are expected, not Linux validation
  of case-insensitive filesystems.
- Browser discovery and a real debugpy adapter are optional. Python PTY execution
  alone does not run debugpy. Record skips rather than installing more tools or
  claiming optional adapter/browser coverage.

## Evidence to capture

- Workflow run URL/checkout SHA and evidence artifact, or each locally run command.
- Full console output of Step 1 and the focused/full suites actually run.
- `bun --version`, the OS image/build (`winver` / `uname -a`), and on Windows whether
  Developer Mode is enabled (it decides whether symlink fixtures can run).
- `python3 --version` and its resolved path on Linux; whether Chrome/Edge and a
  debugpy adapter are available, and the real adapter/interpreter paths if used.
- For each failure: command, failing check/test name, pass/fail/skip totals and
  relevant log path. Do not discard a failing run because a later rerun passes.
- Manual terminal findings/captures, including checks still unperformed.

## Interpretation and follow-up

- Green probe + green Step 2 = evidence for the platform layer on that specific
  OS/build; only then update the platform-layer support claim with host/run details.
  It is not terminal/UI or distribution sign-off.
- Revised terminal/login acceptance additionally needs the focused regressions
  and native manual checks above. A Windows skip remains a coverage gap.
- Every FAIL needs a product-versus-fixture diagnosis before claiming the affected
  behavior works. Do not suppress a failure or equate a rerun with diagnosis.
- Linux additionally exercises shared POSIX process groups and `ps` listing;
  shared source paths do not imply identical host behavior.

## Limits of these runs

The probe covers the platform layer, not adapters or browsers beyond discovery.
Process discovery stays bounded and non-atomic: unobserved daemonized descendants,
PID-reuse races and host SIGKILL/power loss are not certified on any platform. Real
Windows signal semantics and Windows adapter/browser behavior are established only by
the suites in Step 3 running there.
