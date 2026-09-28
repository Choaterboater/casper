# Release process and installers

Casper distributes an unsigned **v0.2.14 preview**, not a stable release. Installers
default to `https://github.com/Choaterboater/casper/releases/download/v0.2.14` because
GitHub's `latest/download` route excludes prereleases. The first published preview
was **v0.1.0**; its assets and tag stay as published, and every fix ships under a new
version.

## v0.2.14: see it build, trust the result

**Receipt:** line 1 is the verdict: `✓ Verified — the checks pass, and the tests fail without the
change`, `✓ Checks passed — not proven: <why>`, `✗ Failed`, `Incomplete`, `Not verified`, or
`✗ Stopped — cancelled; changes already made are kept`. Check lines read `✓ test passed (npm test,
0.4s)`. `--json` receipts add `verdict` and `proofSkipped`; `outcome` and exit codes are unchanged.
See [VERIFICATION.md](VERIFICATION.md#receipts).

**Unfinished checks:** a check that timed out or could not start is marked as unfinished (`--json`
check events carry `ended: "timeout"` or `"no_start"`), not as the code failing, and it is never handed
to a paid repair. The terminal asks: 1 Retry · 2 Fix it anyway · 3 Allow more time (doubles the
limit each time, at most one hour), and the receipt says `✗ Not checked`, not `✗ Failed`. While a
question or the checklist waits for you, the footer says `? waiting for you` instead of spinning.

**Model errors:** a provider failure such as an empty response is retried once on its own, and then
the terminal asks whether to retry or stop. When the model fails after editing, Casper still runs the checks on its edits (no
repair) and the receipt says how they fared and suggests another model.

**Watching it work:** the footer shows the task's stages (`checklist ✓ · building ✓ · checks ·
1m05s`); each check prints one line as it finishes; edit and write lines show their size (`+18 -4`); a
bell rings when a request that ran 10 seconds or more finishes or needs you (rich terminal only).
Question choices show numbers, and pressing a number picks it. The banner and `/status` say which
checks run after a change, and `/receipt` is in the command list. Shift+Tab remembers the effort
level it stops at, like `/effort`.

**Sign-in:** with no model set, Casper opens sign-in on your first request instead of printing a
failed receipt, then picks a model for that provider (OpenRouter: `deepseek/deepseek-v4.1-flash`).
It never replaces a model you chose.

**Repositories:** Python detection covers uv, poetry, `.venv`, `python3 -m`, `requirements*.txt`
and `[tool.mypy] files`. In a git repository the change list comes from git, and the proof copy
links `.venv`/`venv` like `node_modules` instead of copying it, so a 30,000-file virtualenv no
longer slows every task. Launched from a folder of projects, Casper asks which one to open. A
request that opens with a build verb ("add a config loader") is treated as building.

**Tools:** Pi's own read/edit/write rules are back in the model's prompt (Pi drops them when a
custom prompt is set). A bash timeout above one hour is capped at one hour. Calls that ask you or
drive shared state (ask, MCP calls that may need approval, browser, LSP) run one at a time, and a
delegate turned away as busy no longer spends the task's delegation budget.

**Security:** the `--json` receipt redacts secrets in the proof's failing output and review items.
The proof step never deletes or writes through a folder the change turned into a link. Your own
MCP servers (user and profile config) start in your home folder unless their `cwd` says otherwise,
and a project server's review names each variable it sends and where (`sends $TOKEN to
https://example.com (header Authorization)`).

**Git safety:** the model's bash may not run `git stash`, `git reset --hard`, `git checkout --`,
`git restore`, `git switch -f` or `git clean`, which can set aside or discard your uncommitted work.

**Docs:** git commit/push policy and "ask before destructive operations" are described as what
they are, instructions in the model's prompt, and auto checks as running the repository's
commands without asking (`--no-verify` opts out for a run).

## v0.2.13

The first published build since v0.1.0. It carries every change below. The 0.2.12 build was never
published: its binary could not use stored OAuth sign-ins (fixed here, see below), and the installer
URLs that pointed at it returned 404.

**Request checklist:** before an interactive code change (implement, fix or test), Casper lists the
cases the request states and shows them in the prompt editor, where you can edit them or press Esc to
skip; the model then writes one test per case. On by default for interactive code changes,
`verification.checklist: false` turns it off, `true` also enables it for one-shot runs. Long requests
work: up to 80 cases, a 24,000-token answer, bullet-list answers accepted, and a cut list says how many
cases were left out. The requirements list no longer drops open items past its 50th line, so an
admitted gap always makes the change not verified. See [VERIFICATION.md](VERIFICATION.md#request-checklist).

**Casper checks its own work by default:** a new project's first change runs the checks and repairs
failures with no command from the user (before, it only suggested `/verify` until the checks had been
timed, and one-shot prompts needed `--verify`). `--no-verify` opts out for a run.

## v0.2.13: scripting surface

Phase 2: one-shot runs are scriptable. `--model <provider/id[:effort]>` and `--effort` choose
the model and effort for one run and never change the saved default. `--json` streams JSON Lines
events (`"v": 1`) on stdout and moves human output to stderr. `--continue` and
`--resume <id-prefix>` pick up a conversation, `--cd <path>` opens a folder, and `--max-turns <n>`
bounds each request. `--require-verification` makes unverified changes exit 3. **Exit code
change:** command-line mistakes (unknown options, conflicting flags, bad `learn` arguments) now
exit **64** instead of 2 or 1, so 2 always means incomplete. See [SCRIPTING.md](SCRIPTING.md).

## v0.2.13: Casper runs the checks

Phase 1: after the model edits files, Casper runs the project's checks itself
(`verification.mode: auto`), repairs failures within `repair.maxAttempts`, and ends each
task with a plain receipt ("✓ Verified by Casper: test passed"). `--verify` now means
`auto` for the run and `--no-verify` means `off`. Unconfigured sessions, interactive and one-shot,
use `auto` from the first change (Casper checks its own work by default); interactive sessions offer
checks measured at 60 seconds or more instead. The detailed evidence
receipt moved to `/receipt` and `--verbose`. `verification.checks` selects the checks, and
the default per-check timeout is now 600 seconds. See [VERIFICATION.md](VERIFICATION.md).

**Compiled-binary sign-in fix:** the unpublished 0.2.12 binary could not use any stored OAuth sign-in
(OpenAI Codex, GitHub Copilot, Anthropic, OpenRouter): model requests failed with
`OAuth auth derivation failed … Cannot find module './github-copilot.js'`. The OAuth flows are now
embedded in the binary. The source CLI was unaffected.

## v0.2.13: independence and review fixes

Phase 0 lands the full review fixes, including untrusted project-resource isolation,
side-effect-free informational flags, terminal sanitization, explicit project-server
consent, bounded cleanup, and release builds without stray `.bun-build` files.

**Environment migration:** use `CASPER_AGENT_DIR`, `CASPER_OFFLINE`,
`CASPER_OAUTH_CALLBACK_HOST` and `CASPER_TUI_WRITE_LOG`. Inherited matching `PI_*`
settings are no longer fallbacks. A conflicting `PI_CODING_AGENT_DIR` is ignored
with a `[config]` startup warning, so Casper does not silently use another agent's credentials
or conversations. Explicit Casper stores receive no legacy import. See
[CONFIGURATION.md](CONFIGURATION.md#environment-variables).

Runtime copy now uses Casper/conversation terminology. Synthetic MCP fixtures use
neutral vendor/router-catalog names. Saved evaluation reports redact home and temp
prefixes; the committed historical reports are scrubbed too.

## Changes since v0.1.0

Correction: `/login` now mounts every provider/method, consent
and private-input panel in Casper's existing renderer. Previously a second
renderer sent cursor controls through the transcript sanitizer, printing literal
`\u{d}` and appending navigation updates. Login panels no longer become transcript
entries; standalone authorization URLs/device codes remain visible above them.

Source replaces the login selection log with Pi's `SelectList` and renderer.
Provider/method highlights redraw in place; parsed application arrows, fragmented
and batched navigation, and encoded Enter are handled without carrying keys into
consent or private submission. macOS production-CLI PTY and login/security tests
cover the correction. Windows CI includes keyboard regressions, but a Windows-host
run of this change is still pending.

Source also includes a coordinated terminal presentation update: width-aware
message/result/approval panels, semantic colors, Pi Markdown streaming, grouped
help/status/verification output and action-first assistant instructions. Exact
approval uses a separate input editor and restores the original draft/cursor.
The offline demo covers streaming, tables, Unicode, resize, approval and errors.

Terminal layout is stabilized: the `/` popup and model/effort pickers are
composited over the transcript instead of appended, a rows-only resize keeps
scrollback, the prompt gutter and footer state dot never shift, tool lines are
redrawn in place with a live progress line, and `/output [n]` recalls a tool
call's full retained output. Coding receipts name the files that actually changed
(before/after tree digest, plus changes made later during checks/repair) and append
a bounded `git diff --stat`. Interactive sessions offer `casper_check` by default;
`--no-verify` withholds it, and model-issued bash without `timeout` gets a
120-second default. `casper --version` prints `casper <version> (<path>)`.
See [TERMINAL_UX.md](TERMINAL_UX.md) and the bundled reference notices.

Source adds optional fast/build/reason/review aliases, explicit effort suffixes,
and model-backed automatic effort through the existing Pi session owner.
Automatic effort is opt-in, exposes its effective level/fallback, preserves
conversation preferences, and reports classifier usage separately. Read-only
children now route through Casper roles/defaults instead of shared Pi defaults.
See [CONFIGURATION.md](CONFIGURATION.md) for request-sharing and precedence.
Local fixture/terminal checks do not establish live-model classification quality
or lower cost.

The [evaluation suite](EVALUATION.md) gains `--repeat`/`--model`, three harder
single-module tasks, two multi-module fulfillment tasks and credential-free
preparation/grading.

None of this is in the published v0.1.0 binaries; Windows/Linux host validation of
these changes remains pending.

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
the host artifact; publish the complete `--all` output, not a partial rebuild. A
first `--all` needs network: Bun downloads the target runtimes into its cache.

| Artifact | Platform |
| --- | --- |
| `casper-darwin-arm64` | macOS, Apple silicon |
| `casper-darwin-x64` | macOS, Intel |
| `casper-linux-x64` | Linux, x86-64 |
| `casper-linux-arm64` | Linux, arm64 |
| `casper-windows-x64.exe` | Windows, x86-64 |

The directory also contains both installers (copies of `scripts/`, so one upload
makes `<base>/install.sh` reachable), `SHA256SUMS` (in `sha256sum -c` format),
`VERSION`, `LICENSE` and `THIRD_PARTY_NOTICES.txt`. Checksums cover the executables
only: an installer cannot meaningfully verify itself. Each executable embeds the
notices, available through `casper --licenses`, so copying the executable alone
retains its notices. Third-party components keep their own licenses.

The compiled binary embeds Bun and every dependency, so the installed `casper` needs
neither the checkout nor Bun on the target machine. The build fails if
`package.json`'s version and `src/version.ts` (what `casper --version` prints) drift
apart — a compiled binary cannot read `package.json`, so the version lives in code.

## Standalone resource handling

- `src/standalone.ts` explicitly starts the CLI. Relying on the source CLI's
  `import.meta.main` guard produced silent exits in compiled Windows builds.
- The compiler embeds Photon's WASM using Bun's file loader. An in-memory build
  plugin replaces only the pinned package's absolute-path loader, without modifying
  installed dependency files. A changed upstream loader causes the build to fail
  for review rather than silently producing an incomplete executable.
- The native image regression compiles Pi's actual read tool, denies external WASM
  reads and processes/resizes a generated PNG outside the checkout.
- The C artifact bridge is embedded too. TinyCC cannot open Bun's virtual
  filesystem directly, so on supported POSIX hosts the fixed source is briefly
  materialized in a private temporary directory for compilation, then removed. No
  system headers or compiler are needed.
- Pi's release scripts supplied the resource-packaging reference; OMP's build and
  installer scripts supplied cross-platform implementation examples. Like those
  builds, x64 targets use baseline CPU compatibility. Executables do not autoload
  a project's Bun configuration or preload scripts.

## Installer contract

`scripts/install.sh` (macOS, Linux) and `scripts/install.ps1` (Windows) share it:

- **No administrator access.** Installation goes to `~/.local/bin` on macOS/Linux, or
  `%LOCALAPPDATA%\Programs\casper` on Windows; `CASPER_INSTALL_DIR` overrides it.
  `install.sh` aborts before staging anything when that directory cannot be created
  or written.
- **Verify or refuse.** Downloads must match `SHA256SUMS` (or an explicit
  `--sha256`/`CASPER_SHA256` override for out-of-band verification); a missing or
  mismatched digest aborts and nothing is installed. The shell installer's
  `CASPER_BASE_URL` accepts an `http(s)` URL, a `file://` URL or a local directory for
  offline/internal installs. PowerShell downloads through `Invoke-WebRequest`; use an
  HTTP(S) base URL there.
- **Requires a successful version probe before replacement.** The download is staged
  inside the install directory and run there for `--version`. It must exit 0 and print
  `casper <version> (<path>)`; only the version token is compared, so an optional
  `--version`/`CASPER_VERSION` pin must match it exactly while the path suffix is
  ignored. Matching output with a nonzero exit is still a failure. The success line
  `Installed casper <version> to <target>` comes from that staged probe; neither
  installer executes the final path again.
- **Preserves an existing installation on any rejection.** A rejected checksum,
  failed executable or mismatched version leaves the previous binary byte-identical
  and removes staging on every exit path, including a signal. The final step is a
  single rename within the install directory, so an interrupted update cannot leave
  a half-written `casper`; once renamed, the new binary is installed and is not
  rolled back automatically.
- **Idempotent, per version.** Re-running a versioned installer reinstalls that
  preview, not an automatically selected newer release. Use a newer release's URL
  to upgrade.
- **Protects a development link.** On POSIX, an existing `casper` symlink that leaves
  the install directory (the checkout install described in the README) is reported
  and left alone unless `--force` is given; a link resolving into a `.scratch/`
  checkout is never replaced, even with `--force`. On Windows an existing
  `casper.exe` reparse point pointing outside the install directory is reported and
  never replaced.
- **Flag parity is deliberately asymmetric.** `install.sh` accepts `--dir`,
  `--version`, `--sha256`, `--force` and `--print-target`; `install.ps1` takes no
  flags and reads `CASPER_BASE_URL`, `CASPER_INSTALL_DIR`, `CASPER_VERSION` and
  `CASPER_SHA256` from the environment.
- **Does not edit shell dotfiles.** macOS/Linux print the exact `export PATH=…` line
  when the install directory is not on `PATH`. Windows requires PowerShell 5.1 or
  newer, enables TLS 1.2, suppresses slow per-chunk download progress, and updates
  both the user PATH and the current PowerShell process PATH. Running through a child
  `powershell -c` still requires reopening the parent terminal. Close a running
  Casper before replacing its exe.
- **Clears the macOS quarantine flag** on the staged binary before it is run (best
  effort), so the first run is not blocked by Gatekeeper.
- Windows has an x64 artifact only. ARM64 is not claimed as native support. The
  installer picks the artifact by `uname`/`PROCESSOR_ARCHITECTURE`; artifacts are
  per-platform builds, not universal binaries.

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

## Pi upgrade revalidation

Casper pins `@earendil-works/pi-coding-agent` exactly, and the engine packages it imports
directly (`pi-ai`, `pi-agent-core`, `pi-tui`) at the same version;
`tests/package-dependencies.test.ts` fails when an imported one is undeclared or drifts. The interactive model browser
(`src/runtime/pi-model-browser.ts`) is Casper-owned, but the adapter
(`src/runtime/pi-model-picker.ts`) still couples to Pi: the `ModelRuntime` snapshot and
`ModelsRefreshResult` shapes, the `app.models.save` keybinding id, `AgentSession["model"]`
and pi-tui rendering primitives. A Pi bump can degrade these silently. After changing the
pin, run:

```bash
bun run typecheck && bun test tests/pi-picker-coupling.test.ts tests/ask.test.ts tests/daily-terminal.test.ts && bun run check
```

and confirm, in a real interactive session against a configured provider:

1. `/model` opens the full-screen browser with the provider sidebar (Tab focuses the
   sidebar; Up/Down switch login groups); the footer ends with Casper's hint line
   (`Enter: remember globally · Ctrl+S: session only · …`) followed by the selected-model
   summary. Startup clears the viewport once (a fresh session fills the screen).
2. Filtering to one model and pressing Enter selects it; Esc cancels; Ctrl+S selects for
   the session only.
3. `/effort` opens the effort picker (plain `SelectList`; no Pi internals beyond
   `Container`/`Text`/`matchesKey`).
4. The transcript, editor gutter and the browser/debug/MCP approval prompts still render
   (surface compositing over Pi's `TuiMainScreen`).

`tests/pi-picker-coupling.test.ts` fails on keybinding (`app.models.save`),
refresh-result or browser render-contract changes; if it fails, update the adapter and
the test together, and re-verify steps 1–4 by hand before publishing.

## Validation

The v0.1.0 macOS serial gate passed **543 tests / 0 failures / 3,556 assertions**, with
TypeScript clean. ARM64 and Intel-through-Rosetta installs, version/help, diagram
artifacts and rejected-version preservation are checked against a locally served
release directory, without Bun on the installed application's PATH. Linux artifacts
are correctly refused as unrunnable on macOS; nothing has executed a Linux artifact
on its own platform.

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
   release URLs aligned. The build rejects application-version drift. Edit
   `scripts/`, never the copies in `dist/release/`; any installer change needs a
   rebuild and re-upload before the served one-liner contains it.
3. Commit/push the approved source. Create a draft GitHub prerelease for the exact
   intended tag/commit and upload every file in `dist/release/`: the artifacts,
   `SHA256SUMS`, `VERSION` and both installers go to the same place, so
   `<base>/install.sh` and `<base>/install.ps1` resolve next to the binaries they
   download.
4. Verify uploaded assets/checksums, then publish the prerelease. Draft assets cannot
   serve the anonymous one-liner. Do not put executable binaries in Git history.
5. Run the published-release workflow and verify the anonymous installer URLs; on a
   clean machine, `casper --version` and `casper /visualize repo` inside a small
   source project. On Windows, verify the PowerShell installer and inline
   visualization separately on that host.

## Known preview limits

- Binaries are unsigned/unnotarized. SmartScreen or Gatekeeper may warn; the
  installers clear the quarantine attribute but do not sign or notarize.
- Published v0.1.0 appends login selection messages instead of moving the highlight,
  and lacks every change listed above. Those corrections ship in v0.2.13.
- Windows diagram output is inline; screenshot/diagram artifact files require the
  POSIX bridge. Optional browser/debugger/LSP/MCP behavior is not fully host-tested.
- There is no npm/Homebrew distribution channel, automatic updater or rollback.
- Installation does not install project language tools, browser/debugger adapters or
  Git Bash. Pi's model-facing Bash tool needs an available Bash on Windows; Casper's
  own verification commands use the Windows shell.
