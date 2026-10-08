# Windows preview checklist

**What this is:** how to install Casper on Windows, what has been tested there, and a
checklist to test the parts that have not. **When you'd use it:** you want to run
Casper on a Windows PC, or you want to help confirm it works there.

Casper on Windows is a **preview for Windows x64 and ARM64**. In short:

- **Tested in CI** (a GitHub build machine, not a desktop): install, `PATH` update,
  `--version`, `--help`, `--licenses`, `/project` and inline diagrams, under Windows
  PowerShell 5.1 and PowerShell 7. The full test suite and the eval tests pass there too.
- **Not yet tested on a real Windows desktop:** the interactive screen (pickers,
  resizing, sign-in screens), process cleanup, the browser and the debugger.
- **Windows ARM64** (from v0.2.23): `casper-windows-arm64.exe` is
  built, started and installed in CI on a GitHub ARM64 runner. Nothing else runs there.

You do not need Bun or a source checkout to use the released program. The program is
not signed, so SmartScreen may warn you. Do not click past a warning you did not expect
without checking where the download came from.

## 1. Install the published preview

In PowerShell (a normal window, not "Run as administrator"):

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Choaterboater/casper/releases/download/v0.2.27/install.ps1 | iex
```

What the installer does:

- downloads `casper-windows-x64.exe` (`casper-windows-arm64.exe` on an ARM64 PC, also
  from an x64 PowerShell) and checks its SHA-256 against the release's
  `SHA256SUMS`;
- runs the new file's `--version` before it replaces anything;
- installs to `%LOCALAPPDATA%\Programs\casper\casper.exe`;
- adds that folder to your **user** `PATH` (not the system `PATH`) and to the current
  PowerShell window.

If antivirus or a Casper that just closed still holds `casper.exe`, the installer tries
again for about 5 seconds before it gives up.

If any check fails, nothing is installed and an older `casper.exe` stays as it was.
Close a running Casper before you update it. The installer takes no flags; set these
environment variables first if you need them: `CASPER_INSTALL_DIR` (another folder),
`CASPER_VERSION` (require this exact version), `CASPER_SHA256` (a digest you checked
yourself), `CASPER_BASE_URL` (an HTTP(S) folder holding the release files). More in
[RELEASE.md](RELEASE.md#installer-contract).

Open a **new terminal**, then run:

```powershell
casper --version
casper --help
Get-Command casper | Select-Object Source
```

`casper --version` should print `casper 0.2.27 (<path to casper.exe>)`. The `Source`
line should point into the install folder, not an old checkout or some other program
called casper.

The command above always installs **v0.2.27**. Running it again reinstalls v0.2.27.
To get a newer preview, run `casper update`. Windows will not replace a running `casper.exe`,
so Casper checks that release's own installer (checksum and build provenance, as on other systems),
saves it to a private temporary folder and starts a separate hidden PowerShell that waits for
Casper to exit, then runs that same file. Casper prints one line and exits; once its window has
closed, run `casper --version` to see the new version. The waiting step gives up after five minutes
without installing. If that separate step cannot be started, Casper shows the `irm ... | iex` line
to run yourself. This hand-off has not been run on a real Windows machine yet.

## Windows with WSL (Linux inside Windows)

WSL is Linux running inside Windows. If you open a WSL terminal (Ubuntu, for example), you
can use the Linux Casper there instead of the Windows preview. In that terminal:

```sh
curl -fsSL https://github.com/Choaterboater/casper/releases/download/v0.2.27/install.sh | sh
```

- The Linux Casper is a separate install from the Windows one. It has its own `~/.casper`
  (inside WSL) and its own sign-in, so run `/login` once there.
- It works with nothing else to install. It asks before shell commands that change
  things.
- `/sandbox` shows how to add the full sandbox if you want it.

## 2. Automated checks (CI)

`.github/workflows/windows-preview.yml` runs on `windows-latest` with Bun **1.4.0** and
the locked dependencies. It runs when started by hand, and on every pull request and push
to `main` that changes code, tests, scripts or the workflow (`src`, `scripts`, `tools`,
`tests`, `evals`, the Windows docs, package and lock files, and the workflow itself). It
never publishes a release. The run fails if any step fails, the full suite included, and
the owner merges only after it is green. Its steps:

| Step | What it checks |
| --- | --- |
| `bun run typecheck` | Source and test types |
| `bun tools/platform-report.ts` | Windows process list, stopping a child and grandchild, leaving an unrelated process alone, the clean environment, opening state files, refusing a linked file (when Windows allows links), browser discovery |
| The focused tests below | Process ownership rules; the login, model and terminal code that does not depend on the OS; undo, the project folder, browser sign-in, receipts and the network server update with real file locks |
| `bun test tests/release-compile.test.ts` | The compiled program starts and reads images with no Bun on `PATH` |
| `bun run build:release` | Builds the release files; publishes nothing |
| `scripts/test-install-windows.ps1` under PowerShell 5.1 and 7 | Installs from a local copy of the release files: `PATH` (saved and current), `--version`, `--help`, `--licenses`, `/project`, an inline diagram, that a bad checksum or wrong version leaves the old program untouched, and that the installer waits for a `casper.exe` or staged download another process holds for a moment |
| `scripts/test-install-signature-windows.ps1` under PowerShell 5.1 and 7 | The release signature check, with throwaway keys made for the run: a list signed with the pinned key installs; another key, a changed list or a broken signature is refused and the old program stays; a missing signature is refused from the release address and said from another; an old `ssh-keygen` is named; a 32-bit Windows PowerShell checks too |
| `bun run test` | The full suite, files in parallel, as on Linux and macOS. Tests that need a PTY, POSIX signals or file modes, or a tool that is not installed, skip |
| `bun run test:evals` | The evaluation bench's own tests, as on Linux |

To run the same focused tests from a checkout (after `bun install --frozen-lockfile`):

```powershell
bun test tests/platform-processes.test.ts tests/login-picker.test.ts tests/login.test.ts tests/model-routing.test.ts tests/auto-effort.test.ts tests/model-selection.test.ts tests/daily-terminal.test.ts tests/terminal-review.test.ts tests/terminal-ux.test.ts tests/terminal-discovery.test.ts tests/network-update-swap.test.ts tests/undo.test.ts tests/project-root-path.test.ts tests/login-browser.test.ts tests/receipt.test.ts tests/undo-app.integration.test.ts
```

These use fake providers, temporary folders and local-only services. They need no
real credentials and make no paid model calls. The platform probe must exit 0; any
failed step fails the job.

CI runs the full suite in three parts on three runners at once (split by
`tests/timings.json` into parts of about equal time; `bun tools/test-shard.ts 3 1` prints
part 1), beside a fourth runner that builds, checks the screen and tests the installers.
Each uploads a `windows-verification-*` artifact, even after a failure. They hold
the Windows build and CPU type, Bun and PowerShell versions, the commit, each step's
output, and the installer logs for the steps that ran. The `windows-preview` artifact
holds the built files from a green run. A step that did not run was not tested. Write
down the run URL, commit and real pass/fail/skip counts before you change any
"tested on Windows" claim.

**What CI does not prove:** the PTY, process-group, signal and file-permission tests
skip on Windows. Link tests may skip without Developer Mode or admin rights. The
terminal tests use in-memory streams, not a real Windows console. So a green run does
not show that redraw, key handling, resizing or giving the keyboard back to the shell
work in a real window. Finding a browser is not the same as driving one. The
[platform runbook](PLATFORM_VERIFICATION.md) explains these gaps.

## 3. Native terminal acceptance (offline; still required)

This needs a **source checkout** with dependencies installed
(`bun install --frozen-lockfile`). Write down: the commit, `bun --version`, the
Windows build, `$PSVersionTable.PSVersion`, and the terminal app and version. Test in
Windows Terminal under both PowerShell 7 and Windows PowerShell 5.1. Record any other
console separately. The old Windows console (conhost, outside Windows Terminal) has no braille
or rounded corners in its fonts, so there Casper's spinner is `| / - \` and panels have square
corners.

**Step A — the offline demo.** It makes no model calls and saves nothing:

```powershell
bun tools/terminal-demo.ts
```

- Type any text and press Enter: three fake tool lines print, half a second apart,
  then "Demo complete". Type a new draft while they print; it must not be sent on its
  own. Press Escape while they print: you should see `[cancel] Synthetic work cancelled.`
- Resize the window between wide and narrow (for example 100, 40 and 24 columns).
  The footer, input box and cursor should stay usable, with no repeated screens.
  Ctrl+J adds a new line; Up brings back earlier input.
- `/model` and `/effort` open pickers with made-up choices. The arrow keys must move
  the highlight in place, Enter picks, Escape cancels.
- `/exit` quits. Your shell's normal typing and echo must come back. Then do it all
  again with `$env:NO_COLOR = '1'`. Do not use a saved transcript or redirected
  output instead of a real window for this check.

The demo has no sign-in, approval or error screens. Those are tested next, in the
real program.

**Step B — the real sign-in picker, stopping before any sign-in.** Open a new,
throwaway PowerShell window. Start in the source checkout and point Casper at a
temporary home and project:

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
$env:CASPER_AGENT_DIR = Join-Path $ProbeHome '.casper\agent'
$env:CASPER_OFFLINE = '1'
$env:CASPER_TELEMETRY = '0'
Remove-Item Env:CASPER_PROFILE -ErrorAction SilentlyContinue
Set-Location $Project
bun (Join-Path $Source 'src\cli.ts')
```

