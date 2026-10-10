# Scripting and CI

**What this is:** how to run Casper from a script, a cron job or a CI pipeline instead of typing
in the terminal. **When you'd use it:** you want one task done with no human at the keyboard, and
you want the script to know if it worked (by exit code or by JSON).

Give Casper a prompt on the command line and it runs that one prompt, then exits.
The flags below let you pick the model for the run, get machine-readable events, continue a
conversation, and get an exit code that says whether the change was checked.

```sh
casper --json --model github-copilot/gpt-5-mini --verify --require-verification "fix the failing test" \
  | jq -c 'select(.type=="receipt")'
echo "exit ${PIPESTATUS[0]}"   # bash: Casper's exit code, not jq's
```

## How arguments are read

- Options go **before** the prompt. The first word that is not an option starts the prompt, so
  `casper explain the -v flag` is a prompt, not a version request.
- Put `--` before a prompt that starts with `-`: `casper -- "-v is broken"`.
- Options that take a value accept `--name value` or `--name=value`.
- An unknown option (a typo such as `--verfy`) is an error (exit 64). It never becomes a paid
  model prompt.
- From v0.2.17: a known option at the end of the prompt
  (`casper fix the bug --verify`) exits 64 before anything runs. Put options first, or quote the
  whole request (`casper "fix the bug --verify"`) to send them as words. A single folder argument
  (`casper ~/code/app`) opens that folder instead of sending its path as a prompt; a single word
  that can only be a path but is not a folder exits 64 with `Not a folder: <path>`. A quoted
  request such as `casper "fix src/app.py"` is still a prompt.

**Read the prompt from stdin.** A lone `-` as the prompt reads it from stdin (at most 1 MiB):

```sh
casper --json --verify - < task.md
```

Prefer this in scripts. Casper runs on Bun, which cannot hide its command line the way Node
programs such as Pi can. A prompt given as arguments stays visible in `ps` to other users of the
machine, and a `pkill -f` with words from the prompt (a model stopping "src/server.ts", say)
would match Casper itself. The benchmark harness passes Casper's prompt this way. `-` with no
pipe (a terminal on stdin) or an empty stdin is a usage error (exit 64).

## Flags

