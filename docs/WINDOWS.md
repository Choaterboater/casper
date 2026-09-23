# Windows preview checklist

This preview targets **Windows x64**. Published v0.1.0 installation and
noninteractive startup have prior Windows CI evidence with PowerShell 5.1 and 7.
The revised source picker and terminal interface are **not yet Windows-host
validated**. A configured CI gate is not a completed run; desktop usage remains a
preview. You do not need Bun or a Git checkout to use the published application.
Unsigned executables may trigger SmartScreen; do not bypass an unexpected warning
without verifying the download source.

## 1. Install the published preview (old interface)

In PowerShell (not an administrator window):

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Choaterboater/casper/releases/download/v0.1.0/install.ps1 | iex
```

The installer checks SHA-256, tests the staged executable's version, and installs
under `%LOCALAPPDATA%\Programs\casper`. It updates your user PATH, not system PATH.
Close an already running Casper before replacing its executable.

Open a **new terminal**, then run:

```powershell
casper --version
casper --help
Get-Command casper | Select-Object Source
```

Expected version: `casper 0.1.0`. The command should resolve to the install directory,
not an old checkout link or another program named Casper.

This installs the unchanged published preview, **not the source login/UI repair**.
Its version label cannot distinguish the new source from the old release: both
currently say 0.1.0. Use the exact source revision for the checks below. Do not
replace v0.1.0 assets to distribute the repair.

## 2. Automated source verification

`.github/workflows/windows-preview.yml` runs on `windows-latest`, with Bun
**1.4.0** and the frozen lockfile, on manual dispatch or relevant pushes to `main`.
It does not publish a release. Its required checks are:

| Command / step | Automated scope |
| --- | --- |
| `bun run typecheck` | Source and test type contracts |
| `bun tools/platform-report.ts` | Native Windows process listing, spawned child/grandchild cleanup, unrelated-process survival, isolated environment, regular state-file opening, capability-dependent symlink rejection and browser discovery |
| Focused suites below | Ownership policy and host-independent picker, login, model-selection and terminal contracts |
| `bun test tests/release-compile.test.ts` | Compiled CLI startup and embedded image/WASM use without build-time WASM or Bun on PATH |
| `bun run build:release` | Build release candidates only; no publication |
| `scripts/test-install-windows.ps1` under PowerShell 5.1 and 7 | Locally served candidate install, persistent/current PATH, version/help/licenses/project/inline diagram, rejection of checksum/version mismatch without replacing the existing binary |

Run the same focused source suites from a prepared checkout:

```powershell
bun test tests/platform-processes.test.ts tests/login-picker.test.ts tests/login.test.ts tests/model-selection.test.ts tests/model-routing.test.ts tests/auto-effort.test.ts tests/daily-terminal.test.ts tests/terminal-review.test.ts tests/terminal-ux.test.ts tests/terminal-discovery.test.ts
```

These suites use synthetic inputs/providers, temporary state and loopback services;
they require no real credentials or paid model calls. They cover decoded and
fragmented picker navigation, cancellation, secret non-echo, fresh consent,
model/default persistence boundaries, draft/history retention through simulated
resizes, streaming/approval boundaries, output-control neutralization and discovery.
The platform probe must exit 0; a failed required check fails the job.

CI uploads `windows-verification` even after a check fails. It contains the OS
build/architecture, Bun and PowerShell versions, source revision, command output
and installer transcripts for steps reached. The separate `windows-preview`
artifact remains the successful candidate build. A step not reached is not
validated. Setup failures before evidence creation may have only the Actions log.
Record the run URL, revision and actual pass/fail/skip counts before changing any
host-validation claim.

**Limits:** POSIX PTY, process-group, signal and file-mode fixtures skip on
Windows; symlink tests may skip without Developer Mode or elevation. In-memory
terminal streams are not a Windows console. Neither those passes nor PTY skips
prove native redraw, key decoding, resizing, terminal ownership or restored input
state. Browser discovery is not browser automation; optional adapter/browser
acceptance remains separate. The [platform runbook](PLATFORM_VERIFICATION.md)
explains these boundaries.

## 3. Native terminal acceptance (offline; still required)

Use the **revised source checkout**, not the v0.1.0 download. Dependencies must
already be prepared with the pinned lockfile. Record the source revision,
`bun --version`, Windows build, `$PSVersionTable.PSVersion`, and terminal application
and version. Run in Windows Terminal under PowerShell 7 and Windows PowerShell
5.1; record any other console host separately rather than generalizing results.

Start with the no-account demo from the checkout:

```powershell
bun tools/terminal-demo.ts
```

- Send ordinary text to see synthetic streaming Markdown, code, tables and
  Unicode. Type a draft while it streams; Enter must not queue it. Escape should
  cancel the synthetic work while keeping the draft usable.
- Resize between wide and narrow windows (for example 100, 40 and 24 columns).
  Confirm panels, footer, multiline input and cursor remain usable without
  duplicated screens; use Ctrl+J for a newline and Up to recall submitted input.
- Use `/model` and `/effort`: arrow keys must move the visible highlight in place,
  Enter must select the highlighted item, and Escape must cancel. The demo uses
  synthetic choices, not the production model catalog.
- Use `/approve`; type a draft before the delayed approval appears. It must not
  answer approval. Only a fresh exact `yes` accepts, and the original draft/cursor
  returns afterward. Use `/error` and `/status` to inspect diagnostics and panels.
- Exit with `/exit`; normal shell input and echo must be restored. Repeat with
  `NO_COLOR=1` set in the environment. Do not use a transcript/redirected stream
  as a substitute for this real interactive-console check.

Then exercise the **production login picker**, stopping before any consent or
credential entry. Open a dedicated disposable PowerShell session, start in the
source checkout, and isolate its home/project:

```powershell
$Source = (Get-Location).Path
$Probe = Join-Path ([IO.Path]::GetTempPath()) ('casper-terminal-' + [guid]::NewGuid().ToString('N'))
$ProbeHome = Join-Path $Probe 'home'
$Project = Join-Path $Probe 'project'
New-Item -ItemType Directory -Path $ProbeHome, $Project | Out-Null
$env:HOME = $ProbeHome
$env:USERPROFILE = $ProbeHome
$env:APPDATA = $ProbeHome
$env:LOCALAPPDATA = $ProbeHome
$env:PI_CODING_AGENT_DIR = Join-Path $ProbeHome '.pi\agent'
$env:PI_OFFLINE = '1'
$env:PI_TELEMETRY = '0'
Remove-Item Env:CASPER_PROFILE -ErrorAction SilentlyContinue
Set-Location $Project
bun (Join-Path $Source 'src\cli.ts')
```

Use `/help`, `/status`, then `/login`. Navigate with Up/Down and check that the
visible highlight moves without appending `Selected:` rows. Test Escape and the
explicit Cancel item. Reopen `/login`, select a provider and cancel at the next
method or consent screen; **do not press Y at consent, enter secrets, open a login
URL or submit a model prompt**. Confirm selection reaches the intended provider,
and cancellation returns to a usable editor. Resize with the picker open. Exit,
restart once and check clean input ownership again.

The demo does not implement login; this separate production check is required.
After Casper exits, leave the temporary project, remove only `$Probe`, then close
the disposable shell to discard its environment overrides. This acceptance path
does not establish provider authentication or real coding behavior.

Configured project verification commands must work in Windows `cmd.exe`, not
require POSIX-only commands such as `grep` or `printf`. Existing repository
dependencies and language tools are still needed for those checks; the embedded
Bun runtime runs Casper itself, not every arbitrary project command.

## 4. Optional integrations and limitations

- Published v0.1.0 prints login selection updates instead of moving its visible
  highlight. Revised source uses Pi's redrawable picker and decoded navigation
  keys; native Windows acceptance above is still pending for this unreleased code.
- Pi's model-facing Bash tool needs Bash (for example Git for Windows). Casper's
  own verifier uses `cmd.exe`. Installing Casper does not install those other tools.
- Browser discovery includes installed Chrome and Edge. No browser is downloaded.
- Screenshot-file and diagram-artifact creation use a POSIX native bridge. Windows
  diagram requests fall back to inline text; screenshot files are unavailable.
- Debugging requires a manually configured, already installed DAP adapter.
- Windows process cleanup uses OS parentage and reports uncertainty rather than
  guessing which unrelated processes to terminate. Unconfirmed cleanup may leave
  processes alive; restarting Casper is not proof they stopped.
- Re-running this installer reinstalls the pinned preview, not a future version.

## Report a failure

Include Windows version, Bun/PowerShell versions, terminal application/version,
source revision (or explicitly published v0.1.0), exact command, expected/actual
behavior, and the error text. For CI, attach the run URL and `windows-verification`
artifact, including skipped checks. Redact credentials, private source, account
identifiers and sensitive paths. A screenshot is optional.

Do not interpret skipped tests or an unavailable optional browser/adapter as
validation. For deeper source-level checks, see the
[platform verification runbook](PLATFORM_VERIFICATION.md).
