# Release-readiness review and corrections

Scope: current Casper release behavior, with `d6e2483...7231442` as the checkpoint
comparison. Single-agent review; no independent reviewers were available. This is
not an exhaustive security audit or a certification of every feature on every OS.
Corrections below are in the working tree, not committed or published.

## Standards

The review prioritized the documented design rules: proof over self-reporting,
inspectable behavior, and one shared platform policy. No speculative architecture
rewrite or dependency change was justified. No new hard standards violation was
confirmed within this scoped pass; that is not a whole-codebase standards sign-off.

The significant design correction is that process termination now has an awaitable
result, rather than discarding its own uncertainty at the shared wrapper. The
actual caller lifecycles, not only the process-owner class, are regression-tested.

## Spec and behavior

### 1. Compiled visualization lacked its native source — corrected

`src/visualize/artifacts.ts` resolved `artifacts.c` through `import.meta.url`.
`/visualize repo` worked from source but the compiled CLI exited 1:

```text
file '/$bunfs/root/artifacts.c' not found
```

A Bun file-loader import embeds the bridge. Embedding alone was insufficient:
TinyCC opens source through libc, which cannot resolve Bun's virtual filesystem.
The bridge is now copied into a private temporary directory for synchronous
compilation, then removed. No headers or external compiler are required.

`tests/release-install.test.ts` now compiles the actual CLI and runs visualization
outside the checkout with no Bun on PATH, asserting Mermaid and MindMesh files.
This test failed before the correction and passes afterward. The rebuilt ARM64
and Intel macOS artifacts also passed the served-installer flow independently.

### 2. Installer accepted a failing version probe — corrected locally

A checksum-valid stand-in printed `casper 0.1.0` and exited 42. The shell installer
reported success and replaced an existing installation because `|| true` discarded
the exit status. It now requires both successful execution and nonempty output,
plus the requested version match when pinned. The regression checks preservation
of the prior bytes and removal of the staged file.

PowerShell now checks `$LASTEXITCODE` too. **No PowerShell/Windows run is available**;
this half remains statically reviewed, not host-validated. The release docs no
longer claim a second execution from the final path, and accurately restrict the
PowerShell download path to HTTP(S), unlike the shell installer's local/file support.

### 3. Evaluation inferred symbol absence from skipped files — corrected

The symbol-absence predicate skipped files over 1 MiB after reading the whole file.
Padding a file containing `formatCurrency` beyond that limit made acceptance pass.
It also silently skipped symlinks.

Supported text files are now read through the no-follow helper with at most 1 MiB
plus one overflow-detection byte. Unreadable, non-regular, linked or oversized
supported paths fail acceptance as **scan unavailable**. Regressions include a
large file with the old symbol, a large clean file, and a dangling symlink.
The supported suffix set and non-atomic observation limits are documented. This is
not semantic grading or general protection against adversarial filesystem changes.
No new paid/model evaluation sample was run.

### 4. Shared termination discarded Windows cleanup results — corrected at callers

`terminateTree` returned nothing and launched `owner.stop()` without awaiting its
result. The debugger had its own result-aware path; browser, verifier, LSP and MCP
callers did not. The precise platform document already limited the global blocking
promise to the debugger; the README wording was broader.

The wrapper now returns the cleanup result. An owner's TERM/escalation/close paths
share one cleanup promise. Browser/LSP/MCP retain unconfirmed cleanup and reject
replacement/reconnect; verifier failure prevents further checks and aborts repair.
Casper checks retained failures before subsequent execution, while allowing local
status/help and cleanup commands. Command state is released even when cleanup
throws. Unknown cleanup detaches owned I/O/process handles rather than hanging the
host indefinitely waiting for an unverified child to close; it does not claim the
child was terminated. Temporary state needed by an unconfirmed browser process is
preserved. MCP begins ownership before its protocol handshake, not only afterward.

The shared wrapper and five real caller lifecycles are tested with an unavailable
simulated non-group process table. The caller regressions also failed against an
export of the original committed tree. Module substitution runs in separate Bun
processes; POSIX fixture teardown removes only the children deliberately left
alive by the failed synthetic listing. These are **not Windows host tests**.

