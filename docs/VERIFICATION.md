# Verification and repair

**What this is:** how Casper checks the AI's work. After the model edits files, Casper runs the
project's own checks (tests, lint, type check, build), sends real failures back for a few repair
tries, and ends with a short receipt that says what changed and what was proven.
**When you'd use it:** every coding task uses it by default. Read this page to set up your checks,
to read a receipt, or to turn checking off for code you do not trust.

## Quick start

```bash
casper                               # interactive: checks run after each change (or are offered once known to be slow)
casper -p "Fix the login flow"       # one-shot: checks run after the change
casper -p --verify "Fix the login flow" # always run checks for this run, even if configured otherwise
casper --no-verify                   # no checks for this run
casper -p "/verify"                  # run typecheck, lint, test, build now, no model
casper -p "/verify typecheck test"    # only these checks, in this order
casper -p "/verify repair test"      # run the check; start the model only if it fails
```

**Since v0.2.36:** `-p` / `--print` explicitly runs once. With stdin and
stdout both TTYs, no forcing flags and `CI` unset, `casper "your request"` instead starts a session
with that first request. Existing scripts stay one-shot; receipts and exit codes are unchanged.
See [SCRIPTING.md](SCRIPTING.md).

Tell Casper your check commands in `.casper/project.yaml` (see [Configuration](#configuration)),
or let it find them (see [Where the checks come from](#where-the-checks-come-from)). The banner,
`/status` and `/project` show which checks will run.

**Trust first.** Checks run the repository's own commands, so they run only in a folder you trusted.
The first time a session opens a folder, Casper asks `Trust <folder>? It would run: npm test, npm run
lint.` with `1 Not now · 2 Trust this folder` (Enter is Not now). Trust is saved for that folder; Not now
lasts this session and Casper asks again next time. Saying "trust this folder" (or `/trust`) trusts it
later, and "stop trusting this folder" (`/trust off`) takes it back.

In a folder you haven't trusted:
- Casper runs no checks, page checks, services or smoke checks, whatever its `.casper/project.yaml`
  says. The banner, `/status`, `/verify` and the receipt say why.
- Where no sandbox runs, the AI asks before the project's scripts, builds, tests and installs
  instead of running them as routine work. You can still read and edit.

Your home folder and the top of a drive are never trusted and never asked about. Folders Casper had
already opened before it asked count as trusted. A folder inside a trusted one is covered by it,
unless it is a repository of its own (one you cloned there asks for itself). A worktree of a trusted
repository counts as that repository. A project Casper made for you opens trusted. A run that can't
ask (`-p`, `--json`, piped, `CI`) is trusted for that run, as Claude Code's `-p` is: starting it
there is your choice. `--no-verify` still turns checks off.

Since v0.2.17 checks run in the shell sandbox where it can run: they write only the project, temp and
package caches, can't read your private folders and reach only listed hosts (see
[SECURITY.md](SECURITY.md)). Where no sandbox runs (Windows, bubblewrap missing, `--no-sandbox`) a
trusted folder's checks run with your permissions. A flag wins over every configuration file.

**When the sandbox, not your code, fails a check.** Real test suites sometimes need what the sandbox
refuses: unix sockets, a loopback address like `127.0.0.2`, `/dev/fd`, or a browser or terminal
multiplexer started by a test. Such a check prints `EPERM`, `Operation not permitted`, or (Chromium on macOS)
`bootstrap_check_in ... Permission denied (1100)`. Casper reads that as "could not check", not a bug: the receipt says `✗ test — blocked by the sandbox (...)`, it says plainly
`This check failed because Casper's sandbox blocked something, not because of a bug in your code. Run it
yourself with !<command> or allow checks outside the sandbox`, and it starts no repair and edits no test.
When the only checks that did not pass never ran (blocked like this, timed out, or could not start), the
task ends incomplete (exit 2), not failed (exit 1): exit 1 means a check ran against your code and failed. So
does a check that passed but left something running (a server or browser its tests started kept its output open):
it never counts as a pass, it is not repaired, and `/verify <check>` runs it again.
In a session Casper then asks `Run this project's checks outside the sandbox?` with `1 No · 2 Yes, this once ·
3 Yes, for this session · 4 Yes, always for this project`; Enter is No. "This once" runs only the blocked
checks again outside the sandbox. "Always" is kept privately in `~/.casper` (never in the repo), is listed
by `/allowed` and taken back with `/allowed forget`. A result that ran outside shows `outside the sandbox`.
You can decide ahead of time in your own `~/.casper/config.yaml`: `sandbox: { checks: outside }` always
runs the checks outside, `inside` never does and never asks; the default is `ask`. A repository's
`.casper/project.yaml` cannot set it. `/permissions details` shows the setting and a remembered "always";
`/permissions all` ("stop asking until I quit") never answers this question for you. Outside the sandbox the checks run the AI's edits with your
permissions, so say yes only for a project you trust.

**Only prose changed.** An edit that touches only Markdown or text files (`.md`, `.mdx`, `.txt`, `.rst`,
`.adoc`) runs no check that has no declared `scope`, and the receipt says
`Checks skipped — only documentation changed (...)`; `/verify` runs them anyway. A check with a declared
scope that covers those files (a docs test) still runs. YAML and JSON are not skipped: a check may read them.

**Only a running app's database changed.** A SQLite database and its journal (`.db`, `.db-wal`, `.db-shm`, `.db-journal`, and the same
for `.sqlite`) is what an app running next to its code writes all the time; when only those changed, the receipt
says `Checks skipped — only a running app's database files changed (...)`. The database file itself counts as data too.

**Changed by something else.** Casper notes when each of the AI's tools that may write runs (any tool but reads,
searches and one plain `ssh <machine> '...'`). A file whose time of change falls while none of them ran (the AI
read, searched, or waited on its own question) is another program's: an editor, a second AI tool, a running app.
It is listed as `Changed by something else while Casper worked (not checked)`, and is not checked, offered as "The
work is in ..." or touched by undo. A file the AI's `edit` and `write` tools named, or one that changed while one of
its tools ran, stays the AI's. A deleted file (it has no time of its own) or a change while a command or service the
task left running could still write stays the AI's on the receipt, and `/undo` asks before touching it
([UNDO.md](UNDO.md#the-rules)). `tests/changed-by-others.test.ts` covers this.

**Work outside this folder.** Before the first AI command that works in a repository or folder outside this one
(the folder it starts in, `cd`, `pushd`, `git -C`, or a path inside a repository) or an `edit` there, Casper notes its
state: a repository's HEAD and the files git shows as changed, or a small folder's files. The receipt compares
again and says `Changed outside this folder: ~/Documents/other: 7 files (api.py, sensor.py, source.py …); committed
1a2b3c4 (no undo copy)`, or `May have changed outside this folder: … (Casper couldn't compare it: …)`, however the
files were written. When the task changed nothing in this folder and its work is in such a repository, line 1 says
`Not verified — the work was in ~/Documents/other, outside this folder; Casper didn't run its checks`, never "only
documentation changed". A test run the AI made there is named (`The AI ran tests in ~/Documents/other itself (not
counted)`) and not counted. After the receipt, `The work is in ~/Documents/other. 1 Stay here · 2 Switch there`
offers to move there, where `/verify` runs its checks. Casper only reads those places, and undo never reaches them.
`tests/outside-receipt.test.ts` and `tests/outside-work.test.ts` cover this.

**Published.** What the AI's commands sent out is on the receipt's Changed row, read from each successful command
and what it printed: `Published: pushed main and tag v0.3.5 to owner/repo; created GitHub release v0.3.5 (can't be
undone with /undo)`. It covers `git push` (branches and tags, from git's own output), `gh release` and `gh pr`
create and merge, `npm`/`pnpm`/`yarn publish`, `cargo publish`, `twine upload`, `uv publish` and `docker push`.
Casper never asks GitHub or a registry. `tests/published.test.ts` covers this.

From v0.2.16, checks run without AI provider keys (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` and the other names Pi reads) and without Casper's own secret variables;
everything else in your environment, network product tokens such as `MIST_API_TOKEN` included, is
still there.

## Branch movement in the change list

A task that moves HEAD or switches branches gets one receipt line:

```
– The branch moved during this task: changes git brought in are not counted, and undo leaves them alone
```

The change list and `/diff` exclude incoming branch changes whose final bytes match the new committed
version (including incoming additions and deletions). Commits made during the task, including amend and
cherry-pick, remain the task's work: their changed files count even with a clean working tree or a later
restore to the starting bytes. HEAD reflog transitions distinguish these from incoming movement; an
unreadable or ambiguous history reports uncertainty instead of guessing. Files the task also edited remain;
for paths git touched, the diff starts at the new HEAD, not the old folder copy. Undo leaves overlapping
files with a plain reason. If Casper cannot read the branch baseline, it reports changes as unknown and
refuses Undo rather than guessing. Normal tasks and non-git folders are unchanged. See [Undo](UNDO.md).

## Iteration checks and the final configured test

For the known Bun test entrypoints `bun test` and `bun .casper/quick-test.ts` (also `bun run
.casper/quick-test.ts`), Casper splits a model task's test runs without editing your check configuration
or scripts. During work and repair, it runs typecheck and lint as selected, and invokes
`bun test --parallel=4` with only changed test files and tests that import changed files. Other selected
automatic checks (such as build) wait for the final batch; explicitly requested checks still run directly. The import
graph includes transitive imports, re-exports, literal dynamic imports and `require`; it does not execute
project code to discover tests. Fixture directories, dependencies and build outputs are not test roots.
Type-only dependencies are covered by typecheck, not this runtime-import selection.

An empty or unavailable graph is a visible deferred skip, never a pass and never permission to start
the broad suite during iteration. Runtime-computed imports and tests that read documents/data without
importing them may not be selected; the final configured command covers those cases. Proof copies use
the same selected test argv, rather than invoking quick-test again. Selection is bounded; an unreadable,
invalid or oversized graph defers to the final run.

After all model, review and browser-repair edits, **before the receipt**, Casper runs your unchanged
configured test command once. A targeted pass cannot substitute for it. A final failure remains a failure;
a final green cannot erase an unresolved targeted failure. Casper starts no repair/rerun loop for that
final command. Cancelled/stopped tasks and unchanged tasks with no requested checks start no final command. A crew's final
full sweep counts as that run rather than duplicating it. Explicit `/verify` still runs the configured
command directly; custom runners, shell pipelines and Bun commands with extra flags retain their current
behavior rather than being guessed at. Test evidence identifies iteration runs as `testPhase: changed`.
The split does not change sandbox, timeout, cancellation or command-approval rules.

Never rewrite `.casper/project.yaml` or a check script to narrow or speed it up. Use targeted `bun test`
commands directly for additional diagnostics. Casper owns this per-change/final invocation split, not the
model. The owner's configured quick-test selection still runs once at task finish.

## Changing configured checks

The AI cannot silently replace the project's configured checks or the scripts they name. Native
edit/write asks **Change the test check for this project?**, with the old → new text and No first.
An approved saved command replacement takes effect for the current task too. For a replacement of an
existing command, **Use this command for this session only** updates the active check registries without
writing the file; it ends when this Casper session closes. The edit shows a quiet `– kept .casper/project.yaml as it is: session-only check in use`, not a red failure. Further check-file edit attempts in that task keep the files without asking again; Casper uses the session-only command instead. A later task can ask again. Script rewrites otherwise need an explicit save.
No, Enter, cancellation or a run that cannot ask leaves the file unchanged. Unrelated project settings
remain ordinary edits. Shell commands targeting a possible check rewrite (including directory copies)
are refused and directed to native edit/write so the exact change can be shown. Plain reads and copying
checks to unrelated files are not rewrites; other shell permission rules still apply. Paths are read as the
shell reads them: `~` and `$HOME` are your home folder and `~+` and `$PWD` the folder the command runs in.
In a copy's destination, a brace list `{a,b}` is each of its words, and a glob is matched against the checks
and their folders. So copying or moving files out of the project, to a folder written any of those ways, is
never refused, and a write to a check through `~` is refused like any other. A copy's destination Casper
can't know (a variable or a command at its start, another user's `~name`, or a `..` after an unknown part)
is refused as before, with a message that names the destination it couldn't read: write it as a plain path.
This text guard is
not an operating-system sandbox against opaque scripts. User-issued setup commands keep their own flows.

