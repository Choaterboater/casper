# Verification and repair

Casper runs the project's checks itself after the model edits files, then prints a plain receipt
of what changed and what was verified. Whether it does so depends on the **verification mode**:

| Mode | After a model turn that changed files |
|---|---|
| `auto` | Casper runs the selected checks, hands failures to bounded repair, and records the results. The model may still use `casper_check` while iterating; its fresh passes are reused, not rerun. |
| `offer` | The model may use `casper_check`; nothing else runs. The receipt suggests `/verify`. |
| `off` | No managed checks during tasks. `/verify` still works. |

```bash
casper                               # interactive: auto, or offer once checks are known to be slow
casper "Fix the login flow"          # one-shot: auto
casper --verify "Fix the login flow" # auto for this run, even if configured otherwise
casper --no-verify                   # off for this run
casper "/verify"                     # all configured checks, no model
casper "/verify typecheck test"      # selected checks, in this order
casper "/verify repair test"         # start the model only if a check fails
```

**Choosing the mode.** A flag wins for its run, then `verification.mode`, then the default: Casper
checks its own work. Unconfigured sessions use `auto`, so the first change runs the checks with no
command from the user. An interactive session switches to `offer` once Casper has timed the selected
checks at 60 seconds or more in total (every check run records the timing, per project and exact
command), so a slow suite does not run after every change. Unconfigured one-shot prompts always use
`auto` (they cannot be offered anything); `--no-verify` turns checking off. When checking is only the
default and the project has no checks, a change is `not_verified` but exits 0; with `--verify` or
`verification.mode: auto` it exits 2.
Embedders pass `CasperApp({ verificationMode })`; `autoVerify: true|false` is shorthand for
`offer`/`off`.

**What auto runs.** The checks in `verification.checks`, or every check with a configured or
detected command. Auto runs nothing when the model changed no files, and skips a check whose
declared scope (below) contains none of the changed files. If Casper could not compare the
workspace, it runs every selected check. Changes but no configured checks is **incomplete**
(one-shot exit 2). Cancellation rules are unchanged.

**Exit codes.** A one-shot run exits 0 when done, 1 when a check or the run failed, 2 when
checks were incomplete, and 130 when cancelled. By default a pass that later went stale, or
changes nobody verified, still exit 0 and the receipt says "Not verified". Add
`--require-verification` (which implies `--verify`) to make those exit 3. See
[SCRIPTING.md](SCRIPTING.md) for the full table and `--json` events.

Casper runs the repository's own check commands. That is **not sandboxing or persisted repository
trust**, and it is not a separate yes/no: `auto` is the default, so asking for a change in a repository
runs its test, lint and build commands (and a repository's `.casper/project.yaml` can itself choose
`auto`). For a repository whose commands you do not trust, start Casper with `--no-verify`; a flag
wins over every configuration file.
Checks run without AI provider keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and the
other names Pi reads) and without Casper's own secret variables; everything else in your environment,
network product tokens such as `MIST_API_TOKEN` included, is still there. See [SECURITY.md](SECURITY.md).
Repair also authorizes model edits. **Native bash is unchanged:** a model's bash run of a check is
reported but never counted as verification.

## Receipts

Line 1 is the verdict, one of:

```
✓ Verified — the checks pass, and the tests fail without the change
✓ Verified — the checks pass; without the change the tests could not even load
• Checks passed — not proven: a refactor should not change behavior, so no test is expected to fail without it
✓ Checks passed — no files changed
✗ Failed — test failed
✗ Not checked — test timed out, so the change was not tested
• Incomplete — stopped after 3 turns (--max-turns); changes so far are kept; send another request to go on
• Not verified — the tests pass without the change too
✗ Stopped — cancelled; changes already made are kept
```

Before the first repair of a change, Casper runs each failing check on the files from before the change
(the copy it keeps for the proof). A check that failed there too was already broken: Casper says so, and
an interactive terminal asks `1 Fix it anyway · 2 Leave it` before paying for a repair (scripts repair).

A provider that answers with nothing ("empty response", which Pi does not retry itself) is retried
once; other errors are left to Pi's own retry budget; if it fails again, an interactive terminal asks `1 Retry · 2 Stop`.
When the model run fails after it edited files (a provider error, for example), Casper still runs the
checks on those edits, without a repair, and the verdict says how they fared (`✗ Failed — the model run
failed; changes already made are kept; the checks pass on those changes`), followed by a `• Next:` line
to try another model.

`Verified` means the checks passed on the final files and a test fails without the change (ADR 0001).
The JSON `outcome` and the exit code do not change with the verdict: a change whose checks pass but
that was not proven still has the outcome `verified`, and the JSON receipt's `proofSkipped` says why.
The lines below the verdict give the evidence:

