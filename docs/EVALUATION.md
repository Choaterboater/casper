# Evaluation suite

Casper's own tests for agent behavior. The suite runs real tasks
against small fixture repositories and records numbers instead of impressions:
task success, required interactions, rescue interventions, verification success,
model responses, files touched, repair attempts, reported usage and elapsed time.

The harness is exercised without a model by `tests/eval-suite.test.ts`. Two local
samples each completed 9/9 small tasks with one provider/model; that is not a
competitive benchmark, provider matrix or proof of daily-driver reliability.

The daily-driver preparation adds two multi-module repository tasks and two
human-driven workflow protocols. These are **prepared**, not live-provider or
native-platform acceptance. Historical 9/9 results do not cover the new tasks.

## Layout

```text
evals/
├── fixtures/     solved baseline repositories (one per project shape)
├── setups/       overlays that turn a baseline into one task's unsolved state
├── tasks.ts      the task catalog (prompt, verification, acceptance)
├── scenarios.ts  cancellation/restart/resume and delegation protocols
├── runner.ts     prepare → run → measure → verify → grade
└── report.ts     per-attempt outcomes and summary
tools/eval.ts     CLI
```

## Fixture contract

A fixture is the **solved** state: its own verification commands pass on it. A
task's `setup` overlay (`files/` plus `remove.json`) turns it into the unsolved
starting state, and the fixture's verification then fails. `tests/eval-suite.test.ts`
asserts both directions for every task, so a fixture cannot silently drift into
being trivially passable or permanently broken.

Verification never depends on the child's shell or PATH. Commands run as argv with
`{{bun}}` (the running Bun executable) and `{{tsc}}` (this repository's TypeScript
compiler) resolved to absolute paths, and the command is spawned directly rather
than through a shell, so a fixture's grading works on any host. Inside the fixture,
Casper's own checks stay whatever the fixture configures (`bun run test`).

Before model execution, the runner freezes a second, solved fixture outside the
candidate workspace. Grading replaces only the declared `verify.candidatePaths`
(currently top-level `src`) with the candidate's production files. Missing source
stays missing; source symlinks fail grading. Tests and configuration remain frozen,
so replacing candidate tests with trivial passes cannot replace the host checks.
File-change predicates still inspect the candidate, including its test/config edits.
The fulfillment tasks allow changes only under `src/`: unrelated root files,
scripts, tests and configuration changes fail acceptance even when behavior passes.

The low-level `runVerification` function executes argv against its supplied cwd;
it is not itself a protected evaluator. `runEvalTask` and `gradePreparedEval` supply
the protected evaluation workspace. This is logical separation, **not a sandbox**:
candidate code still executes with the host user's privileges. Keep the evaluator
outside the candidate; do not treat it as protection against malicious code.

## Tasks

| Task | Fixture + setup | Independent verification | Start | Acceptance beyond verification |
| --- | --- | --- | --- | --- |
| `add-api-endpoint` | typescript-service + add-api-endpoint | `bun test` | fail | `src/` changed, `tests/` untouched |
| `fix-failing-test` | typescript-service + slug-regression | `bun test` | fail | `src/` changed |
| `respect-project-rule` | typescript-service + slug-regression | `bun test` | fail | `tests/` untouched, `slugify` still exported |
| `avoid-unnecessary-dependency` | typescript-service + slug-regression | `bun test` | fail | `package.json` untouched |
| `repair-type-error` | broken-types + repair-type-error | `tsc --noEmit -p tsconfig.json` | fail | `tsconfig.json` untouched, `withAdjustment` kept |
| `rename-symbol` | symbol-rename + rename-symbol | `bun test` | pass | `formatCurrency` gone everywhere, `formatMoney` exported, `src/` and `tests/` changed |
| `add-component` | component-registry + add-component | `bun test` | fail | `src/` changed, `tests/` untouched |
| `add-mcp-tool` | mcp-tool + add-mcp-tool | `bun test` | fail | `src/` changed, `tests/` untouched |
| `find-bug-without-editing` | bug-hunt | `bun test` | pass | no file edited, answer mentions the file and the wrong expression |
| `repair-order-reservations` | fulfillment-service + repair-order-reservations | `bun test` | fail | stock reservation atomicity, repeated-SKU normalization, callers and lifecycle; tests/config untouched |
| `add-order-cancellation` | fulfillment-service + add-order-cancellation | `bun test` | fail | cancellation/replay/transitions and stock reuse through the public command API; tests/config untouched |

