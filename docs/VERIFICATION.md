# Verification and repair

**What this is:** how Casper checks the AI's work. After the model edits files, Casper runs the
project's own checks (tests, lint, type check, build), sends real failures back for a few repair
tries, and ends with a short receipt that says what changed and what was proven.
**When you'd use it:** every coding task uses it by default. Read this page to set up your checks,
to read a receipt, or to turn checking off for code you do not trust.

## Quick start

```bash
casper                               # interactive: checks run after each change (or are offered once known to be slow)
casper "Fix the login flow"          # one-shot: checks run after the change
casper --verify "Fix the login flow" # always run checks for this run, even if configured otherwise
casper --no-verify                   # no checks for this run
casper "/verify"                     # run typecheck, lint, test, build now, no model
casper "/verify typecheck test"      # only these checks, in this order
casper "/verify repair test"         # run the check; start the model only if it fails
```

Tell Casper your check commands in `.casper/project.yaml` (see [Configuration](#configuration)),
or let it find them (see [Where the checks come from](#where-the-checks-come-from)). The banner,
`/status` and `/project` show which checks will run.

**Trust first.** Checks run the repository's own commands, and Casper does not ask first: in
`auto` mode (the default) asking for a change runs the repository's test, lint and build commands,
and a repository's `.casper/project.yaml` can itself choose `auto`. In 0.2.15 that is **not a
sandbox** (nothing limits what those commands can touch). From v0.2.17 (not released yet) checks
run in the shell sandbox where it can run: they write only the project, temp and package caches,
can't read your private folders and reach only listed hosts (see [SECURITY.md](SECURITY.md)).
Where no sandbox runs (Windows, bubblewrap missing, `--no-sandbox`) they run with your
permissions. For a repository whose commands you do not trust, start Casper with `--no-verify`.
A flag wins over every configuration file.

From v0.2.16, checks run without AI provider keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` and the other names Pi reads) and without Casper's own secret variables;
everything else in your environment, network product tokens such as `MIST_API_TOKEN` included, is
still there.

## Verification modes

| Mode | After a model turn that changed files |
|---|---|
| `auto` | Casper runs the selected checks, sends failures to a limited number of repair tries, and records the results. The model may still use its `casper_check` tool while working; its fresh passes are reused, not rerun. |
| `offer` | The model may use `casper_check`; nothing else runs. The receipt suggests `/verify`. |
| `off` | No managed checks during tasks. `/verify` still works. |

**How the mode is picked.** A flag wins for its run (`--verify` means `auto`, `--no-verify` means
`off`). Next comes `verification.mode` from configuration. With neither, Casper checks its own
work: `auto`, so the first change runs the checks with no command from you.

An interactive session with no mode set switches to `offer` once Casper has timed the selected
checks at 60 seconds or more in total. Every check run records its time, per project and exact
command, so a slow suite does not run after every change. A one-shot run with no mode set always
uses `auto` (it cannot offer you anything).

Programs that embed Casper pass `CasperApp({ verificationMode })`; `autoVerify: true|false` is
shorthand for `offer`/`off`.

**What auto runs.** The checks in `verification.checks`, or every check that has a configured or
detected command. Auto runs nothing when the model changed no files. It skips a check whose
declared scope (see [Configuration](#configuration)) contains none of the changed files. If
Casper could not compare the workspace, it runs every selected check.

**No checks set up.** If files changed but there are no checks, the change is `not_verified`
(`• Not verified — no checks configured. Add verify.test to .casper/project.yaml.`). The one-shot
exit code depends on who asked for checking:

- checking only by default: exit 0;
- `--verify` or `verification.mode: auto`: exit 2;
- `--require-verification`: exit 3.

**Work in a project inside the folder (from v0.2.19).** When every changed file sits in one project
folder inside the open folder (Casper open in `~/Documents`, the work in `~/Documents/sample-tools`), and
the open folder is not a project or git repository itself, that project's own checks run for the
receipt: `… Casper checking: test (checks from sample-tools)` and
`✓ test passed (checks from sample-tools · python3 -m unittest discover -s tests)`. They run in the
sandbox, once, with no repair round. Then Casper asks `The work is in ~/Documents/sample-tools.` with
`1 Stay here · 2 Switch there`; Enter stays, and after Stay it doesn't ask about that folder again this
session. A one-shot run prints `[folder] The work is in ~/Documents/sample-tools. To work there: cd
~/Documents/sample-tools && casper`.

**`/verify` with nothing to run (from v0.2.19)** prints one line instead of one line per check:
`[verify] No checks found in Documents. Tests found in sample-tools: /project sample-tools`, or
`To add one: verify.test in .casper/project.yaml.` when no folder inside has tests. The receipt says
`• Not checked — no checks found in this folder` and a one-shot run exits 2, so a script never
passes with nothing checked. In a project that has only tests, `/verify` says
`[verify] No typecheck, lint or build command here, so Casper runs test.` and runs that.

**Bash runs do not count.** When the model runs a test through its own bash tool, Casper reports
it but never counts it as verification (`• Not verified — test ran via bash only …`).

## Exit codes

A one-shot run exits:

| Code | Meaning |
|---|---|
| 0 | Done. A pass that later went stale, checks that passed without proving the change, or changes nobody verified, still exit 0 and the receipt says why. |
| 1 | A check failed, checks were blocked, or the model run failed. |
| 2 | Incomplete: a selected check was skipped (it has no command), a smoke check could not run, `--max-turns` stopped the run, Casper stopped commands to another machine, or checking was asked for and no check exists. |
| 3 | Only with `--require-verification` (which implies `--verify`): the change was not verified. From v0.2.17 that includes checks that passed without a proof (`• Checks passed — not proven`). |
| 130 / 143 | Cancelled (Ctrl-C) / terminated (SIGTERM). |

See [SCRIPTING.md](SCRIPTING.md#exit-codes) for the full table and the `--json` events.

## Receipts

Every coding task ends with a receipt. When all is well it is one line: the verdict, the checks
that passed and the files changed.

```
✓ Verified · test passed · lint passed · 15 files changed · after 1 repair
```

Anything else puts the verdict on line 1 and each problem on its own short line under it (a failed
check, why the change is not verified, a file undo can't put back); what went well shares one `✓`
line. The per-file change table is behind `Diff` (`/diff`) and `--verbose`, and `/receipt` shows
the full form below. The `--json` receipt's `text` and saved receipts keep the full form.

The full form's line 1 is the verdict, one of:

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

(In a one-shot run the `--max-turns` line says `casper --continue to go on` instead of "send another
request".)

`Verified` means the checks passed on the final files **and** a test fails without the change
(ADR 0001). In 0.2.15 the JSON `outcome` and the exit code do not follow the wording of line 1:
a change whose checks pass but that was not proven by a failing test (for example a refactor)
still has the outcome `verified`. From v0.2.17 (not released yet) the outcome follows the verdict:
`verified` only for `✓ Verified`. A change whose checks pass but that was not proven has the
outcome `not_verified` (exit 3 with `--require-verification`) and `checksPassed` is `true`. Either
way the JSON receipt's `proofSkipped` says why it was not proven.

The lines below the verdict give the evidence:

```
✓ Changed 1 file: sum.js
✓ test passed (npm run test, 1.3s)
✓ test passed earlier in this task, reused (npm run test, 1.3s)
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
• Changes unknown: this folder has over 20,000 files; open a project folder
• Changed (seen by Casper's edit and write tools): lab.md
• Changed on 198.51.100.20 (build-server) (from the commands Casper saw): made an API token (pveum user token add …); installed a service (/etc/systemd/system/sampleapp.service)
• Ran commands on build-server over ssh; Casper can't tell from the command text whether they changed anything there
• Not run on 198.51.100.20 (build-server): 3 commands Casper stopped before they reached it
• Incomplete — commands to 198.51.100.20 (build-server) did not run
• A secret appeared in a command; change it after this task.
```

From v0.2.19 a check's time shows only from one second up (`✓ test passed (npm run test)` for a
quick one). The lines about other machines come from the text of the AI's ssh and scp commands, not
from the machine itself: Casper never logs in to check. They are there so a model's "nothing changed
on the server" never stands alone. When Casper stopped commands to another machine, the task is
never a clean pass: the verdict is `• Incomplete — commands to 198.51.100.20 (build-server) did not run`
(exit 2), even when the local checks passed.

A pass marked `reused` did not run again: its declared inputs are unchanged since it passed
earlier in the same task (often the model's own `casper_check`), and the time shown is that
earlier run's.

One-shot receipts name the next command as `casper "/verify repair test"`. `/receipt` (or
`--verbose` for a whole run) shows the detailed form: how each command ran, its input scope and
freshness, reuse, and the "not independently certified" note described in
[How checks are tracked](#how-checks-are-tracked).

### When a check fails

**Already broken before the change.** Before the first repair, Casper runs each failing check on
the files from before the change (the copy it keeps for the proof). If the check failed there
too, it was already broken: Casper says so, and an interactive terminal asks
`1 Leave it · 2 Fix it anyway` before paying for a repair (Enter leaves it; before v0.2.16 the
two were the other way round). Scripts repair.

**Timed out or could not start.** Such a check did not fail as a test, so Casper never repairs it
on its own: a repair costs model tokens and cannot fix a slow suite or a missing tool. In an
interactive terminal Casper asks `test timed out after 10m. Casper did not try to fix it. What
now?` with:

- `1 Stop`
- `2 Retry`
- `3 Fix it anyway`
- `4 Allow more time` — four times the limit the check just had (at least a minute, at most an
  hour), again each time you pick it. The longer limit also applies to the model's own runs of
  that check for the rest of the task. The choice names `verification.timeoutMs`, which keeps a
  longer limit.

Enter or Esc stops (before v0.2.16 there was no Stop choice and `1` was Retry). Casper asks at
most eight times per round of checks (the review round, when on, is a
second round). When the only failures are unfinished checks, the verdict is `✗ Not checked —
test timed out, so the change was not tested`, not `✗ Failed`; the outcome and exit code stay
`failed`/1. Scripts and one-shot runs report the check and repair only real test failures. A
command that could not start is not saved as a check timing.

**The model provider fails.** A provider that answers with nothing ("empty response", which Pi
does not retry itself) is retried once; other errors are left to Pi's own retries. If it fails
again, an interactive terminal asks `1 Stop · 2 Retry` (Enter stops; before v0.2.16 it was
`1 Retry · 2 Stop`). With your big model set, a third choice, Retry with your big model, comes
last. When the model run fails after it edited
files, Casper still runs the checks on those edits, without a repair, and the verdict says how
they fared (`✗ Failed — the model run failed; changes already made are kept; the checks pass on
those changes`), followed by a `• Next:` line suggesting another model.

## Independent acceptance check (experimental)

Off by default. **What it is:** a second opinion. A separate model call writes tests from your
request alone and runs them against the change. **Why:** in the hard-pack decision run
(docs/evals/2026-09-26-hard-pack.md), every wrong run passed the visible tests and the proof: the
model's own tests missed the same requirement its code did.

```yaml
verification:
  acceptance: true   # or warn; default false
```

With it on, a code change in auto mode whose checks passed, and that was not left unproven, gets
one more piece of evidence. It needs a `verify.test` command, and the test command must accept a
file argument (`bun test`, jest, vitest, pytest). It runs whether or not Casper proves the change,
so server tasks and requests Casper does not prove (refactor, configure and the like) are checked
too.

How it works:

1. Casper makes one separate model call outside the conversation, with the conversation's model
   (or the `review` role's, if set) at low effort and an answer capped at 24,000 tokens.
2. It sends the request, `CONTEXT.md` and `AGENTS.md`, the changed code and up to two existing
   tests as style examples.
3. It asks for one test file with one test per requirement the request states, each named with a
   short quote of it, checking only what the request says.
4. Casper saves the file next to the project's first test file (or in `tests/`), runs
   `<verify.test> ./<file>` once and deletes the file, so the workspace ends as the model left it.

```
✓ Independent acceptance: tests written from the request alone pass
✗ Independent acceptance: tests written from the request alone fail: "rejects the 6th call"
⚠ Not confirmed by tests written from the request: "rejects the 6th call"; "counts per key"
• Independent acceptance not run: the acceptance answer had no test file
```

- With `true`, a failure makes the change `not_verified` (exit 3 with `--require-verification`).
- With `warn`, a failure never changes the outcome or exit code. The receipt's ⚠ line names the
  failing tests, which quote the requirements they did not confirm (or says the tests fail when
  the output names none).

A pass or an error never upgrades anything. It is a signal only: no repair round follows. Failing
test names are read from bun (`(fail) <name>`), jest and vitest (`✕`/`× <name>`) and pytest
(`FAILED <path>::<name>`) output, at most 20. The call's tokens join the task's usage. The JSON
receipt carries `acceptance` (`status`, `mode` `verdict` or `warn`, `reason`, `output`,
`unconfirmed` when names were read) or `null`. With a `review` model role set (`modelRoles.review`
in `~/.casper/settings.json`, see [CONFIGURATION.md](CONFIGURATION.md#model-roles-and-automatic-effort)),
the tests come from that model instead of the one that did the work; that role also serves
delegated reviewer subagents.

## Request checklist

**What it is:** before the model starts, Casper lists the concrete cases your request states, so
the model's own tests cover each one. On the hard eval pack it cut wrong runs from 7 of 48 to 2 of
48 at 1.06× Pi's wall time (docs/evals/2026-09-27-request-checklist.md).

**On by default in interactive sessions for code changes** (requests Casper classifies as
implement, fix or test). Off for questions, docs,
refactors and configuration, and off in one-shot runs unless set:

```yaml
verification:
  checklist: true    # also in one-shot runs and for every request
  # checklist: false # never
```

How it works:

- Casper makes one separate model call outside the conversation, with the conversation's model
  (or the `review` role's) at low effort and an answer capped at 24,000 tokens (at 8,000, a
  reasoning model often ran out before listing anything on a long request).
- It sends only the request, and asks for every concrete behavior case it states (inputs and
  outputs, errors, limits, orders, formats), one short line each quoting the request's specifics.
  Process instructions such as "which files to read" are left out.
- It reads a JSON array. If the answer was cut off mid-array it keeps the complete cases; if the
  model wrote a bullet or numbered list instead, it reads that.
- It keeps up to 80 cases of at most 200 characters (one line says how many more were left out)
  and adds them to the task prompt, asking for one test per case that checks exactly that case.
  It does not print them before work.

**Seeing the list.** The receipt names the checklist only when something is wrong with it: a case
the model's own review says is not done, or cases that could not be confirmed because the checks
did not pass or did not run. `/receipt` lists every case.

```
⚠ 1 requirement not met, the model says: the 6th call within a minute is rejected — not implemented
• 26 cases from your request not confirmed: the checks did not pass (/receipt lists them)
```

**Editing the list.** When Casper suggests planning first (a request with several asks), the same
panel offers `3 Edit the cases first`. It opens the cases in the prompt editor, one per line, so
you can correct them before the model sees them.

- Enter starts the task with the lines as they stand.
- You can change, add (Shift+Enter or Ctrl+J for a new line) or delete lines; a leading `- ` is
  dropped.
- Esc, or deleting every line, starts the task without a checklist (`[checklist] skipped; the task
  starts without one`).
- Ctrl+C cancels the task.

Edited lines get the same limits as the model's. One-shot runs, `--json` and plain terminals use
the cases as listed, without a pause.

If the call fails or its answer has no list of cases, Casper prints one line
(`• Checklist not made: <reason>`) and the task runs unchanged. The checklist is guidance, not
evidence: the outcome and the JSON receipt's `text` do not change. The call's tokens join the task's usage,
the JSON stream marks it with a `checklist` phase, and the JSON receipt carries `checklist` (the
cases) or `null`.

## Requirements review

The requirements review is **off by default**. In pinned benchmarks it added no first-time-right
runs (the same runs were right first time with it off) while taking about 40% of Casper's wall
time. The checks and the proof, not the review, keep Casper at zero false "done".

**With it off**, the first turn of a **code change in auto mode** with a `test` check asks the
model to check every requirement and to end its answer with only the ones still not done
(`- [ ] requirement — why not done`), plus a test that fails without the change. A full ticked list
made answers long and is the model's own claim anyway. The receipt reports any open item as the
model's own claim (it makes the change not verified), and the change is still proven.

To turn the round on:

```yaml
verification:
  review: true   # default false
```

**With it on**, when the checks pass on such a change, Casper gives the model one review round
before proving the change: check every requirement the request and the project docs (for example
`CONTEXT.md`) state, one case at a time, confirm each is implemented and tested, and fix any gap.
The answer reports only the gaps and a count, not the requirements that were already covered:

```
Requirements review:
- [x] unknown option exits 2 — tests/cli.test.ts       (a gap the review added a test or fix for)
- [ ] handshake timeout — not implemented              (a gap still open)
Covered: 5 of 6 requirements.
```

With no gaps it is just `Requirements review: all covered.` and `Covered: 6 of 6 requirements.`
(Re-listing every covered requirement made the round 41–44% of the wall time and its answer
several times longer, with no first-time-right gain in pinned runs.) The checks rerun only if the
review changed files. The receipt shows the review as **the model's own claim**, never as
Casper's evidence:

```
• The model's review: all 6 requirements covered (1 gap fixed; its own claim, not checked by Casper)
• The model's review: 5 of 6 requirements covered (1 gap fixed; its own claim, not checked by Casper)
⚠ The model's review says not done: handshake timeout — not implemented
• The model's review returned no checklist
• The model's review stopped at its 12-turn budget (its own claim so far, not checked by Casper)
```

How the answer is read:

- A `Covered:` line counts only at the start of a line and with its colon.
- When `n` is less than `m` and no open line is listed, the receipt says `n of m requirements
  covered`, not all.
- A bare `Requirements review: all covered.` with no `Covered:` line reads as all covered, without
  a number.
- An answer with a full checklist but no `Covered:` line is still read, and reported without the
  gap count.

An item the model admits is not done makes the change `not_verified`.

**Turn budget.** The review round has its own budget of 12 model turns (a `--max-turns` at or
below 12 wins and stops the task as usual, exit 2). A review that hits its budget ends there;
Casper keeps any checklist from its last answer, marks the review `incomplete` (receipt line
above, `"incomplete": true` in the JSON receipt's `review`) and goes on as after a finished
review: the checks rerun if the review changed files, then the proof. An incomplete review alone
does not make the change `not_verified`; open items it listed still do. The proof repair round
(below) has the same 12-turn budget; the checks and the comparison after it decide.

The review costs one more model round per such request. With it on, such a change's first turn is
the request as you wrote it, without Casper's task hints (project facts and selected skills still
come first, with the request labelled, and an unclear target still gets the "ask first" nudge).
The review then checks every requirement, one case at a time (each missing option, each malformed
value), reusing what the model already read; if the tests also pass without the change, the proof
round asks for one that fails. In one pinned test the request alone was as accurate as the hinted
first turn, with fewer turns. If the work stops before the review (checks still failing after
repairs, a turn limit), no later round asks for tests.

## Proving the change

A passing test check only shows the tests still pass; they may not exercise the change at all.
For a **code change in auto mode** (the default, `--verify`, or `verification.mode: auto`) with a
`test` check configured, Casper also asks whether the tests *prove* the change.

A code change is any added, changed or removed source file (by file extension; tests, docs, data
and configuration do not count), made for any request except one Casper classifies as a refactor,
docs, inspection, diagram or configuration request. The work decides, not the wording: "add X;
you may add test files" is still a code change.

1. **Copy.** Before the model starts, Casper copies the workspace (copy-on-write where the file
   system allows). `.git`, `.casper`, `node_modules`, `.venv` (and `venv` when it holds a
   `pyvenv.cfg`) and Python caches are left out; `node_modules` and the virtual environment are
   linked back in. Runs in the copies set `UV_NO_SYNC=1`, so `uv run` never changes your linked
   `.venv`.
2. **Run without the change.** After the checks pass, Casper rebuilds the workspace **without the
   change**: the copy from before, with the tests (anything under a test directory, or named like
   a test) as they are now. It runs the `test` check there.
3. **If that fails**, it runs the same check on a copy of the current workspace. When that passes,
   the change is **proven**: the tests fail without it and pass with it. When it fails too, the
   copy cannot run the tests, and the receipt says Casper could not compare (never a false proof).
   The receipt names the exit code of the run without the change. A run that did not end as a
   test failure is weaker evidence and reads **Proven, weakly**: a timeout, a crash or signal (a
   shell's exit above 128), or a command that could not start (exit 126 or 127). A run with no exit
   status at all (killed before it could report one) is not proof: Casper could not compare.
4. **If it passes without the change**, the change is **not proven**. Casper spends one repair
   round (within `repair.maxAttempts`) asking the model to add a test that fails without the
   change, then reruns the checks and the comparison.

An unproven change is not verified: its outcome is `not_verified` (`--require-verification` exits
3). A change Casper could not compare keeps its check result and says why. Test-only, docs-only or
data-only changes, and refactor, docs, inspection, diagram and configuration requests, need no
proof. The comparison runs the test check once more (twice when proven), so it adds that time to
the run.

## Smoke checks

A **smoke check** is an HTTP request with an expected answer, which Casper sends to one of the
project's [managed services](SERVICES.md) (a dev server Casper starts for you). Configured checks
live in `.casper/project.yaml`; the model can record more during a task with the `service` tool.

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

**Rules.**

- `expect` needs at least one of `status`, `headers`, `json` and `bodyMatches`, and every one
  given must hold.
- `json` matches a subset: an object needs only the keys listed (each matching in turn), a list
  needs each listed item to match some item of the actual list, and anything else must be equal.
- `bodyMatches` runs in a separate process that is killed after a second, so a slow pattern fails
  the check ("took too long") instead of hanging Casper.
- At most 8 checks, each at most 4 KiB as JSON, with unique names. `smoke` is a project setting
  only.
- Invalid values stop configuration loading with the dotted path, for example
  `smoke[0].service must name a declared service (api)`.

**Model checks.** `service` `check { name, service, request, expect }` records a check and runs it
once for its **baseline**, the result before the change. `replay { id }` reruns it. The tool asks
the model to record a check for new endpoint behavior before editing; Casper replays every
recorded check after the change. A model check is the model's expectation, run by Casper: the
receipt says so.

**When they run.** In a task Casper verifies (`auto`, or `offer` once the model recorded a check),
smoke runs inside the same check-and-repair loop as the command checks, after those pass.

- Configured checks run after any change; recorded ones always run.
- Before each run Casper makes every referenced service fresh: a service that is stale from
  edits, has crashed or no longer answers its readiness path is restarted.
- A failing smoke check joins the normal repair prompt and uses the same `repair.maxAttempts`
  budget; there is no extra round. Smoke runs again after a repair, a requirements-review edit or
  a proof repair.
- A standalone `/verify` runs only commands.
- When the command checks still fail after the last repair, smoke never ran, and the receipt says
  `• Smoke not run: command checks failed`.

**What counts.**

- A configured check is verification evidence when it passes against fresh services.
- A model check counts only when its baseline failed and it now passes.
- A baseline that got no HTTP response (a timeout, a reset connection) says nothing about the
  endpoint: it is recorded as `incomplete` ("could not run before the change"), never as a
  failure.
- A model check whose baseline passed is shown as an observation and never makes the outcome
  verified. With no command checks and only such observations, the outcome is `not_verified`.
- Casper does not take the model's word that it recorded before editing. A check recorded after
  an edit in the task (a native edit or write, or a shell command after which the tree differs
  from the task's start), or during a repair, review or proof round, has no before-the-change
  baseline. It is an observation too, and the receipt says `create note failed when recorded,
  after edits — an observation, not proof`.
- A smoke failure left after the repairs makes the outcome `failed`.
- A check that could not run (its service would not start) makes it `incomplete`, and so does any
  managed service whose processes Casper could not confirm stopped, even when every check passed.

The plain receipt gets one line with each service's address and the smoke tally; the detailed
receipt lists every check with its source, response status and baseline. `--json` carries the
report (see [SCRIPTING.md](SCRIPTING.md#receipt-fields)). A passing smoke check shows what one
request returned; it does not prove the requested behavior as a whole.

## Page checks

New in v0.2.16 (not released yet).

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
HOME), in the shell sandbox where it can run: its files are held, but it keeps the machine's network so
the page can load (on macOS it reaches only listed hosts), and a page it serves can still reach the
network. Where no sandbox runs it has your permissions: set `pages: off` in a project you don't trust.

## SQL migrations check

New in v0.2.16 (not released yet).

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

New in v0.2.16 (not released yet).

After `repair.maxAttempts` repairs, an interactive session can offer one more try on your big model
(see [Your big model](CONFIGURATION.md#your-big-model)). It is never automatic unless you set
`repair.bigModelLastTry: true` in your own config, and one-shot runs never ask. "Remember <command> as
this project's test command" on the row under a receipt saves `verify.test` in `.casper/project.yaml`
exactly as shown, keeping the file's comments (see [TERMINAL_UX.md](TERMINAL_UX.md)).

## Where the checks come from

Casper knows four checks: `typecheck`, `lint`, `test` and `build`. For each one it uses, in order:

1. `verify:` in `.casper/project.yaml` (see [Configuration](#configuration));
2. `commands:` in `.casper/project.yaml`;
3. a command it detects in the repository (Node scripts, Python tools, `cargo`, `go`; see
   [CONFIGURATION.md](CONFIGURATION.md#detected-check-commands)).

From v0.2.16 (not released yet) a project can also name its own checks under
`verify.checks.<name>` (see [Configuration](#configuration)), Casper finds a `migrations` check
(see [SQL migrations check](#sql-migrations-check)), and it finds ready-made checks for Ansible
playbooks (see [NETWORK-CHECKS.md](NETWORK-CHECKS.md)).

From v0.2.19 a Python project with `test*.py` files that use `unittest`, and no pytest, gets
`python3 -m unittest discover -s tests` (or `discover` at the top). pytest-style files are not
counted, because `unittest` would run zero of them and still say OK.

`/project` shows the commands Casper found.

## Configuration

`.casper/project.yaml` can set the checks:

```yaml
verify:
  typecheck: bun run typecheck
  lint: bun run lint
  test: bun test
  build: bun run build
verification:
  mode: auto         # auto | offer | off; unset = Casper's default (see "How the mode is picked")
  checks: [typecheck, test] # checks auto runs; default: every check with a command
  timeoutMs: 600000  # per command, in milliseconds; default 10 minutes, maximum 1 hour
  scopes:            # optional; what each check reads (your statement, not discovered)
    test:
      inputs: [src, tests, package.json, bun.lock, tsconfig.json]
      exclude: [tests/coverage] # only if this is generated output, not test input
  # review: false    # requirements review round, see above
  # checklist:       # request checklist, see above (unset = interactive code changes only)
  # acceptance: false # independent acceptance check: true, warn or false
repair:
  maxAttempts: 3     # repair prompts after the first run of checks; 0 turns repair off, max 10
```

| Key | Where | Default |
|---|---|---|
| `verify.<check>` | project file only | none (detected commands are used) |
| `verification.mode` | any config file | unset: Casper's default |
| `verification.checks` | any config file | every check with a command |
| `verification.timeoutMs` | any config file | `600000` (10 minutes), 1 to `3600000` |
| `verification.scopes` | project file only | none (no reuse) |
| `verification.review` | any config file | `false` |
| `verification.checklist` | any config file | unset (interactive code changes only) |
| `verification.acceptance` | any config file | `false` |
| `repair.maxAttempts` | any config file | `3`, 0 to 10 |

"Any config file" means `~/.casper/config.yaml`, the profile's `config.yaml` or the project
file; the project file wins (see [CONFIGURATION.md](CONFIGURATION.md)).

- `verify:` overrides `commands:` and detected commands by check name. Only nonempty
  `typecheck`/`lint`/`test`/`build` commands are accepted there; anything else stops configuration
  loading. From v0.2.16, other checks get a name of their own under `verify.checks.<name>` (a
  `run:` command, or a ready-made `preset:` that Casper runs without a shell). A named check runs
  after each change unless it says `after: ask`; a report (a diff) never makes a run pass or fail;
  a lab check runs only when you start it with `/verify <name>` and pick 2 Run on the lab in the
  numbered ask (see [NETWORK-CHECKS.md](NETWORK-CHECKS.md)). Ready-made checks Casper finds for
  Ansible playbooks are listed in the banner as found, not saved, and run only after you save one
  with `/verify add <name>`. `lab.hosts` is your own setting in `~/.casper/config.yaml`; a
  project file cannot set it.
- Commands and declared scopes are read at startup and do not change during repair. Restart
  Casper after changing configuration or manifests.
- Casper runs the checks one at a time, at the project root, with the platform shell and your
  environment (from v0.2.16, minus AI provider keys). It does not install dependencies or fall back to another tool when one is missing.
- The model's `casper_check` tool takes only a check name (`typecheck`, `lint`, `test`, `build`,
  or from v0.2.16 a named check that is not a lab check), not a command, scope, folder or timeout.
  Check output the model reads (`casper_check` replies and repair prompts) has secret values
  hidden, the same way as bash output; named checks also get the device config rules.
- `/verify` with no names runs typecheck → lint → test → build, then the named checks (never lab
  checks). A check with no command shows as
  a **skip**, never a pass, and a skip makes the result incomplete. A configured command whose
  program is missing is a failure.
- Checks you did not select are not required. Passing the selected checks does not mean the
  others pass.

## How checks are tracked

This section is for readers who want the exact rules. Most users can skip it.

**Command success, freshness, scope and behavior are separate facts.**

- *Command success:* the named command, run by Casper, exited 0 on the files as they were when it
  ran. Detailed reports (`/receipt`, `--verbose`) say `Checks pass (command execution)`; the plain
  receipt's `✓ test passed` line means the same. It does not certify the requested behavior. Only
  the verdict `✓ Verified` adds that a test fails without the change.
- *Freshness:* whether the check's declared inputs are unchanged since it passed. Stale or unknown
  freshness stays "not verified" and blocks reuse, but does not turn a successful exit into a
  failure or start a new repair.
- *Declared scope:* the files you say a check reads (`verification.scopes`). It is your statement,
  not something Casper discovers.

**Shared evidence in a task.** The model's `casper_check` calls and the checks after the task
share one record per task. Parallel calls wait for each other, and an unchanged scoped pass is
not run again. At the end of a task, selected passes whose freshness is stale or unknown are
rechecked once, and failures whose inputs changed are rechecked before deciding on repair. Checks
do not lock out the model's own edits, its bash, or other programs: run checks after edits
settle.

**Repair.** A check tool only returns results to the model's normal edit-and-check loop; it never
starts a repair of its own. Real failures left when the main prompt ends go to the repair loop,
with the exact command, a limited amount of output, the exit status, the git changed-file list
where available, the original request and your rules. Post-task repair keeps that task's request;
`/verify repair` asks the model to make the selected checks pass. Failed checks rerun first; after
they pass, a multi-check selection runs again in full to catch regressions, reusing only passes
whose declared inputs are unchanged. New requests and each `/verify` start fresh. The model saying
"done" is not a passing result. Up to three repair prompts run by default.

**What is kept.** The terminal shows the plain receipt and the end of a failing check's output,
not full logs; `--verbose` adds one line per check run. Each output stream keeps at most 8 KiB
(start and end, with a marker where it was cut); that is what repair receives. No log database or
unlimited raw log file is created. Saved task outcomes and `/memory outcomes` keep exit codes,
scope, freshness and a short reason, but no output. Your own acceptance (`/memory accept`) starts
unknown. Older saved outcomes stay readable and are labeled as legacy.

**For programs embedding Casper.** `CasperApp.runOnce()` returns a `VerificationReport` for
verification runs, including all rounds. `getLastTaskResult()` returns the result of the last
normal request, keeping execution (`completed`, `failed`, `cancelled`) separate from verification;
local commands clear it. `/receipt` prints the detailed receipt, including native edit paths,
possible tool writes (including failed or partial writes) and shell commands seen. A plain
conversation with no file effects and no verification prints no receipt; failures and
cancellation are always shown. A model error or stop at the end skips further checks and repair,
keeps what already ran as blocked, and exits 1 or 130; a provider error that Pi recovered from is
not a failure.

**Declared scopes.** `verification.scopes` is optional and project-only. Each check may list
literal relative `inputs` (files or folders, read recursively; `.` means the project root) and
optional `exclude` paths.

- No wildcards, absolute paths, `..`, or inputs that are fully excluded. Each list holds at most 32
  paths, each path at most 256 bytes, each declaration at most 2 KiB.
- **No declaration means unknown freshness and no reuse, not a failure.**
- `.gitignore` does not count: ignored files inside a declared scope are included unless you
  exclude them. Generated files outside the scope, or excluded from it, do not make a pass stale.
- Casper fingerprints the included files' bytes and metadata and each folder's list of entries.
  A symlink, special file, read error or size limit (1 MiB per file, 16 MiB total, 4,096 items,
  500 ms) turns reuse off with a reason.
- Casper looks at the files before and after each check and at report time. Any edit, write or
  failed write by the model to a path inside a scope makes that check stale, even if later undone;
  a path it cannot resolve makes every scope stale. Ambiguous names (case or Unicode spelling) are
  treated as a change, which can cause extra runs.
- **A declared scope is your assumption, not discovered coverage.** The example above does not
  watch installed `node_modules`, environment variables, outside tools or services, and a lockfile
  does not prove installed packages are unchanged. If a check depends on files outside its scope,
  changes there can go unnoticed: include them, or leave the scope undeclared to turn reuse off.
  These observations are not a frozen copy of the files or a sandbox, and changes during a command or after
  the report can be missed.

**Changed files.** In a git work tree the list of changed files comes from git: tracked files plus
untracked files git does not ignore, so an ignored `.venv` or build folder of any size never slows
the receipt (an edit to an ignored file, such as `.env`, is not listed). A nested repository or
submodule is walked, and so is a folder git lists nothing for (one an enclosing repository
ignores). Outside git, Casper walks the folder. Either way dependency trees, virtual environments
and caches are left out, and the limit is 20,000 files.

**Stopping.** Timeouts and cancellation stop the check's whole process group on Linux and macOS.
Windows stops the check's child processes it can trace; that has not been tested on a real
Windows host yet. In a one-shot run, Ctrl-C (SIGINT) or SIGTERM cancels checks and any further
repair; the CLI gives cleanup up to one second, then exits anyway. Interactive Ctrl-C cancels the
active task but keeps the session. Programmatic `app.close()` waits for startup and checks to
finish, with no forced deadline. Command timeouts do not limit how long the model takes to answer.

**Secrets in output.** In 0.2.15 commands and the model's tools are not sandboxed. From v0.2.17
commands run in the shell sandbox where it can run, and without it when no sandbox is there
(Windows, bubblewrap missing, `--no-sandbox`). Either way command output may contain secrets. Review your checks before their output is sent to a model.