## Working on Casper's own tests

While working, run typecheck, lint and targeted `bun test --parallel=4 tests/example.test.ts` commands.
Run the full set once at the end, at width four maximum; CI runs everything. Do not narrow the owner's
configured check to save time. Keep at most two Casper sessions/crews building on a machine.

`tests/support/preload.ts` clears ambient CI, git overrides, colour, agent and credential state before
loading each test file. It supplies a throwaway HOME, XDG folders and an ordinary empty git config file
for both `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`, including on Windows. Bun caches `os.homedir()` at
startup: pass a fixture home to code paths that take one, or launch a child with HOME/USERPROFILE set
when testing native home resolution. Never monkey-patch built-ins globally. A test needing an env
setting supplies it explicitly: `cleanEnv(extra)` for child processes, or serial `await withEnv(extra, body)` for in-process
fixtures (restored in `finally`, including on rejection). Pass a source env as cleanEnv's second argument
for pure env tests. Never mutate the platform. Screens use `tests/support/private-tmux.ts`: private
`tmux -L`, throwaway HOME, cleanup in `finally`.

For a suspected flake, use **Actions → Deflake one test file** (`.github/workflows/deflake.yml`): choose
one `tests/*.test.ts` file, 1–100 independent runs and Linux, macOS or Windows. Inspect every run's logs
and the pass/fail counts in the summary/artifact; a skipped test is not evidence. Do not merge a green
rerun after a PR's own new/changed test failed. Prove it with this workflow, then fix it or record its
owner, OS and reason in `tests/known-flaky.ts`. Observations there do not enable assertion retries;
`tests/flaky-list.test.ts` still guards the separate timeout-only retry allowlist.

## Verification modes

| Mode | After a model turn that changed files |
|---|---|
| `auto` | Casper runs the selected checks, sends failures to a limited number of repair tries, and records the results. The model may still use its `casper_check` tool while working; its fresh passes are reused, not rerun. |
| `offer` | The model may use `casper_check`; no automatic app smoke runs. The receipt suggests `/verify`, which also tries the offered app. |
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

**Crews' combined result.** When builders land parts, `auto` mode finishes with one
full selected-check batch after the reviewers, fix round and later repairs, without
scope/prose pruning or reuse of per-part passes. A whole batch already run on that
same combined result counts once; later edits or reviews require a fresh batch.
The receipt labels it `Crew full checks on the combined result` and shows its status
and check names. This final sweep does not start more repairs. `offer`, `off`,
stopped tasks and device/manual-only checks keep their normal limits; the receipt
explains a sweep that did not run. See [Crews](CREWS.md).