`rename-symbol` and `find-bug-without-editing` start **green**: the suite passes
before the task, so the independent verification cannot carry them. Their
acceptance predicates do (the old symbol must be gone; no file may change).

## Metrics and their sources

| Metric | Source |
| --- | --- |
| task success | `execution == completed` **and** at least one model response **and** independent verification passes **and** every acceptance predicate holds |
| verification success | frozen host checks against copied candidate production files, after Casper stopped — never Casper's report or candidate-modified checks |
| model responses | `assistant_response_start` events, counted by the runtime wrapper (the wrapper is unconditional, so a real-provider run reports the same numbers as a scripted test) |
| files touched | SHA-256 tree snapshot diff before/after (added, modified, removed); hashes are streamed, so a large file cannot balloon harness memory. A symlink counts as a touched path and is never followed, so it cannot escape the work directory |
| repair attempts | `VerificationReport.repairAttempts` when Casper's own loop ran |
| reported usage | `RuntimeUsage` from the primary runtime; `reportedUsage` retains available cost estimates and separate effort-classifier usage; `n/a`/`null` stays unavailable, not zero |
| wall clock | harness timer through preparation, execution, grading and cleanup (as in the historical baseline); manual scenarios use the host's recorded elapsed time |
| self-reported verification | Casper's own report status, recorded **separately** and never acceptance |
| output tail | the last 4 KB of Casper's own output, kept only for diagnosing a failed run; never acceptance evidence |
| intervention log | ordered host entries: `kind` (`required` or `rescue`), elapsed `atMs`, and `reason`; Casper's automatic repair count is separate |
| acceptance outcome | `accepted-without-rescue`, `accepted-with-rescue`, or `not-accepted`; each result has a distinct `attemptId` |
| evidence source | `runtime` for instrumented one-shot runs; `host-observation` for manually recorded scenarios |

Independent verification reports `pass`, `fail` (the command ran and failed), or
`unavailable` (the evaluator could not run safely). Both non-pass states prevent
acceptance; an infrastructure problem is not reported as a behavioral test failure.

A run that produced no model response cannot succeed, whatever the tree looks
like: no response means no work was done.

## Isolation

- The fixture is copied to a fresh temporary directory. Use `TMPDIR`/`TMP`/`TEMP`
  outside any Git repository: Casper's project discovery otherwise finds the
  enclosing repository. The runner rejects a discovered root outside the prepared
  candidate before loading its configuration or constructing a runtime. This
  fail-closed check is not an OS sandbox.
- The runner's temporary home redirects Casper-owned state (named-workspace
  records, memory, skills and integration configuration). It does **not** change
  process HOME or Pi's agent directory. Legacy one-shot provider runs can still
  load ambient Pi configuration/extensions and persist Pi conversation transcripts
  outside that temporary home; they are not isolated daily-driver evidence by
  default. Before any live evaluation, explicitly isolate HOME/XDG/Pi configuration
  and session paths and agree how only the authorized credential/model configuration
  is supplied. Neither preparation nor this review copies personal credentials.
- Code acceptance uses candidate filesystem predicates, the final answer and frozen
  behavioral checks. Workflow scenarios additionally require explicit host-observed
  checks; no lifecycle/delegation success is inferred from the model's prose.

## Running

```bash
bun tools/eval.ts --list                      # task ids
bun tools/eval.ts                             # every catalog task; PROVIDER CALLS
bun tools/eval.ts --task rename-symbol        # one task; PROVIDER CALLS
bun tools/eval.ts --json /tmp/eval-new.json   # new report only; refuses replacement
bun tools/eval.ts --keep --no-auto-verify     # provider run; keep work directories
```

Exit code is 0 only when every selected task succeeded. `bun test tests/eval-suite.test.ts`
validates the harness itself (catalog, fixture/setup matrix, measurement, grading)
without a model.

## Credential-free preparation and grading

```bash
bun tools/eval.ts --prepare --task repair-order-reservations
bun tools/eval.ts --prepare --task add-order-cancellation
bun tools/eval.ts --prepare --scenario cancel-resume
bun tools/eval.ts --prepare --scenario delegate-investigation
bun tools/eval.ts --grade /path/to/prepared-root --observation /path/to/host-observation.json
```

Preparation returns a retained root containing `candidate/`, frozen `evaluator/`,
`home/`, `manifest.json`, `prompt.txt` and `results/`. Workflow scenarios also contain
`instructions.txt`. The manifest records the task and initial/evaluator file hashes.
Grading refuses a changed frozen evaluator and uses a fresh disposable grader copy.
The caller owns the prepared root; retain evidence before removing it.

