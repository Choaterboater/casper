# 28. The flag that allows shell commands is told to the person, not the AI

Date: 2026-10-22. Status: accepted (merged 2026-10-22 in #463). Decision 1 is unchanged.

## Decision

When a run can't ask (one-shot, `--json`, piped) and a shell command needs your OK, the AI reads only what it can do
instead: `Not run: shell commands need the user's OK here, and this run can't ask them. Don't send this command again,
with or without a flag, and don't ask for one: casper_check runs the project's checks, read, grep, find and ls look at
files, edit and write change them, service starts the app. Only the user can allow commands, before the run.`

The way to allow them for one run (`--no-sandbox`) is told to the person: on the step's line on screen, and once a
session as `[shell] This run can't ask before the AI's shell commands, so they are not run. --no-sandbox allows them for
one run.` (stderr with `--json`).

Before, the AI read "Use --no-sandbox to allow them for this run." A local qwen3.5:9b in unattended benchmark runs then
ran `bun diagnose.js --no-sandbox` four times and `bun test --no-sandbox ./tests/…`, or ended its task with "The shell
needs --no-sandbox flag". The same text cost an earlier hosted run its failed-command tasks.

## Guard rails

- Nothing is allowed that was refused before: the command still doesn't run, and only the person's own flag or answer
  changes that. The "Not run:" prefix, the screen's not-run line and decision 1 stay as they are.
- This covers the shell's refusal. The refusals for reaching another machine and for a write outside the project still
  name their flags (`--allow-reach`, `--allow-write`) as something to tell the user; they can follow the same rule if
  they show the same problem.
