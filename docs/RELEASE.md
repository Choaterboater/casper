# Release process and installers

Casper distributes an unsigned **v0.1.0 preview**, not a stable release. Installers
use `https://github.com/Choaterboater/casper/releases/download/v0.1.0` because
GitHub's `latest/download` route excludes prereleases.

## Build

Build with Bun **1.4.0**, the runtime used for this preview:

```sh
bun install --frozen-lockfile
bun run check
bun run build:release                 # host target
bun run build:release -- --all         # all five release targets
bun run build:release -- --target bun-windows-x64
```

`scripts/build-release.ts` uses the shared compiler in `scripts/compile.ts` and
writes a fresh `dist/release/`. A host-only build replaces that directory with only
the host artifact; publish the complete `--all` output, not a partial rebuild.

| Artifact | Platform |
| --- | --- |
| `casper-darwin-arm64` | macOS, Apple silicon |
| `casper-darwin-x64` | macOS, Intel |
| `casper-linux-x64` | Linux, x86-64 |
| `casper-linux-arm64` | Linux, arm64 |
| `casper-windows-x64.exe` | Windows, x86-64 |

The directory also contains both installers, `SHA256SUMS`, `VERSION`, `LICENSE`
and `THIRD_PARTY_NOTICES.txt`. Checksums cover the executables. Each executable
embeds the notices, available through `casper --licenses`, so copying the executable
alone retains its notices. Third-party components keep their own licenses.

## Standalone resource handling

- `src/standalone.ts` explicitly starts the CLI. Relying on the source CLI's
  `import.meta.main` guard produced silent exits in compiled Windows builds.
- The compiler embeds Photon's WASM using Bun's file loader. An in-memory build
  plugin replaces only the pinned package's absolute-path loader, without modifying
  installed dependency files. A changed upstream loader causes the build to fail
  for review rather than silently producing an incomplete executable.
- The native image regression compiles Pi's actual read tool, denies external WASM
  reads and processes/resizes a generated PNG outside the checkout.
- The C artifact bridge is embedded too. On supported POSIX hosts it is briefly
  materialized in a private temporary directory for TinyCC, then removed.
- Pi's release scripts supplied the resource-packaging reference; OMP's build and
  installer scripts supplied cross-platform implementation examples. Like those
  builds, x64 targets use baseline CPU compatibility. Executables do not autoload
  a project's Bun configuration or preload scripts.

## Installer contract

- No administrator access: `~/.local/bin` on macOS/Linux, or
  `%LOCALAPPDATA%\Programs\casper` on Windows. `CASPER_INSTALL_DIR` overrides it.
- Downloads must match `SHA256SUMS` (or an explicit `CASPER_SHA256` override).
- The staged executable must exit successfully for `--version`, produce output,
  and match an optional `CASPER_VERSION` pin before replacing an existing binary.
- A rejected checksum, failed executable or mismatched version preserves the
  existing installation and removes staging. A successful replacement is not
  rolled back automatically.
- Re-running a versioned installer reinstalls that preview. Use a newer release's
  URL to upgrade to a different version.
- POSIX installers preserve an existing development symlink unless `--force` is
  supplied, and print PATH guidance without modifying shell dotfiles.
- Windows requires PowerShell 5.1 or newer, enables TLS 1.2, suppresses slow
  per-chunk download progress, and updates both the user PATH and the current
  PowerShell process PATH. Running through a child `powershell -c` still requires
  reopening the parent terminal. Close a running Casper before replacing its exe.
- Windows has an x64 artifact only. ARM64 is not claimed as native support.

## Validation

The macOS serial gate passed **543 tests / 0 failures / 3,556 assertions**, with
TypeScript clean. ARM64 and Intel-through-Rosetta installs, version/help, diagram
artifacts and rejected-version preservation are checked against a locally served
release directory, without Bun on the installed application's PATH.

The [Windows CI workflow](../.github/workflows/windows-preview.yml) installs locked
dependencies on a Windows runner, typechecks, tests standalone startup and native
image reads, builds the Windows executable, and tests served installation under
**Windows PowerShell 5.1 and PowerShell 7**. It checks PATH updates, version/help,
embedded licenses, project inspection, inline diagrams, and rejection of bad
checksums/version pins without replacing an existing installation.

The [published-release workflow](../.github/workflows/verify-release.yml) installs
from the actual anonymous GitHub URL with no checkout or Bun on PATH.
These are installation/smoke checks, not exhaustive Windows desktop validation.
Linux artifacts are cross-compiled but still require real-host verification.

## Publish

1. Run the gates above and review source/notice changes. Build from a neutral path;
   scan final binaries for personal build paths before uploading them.
2. Keep `package.json`, `src/version.ts`, both installer defaults and documented
   release URLs aligned. The build rejects application-version drift.
3. Commit/push the approved source. Create a draft GitHub prerelease for the exact
   intended tag/commit and upload every file in `dist/release/`.
4. Verify uploaded assets/checksums, then publish the prerelease. Draft assets cannot
   serve the anonymous one-liner. Do not put executable binaries in Git history.
5. Run the published-release workflow and verify the anonymous installer URLs.

## Known preview limits

- Binaries are unsigned/unnotarized. SmartScreen or Gatekeeper may warn.
- The login picker currently appends selection messages instead of visibly moving
  the highlight. This UI issue is separate from installation and remains queued.
- Windows diagram output is inline; screenshot/diagram artifact files require the
  POSIX bridge. Optional browser/debugger/LSP/MCP behavior is not fully host-tested.
- There is no npm/Homebrew distribution channel, automatic updater or rollback.
- Installation does not install project language tools, browser/debugger adapters or
  Git Bash. Pi's model-facing Bash tool needs an available Bash on Windows; Casper's
  own verification commands use the Windows shell.
