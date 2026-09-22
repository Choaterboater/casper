# Release process and installers

How Casper becomes a one-line install: a self-contained binary per platform, an
installer that verifies what it downloads, and a version-specific GitHub preview URL.

Status: **build and installers are implemented and verified locally (macOS); the
published directory shape — artifacts, sums and both installers in one place — is
verified over a local HTTP server, so `curl … | sh` works against it, and `--all`
cross-compiles all five artifacts. Defaults target the planned `Choaterboater/casper`
`v0.1.7` preview. Nothing is published, and no Windows host has run `install.ps1`.**

## Artifacts

```bash
bun run build:release                      # host platform only (fast; what CI and local checks use)
bun run build:release -- --all             # every published platform
bun run build:release -- --target bun-linux-x64
```

`scripts/build-release.ts` compiles `src/cli.ts` with `bun build --compile --minify`
and writes to `dist/release/` (gitignored):

| Artifact | Platform |
| --- | --- |
| `casper-darwin-arm64` | macOS, Apple silicon |
| `casper-darwin-x64` | macOS, Intel |
| `casper-linux-x64` | Linux, x86-64 |
| `casper-linux-arm64` | Linux, arm64 |
| `casper-windows-x64.exe` | Windows, x86-64 |

Plus `install.sh` and `install.ps1` (copies of `scripts/`, so one upload makes
`<base>/install.sh` reachable), `SHA256SUMS` (in `sha256sum -c` format) and `VERSION`.
The sums file covers the binaries only: it is what the installer checks its download
against, and an installer cannot meaningfully verify itself.

Each run rebuilds the directory from scratch: a host-only build leaves **one** artifact
there, so publish from a `--all` build (`--target` and the host default are for local
verification).

The compiled binary embeds Bun and every dependency, so the installed `casper` needs
neither the checkout nor Bun on the target machine. The build fails if
`package.json`'s version and `src/version.ts` (what `casper --version` prints) drift
apart — a compiled binary cannot read `package.json`, so the version lives in code.

## Publishing

1. Choose the release host and set the default `CASPER_BASE_URL` in both
   `scripts/install.sh` and `scripts/install.ps1`. This preview uses
   `https://github.com/Choaterboater/casper/releases/download/v0.1.7`.
   **Do not use `latest/download` for a prerelease:** GitHub excludes prereleases
   from that route. Re-running a versioned installer reinstalls that version;
   update the documented URL/defaults together when publishing a new preview.
2. `bun run build:release -- --all`.
3. Upload **every file** in `dist/release/` to one directory of a release host
   (for this preview, the GitHub Release tagged `v0.1.7`). The
   directory is self-contained: the artifacts, `SHA256SUMS`, `VERSION` and both
   installers go to the same place, so `<base>/install.sh` and `<base>/install.ps1`
   resolve next to the binaries they download.
   Edit `scripts/`, never the copies in `dist/release/`. Any installer change needs
   a rebuild and re-upload before the served one-liner contains that change.
4. Verify from a clean machine:
   `curl -fsSL <host>/install.sh | sh`, `casper --version`, and
   `casper /visualize repo` inside a small source project. On Windows, verify the
   PowerShell installer and inline visualization separately on that host.

The build does not publish anything. Commit the approved source snapshot, push it,
then create `v0.1.7` against that exact commit as a GitHub prerelease. Upload binaries
as release assets, never as Git source files. Publishing needs explicit maintainer
approval; a draft/private release cannot serve the anonymous one-liner.

## Installer contract

`scripts/install.sh` (macOS, Linux) and `scripts/install.ps1` (Windows) share it:

- **Verify or refuse.** The SHA-256 is checked against the release `SHA256SUMS`;
  a missing or mismatched digest aborts and nothing is installed. `--sha256`/`CASPER_SHA256`
  covers out-of-band verification. The shell installer's `CASPER_BASE_URL` accepts an
  `http(s)` URL, a `file://` URL or a local directory for offline/internal installs.
  PowerShell currently downloads through `Invoke-WebRequest`; use an HTTP(S) base URL.
- **No sudo.** Installation goes to `CASPER_INSTALL_DIR` (`~/.local/bin`, or
  `%LOCALAPPDATA%\Programs\casper` on Windows).
- **Proves the artifact before it replaces anything.** The download is staged inside the
  install directory (`.casper-download.<pid>`, or `.casper-download.exe`), run there for
  `--version`, and only then moved over the target. A failed version pin, or a binary
  that cannot run on this host, therefore leaves an existing installation byte-identical
  — the staged file is removed on every exit path, including a signal.
- **Idempotent.** Re-running replaces the binary in place. A versioned preview URL
  reinstalls that preview, not an automatically selected newer release.
  Because the final step is a single rename within the install directory, an interrupted
  update cannot leave a half-written `casper`.
- **Protects a development link.** An existing symlink at the target (the checkout
  install documented in the README) is reported and left alone unless `--force` is given.
  Windows has no analogue: its target is `casper.exe`, and `install.ps1` takes no flags
  at all — it is configured entirely through environment variables.
