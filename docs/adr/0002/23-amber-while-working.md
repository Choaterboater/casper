# 23. A failed step is amber while the AI works; red is for the result

Date: 2026-10-21. Status: accepted (owner's choice).

## Decision

While the AI is still working, a step that failed keeps its `✗`, its box and Ctrl+T, in amber: its live row, its
folded failure box, Casper's own check lines and their boxes, and `/output`'s replay of a failed call. Red is kept for
the task's result and for what stops work: the receipt's edge and its `✗` lines (in `--verbose` and `/receipt` too),
`[error]` lines, and removed lines in a diff.

Before, every `✗` and every failure box was red. A test that failed on the way to a fix, or a command the AI could
still retry, looked the same as a task that had failed, and the screen showed red for things that were not bad. The
owner chose amber for the work and red for the result.

The marks and their colours are listed in [TERMINAL_UX.md](../../TERMINAL_UX.md). `tests/failure-colour-ansi.test.ts`
checks them in the bytes the terminal writes.

## Guard rails

- Display only: verification evidence, `--json` events and outcome, exit codes, saved receipts and `--verbose` text
  stay the same. Only the colour of a step's failure changes.
- Every failure still shows, with its `✗`, its box with what it printed, and Ctrl+T. None is folded away or turned into
  a note by this decision.
- A failed result is red wherever it shows: the receipt's edge and lines, `--verbose` and `/receipt`.
- `NO_COLOR`, a pipe and `TERM=dumb` show the same marks and words without colour.

## A finding

A failure that is not shown, or a failed result that is not red.
