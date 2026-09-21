# Evaluation suite

Casper's own tests for agent behavior (master plan §48). The suite runs real tasks
against small fixture repositories and records numbers instead of impressions:
task success, verification success, model responses, files touched, repair
attempts, tokens and wall clock.

Status: **implemented, self-verified and measured twice** — see the
[recorded baseline](#recorded-baseline) and the [second sample](#second-sample-variance).
The harness itself is exercised without a model by `tests/eval-suite.test.ts` (catalog,
fixture/setup matrix, measurement, grading); there is no provider matrix yet.

## Layout

```text
evals/
├── fixtures/     solved baseline repositories (one per project shape)
├── setups/       overlays that turn a baseline into one task's unsolved state
├── tasks.ts      the task catalog (prompt, verification, acceptance)
├── runner.ts     prepare → run → measure → verify → grade
└── report.ts     one line per task plus a summary
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

## Tasks

| Task | Fixture + setup | Independent verification | Start | Acceptance beyond verification |
| --- | --- | --- | --- | --- |
| `add-api-endpoint` | typescript-service + add-api-endpoint | `bun test` | fail | `src/` changed, `src/health.ts` exists, `tests/` untouched |
| `fix-failing-test` | typescript-service + slug-regression | `bun test` | fail | `src/` changed |
| `respect-project-rule` | typescript-service + slug-regression | `bun test` | fail | `tests/` untouched, `slugify` still exported |
| `avoid-unnecessary-dependency` | typescript-service + slug-regression | `bun test` | fail | `package.json` untouched |
| `repair-type-error` | broken-types + repair-type-error | `tsc --noEmit -p tsconfig.json` | fail | `tsconfig.json` untouched, `withAdjustment` kept |
| `rename-symbol` | symbol-rename + rename-symbol | `bun test` | pass | `formatCurrency` gone everywhere, `formatMoney` exported, `src/` and `tests/` changed |
| `add-component` | component-registry + add-component | `bun test` | fail | `src/` changed, `tests/` untouched |
| `add-mcp-tool` | mcp-tool + add-mcp-tool | `bun test` | fail | `src/` changed, `tests/` untouched |
| `find-bug-without-editing` | bug-hunt | `bun test` | pass | no file edited, answer mentions the file and the wrong expression |

`rename-symbol` and `find-bug-without-editing` start **green**: the suite passes
before the task, so the independent verification cannot carry them. Their
acceptance predicates do (the old symbol must be gone; no file may change).

## Metrics and their sources

| Metric | Source |
| --- | --- |
| task success | `execution == completed` **and** at least one model response **and** independent verification passes **and** every acceptance predicate holds |
| verification success | the task's own argv command, run by the harness after Casper stopped — never Casper's report |
| model responses | `assistant_response_start` events, counted by the runtime wrapper (the wrapper is unconditional, so a real-provider run reports the same numbers as a scripted test) |
| files touched | SHA-256 tree snapshot diff before/after (added, modified, removed); hashes are streamed, so a large file cannot balloon harness memory. A symlink counts as a touched path and is never followed, so it cannot escape the work directory |
| repair attempts | `VerificationReport.repairAttempts` when Casper's own loop ran |
| tokens / context | `RuntimeUsage` captured through the wrapper; `n/a` when the adapter reports none |
| wall clock | harness timer around the task |
| self-reported verification | Casper's own report status, recorded **separately** and never acceptance (design rule 6) |
| output tail | the last 4 KB of Casper's own output, kept only for diagnosing a failed run; never acceptance evidence |

A run that produced no model response cannot succeed, whatever the tree looks
like: no response means no work was done.

## Isolation

- The fixture is copied to a fresh temporary directory; the repository is never the
  work directory.
- Casper state (sessions, memory, skills, MCP/LSP/reference configuration) is
  redirected to a temporary home, so ambient configuration cannot join a run and
  runs stay comparable. The runtime keeps the user's provider credentials, so a
  CLI run uses the configured model and any provider billing is the user's.
- Acceptance is evaluated from the filesystem and the final answer only.

## Running

```bash
bun tools/eval.ts --list                      # task ids
bun tools/eval.ts                             # every task
bun tools/eval.ts --task rename-symbol        # one task
bun tools/eval.ts --json /tmp/eval.json       # raw results
bun tools/eval.ts --keep --no-auto-verify     # inspect work directories, skip Casper's loop
```

Exit code is 0 only when every selected task succeeded. `bun test tests/eval-suite.test.ts`
validates the harness itself (catalog, fixture/setup matrix, measurement, grading)
without a model.

## Deliberate deviations from §48

- **`evals/` instead of a root `fixtures/`.** §48 sketched `fixtures/` at the
  repository root; `evals/fixtures/` avoids colliding with the existing
  `tests/fixtures/` helpers and keeps the whole evaluation surface (fixtures,
  setups, catalog, runner) in one directory that `bunfig.toml` keeps out of the
  product suite's discovery.
- **No framework or Python fixtures.** Installing React, FastAPI or a Python
  toolchain is not something this suite may do, so fixtures are dependency-free
  and every task shape is preserved: the React fixture becomes a component
  registry, the FastAPI fixture an HTTP-shaped router, `typescript-mcp` a tool
  catalog. The nine §48 task shapes are all present; `python-cli` is not
  represented because a Python interpreter is not guaranteed on an eval host.
- **`repair-type-error` has no in-fixture typecheck.** The fixture ships a
  `tsconfig.json` but no `node_modules`, so the model cannot run `tsc` there; the
  grader runs the repository's compiler instead. Grading stays independent of the
  model's tooling, which is the point.
- **`find-bug-without-editing` is graded by keywords** (file name plus the wrong
  expression). That is weaker than a semantic judgment and is stated here rather
  than hidden.

## Recorded baseline

First measured run — 2026-09-21, macOS arm64, Bun 1.4.0, provider `github-copilot`,
model `claude-fable-5`, artifact `/tmp/eval-baseline2.json`:

| Task | Wall | Model responses | Tokens (total / cache read) | Files touched | Casper's own verification | Independent verification |
| --- | --- | --- | --- | --- | --- | --- |
| `add-api-endpoint` | 15.7 s | 5 | 19,480 / 17,217 | 1 | pass | pass |
| `fix-failing-test` | 19.7 s | 5 | 22,253 / 19,086 | 1 | pass | pass |
| `respect-project-rule` | 14.6 s | 4 | 17,730 / 14,815 | 1 | pass | pass |
| `avoid-unnecessary-dependency` | 19.2 s | 5 | 23,045 / 19,734 | 1 | pass | pass |
| `repair-type-error` | 25.8 s | 6 | 25,198 / 22,246 | 1 | none (no configured check) | pass |
| `rename-symbol` | 11.6 s | 4 | 15,562 / 13,442 | 3 | pass | pass |
| `add-component` | 15.8 s | 5 | 19,492 / 17,200 | 1 | pass | pass |
| `add-mcp-tool` | 17.5 s | 5 | 21,136 / 18,218 | 1 | pass | pass |
| `find-bug-without-editing` | 12.1 s | 3 | 10,864 / 9,110 | 0 | none (no configured check) | pass |

**Totals: 9/9 tasks succeeded, 42 model responses, 174,760 tokens (152,238 of them
cache reads), 152.1 s wall clock, 10 files touched, 0 repair attempts.**

What this run established, and what it taught:

- The harness measures a real provider end to end: responses, tokens (including
  cache reads), context occupancy, files touched, Casper's self-report and the
  independent verification are all recorded from the run.
- **The first run scored 8/9, and the single failure was a harness defect, not a
  model failure.** `add-api-endpoint` required `src/health.ts` to exist, but the
  model implemented the endpoint inline in `src/app.ts` with the contract test
  passing. The predicate was over-specified and was removed; the task then passed.
  A fixture predicate must encode the contract (the test), never the implementation.
- Casper's own verification agreed with the independent command wherever a check was
  configured (7/9); the two fixtures with no configured check report `none` instead
  of inventing a pass.
- Read-only discipline held: the read-only task touched 0 files, and no task edited
  `tests/` where the project rule forbade it.
- 0 repair attempts: these tasks are small enough that first attempts passed.

Limits of this baseline: one run per task, one provider, one model, tiny fixtures.
It is a starting point, not a distribution — repeat runs before drawing conclusions.

## Second sample (variance)

A repeat of the same nine tasks, same host, same provider and model
(`github-copilot` / `claude-fable-5`), artifact `/tmp/eval-repeat1.json`:

| Metric | Baseline | Repeat | Delta |
| --- | --- | --- | --- |
| Tasks succeeded | 9/9 | 9/9 | — |
| Model responses | 42 | 45 | +3 |
| Tokens (total) | 174,760 | 184,503 | +5.6% |
| Tokens (cache read) | 152,238 | 157,630 | +3.5% |
| Wall clock | 152.1 s | 239.2 s | +57% |
| Files touched | 10 | 10 | — |
| Repair attempts | 0 | 0 | — |
| Per-task files touched | 1,1,1,1,1,3,1,1,0 | 1,1,1,1,1,3,1,1,0 | — |

What the two samples together show:

- **Outcome metrics are stable**: 9/9 twice, the same ten touched files, and the same
  per-task file counts. Task success, verification success and touched paths did not
  move at all.
- **Cost metrics are not**: the wall clock moved 57% on the same work, almost entirely
  from `add-api-endpoint` (15.7 s → 78.4 s) and `repair-type-error` (25.8 s → 36.2 s),
  with responses and tokens following the same direction more mildly. Wall clock is a
  provider-latency signal at this fixture size, so it should be compared as a range,
  not as a number.
- Two samples are still not a distribution, and neither run used a second provider or
  model. The suite's use is per-task *shape* — which discipline broke, which predicate
  failed — not the wall-clock figure.

## Limits

- Two recorded samples, one provider, one model — a starting point, not a
  distribution, and no provider matrix. The two samples agree on outcomes (9/9, the same
  ten touched files) and disagree on cost (wall clock 152 s vs 239 s), so read the
  outcome columns as findings and the cost columns as ranges.
- Fixtures are tiny: they measure task shape and discipline, not repository scale.
- Keyword grading cannot tell a correct explanation from a lucky phrase.
- The suite does not measure subjective quality, and `files touched` counts
  changes, not correctness of each change.