- Try `/help` and `/status`, then `/login`.
- Move with Up/Down. The highlight should move in place, with no new `Selected:` lines.
- Try Escape. Open `/login` again, press a number, and cancel at
  the next screen. **Do not type any secret, open a login link or
  send a prompt to a model.**
- Check that the provider you picked is the one that opened, and that after cancel
  you are back at a working input box. Resize with the picker open.
- Exit, start it once more, and check that the shell gets its keyboard back cleanly.

When done, `Set-Location` out of the temp folder, delete only `$Probe`, and close that
PowerShell window (this drops the variables you set). This check does not test a real
sign-in or real coding work.

**Your project's checks on Windows.** Casper runs your configured check commands in
`cmd.exe`. Commands that only exist on macOS/Linux (`grep`, `printf`, `test -f`) will
fail there. Your project's own tools (Node, Python, compilers) must already be
installed; the Bun built into `casper.exe` runs Casper itself, not your project's
commands.

## 4. Optional integrations and limitations

- **The AI's shell tool needs Bash.** The model's `bash` tool (from Pi) needs a Bash on
  the PC, for example Git for Windows. Casper's own checks use `cmd.exe`. Installing
  Casper does not install Bash or any other tool.
- **Browser:** Casper looks for installed Chrome and Edge. It never downloads a browser.
- **Diagrams and screenshots:** diagram files and screenshot files need macOS or Linux.
  On Windows, diagrams are shown in the conversation instead; screenshot files are
  not available.