| Flag | Effect |
|---|---|
| `--model <provider/model-id[:effort]>` | Use this model for this run only. Also accepts `@role` selectors (`@fast`, `@build`, `@reason`, `@review`, `@default`; see [CONFIGURATION.md](CONFIGURATION.md#model-roles-and-automatic-effort)). The saved default is never changed. |
| `--effort <level\|auto>` | Reasoning effort for this run only: `auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Any level works on any model: a level the model lacks runs as the nearest level above it, else below (`medium` on a model with only low and high runs as high; a model without reasoning runs without it). Not remembered. Do not combine with an effort suffix in `--model`. |
| `--json` | JSON Lines events on stdout ([below](#json-events)). Everything a person would read (banner, transcript, receipt) goes to stderr. Needs a prompt. |
| `--verify` / `--no-verify` | Casper runs the checks after this run's edits (`auto`), or runs none (`off`). Cannot be combined. See [VERIFICATION.md](VERIFICATION.md). |
| `--require-verification` | Implies `--verify`. Changes Casper did not verify exit **3** instead of 0. Needs a prompt. Cannot be combined with `--no-verify`. |
| `--continue` | Continue this folder's most recent conversation. With none, a new one starts, with the notice `[session] No earlier conversation in this workspace; starting a new one.` |
| `--resume <id-prefix>` | Continue the saved conversation whose ID starts with this prefix. `casper /resume` lists IDs. No match, or more than one, is a usage error. Cannot be combined with `--continue`. |
| `--cd <path>` | Work in that folder instead of the current directory. A path that is not a folder is a usage error. |
| `--max-turns <n>` | Stop each model request after `n` model turns (1–9999). The run is then incomplete (exit 2) and Casper runs no checks. The requirements review (`verification.review: true`) and the proof repair round have their own 12-turn budget; hitting that is not this stop (see [VERIFICATION.md](VERIFICATION.md#requirements-review)). |
| `--verbose` | The detailed evidence receipt instead of the plain one. |
| `--allow-host <host>` | Shell commands may reach this host for this run, as if you said yes to it. Repeatable. A run that can't ask names this flag when it blocks a host. |
| `--allow-write <folder>` | Shell commands and the AI's edits may write this folder outside the project for this run (relative to where you typed the command; `~` is your home). Repeatable. Git's own files and private places stay closed. |
| `--allow-reach <host>` | The AI's `ssh`, `scp` and the like may reach this machine for this run (a `~/.ssh/config` alias counts by its real address too). Repeatable. A machine named as `$HOST` is still refused. |
| `--mcp <name>`, `--lsp <name>` | Connect one of your own MCP or language servers (from your user or profile config) before the prompt. Repeatable. Servers defined in a project need an interactive `/mcp connect` or `/lsp connect` review first. |
| `--help` / `-h`, `--version` / `-v`, `--licenses` | Print help, the version and the path that is running, or third-party licenses, then exit. They write no state. |

An unknown `--model` (or an effort name that is not a level) is a usage error (exit 64), found
before any model request. Missing credentials for the chosen provider exit 1 with the sign-in hint.

These commands have their own arguments and take none of the options above:

- `casper learn <repo>` and its `list`, `inspect` and `promote` forms. See [LEARNING.md](LEARNING.md).
- `casper mcp check [repo] [--server <name>] [--live] [--quick] [--strict] [--json] [--env NAME=VALUE]... [-- <start command>...]`
  checks an MCP server you built. It runs the repo's own code, so use it only on repos you trust.
  See [MCP.md](MCP.md#check-a-server-you-built).
- `casper new [<template> <name>]` and `casper new --list` (from v0.2.16) start a new
  project. It never calls a model. Its codes: 0 ready, 1 created but not ready (or nothing
  created), 64 usage. See [NEW.md](NEW.md).
- `casper security [folder]` (from v0.2.16) runs the security tools with no model
  call: 0 no problems, 1 problems, 64 usage. See [SECURITY_CHECKS.md](SECURITY_CHECKS.md).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. Changes, if any, were verified — or, without `--require-verification`, simply not disproven. A run that changed nothing exits 0. |
| 1 | Failed: a check failed, checks were blocked, the model run failed, or Casper hit an error (for example missing credentials). |
| 2 | Incomplete: checks could not finish, `--max-turns` stopped the model, Casper stopped commands to another machine (`remoteNotRun`), the model wrote its tool call as plain text instead of using it (nothing was done; the receipt's first line says "Did not act"), or checking was asked for (`--verify` or `verification.mode: auto`) and found changes but no configured check, or `casper /verify` found no check to run. |
| 3 | Not verified (only with `--require-verification`): files changed but Casper did not prove them — checks off, none configured or covering the files, bash-only test runs, a pass that went stale, a change the tests do not prove, or (from v0.2.17) checks that passed without a proof (`– Checks passed — not proven`). `checksPassed` in the JSON receipt still says the checks passed. |
| 64 | Usage error: an unknown option, a bad value, conflicting flags, an unknown model or conversation. Nothing ran. |
| 130 | Cancelled (Ctrl-C / SIGINT). |
| 143 | Terminated (SIGTERM). |

Failure wins over incomplete, and incomplete wins over "not verified".

**Change in v0.2.17.** `outcome: "verified"` now means only a proven change,
the same as the receipt's `✓ Verified` line. Checks that passed on changed files without a proof
were `verified` before and are `not_verified` now, so `--require-verification` exits 3 for them
instead of 0. Checks that passed with no files changed are `unchanged` (exit 0). The new
`checksPassed` field keeps the old signal: it is `true` whenever the checks passed. The receipt
lines themselves did not change.

When Casper checks only because that is its default (no flag, no `verification.mode`) and the
project has no checks, a change is `not_verified` but exits 0. Add `--verify` to make that exit 2,
or `--require-verification` to make it exit 3.

## JSON events

With `--json`, stdout carries one JSON object per line and nothing else. Every event has
`"v": 1` and a `type`. New event types and fields may be added within version 1; a breaking
change bumps `v`. Strings are JSON-escaped, terminal control characters (including C1 and bidi
controls) are escaped, and tool targets and error messages have credentials redacted.

A run ends with exactly one `receipt` event, or, when Casper stops before it can write one, an
`error` event. An `error` can also appear before the receipt (for example a provider failure).

| `type` | Fields | When |
|---|---|---|
| `session_start` | `casper` (version), `cwd`, `session` (conversation ID or null), `provider`, `model`, `effort` | The model session starts (not for local `/` commands). |
| `assistant_delta` | `text` | Streamed model text. |
| `assistant_message` | `text` | One model response's complete text. |
| `tool_start` | `tool`, `id`, `target` (path, command or pattern; redacted) | A tool call starts. |
| `tool_end` | `tool`, `id`, `ok`, `ms` | A tool call ends. `ok` is the tool status, not a check result. |
| `check` | `name`, `command`, `status` (`pass`/`fail`/`skip`), `exit`, `ms`, `recordedBy`, `reused`, `ended`?, `kind`?, `label`?, `hosts`?, `summary`? | Casper recorded a check. `recordedBy` is `casper` (auto mode, `/verify`, repair) or `casper_check` (the model asked for it). `ended` appears only on a failure that was not the code failing: `timeout`, `no_start` (could not execute, or the shell's exit 126/127), or (v0.2.17) `blocked` (the shell sandbox refused something the check tried; the receipt text says what). Named checks (`verify.checks.<name>`, v0.2.16) may add `kind` (`report`: a diff that never passes or fails; `lab`: your own lab devices), `label` (a few words such as `dry run not guaranteed`), `hosts` (lab checks) and `summary` (reports). |
| `phase` | `phase` (`task`, `checklist`, `checks`, `smoke`, `pages`, `review`, `proof`, `acceptance`, `repair`), `state` (`start`/`end`), `atMs` | A stage of Casper's work starts or ends. `smoke` and `pages` (v0.2.16) run inside `checks`. |
| `receipt` | `outcome`, `exitCode`, `execution`, `changed`, `changedDuringChecks`, `verificationMode`, `checks`, `repairAttempts`, `turnLimit`, `spendLimit`, `remoteChanges`, `remoteNotRun`, `secretInCommand`, `usage`, `proof`, `proofSkipped`, `review`, `acceptance`, `checklist`, `services`, `smoke`, `pages`, `checksPassed`, `repairModels`, `bigModel`, `security`, `task`, `undo`, `sandbox`, `changedWhilePlanning`, `pageNotes`, `verdict`, `text` | The run finished. |
| `error` | `message` | Something failed. |

### Receipt fields

**The basics.**

- `outcome` is one of `verified`, `failed`, `incomplete`, `not_verified`, `unchanged`, `cancelled`.
  From v0.2.17, `verified` means exactly what the receipt's first line calls `✓ Verified`: files
  changed, the checks pass, and a test fails without the change. Read `checksPassed` to know
  whether the checks passed.
- `exitCode` is the process exit code.
- `execution` is `completed`, `failed` or `cancelled` (did the model run finish, not "was it right").
- `changed` is the list of files the request changed, or `null` when Casper could not compare the
  workspace. `changedDuringChecks` lists files changed later, while checks and repairs ran.
- `verificationMode` is `auto`, `offer`, `off`, or `null`.
- Each entry of `checks` has `name`, `command`, `status`, `exit`, `ms` and `fresh`.
- `repairAttempts` counts repair prompts. `turnLimit` is the `--max-turns` value that stopped the
  run, else `null`. `spendLimit` is `{ "spent": 5.02, "limit": 5 }` (dollars, from the model's price)
  when the task reached a spend limit (`spend.pauseAt`, or a limit said in the request; there is
  none unless you set one) and Casper stopped it there, else `null`. A script never waits at that
  point: the run stops, keeps the work, and exits 2 (incomplete).
- `remoteChanges` lists what the AI's ssh and scp commands changed on other machines, read from the
  command text: `[{ "host": "198.51.100.20 (build-server)", "changes": ["made an API token (…)"] }]`. An
  empty `changes` means commands ran there and Casper can't tell what they did. `remoteNotRun` lists
  commands to other machines Casper stopped before they reached them (`[{ "host": …, "commands": 3 }]`):
  a run that can't ask never lets them through, and any such command makes the run `incomplete` (exit 2)
  even when the local checks passed. `secretInCommand` is `true` when a secret appeared in
  a command the AI sent; change that secret after the task.
- `verdict` is line 1 of `text`: `✓ Verified — …` only when the tests fail without the change;
  otherwise `– Checks passed — not proven: …`, `✓ Checks passed — no files changed`,
  `✗ Failed — …`, `✗ Not checked — …` (only unfinished checks), `– Incomplete — …`,
  `– Not verified — …` or `✗ Stopped — …`.
- `text` is the plain receipt a person would read.

**Usage.** `usage` is the request's model use, repair prompts included, or `null` when no model
request ran (a local `/` command). `casper --json "/security-review ai"` (v0.2.17) is a `/` command
that does use the model: its `usage` is the AI review's responses and tokens. `turns` counts the conversation's model responses. `tokens` and
`estimatedCost` total what the provider reported for each of them, plus every `delegate`
subagent's responses (a child's turns are not counted in `turns`). `estimatedCost` is what OpenRouter
reports it charged when the model runs through OpenRouter, and otherwise the model catalog's
estimate, not an invoice. Context compaction is not counted. Both totals are `null`
(unknown, never an undercount) when a response had no usage report, or the request also made
model calls Casper does not total: a subagent whose usage is unknown (a response without a
report, a run cut off mid-response or still cleaning up, or a child running the effort
classifier), or automatic effort's classifier.

**Proof.** `proof` says whether the tests prove the change (see
[VERIFICATION.md](VERIFICATION.md#proving-the-change)):

- `{ "status": "proven" | "unproven", "check", "command", "testsChanged", "without" }`,
- or `{ "status": "unavailable", "check", "reason" }` when Casper could not compare,
- or `null` when no proof applied.

`without` is the check's run on the code without the change: `{ "exitCode", "ended", "reason"?,
"output"? }`. `ended` is `pass` (unproven), `fail` (the tests failed), or weaker evidence for a
proven change: `timeout`, `crash` (a signal or crash, exit above 128) or `no_start` (exit 126/127).
`reason` is the runner's reason (for example `Timed out after 20000ms`); `output` is at most the
last 500 characters of the failing run's output. An `unproven` change has the outcome
`not_verified`. `proofSkipped` says why checks that passed on changed files came without a proof
(for example `only non-code files changed`, or a refactor request), else `null`.

**Review.** `review` is the model's requirements checklist, in one of two shapes. It is the
model's own claim, not Casper's evidence.

- The review round's answer (`verification.review: true`) is `{ "fixed": [...], "open": [...],
  "covered": n, "total": m }`. `fixed` lists only the gaps the review added a test or fix for,
  `open` those still open, and `covered`/`total` come from its `Covered: n of m` line (both absent
  after a bare `Requirements review: all covered.`).
- A full checklist (the first answer's own with the review off, the default, or a review answer
  without a count) is `{ "done": [...], "open": [...] }`, `done` being every ticked requirement.
- `{ "missing": true }` means the review returned none; `"incomplete": true` marks a review stopped
  at its turn budget; `null` means there was no checklist to report.

Any `open` item makes the outcome `not_verified`. A `covered` short of `total` with no `open` item
does not, but the receipt says `n of m requirements covered`, not all.

**Acceptance and checklist.** `acceptance` is the result of the independent acceptance check
(`verification.acceptance`, see [VERIFICATION.md](VERIFICATION.md#independent-acceptance-check-experimental)):
`status` (`pass`, `fail` or `error`), `mode` (`verdict` or `warn`), and when present `reason`,
`output` and `unconfirmed` (the failing test names, when Casper could read them); or `null` when it
did not run. `checklist` is the list of cases from the
[request checklist](VERIFICATION.md#request-checklist), or `null` when none was made.

**Services and smoke.** `services` lists the session's managed services at the end of the task,
each `{ "name", "origin", "state" }` (`origin` such as `http://127.0.0.1:53121`, or `null` when it
is not starting or ready), or `[]`. `smoke` is Casper's last smoke run (see
[VERIFICATION.md](VERIFICATION.md#smoke-checks)), or `null` when none ran (when command checks
failed with smoke checks pending, `text` says `Smoke not run: command checks failed`):
`{ "status": "pass" | "fail" | "incomplete", "checks": [...], "reason"? }`. `reason` appears when
the run is incomplete beyond its checks, such as unconfirmed service cleanup. `crashes`, when
present, lists `{ "service", "exit", "tail" }` for each service that crashed since a call last
reported it, with at most 2048 characters of log tail. Each check has:

- `id`, `name`, `service`, `source` (`config`, or `model` for one the model recorded),
  `request` (`method`, `path`), `status`;
- `baseline` (model checks: the result when recorded, before the change; `incomplete` when it got
  no HTTP response);
- `baselineAfterEdits` (`true` for a model check recorded after edits in the task or during a
  repair round, whose baseline is therefore not "before the change");
- `evidence` (whether it counts as verification: a configured pass, or a model check that failed
  before the change and passes now);
- when available, `actual` (`status` and at most 512 characters of body), `reason` and `restarted`.

**Added in v0.2.16 and v0.2.17.** All within `v: 1`; each is `null` when it
does not apply.

- `pages` is Casper's last page check on the dev server (`status`, `pages` with `path`, `status`,
  `httpStatus`, `consoleErrors`, `failedRequests`, `overlay`?, `serverError`?, and `server`), with
  console text and logs redacted. See [VERIFICATION.md](VERIFICATION.md#page-checks).
- `checksPassed` is `true` when the checks passed on the final files (proven or not).
- `repairModels` lists the model each repair used when Casper knows it; `bigModel` is
  `{ "model", "attempts" }` when the last repair ran on your big model.
- `security` holds counts only (`problems`, `notes`, `notRun`, and each tool's `status`), never
  finding text.
- `task` is the task's saved receipt number (`/receipt <n>`), and `undo` is
  `{ "available", "reason" }`: whether `casper /undo` can put this task's files back, and why not
  (see [UNDO.md](UNDO.md)). After `casper --json /undo` or `/redo`, `changed` lists the files it
  put back and `outcome` is `not_verified` (nothing checked them).
- `sandbox` is `{ "held": true, "reason": null }` when the shell sandbox held the task's shell
  commands and checks (or, for `/verify` alone, its checks), or `{ "held": false, "reason" }` when
  it did not (`--no-sandbox`, Windows, bubblewrap missing; see [SECURITY.md](SECURITY.md)).
- `changedWhilePlanning` lists files that changed during a plan turn anyway (`/plan`), and
  `pageNotes` says in plain words why changed pages were not opened (for example
  `node_modules is missing`); neither is ever a failure.

**Redaction.** `text`, `verdict`, the proof's `reason` and `output`, review items, acceptance
output and names, checklist cases, smoke bodies, reasons and crash tails are redacted like other
previews: tokens, keys and passwords become `<redacted>`.

```json
{"v":1,"type":"check","name":"test","command":"npm run test","status":"pass","exit":0,"ms":412,"recordedBy":"casper","reused":false}
{"v":1,"type":"receipt","outcome":"verified","exitCode":0,"execution":"completed","changed":["sum.js"],"changedDuringChecks":[],"verificationMode":"auto","checks":[{"name":"test","command":"npm run test","status":"pass","exit":0,"ms":412,"fresh":true}],"repairAttempts":0,"turnLimit":null,"spendLimit":null,"remoteChanges":[],"remoteNotRun":[],"secretInCommand":false,"usage":{"turns":2,"tokens":18342,"estimatedCost":0.0041},"proof":{"status":"proven","check":"test","command":"npm run test","testsChanged":true,"without":{"exitCode":1,"ended":"fail","output":"expected 3, got 2"}},"proofSkipped":null,"review":null,"acceptance":null,"checklist":null,"services":[],"smoke":null,"verdict":"✓ Verified — the checks pass, and the tests fail without the change","text":"✓ Verified — the checks pass, and the tests fail without the change\n✓ Changed 1 file: sum.js\n✓ test passed (npm run test, 0.4s)\n✓ Proven: test fails without this change (exit 1) and passes with it"}
```

### `jq` recipes

```sh
# Just the outcome
casper --json --verify "fix the test" | jq -r 'select(.type=="receipt") | .outcome'

# The model's final words
casper --json "summarize this repo" | jq -r 'select(.type=="assistant_message") | .text' | tail -n 1

# Every check Casper recorded, as a table
casper --json --verify "fix the test" | jq -r 'select(.type=="check") | [.name, .status, .exit, .ms] | @tsv'

# Files changed
casper --json --verify "rename the helper" | jq -r 'select(.type=="receipt") | .changed[]?'

# The conversation ID, to continue later with --resume
casper --json "start the migration" | jq -r 'select(.type=="session_start") | .session'
```

## GitHub Actions

```yaml
name: casper-fix
on: workflow_dispatch
jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Casper
        run: curl -fsSL https://github.com/Choaterboater/casper/releases/download/v0.2.31/install.sh | sh
      - name: Fix the failing test
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
        run: |
          set -o pipefail
          casper --json --model openrouter/<model-id> --require-verification --max-turns 40 \
            "Fix the failing test without skipping it" | tee casper-events.jsonl \
            | jq -r 'select(.type=="receipt") | .text'
      - name: Keep the event log
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: casper-events
          path: casper-events.jsonl
```

Notes on this example:

- Replace `<model-id>` with a real OpenRouter model ID.
- `set -o pipefail` makes the step fail with Casper's exit code rather than `jq`'s.
- Provider API keys such as `OPENROUTER_API_KEY` are read from the environment.
- The flags on this page ship in v0.2.13 and later, so pin the installer to v0.2.13 or newer. The
  receipt's `verdict` and `proofSkipped` fields and a check's `ended` field ship in v0.2.14.
- Checks run the repository's own configured commands without asking. They run in the shell
  sandbox where it can run (Linux with bubblewrap, macOS); on a runner without it they run with
  the job's permissions. Either way, run Casper only on code you trust, or pass
  `--no-verify`. With the sandbox, a host a check wants that is not listed is blocked in a script
  (nobody can answer); add it to `sandbox.allowedDomains` in the runner's `~/.casper/config.yaml`.
  The receipt's `sandbox` field says whether the run was held.
- Configure the checks in `.casper/project.yaml` (see [VERIFICATION.md](VERIFICATION.md#configuration));
  `--require-verification` then fails the job when Casper could not prove the change.
