# Casper — next-session handoff

## Resume here — release path fixed, eval variance sample, platform-neutral fixtures

### What this increment did

The user's items 4, 2 and 3, in that order. Everything below was verified on macOS;
the Windows/Linux host runs are still outstanding.

**1. The documented one-liner could not resolve.** `docs/RELEASE.md` and the README
tell the maintainer to upload `dist/release/*` and then verify
`curl -fsSL <host>/install.sh | sh`, but `build:release` wrote only the binaries,
`SHA256SUMS` and `VERSION` there — the installers live in `scripts/`, so `<base>/install.sh`
was a 404 after following the runbook. Both defects here were found by **running the
documented publish flow** rather than reading it; neither was visible to the installer
tests, because those drive `scripts/install.sh` directly and never a served directory.
`scripts/build-release.ts` now copies
`install.sh` (0755) and `install.ps1` (0644) into `dist/release/`, so one upload makes
the directory self-contained; the copies are byte-identical to `scripts/` and are
deliberately **not** in `SHA256SUMS` (the sums file is what the installer checks its
download against). Docs now say: upload every file, and edit `scripts/` then rebuild —
never the copies.

**2. A rejected `--version` pin installed the binary anyway.** `install.sh` ran
`install -m 755` first and checked the reported version afterwards, so
`CASPER_VERSION=9.9.9` against a 0.1.0 artifact replaced the target with 0.1.0 and *then*
exited 1 — a failing command that silently changed the installation, contradicting both
"nothing is installed" (README) and "a failed install leaves the previous binary in
place" (RELEASE.md). The artifact is now staged inside the install directory
(`.casper-download.<pid>`), run there for `--version`, and only then renamed over the
target: a rejected pin or a binary that cannot run leaves an existing install
byte-identical, the staged file is removed on every exit path (including signals), and
the final rename cannot leave a half-written `casper`. `install.ps1` got the same
staged-move contract (`.casper-download.exe`), unvalidated as always.

`tests/release-install.test.ts`'s pin test now asserts the rejected pin installs
nothing and leaves no staged file — the assertion whose absence let defect 2 through.

**3. The publish step itself is now proven.** `bun run build:release -- --all` (never
run before) cross-compiles all five artifacts on this host — Bun fetches the target
runtimes on first use — and the served directory was then verified against the full
set: every digest matches `SHA256SUMS`, the name `install.ps1` fetches is in it, the
Linux artifacts are refused as unrunnable on this host *after* the checksum gate
(which proves their published digests resolve), and `casper-darwin-x64` installs and
runs here through Rosetta. Docs now state that the directory is rebuilt from scratch,
so a host-only build leaves one artifact and publishing needs `--all`.

**4. Evaluation: a second sample, for variance.** One repeat run of the nine tasks
(`/tmp/eval-repeat1.json`) — the user approved the provider spend. Same outcome
(9/9, the same ten touched files, same per-task counts) and different cost: 45 model
responses vs 42, 184,503 tokens vs 174,760, **239.2 s vs 152.1 s wall clock** (almost
all of it `add-api-endpoint`, 15.7 s → 78.4 s). Recorded in
[EVALUATION.md](EVALUATION.md#second-sample-variance) with the deltas: outcome columns
are findings, cost columns are ranges.

**5. Windows/Linux fixtures: a check command no longer needs a shell.** Casper runs a
configured check through the platform shell, so a fixture whose check was
`printf x >> test-runs; grep -qx good src/value` could only run where a POSIX shell
exists. Two new test-support files replace that: `tests/fixtures/check-script.ts` (a
documented action vocabulary — `append`, `write`, `mkdir`, `touch`, `remove`,
`require`, `forbid`, `require-line`, `stdout`, `stderr`, `cwd`, `pad`, `sleep`,
`wait`, `fail`, `on-failure`, `exit`) and `tests/support/check-command.ts`
(`checkCommand(...actions)` → `"<runtime>" "<script>" <actions…>`, no redirection,
globbing or quoting, so the same string parses as argv in `sh` and `cmd.exe`). Five
suites converted, each verified on macOS with identical pass and assertion counts:

| Suite | Tests | `posixOnly` before → after | Still gated because |
| --- | --- | --- | --- |
| `phase3-verification` | 12 pass / 74 assertions | 7 → 0 | — |
| `work-driven-checks.integration` | 41 pass / 312 assertions | 30 → 2 | signal termination; cancellation with `& wait` |
| `phase3-app.integration` | 27 pass / 165 assertions | 23 → 8 | process group, TERM-resistant descendant, two tests that match the configured command against model-reported `tool_end` text |
| `coding-loop-evidence` | 12 pass / 66 assertions | 8 → 3 | two `/dev/null` links, `mkfifo` |
| `phase8-pi.integration` | 34 pass / 259 assertions | 6 → 4 (+2 `skipIf` clauses) | native commands the product parses for paths (`rm`, `ln -s`, `test -f … && rm …`, `kill -TERM $$`) |

Declarations and assertions are unchanged in all five (checked against the pre-edit
counts and `HEAD`), no test was deleted, and no assertion was relaxed: where a test
quoted a fixture command it now compares against the same generated value.

**6. Unmasked Windows failures found while doing 5.** The suite had tests that
executed POSIX utilities or asserted POSIX modes with no gate at all, so a Windows run
would have reported them as product defects:

- Executed `true` in `coding-loop-evidence` (2 sites) and `work-driven-checks` (a
  config mutation), plus `true`/`false` in `phase3-verification`'s frozen-command
  test. Windows has no `true`; all now use `checkCommand()`.
- POSIX mode assertions in `phase9-learn`, `phase9-memory`, `phase10-browser`
  (`0o600`/`0o700`) and `model-selection` (a `chmod 0o500` premise). New probed
  capability in `tests/support/platform.ts`: `posixModes` (the mode is reported back
  *and* enforced; false on Windows and as root) and `needsPosixModes`; the
  single-assertion cases use `posixModes`, the mode-premise test is gated.
- `tests/release-install.test.ts` drove the POSIX installer and a `#!/bin/sh` stand-in
  artifact with no gate at all — every case is now `posixOnly`, with a comment that the
  Windows installer has no test because it needs PowerShell.

Typecheck clean, `git diff --check` clean.

### Evidence

- **Gate: 530 pass / 0 fail / 3,523 assertions, 46 files, 287.56 s, exit 0**
  (`/tmp/casper-gate-release/gate4.log`). Same env as documented above:
  `TERM=xterm-256color`, an existing isolated `HOME`/`TMPDIR`, `CASPER_TEST_DEBUGPY` +
  `CASPER_TEST_PYTHON`, run serially. **530 tests and 3,523 assertions are identical to
  the pre-rewrite gate**, which is the point: the conversions changed how a fixture's
  check runs, not what it asserts. Wall clock went 261.22 s → 287.56 s (~10%): a fixture
  check now starts the runtime instead of a shell builtin, so each check costs tens of
  milliseconds more. That is the price of the portability, and it is the only measurable
  cost.
- **A load-contaminated gate is not a gate.** A run started immediately after cancelling
  another one failed `model-selection`'s PTY picker test and
  `phase5-lsp-stress`'s diagnostic-batch test (528/2, 307.53 s, exit 1,
  `/tmp/casper-gate-release/gate3.log`). Both files pass alone with the same environment
  (25/25 and 8/8; the LSP test took 1.1 s alone against 2.2 s in the failing run), and
  the next quiet run was green. Run gates one at a time and let the previous one's
  processes exit.
- **The five converted suites, each run on its own** (macOS, serial): `phase3-verification`
  12 pass / 74 assertions; `work-driven-checks.integration` 41 / 312;
  `phase3-app.integration` 27 / 165; `coding-loop-evidence` 12 / 66;
  `phase8-pi.integration` 34 / 259. Pass and assertion counts match the pre-edit runs
  recorded by each converter, and declaration counts match `HEAD` — no test was added,
  dropped or relaxed.
- **The mode-gated suites**: `phase9-memory` 14 / 177, `phase9-learn` 49 / 324,
  `model-selection` 25 / 187, all pass; `posixModes` probes `true` on this host
  (`bun -e 'import("./tests/support/platform.ts")'` → `posixModes = true`).
- **The published directory verified end to end against the real artifacts**:
  `bun run build:release -- --all` produced all five (`casper-darwin-arm64` sha256
  `e93cccda…` — unchanged across every rebuild here), `dist/release` served over
  `python3 -m http.server`, then 33 checks (`/tmp/casper-release-verify/verify.sh`),
  all pass: every published file answers 200; the documented
  `curl -fsSL $CASPER_BASE_URL/install.sh | sh` shape installs into an isolated `HOME`
  and reports `Installed casper 0.1.0`; re-running it replaces in place; `file://` and
  local-directory base URLs install; `CASPER_VERSION=0.1.0` installs while `9.9.9` exits
  1 leaving the existing binary byte-identical and no staged file; a tampered artifact
  and a missing `SHA256SUMS` both refuse and install nothing; an out-of-band
  `CASPER_SHA256` installs; a Windows host is routed to the `install.ps1` hint; unknown
  OS/architecture are refused; all four POSIX `--print-target` names match the published
  artifacts; every digest in `SHA256SUMS` matches its file; the Linux artifacts are
  refused as unrunnable *after* the digest gate (which is what proves their published
  digests resolve) and install nothing; `casper-darwin-x64` installs and runs here
  through Rosetta; a development symlink is refused and preserved, and `--force`
  replaces it.
- **A stale build product nearly hid defect 2's fix**: `dist/release/install.sh` is a
  copy, so an installer fix needs `bun run build:release` before the served-directory
  check is meaningful. The re-run above is post-rebuild and `cmp` confirms both copies
  match `scripts/`.
