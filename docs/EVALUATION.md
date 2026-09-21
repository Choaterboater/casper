# Evaluation suite

Casper's own tests for agent behavior. The suite runs real tasks
against small fixture repositories and records numbers instead of impressions:
task success, verification success, model responses, files touched, repair
attempts, tokens and wall clock.

The harness is exercised without a model by `tests/eval-suite.test.ts`. Two local
samples each completed 9/9 small tasks with one provider/model; that is not a
competitive benchmark, provider matrix or proof of daily-driver reliability.

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
| `add-api-endpoint` | typescript-service + add-api-endpoint | `bun test` | fail | `src/` changed, `tests/` untouched |
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

## Limits

- Two recorded samples, one provider, one model — a starting point, not a
  distribution, and no provider matrix. The two samples agree on outcomes (9/9, the same
  ten touched files) and disagree on cost (wall clock 152 s vs 239 s), so read the
  outcome columns as findings and the cost columns as ranges.
- Fixtures are tiny: they measure task shape and discipline, not repository scale.
- Keyword grading cannot tell a correct explanation from a lucky phrase.
- Symbol-absence scans cover `.ts`, `.js`, `.json`, `.yaml`, `.yml`, `.md` and `.txt`
  files, not every possible language or binary format. Within that set, symlinks,
  unreadable/non-regular files and files over 1 MiB fail acceptance as **scan
  unavailable**; skipping a file never proves the symbol absent. Reads retain at
  most 1 MiB plus one overflow-detection byte per file. These observations remain
  non-atomic, not a defense against concurrent malicious filesystem changes.
- The suite does not measure subjective quality, and `files touched` counts
  changes, not correctness of each change.