- **Debugger:** needs a debug adapter (DAP) that you installed and set up yourself.
- **Process cleanup:** Casper uses the Windows parent/child process list. When it is
  not sure a process stopped, it says so instead of guessing and stopping something
  else. Such a process may still be running; restarting Casper does not prove it stopped.
- **MCP servers you already set up (new in 0.2.15):** Casper finds VS Code's
  `mcp.json` and `settings.json` in `%APPDATA%\Code\User` (and the Insiders folder),
  plus the other files listed in [MCP.md](MCP.md), such as `~/.mcp.json` in your user
  folder. Each server needs one `/mcp connect` first.
- **Remembered MCP approvals:** on Windows, Casper cannot check that
  `~/.casper/mcp-consent.key` is readable only by you (Windows has no such permission
  bits), so that check is skipped. See [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md).
- **netconan** (optional secret checker): found as `netconan.exe`, `.cmd` or `.bat`
  when installed.
- **No shell sandbox yet.** The banner and `/status` say
  `shell     not sandboxed (Windows has no sandbox yet) · Casper asks before AI shell commands that change things`,
  and the AI's shell asks `Run this command?` before each command that changes something, with `1 No` first
  (reads like `ls`, `cat` or `git status` don't ask; 3 and 4 cover a command prefix such as `npm test`).
  A one-shot run refuses the AI's shell commands unless you pass `--no-sandbox`. On
  Windows your project's own checks, services and dev servers still run, not sandboxed,
  with your permissions and network. A pack from GitHub (`/pack add https://github.com/…@<commit>`) is
  fetched not sandboxed too, with your git settings and hooks off; see [PACKS.md](PACKS.md#from-github).
  See [SECURITY.md](SECURITY.md).
- **Undo** needs git on PATH (Git for Windows). Without it
  the receipt says `Undo not available` and names why. Restoring a symbolic link or a
  file's run bit has not been tried on Windows yet. See [UNDO.md](UNDO.md).

### v0.2.17 checks to try by hand

In the disposable project above (a git repository, with Git for Windows installed):

- Ask for a small change, then press `2` on the `Next: 1 Show diff · 2 Undo` row. The
  file goes back; `/redo` puts it back again (its row shows `2 Redo`). Press Enter on the row
  instead: nothing runs.
- Change the same file yourself after a task, then `/undo`: the question starts with
  `1 Cancel`, and Enter changes nothing.
- `/diff`, `/receipt list`, then restart Casper and `/receipt 1`: the old receipt shows.
- Ask the AI to run a shell command: `Run this command?` shows, Enter says no.
- `casper --json "/undo 1"` and `casper "/security-review"` in one-shot runs end without
  waiting for an answer.

## Report a failure

Include: Windows version, Bun and PowerShell versions, terminal app and version, the
Casper version (`casper --version`) or source commit, the exact command, what you
expected, what happened, and the error text. For CI, add the run URL and the
`windows-verification-*` artifacts, including skipped tests. Remove credentials, private
code, account names and private paths. A screenshot helps but is optional.

A skipped test, or a browser or adapter that was not there, is not proof that
something works. For deeper checks, see the
[platform verification runbook](PLATFORM_VERIFICATION.md).