- **Evaluation repeat**: 9/9 tasks, 45 model responses, 184,503 tokens (157,630 cache
  reads), 239.2 s wall clock, 10 files touched, 0 repair attempts, exit 0
  (`/tmp/eval-repeat1.json`).

### Next work, in order

1. **Validate Windows and Linux on real hosts** (the user's step): run
   [PLATFORM_VERIFICATION.md](PLATFORM_VERIFICATION.md) and send the output. Any probe
   FAIL is a product defect to fix before the platform table changes. The converted
   fixtures have never run there, so a Windows-only failure inside one is a *fixture*
   defect to fix on that host — the file it comes from says which.
2. **Publish** (needs the release host): set `CASPER_BASE_URL` in `scripts/install.sh`
   and `scripts/install.ps1`, `bun run build:release -- --all`, upload **every file** in
   `dist/release/`, then verify `curl -fsSL <host>/install.sh | sh` on a clean machine.
   `--all` and the served directory are now proven on macOS; what is not is a real host,
   a machine without this checkout, and `install.ps1` — its first Windows run is a test.
   Signing/notarization is separate work with its own credentials.
3. **Restore the remaining Windows coverage** — POSIX by subject, and each needing a
   Windows host to write and verify: Python 3 PTY fixtures, `mkfifo`, symlink
   privilege, mode bits, process groups/signals, the POSIX installer, and the native
   commands the product parses as text. The per-suite table in the runbook is current.
4. **Optional, each with its own trigger**: LLDB adapter validation, real HPE profile
   deployment acceptance (Phase 4 pending), SDK/RPC (needs a concrete workflow),
   collaboration/remote (needs an auth design), interactive MindMesh, writing subagents.
5. **Checkpointing**: the tree is committed and clean — the checkpoint commit on `main`
   (`git log --oneline -1`), authored `Choaterboater <stephen.choate@choatelabs.com>` as
   a one-off; the repo-local identity is still `secure-ssid`. Nothing is pushed, and
   push needs explicit permission. 286 MB of `.…-00000000.bun-build` junk at the repo
   root was deleted and `*.bun-build`/`.scratch/` are ignored; `dist/release/` holds all
   five artifacts plus both installers, `SHA256SUMS` and `VERSION`, so publishing needs
   no rebuild.

### Limits and preservation

No Windows or Linux host run exists; Windows behavior rests on simulated process tables
plus the shared POSIX suite. The rewritten fixtures are platform-neutral **by
construction** — no shell syntax in a check command — but they have only ever run on
macOS, so they are not Windows-validated either. `install.ps1` remains statically
reviewed only — it is now also unvalidated in its staged-move form, while its
`install.sh` twin is verified on macOS. The served-directory verification is local:
`CASPER_BASE_URL` still holds the `https://github.com/OWNER/casper/releases/latest/download`
placeholder, no release host exists, and the one-liner has never run from a machine
without this checkout. The evaluation suite has two recorded samples, one provider and
one model, and no provider matrix; its read-only task is graded by keywords, and one
fixture (`repair-type-error`) has no in-fixture typecheck by design. Process discovery
stays bounded and non-atomic; consent is not confinement. No commits/pushes, dependency
installs, personal credential operations or CasperCloud changes occurred; the one
network fetch was Bun's cross-compile runtimes, approved by the user. The tree is
committed (checkpoint commit on `main`, based on `d6e2483`) and clean; saved acceptance
evidence, `docs/benchmarks/` material and unrelated running processes are preserved.

## Prior checkpoint — suite hygiene, evaluation suite + baseline, install path

### What this increment did

Both are items 2 and 3 of the previous handoff's ordered next-work list.

**1. Windows/Linux test-suite hygiene.** `tests/support/platform.ts` is now the one
place that decides whether a fixture can run on this host: `posixOnly`,
`needsSymlinks` (probed once at import), `needsFifos`, `posixSymlinks`. POSIX-only
fixtures skip with a stated reason instead of failing, and the old whole-test
`if (process.platform === "win32") return;` guards became visible skips instead of
silent passes. 22 test files converted; POSIX assertions are unchanged and no test
was removed or weakened. The per-suite table of what is still POSIX-only on Windows
is in [PLATFORM_VERIFICATION.md](PLATFORM_VERIFICATION.md); skipped is not
validated, and restoring that coverage needs fixtures rewritten and verified on a
Windows host.

**2. Evaluation suite (master plan §48 — the last v1-credibility item).** `evals/`
holds six dependency-free fixture repositories (each a *solved* baseline), six setup
overlays that create a task's unsolved state, a nine-task catalog covering all nine
§48 task shapes, and the runner: prepare → run Casper → measure → verify
independently → grade. Measured per task: task success, independent verification
success, model responses, files touched, repair attempts, tokens/context and wall
clock. `bun tools/eval.ts` runs it; `tests/eval-suite.test.ts` validates the harness
without a model (catalog, fixture/setup matrix, measurement, grading). Contract,
metrics, grading rules, deliberate §48 deviations and limits:
[EVALUATION.md](EVALUATION.md).

### Review corrections (same increment)

A review pass over this increment found and fixed real defects rather than leaving
them for later:

- **The evaluation runner instrumented the runtime only when a test injected a
  factory**, so a real CLI run reported `0` model responses and captured no answer
  at all — `find-bug-without-editing`'s keyword grading could never pass from the
  CLI. Instrumentation is now unconditional (`createInstrumentedRuntime`), so real
  and scripted runs report the same numbers.
- **A run that produced no task result reported `execution: completed`.** It is now
  `error` with the reason recorded.
- **Task success no longer passes without a model response**: an
  `assistant_response_start` count of at least one is part of the definition, and
  the report says "no model response was recorded". A test asserts it.
- **Two guards were misclassified**: `coding-loop-evidence` tests that link
  `/dev/null` are POSIX-only, not merely symlink-dependent, and would have run on a
  Windows host that permits symlinks.
- **`needsFifos` duplicated `posixOnly`'s condition**; it is now a real `mkfifo`
  probe (alongside the symlink probe) through one `hostProbe`, so the skip reason is
  a measured host fact.
- **Harness cleanup is exception-safe**: a misconfigured verification command no
  longer leaks the work directory or the temporary home.
- **Symlinks are measured**: they count as touched paths, hash by target string, are
  never followed, and a fixture containing one fails loudly instead of being
  silently dropped by the copy.
- **Hashing is streamed and text scans read each file once**, so a large
  model-created file cannot balloon harness memory; dead exports were trimmed.

### Install and release (same session, after the baseline)

Casper now has the Codex/OMP install shape the user asked for: one line per platform,
update by re-running, and no Bun or checkout needed on the target machine.

- `scripts/build-release.ts` (`bun run build:release [-- --all|--target <t>]`) compiles
  a self-contained binary per platform into `dist/release/` plus `SHA256SUMS` and
  `VERSION`, and fails on version drift between `package.json` and `src/version.ts`.
- `scripts/install.sh` (macOS/Linux) and `scripts/install.ps1` (Windows) download the
  right artifact, **verify SHA-256 or refuse to install**, install to
  `~/.local/bin/casper` (`%LOCALAPPDATA%\Programs\casper`), clear the macOS quarantine
  flag, protect an existing development symlink unless `--force`, and prove the result
  with `casper --version`. `CASPER_BASE_URL` accepts an http(s) URL, `file://` or a
  local directory, so offline/internal installs work today.
- New `casper --version` / `-v` (the version lives in `src/version.ts`, because a
  compiled binary cannot read `package.json`).
- Contract, artifact matrix, publishing steps and limits: [RELEASE.md](RELEASE.md).

**Verified end to end on macOS, with no release host:** `bun run build:release`
produced a 64.7 MB `casper-darwin-arm64`; a local HTTP server served `dist/release`;
`CASPER_BASE_URL=http://127.0.0.1:8731 sh scripts/install.sh --dir …` downloaded,
verified, installed and reported `Installed casper 0.1.0`; the installed binary ran
`--version`, `--help` and `/status` from an isolated HOME; a tampered artifact failed
closed (`Checksum mismatch …`, exit 1, nothing installed).
`tests/release-install.test.ts` (7 tests) covers installer behavior without a
compiler: artifact-name agreement with the release build, verified install,
checksum-mismatch refusal, missing-digest refusal, out-of-band digest plus version
pinning, development-symlink protection, unsupported-platform reporting.

**Not done, by design:** nothing is published, `<release-host>` is still a placeholder
(`CASPER_BASE_URL` is the single constant to set), binaries are unsigned, and
`install.ps1` has never run on Windows — the validating host has no PowerShell either,
so it is statically reviewed only (three issues found and fixed: 32-bit-shell
architecture detection, temp-directory creation inside the cleanup `try`, and a named
error when `casper.exe` is still running).

### Two-axis review (same session)

`/code-review` at `d6e2483` — which **equals HEAD**, so the review target was the
uncommitted tree, scoped to this session's increments (the tree also holds earlier
sessions' work, each already carrying its own review doc). Run as two parallel
reviewer sub-agents, then aggregated without merging the axes.

- **Spec: no findings.** All nine §48 tasks and all seven measurements present;
  predicates grade the contract rather than the implementation; POSIX assertions
  unchanged; installers verify before installing; no claim of Windows validation that
  does not exist.
- **Standards: five findings, none confirmed hard.** One claimed hard breach was
  wrong (`pad` has eight lockstep call sites, which the no-tiny-functions rule
  explicitly allows); one was a false positive (`POSIX` is used as a value in three
  `test.skipIf` conditions). Two were real and are fixed below; one (import-time
  capability probes) is accepted by design.
- **Both axes missed a real bug, found while verifying their reports:** `src/cli.ts`
  matched flags with `args.includes(…)`, so a multi-word prompt containing `-v` or
  `--version` printed a version and silently discarded the prompt
  (`casper explain the -v flag` → `casper 0.1.0`). `--help` carried the same latent
  shape before this increment; adding a one-character flag widened the trigger set.

Fixes applied: flags are read only from a **leading** argument (`leadingFlag`, exported
as the argv policy's test seam, with a regression test asserting that `-v`,
`--version` and `--help` inside a prompt stay part of the prompt); the dead
`EvalAcceptance.exists`/`.missing` predicates deleted; `install.ps1`'s
flag-versus-environment asymmetry and its missing `--force` analogue documented
instead of implied; `-v` documented in help.

### Evidence

- TypeScript clean (`bun run typecheck`), `git diff --check` clean.
- **Gate after the review fixes and the netcalc cleanup: 530 pass / 0 fail / 3,521
  assertions, 46 files, 254.53 s, exit 0**
  (`/tmp/casper-hygiene-gate/final-clean.log`). Composition: 520 pre-existing tests,
  8 evaluation-suite, 7 installer, 1 flag-policy regression test.
- **The user's netcalc work was removed by the user**, which left `tests/netcalc/ip.test.ts`
  importing a module that no longer existed and `package.json`'s `netcalc` script
  pointing at a deleted file. Both leftovers were removed in this session at the user's
  confirmation (`rm -rf tests/netcalc`, script deleted); nothing else of their work was
  touched. Earlier gate numbers in this file that read 535 include those 6 netcalc tests
  — 535 − 6 + 1 flag-policy test = 530.
- **Gate caveat observed once, not reproduced:** a full gate that ran *concurrently*
  with another full gate failed `real installed debugpy: breakpoint, variables and
  exit cleanup` at the post-approval revalidation ("Debugger configuration or launch
  files changed during approval", 9.4 ms in). `resolveTarget` folds `mtimeMs`/`ctimeMs`
  of the adapter command (`/usr/bin/python3`), the program and breakpoint sources into
  its identity, so a host-side metadata change to a system binary during approval
  fails the launch **closed**. The same test passed in every solo run, including two
  concurrent runs of that file alone. Run gates serially (as documented) and, if it
  recurs, capture `stat /usr/bin/python3` before and after.
- `bun test` now scopes discovery to `tests/` (`bunfig.toml`), so the fixture test
  files under `evals/` never join Casper's own suite. **Consequence to know:** the
  website suite `web/tic-tac-toe/game.test.js` (5 tests / 1,944 assertions) is no
  longer swept in either — run it explicitly with
  `bun test ./web/tic-tac-toe/game.test.js`. That exclusion is why this gate's
  assertion total is lower than the previous handoff's 5,364 (5,364 = 520 tests'
  3,473 + the website's 1,944, with the difference from the previously skipped
  real-adapter tests).
- Platform probe on macOS: **8 pass / 0 fail / 1 skip**, exit 0 (unchanged).
- `bun tools/eval.ts --list` lists nine tasks. **Recorded baseline (2026-09-21,
  github-copilot / `claude-fable-5`, macOS arm64): 9/9 tasks, 42 model responses,
  174,760 tokens (152,238 cache reads), 152.1 s wall clock, 10 files touched, 0
  repair attempts** (`/tmp/eval-baseline2.json`; full table in
  [EVALUATION.md](EVALUATION.md)). The first run scored 8/9 and the single failure
  was a **harness predicate**, not a model failure: `add-api-endpoint` demanded
  `src/health.ts` while the model implemented the endpoint inline in `src/app.ts`
  with the contract test passing. The over-specified predicate was removed, and the
  task then passed — fixture predicates must encode the contract, not the
  implementation. Three earlier incidental prompts (two smoke runs, one diagnostic)
  also reached the provider before the instrumentation defect was found; those runs
  are not baseline evidence.
- Gate environment gotcha (unchanged): run gates with `TERM=xterm-256color`, an
  existing isolated `HOME`/`TMPDIR`, and `CASPER_TEST_DEBUGPY` plus
  `CASPER_TEST_PYTHON`. An unset/relocated `HOME` hides the discovered debugpy and
  skips the two real-adapter tests; a missing `TMPDIR` fails every fixture.

### Next work, in order

1. **Validate Windows and Linux on real hosts** (still the user's step): run
   [PLATFORM_VERIFICATION.md](PLATFORM_VERIFICATION.md) and send the output. Any
   probe FAIL is a product defect to fix before the platform table changes.
2. **Repeat the evaluation baseline for variance** (and, if useful, a second
   provider/model): `bun tools/eval.ts --json /tmp/eval.json`. One recorded run
   exists (9/9 — see Evidence); a distribution, not a single sample, is what the
   numbers are for, and further runs are a model/billing decision for the user.
3. **Restore Windows coverage** for the POSIX-only suites: rewrite those fixtures
   with platform-neutral commands (the runtime executable plus a fixture script
   instead of a POSIX shell pipeline) and verify on a Windows host. Do not guess
   `cmd.exe` semantics from macOS.
4. **Publish the install path** (needs your release host): `bun run build:release --
   --all`, upload `dist/release/*` to one directory, set `CASPER_BASE_URL` in
   `scripts/install.sh` / `scripts/install.ps1`, then verify
   `curl -fsSL <host>/install.sh | sh` on a clean machine. First Windows run of
   `install.ps1` is a test — it has never executed there. Signing/notarization is
   separate work with its own credentials.
5. **Optional, each with its own trigger**: LLDB adapter validation, real HPE
   profile deployment acceptance (Phase 4 pending), SDK/RPC (needs a concrete
   workflow), collaboration/remote (needs an auth design), interactive MindMesh,
   writing subagents.
6. **Checkpointing**: still a large dirty tree with no commits since `d6e2483`;
   commits and pushes need explicit permission. The install artifacts are already
   built and waiting in `dist/release/` (gitignored), so publishing needs no rebuild.

### Limits and preservation

No Windows or Linux host run exists; Windows behavior rests on simulated process
tables plus the shared POSIX suite. The evaluation suite has **one recorded baseline
run** (9/9, Evidence above) and three earlier incidental prompts that under-reported
model calls because of the instrumentation defect since fixed; there is no provider
matrix and no variance study, so the numbers are a starting point, not a
distribution. Its read-only task is graded by keywords, and one fixture
(`repair-type-error`) has no in-fixture typecheck by design. Process discovery stays
bounded and non-atomic; consent is not confinement. No commits/pushes, dependency
installs, personal credential operations or CasperCloud changes occurred. HEAD
remains `d6e24836c1509188f3e298e8ca4caeb134cd031b`; the dirty-tree baseline, the
user's website work, saved acceptance evidence, `docs/benchmarks/` material and
unrelated running processes are preserved.

## Prior checkpoint — cross-platform platform layer; Phase 10 closed as scoped

### Phase 10 status

**Phase 10 is complete for its scoped deliverable, and the documents say so
explicitly.** `docs/PHASE10_SPEC.md`: "Together they complete the scoped Phase 10
debugging work; optional clients are not prerequisites." `docs/PHASE10_PLAN.md`:
"Generic SDK/RPC and conditional collaboration remain optional; they are not invented
completion prerequisites." Master plan §40 Phase 10: the remaining roadmap "is **not**
an acceptance checklist requiring additional clients before completion."

- Delivered: browser-first 10A (disposable real browser, owned dev servers, consent,
  replay assertions) and the local DAP debugger (consent-revalidated launch, bounded
  inspection, owned-tree cleanup, corrected post-launch cancellation race).
- Excluded by the spec, not missing: DAP attach/evaluate/stepping, SDK/RPC,
  collaboration/remote, authenticated personal browser sessions, aesthetic
  acceptance, browser/adapter installation.
- Not certified inside Phase 10: adapters beyond debugpy (LLDB probe stalled; no
  adapter installed), Windows/Linux host runs, independent review (same-agent only),
  and non-atomic process discovery.

### Current increment — one Casper-owned platform layer (macOS/Linux/Windows)

The user corrected the platform scope: Casper targets **macOS, Linux and Windows**,
must behave like OMP where that matters, and stays its own implementation (no OMP or
`pi-*` code, no new dependency, no fork). Contract:
[PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md); host runbook:
[PLATFORM_VERIFICATION.md](PLATFORM_VERIFICATION.md).

- New `src/platform/processes.ts` owns every spawned process tree. POSIX keeps `ps`
  parentage and process-group signalling; Windows, which has no process groups, lists
  the table through PowerShell `Get-CimInstance Win32_Process` (legacy `wmic`
  fallback) and terminates only records whose creation stamp still matches, children
  first and root last. A reused PID is never treated as owned, an untrustworthy
  listing fails closed as **unknown**, and existing budgets/deadlines are unchanged.
  `src/debug/processes.ts` was replaced by this module; the debugger's consent,
  lifecycle and blocking semantics are untouched.
- New `src/platform/environment.ts` builds the allowlisted environment with a
  temporary user directory (POSIX `HOME`/`TMPDIR`; Windows `USERPROFILE`, `APPDATA`,
  `LOCALAPPDATA`, `TEMP`/`TMP` plus the loader variables Windows needs to start a
  process). Provider credentials are still never inherited.
- New `src/platform/files.ts` centralizes `O_NOFOLLOW`/`O_NONBLOCK`, which do not
  exist on Windows and previously produced `NaN` access flags there. POSIX keeps the
  atomic guarantees; Windows rejects a final symlink with an explicit pre-open
  `lstat`, documented as non-atomic. Converted: reference search, memory store, LSP
  configuration and workspace snapshot/rename, MCP configuration, debugger
  configuration, verification workspace state and the startup model preference.
- The debugger and both browser modules no longer refuse Windows. Browser discovery
  moved to `src/browser/discovery.ts` (macOS `/Applications`, Linux `/usr/bin` and
  `/snap/bin`, Windows `ProgramFiles`/`ProgramFiles(x86)`/`LOCALAPPDATA` Chrome and
  Edge) and is now directly testable.
- Verifier commands, LSP servers, MCP stdio servers, managed development servers and
  the launched browser all use the shared tree policy. POSIX behavior is unchanged;
  Windows terminates verified descendants instead of only the direct child.
- Diagram artifact files remain macOS/Linux only (POSIX `openat` through Bun FFI). On
  other platforms the router now degrades explicitly to in-conversation output and
  reports why, instead of failing the diagram request.
- New `bun tools/platform-report.ts`: self-checking host probe (no model, network or
  credentials) that exercises the real listing, spawns a root plus grandchild, owns
  and terminates the tree, proves an unrelated process survived, and checks the
  environment allowlist, state-file flags and browser discovery. macOS:
  **8 pass / 0 fail / 1 skip**, exit 0.

### Evidence

- Final isolated serial gate on the frozen tree: **525 pass / 0 fail / 5,364
  assertions**, 46 files, 249.39 s (log `/tmp/casper-xplat-final.KvGyZy/check.log`);
  a fresh gate on the current tree is recorded at the end of this section.
- All Phase 10 tests ran without skips against installed Chrome and installed
  debugpy 1.8.20. `tests/platform-processes.test.ts` (7 tests / 19 assertions) covers
  live POSIX group cleanup with an unrelated-process control, the simulated non-group
  platform (children-first ordering, reused-PID rejection, fail-closed `unknown`),
  grouped-ownership verification, environment allowlisting and final-symlink
  rejection.
- **Gate environment gotcha:** with `TERM=dumb` three `daily-terminal` tests fail
  (pre-existing fail-closed plain-mode behavior). Run gates with
  `TERM=xterm-256color`, isolated `HOME`/`TMPDIR`, and — for the real-adapter tests —
  `CASPER_TEST_DEBUGPY` plus `CASPER_TEST_PYTHON`.

### Next work, in order

**Items 2 and 3 below were completed in the increment above (test-suite hygiene and
the evaluation suite); this list is historical. Item 1 and item 5 still stand.**

1. **Validate Windows and Linux on real hosts** (the user can do this now): run
   [PLATFORM_VERIFICATION.md](PLATFORM_VERIFICATION.md) and send the output. Any probe
   FAIL is a product defect to fix before the platform table changes.
2. **Windows/Linux test-suite hygiene**: the full suite is not yet Windows-clean —
   POSIX-only PTY (`python3`), symlink/FIFO/`/dev/null` and POSIX-shell-command
   fixtures fail instead of skipping (`daily-terminal`, `phase3-app`,
   `phase3-verification`, `coding-loop-evidence`, `work-driven-checks`,
   `phase7-sessions`, `phase8-pi.integration`, `phase9-memory`, `model-selection`,
   `review-config`, `phase10-browser*`, `phase10-debugger-workspace`). Convert to
   explicit platform skips or platform-specific command variants without weakening
   POSIX assertions.
3. **Evaluation suite** (master plan §48, never built): fixture repositories plus
   measured tasks — task success, verification success, model calls, files touched,
   repair attempts, context tokens, wall-clock. Today there is one manual trial
   (`docs/acceptance/TRIAL_01.md`). This is the remaining v1-credibility item; the
   §42 v1 feature boundary itself is already implemented and gated.
4. **Optional, each with its own trigger**: LLDB adapter validation (would add a
   second real adapter on all three OSes), real HPE profile deployment acceptance
   (Phase 4 pending), SDK/RPC (needs a concrete workflow), collaboration/remote
   (needs an auth design), interactive MindMesh, writing subagents.
5. **Checkpointing**: 525 tests and a large dirty tree with no commits since
   `d6e2483`; the platform increment is self-contained and would make a clean
   checkpoint commit. Commits and pushes need explicit permission.

### Limits and preservation

No real Windows or Linux host run exists yet; Windows behavior rests on simulated
process tables plus the shared POSIX suite, so the PowerShell/wmic listing, Windows
signal semantics and Windows adapters/browsers are not host-validated. LLDB remains
unvalidated. Process discovery stays bounded and non-atomic; unobserved daemonized
descendants and PID-reuse races are not certified on any platform. Consent is not
confinement. No commits/pushes, dependency installs, personal credential operations,
live/paid model trials or CasperCloud changes occurred. HEAD remains
`d6e24836c1509188f3e298e8ca4caeb134cd031b`; the dirty-tree baseline, the user's
website/netcalc work, saved acceptance evidence, `docs/benchmarks/` material and the
unrelated running process are preserved.

**Fresh gate on the current tree (probe tool, browser-discovery extraction and the
new platform test guards included): 525 pass / 0 fail / 5,364 assertions, 46 files,
250.24 s test portion, TypeScript clean, 0 skips, exit 0. Log:
`/tmp/casper-handoff-gate.cIOARp/check.log`. Same counts as the frozen-tree gate
above, so the post-gate refactor is covered.

## Prior checkpoint — login and scoped Phase 10 debugging complete

The user's “continue finish 10” request is completed for Casper's browser and
local-debugger scope. Read [DEBUGGER.md](DEBUGGER.md) and
[PHASE10_DEBUGGER_REVIEW.md](PHASE10_DEBUGGER_REVIEW.md) for the implemented contract,
research, test/review evidence and limits. CasperCloud is **reference material only**,
not a required client or integration. Generic SDK/RPC and collaboration remain
optional future ideas, not blocked acceptance tasks.

- Lazy `/debug` metadata and `.casper/debug.json`; fresh exact launch consent,
  revalidated config/files, stdio adapter, temporary HOME and allowlisted environment.
- Source breakpoints, threads, stack, scopes, variables, continue and stop; bounded
  escaped output, stop-scoped opaque handles, no evaluate/attach/reverse execution.
- Real installed **debugpy 1.8.20** passes breakpoint/value, normal-exit, explicit-stop
  and adapter-crash tests. LLDB initialization worked but launch stalled in a probe;
  LLDB is **not validated support**. No adapter was installed.
- OS-parentage-based process ownership handles separately grouped debuggees without
  trusting adapter-reported PIDs. Unconfirmed cleanup blocks new work. POSIX discovery
  is non-atomic; unobserved daemonized descendants and Windows are not certified.
- Active-command cancellation, EOF/SIGTERM, workspace/conversation changes and model
  work revoke debugging. `/debug stop` is the explicit idle-editor stop. Debug values
  stay out of automatic model context, receipts and memory; they are not verification.
- The first full gate exposed an immediate-post-launch cancellation race. Shutdown
  reused an old pre-launch process snapshot before disconnect orphaned the child.
  A fresh pre-disconnect snapshot corrected it; 160 repeated cancellation launches
  passed afterward (80 without tracing), plus final complete-suite repeats.
- An isolated copied-source fault probe removing SIGKILL correctly failed its
  surviving-debuggee assertion; fixture teardown removed its own child.

Final isolated serial gate: **518 pass / 0 fail / 5,345 assertions**, **45 files**,
**251.47 s**, TypeScript clean. All **38 Phase 10 tests** ran without skips, using
installed Chrome/debugpy. Log: `/tmp/casper-phase10-final.p1CBnq/check.log`.
Two final debugger repeats: **18 pass / 117 assertions** each, 23.04 s and 22.53 s,
under `/tmp/casper-dap-research/release-repeat-{1,2}.log`. Same-agent Standards/Spec
reviews have no blocking findings; independent sign-off remains unavailable.

HEAD remains `d6e24836c1509188f3e298e8ca4caeb134cd031b`; no repository commit/push,
dependency installation, personal credential operation or live/paid model trial.
The dirty-tree baseline is preserved. New debugger implementation/tests, shared
byte framing and scoped app/help/docs are the only changes in this increment;
login/browser implementation and dependency files remain unchanged. Existing
unrelated Bun PID 56873 was preserved. Do not treat historical checkpoints below
as a current DAP gap or permission to change CasperCloud.

**Next:** superseded by the cross-platform checkpoint above; the permission limits
below still stand. Commits/pushes, installs, personal credentials and live/paid
model trials still need separate permission.

## Prior checkpoint — four-provider login complete

The user approved the complete multi-provider proposal, including browser OAuth,
then asked to “loop until done then finish phase 10.” Login implementation and
same-agent Standards/Spec review are complete. Read
[MULTI_PROVIDER_LOGIN_REVIEW.md](MULTI_PROVIDER_LOGIN_REVIEW.md) and
[MULTI_PROVIDER_LOGIN_RESEARCH.md](MULTI_PROVIDER_LOGIN_RESEARCH.md).

- `/login`: Codex/Copilot device code, Anthropic/Claude and OpenRouter API-key or
  browser sign-in. Exact provider shortcuts skip only the provider chooser.
- Private masked key/callback entry, no chat/history/diagnostic secret echo, fresh
  provider/method consent, manual browser opening, loopback-only callbacks and
  existing shared provider-scoped storage. No automatic model/default change.
- Copilot account-policy enablement, Claude extra-usage billing and OpenRouter
  permanent-key/credit billing are disclosed. Cancellation cannot undo remote effects.
- Actual pinned provider paths use synthetic transport; real PTYs and loopback
  callbacks cover input/lifecycle. No personal login or live provider trial occurred.
- New regressions corrected oversized unfinished-paste hangs and selector-transition
  cancellation classification. Existing active-parent stale-auth behavior remains.

Final isolated serial gate: **500 pass / 0 fail / 5,228 assertions**, 41 files,
**236.60 s**, TypeScript clean. Log:
`/tmp/casper-multi-login-final.57YkDB/check.log`.
Two focused repeats: **18 pass / 155 assertions** each. Independent review was
unavailable. No dependencies installed, commits/pushes, credential migration or
personal credential operations. HEAD remains `d6e24836c1509188f3e298e8ca4caeb134cd031b`.
Preserve all unrelated dirty work; pre-edit hash audit confirmed only scoped files
changed during this increment.

**Latest user correction:** CasperCloud is a reference project only, not a client
or integration deliverable. Inspect/reuse useful ideas or code where justified;
do not change CasperCloud or make its integration a Casper completion requirement.
The previous response incorrectly promoted an old roadmap assumption into a
requirement and stopped on it. That was an agent scoping mistake, not a blocker.

**Historical outstanding request (now fulfilled above):** finish Phase 10 after
login; that authorization stood. All 20 browser-first Phase 10A tests were revalidated against installed
Chrome, and that concrete slice was complete. DAP/breakpoint debugging was then
unimplemented. Assess remaining Casper requirements without inventing an external
client dependency or reopening completed browser tickets. Generic SDK/RPC and
collaboration are optional roadmap ideas, not CasperCloud obligations. No arbitrary
dependency installation, public listener, personal account access or paid/live
trial is authorized.

## Prior checkpoint — daily-use terminal implemented and validated

The user prioritized a usable coding interface over DAP/new clients and authorized
completion without further approval rounds. Normal model selection now remembers
a global Casper startup default; Ctrl+S or `/model --session` is the explicit
session-only choice. `/effort` exposes supported reasoning levels. Pi's main-screen
editor supplies multiline/history and fuzzy slash/file completion, with a persistent
footer and exclusive picker/confirmation ownership. No alternate-screen takeover.

New controls: `/context`, `/usage`, explicit model-assisted `/compact`, `/clear`,
`/resume [exact-id]`, bounded `/diff` and descriptive `/permissions`. Existing
verification, browser, skills, MCP/LSP and named-workspace lifecycles remain intact.
No new permission presets, enforced modes, undo, queue or automatic shell shortcut
is implied. Saved defaults are a startup snapshot until the runtime is active;
unknown context/cost is not guessed. `/status` refreshes the branch snapshot.

Current contract: [TERMINAL_UX.md](TERMINAL_UX.md).
Spec: [TERMINAL_UX_SPEC.md](TERMINAL_UX_SPEC.md).
Review/evidence: [DAILY_TERMINAL_REVIEW.md](DAILY_TERMINAL_REVIEW.md).
Offline synthetic UI demo: `bun tools/terminal-demo.ts` (no model or settings writes).
Local tickets: `.scratch/terminal-ux/issues/`; domain language: `CONTEXT.md`.

Latest isolated serial gate: **491 pass / 0 fail / 5,121 assertions**, 41 files,
**203.42 s**, TypeScript clean. Log:
`/tmp/casper-terminal-complete.FFhpap/check.log`.
Real PTYs cover editor, model/effort, login, fresh approval and resize. A local
synthetic provider proves compaction persistence and active/preflight cancellation.
Same-agent Standards/Spec review only; independent review was unavailable.

No live/paid models, personal credential changes, new dependency installation,
commits or pushes. HEAD is still `d6e24836c1509188f3e298e8ca4caeb134cd031b`.
Preserve unrelated dirty work. The sample website was only a smoke test, not an
ongoing workstream. Next work should follow actual daily-use feedback; DAP and
SDK/RPC are not automatic next prerequisites.

### Historical requested direction — multi-provider login like OMP (completed above)

The user wants provider login/setup to feel similar to OMP, rather than remaining
Codex-only. Inspect OMP's actual current provider chooser and authentication flows,
and the pinned Pi SDK's supported provider authentication APIs, before proposing
the implementation. Target one discoverable `/login` provider chooser covering
OpenAI Codex, GitHub Copilot, Anthropic/Claude and OpenRouter where supported.
Use each provider's supported method: OAuth/device flow or API-key setup, not a
fictional universal OAuth flow. Keep credentials out of chat/transcripts and retain
Casper's consent, cancellation and exclusive terminal-input ownership. Reuse Pi's
provider/auth machinery; do not add OMP as a runtime dependency or copy its whole UI.
The OMP-like direction is requested; exact provider coverage and implementation
scope still need confirmation after inspection. No personal credential operations
or live/paid provider trials have been authorized.

## Prior completed scope — browser-first Phase 10A

The user authorized exact `puppeteer-core@25.11.0` after the temporary comparison.
Casper now has disposable installed-browser inspection, synthetic interaction
consent, task-owned dev servers, immutable behavior/layout replay, scoped freshness
and separate browser task receipts. Native `read` delivers screenshots to Pi as
actual image content. Read [BROWSER.md](BROWSER.md), [PHASE10_SPEC.md](PHASE10_SPEC.md)
and [PHASE10_REVIEW.md](PHASE10_REVIEW.md) before changing this contract.

Latest isolated serial full gate: **481 passed / 0 failed / 5,068 assertions**,
40 files, **188.36 s**, TypeScript clean. Log:
`/tmp/casper-phase10-complete.F0oAvy/check.log`. All 20 Phase 10 tests ran here
with installed Chrome available (99 assertions); missing browser availability elsewhere is
an explicit skip, not browser acceptance. Review corrected multiline fill, crash
invalidation, post-escaping output bounds, ordinary-error suppression and prior-task
receipt leakage. No independent reviewer was available.

All four browser-first local tickets are complete, including the combined
active-real-browser/worktree-transition test with positive process controls.
Tickets are in `.scratch/browser-debugging/issues/`. DAP, richer clients,
aesthetic acceptance and authenticated browser sessions remain deferred.

No live/paid model, browser download, personal credential operation, commit or push
was used. HEAD remains `d6e24836c1509188f3e298e8ca4caeb134cd031b`. Preserve the broad
dirty tree and unrelated local processes. The user's sample website was only a
smoke test, not a product requirement or ongoing workstream; do not keep elevating
it in status reports. Current browser permissions are behavioral, not a sandbox;
input freshness cannot certify the served build or external state.

The Phase 9 re-review correction preceded this work and passed **461 / 4,969**;
the older Phase 9 totals below are historical, not the current gate.

## Prior completed scope — Phase 9 implementation, gate and documentation

Phase 9 now includes explicit facts/outcomes, local reference search, bounded
candidate generation, and digest-bound human promotion. The new local command is:

```text
casper learn promote <repo> <draft-id> <draft-sha256> <candidate-number> \
  <reference|project-skill|global-skill|ignore> [skill-name]
```

Promotion starts no Pi runtime/provider call. It requires exact human-supplied
identity and disposition, preserves original drafts, records one separately
inspectable immutable decision per candidate, and never replaces an existing
destination. Exact replay is idempotent. References activate through reserved
source `casper-promoted`; project skills live in matching per-project Casper state;
global skills live in user state; ignore creates no artifact. Committed staging
can be recovered only by exact replay with matching recorded bytes. Corrupt,
inconsistent, redirected, collided or changed state fails closed.

Final isolated Phase 9 suites: **85 tests / 650 assertions**. Final serial full
gate: TypeScript clean, **459 tests / 4,959 assertions** across 36 files, 157.44 s
test portion. `git diff --check` passed. The full gate includes unrelated user
netcalc/website work but the review remained Phase 9-scoped. Standards pass: 0
findings. Spec pass: 0 findings. No independent review sub-agent was available;
[PHASE9_REVIEW.md](PHASE9_REVIEW.md) records that limitation and both same-agent
passes. Read [LEARNING.md](LEARNING.md), [REFERENCES.md](REFERENCES.md), and
[PHASE9_IMPLEMENTATION.md](PHASE9_IMPLEMENTATION.md) before changing the contract.

No live/paid model call, external reference scan, personal credential operation,
commit, push or Phase 10 work occurred. The running tic-tac-toe server was
preserved. HEAD remains `d6e2483`; the broad working tree still contains unrelated
modified/untracked work. Agree a separately scoped issue before further edits.

## Prior completed scope — Casper-owned `/login` implemented and validated offline

The user approved the bounded login plan and asked to complete it plus the next
three follow-ups before stopping. All four items are complete: implementation,
real-PTY input safety, active-parent refresh/stale-auth behavior, and isolated
validation/scoped review/documentation. Read [LOGIN_REVIEW.md](LOGIN_REVIEW.md)
for current evidence and [LOGIN_PLAN.md](LOGIN_PLAN.md) for the contract.

- Interactive `/login` now offers **OpenAI Codex device code** and Cancel;
  `/login openai-codex` skips only the chooser. Fresh consent discloses that only
  the `openai-codex` entry in resolved shared `<getAgentDir()>/auth.json` may be
  saved/replaced. Casper does not accept secrets or callbacks, open a browser,
  select a model, create an agent session, load extensions or migrate credentials.
- Plain/redirected/`TERM=dumb` invocations remain local guidance. Unsupported
  arguments are rejected safely. `PI_TUI_WRITE_LOG`, unsafe modes, symlinks and
  hardlinks fail before provider transport or auth mutation.
- The actual pinned Pi 0.85.1 Codex issuance/poll/exchange path is used. Tests
  intercept transport with synthetic responses; no live endpoint, browser,
  account, personal credential or model generation was used. URL/code display is
  allowlisted; raw provider diagnostics and credentials never cross the adapter.
- Escape/Ctrl-C/EOF/shutdown and pasted/unrelated input fail closed. Draft,
  cursor and history return after exclusive input. A PTY-discovered EOF hang was
  fixed by pausing lent stdin before readline closes or retakes ownership.
- Provider-scoped persistence preserves unrelated credentials. An active parent
  refreshes locally without changing model/default/conversation/branch. Committed
  but unsynchronized or uncertain affected auth is marked stale and blocked until
  refresh succeeds or restart; Casper does not blindly repeat login.

Final focused login: **9 tests / 48 assertions**, TypeScript clean. Three prior
clean repeats were also 9/48. Final shared terminal/model run: **24 tests / 172
assertions**. Isolated serial `bun run check`: **450 tests / 4,876 assertions**
across 36 files; 149.78 s test portion. The full working-tree inventory includes
the user's unrelated netcalc and website tests, so it is not a review of them.
A temporary test-only CLI export used in that full gate was removed in favor of
Bun preload; the final source shape and SIGTERM/preload PTY additions then passed
final TypeScript and focused login/terminal/model runs. `git diff --check` passed.

Scoped single-agent Standards review: 0 findings. Spec review: 0 findings. No
independent reviewer was available. The 192-file pre-edit manifest showed only
login-scoped source/docs/tests changed; the running tic-tac-toe server and all
unrelated netcalc, website, acceptance, benchmark, shutdown and planning work were
preserved. HEAD remains `d6e2483`; no commit or push.

**Next boundary:** this login slice and the requested three follow-ups are done.
Choose a separately scoped issue. Browser OAuth, API-key entry, logout/revocation,
credential migration, automatic browser opening, custom providers, live trials,
Windows validation, child/learning model defaults and Phase 9/10 promotion remain
outside scope. A real login/provider trial still needs separate permission.
Older “next” directions below are historical; do not reopen completed login or
shutdown work as though it were unfinished.

## Previous checkpoint — bounded verifier-shutdown diagnosis complete; correction uncommitted

The user authorized continuing the shutdown investigation until this bounded
phase was complete. The exact `leaked` assertion failure was reproduced through
the real CLI (4/200 cancellations) and minimized to the command runner. The
marker appeared milliseconds after SIGTERM: interrupted `sleep` could fall
through to unconditional `; touch leaked`. A controlled probe confirmed sleep
exit 143; changing only the marker separator from `;` to `&&` removed that false
signal. See [VERIFIER_SHUTDOWN_REVIEW.md](VERIFIER_SHUTDOWN_REVIEW.md) for causal
evidence, negative controls, review and limits.

- Corrected the three affected test commands without removing assertions or
  relaxing waits/deadlines. Added a real TERM-resistant descendant fixture,
  its positive control, and CLI checks for inherited/closed pipes, absent delayed
  work, and dead descendant PID/process group.
- Both descendant tests failed when isolated fault injection disabled group
  cleanup, and again when SIGKILL escalation was suppressed. Restoring the
  unchanged production runner made them pass. No production source was changed.
- Corrected stress loops: **200 CLI + 300 runner cancellations**, no marker
  failures. Final isolated serial `bun run check`: **430 tests / 2,865 assertions**,
  TypeScript clean; 33 files; 141.41 s test portion. Five additional focused runs:
  **6 tests / 39 assertions** each, all passed.
- Validation used committed `d6e2483` plus the four scoped test/fixture files,
  temporary HOME/TMPDIR, allowlisted environment and offline settings. It does
  **not** validate the unrelated website/netcalc test inventory.
- Only three existing test files, `tests/fixtures/verifier-descendant.ts`, the
  new shutdown review, README's testing note and this section changed. Unrelated
  work below is preserved. Detailed temporary evidence:
  `/tmp/casper-shutdown-diagnosis.dIat8c`.

**Next boundary:** this diagnosis/test correction is complete and uncommitted;
choose another separately scoped issue. HEAD remains `d6e2483` on `main`. Inspect
Git status and active writers before further edits. No user process was stopped;
the earlier Casper process was no longer present when applying the test-only
correction. Parallel testing stays opt-in. No push, provider trial, credentials
change, O4 application or Phase 9/10 promotion occurred. Review was single-agent.

This diagnoses a reproduced defect in the historical test's observation, not
every possible shutdown failure. Old logs lack event ordering; no claim of
atomic/side-effect-free cancellation or Windows validation is made. Statements
below that the cleanup flake is wholly undiagnosed are historical and superseded
by this section; independent Phase 9 review/promotion remain open.

## Previous checkpoint — local checkpoints committed; unrelated/newer work remains

The user authorized a local checkpoint and then the handoff. Two code commits
were created on `main`, without pushing:

| Commit | Scope | Exact committed-code validation |
| --- | --- | --- |
| `624088b` | Existing candidate-only learning, safety/config corrections, lazy capability loading, terminal UX and Casper-owned model selection, including picker diagnostic sanitization and opt-in test runner | **426 tests / 2,828 assertions**, TypeScript clean; 33 files; 139.57 s test portion |
| `254095c` | Separate slash-command/model-task paths and passive task observations, with app-level characterization and design/review docs | **427 tests / 2,843 assertions**, TypeScript clean; 33 files; 138.52 s test portion |

Each code tree was exported directly from its staged Git tree and checked serially
with a temporary HOME, an allowlisted environment and offline Pi settings. The
existing pinned `node_modules` was linked into each export; no install or dependency
change was made. This handoff and archived handoff history are recorded in a
subsequent documentation-only commit; use `git log -3 --oneline` for current HEAD.

The earlier **432 tests / 4,787 assertions** result included the five untracked
website tests. Those files were deliberately excluded from the code checkpoints.
The different counts are different test inventories, not weakened assertions.
Do not call either result a validation of newer work below.

### Still uncommitted — preserve and review separately

- `web/tic-tac-toe/`: all seven user website files, unchanged during checkpointing.
- **User's random Casper test:** `package.json` now adds a `netcalc` script,
  alongside `tools/netcalc/` and `tests/netcalc/`. These appeared while the checkpoint
  trees were being validated; the user confirmed they were just testing Casper.
  This output was not edited, staged, reviewed or tested in this checkpoint.
  Leave it separate; no deletion was requested. Check for an active writer before
  changing it or rerunning a full-tree gate.
- Existing unrelated plan edits: `docs/CASPER_COMPLETE_PLAN.md`,
  `docs/IMPLEMENTATION_PLAN.md`, `docs/PHASE3_VERIFICATION.md`.
- Local trial evidence: `docs/ACCEPTANCE_TRIAL.md`, `docs/acceptance/` (including
  the saved **unapplied** O4 candidate). No evidence was modified or candidate applied.
- Local optimization/benchmark material: `docs/DEBUG_OPTIMIZATION_REVIEW.md`,
  `docs/benchmarks/STARTUP_O2*`, `docs/benchmarks/STARTUP_O3*`, and
  `scripts/benchmark-startup.ts`. These remain outside the checkpoint, including
  any historical-document links to those local files.

Checkpoint preservation snapshot and exact-tree gate logs:
`/var/folders/yj/l1q2ypcj68qck8m_kcrdv26r0000gp/T/casper-checkpoint-ucx73n8x`.
Temporary evidence may disappear; the committed tests and scoped counts above do
not depend on those paths surviving.

**Next session:** read this section first, inspect `git status --short` and
`git log -3 --oneline`, and coordinate around the newer netcalc work. The bounded
app refactor and picker correction are complete; choose a separately scoped next
issue rather than continuing them indefinitely. Review details:
[APP_STRUCTURE_REVIEW.md](APP_STRUCTURE_REVIEW.md) and
[MODEL_SELECTION_REVIEW.md](MODEL_SELECTION_REVIEW.md).

No push, live-provider trial, personal credential change, OAuth work, Phase 9
promotion or Phase 10 expansion was performed. Reviews remain local/single-agent;
Phase 9's independent review/promotion questions and the historical verifier
SIGTERM cleanup flake are not closed by these commits. Statements below about
uncommitted work or earlier HEADs are historical and superseded by this section.

## Previous checkpoint — bounded CasperApp refactor complete

The user authorized reviewing and completing the first structural slice in
[APP_STRUCTURE_PLAN.md](APP_STRUCTURE_PLAN.md). It is implemented and locally
reviewed, still uncommitted. See [APP_STRUCTURE_REVIEW.md](APP_STRUCTURE_REVIEW.md)
for the isolated diff review, validation and limitations.

- `CasperApp` now separates slash-command dispatch from normal model-task execution
  while retaining the existing shared command-lifetime wrapper.
- New internal `src/task/observations.ts` owns bounded edit paths, shell-check
  diagnostics and possible-write flags. It neither verifies results nor owns tool
  authority, cancellation, persistence or repair. It is not barrel-exported.
- Cancellation, consent, runtime/workspace lifetime, edit invalidation, verifier
  evidence, task outcomes and the single repair owner retain their existing owners.
  No router framework or capability caching was added.
- One characterization at the app seam passed before source edits and after the
  refactor. Existing tests were retained. Final serial isolated `bun run check`:
  **432 tests / 4,787 assertions**, TypeScript clean (34 files; 136.61 s test portion).
  The full gate includes CLI/PTY behavior, model diagnostics and shutdown cleanup.
- Standards 0 findings; Spec 0 findings in the bounded **single-agent** review.
  No independent/subagent review was available. A passing cleanup test does not
  diagnose the historical intermittent verifier SIGTERM failure.
- Preservation snapshot:
  `/var/folders/yj/l1q2ypcj68qck8m_kcrdv26r0000gp/T/casper-app-refactor-baseline-42ivg7ee`.
  Website/acceptance evidence, dependencies, CLI mode and unrelated dirty work are
  unchanged. Only app/observation code, one test file and app-structure/handoff docs
  changed.

**Next boundary:** this first structural slice is complete; further architecture
or product work needs separate scope. No live-provider trial, personal credential
change, commit, push, OAuth work or Phase 9 promotion. The saved O4 candidate remains
unapplied. The app remains a substantial control layer; completion is not a claim
that every future maintainability concern has been resolved.

## Previous checkpoint — `/model` review correction complete

The user authorized continuing after the fresh review found one P2 terminal-safety
regression. That issue is now fixed: the picker catalog view sanitizes diagnostic
text, refresh-error provider labels/messages and rejected refresh diagnostics
before Pi adds its renderer controls. Model-selection policy is unchanged.

Two permanent regressions reproduced the failures before their fixes and now pass
for color and NO_COLOR, including malformed local catalogs, refresh failures,
OSC/C1/bidi controls, readable errors and cancellation without selection.
See [MODEL_SELECTION_REVIEW.md](MODEL_SELECTION_REVIEW.md) for the finding,
correction, review limits and evidence.

Latest serial isolated `bun run check`: **431 tests / 4,772 assertions**, TypeScript
clean (34 files; 153.06 s test portion). Three extra repeats of the diagnostic
regressions plus production CLI PTY test passed. Only the picker adapter, model
selection tests and three model/handoff documents changed; all website files,
saved acceptance evidence, dependency pins and unrelated dirty work are preserved.

**Next boundary:** this bounded correction is complete and remains uncommitted.
No outstanding finding from the local single-agent review; this is not independent
Phase 9 sign-off. Agree separate scope before OAuth, child/learning defaults or
Phase 9 promotion. No live-provider trial, personal credential change, commit or push.

## Previous checkpoint — approved Casper-owned `/model` slice locally complete

The user approved continuing the reuse-based model-selection slice and looping
through checks. Implementation and local Standards/Spec self-review are complete,
still uncommitted. No independent/subagent review was available; this is not
Phase 9 promotion. Read [MODEL_SELECTION.md](MODEL_SELECTION.md) for scope,
reuse evidence, integration corrections, defaults/restoration semantics and limits.

- `/model` hosts the **actual Pi 0.85.1 picker**. Exact `/model <id or provider/id>`
  selects directly; other interactive queries prefill search. Enter selects for
  the conversation; Ctrl+S also saves the new-parent default. Plain/redirected
  terminals and `TERM=dumb` list models instead. No OMP dependency or new command tree.
- Casper defaults live in `~/.casper/settings.json` using Pi's settings manager.
  Shared global/project Pi model defaults are neither adopted nor rewritten.
  Restored/forked conversations use their recorded selection; a missing/unavailable
  model blocks generation rather than silently falling back. `/status` reports the
  selected identity, reasoning, local auth, selection source, default and block reason.
- Selection records through Pi's transcript. Tests reproduced and fixed lost
  inactive branches and first-response `EEXIST` in the initial integration.
  Readline yields exclusive input ownership to the picker and restores the draft,
  cursor **and history**. Pending auth cannot select/save after cancellation or disposal.
- Picker catalog refresh is local-only. Configured credential-resolution programs
  can still run; configured runtime extensions still load as before. Credential
  availability is not a connectivity test. No embedded OAuth or credential migration.
  Delegation and learning intentionally retain their separately documented global
  Pi defaults; Casper defaults here apply to parent conversations only.
- Final serial `bun run check`: **429 tests / 4,708 assertions**, TypeScript clean
  (34 files; test portion 136.56 s). Three extra production-model PTY repeats and
  isolated installed-`casper` smoke checks passed. Added
  coverage includes isolated preferences/auth fixtures, missing-model/auth guards,
  default-write failures, restoration/forks, alias/corrupt settings, cancellation,
  concurrent work, an actual **localhost-only** reply after model selection, and
  the production CLI in a real PTY. No live providers or personal credentials used.
- The pre-edit preservation baseline is
  `/var/folders/yj/l1q2ypcj68qck8m_kcrdv26r0000gp/T/casper-model-baseline-omh8563k`.
  All seven `web/` files and twenty `docs/acceptance/` files remain hash-identical.
  Existing unrelated dirty work, dependencies/pins and CLI installation are preserved.

**Next boundary:** this bounded parent-model slice is complete, not all future
model/auth UX or Phase 9. Agree separate scope before embedded OAuth, propagating
Casper defaults into child/learning runs, broader terminal controls, or Phase 10.
The saved O4 candidate remains unapplied; no new live-model trial, credentials
change, commit or push was authorized or performed.

## Previous checkpoint — terminal slice complete (historical)

The user approved the bounded **quiet startup / usable prompt** slice, including
color, and asked to iterate until it was complete. Implementation and local
validation and a follow-up single-agent Standards/Spec review are complete, still
uncommitted. Read [TERMINAL_UX_REVIEW.md](TERMINAL_UX_REVIEW.md) for review findings,
fixes and next-phase readiness; [TERMINAL_UX.md](TERMINAL_UX.md) retains the slice's
scope and validation details.

- Skill discovery now defaults to Casper roots only. User/profile `skills.imports`
  enables Pi/shared/Claude/Codex roots explicitly; import is not trust. Ordinary docs
  are ignored; real warnings are summarized and inspectable via `/skills diagnostics`.
- The CLI now has color/basic Markdown, target-bearing tool activity, preserved
  drafts during streaming, busy-Enter protection, Ctrl-C task cancellation, and
  fresh confirmation input. `/status`, `/login` setup guidance and `/help all` are
  local. Active model/auth status comes from the host; startup remains lazy.
- Review reproduced and fixed two plain-mode gaps: pretyped approval reuse and
  buffered/invisible streaming deltas. Cooked TTY input (`TERM=dumb` or redirected
  output) now fails closed on exact approvals; piped-input fragments are discarded.
- Latest serial gate: **411 tests / 4,624 assertions**, TypeScript clean; three
  additional terminal regression repeats passed. PTY coverage includes streaming,
  wrapped input/cursor preservation, cancellation, confirmations (deny/approve/
  Ctrl-C/EOF), color/NO_COLOR, and `TERM=dumb` fail-closed behavior. Auth-preflight
  cancellation is tested against a localhost Pi protocol fixture.
- All seven website files and twenty saved acceptance-evidence files remain
  hash-identical to the pre-edit manifest. Existing unrelated uncommitted files,
  dependency pins, CLI executable mode and installed link were preserved. Website
  game tests passed as part of the gate; no browser acceptance was performed.

**Standing limits remain:** saved O4 trial candidate unapplied; no new live-model
trial, commit, push or Phase 10 expansion. Phase 9's independent review/promotion
questions remain open. A green gate does not diagnose the historical verifier
SIGTERM cleanup flake. The user subsequently confirmed blue output and successful
chat with host status `openai-codex / gpt-6-astra`, reasoning medium; this is human
feedback, not an agent-run trial. They reiterated that Casper should be its own
product: Pi is the runtime, not a long-term setup workflow users must manage.

**Next recommendation:** agree a bounded Casper-owned `/model` slice, including
selection persistence and Casper-specific defaults without rewriting shared Pi
settings. Model switching and embedded OAuth remain unimplemented. This review
makes the terminal slice ready for that planning discussion; it does not authorize
implementation, full-screen TUI expansion, or completion of Phase 9.

## Pre-slice handoff (historical context; superseded above)

**Previous direction: preserve the coding capability; make the interactive terminal
usable.** The user launched `casper`, asked it to build a polished tic-tac-toe
website, and said **“it did built the app well though.”** They also said the
terminal does not feel like Pi, OMP, Codex or Copilot: no colors, opaque activity,
noisy startup and missing expected controls. This is broader than a cosmetic fix.
The latest request was this handoff, not authorization for a full TUI rewrite.

1. Check `git status --short` and preserve all existing changes, especially the new
   **`web/tic-tac-toe/`** app. HEAD remains **`c8df223` — Add read-only local reference
   search**. Substantial work is uncommitted. If the user's Casper session is still
   writing in this checkout, coordinate before editing the CLI it runs.
2. Start with the real-use findings below, not another optimization pass. Agree a
   bounded interactive-UX slice and skill-source policy with the user. Basic input,
   activity visibility and onboarding should not be deferred behind advanced phases.
   No discovery, color, input, login or model-display fix has been implemented yet.
3. For a discovery fix, reproduce with a realistic temporary skill tree (ordinary
   docs alongside valid/invalid skill entries); assert warning behavior, not just
   successful launch. For input/rendering work, include a real TTY/PTY exercise of
   typing during streaming, cancellation and confirmations. Empty-HOME smoke tests
   alone missed the actual startup experience.
4. The older O4 candidate remains an independent pending decision, **unapplied**.
   If resuming it, read [trial 01](acceptance/TRIAL_01.md) and its
   [patch](acceptance/trial-01/candidate.patch), review fallback costs, and obtain
   application approval. It is not a prerequisite for terminal UX work.

**No automatic candidate application, agent-initiated live-model run, promotion,
Phase 10 expansion, commit or push.** The user's own website-building session is
new human feedback, not renewed authorization for agent-run trials. Before another
trial, agree command-timeout headroom and a new provider allowance. Independent
Phase 9 Standards/Spec review remains pending.

## Human real-use feedback — successful task, rough interface

The user ran the installed command in this repository. Chat worked and Casper
built the requested website; the user liked the result. The new untracked
`web/tic-tac-toe/` contains `index.html`, `style.css`, `app.js`, `game.js`,
`game.test.js`, `serve.ts` and `README.md`. Preserve it as user work. This handoff
only inventories those files: no website review, browser validation, test run or
independent acceptance was performed. The pasted transcript ends during writes;
do not invent its final verification status, usage or exact runtime model.

Observed interface problems and proposed next behavior:

- **Startup flood:** 44 skills were indexed, followed by many warnings about normal
  Markdown files under `~/.claude/skills/AionUi` and `paperclip`. The user explicitly
  objected that Claude is not what they are using. Two actual Codex `SKILL.md`
  entries also failed description-length validation; retain genuine diagnostics.
- **Discovery cause is visible in code:** `src/skills/registry.ts:scan` automatically
  adds Pi, shared `.agents`, Claude and Codex roots independently of provider. It
  recurses through every `.md` file unless that directory contains `SKILL.md`;
  ordinary repo docs therefore become invalid skill candidates. This is Casper's
  scanner, not Claude running or evidence of a provider switch. No corrective
  reproduction/test or implementation was completed in this session.
- **Recommended discovery policy:** make other tools' roots explicit opt-in and
  keep ordinary docs out of rejection logs. Confirm the exact default roots/import
  configuration before changing them. Standalone frontmatter `.md` skills are
  currently documented and tested behavior; distinguish them from ordinary docs
  rather than silently breaking compatibility. Summarize genuine warnings at
  startup and retain inspectable detail. Leave the user's external skill files alone.
- **Activity:** output such as `• read` / `✓ write` hides the file, command and result.
  Show meaningful operation targets, progress and useful result/error summaries,
  with appropriate redaction; this does not require exposing private reasoning.
- **Input and rendering:** no readable color/Markdown presentation; the transcript
  includes `/hHey!` while text streams. Treat input/output interference as a reported
  symptom requiring reproduction, not a diagnosed readline race. Provide an input
  area that survives streamed output and supports cancellation/approval safely.
- **Identity and auth:** `/login` is currently unknown. Chat nevertheless worked
  with existing authentication. Asking the model its identity produced only a vague
  “OpenAI model” answer. Display authoritative provider/model information from the
  host runtime and provide a clear login/status path; do not guess identity from
  generated prose or change the user's defaults/credentials implicitly.
- **Information hierarchy:** startup prints unused MCP/LSP/visualization status;
  `/help` dumps a long command/safety reference. A casual “hey” gets
  `[task] Execution completed; no Casper verification recorded.` Prefer concise
  startup/help and task-appropriate summaries, retaining detailed status, audit
  evidence and safety disclosures where they matter. Never imply checks passed
  merely by removing a noisy disclaimer.

The agreed conversational direction is **basic terminal usability before more
advanced features**, not merely adding colors. Themes/animations can wait. The
coding result is positive human evidence; it neither erases the UX gaps nor proves
general reliability. Preserve working execution, trust, consent and verification.

### Entry points for the next slice

- Discovery and warnings: `src/skills/registry.ts`,
  `src/app.ts:reportSkillWarnings`, `tests/phase2-skills.test.ts`,
  [README Skills](../README.md#skills).
- Interaction/rendering: readline and runtime event handling in `src/app.ts`,
  `src/tui/banner.ts`, `src/tui/help.ts`, `src/cli.ts`,
  `tests/casper-app.integration.test.ts`.
- Existing event data: `src/runtime/types.ts` and `src/runtime/pi.ts` already carry
  tool-call IDs and input observations, with output observations for bash. Inspect
  the actual contracts before proposing a new event interface. If using Pi's TUI
  or SDK APIs, read the installed Pi documentation/examples first; no library or
  renderer replacement has been selected.

## Local `casper` command is installed

The user authorized this setup. `src/cli.ts` is now executable (`0755`), and
`~/.local/bin/casper` links to
`/Users/stephenchoate/Documents/Casper/src/cli.ts`. That directory was already on
PATH; no shell settings, Bun package registration, credentials or dependencies
were changed. `command -v casper` also resolves in a login zsh.

From any project directory, **`casper` starts interactive mode**. `casper --help`
and `casper /project` work locally without model calls. Those two commands and an
interactive `/exit` smoke test all exited 0 from an unrelated temporary project
with isolated HOME and no credentials. No live-model call was made for installation.

This is a development link to the current main checkout, **not** the trial
candidate, a packaged release or a readiness sign-off. Moving/deleting the checkout
breaks the link. Preserve it unless the user asks otherwise. README Install/Run
instructions now explain setup. The installation changed only the executable
mode bit in source; CLI contents were checked against the saved baseline manifest.
Subsequent user work added the website; it was not part of the installation.

## Latest user preference: task progress, not a countdown

The user said that prominently calling out a “10 min timer” could scare people
away. Treat that limit as an **internal acceptance-experiment safeguard**, not a
Casper product requirement or normal task-duration promise. Lead with what Casper
is doing, checks/results, completion and requests for input. Keep exact limits in
engineering evidence; explain a reached limit honestly when relevant.

No customer-facing countdown or general ten-minute task cap was implemented.
Configurable limits in advanced settings are a possible UX direction, not a newly
shipped feature or authorization to implement one. Do not hide material spending
limits or failures. The user explicitly chose the original trial rather than
adaptive reasoning-effort escalation; that feature remains unimplemented.

## Trial outcome — keep these three results separate

| Evidence | Result |
| --- | --- |
| Frozen pre-website baseline | **389 tests / 2,599 assertions**, TypeScript clean; corrected isolated serial gate 117.63 s |
| Live Casper task | **286.10 s**, CLI exit **1**: managed full suite timed out at its existing **120-second command limit**; managed typecheck passed; zero repair attempts |
| Unchanged candidate, separately evaluated afterward | **398 tests / 2,609 assertions**, TypeScript clean, serial gate 120.49 s; all six evaluator cases and real `/project` check passed |

The outer experiment timeout was **not reached**. The separately passing host gate
does not turn the failed managed check into a pass. The last validated main-code
baseline was 389 tests, not the unapplied candidate's 398. The user has since added
website files including a test file; today's full-tree count has not been measured.
No supervising-agent code repair or model rerun occurred in the approved trial.

The candidate changes only `src/project/inspect.ts` and adds
`tests/project-inspect.test.ts`. Git process counts:

- Ordinary committed, nested, detached and linked-worktree inspection: **2 → 1**.
- Unborn branch: **2 → 3**; non-Git directory: **1 → 2**. These are real costs to
  consider before application, not a universal startup improvement.
- Controlled fresh-process inspection median: **89.11 → 60.05 ms**. This is a
  traced inspection fixture, not whole CLI startup or general productivity.

Provider: approved **Codex subscription / gpt-6-astra**, fixed **medium** effort.
Session reports 13 assistant messages, 12 tool calls and 75,819 total tokens
including cache reads. Actual subscription charge/remaining allowance is
unavailable; no hard dollar/token cap was claimed. No separately paid API provider
was used. Temporary protected auth was removed; original source/auth/settings
were unchanged at the end-of-run audit. Preserve the user's existing Pi defaults.

### Unresolved cleanup evidence

The first isolated baseline failed two profile tests because the harness forced
`CASPER_PROFILE=default`; removing that override corrected the setup. It also
reproduced the existing **SIGTERM verifier cleanup failure** (`leaked` marker
present). The later gate passed, but the cleanup cause remains unresolved. It has
now occurred in a **serial** gate as well as the earlier parallel run.

Keep `bun run check` serial and `test:fast` opt-in. Preserve cleanup assertions and
deadlines. A bounded investigation of this concrete failure is reasonable if
approved; another open-ended path/scope audit is not the next task. Do not attribute
the cleanup failure to the profile override or claim that rerunning diagnosed it.

## Evidence to read on demand

- **Trial assessment, usage, logs and limitations:**
  [acceptance/TRIAL_01.md](acceptance/TRIAL_01.md). Its `trial-01/` directory contains
  the permanent prompt, patch, manifests, evaluator, samples and separate gate logs.
- **Original agreed trial scope:** [ACCEPTANCE_TRIAL.md](ACCEPTANCE_TRIAL.md), now
  marked executed. Historical approval wording is not permission for another run.
- **Raw local snapshots/session:** `/tmp/casper-acceptance-sgTCoi/`, possibly absent
  later. No copied access/refresh token values remained after cleanup. The saved
  evaluator names that temporary root; recreating it requires matching baseline
  and candidate directories. Do not depend on temporary paths surviving.
- **Prior fixes/optimization details:**
  [DEBUG_OPTIMIZATION_REVIEW.md](DEBUG_OPTIMIZATION_REVIEW.md#follow-up-implementation-status).
- **Earlier checkpoints and historical validation only:**
  [HANDOFF_HISTORY.md](HANDOFF_HISTORY.md). Its old “next” instructions are superseded.

## Existing uncommitted work to preserve

- Phase 9 learning and human promotion: read [LEARNING.md](LEARNING.md) before
  changing generation, provenance, decisions, persistence or activation. Drafts
  remain immutable, unverified and unaccepted; promotion is a separate exact human
  decision, not verification. Read-only tools are not an OS sandbox or spending cap.
- Opt-in fast tests; local `/help`, one-shot exit and unknown-command rejection.
- Shared profile validation; optional-facts fallback; bounded, right-sized memory
  reads; supported project-command keys only. Lock recovery and outcome pruning
  remain deferred pending explicit ownership/retention rules.
- O2 deferred MCP/validator loading and O3 shared parallel workspace discovery.
  O2 showed a local startup gain; O3 did not establish a material speedup. Preserve
  consent, cancellation, catalog identity and cleanup behavior.

The trial added evidence, **not O4 production code**. `src/project/inspect.ts` is
still unchanged and `tests/project-inspect.test.ts` absent in the main tree. The
saved patch previously passed `git apply --check`; it remains unapplied.

Agent handoff/install work changed documentation and the CLI executable mode only;
the user subsequently generated the website with Casper. This latest handoff update
is docs-only. `git diff --check` passed, and the earlier three installed-command
smoke tests passed. No full suite or live model was run for this update. Full-gate
counts above are historical; the user's own successful task is separate evidence.

## Phase readiness and standing limits (historical — superseded by the resume section)

> Historical snapshot from before the terminal, login, Phase 10 and platform work.
> Its "Phase 10 stays paused" and "Windows remains unvalidated" statements are
> superseded: Phase 10 is closed as scoped and the platform layer is implemented
> (see the resume section at the top). The preservation and review-limit points
> below still apply.

Phase 9 implementation and the available same-agent Standards/Spec gate are
complete; an independent reviewer was unavailable and no independent sign-off is
claimed. The self-hosted coding trial does not validate learning quality,
production integrations or general daily-driver readiness. Phase 10, research
activation and further feature expansion stay paused.

Preserve native bash, dependency pins, the verification command runner and the
single post-primary repair owner. The earlier filesystem/evidence correction is
closed within its documented limits; reopen only for a concrete reproducible
contract regression or an approved affecting change. Scope observations and reads
remain non-atomic; Windows remains unvalidated.
