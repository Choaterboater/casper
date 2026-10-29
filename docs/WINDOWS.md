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
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; irm https://github.com/Choaterboater/casper/releases/download/v0.3.9/install.ps1 | iex
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

`casper --version` should print `casper 0.3.9 (<path to casper.exe>)`. The `Source`
line should point into the install folder, not an old checkout or some other program
called casper.

The command above always installs **v0.3.9**. Running it again reinstalls v0.3.9.
To get a newer preview, run `casper update`. Windows will not replace a running `casper.exe`,
so Casper checks that release's own installer (checksum and build provenance, as on other systems),
saves it to a private temporary folder and asks Windows itself (its WMI service, `Win32_Process.Create`)
to start a separate hidden PowerShell that waits for Casper to exit, then runs that same file. Started by
Windows rather than by `casper.exe`, the helper keeps running after Casper exits; the settings the
installer needs go to it as checked parameters. Casper prints one line and exits; the helper then
downloads the new program, which takes a little while, so wait about 30 seconds before running `casper --version`.
For a manual update the waiting step gives up after five minutes without installing. If that separate step cannot be started, Casper shows
the `irm ... | iex` line to run yourself.

The helper has no window, so it writes what it does to `~/.casper/update.log` (one file, overwritten by each update;
versions, process ids, the installer's SHA-256 and error text, nothing else): one line per step, and a last line
`result: ok` or `result: failed: <why>`. When the last update did not finish, `casper update`, `casper doctor` and the
line at the start of a session say so, name the log and show the `irm ... | iex` line. Before 0.2.35 the helper was
started as Casper's own detached child; on a real Windows machine it never ran (the log stopped at `result: pending`),
so updating from 0.2.34 or older still needs the `irm ... | iex` line once. `scripts/windows-handoff-check.ps1` checks,
on a PC, which way of starting a helper outlives its parent.

### Background updates

Since v0.2.36 Casper defaults to **Updates: auto**: it quietly uses the same signed checksum,
SHA-256 and build-provenance checks as `casper update`, then the fixed Windows WMI handoff.
The notice above the prompt says `✔ Update installed · restart to use it`; on Windows this means
the checked installer is ready and the helper waits until this Casper exits before replacing
`casper.exe`. Background handoffs wait for the whole session, not the manual command's five-minute
limit. Nothing restarts Casper or changes the running program. After quitting, allow the helper
time to install before starting Casper again. Failures are in `~/.casper/update.log` and the notice
says `update failed · casper update`. **Updates: notify only** (`updates: notify`) checks without
installing; **off**, `CASPER_NO_UPDATE_CHECK=1` or `CI` stops background activity. One-shot and
`--json` runs never install.

### Starting a session or running once

**Since v0.2.36:** in PowerShell with stdin and stdout both attached to the
terminal, no forcing flags and `CI` unset, `casper "Explain this project"` starts a session with that first request
and stays open. `casper -p "Explain this project"` (or `--print`) runs once and exits; use `-p`
explicitly in scripts. Redirecting either stream, `--json`, a lone `-` prompt,
`--require-verification`, `--max-turns`, or `CI` set still forces one-shot mode. Exit codes and
receipts are unchanged. At home or a drive root, a lone word that isn't a folder first asks
whether you meant a request or a new named project; elsewhere, or with two or more words, it does not.

## Windows with WSL (Linux inside Windows)

WSL is Linux running inside Windows. If you open a WSL terminal (Ubuntu, for example), you
can use the Linux Casper there instead of the Windows preview. In that terminal:

```sh
curl -fsSL https://github.com/Choaterboater/casper/releases/download/v0.3.9/install.sh | sh
```

- The Linux Casper is a separate install from the Windows one. It has its own `~/.casper`
  (inside WSL) and its own sign-in, so run `/login` once there.
- It works with nothing else to install. It asks before shell commands that change
  things.
- `/sandbox` shows how to add the full sandbox if you want it.
- The AI's browser and `/look` need a Chrome inside WSL; the Windows Chrome can't be used from
  there. To install it:
  `wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y ./google-chrome-stable_current_amd64.deb`.

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
| `bun run test` | The full suite: non-terminal files in parallel, then serial terminals and the real debugger, as on Linux and macOS. Tests that need a PTY, POSIX signals or file modes, or a tool that is not installed, skip |
| `bun run test:evals` | The evaluation bench's own tests, as on Linux |

To run the same focused tests from a checkout (after `bun install --frozen-lockfile`):

```powershell
bun test tests/platform-processes.test.ts tests/login-picker.test.ts tests/login.test.ts tests/model-routing.test.ts tests/auto-effort.test.ts tests/model-selection.test.ts tests/daily-terminal.test.ts tests/terminal-review.test.ts tests/terminal-ux.test.ts tests/terminal-discovery.test.ts tests/network-update-swap.test.ts tests/undo.test.ts tests/project-root-path.test.ts tests/login-browser.test.ts tests/receipt.test.ts tests/undo-app.integration.test.ts
```

These use fake providers, temporary folders and local-only services. They need no
real credentials and make no paid model calls. The platform probe must exit 0; any
failed step fails the job.

CI balances the non-terminal suite across six runners using `tests/timings.json`
(`bun tools/test-shard.ts 6 1` prints part 1). Slow-file weights were raised from test-duration
totals in green Windows main run `38781548444`; higher existing cross-OS estimates were kept.
Each runs two files at a time, leaving room
for their spawned CLIs and servers, with an 18-minute suite step inside a 28-minute job. Part 1 also runs the
real debugger (3 minutes) and the eval tests (6 minutes: the real-grader case alone takes 2-3 minutes on Windows).
Source tmux/PTY/ConPTY users run in a separate serial job (`bun run test:terminal`, one retry
per test, a 120 s default per-test limit, and separate `tests/timings-terminal.json`).
The build/installer runner retains its serial check of the compiled executable's console.
Linux/macOS use the same separation: source terminals have their own 20-minute job with a 15-minute
test step, without extending the 18/25-minute source-job limits. No files are dropped: each OS's parallel
files plus the terminal lane are the original suite, with real debugger and evals still run separately.

To record proof, use `bun tools/windows-ci-proof.ts <run-id> <commit-sha>`. It reads GitHub
metadata and requires a full push/nightly/manual Windows run on that exact commit, attempt 1,
with all six shards, source terminals and the build green. A rerun, skipped job or fast-tier
PR run cannot count. This is workflow-attempt evidence, not a claim that OS-skipped tests ran.
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
corners, and every other mark is ASCII (`>` for `❯`, `+` for `✓`, `x` for `✗`; docs/TERMINAL_UX.md lists them).

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
- `/model` and `/effort` open pickers with made-up choices. `/model` opens on the
  providers on the left; Tab moves to the models. The arrow keys must move the highlight
  in place, Enter picks, Escape cancels.
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
  On Windows, diagrams are shown in the conversation instead, and the AI still sees its
  browser screenshots: they come with the result, only not as files.
- **Debugger:** needs a debug adapter (DAP) that you installed and set up yourself.
- **Process cleanup:** Casper uses the Windows parent/child process list. When it is
  not sure a process stopped, it says so instead of guessing and stopping something
  else. Such a process may still be running; restarting Casper does not prove it stopped.
- **MCP servers you already set up (new in 0.2.15):** Casper finds VS Code's
  `mcp.json` and `settings.json` in `%APPDATA%\Code\User` (and the Insiders folder),
  plus the other files listed in [MCP.md](MCP.md), such as `~/.mcp.json` in your user
  folder. They connect when the session starts (**My MCP servers** in `/settings`; with it off,
  each server needs one `/mcp connect` first).
- **Remembered MCP approvals:** on Windows, Casper cannot check that
  `~/.casper/mcp-consent.key` is readable only by you (Windows has no such permission
  bits), so that check is skipped. See [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md).
- **netconan** (optional secret checker): found as `netconan.exe`, `.cmd` or `.bat`
  when installed.
- **No shell sandbox yet.** The banner and `/status` say
  `shell     not sandboxed (Windows has no sandbox yet) · Casper asks before AI shell commands that change things`,
  and the AI's shell asks `Run this command?` before each command that changes something but routine work (git commit,
  `npm test`, `bun install`, files made or removed in the project: **Routine commands** in `/settings`), with `1 No` first
  (reads like `ls`, `cat` or `git status` don't ask, also after a `cd /c/Users/me/project &&` into the project, with
  `app/*.py` globs, `2>&1` or `python --version`; 3 and 4 cover that exact command, such as `npm test`; inside a line like `cd app && npm test 2>&1 | tail -25`
  they cover `cd app && npm test` from that folder, never `npm test -- --watch` or `rm -rf ~`). A
  yes leaves no extra line; a
  remembered one leaves one short `✓ allowed …` line, and `/permissions all` stops asking until you quit.
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
- `casper --json "/undo 1"` and `casper -p "/security-review"` in one-shot runs end without
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
