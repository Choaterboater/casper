# 40. One key fixes what a /look report found

Date: 2026-10-26. Status: accepted (the owner chose it, and chose `1` on the Next row over a bare Enter).

## Decision

A `/look` report names a `/look` command for each issue it finds (`critique` and `audit` do). Casper keeps those
commands, and the page, for `/look fix`. In a session, the row under the answer then offers
`Next: 1 Fix all of it (uses tokens)`, with the commands and the page on the line under it. `1` runs `/look fix`: one
task that fixes everything the report found, most important first, with each named command's instructions.

- The key is `1`, as for every Next step. A bare Enter runs nothing (the guard rail of
  [decision 1](../0002-deliberate-choices.md)). On the rich terminal the digit alone picks the step, so it is still
  one key.
- The row waits until the report's questions are answered. It never comes under a question
  ([decision 33](33-no-card-until-done.md)), and here not under a closing list of questions either, where a typed `1`
  would read as the answer to the first one. The critique asks at most 3, last, and only where an answer would change
  a fix.
- A reply that revises the list ("mainly a desk", "drop 3") gets the row again under the new list, with the
  commands in the new order.
- `/look fix` and `look fix` work without the row until they have run once. A new report replaces the list;
  `/clear`, `/resume` and a session switch forget it.

## Why

The owner, after a real `/look critique`: "keep asking to do the different look, kinda redundant". The critique named
`/look adapt`, `/look polish` and `/look clarify` for its 5 issues, and he typed them one line at a time, one with a
typo.

He chose one key after the critique, or after answering its questions, over fixing straight away. `/look critique`
promises to change no files, and his answer to its first question ("mainly pc") reordered the fixes. He then chose
`1` over Enter: an Enter pressed by habit on an empty prompt would start edits.

## Guard rails

- Nothing runs until the person presses `1` or types `/look fix`. The fix is an ordinary task: the same tools,
  approval boxes, sandbox, spend pause, checks and receipt.
- No row under a question or a closing list of questions, after a task that changed something, in a one-shot run or
  with `--json`.
- The row says what it runs: the commands, the page, and that it uses tokens.

A finding: the row under a question or a closing list of questions; Enter running it; a fix that starts without `1`,
`/look fix` or `look fix`; or the row in a one-shot or `--json` run.
