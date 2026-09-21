# Verifier shutdown — reproduced marker race and bounded correction

## Outcome

The reproduced SIGTERM cleanup-test flake is an **interrupted-sleep marker race**,
not evidence that a descendant survived the shutdown deadline. The diagnostic
command was:

```sh
touch started; (sleep 1; touch leaked) & wait
```

SIGTERM can interrupt `sleep` while its surrounding shell still has time to run
its next command. `; touch leaked` runs even after an unsuccessful sleep. The
marker therefore sometimes appeared within milliseconds of cancellation, not
one second later. Its existence alone was not a valid observation of delayed,
surviving work.

The three affected test commands now use `sleep … && touch leaked`. Existing
assertions, observation waits and production deadlines remain unchanged. New
real-CLI tests additionally require a TERM-resistant descendant and its process
group to disappear, with no delayed marker. They cover both inherited pipes and
closed pipes, exercising timed escalation and cleanup after the shell closes.

**No production code, signal policy, dependency, timeout or default test-runner
change was necessary.** This bounded diagnosis/correction is complete, not Phase
9 promotion or a guarantee of side-effect-free cancellation.

## Reproduction and causal evidence

Baseline: committed `d6e2483`, exported outside the working checkout. Tests ran
serially on macOS with Bun 1.4.0 (`1381054db`), a temporary HOME/TMPDIR, an
allowlisted environment and offline Pi settings. No provider task was invoked.

The first bounded attempt was inconclusive: 30 original-test repeats and 27
valid early-signal probes passed. Three zero-delay probes failed before readiness
and were explicitly excluded. The user then authorized continuing the loop.
One instrumented full serial gate also passed; none of these green runs was
presented as a diagnosis.

The tighter CLI loop ran the real `/verify test` command, waited for `started`,
sent SIGTERM and awaited exit 143. It ran cancellations serially and checked
retained fixture markers after a final 1,100 ms wait instead of waiting that long
after every cancellation. No production code was changed for this loop.

| Probe | Result |
| --- | --- |
| Original command through the real CLI, 1 ms readiness polling | **4 marker failures / 200 cancellations**, all exit 143 |
| Direct command runner without a SIGTERM listener | 0 / 300; another 0 / 300 with a 5 ms post-readiness delay |
| Direct runner with a registered SIGTERM listener | **4 marker failures / 300 cancellations** |
| Sleep-status instrumentation in the CLI / direct runner | 0 / 200 and 0 / 300; instrumentation affected the reproduction rate |
| Controlled shell with a TERM trap, interrupted sleep and unconditional marker | **10 / 10 markers**, sleep exit status **143** |
| Controlled pair differing only in `;` versus `&&` before `touch leaked` | **10 / 10** versus **0 / 10** markers |
| Corrected command through the original CLI loop | **0 / 200** marker failures |
| Corrected command through the direct runner with SIGTERM listener | **0 / 300** marker failures |

Example unmodified-command CLI failure, expressed relative to SIGTERM delivery:

```text
started created:  -0.952 ms
SIGTERM sent:      0.000 ms
leaked created:   +3.478 ms
CLI exit 143:     +6.000 ms
```

A direct-runner failure also retained this real command evidence:

```text
/bin/sh: line 1: 18051 Terminated: 15          sleep 1
status: fail; signal: SIGTERM; reason: Verification cancelled
leaked created approximately 3.75 ms after abort
```

This rejects the late-signal explanation for those samples and shows why the
old marker could misclassify shutdown activity as a leak. The controlled TERM
trap deliberately makes shell continuation reproducible; it is not a claim that
the original command installed that trap. Listener registration exposed the race
in the smaller harness; this investigation does not establish a Bun signal-
inheritance defect.

Ranked alternatives were interrupted-sleep fallthrough, a descendant surviving
CLI exit, and a late test signal. The historical logs lack event ordering, so
we cannot retrospectively prove every historical occurrence had this cause.
We reproduced the same assertion failure and established a concrete defect in
its observation mechanism rather than dismissing it after a passing rerun.

## Stronger permanent coverage

`tests/fixtures/verifier-descendant.ts` installs a real TERM handler, publishes its
PID only after setup, and schedules a one-second marker using a Bun timer.
SIGTERM cannot accelerate that timer as it can interrupt a shell sleep.

Three added cases in `tests/phase3-app.integration.test.ts` establish:

1. **Fixture positive control:** TERM is received, the marker is initially absent,
   and it appears later if the descendant is allowed to live.
2. **Inherited pipes:** real CLI termination kills the resistant descendant;
   exit remains 143, the delayed marker stays absent, and both PID and PGID no
   longer exist. Open descendant pipes keep the shell's close event pending.
3. **Closed pipes:** the same guarantees hold when the shell can close before the
   descendant, testing cleanup on that path too.

The tests clean up their own process groups even when intentionally faulted.
Existing shell-marker assertions remain in the app, command-runner timeout and
model-selected cancellation tests, with only the sleep-success guard corrected.
The latter also retains the queued-check and no-repair assertions.

### Negative controls, not just green tests

In the isolated snapshot only:

- Replaced group signalling with direct-shell signalling: **both descendant tests
  failed at the delayed-marker assertion**.
- Suppressed SIGKILL while retaining group SIGTERM: **both descendant tests failed
  at the delayed-marker assertion**.
- Restored the original runner: both passed, along with the fixture control.

These mutations were removed before validation and never applied to the working
checkout. They demonstrate that the new coverage detects actual survivors and
missing escalation; the correction does not simply silence the old failure.
This is a test-fixture correction, not a claim of red-to-green production repair.

## Validation and review

| Gate | Result |
| --- | --- |
| Instrumented baseline serial `bun run check` | 427 tests / 2,843 assertions; TypeScript clean |
| Corrected scoped tree, serial `bun run check` | **430 tests / 2,865 assertions**, TypeScript clean; 33 files; **141.41 s** test portion |
| Five additional serial focused repeats | **6 tests / 39 assertions** per run, all passed |

The scoped tree is committed HEAD plus these four test/fixture files. It excludes
unrelated netcalc/website work and is **not** a full-working-tree validation.
The applied test/fixture files byte-match that validated snapshot, and
`git diff --check` passed. The focused selection was:

```sh
bun test tests/phase3-app.integration.test.ts \
  tests/phase3-verification.test.ts \
  tests/work-driven-checks.integration.test.ts \
  -t 'CLI termination|verifier descendant fixture|times out and kills shell descendants|tool cancellation kills'
```

Single-agent Standards/Spec review: no outstanding findings in the bounded diff.
Tests exercise real processes and the public CLI, keep the original contracts,
and add no production interface or dependency. No independent/subagent review
was available. Parallel tests remain opt-in. Windows and escaped/daemonized
processes are not newly validated. Termination is not transactional rollback;
arbitrary commands may have effects before or during cleanup.

## Preservation and artifacts

Only the three existing test files, one new fixture, this review, README's test
note and the latest handoff section are in scope. All pre-existing unrelated
files were checked against a 189-file content/mode manifest: the five expected
existing files changed; all other **184 files** matched, with only the two scoped
new files added. No netcalc, website, plan edit, dependency pin or saved acceptance
evidence was changed. No live
provider, credential change, O4 application, commit or push was performed.

Detailed logs, loop harnesses, controlled probes and the original inconclusive
report are retained in the clearly separated temporary diagnostic directory:
`/tmp/casper-shutdown-diagnosis.dIat8c`. Temporary files may disappear; the causal
samples and permanent coverage above do not depend on their survival.