- **Flag parity is deliberately asymmetric.** `install.sh` accepts `--dir`, `--version`,
  `--sha256` and `--force`; `install.ps1` reads `CASPER_INSTALL_DIR`, `CASPER_VERSION`
  and `CASPER_SHA256` from the environment. Windows arm64 also has no artifact, so the
  platform checks differ by necessity.
- **Requires a successful version probe before replacement.** The staged executable's
  `--version` must exit 0 and print `casper <version> (<path>)`; only the version token is
  compared, so a requested version must match it exactly while the path suffix is ignored.
  Matching output with a nonzero exit is still a failure. The success line is
  `Installed casper <version> to <target>` and comes from that staged probe; neither
  installer executes the final path again. A rejected probe preserves the previous
  installation. An existing `casper` link that resolves into a `.scratch/` checkout is
  reported and never replaced, even with `--force`.
- **Does not edit shell dotfiles.** macOS/Linux print the exact `export PATH=…` line
  when the install directory is not on `PATH`; Windows appends the directory to the
  *user* PATH through the environment registry.
- **Clears the macOS quarantine flag** on the staged binary before it is run (best
  effort), so the first run is not blocked by Gatekeeper.

## Local verification (no release host required)

```bash
bun run build:release
cd dist/release && python3 -m http.server 8731 --bind 127.0.0.1 &
CASPER_BASE_URL=http://127.0.0.1:8731 sh scripts/install.sh --dir /tmp/casper-install
/tmp/casper-install/casper --version
```

The published shape itself is checkable the same way: serve `dist/release` and pipe the
*served* installer into a shell, which is the documented one-liner minus the real host.

```bash
env -i PATH=/usr/bin:/bin HOME=/tmp/casper-home TMPDIR=/tmp \
  CASPER_BASE_URL=http://127.0.0.1:8731 sh -c 'curl -fsSL "$CASPER_BASE_URL/install.sh" | sh'
```

`tests/release-install.test.ts` covers the installer without a compiler: artifact-name
agreement with the release build, successful install of a verified artifact, checksum
mismatch failing closed, missing digest failing closed, out-of-band digest plus version
pinning (including that a rejected pin installs nothing and leaves no staged file),
development-symlink protection, and unsupported-platform reporting. A failing executable
that prints the expected version is rejected while preserving an existing installation.
The suite also compiles the real CLI, runs it outside the checkout with no Bun on PATH,
and asserts Mermaid and MindMesh artifact files are created. This catches missing runtime
assets that `--version` and `--help` cannot exercise.

The C bridge is embedded via Bun's file loader. TinyCC cannot open Bun's virtual
filesystem directly, so Casper writes the fixed source into a private temporary
directory for compilation, then removes it. No system headers or compiler are needed.

## Limits

- **`install.ps1` is not host-validated.** It is written to the same contract as
  `install.sh`, but no Windows machine has run it, and the validating host has no
  PowerShell either — so it has not even been parsed, only statically reviewed. Three
  issues that review did catch are fixed (32-bit-shell architecture detection via
  `PROCESSOR_ARCHITEW6432`, temp-directory creation inside the cleanup `try`, and a
  named error when the installed `casper.exe` is still running); a fourth is the staged
  move that makes the version pin fail closed, which is verified in `install.sh` on
  macOS but not in PowerShell. The version probe now also checks `$LASTEXITCODE`;
  this correction still needs that host run. Treat the first Windows run as a test and expect to fix
  quoting or PATH details. Only `casper-windows-x64.exe` is built — Windows arm64 has no
  artifact yet.
- **Binaries are unsigned.** macOS Gatekeeper and Windows SmartScreen may warn; the
  installers clear the quarantine attribute but do not notarize or sign. Signing and
  notarization are separate work with their own credentials.
- **No npm or Homebrew channel.** `npm i -g casper` is not available: the name `casper`
  is taken on npm (v0.1.7), and a Bun-native CLI would still require Bun on the target
  machine, which the compiled binary avoids. A scoped npm package or a Homebrew cask
  are options, not implemented.
- **Artifacts are per-platform builds, not universal binaries.** Each platform gets
  its own file; the installer picks by `uname`/`PROCESSOR_ARCHITECTURE`.
- **Nothing is published.** `dist/release/` is built and locally verified; installer
  defaults target `https://github.com/Choaterboater/casper/releases/download/v0.1.7`.
  That is a planned address, not a live release. The binaries have run outside the
  checkout on macOS but not on a separate Windows/Linux machine.
- **Cross-compilation is verified on macOS, the artifacts are not.** `--all` produced
  all five files on this host (Bun fetches the target runtimes on first use) and every
  digest matches `SHA256SUMS`; `casper-darwin-x64` even installs and runs here through
  Rosetta, while the Linux artifacts are correctly refused as unrunnable. Nothing has
  executed a Linux or Windows artifact on its own platform.
- **A first `--all` needs network.** Bun downloads the target runtimes into its cache;
  later builds are local.
- The installer has no rollback, because it has nothing to roll back to: the target is
  only replaced after the download is verified and proven to run, so a failed install
  leaves the previous binary untouched when validation fails. Once the staged file has
  been renamed, the new binary is installed; interruption afterward does not roll it back.
