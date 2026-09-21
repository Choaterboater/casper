# Platform verification runbook (Windows / Linux)

How to turn "implemented; real-host validation pending" into "validated on this
host" for [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md). The macOS column is validated;
Linux and Windows are not yet. Run this on the target machine and send the output
back.

## Prerequisites

- Bun for the target OS (`bun --version`).
- A checkout with dependencies installed once (`bun install`; uses the pinned
  lockfile, needs network or a warm cache).
- Optional: Chrome or Edge installed — needed for browser suites and the discovery
  check.
- Optional: Python 3 with an installed debugpy adapter (`CASPER_TEST_DEBUGPY`,
  `CASPER_TEST_PYTHON`) — needed for the real-adapter debugger tests.

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

Expected: typecheck clean, and 7 passes (or 6 on Windows without symlink privilege,
where one test skips with a stated reason).

## Step 3 — optional deeper checks

```bash
bun test tests/phase10-browser.test.ts        # installed Chrome/Edge; validates discovery + browser cleanup
bun test tests/phase10-debugger-real.test.ts  # with CASPER_TEST_DEBUGPY / CASPER_TEST_PYTHON
bun test tests/phase10-debugger.test.ts       # synthetic adapter, no external adapter needed
```

CLI smoke without a model call, from any project directory:

```bash
casper --help
casper /project
```

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
failure there is a product defect. This is verified on macOS only: the rewritten
fixtures have not run on a Windows or Linux host yet, so a Windows-only failure in
them is still possible and would be a fixture defect.

| POSIX-only because | Suites |
| --- | --- |
| Python 3 PTY fixtures | `daily-terminal`, `terminal-ux`, `login`, `model-selection`, `phase10-debugger-app` |
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

Send the failure list either way: a failure that is only a fixture limitation is
distinguishable from a product defect by the file it comes from.

## Evidence to capture

- Full console output of Step 1.
- `bun --version`, the OS build (`winver` / `uname -a`), and on Windows whether
  Developer Mode is enabled (it decides whether symlink fixtures can run).
- Whether Chrome/Edge and Python 3 are installed, and the debugpy adapter path if
  used.
- For each failure: the command, the failing check or test name, and any log path.

## Interpretation and follow-up

- Green probe + green Step 2 = the platform layer is host-validated on that OS;
  update the platform table in README/PLATFORM_SUPPORT.md from "real-host validation
  pending" to "validated on this host", naming the OS build.
- Any FAIL is a product defect to fix before claiming support.
- Linux additionally validates the shared POSIX paths (process groups, `ps`
  listing) that macOS already exercises; no separate code path exists.

## Limits of these runs

The probe covers the platform layer, not adapters or browsers beyond discovery.
Process discovery stays bounded and non-atomic: unobserved daemonized descendants,
PID-reuse races and host SIGKILL/power loss are not certified on any platform. Real
Windows signal semantics and Windows adapter/browser behavior are established only by
the suites in Step 3 running there.