**No checks set up.** If files changed but there are no checks, the change is `not_verified`
(`– Not checked — no tests yet. Say "add tests".`), and the model writes tests and the check when
you ask. When the project has tests but no command runs them (Jest-style tests and no `test` script, or pytest
tests in a project that doesn't list pytest), the line is
`– Not checked — Casper found tests but no command that runs them. Say "set up the test command".` instead, with
the same outcome and exit code. The startup banner shows no checks line until there is something to check; `/status`
says `none yet; say "add tests" and Casper writes some` (or `none: Casper found tests but no command that runs them;
say "set up the test command"`). The one-shot
exit code depends on who asked for checking:

- checking only by default: exit 0;
- `--verify` or `verification.mode: auto`: exit 2;
- `--require-verification`: exit 3.

**Work in a project inside the folder (from v0.2.19).** When every changed file sits in one project
folder inside the open folder (Casper open in `~/Documents`, the work in `~/Documents/sample-tools`), and
the open folder is not a project or git repository itself, that project's own checks run for the
receipt: `• Casper checking: test (checks from sample-tools)` and
`✓ test passed (checks from sample-tools · python3 -m unittest discover -s tests)`. They run in the
sandbox, once, with no repair round. Then Casper asks `The work is in ~/Documents/sample-tools.` with
`1 Stay here · 2 Switch there`; Enter stays, and after Stay it doesn't ask about that folder again this
session. Switch there takes the conversation with it: it is copied into that folder (so `/resume` there lists
it; the one here stays as it was), and the next request continues it there
(`[folder] This conversation came with you: your next request continues it there.`). Before the model starts, a request that names another project Casper has had conversations in (by its
folder name, or a link ending in it; a plain-word name such as `review` only where the request points at a folder:
"move to review", "the review project") asks `This request names casper-tools, in ~/Documents/casper-tools.` with
`1 Stay here · 2 Move there`: Move runs the request there (in a new conversation when one had started here, which
stays in /resume). Only the saved conversations' folders are matched; Casper never searches for the project. A one-shot run prints `[folder] The work is in ~/Documents/sample-tools. To work there: cd
~/Documents/sample-tools && casper`. In a folder Casper can't compare (over 20,000 files, as a Documents folder
holding many projects often is, or with a folder it can't read, as a NAS's `docker` folder of app folders is), the work
folder is found from the files Casper's edit and write tools changed, even when the open folder is a project or
repository itself; what a shell command changed there is not counted. An app folder with its own compose file counts as
a project: only its compose file is checked (`• Casper checking: compose (checks from cloudflared)`), never every app's.
When such a folder opens, one line says so and names the folder to open instead: `[folder] Casper can't read some
folders in this folder, so undo and the list of changed files are off here. To have them for one app, open its folder:
cd ~/docker/cloudflared && casper` (or `This folder has over 20,000 files, …`). `tests/big-folder-work.test.ts` covers
this.

**`/verify` with nothing to run (from v0.2.19)** prints one line instead of one line per check:
`[verify] No checks found in Documents. Tests found in sample-tools: /project sample-tools`, or
`[verify] No tests in Documents yet. Say "add tests" and Casper writes some.` when no folder inside
has tests. The receipt says `– Not checked — no tests yet. Say "add tests".` and a one-shot run exits 2, so a script never
passes with nothing checked. In a folder with tests no command runs, both say so:
`[verify] Casper found tests in demo but no command that runs them. Say "set up the test command".` In a project that has only tests, `/verify` says
`[verify] No typecheck, lint or build command here, so Casper runs test.` and runs that.

**Bash runs do not count.** When the model runs a test through its own bash tool, Casper reports
it but never counts it as verification (`– Not verified — test ran via bash only …`).

## Exit codes

A one-shot run exits:

| Code | Meaning |
|---|---|
| 0 | Done. A pass that later went stale, checks that passed without proving the change, or changes nobody verified, still exit 0 and the receipt says why. |
| 1 | A check failed, checking was stopped, or the model run failed. |
| 2 | Incomplete: a check never ran to the end (the sandbox blocked it, it timed out or could not start) or passed but left something running, a selected check was skipped (it has no command), a smoke check could not run, `--max-turns` stopped the run, Casper stopped commands to another machine, or checking was asked for and no check exists. |
| 3 | Only with `--require-verification` (which implies `--verify`): the change was not verified. From v0.2.17 that includes checks that passed without a proof (`– Checks passed — not proven`). |
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
line, for example:

```
– Not verified — no configured check covers the changed files.
✓ changed README.md
```

In a session on a rich terminal the receipt is a card: line 1 is the verdict and why, then labelled rows under a
coloured edge, for example

```
▌ ✗ Failed: test failed
▌   Checks   ✓ lint 2.1s · ✗ test 4s (exit 1), after 2 repairs · Ctrl+T shows the log
▌   Changed  15 files
▌   Config   .casper/project.yaml, package.json
▌   Devices  build-server: installed a service (/etc/systemd/system/app.service)
▌            from the commands Casper saw, not checked there
▌   Next     /verify repair test
▌            [1] Show diff   [2] Undo   · press a number
```

A row shows only when it has something to say, in this order: **Open** (what needs you, `⚠` first, and a plan step the
AI did not finish), **Checks** (one per check with its time, the repairs, and checks Casper did not run or count),
**Changed**, **Config** (the config files the task changed, its lockfiles as one entry, and risky config lines),
**Devices** (other machines, from the commands Casper saw), **Proof** (only when the proof is missing or weak),
**Notes** (grey, at most three, then `+N more · /receipt`), **Undo**, and **Next** (what to type, then the numbered
keys, each a key cap: a bold, reversed ` 1 ` in the theme's selection colour, `[1]` with `NO_COLOR`, then a grey
`· press a number`; `tests/next-keycaps-ansi.test.ts` checks these). Config files are package.json and other dependency lists, tsconfig, `.env` files, YAML, TOML and INI files,
Dockerfiles and compose files, CI workflows, `.casper/project.yaml`, Ansible inventories and variables, and device
configs (Junos `.set`, `.conf`, `.cfg`). The edge and line 1 are green for Verified or Checks passed, red only for
Failed, and amber with `⚠` for the rest (not verified, not checked, incomplete, stopped);
`tests/receipt-card-ansi.test.ts` checks these colours. A clean pass stays one line. Ctrl+T shows the last failed
check's whole log. Below 50 columns the card falls back to the lines above, and the plain terminal, one-shot runs,
`--json` and saved receipts always have the lines.

The per-file change table is behind `Diff` (`/diff`) and `--verbose`. `/receipt` (or `/receipt <n>` for a saved one)
shows every line in full: on a session's rich terminal it is the same card with every row expanded under plain labels
(Changes, Config, Devices, Checks, Proof, Tests from your request, Model's review, Shell runs (not counted), Notes,
Undo, Next), each check with its command and time, every changed file, and the proof even when it is strong. With
`--verbose`, and on the plain terminal, it is the full form below. The `--json` receipt's `text` and saved receipts
keep the full form.

`/help receipt` says what each verdict means and what to do about it: Verified, Checks passed · not proven, Not
verified, Not checked, Incomplete, Failed and Stopped. The first receipt of a session that is not a pass ends with a
grey `What these words mean: /help receipt`, once.

The full form's line 1 is the verdict, one of:

```
✓ Verified — the checks pass, and the tests fail without the change
✓ Verified — the checks pass; without the change the tests could not even load
– Checks passed — not proven: a refactor should not change behavior, so no test is expected to fail without it
✓ Checks passed — no files changed
✗ Failed — test failed
✗ Not checked — test timed out after 10m, so the change was not tested; /verify test runs it again
– Incomplete — test passed, but something it started was still running when it ended; /verify test runs it again
– Incomplete — stopped after 3 turns (--max-turns); changes so far are kept; send another request to go on
– Not verified — the tests pass without the change too
✗ Stopped — cancelled; changes already made are kept
```

(In a one-shot run the `--max-turns` line says `casper --continue to go on` instead of "send another
request".)

`Verified` means the checks passed on the final files **and** a test fails without the change
(ADR 0001). Since v0.2.17 the JSON `outcome` follows the verdict: `verified` only for
`✓ Verified` (before that, a change whose checks passed but was not proven by a failing test, for
example a refactor, still had the outcome `verified`). A change whose checks pass but that was not
proven has the outcome `not_verified` (exit 3 with `--require-verification`) and `checksPassed` is
`true`. Either way the JSON receipt's `proofSkipped` says why it was not proven.

The lines below the verdict give the evidence:

```
✓ Changed 1 file: sum.js
✓ test passed (npm run test, 1.3s)
✓ test passed earlier in this task, reused (npm run test, 1.3s)
✗ test failed (exit 1) — log above; /verify repair test to fix
✗ test timed out after 10m — it did not finish, so it was not checked; /verify test to run it again (a session offers more time)
– test passed, but something it started was still running when it ended (cleanup unconfirmed); /verify test runs it again
✗ lint could not start (exit 127) — check verify.lint in .casper/project.yaml
✗ test could not start — go isn't installed on this computer; install it, then /verify test
– Not verified — test ran via bash only (npm test: passed). Run /verify test to record a check.
– Not checked — no tests yet. Say "add tests".
– Not checked — Casper found tests but no command that runs them. Say "set up the test command".
– Not verified — stale: files changed after the last passing test. Run /verify test.
– No files changed, so Casper ran no checks
✓ Proven: test fails without this change (exit 1) and passes with it
✓ Proven, weakly: test passes with this change; without it test crashed or was killed (exit 139) instead of failing
⚠ Not proven: test passes without this change too, and no test was added or changed
✓ Service api at 127.0.0.1:53121; smoke 2/2 passed (model-declared, run by Casper: create note failed before the change)
✗ Service api at 127.0.0.1:53121; smoke 0/1 passed; failed: create note (status 404, expected 201)
– Changes unknown: not a project folder (over 20,000 files)
– Changed (seen by Casper's edit and write tools): lab.md
– Changed on 198.51.100.20 (build-server) (from the commands Casper saw): made an API token (pveum user token add …); installed a service (/etc/systemd/system/sampleapp.service)
– Ran commands on build-server over ssh; Casper can't tell from the command text whether they changed anything there
– Not run on 198.51.100.20 (build-server): 3 commands Casper stopped before they reached it
– Incomplete — commands to 198.51.100.20 (build-server) did not run
⚠ A secret appeared in a command; change it after this task.
– A secret was written into config/app.yaml (not shown). Keep secrets in an env file or a secrets store.
```

The machines a task reached over ssh (at most the last three) are named on each later request of the conversation,
by the name your ssh config gives them (`nas (192.0.2.31)`), so work meant for one of them is done there and not in
this folder, and checked there where you would see it (its page in the browser tool, or its API) before the AI
calls it done or moves on; otherwise it says it is not checked. `/clear` and `/resume` forget them.

A folder over 20,000 files only because of its pictures, videos, audio and archives (a project that saves photo
copies, say) is compared without them: the receipt lists the changes to everything else and says `– Pictures, videos
and archives here are not tracked: with them this folder is over 20,000 files`. It still has no undo, since the undo
copy counts every file ([UNDO.md](UNDO.md)).

In a folder too big to compare, the receipt says `– Changes unknown: not a project folder (over 20,000 files)` (or
`Casper could not read this folder (EACCES)`) and lists the files Casper's edit and write tools changed. When the ones
inside the folder all sit in one project or app folder, that folder's checks run instead of the open folder's and Casper says `The work is in ~/Documents/sample-tools.`, as above; not when the tools changed 32
files or more, since Casper keeps only the first 32 and a later one may sit elsewhere. In this list, as in any receipt
that says `Changes unknown`, a file outside the folder is named in full, except scratch in the system temp folders,
which is left out.

A note about the session rather than the task, `– Shell commands and checks were not sandboxed (…)` when the sandbox
is off or `– Changes unknown: not a project folder (…)`, is said in full on the first receipt of a session that has it.
Later receipts say the notes that have not changed in one short line at the end,
`– Same as before: changes unknown (not a project folder) · not sandboxed (/receipt)`; a note whose state changes (the
sandbox on again, a folder Casper can compare) is said in full again the next time it comes back. `/receipt` and
`--json` always have every line in full. A warning to act on, `⚠ A secret appeared in a command; change it after this
task.` or `⚠ Not proven: …`, comes right after the verdict.

From v0.2.19 a check's time shows only from one second up (`✓ test passed (npm run test)` for a
quick one). The lines about other machines come from the text of the AI's ssh and scp commands, not
from the machine itself: Casper never logs in to check. They are there so a model's "nothing changed
on the server" never stands alone. When Casper stopped commands to another machine, the task is
never a clean pass: the verdict is `– Incomplete — commands to 198.51.100.20 (build-server) did not run`
(exit 2), even when the local checks passed.

A pass marked `reused` did not run again: its declared inputs are unchanged since it passed
earlier in the same task (often the model's own `casper_check`), and the time shown is that
earlier run's.

For a one-shot repair, use `casper -p "/verify repair test"`. `/receipt` (or
`--verbose` for a whole run) shows the detailed form: how each command ran, its input scope and
freshness, reuse, and the "not independently certified" note described in
[How checks are tracked](#how-checks-are-tracked).

### When a task is not done yet

In a session the card comes when the work is done. When the AI's last words ask you something (a question, `say done
when …`, `tell me which …`) or say what it does next and it stops (`Next I'll …`, `Let me check …`), Casper shows one
line instead of the card and its numbered keys, which could pass for the options the AI just offered:

```
? Waiting for your answer · /receipt 12 shows the 2 files changed so far
Paused — the AI said what it does next; say go, or tell it what to change
```

With **Keep going** on (the default; [decision 39](adr/0002/39-keep-going.md)), a session doesn't stop there when the
AI asked you nothing. When its last message lists work still open (`Still not done: …`) or says what it does next,
Casper sends it on itself, with the open items and the accepted plan's steps it never reported, and says so:
`↻ keep going 1/2: 2 items still open, so the AI carries on (Esc stops it)`. The AI is told to do what it can and
leave only what needs you. That is two rounds a task at most, and none after a round that leaves as much open as
before; then the line or the card follows. The task after a plan build hears the plan's steps still open and where
the saved plan is. `keep_going: off` (`/settings` → Keep going) waits for you instead; one-shot runs and `--json`
never keep going by themselves.

The part after `·` comes only when the task changed something. The receipt is saved as always, so `/receipt`, `/undo`
and `/diff` work. The card that ends the work adds `– Also changed before your answer: 2 files (/receipt 12)`; when
your answer needs no change, the card is the one held back. A failure, a stop, work that did not finish, a secret
Casper saw and a risky config line always keep their card, with the line under it and no keys. When the card would only
say that no files changed (no check ran, nothing changed in the project, outside it or on another machine, and nothing
needs you), there is no card at all: the AI's message is the whole result, as with a plain question. `--verbose` always prints the full receipt (the line follows it), and one-shot runs and `--json` are
unchanged.

**The request's next step.** Some models finish one step of a pasted list and stop with nothing open and nothing
asked, so there is nothing to keep going on. When the request lists several steps (numbered or bulleted, also run
together on one line) and the AI's last words name nothing open and ask nothing, one small call to your fast model reads
the request and those words and names the first step not done yet (about 2–5k tokens; never for other requests). The
row under the card offers it first: `3 Continue: Publish ha.example.org as a public hostname (uses tokens)` with
`Why 3: the request has more steps, and the AI didn't say what is left`; after a code fix, its test comes first. Only
your key sends it, as the next request. `tests/request-next-step-app.test.ts` covers this.

Casper reads only the closing words of the AI's last message: its last paragraph, past a code block, the open items and
a list of options under it, and only when no tool ran after them. A guess the wrong way shows the line after a
finished task (its card follows your next request, and `/receipt` has it now) or the card as before. The AI is told
to ask with the ask tool, not in a question ending its reply, and not to stop just to say what it will do next.

### When a check fails

**Already broken before the change.** Before the first repair, Casper runs each failing check on
the files from before the change (the copy it keeps for the proof). If the check failed there
too as a test failure (not a crash, a signal or a timeout there, which can't tell), it was already broken: Casper says so, and an interactive terminal asks
`1 Leave it · 2 Fix it anyway` before paying for a repair (Enter leaves it; before v0.2.16 the
two were the other way round). Scripts repair. Left as it is, the receipt says so first instead of `✗ Failed`:
`– Not caused by this change — test already failed before it; left as it is`
(the `--json` outcome stays `failed`, since a check still fails). A check that fails only now still reads `✗ Failed`.

**A repair that changes nothing.** Casper compares each failure with the last round's, leaving out
what changes from run to run (durations, ports, temp paths, hex ids, times). When a repair
round changed no files and the failure is the same, Casper stops there with `The last repair
changed nothing and the failure is the same.` instead of spending another round. With
`repair.bigModelLastTry` on, the next round is that last try on your big model instead; in an
interactive terminal you get the offer to try once more on the big model first. When files
changed but the failure is the same, the next repair prompt starts with `Same failure as the last
round: your change did not affect it; try a different approach.`

**Timed out or could not start.** Such a check did not fail as a test, so Casper never repairs it
on its own: a repair costs model tokens and cannot fix a slow suite or a missing tool. In an
interactive terminal Casper asks `test timed out after 10m. Casper did not try to fix it. What
now?` with:

- `1 Stop`
- `2 Retry`
- `3 Fix it anyway`
- `4 Allow more time` — four times the limit the check just had (at least a minute, at most an
  hour), again each time you pick it. The longer limit also applies to the model's own runs of
  that check for the rest of the task.
- `5 Allow more time from now on` — the same, and Casper saves that limit for every check in this
  project (`verification.timeoutMs` in `.casper/project.yaml`, written for you):
  `[verify] Saved verification.timeoutMs: 2400000 in .casper/project.yaml: every check here gets 40m from now on.`

A check that finished but in which a test hit its own time limit (bun's `this test timed out after`,
Jest's `Exceeded timeout of`, Vitest's `Test timed out in`, Mocha's `Timeout of ... exceeded`,
pytest-timeout's `Failed: Timeout >`) is unfinished too: that is often a busy computer, not the code.
Casper asks `test: a test in it timed out (often a busy machine, not the code). Casper did not try to
fix it. What now?` with `1 Stop · 2 Retry · 3 Fix it anyway` (more time for the whole check would not help).

A check whose own program this computer doesn't have (`go: command not found` for `go test ./...`, or
Windows' `'go' is not recognized`) gets no question: a retry or a repair can't install it, so the receipt
says `go isn't installed on this computer; install it, then /verify test`. A tool deeper in the check
(`jest: not found` under `npm test`, often dependencies not installed yet) still gets the choices above.

Enter or Esc stops (before v0.2.16 there was no Stop choice and `1` was Retry). Casper asks at
most eight times per round of checks (the review round, when on, is a
second round). When the only failures are unfinished checks, the verdict is `✗ Not checked —
test timed out, so the change was not tested`, not `✗ Failed`; the outcome and exit code stay
`failed`/1. Scripts and one-shot runs report the check and repair only real test failures. A
command that could not start is not saved as a check timing.

**The model provider fails.** A provider that answers with nothing ("empty response", which Pi
does not retry itself) is retried three times on its own, after 1, 2 and 4 seconds, each with one
dim line (`… The model failed · trying again in 2s (2 of 3) · Esc stops`); Esc stops the retries at
once. Other errors are left to Pi's own retries. If it still fails, an interactive terminal asks
`1 Stop · 2 Retry` (Enter stops; before v0.2.16 it was
`1 Retry · 2 Stop`). With your big model set, a third choice, Retry with your big model, comes
last. When the model run fails after it edited
files, Casper still runs the checks on those edits, without a repair, and the verdict says how
they fared (`✗ Failed — the model run failed; changes already made are kept; the checks pass on
those changes`), followed by a `– Next:` line for the cause.

The `[error]` line names the cause in plain words with one next step, and Ctrl+T shows the
provider's own message (a plain terminal prints it on the next line):

| Cause | Next step |
| --- | --- |
| The key is wrong or expired (401) | `/login` to sign in again |
| A saved sign-in could not be renewed (the token server said `invalid_grant`, 400 or 401; offline or a 5xx while renewing reads as those causes) | `/login` to sign in again |
| Out of credits (402, "quota") | Add credits on the provider's site, or `/model` to pick another model |
| Rate limited or overloaded (429, 529) | Wait a minute, then ask again |
| Can't reach the provider (offline, DNS) | Check your internet connection, then ask again |
| The conversation is too long | `/compact`, then ask again |
| The provider can't run this model | `/model` to pick another model |

Any other error keeps the provider's text, and the receipt suggests another model.

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
– Independent acceptance not run: the acceptance answer had no test file
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
implement, fix or test). A request for a report, review or audit, or one that says not to change anything ("look
for issues and report back, don't change anything"), is read-only even when it names debugging or changes: the AI is told
so, and it gets no checklist or proof step, unless it also asks for a change ("debug why it fails and fix it"). Off for questions, docs,
refactors and configuration, and off in one-shot runs unless set. A terminal transcript pasted into
the request (an agent session copied off the screen) is left out of both choices: its "fix" or "add
tests" is context, not what you asked, so a pasted transcript alone makes no checklist, and the cases
come only from what you typed around it.

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
– 26 cases from your request not confirmed: the checks did not pass (/receipt lists them)
```

**Planning first (optional).** Nothing waits before ordinary work: the list goes to the model as made.
To read and correct the cases first, use `/plan <request>`. A clear request returns a plan directly; only
choices that change the build get at most 3 questions in one round, with 2-4 options, each labelled and described,
and the normal picker's Type your own. The next prompt includes the answers and must return a plan without
more questions. The read-only planning gate is unchanged: the model may only look, not edit or run checks.

An existing-project plan has Title, Goal, What I found, What you'll see (an on-screen mock-up at most 60
columns), numbered Steps, Done means (acceptance criteria including checks), Open questions only for unknowns,
and optional Details. For a new/empty folder or a request to make an app, site or game, it is a first-version
spec: Goal, Screens, Data, Look (a named style), First version, Later and Done means, with no forced Steps.
Later is not part of the build. The accepted Done means cases become the build checklist, without a separate
checklist-generation call; Build gets the whole plan, not just the numbered steps.

On both terminals, `3 Change the plan` opens one line for plain words such as "also test X". The model
rewrites the plan and shows it again with `1 Stop · 2 Build · 3 Change the plan`; Enter stops without building. Choice 3
is not a raw plan editor. Ctrl+T shows Details; Ctrl+G opens the saved Markdown using `VISUAL` or `EDITOR`,
rereads it on return and shows it again. Plans are gitignored at `.casper/plans/date-slug.md`; `/plan` alone
lists recent plans to reopen. A plan with an open question adds `2 Answer the question` before Build; several
add `2 Answer the questions`, asked in turn and answered in one rewrite. A plan longer than the screen is not
printed again after a rewrite: Casper shows the lines added and removed and where the saved plan is. The rich
plan's accent frame is as wide as the window, with dim paths; plain
terminals and `NO_COLOR` show no frame.

**Plan progress is a model report, not check proof.** During the build the working line can read
`Step 2 of 4 · Draw the header`. The screen after the build says the plan in one line (`– Plan: 1 of 2 steps
done (model report) — <reason>; /receipt lists them`); `/receipt` reports each item from Steps (or First
version in a spec): completed items as done, not-done items with reasons, labelled **model report**.
These are the model's claims, not proof that a check ran or passed.
They do not replace recorded check results, change the verification verdict, or make unchecked work Verified.

If the call fails or its answer has no list of cases, Casper prints one line
(`– Checklist not made: <reason>`) and the task runs unchanged. The checklist is guidance, not
evidence: the outcome and the JSON receipt's `text` do not change. The call's tokens join the task's usage,
the JSON stream marks it with a `checklist` phase, and the JSON receipt carries `checklist` (the
cases) or `null`.

## Requirements review

The requirements review is **off by default**. In pinned benchmarks it added no first-time-right
runs (the same runs were right first time with it off) while taking about 40% of Casper's wall
time. The checks and the proof, not the review, keep Casper at zero false "done".

**With it off**, the first turn of a **code change in auto mode** with a `test` check asks the
model to check every requirement and to end its answer with only the ones still not done
(`Still not done: requirement — why not done`, plain lines that never look like boxes to tick or options to
pick), plus a test that fails without the change. A full ticked list
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
Covered now: unknown option exits 2 — tests/cli.test.ts    (a gap the review added a test or fix for)
Still not done: handshake timeout — not implemented        (a gap still open)
Covered: 5 of 6 requirements.
```

With no gaps it is just `Requirements review: all covered.` and `Covered: 6 of 6 requirements.`
(Re-listing every covered requirement made the round 41–44% of the wall time and its answer
several times longer, with no first-time-right gain in pinned runs.) The checks rerun only if the
review changed files. The receipt shows the review as **the model's own claim**, never as
Casper's evidence:

```
– The model's review: all 6 requirements covered (1 gap fixed; its own claim, not checked by Casper)
– The model's review: 5 of 6 requirements covered (1 gap fixed; its own claim, not checked by Casper)
⚠ The model's review says not done: handshake timeout — not implemented
– The model's review returned no checklist
– The model's review stopped at its 12-turn budget (its own claim so far, not checked by Casper)
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
   linked back in. Literal in-project files named by the test command or its package scripts are
   included even under gitignored `.casper/` (for example `.casper/quick-test.ts`), without copying
   sibling state. Private/outside inputs, linked inputs and excluded state cannot be imported;
   absolute script paths are unsupported because they could execute live workspace code. The receipt
   explains the unavailable comparison. Dynamic paths and imported dependencies are not inferred.
   Runs in the copies set `UV_NO_SYNC=1`, so `uv run` never changes your linked
   `.venv`. When code (not tests) changed during a plan turn, the copy would already hold that
   change, so there is none: the receipt says Casper could not compare. Code the AI changes while
   it looks at the page screenshots is part of the change.
2. **Run without the change.** After the checks pass, Casper rebuilds the workspace **without the
   change**: the copy from before, with the tests (anything under a test directory, or named like
   a test) as they are now. It runs the `test` check there.
3. **If that fails**, it runs the same check on a copy of the current workspace. When that passes,
   the change is **proven**: the tests fail without it and pass with it. When it fails too, the
   copy cannot run the tests, and the receipt says Casper could not compare (never a false proof).
   The receipt names the exit code of the run without the change. A run that did not end as a
   test failure is weaker evidence and reads **Proven, weakly**: a timeout, a crash or signal (a
   shell's exit above 128), or a command that could not start (exit 126 or 127). Only the crash
   still makes the change Verified: a run that timed out or could not start did not show the old
   code failing, so it is not proof, and line 1 reads `– Checks passed — not proven: without the
   change test timed out, so it did not show the old code failing`. A run with no exit
   status at all (killed before it could report one), or one in which a test hit its own time limit
   (see Timed out or could not start), is not proof: Casper could not compare.
4. **If it passes without the change**, the change is **not proven**. Casper spends one repair
   round (within `repair.maxAttempts`) asking the model to add a test that fails without the
   change, then reruns the checks and the comparison.

When the change rewrote what the `test` command runs (the package.json script it runs, with its
pre and post scripts, `bunfig.toml` `[test]`, jest or vitest config (or `vite.config` when vitest
has none), pytest settings, any `conftest.py` outside the test folders, the Makefile for `make`, or a
script or `--config` file that the command or those scripts name outside the tests),
its pass is not your tests passing: Casper does not compare, and the receipt says
`the test command's definition changed in this task (package.json scripts.test)`. The independent
acceptance check is not run either, for the same reason. Named inputs and receipt labels use portable
separators for Windows checks and Bun's cross-platform Windows-relative paths; the executed command
stays unchanged. CRLF runner edits still count: line endings can change shell execution.

An unproven change is not verified: its outcome is `not_verified` (`--require-verification` exits
3). A change Casper could not compare keeps its check result and says why. Test-only, docs-only or
data-only changes, and refactor, docs, inspection, diagram and configuration requests, need no
proof. The comparison runs the test check once more (twice when proven), so it adds that time to
the run.

## Try it before done

Before the final receipt for an app, server or page change in `auto` mode, Casper tries the app once.
In `offer` mode it does not run automatically: the receipt says `App smoke: not run — /verify to try it`.
`/verify` runs that app smoke with the other checks, or alone if no command checks are configured.
It does not launch an extra test suite, crawl links or start another repair loop.
Docs-only, tests-only and unchanged tasks start nothing. `--no-verify` / `verification.mode: off`, or
`pages: off`, disables this completion smoke; the receipt says `App smoke: not run (off)`. An offer is
not an unfinished attempt and does not by itself make the task incomplete.

Casper selects one declared service whose scope covers the change, or the project's own `dev` (else
`start`) command. API servers need no HTML page. A server with no framework is known by its entry file: `Bun.serve(`,
`serve(` imported from `bun`, `Deno.serve(`, `createServer(` or `.listen(`. For an automatic request it chooses the first concrete
changed page, otherwise the service's `ready.http` path, otherwise `/`. It sends one local GET, without
following redirects, and expects HTTP 2xx. When `/` is only a guess (that last fallback, or an app Casper found from `package.json`, whose
readiness path is Casper's own default `/`), a JSON 404 or 405 also passes:
the API answered and has no page there (`GET / → HTTP 404 — the API answered; it has no page at /`). An HTML
404, a 5xx, or a 404 on a changed page or declared path still fails. Readiness polling is separate from this one smoke request.
A matching fresh page or service check on the final files is reused instead of making another request.
A reused check keeps its actual method, path and result. A later edit invalidates it.
If code or configuration changes while the app is being tried, the smoke says not run. Data the app
writes as it works (`.json` data files, SQLite databases and their `-wal`/`-shm` files, `.log`, `.csv`)
does not count; manifests and tool configs such as `package.json` or `tsconfig.json` still do. The
receipt still lists those files under `Changed while checking`.
If the selected service is already running because you intentionally started it, Casper makes it fresh
with `ensureFresh` before that GET: edits mark it stale, so it restarts once instead of serving old code.
The request goes there instead of launching a second copy, even on a fixed port. The service stays yours,
not an automatic service, and completion cleanup never stops it. The receipt says `existing service left running`.
If the restart fails, app smoke says not run with the reason, and no GET is sent.

A change to page files that nothing in the folder serves (no web framework, no server code, no start
command or service: a card or page another program loads) says `App smoke: not run — no start/dev command or
declared service found for this app` as a note; it does not make the task Incomplete. An app that has a framework
or server code but no launch command still does.

A new completion launch has at most 15 s to start (less if the declaration has a shorter deadline), and
its request has at most 10 s. Casper stops its automatically started services and their child processes
before the receipt, including after failure or cancellation. Services you intentionally started with
`/services`, `/preview`, or the model's service tool remain under their original ownership.

```text
✓ App smoke: passed · bun run dev · GET / → HTTP 200; app stopped
– App smoke: not run · bun run dev · GET / — the app could not start: exit code 1
```

Missing launch information or dependencies, startup failure or timeout, changes during the smoke, and
unconfirmed cleanup are reported plainly and leave the task incomplete, never with a passing smoke.
An unexpected response or a reused failing page check fails the task. The observation is kept in
`/receipt`, saved receipts and JSON `appSmoke`; a passing smoke is not behavioral proof and cannot by
itself make a change **Verified**. Casper never guesses credentials or installs dependencies for it.

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

- Configured checks run after runtime changes, not docs-only or tests-only changes; recorded ones always run.
- Before each run Casper makes every referenced service fresh: a service that is stale from
  edits, has crashed or no longer answers its readiness path is restarted.
- A failing smoke check joins the normal repair prompt and uses the same `repair.maxAttempts`
  budget; there is no extra round. Smoke runs again after a repair, a requirements-review edit or
  a proof repair.
- A standalone `/verify` runs command checks and any app smoke deferred by the latest offer-mode task;
  it does not replay that task's configured or model-recorded smoke cases.
- When the command checks still fail after the last repair, smoke never ran, and the receipt says
  `– Smoke not run: command checks failed`.

**What counts.**

- A configured check is verification evidence when it passes against fresh services.
- A model check counts only when its baseline failed and it now passes.
- A baseline that got no HTTP response (a timeout, a reset connection) says nothing about the
  endpoint: it is recorded as `incomplete` ("could not run before the change"), never as a
  failure. The exception is a request that crashed the service: when the service exits on its own
  during the baseline request, the baseline is `fail`, so a fix that makes the check pass is evidence.
- A model check whose baseline passed is shown as an observation and never makes the outcome
  verified. With no command checks and only such observations, the outcome is `not_verified`.
- Casper does not take the model's word that it recorded before editing. A check recorded after
  an edit in the task (a native edit or write, or a shell command or approved MCP change after
  which the tree differs from the task's start), or during a repair, review or proof round, has no before-the-change
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

New in v0.2.16. Since v0.2.21 each page is opened at phone width (390px) too, and a page that
scrolls sideways or squashes a text field fails; a plain Bun or Node site (an `index.html` and a
`dev` or `start` script that runs its own server file, `bun run server.ts` or `node server.js`,
which reads `PORT`) gets the check as well.

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
  and front-end files in `public/`, `static/` or `assets/` open `/` (a picture there does not: `make_picture`
  saves to `assets/` in any folder), and the `pages:` list is opened after any code change.

Page checks run only when Casper checks each change itself (`auto`), after the command checks and
smoke checks pass, inside the same verify-and-repair loop. Casper starts the dev server through
[managed services](SERVICES.md) and reuses it within the task; an edit makes it restart before the next
check. Automatically started servers stop before the final receipt. A server you started intentionally
is left running. Each automatic task-owned start prints the command, because it runs
the project's own code:

```text
• Casper checking: typecheck, pages
• Starting dev server: bun run dev (it runs your project's code)
Dev server: bun run dev · http://127.0.0.1:41733 (stops after the task unless you started it)
• Casper opening changed pages: /dashboard
```

The banner and `/status` name it too: `checks    typecheck, pages (bun run dev) — run after each change`.

Each page gets one receipt line:

```text
✓ /dashboard loads · 0 console errors
✗ /dashboard · 2 console errors: TypeError: Cannot read properties of undefined (reading 'map')
✗ /dashboard returned 500
✗ /dashboard shows an error: KeyError: 'site'
– /devices/[id] not opened: it needs a value for [id] (a fixed path can be set in .casper/project.yaml pages:)
```

A page fails on a console error or an uncaught page error, an HTTP status of 400 or more, a failed
request to the same site (500 or more, or no answer; other sites never count), or an error overlay:
Vite's and Next.js's, or Streamlit's in-page exception. Streamlit shows app exceptions in the page, not
the console, so Casper also reads the traceback the Streamlit server logs while the page loads. A
failing page is the receipt's first line (`✗ Failed — /dashboard has 2 console errors`) and goes to the
repair as page evidence (the console text, the error line and the server's last log lines, bounded and
with secrets hidden; for a page that doesn't fit a phone, its width and the squashed fields); the pages are
planned and opened again after each repair. A page that loads says
**loads**, never "works": a pass never makes a change **Verified**. With only page checks, the receipt
says `– Checks passed — not proven: pages load, but no test fails without the change`; without Chrome it
says `pages answer, but their console was not checked` instead.

**Screenshots.** With Chrome, Casper also saves a picture of each opened page at desktop width
(1280 px) and at phone width (390 px). First it scrolls through the page once, so lazy images load, and
waits for animations to finish (at most a second). The desktop picture is the whole page, up to 4000 px
tall, so rows below the fold are in it; the phone picture is the screen. They cost no tokens and are
listed under the page's line:

```text
✓ /dashboard loads · 0 console errors · fits a phone · 2 screenshots
  desktop ~/.casper/projects/<project>/browser/<run>/page-1-desktop.png · phone …/page-1-phone.png
```

They are saved outside the project (folders 0700, files 0600) and stay after the session, like the
browser tool's own screenshots. Not on Windows yet (Casper's private file writer is macOS and Linux only).

**The AI looks at the pages.** A loading page can still look wrong (a button over the header, cut-off
text). When the checks pass and the model in use can see pictures, Casper can show it the screenshots
of up to 2 pages once, so it can fix what looks wrong before it says done. That uses tokens, so the
first time in a session Casper asks: `1 No · 2 Yes, show the AI the pages`. The answer holds for the
session; `/settings` (Show the AI the pages) makes it always or never, written as `showPages: ask|on|off`
in `~/.casper/config.yaml` (a project file can't set it). A one-shot run never asks, so by default it
never looks. A fix made while looking goes through the checks again, with the repairs left. The
receipt says `– The AI looked at 2 screenshots of the pages (advice, not a check)`: what the model
thinks of a picture is never evidence and never makes a change **Verified**. A model that can't see
pictures is never sent them. The prompt names them `[screenshot 1]`, `[screenshot 2]`, apart from any
`[image N]` you sent. Pictures are sent as they are: Casper can't hide a secret the page shows (a debug
panel, a token on screen) the way it hides one in text.

**Accessibility notes.** New in v0.2.23. While a page is open at desktop width, Casper also counts a
few common misses with its own small rules (no third-party script): images with no `alt` (`alt=""`
is fine for decoration), fields with no label (a placeholder is not a label), buttons with no name,
text below WCAG AA contrast against its background (4.5:1, or 3:1 for text of 24 px, or 18.66 px bold;
in any CSS colour, Tailwind v4's `oklch()` too, naming the worst pair), and a page with no `lang`. They
show as one note under the page line and never fail the page. When a page has notes and repair is on
with a try left, the model gets one repair turn per task with only those notes ("fix only these; don't
weaken checks"), shown as `↻ page notes 1/3` and never on your big model, then the pages are checked
once more. That turn tells the model Casper checks the pages again itself, so it need not run its own
browser check, replay or screenshot to confirm the notes; a clean page asks the model nothing:

```text
✓ /signup loads · 0 console errors
  • /signup: 2 inputs have no label · 1 image has no alt text · the page has no lang
```

Finding them costs no model tokens; only that one turn does. They need Chrome; `pages: off` (or
verification off) turns them off with the rest of the check.

**Look notes.** The same way, Casper names what a person would see wrong: images that didn't load (by
`src`), one picture used on two or more items of a repeated group such as product cards (icons under 48
px left out), and at phone width the first elements that run past the screen's right edge (not inside a
box that scrolls sideways on purpose) and links, buttons and inputs smaller than 44×44 px (a link inside
a sentence is left out). Drawn pictures (inline `<svg>` and the site's own `.svg` images) get notes too:
one of 48 px or more with no `viewBox`; an inline one of any size with no name (`<title>`, `aria-label`
or `aria-labelledby`), unless it has `aria-hidden="true"` or sits inside a link, button or label, whose
own words name it; and an icon (under 64 px each way) whose colors stay the same when the page itself
turns dark (checked only when its background changes in dark mode). For an icon file shown with `<img>`
the note says to put the SVG inline or give the file its own `prefers-color-scheme` rule, since the
page's CSS can't reach it. A rich illustration is never noted for its own colors, gradients, words or
number of shapes, and Casper's own reads of the `.svg` files never count as failed requests. They are
one note above the accessibility one, and nothing when the page is clean. They go to the model in the
same one repair turn as the accessibility notes:

```text
✓ /shop loads · 0 console errors
  – /shop: 1 image didn't load: /img/hero.jpg · the same picture is on 4 items: /img/bag.jpg
```

**Feel notes.** Casper also names what would feel wrong to use, as more look notes in the same turn.
At desktop width: developer or broken text a person can see (`[object Object]`, `Invalid Date`, `NaN`,
`{{…}}` or `${…}`, raw JSON, ISO timestamps, HTML entities shown as text, lorem ipsum, UUIDs and long hex
ids, `undefined` or `null` alone or after `:` or a currency sign, a time zone such as `Europe/London`
outside a picker, and "1 bags"), quoted and cut to 30 characters, in a field's label or a form's legend too
(`Date & time (Europe/London)`), never inside `code`, `pre`, a field's value or placeholder, or a time-zone option;
the layout jumping while it loads (a shift score of 0.1 or more, with what moved and the images that
have no `width` and `height` or `aspect-ratio`); and a focus ring drawn round `main`, the heading or a
big box as the page opens (a field or button focused on load is fine). At phone width: a page footer
taller than half the screen (a card's own footer is left out), and a control a fixed or sticky layer
covers at the top or the bottom of the page (a dialog is meant to cover it). Each is one note naming
at most 3, and none ever fails a page.

**Chrome.** Pages are opened in a fresh headless Chrome (`CASPER_BROWSER_EXECUTABLE`, else an installed
Chrome or Chromium; Casper never downloads one). Without Chrome, Casper only fetches the page and says so:
`✓ /dashboard answers (HTTP 200) · console not checked: no Chrome found (install Chrome or set
CASPER_BROWSER_EXECUTABLE)`. That is never a failure.

**Links.** After the changed pages, Casper opens up to 5 pages they link to on the same site, each once
and never one it already opened: a plain GET that waits for the page to settle and looks for an error
overlay, console errors and a page that shows nothing (no phone size, notes or pictures, so a second or
two each). It never follows a link with a query or a `#`, a `download` or `rel="nofollow"` link, an
`/api/` path, a file that isn't a page, a path with log out, sign out, delete, remove, destroy,
reset, unsubscribe, cancel, clear or admin in it, or one with an action word such as `add`, `confirm`
or `toggle` as a part (`/cart/add/3`), and it never sends a form. What is wrong is a look note on the
page that links there (`link /about returns 404`, `link /help is blank`; a page that asks to sign in
first, 401 or 403, is not); those pages were not changed in the task, so this never fails a page.
Then it opens links whose query makes a choice (`/book?staff=ana-sousa`): at least 3, and up to 8 light
loads in all when fewer plain links were opened, taking turns by key (staff, service, staff), with the same light load
and the same path rules, never one whose query has an action word or a key such as `action`, `redirect`,
`next` or `token`; keys that page, sort or track (`page`, `sort`, `utm_…`) are not choices. Each value
must show as chosen: a selected option, a checked box or its label, a field's value, or words in the first
screen and a half (a date also as `12 October` or `12/10/2026`). A value under 3 characters, one with a digit
(an id such as `a1b2c3`, not a date) or one under an id key (`id`, `user_id`) counts only where a field is named
after its key. If not, the note is `link /book?staff=ana-sousa: the page
does not show ana-sousa as chosen`.

**When pages are not checked.** A project Casper can't start is a note, never a failure:
`– Pages not checked: node_modules is missing. Run bun install first (Casper doesn't install packages)`.
A dev server that stops before it is ready, or doesn't answer on its port in time (45 s for one Casper found), makes the check
incomplete, with the server's last lines. When the command checks still fail after the last repair, the
pages never opened: `– Pages not checked: command checks failed`. A check the sandbox blocked doesn't count
here: smoke checks and pages still run, and their notes still reach the model, while the task ends incomplete.

**Turning them off for every project.** Pick **Page checks** in `/settings` (it writes `pages: off`
in `~/.casper/config.yaml`). In your own config `pages:` is only on or off. A project file can still
turn them off for itself, but its list of pages doesn't turn them back on for you, and neither does
a profile it picks.

**Settings** (`.casper/project.yaml`; the list of pages is the project's):

```yaml
pages: [/, /dashboard]   # always open these after a code change (at most 8)
# pages: off             # never open pages in this project
services:
  web: { command: bun run dev, port: auto, ready: { http: / } }   # how to start the dev server, if Casper can't tell
```

Only routes are found from files; for single-page apps and Streamlit, list the pages you care about.
The dev server runs the project's code with Casper's reduced environment (no provider keys, a separate
HOME), in the shell sandbox where it can run: its files are held, but it keeps the machine's network so
the page can load (on macOS it reaches only listed hosts), and a page it serves can still reach the
network. Where no sandbox runs it has your permissions: set `pages: off` in a project you don't trust,
or turn **Page checks** off in `/settings` for every project.

## End-to-end tests (Playwright)

New in v0.2.23. When a project already has Playwright tests, Casper finds an `e2e` check and runs
it after each change, next to typecheck, lint and test, through `/verify e2e`, and through the AI's
`casper_check`. It is found from the project's own files each time it is opened:

- `@playwright/test` is in package.json, and
- a `test:e2e`, `e2e`, `test:playwright` or `playwright` script runs with the project's package
  manager (`bun run test:e2e`), or else a `playwright.config.*` runs `npx --no-install playwright test`.

When the `test` script already runs Playwright there is no second check. The tests start their own
server the way the project's Playwright config says (`webServer`).

Casper never installs Playwright or its browsers. Without `node_modules/@playwright/test` the check
only skips and says so; without the browsers a run is a skip too: `Playwright's browsers aren't
downloaded. Run npx playwright install yourself; Casper doesn't download browsers`. Neither goes to
the AI as a failure to fix.

Turn it off with `/settings` → Playwright tests (it writes `verification.e2e: false`; a project
file can set it too). A project that names its own `verify.checks.e2e` keeps that one instead.

## Docker Compose files

When a project has Docker Compose files, Casper finds a `compose` check and runs Compose's own
validator on them, so a typo (bad indentation, an unknown key, a `${VAR}` that is not set, a wrong
port mapping) shows up before `docker compose up`. It runs after each change to a compose file or a
stack's folder, through `/verify compose`, and through the AI's `casper_check`.

- Files: `compose.yaml`, `compose.yml`, `docker-compose.yaml` and `docker-compose.yml`, at the top of
  the project and in folders up to two levels down (`media/compose.yaml`, `stacks/dns/compose.yaml`),
  never in hidden folders, `node_modules` or linked folders; at most 20 files and 500 folders read,
  found again on each run.
- Each file runs `docker compose -f <file> config --quiet` in its own folder, so that folder's `.env`
  is read. `config` needs no Docker daemon and never pulls or starts anything. `--quiet` matters:
  plain `config` prints the file with the `.env` values filled in.
- A failure names each file and Compose's error:
  `✗ compose failed (media/compose.yaml is not valid — … additional properties 'imagee' not allowed)`.
  Compose's errors can repeat a `.env` value (`invalid hostPort: <value>`): secret-named and other long
  values from that folder's `.env` are shown as `<secret hidden>`.

Casper never installs Docker. Without `docker` on PATH, or without its `compose` command, the check
only skips and says so; neither goes to the AI as a failure to fix. Like every check, it runs in the
shell sandbox where one runs.

Turn it off with `/settings` → Compose files (it writes `verification.compose: false`; a project file
can set it too). A project that names its own `verify.checks.compose` keeps that one instead.

## SQL migrations check

New in v0.2.16.

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
  `– Not verified — migrations not run: these are Postgres migrations (supabase/migrations), and Casper only has a throwaway SQLite`.
- Prisma runs `prisma migrate deploy` from the project's `node_modules` only when the schema reads its
  address from a variable; Casper points that variable at the throwaway file. Like every check, it runs
  in the shell sandbox where one runs, with no network.
- Statements that could reach other files (`ATTACH`, `VACUUM INTO`, `load_extension`) are refused. Plain `.sql`
  files are read in one pass that understands quoted text, quoted names and comments together, so a quote
  next to a comment marker cannot hide one; a file that ends inside an open quote or comment is refused too.
  Plain `.sql` files are applied by a short-lived child of Casper's own runtime (not in the shell sandbox),
  which is why this guard exists; only Prisma's own `prisma migrate deploy` runs in the sandbox.

A failure names the file and SQLite's error: `✗ migrations failed (002_devices.sql failed — no such table: sites)`.
A project that names its own `verify.checks.migrations` keeps it instead.

## When repairs run out

New in v0.2.16.

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

From v0.2.16 a project can also name its own checks under
`verify.checks.<name>` (see [Configuration](#configuration)), Casper finds a `migrations` check
(see [SQL migrations check](#sql-migrations-check)), from v0.2.23 an `e2e` check for the project's
own Playwright tests (see [End-to-end tests](#end-to-end-tests-playwright)), a `compose` check for its
Docker Compose files (see [Docker Compose files](#docker-compose-files)), and it finds ready-made checks for Ansible
playbooks (see [NETWORK-CHECKS.md](NETWORK-CHECKS.md)).

From v0.2.19 a Python project with `test*.py` files that use `unittest`, and no pytest, gets
`python3 -m unittest discover -s tests` (or `discover` at the top). pytest-style files are not
counted, because `unittest` would run zero of them and still say OK. A folder of plain Python scripts (no
`pyproject.toml` or requirements file, not your home folder) with a top-level `test*.py` that uses
`unittest` gets `python3 -m unittest discover` too, so tests the AI writes there are run and recorded by Casper.

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
| `verification.e2e` | any config file | `true` (the found Playwright check runs) |
| `verification.compose` | any config file | `true` (the found Compose check runs) |
| `repair.maxAttempts` | any config file | `3`, 0 to 10 |

"Any config file" means `~/.casper/config.yaml`, the profile's `config.yaml` or the project
file; the project file wins (see [CONFIGURATION.md](CONFIGURATION.md)).

- `verify:` overrides `commands:` and detected commands by check name. Only nonempty
  `typecheck`/`lint`/`test`/`build` commands are accepted there; anything else stops configuration
  loading. From v0.2.16, other checks get a name of their own under `verify.checks.<name>` (a
  `run:` command, or a ready-made `preset:` that Casper runs without a shell). A named check runs
  after each change unless it says `after: ask`; a report (a diff) never makes a run pass or fail;
  a lab check reaches devices only after you pick 2 Yes, this once (or 3 Yes, always for this project) in its numbered box, whether you typed
  `/verify <name>` or the AI asked for it (see [NETWORK-CHECKS.md](NETWORK-CHECKS.md)). Ready-made checks Casper finds for
  Ansible playbooks are listed in the banner as found, not saved, and run only after you save one
  with `/verify add <name>`. `lab.hosts` (optional: it only marks devices as lab) is your own
  setting in `~/.casper/config.yaml`; a project file cannot set it.
- Commands and declared scopes are read at startup and do not change during repair. Restart
  Casper after changing configuration or manifests. A task that rewrites `.casper/project.yaml`
  keeps the checks and settings it started with (`[project] .casper/project.yaml changed in this
  task; …`); the receipt lists the file and `/undo` puts it back. Casper's own saves to the file
  after that (Remember, `/verify add`, more time) still write it, but the session keeps its checks
  until you restart (`[project] .casper/project.yaml changed in a task; restart Casper to use it`).
- Casper runs the checks one at a time, at the project root, with the platform shell and your
  environment (from v0.2.16, minus AI provider keys). It does not install dependencies or fall back to another tool when one is missing.
- `verification.timeoutMs` is the overall wall-clock deadline for **each command check**,
  not a per-test timeout or a silence timer: output does not extend it. The existing default
  is 10 minutes; set a different value in the configuration above (1 ms to 1 hour). A named
  check's `timeout:` overrides this default, in seconds. On timeout or cancellation Casper
  stops the owned process tree (observed process groups on POSIX; observed descendants on Windows),
  including workers in their own groups, escalating to a forced stop. Casper also attempts
  to stop workers left behind when the command exits normally; cleanup it cannot confirm
  is reported as described below. A timeout is unfinished verification, not a code failure
  to repair automatically.
- After 10 seconds since the latest output, recognized test-file headings (Bun's `tests/example.test.ts:`
  or Jest's `RUNS tests/example.test.ts`) stay visible in the live check progress. This is the
  last file announced by the runner, not an inventory of parallel workers; runners that
  buffer their headings cannot identify a silent worker this way. Plain terminals include the
  latest progress in their minute line. Open pipes that cannot be accounted for after root exit
  report cleanup as unconfirmed instead of waiting forever. In a session, Casper lists the
  verified live owned processes, one PID and command per line, and asks once: **Stop them** or
  **Leave them running**. Stop them revalidates identities before retrying cleanup of the owned groups
  (verified descendants on Windows), then rechecks: successful signals alone do not confirm cleanup
  while verified live processes remain. An unavailable OS listing still means cleanup is unconfirmed.
  Leave them running records that choice in the receipt and lets the session continue. Neither choice leaves a persistent block
  on further work or proves that unobserved descendants have stopped. An unattended run records
  unconfirmed cleanup in the receipt and exits nonzero, without a picker.
  The AI shell uses the same tree ownership for its explicit timeouts and cancellation; its
  configured slow-command background handoff is unchanged. An AI shell command that ran to its end
  but whose cleanup is unconfirmed still gives the AI its output and exit code, with a note that
  Casper could not confirm what it started has stopped.
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
(start and end, with a marker where it was cut), plus up to 20 distinct error lines from the cut
middle (`error TS`, `Cannot find module`, `file:line:col: error`, `FAIL`, `AssertionError`, ...) under
`Lines from the cut middle:`, at most 2 KiB; that is what repair receives. No log database or
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
the receipt. A file git ignores is still listed when the AI's own `edit` or `write` changed it, and
a file listed at the start of the task stays listed while it exists, so adding it to `.gitignore`
does not make it look removed (an ignored file a shell command changed is not listed). A nested repository or
submodule is walked, and so is a folder git lists nothing for (one an enclosing repository
ignores). Outside git, Casper walks the folder. Either way dependency trees, virtual environments
and caches are left out, and the limit is 20,000 files. Over it, Casper lists the folder again without its pictures,
videos, audio and archives (`.jpg`, `.png`, `.mp4`, `.zip` and the like) and, when that fits, keeps listing that folder
so for the rest of the session; a change among those files is then not a change on the receipt.

**Stopping.** Timeouts and cancellation stop the check's whole process group on Linux and macOS.
Windows stops the check's child processes it can trace; that has not been tested on a real
Windows host yet. In a one-shot run, Ctrl-C (SIGINT) or SIGTERM cancels checks and any further
repair; the CLI gives cleanup up to one second, then exits anyway. Interactive Ctrl-C cancels the
active task but keeps the session. Programmatic `app.close()` waits for startup and checks to
finish, with no forced deadline. Command timeouts do not limit how long the model takes to answer.

**Secrets in output.** Commands run in the shell sandbox where it can run, and without it when no
sandbox is there (Windows, bubblewrap missing, `--no-sandbox`). Either way command output may
contain secrets. Review your checks before their output is sent to a model.