```
✓ Changed 1 file: sum.js
✓ test passed (npm run test, 0.3s)
✓ test passed earlier in this task, reused (npm run test, 0.3s)
✗ test failed (exit 1) — log above; /verify repair test to fix
✗ test timed out after 10m — it did not finish, so it was not checked; /verify test to run it again, or raise verification.timeoutMs in .casper/project.yaml
✗ lint could not start (exit 127) — check verify.lint in .casper/project.yaml
• Not verified — test ran via bash only (npm test: passed). Run /verify test to record a check.
• Not verified — no checks configured. Add verify.test to .casper/project.yaml.
• Not verified — stale: files changed after the last passing test. Run /verify test.
• No files changed, so Casper ran no checks
✓ Proven: test fails without this change (exit 1) and passes with it
✓ Proven, weakly: test passes with this change; without it test crashed or was killed (exit 139) instead of failing
⚠ Not proven: test passes without this change too, and no test was added or changed
✓ Service api at 127.0.0.1:53121; smoke 2/2 passed (model-declared, run by Casper: create note failed before the change)
✗ Service api at 127.0.0.1:53121; smoke 0/1 passed; failed: create note (status 404, expected 201)
```

A check that timed out or could not start did not fail as a test, so Casper never repairs it on its
own: repair costs model tokens and cannot fix a slow suite or a missing tool. In an interactive terminal
Casper asks `test timed out after 10m. Casper did not try to fix it. What now?` with `1 Retry`,
`2 Fix it anyway` and `3 Allow more time` (four times the limit the check just had, at least a minute,
at most an hour, and again each time you choose it; the longer limit also applies to the model's own
runs of that check for the rest of the task; the choice names `verification.timeoutMs`, which keeps a
longer limit); Esc stops. It asks at most eight times per round of checks (the review round, when on, is a
second round). When the only failures are unfinished checks, the verdict is `✗ Not checked — test timed
out, so the change was not tested`, not `✗ Failed`; the outcome and exit code stay `failed`/1. Scripts and one-shot runs report the check and repair only real
test failures. A command that could not start is not saved as a check timing.

A pass marked `reused` did not run again: its declared inputs are unchanged since it passed earlier in
the same task (often the model's own `casper_check`), and the time is that earlier run's.

## Independent acceptance check (experimental)

Off by default. The hard-pack decision run (docs/evals/2026-09-26-hard-pack.md) found that every wrong
run passed the visible tests and the proof: the model's own tests missed the same requirement its
code did. With the check on, a change to code in auto mode whose checks passed and that was not left
unproven gets one more piece of evidence. It needs a `verify.test` command and runs whether or not
Casper proves the change, so server tasks and requests Casper does not prove (refactor, configure and
the like) are checked too.

```yaml
verification:
  acceptance: true   # or warn; default false
```

Casper makes one separate model call outside the conversation, with the conversation's model (or the
`review` role's) at low effort and an answer capped at 24,000 tokens. It sends the request, `CONTEXT.md`
and `AGENTS.md`, the changed code and up to two existing tests as style examples, and asks for one test
file with one test per requirement the request states, each named with a short quote of it, asserting
only what the request says. Casper saves the file next to the project's first test file (or in `tests/`),
runs `<verify.test> ./<file>` once and deletes the file, so the workspace ends as the model left it.

```
✓ Independent acceptance: tests written from the request alone pass
✗ Independent acceptance: tests written from the request alone fail: "rejects the 6th call"
⚠ Not confirmed by tests written from the request: "rejects the 6th call"; "counts per key"
• Independent acceptance not run: the acceptance answer had no test file
```

With `true`, a failure makes the change `not_verified` (exit 3 with `--require-verification`). With `warn`,
a failure never changes the outcome or exit code: the receipt's ⚠ line names the failing tests, which
quote the requirements the tests did not confirm (or says the tests fail when the output names none). A
pass or an error never upgrades anything. It is signal only: no repair round follows. Failing test names
are read from bun (`(fail) <name>`), jest and vitest (`✕`/`× <name>`) and pytest (`FAILED <path>::<name>`)
output, at most 20. The call's tokens join the task's usage. The JSON receipt carries `acceptance`
(`status`, `mode` `verdict` or `warn`, `reason`, `output`, `unconfirmed` when names were parsed) or `null`.
The test command must accept a file argument (`bun test`, jest, vitest, pytest). With a `review` model role
configured (`modelRoles.review` in `~/.casper/settings.json`, docs/CONFIGURATION.md), the tests come from
that model instead of the one that did the work; that role also serves delegated reviewer subagents.

## Request checklist

Before the model starts, Casper lists the concrete cases the request states, so the model's own tests
cover each one. On the hard eval pack it cut wrong runs from 7 of 48 to 2 of 48 at 1.06× Pi's wall time
(docs/evals/2026-09-27-request-checklist.md).

**On by default in interactive sessions for code changes** (requests Casper classifies as implement, fix
or test), where you see the list and can edit or skip it. Off for questions, docs, refactors and
configuration, and off in one-shot runs unless set:

```yaml
verification:
  checklist: true    # also in one-shot runs and for every request
  # checklist: false # never
```

Casper makes one separate model call outside the conversation, with the conversation's model (or the
`review` role's) at low effort and an answer capped at 24,000 tokens (at 8,000, a reasoning model often
ran out before listing anything on a long request). It sends only the request and asks for every
concrete behavior case it states (inputs and outputs, errors, boundaries, orders, formats), one short
line each quoting the request's specifics, leaving out process instructions such as which files to read.
It reads a JSON array; if the answer was cut off mid-array it keeps the complete cases, and if the model
wrote a bullet or numbered list instead it reads that. Casper keeps up to 80 cases of at most 200
characters and says how many more were left out, prints them and appends them to the task prompt, asking
for one test per case that asserts exactly that case:

