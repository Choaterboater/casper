# Scripting and CI

Casper runs one prompt and exits when you pass the prompt as arguments. The flags below make
that usable from scripts, CI and benchmarks: choose the model per run, stream machine-readable
events, continue a conversation, and get an exit code that reflects verification.

```sh
casper --json --model github-copilot/gpt-5-mini --verify --require-verification "fix the failing test" \
  | jq -c 'select(.type=="receipt")'
echo "exit $?"
```

Options go **before** the prompt. Everything after the first non-option word is the prompt, so
`casper explain the -v flag` is a prompt. Put `--` before a prompt that starts with `-`. Value
options accept `--name value` or `--name=value`.

## Flags

| Flag | Effect |
|---|---|
| `--model <provider/model-id[:effort]>` | Use this model for this run only. Also accepts `@role` selectors. The saved default is never changed. |
| `--effort <level\|auto>` | Reasoning effort for this run only (`auto`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Any level runs on any model: one the model lacks runs as the nearest level above it, else below (`medium` on a model with only low and high runs as high; a model without reasoning runs without it). Not remembered. |
| `--json` | JSON Lines events on stdout (below). Everything a person would read (banner, transcript, receipt) goes to stderr. Needs a prompt. |
| `--verify` / `--no-verify` | Casper runs the checks after this run's edits (`auto`), or runs none (`off`). See [VERIFICATION.md](VERIFICATION.md). |
| `--require-verification` | Implies `--verify`. Changes Casper did not verify exit **3** instead of 0. Needs a prompt. |
| `--continue` | Continue this folder's most recent conversation. With none, a new one starts (with a notice). |
| `--resume <id-prefix>` | Continue the saved conversation whose ID starts with this prefix. `casper /resume` lists IDs. |
| `--cd <path>` | Work in that folder instead of the current directory. |
| `--max-turns <n>` | Stop each model request after `n` model turns (1–9999). The run is then incomplete (exit 2) and Casper runs no checks. The requirements review and proof repair rounds have their own 12-turn budget; hitting that is not this stop (see VERIFICATION.md). |
| `--verbose` | The detailed evidence receipt instead of the plain one. |
| `--mcp <name>`, `--lsp <name>` | Connect your own configured MCP or language server first (repeatable). |

An unknown `--model` or an effort the model doesn't support is a usage error (exit 64) found
before any model request. Missing credentials for the chosen provider exit 1 with the sign-in hint.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. Changes, if any, were verified — or, without `--require-verification`, simply not disproven. A run that changed nothing exits 0. |
| 1 | Failed: a check failed, checks were blocked, the model run failed, or Casper hit an error. |
| 2 | Incomplete: checks could not finish, `--max-turns` stopped the model, or `--verify` found changes but no configured check. |
| 3 | Not verified (only with `--require-verification`): files changed but Casper recorded no fresh passing check — checks off, none configured or covering the files, bash-only test runs, or a pass that went stale. |
| 64 | Usage error: an unknown option, a bad value, conflicting flags, an unknown model or conversation. Nothing ran. |
| 130 | Cancelled (Ctrl-C / SIGINT). |
| 143 | Terminated (SIGTERM). |

Failure takes precedence over incompleteness, which takes precedence over "not verified".

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
| `check` | `name`, `command`, `status` (`pass`/`fail`/`skip`), `exit`, `ms`, `recordedBy`, `reused` | Casper recorded a check. `recordedBy` is `casper` (auto mode, `/verify`, repair) or `casper_check` (the model asked for it). |
| `receipt` | `outcome`, `exitCode`, `execution`, `changed`, `changedDuringChecks`, `verificationMode`, `checks`, `repairAttempts`, `turnLimit`, `usage`, `proof`, `review`, `text` | The run finished. |
| `error` | `message` | Something failed. |

`receipt.outcome` is one of `verified`, `failed`, `incomplete`, `not_verified`, `unchanged`,
`cancelled`. `receipt.exitCode` is the process exit code. `changed` is the list of files the
request changed, or `null` when Casper could not compare the workspace. Each entry of `checks`
has `name`, `command`, `status`, `exit`, `ms` and `fresh`. `text` is the plain receipt a person
would read.

`usage` is the request's model use, repair prompts included, or `null` when no model request ran
(a local `/` command): `turns` counts the conversation's model responses, and `tokens` and
`estimatedCost` total what the provider reported for each of them plus every `delegate`
subagent's responses (a child's turns are not counted in `turns`). `estimatedCost` is the model
catalog's estimate, not an invoice. Context compaction is not counted. Both totals are `null`
(unknown, never an undercount) when a response had no usage report, or the request also made
model calls Casper does not total: a subagent whose usage is unknown (a response without a
report, a run cut off mid-response or still cleaning up, or a child running the effort
classifier), or automatic effort's classifier.

`proof` says whether the tests prove the change (see docs/VERIFICATION.md, "Proving the change"):
`{ "status": "proven" | "unproven", "check", "command", "testsChanged" }`, or `{ "status":
"unavailable", "check", "reason" }` when Casper could not compare, or `null` when no proof applied.
An `unproven` change has the outcome `not_verified`. `review` is the model's requirements checklist from its review round
(`{ "done": [...], "open": [...], "total": m }`, or `{ "missing": true }` when it returned none), or `null` when no
review ran. With `total` (the requirement count the review reported), `done` lists only the gaps the review
fixed and `open` those still open; without it (`verification.review: false`, or an answer with no count),
`done` is the full checklist. It is the model's own claim; any `open` item makes the outcome `not_verified`.

```json
{"v":1,"type":"check","name":"test","command":"npm run test","status":"pass","exit":0,"ms":412,"recordedBy":"casper","reused":false}
{"v":1,"type":"receipt","outcome":"verified","exitCode":0,"execution":"completed","changed":["sum.js"],"changedDuringChecks":[],"verificationMode":"auto","checks":[{"name":"test","command":"npm run test","status":"pass","exit":0,"ms":412,"fresh":true}],"repairAttempts":0,"turnLimit":null,"usage":{"turns":2,"tokens":18342,"estimatedCost":0.0041},"proof":{"status":"proven","check":"test","command":"npm run test","testsChanged":true},"text":"✓ Changed 1 file: sum.js\n✓ Verified by Casper: test passed (npm run test, 0.4s)\n✓ Proven: test fails without this change and passes with it"}
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
        run: curl -fsSL https://github.com/Choaterboater/casper/releases/download/v0.2.12/install.sh | sh
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

`set -o pipefail` makes the step fail with Casper's exit code rather than `jq`'s. Provider API keys
such as `OPENROUTER_API_KEY` are read from the environment. The flags on this page are newer than
the v0.2.12 preview: pin the installer to a release that includes them. A check runs
the repository's own configured commands: that is execution consent, not sandboxing, so run it
only on code you trust. Configure the checks in `.casper/project.yaml` (see
[VERIFICATION.md](VERIFICATION.md)); `--require-verification` then fails the job when Casper
could not prove the change.
