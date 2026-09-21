# Windows preview checklist

This preview targets **Windows x64**. Its first Windows runs are validation, not
established platform support. You do not need Bun or a Git checkout to use the
compiled application. Unsigned executables may trigger SmartScreen; do not bypass
an unexpected warning without verifying the download source.

## 1. Install once the preview is published

**No binary release is published yet; this command is a planned URL, not a working
installer.** See [release blockers](RELEASE.md#current-release-blockers).

After those blockers are resolved and the preview is published, in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://github.com/Choaterboater/casper/releases/download/v0.1.0/install.ps1 | iex"
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

## 2. Check local startup

Enter a trusted project directory, then:

```powershell
casper /project
casper
```

Try `/help`, `/status`, and `/exit`. These should work without model credentials.
Check that multiline input, cursor movement and terminal resizing are usable.

## 3. Check coding with your provider

Start Casper again, use `/login`, then `/model`. Login and subsequent coding use
your provider account and may incur usage. Only enter secrets in the private
login prompt. Choose a small change in a disposable branch or backed-up project.

Check whether Casper:
- shows meaningful file/tool activity;
- makes the requested change without unrelated edits;
- cancels active work with Ctrl+C and remains usable afterward;
- resumes a saved conversation with `/resume`;
- distinguishes actual check results from model claims.

Configured verification commands must work in Windows `cmd.exe`, not require
POSIX-only commands such as `grep` or `printf`. Existing repository dependencies
and language tools are still needed for those checks; the embedded Bun runtime
runs Casper itself, not every arbitrary project command.

## 4. Optional integrations and limitations

- Browser discovery includes installed Chrome and Edge. No browser is downloaded.
- Screenshot-file and diagram-artifact creation use a POSIX native bridge. Windows
  diagram requests fall back to inline text; screenshot files are unavailable.
- Debugging requires a manually configured, already installed DAP adapter.
- Windows process cleanup uses OS parentage and reports uncertainty rather than
  guessing which unrelated processes to terminate. Unconfirmed cleanup may leave
  processes alive; restarting Casper is not proof they stopped.
- Re-running this installer reinstalls the pinned preview, not a future version.

## Report a failure

Include Windows version, PowerShell version, terminal application, exact command,
expected/actual behavior, and the error text. Redact credentials, private source,
account identifiers and sensitive paths. A screenshot is optional.

Do not interpret skipped tests or an unavailable optional browser/adapter as
validation. For deeper source-level checks, see the
[platform verification runbook](PLATFORM_VERIFICATION.md).