```
Casper checklist (2 cases from your request):
  - limit(0) throws "limit must be positive"
  - the 6th call within a minute is rejected
```

In an interactive session on a rich terminal, Casper first opens the cases in the prompt editor, one per
line, so you can correct them before the model sees them. Enter starts the task with the lines as they
stand. You can change, add (Shift+Enter or Ctrl+J for a new line) or delete lines, and a leading `- ` is
dropped. Esc, or deleting every line, starts the task without a checklist (`[checklist] skipped; the task
starts without one`). Ctrl+C cancels the task. Edited lines get the same limits as the model's, and the
printed list says `edited by you` when you changed it. One-shot runs, `--json` and plain terminals use the
cases as listed, without a pause.

If the call fails or its answer has no list of cases, Casper prints one line
(`• Checklist not made: <reason>`) and the task runs unchanged. The checklist is guidance, not evidence:
the receipt text and outcome do not change. The call's tokens join the task's usage, the JSON stream
marks it with a `checklist` phase, and the JSON receipt carries `checklist` (the cases) or `null`.

## Requirements review

The requirements review is **off by default**. In pinned benchmarks it added no first-time-right
(the same runs were right first time with it off) while taking about 40% of Casper's wall time;
the checks and the proof, not the review, keep Casper at zero false "done". With it off, the first
turn of a **code change in auto mode** with a `test` check asks for the full checklist
(`- [x] requirement — test`, `- [ ] requirement — why not done`) and a test that fails without the
change; the receipt reports that checklist as the model's own claim, and the change is still proven.
To turn the round on:

```yaml
verification:
  review: true   # default false
```

With it on, when the checks pass on such a change (see below for what counts), Casper gives
the model one review round before proving the change: check every requirement the request and the
project docs (for example `CONTEXT.md`) state, one case at a time, confirm each is implemented and
tested, and fix any gap. The answer reports only the gaps and a count, not the requirements that were
already covered:

```
Requirements review:
- [x] unknown option exits 2 — tests/cli.test.ts       (a gap the review added a test or fix for)
- [ ] handshake timeout — not implemented              (a gap still open)
Covered: 5 of 6 requirements.
```

With no gaps it is just `Requirements review: all covered.` and `Covered: 6 of 6 requirements.`
(Re-listing every covered requirement made the round 41-44% of the wall time and its answer several
times longer, with no first-time-right gain in pinned runs.) The checks rerun only if the review
changed files. The receipt shows the review as **the model's own claim**, never as Casper's evidence:

```
• The model's review: all 6 requirements covered (1 gap fixed; its own claim, not checked by Casper)
• The model's review: 5 of 6 requirements covered (1 gap fixed; its own claim, not checked by Casper)
⚠ The model's review says not done: handshake timeout — not implemented
• The model's review returned no checklist
• The model's review stopped at its 12-turn budget (its own claim so far, not checked by Casper)
```

A `Covered:` line counts only at the start of a line and with its colon. When `n` is less than `m` and no open
line is listed, the receipt says `n of m requirements covered`, not all. A bare `Requirements review: all
covered.` with no `Covered:` line reads as all covered, without a number. An answer with a full checklist
but no `Covered:` line is still read, and reported without the gap count.