Only run the actual interactive Casper CLI after authorizing the provider/account,
exact model/effort, run/spending allowance and credential isolation. Keep observation
records outside `candidate/`. The grading CLI resolves the actual candidate and
observation paths, rejecting candidate-owned records reached through aliases or
symlinks. This check is not protection against concurrent filesystem tampering.
The prepared `home/` is an empty directory, **not an
automatic launch environment**: launching Casper manually still requires approved
HOME/XDG/runtime configuration isolation. Neither preparation nor grading reads
personal credentials or starts a provider runtime.

Host observation JSON has required fields:

```json
{
  "startedAt": "2026-09-21T00:00:00.000Z",
  "wallClockMs": 1000,
  "execution": "cancelled",
  "modelCalls": 0,
  "answer": "",
  "interventions": [
    { "kind": "required", "atMs": 500, "reason": "Planned cancellation during active work." }
  ],
  "workflowChecks": [
    { "id": "cancelled-active-work", "passed": true, "evidence": "Reference to the host's retained transcript." }
  ]
}
```

This incomplete example deliberately cannot pass. Record actual execution
(`completed`, `failed`, `cancelled`, `error`), observed model responses, final answer,
elapsed time and the **complete** interaction history. Optional `usage` uses the
`RuntimeUsage` shape (tokens, messages, optional context/cost/classifier estimates);
omit it when unavailable. Optional diagnostic fields are `error`, `runtimeErrors`,
`outputTail`, `repairAttempts`, and `selfVerification`. These do not replace checks.
Host observations are operator attestations, not automatically collected telemetry;
the operator must retain and review the referenced evidence.

Each grading call saves a new `results/<attemptId>.json` containing both the result
and observation, including failed attempts. Regrading a repaired candidate never
overwrites an earlier failure. `--json` likewise refuses an existing destination
before any provider run. Human rescue changes the outcome category, not the
behavioral pass/fail result; required interaction alone does not count as rescue.

### Workflow protocols

- **Cancel/resume:** interrupt active work after a real edit, verify work stops,
  exit cleanly, start a different Casper process, `/resume <exact-id>`, compare
  retained workspace state, and continue without restating prior instructions.
  A unique conversation-only marker in the original prompt must appear in the
  final answer and nowhere in scanned workspace text. Host evidence must cover
  active cancellation, process cleanup, clean exit, identical conversation identity
  and workspace retention. Missing/failed evidence prevents acceptance even if the
  code passes. This is not abrupt-crash recovery.
- **Delegation:** observe a successful read-only explorer investigation before the
  parent's production edit, preserve workspace/activity evidence, then independently
  verify the parent's change. Tool-call/report and host evidence are required;
  an answer saying “I delegated” is insufficient. Primary runtime usage is not a
  total for separately billed children; keep child usage evidence separately and
  label unavailable totals.

The first real repair pilot is prepared outside the public checkout by
`.scratch/daily-driver/prepare-pilot.ts` in the development workspace. Its host-owned
`cleanup-evaluator.ts` covers invalid-preparation cleanup, caller-owned state and
successful-run preservation. The known cleanup defect is intentionally retained
for that authorized trial, not fixed as part of harness preparation.

## Limits

- Two recorded samples, one provider, one model — a starting point, not a
  distribution, and no provider matrix. The two samples agree on outcomes (9/9, the same
  ten touched files) and disagree on cost (wall clock 152 s vs 239 s), so read the
  outcome columns as findings and the cost columns as ranges.
- The fulfillment fixture has multiple modules and behavioral boundaries but remains
  synthetic and in-memory. It prepares feature work in a new repository; it does not
  establish real-world unfamiliarity, scale or daily-driver reliability.
- Keyword grading cannot tell a correct explanation from a lucky phrase.
- Symbol-absence scans cover `.ts`, `.js`, `.json`, `.yaml`, `.yml`, `.md` and `.txt`
  files, not every possible language or binary format. Within that set, symlinks,
  unreadable/non-regular files and files over 1 MiB fail acceptance as **scan
  unavailable**; skipping a file never proves the symbol absent. Reads retain at
  most 1 MiB plus one overflow-detection byte per file. These observations remain
  non-atomic, not a defense against concurrent malicious filesystem changes.
- The suite does not measure subjective quality, and `files touched` counts
  changes, not correctness of each change.