POSIX retains its prior best-effort exact-group signalling. No atomic process-tree
snapshot, daemon containment, complete PID-race protection or universal cleanup
time guarantee is claimed. The CLI's existing one-second signal-exit deadline can
still end the process before asynchronous cleanup completes.

## Full-gate cancellation fixture follow-up

The first full gate reported 539 pass / 1 fail: a cancelled shell running
`touch started; (sleep 0.5 && touch leaked) & wait` returned exit 0 with cancellation
recorded, while the test required a null exit code. Production correctly retained
the observed exit code. The failure did not recur in 20 focused runs or 300 direct
runner cancellations **on each of the committed and corrected trees**. Those probes
created no leaked marker; they do not establish the cause of the original timing.

The fixture now ignores TERM in the shell and children, retaining the original
500 ms delayed-marker premise, so the existing 100 ms KILL escalation supplies
the asserted signal exit. No assertion, cleanup requirement or deadline was
relaxed, and no exit evidence was normalized to make the test pass. The focused
case and subsequent full gates pass. This makes the fixture premise deterministic;
it is not a claim that every historical cancellation flake has been diagnosed.

## Documentation corrections

- README distinguishes source requirements from compiled releases and says nothing
  is publicly released yet.
- Linux's fixture row no longer claims a host run.
- Deleted website instructions are removed from current-facing documentation.
- The implementation plan links to the current handoff rather than copying stale
  gate counts; historical handoff sections remain historical.
- The evaluation table no longer lists the deliberately removed `src/health.ts`
  existence predicate.
- Publishing instructions set the host before building/uploading the installer
  copies. Downloads' temporary-directory writes are disclosed.

## Validation

- Final isolated serial `bun run check`: **540 pass / 0 fail / 3,550 assertions,
  46 files, 277.19 s test portion, exit 0**. TypeScript clean.
  Log: `/tmp/casper-review-release-final.0IoMhi/check.log`.
- Previous green gate: same counts, 283.25 s. First gate's failure is recorded above,
  not omitted from the evidence.
- Gate environment: existing isolated HOME/TMPDIR, `TERM=xterm-256color`, installed
  Chrome and debugpy through explicit `CASPER_TEST_DEBUGPY`/`CASPER_TEST_PYTHON`.
- `bun run build:release -- --all`: all five artifacts rebuilt from the corrected
  tree; every SHA256SUMS entry matches, and both copied installers match `scripts/`.
  Log: `/tmp/casper-review-build-final.log`.
- Served local HTTP directory: both macOS artifacts install through the served
  `curl ... | sh` shape into isolated homes without Bun on PATH; version, help and
  visualization pass. Intel runs via Rosetta. Rejected 9.9.9 pin preserves installed
  bytes, no staged file remains, and the temporary C source is removed.
  Results: `/tmp/casper-review-served-release-final.json`.
- macOS platform probe: **8 pass / 0 fail / 1 informational skip** (adapter-hint
  environment variables were absent for that probe; real debugpy ran in the gate).
- `git diff --check`: clean for these working-tree changes.

Temporary logs are supplemental evidence and may disappear. Permanent regression
tests capture the corrected contracts.

## Remaining before publishing

- Windows/Linux real-host runs, including the PowerShell installer and actual
  release binaries. Cross-compilation is not host validation.
- Repository/release-host creation and URL choice; installer defaults still contain
  `OWNER`, and the README uses `<release-host>`. Set them, rebuild and re-upload
  before a public one-liner can work.
- License decision before presenting the project as reusable open source.
- Publication privacy/secret review, including Git history and committed logs.
  No clean secret-scan certification is claimed here.
- CI is advisable but not implemented by this correction; it is not required merely
  to upload source. No issue-tracker/agent-skill configuration was added.
- Explicit commit/push/publish authorization. None performed here. Existing local
  scratch material, archived evidence and unrelated processes were left alone.