An item the model admits is not done makes the change `not_verified`. The review round has its own
budget of 12 model turns (a `--max-turns` at or below 12 wins and stops the task as usual, exit 2).
A review that hits its budget ends there; Casper keeps any checklist from its last answer, marks the
review `incomplete` (receipt line above, `"incomplete": true` in the JSON receipt's `review`) and
goes on as after a finished review: the checks rerun if the review changed files, then the proof.
An incomplete review alone does not make the change `not_verified`; open items it listed still do.
The proof repair round (below) has the same 12-turn budget; the checks and the comparison after it
decide.

The review costs one more model round per such request. With it on, such a change's first turn is the request as the user wrote it,
without Casper's task hints (project facts and selected skills still come first, with the request
labelled, and an under-specified target still gets the clarification nudge). The review then checks
every requirement, one case at a time (each missing option, each malformed value), reusing what
the model already read; if the tests also pass without the change, the proof round asks for one
that fails. In one pinned ablation the request alone was as accurate as the hinted first turn, with
fewer turns. If the work stops before the review (checks still failing after repairs, a turn
limit), no later round asks for tests.

## Proving the change

A passing test check only shows the tests still pass; they may not exercise the change at all. For
a **code change in auto mode** (`--verify`, or `verification.mode: auto`) with a `test` check
configured, Casper also asks whether the tests *prove* the change. A code change is any added,
changed or removed source file (by extension; tests, docs, data and configuration do not count),
made for any request except one Casper classifies as a refactor, docs, inspection, diagram or
configuration request. The work decides, not the wording: "add X; you may add test files" is still a
code change.

1. Before the model starts, Casper copies the workspace (copy-on-write where the file system allows;
   `.git`, `.casper`, `node_modules`, `.venv` (and `venv` when it holds a `pyvenv.cfg`) and Python caches
   are left out; `node_modules` and the virtual environment are linked back in). Runs in the copies set
   `UV_NO_SYNC=1`, so `uv run` never changes your linked `.venv`.
2. After the checks pass, it rebuilds the workspace **without the change**: the copy from before,
   with the tests (anything under a test directory, or named like a test) as they are now. It runs the
   `test` check there.
3. If that fails, it runs the same check on a copy of the current workspace. When that passes, the
   change is **proven**: the tests fail without it and pass with it. When it fails too, the copy
   cannot run the tests, and the receipt says Casper could not compare (never a false proof).
   The receipt names the exit code of the run without the change. A run that did not end as a test
   failure is weaker evidence and reads **Proven, weakly**: a timeout, a crash or signal (a shell's
   exit above 128), or a command that could not start (exit 126 or 127). A run with no exit status
   at all (killed before it could report one) is not proof: Casper could not compare.
4. If the check passes without the change, the change is **not proven**. Casper spends one repair
   round (within `repair.maxAttempts`) asking the model to add a test that fails without the change,
   then reruns the checks and the comparison.

An unproven change is not verified: its outcome is `not_verified` (`--require-verification` exits
3). A change Casper could not compare keeps its check result and says why. Test-only, docs-only or data-only changes, and refactor, docs, inspection, diagram and
configuration requests, need no proof. The comparison runs the test check once more
(twice when proven), so it adds that time to the run.

One-shot receipts name the next command as `casper "/verify repair test"`. `/receipt` (or
`--verbose` for a whole run) shows the detailed evidence form: command execution status, input
scope and freshness, reuse, and the "not independently certified" qualification described below.

## Smoke checks

A **smoke check** is an HTTP expectation Casper runs against one of the project's
[managed services](SERVICES.md). Configured checks live in `.casper/project.yaml`; the model can
record more during a task with the `service` tool.

```yaml
smoke:
  - name: list notes
    service: api                         # a declared service
    request: { method: GET, path: /notes } # also headers (strings) and body (a string, or JSON)
    expect:
      status: 200
      headers: { content-type: json }    # the header must contain this text (case-insensitive)
      json: [ ]                          # deep subset of the JSON body (see below)
      bodyMatches: '^\['                 # a regular expression on the body text
```

`expect` needs at least one of `status`, `headers`, `json` and `bodyMatches`, and every one given
must hold. `json` matches a subset: an object needs only the keys listed (each matching in turn), a
list needs each listed item to match some item of the actual list, and anything else must be equal.
`bodyMatches` runs in a separate process that is killed after a second, so a pattern that backtracks
badly fails the check ("took too long") instead of hanging Casper.
At most 8 checks, each at most 4 KiB as JSON, with unique names; `smoke` is a project setting only.
Invalid values stop configuration loading with the dotted path, for example
`smoke[0].service must name a declared service (api)`.

