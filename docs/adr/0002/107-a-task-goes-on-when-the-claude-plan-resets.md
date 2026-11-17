# 107. A task goes on by itself when the Claude plan's limit resets

Date: 2026-11-16. Status: proposed. Builds on 106 (the Claude plan says its limits) and is one case of 39 (keep
going). Under 106, a task that ran out of the Claude plan's 5-hour limit with no failover model to go on stopped
with the window and its reset named, and the person had to come back after the reset and say "continue". The idea
of waiting for the reset and going on comes from another coding-agent app (T3 Code), which does the same.

## Decision

- **When.** The task's turn failed on a used-up Claude plan window (the error names it, decision 106), the model in
  use is still the plan's own (failover found nothing to go on), and the window resets within 24 hours: in practice
  the 5-hour limit. A weekly reset, or any reset more than a day away, is only named
  (`Claude's weekly limit resets at Tue 3:40 PM, more than a day away, so Casper doesn't wait for it.`).
- **One line, one timer.** `Claude's 5-hour limit resets at 3:40 PM; Casper goes on then. Type anything or press
  Esc to cancel.` At the reset (30 s after, so the window has surely reset), the same task goes on:
  `↻ keep going 1/2: Claude's 5-hour limit reset, so the AI carries on (Esc stops it)`, and the AI is told:
  "Continue where you left off. Your last turn stopped at a usage limit; check what already took effect before
  repeating a step that changes files or state."
- **A keep going round.** It counts as one of decision 39's 2 rounds a task, and comes once a task: a second stop on
  a limit after it ends the task. `keep_going: off` turns it off too, so there is no new setting.
- **Cancelled by** a line you type (it then runs as your next request, as any queued line does), Esc, Casper
  closing, a change to the folder's files since the stop (the task's own listing of the folder, taken at the stop and
  at the reset), or a model other than the plan's in use at the reset.
- **Walk-away jobs (decision 51).** A job waits the same way. Its record says `waiting` with why (`the Claude plan's
  5-hour limit resets at 3:40 PM`) and no question, so `/jobs` shows `waiting till …` and the row says
  `Job working here`. The wait doesn't count toward the job's 4 hours of work. A terminal that closes during the
  wait turns the task into a job that keeps waiting.

## Why

The 5-hour limit runs out mid-task and resets on its own a few hours later. Coming back only to type "continue" is
the kind of prompt decision 39 removed. Waiting costs nothing: no model call and no tokens until the reset.

## Guard rails

- Nothing new runs without asking: the resumed turn is the task's own, with the same tools, gates, approval boxes,
  sandbox, spend pause and turn limit as any keep going round.
- Bounded: once a task, inside keep going's 2 rounds, never for a reset more than a day away. Never chained.
- Never onto another model: a failover model the task switched to doesn't get the resumed turn.
- Never over your changes: a file changed in the folder while it waited means it doesn't go on.
- Only in a session, as keep going: one-shot runs, `--json` and ACP are unchanged.
- The timer doesn't keep Casper running by itself (an open terminal does; in a job, where nothing else would, it
  holds Casper until the reset), and it is cleared when the task ends, is cancelled or Casper closes. It reads the
  wall clock at least every minute, so a computer that slept goes on when it wakes.

A finding: a wait for a reset more than a day away; a second wait in one task; a resumed turn on a model other than
the plan's; a resume after a typed line, Esc, or a change in the folder; a wait with `keep_going: off`; or a wait in
a one-shot, `--json` or ACP run.

`tests/plan-reset.test.ts` checks the wait and its clock, the resumed turn, once a task, keep_going off, another
model, a weekly reset, a typed line (also one typed before the wait is said), a changed file, a job's waiting record,
and a terminal that closes during the wait.