**Model checks.** `service` `check { name, service, request, expect }` records a check and runs it
once for its **baseline**, the result before the change. `replay { id }` reruns it. The tool asks
the model to record a check for new endpoint behavior before editing; Casper replays every recorded
check after the change. A model check is the model's expectation, run by Casper: the receipt says so.

**When they run.** In a task Casper verifies (`auto`, or `offer` once the model recorded a check),
smoke runs inside the same verify-and-repair loop as the command checks, after those pass. Configured
checks run after any change; recorded ones always run. Before each run Casper makes every referenced
service fresh: a service that is stale from edits, has crashed or no longer answers its readiness path
is restarted. A failing smoke check joins the normal repair prompt as smoke failure evidence and uses
the same `repair.maxAttempts` budget; there is no extra round. Smoke runs again after a repair, a
requirements-review edit or a proof repair. A standalone `/verify` runs only commands. When the
command checks still fail after the last repair, smoke never ran, and the receipt says
`• Smoke not run: command checks failed`.

**What counts.** A configured check is verification evidence when it passes against fresh services.
A model check counts only when its baseline failed and it now passes. A baseline that got no HTTP
response (a timeout, a reset connection) says nothing about the endpoint: it is recorded as
`incomplete` ("could not run before the change"), never as a failure. One whose baseline passed is
shown as an observation and never makes the outcome verified: with no command checks and only such
observations, the outcome is `not_verified`. Casper does not take the model's word that it recorded
before editing: a check recorded after an edit in the task (a native edit or write, or a shell command
after which the tree differs from the task's start) or during a repair, review or proof round has no
before-the-change baseline, so it is an observation too, and the receipt says `create note failed when
recorded, after edits — an observation, not proof`. A smoke failure left after the repairs makes the outcome
`failed`. A check that could not run (its service would not start) makes it `incomplete`, and so does any
managed service whose processes Casper could not confirm stopped, even when every check passed. The plain receipt gets one line with each service's address and the smoke tally; the
detailed receipt lists every check with its source, response status and baseline. `--json` carries the
report (see [SCRIPTING.md](SCRIPTING.md)). A passing smoke check shows what one request returned; it
does not certify the requested behavior as a whole.

## Page checks

In a web project, after a change Casper opens the changed pages itself and reports what each one
showed. It costs no model tokens, and it is decided by project facts only, never by the words of
the request:

- **A web project**: a declared `services.web` in `.casper/project.yaml`; a Next.js, Nuxt,
  SvelteKit, Astro, Angular, Vite, Vue or React project whose `dev` (else `start`) script runs a dev
  server Casper knows (Casper adds its own port flags, for example `vite --port $PORT --strictPort
  --host 127.0.0.1`); or a Streamlit app (`requirements*.txt` or `pyproject.toml` names streamlit,
  and `app.py` or `streamlit_app.py` imports it), run with the project's own `.venv` Python.
- **Changed files that reach a page**: file-routed frameworks map a changed page file to its address
  (`app/dashboard/page.tsx` opens `/dashboard`; Next.js `pages/`, SvelteKit `src/routes/`, Nuxt
  `pages/` and Astro `src/pages/` too). Other front-end changes (components, styles, an SPA's router,
  a Streamlit app) open `/`. A route that needs a value (`/devices/[id]`) is listed, not opened. At
  most 5 pages are opened per check. Docs-only changes open nothing. With no front-end framework
  (a declared `services.web` of an API), script edits are server code and open nothing; HTML, styles
  and files in `public/`, `static/` or `assets/` open `/`, and the `pages:` list is opened after any
  code change.

Page checks run only when Casper checks each change itself (`auto`), after the command checks and
smoke checks pass, inside the same verify-and-repair loop. Casper starts the dev server through
[managed services](SERVICES.md) and keeps it for the session, so later tasks reuse it; an edit makes
it restart before the next check. The first start in a session prints the command, because it runs
the project's own code:

```text
… Casper checking: typecheck, pages
… Starting dev server: bun run dev (it runs your project's code)
Dev server: bun run dev · http://127.0.0.1:41733 (stops when you leave Casper)
… Casper opening changed pages: /dashboard
```

The banner and `/status` name it too: `checks    typecheck, pages (bun run dev) — run after each change`.

Each page gets one receipt line:

```text
✓ /dashboard loads · 0 console errors
✗ /dashboard · 2 console errors: TypeError: Cannot read properties of undefined (reading 'map')
✗ /dashboard returned 500
✗ /dashboard shows an error: KeyError: 'site'
• /devices/[id] not opened: it needs a value for [id] (a fixed path can be set in .casper/project.yaml pages:)
```

A page fails on a console error or an uncaught page error, an HTTP status of 400 or more, a failed
request to the same site (500 or more, or no answer; other sites never count), or an error overlay:
Vite's and Next.js's, or Streamlit's in-page exception. Streamlit shows app exceptions in the page, not
the console, so Casper also reads the traceback the Streamlit server logs while the page loads. A
failing page is the receipt's first line (`✗ Failed — /dashboard has 2 console errors`) and goes to the
repair as page evidence (the console text, the error line and the server's last log lines, bounded and
with secrets hidden); the pages are planned and opened again after each repair. A page that loads says
**loads**, never "works": a pass never makes a change **Verified**. With only page checks, the receipt
says `• Checks passed — not proven: pages load, but no test fails without the change`; without Chrome it
says `pages answer, but their console was not checked` instead.

**Chrome.** Pages are opened in a fresh headless Chrome (`CASPER_BROWSER_EXECUTABLE`, else an installed
Chrome or Chromium; Casper never downloads one). Without Chrome, Casper only fetches the page and says so:
`✓ /dashboard answers (HTTP 200) · console not checked: no Chrome found (install Chrome or set
CASPER_BROWSER_EXECUTABLE)`. That is never a failure.

**When pages are not checked.** A project Casper can't start is a note, never a failure:
`• Pages not checked: node_modules is missing. Run bun install first (Casper doesn't install packages)`.
A dev server that stops before it is ready, or doesn't answer on its port in time (45 s for one Casper found), makes the check
incomplete, with the server's last lines. When the command checks still fail after the last repair, the
pages never opened: `• Pages not checked: command checks failed`.

**Settings** (`.casper/project.yaml` only; your own config can't set them):

```yaml
pages: [/, /dashboard]   # always open these after a code change (at most 8)
# pages: off             # never open pages
services:
  web: { command: bun run dev, port: auto, ready: { http: / } }   # how to start the dev server, if Casper can't tell
```

Only routes are found from files; for single-page apps and Streamlit, list the pages you care about.
The dev server runs the project's code with Casper's reduced environment (no provider keys, a separate
HOME), but it is not sandboxed yet and a page it serves can still reach the network: use page checks only
in projects you trust, or set `pages: off`.

## SQL migrations check

When the project has SQL migrations, Casper finds a `migrations` check: it applies the migrations, in
order, to a throwaway SQLite database that is deleted afterwards. The project's own database files are
never opened. It runs after each change to the migrations (or the Prisma schema), next to the other
checks, and with `/verify migrations` or the AI's `casper_check`.

- Folders: `migrations/`, `db/migrations/`, `sql/migrations/`, `drizzle/`, `supabase/migrations/`, and
  Prisma's `prisma/migrations/`. Plain ordered `.sql`, golang-migrate `.up.sql` (never `.down.sql`),
  dbmate `-- migrate:up` sections and drizzle's `--> statement-breakpoint` are understood.
- The database type comes only from the project: `schema.prisma`'s provider, `drizzle.config`'s dialect,
  or a SQLite driver dependency. Casper never guesses. Postgres (including `supabase/migrations`), MySQL
  or an unknown database is never run after changes; `/verify migrations` says why:
  `• Not verified — migrations not run: these are Postgres migrations (supabase/migrations), and Casper only has a throwaway SQLite`.
- Prisma runs `prisma migrate deploy` from the project's `node_modules` only when the schema reads its
  address from a variable; Casper points that variable at the throwaway file.
- Statements that could reach other files (`ATTACH`, `VACUUM INTO`, `load_extension`) are refused.

A failure names the file and SQLite's error: `✗ migrations failed (002_devices.sql failed — no such table: sites)`.
A project that names its own `verify.checks.migrations` keeps it instead.

## When repairs run out

After `repair.maxAttempts` repairs, an interactive session can offer one more try on your big model
(see docs/CONFIGURATION.md, "Your big model"). It is never automatic unless you set
`repair.bigModelLastTry: true` in your own config, and one-shot runs never ask. "Remember <command> as
this project's test command" on the row under a receipt saves `verify.test` in `.casper/project.yaml`
exactly as shown, keeping the file's comments (docs/TERMINAL_UX.md).

## Configuration

`.casper/project.yaml` can specify canonical checks:

```yaml
verify:
  typecheck: bun run typecheck
  lint: bun run lint
  test: bun test
  build: bun run build
verification:
  mode: auto         # auto | offer | off; unset = surface default (above)
  checks: [typecheck, test] # checks auto runs; default: all configured
  timeoutMs: 600000  # per command; default 10 minutes, maximum 1 hour
  scopes:            # optional, project-local declarations; NOT inferred coverage
    test:
      inputs: [src, tests, package.json, bun.lock, tsconfig.json]
      exclude: [tests/coverage] # only if this is generated output, not test input
repair:
  maxAttempts: 3     # repair prompts, not initial verification; 0 disables repair, max 10
```

`verify:` is project-local and overrides `commands:` and detected commands by check name. Only nonempty typecheck/lint/test/build commands are accepted there; other checks get a name of their own under `verify.checks.<name>` (a `run:` command, or a ready-made `preset:` that Casper runs without a shell). A named check runs after each change unless it says `after: ask`; a report (a diff) never makes a run pass or fail; a lab check runs only when you start it with `/verify <name>` and pick 2 Run on the lab in the numbered ask (see [NETWORK-CHECKS.md](NETWORK-CHECKS.md)). Ready-made checks Casper finds for Ansible playbooks are listed in the banner as found, not saved, and run only after you save one with `/verify add <name>`. `lab.hosts` is your own setting in `~/.casper/config.yaml` and a project file cannot set it. `verification.mode`, `verification.checks`, timeout and repair settings also work in global/profile configuration, with project settings taking precedence. Commands and declared input scopes are loaded at startup and frozen during repair; restart after changing configuration or manifests.

Managed checks run sequentially at the project root using the platform shell and inherited environment (minus AI provider keys). The tool accepts only a check name (`typecheck`, `lint`, `test`, `build`, or a named check that is not a lab check), not a command, scope, cwd, or timeout override. Check output the model reads (casper_check replies and repair prompts) has secret values hidden, the same way as bash output; named checks also get the device config rules. No dependency installation or missing-tool fallback is attempted. Requested absent commands are visible **skips**, never passes; an unavailable configured executable is a failure. `/verify` with no names runs typecheck → lint → test → build, then the named checks (never lab checks). Unselected categories are not required checks; selecting a missing command produces incomplete evidence.

Tool calls and post-task verification share one task-local evidence store. Concurrent managed calls serialize, and unchanged scoped passes are not executed again. At normal completion, selected passes with stale/unavailable freshness are rechecked once; known-invalidated failures are also rechecked before deciding on repair. Unknown/self-mutating inputs remain qualified rather than causing a freshness-seeking loop. Managed calls do not lock out native edits/bash or external writers: run checks after edits settle, and heed the non-atomic observation limits below.

A tool returns execution evidence to Pi's ordinary edit/check loop; it never starts a nested repair prompt. Unresolved actual failures reach the existing bounded repair owner after the main prompt settles, carrying the exact command, bounded output, exit status, available Git changed-file context, original request, and constraints. Post-task repair preserves that task's request; explicit `/verify repair` uses the objective of making the selected checks pass, not an unrelated earlier prompt. Failed checks rerun first; after they pass, multi-check selections revisit the full selection to catch regressions, reusing only passing results with matching **declared-input** evidence. A valid managed pass obtained during repair also avoids a duplicate command. New requests and explicit `/verify` calls always start fresh; captured old check tools are revoked. The model saying “done” is not a passing result. Up to three repair prompts run by default. Passing selected checks does not imply unselected checks passed.

The terminal shows the plain receipt and the tail of a failing check's output, not full logs; `--verbose` adds one evidence line per check run. Programmatic `CasperApp.runOnce()` returns a `VerificationReport` for verification runs, including all rounds. `getLastTaskResult()` returns a detached result for the last normal request, separating execution (`completed`, `failed`, `cancelled`) from optional verification; local commands clear this result. Coding requests print the plain receipt; `/receipt` prints the detailed execution/verification receipt, including bounded observed native edit paths, possible tool writes (including failed/partial writes), and exact-command shell observations. Successful general conversation without observed effects or verification omits that terminal receipt; the structured task result and local outcome are still retained. Failures/cancellation always remain visible. **Shell tool status is diagnostic data, not process-exit evidence:** native shell checks are not reused or counted as verifier passes. Terminal model error/abort stops skip further checks and repair, retain already-executed managed evidence as blocked, and produce CLI exit codes 1/130 rather than success; an intermediate provider error recovered by Pi is not a terminal failure. Otherwise verification exit codes remain 0 for pass, 2 for incomplete, and 1 for failure/blocked; completion without verification exits 0 without claiming verified behavior. Evidence includes cwd, command, status, exit code/signal, duration, stdout/stderr, failure reason, and truncation. Each stream retains at most 8 KiB of original bytes (head/tail plus a truncation marker); this bounded evidence is what repair receives. No evidence database or unbounded raw-log artifact is created.

**Command success, input freshness, declared scope, and behavioral coverage are separate facts.** Detailed reports (`/receipt`, `--verbose`) say `Checks pass (command execution)`; the plain receipt's `✓ test passed` line means the same: the named command, run by Casper, passed on the files as they were when it ran, not that the requested behavior is certified. Only the verdict `✓ Verified` adds that a test fails without the change. Stale or unavailable inputs remain explicitly unverified and cannot support reuse; they do not rewrite successful command exits or trigger a new repair/approval loop. Only actual check failures enter the existing bounded repair loop. Saved task outcomes and `/memory outcomes` retain exit codes, scope, freshness and a bounded freshness reason, without storing output or fingerprints. Human acceptance still starts unknown. Legacy outcomes remain readable, are labeled as legacy, and missing freshness stays unavailable.

`verification.scopes` is optional and project-local. Each check may declare literal relative `inputs` (files/directories, recursively; `.` means the project root) and optional `exclude` paths/subtrees. No globs, absolute paths, traversal, or fully excluded input roots; each list has at most 32 paths, each path at most 256 UTF-8 bytes, and each declaration at most 2 KiB. **No declaration means unavailable freshness and no reuse, not a command failure.** `.gitignore` is not an input contract: ignored files inside a declared scope are included unless explicitly excluded. Generated artifacts/coverage outside the input scope or explicitly excluded from it do not make a successful check stale.

Freshness is observed before/after each check and at report time; checks also refresh earlier evidence so one check cannot silently invalidate another. Observed native edit/write paths invalidate matching declared scopes even if later work restores directory membership, including edits overlapping a check. Native path syntax is expanded once before matching filesystem identities (including file URLs, tilde paths and aliases); an actual `@`-prefixed filename is not stripped again. Declared input roots are resolved too, including case aliases on case-insensitive filesystems, while exclusions retain the scope observer's traversal spelling. Observed included symlink entries also invalidate evidence, even when their targets are excluded or outside the scope and the links are later removed. Excluded links do not hide writes to included targets. Failed native writes conservatively invalidate possible partial changes without claiming a completed edit; missing targets retain their path beneath the nearest existing canonical parent. Possible case/Unicode aliases of the first missing entry (including a named input's parent) invalidate conservatively, and a missing suffix cannot establish an exclusion's traversal spelling. This may cause extra executions for ambiguous absent names even on case-sensitive filesystems; resolved prefixes and literal exclusions are not case-folded. Unresolvable or over-budget path observations conservatively invalidate scoped evidence. Resolved observations with neither an included target nor included symlink traversal do not invalidate other scopes, and observations do not select additional checks. Included file bytes/metadata and directory membership/modes are fingerprinted; named input creation/deletion invalidates previous evidence. Directory timestamps caused by excluded outputs do not affect the fingerprint. Included symlinks (including parents of named paths), special files, I/O errors, or limits (1 MiB/file, 16 MiB total, 4,096 work items, 500 ms checked between I/O operations) disable reuse with a specific reason. An unavailable before/after observation cannot later become a fresh check merely because the final observation succeeds.

The list of changed files comes from git in a git work tree: tracked files plus untracked files git does
not ignore, so an ignored `.venv` or build folder of any size never stops the receipt (an edit to an
ignored file, such as `.env`, is not listed). A nested repository or submodule is walked, and so is a
folder git lists nothing for (one an enclosing repository ignores). Outside git, Casper walks the folder.
Either way dependency trees, virtual environments and caches are left out, and the limit is 20,000 files.

**Declared scope is an assumption, not discovered dependency coverage.** For example, the sample above does not observe installed `node_modules`, environment variables, external tools or services. A lockfile does not prove installed dependencies are unchanged. If a check depends on excluded/unlisted inputs, changes there can go undetected: include them or leave the scope undeclared to disable reuse. Even a fresh scoped result does not certify behavior. These bounded observations are not atomic snapshots, a sandbox, or a guarantee against transient changes during commands or edits after reporting.

One-shot exit codes: **0** selected commands passed (execution only, even if freshness is stale/unavailable) or nothing needed verifying, **1** failed/blocked, **2** incomplete (skips, or auto mode with changes and no configured checks), **130** cancelled. Timeouts and cancellation terminate verifier process groups on POSIX; Windows terminates verified descendants through OS parentage, which has no real-host gate yet. One-shot SIGINT and any SIGTERM cancel checks and prevent further repair; the CLI gives cleanup up to one second, then exits even if runtime startup/abort is stalled. Interactive Ctrl-C cancels the active task while keeping the session; it drains existing cleanup without a forced per-task deadline. Programmatic `app.close()` drains runtime startup and verification before disposal but has no forced-exit deadline. Command timeouts do not bound model response time. Commands and runtime tools are not sandboxed, and command output may contain secrets—review your checks before sending their output to a model.
