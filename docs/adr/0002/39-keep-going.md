# 39. Keep going until the work is done

Date: 2026-10-26. Status: accepted (merged 2026-10-26 in #500). It changes one case
of decision 33: in a session with keep going on, Casper says "go" itself once instead of showing the paused line at
once.

## Decision

In a session, the AI's turn may end with work it says is not done (`Still not done:` lines), or with its last words
saying what it does next. When it asked the person nothing, Casper sends it on itself:

- One line says so: `↻ keep going 1/2: 2 items still open, so the AI carries on (Esc stops it)`.
- The AI gets the open items, and the accepted plan's steps it never reported. It is told to do what it can now,
  leave only what needs the person and say why, and use the ask tool for a choice.
- At most 2 rounds a task, and none after a round that leaves as much open as before. Then the receipt card, or
  decision 33's line, follows as before.
- The task prompt asks for open items only for what needs the person or is blocked: "Do the rest yourself".
- The task after a plan build hears the accepted steps still open and where the saved plan is
  (`.casper/plans/…md`). So "finish it" has the list, and the AI doesn't go looking in Casper's own records, which it
  can't read.
- `keep_going: off` in `~/.casper/config.yaml` (`/settings` → Keep going) waits for the person instead. A project
  file can't set it.

## Why

The user: "feel like this process could go smoother and better - more like when i use copilot- auto do things instead
of me asking over and over".

In a long real session, 9 of the person's lines were only there to get work finished: "do all of them", "why are you
stoping just do all of them", "keep working on the huge list i gave and made you stop like 5 times so noting was
finished". Its answers carried 47 `Still not done:` lines, several of them work the AI could do itself: a data fix it
handed to the person, a browser extension, its own parser misses. Twice the AI tried to read the accepted plan's steps
from Casper's private records.

Other agents carry on by themselves: Copilot CLI's autopilot keeps working until the task is complete. Claude Code goes
on while there is work it can do.

## Guard rails

- Nothing new runs without asking. A round is the task's own turn: the same tools, gates, approval boxes, sandbox,
  spend pause and turn limit. Esc stops it as it stops any turn.
- Never after a question: an ending that asks the person something waits for them (decision 33).
- Bounded: 2 rounds a task, and no round that makes no progress. A stop, a failure, a turn or spend limit, or a tool
  run after the AI's last words ends it.
- Only in a session. One-shot runs, `--json` and scripting are unchanged.
- The checks, the proof and the receipt follow the last round, as for any turn, and the receipt is saved as always.

A finding: a round after the AI asked the person something; a third round in a task; a round in a one-shot or `--json`
run; or a round that skips a gate or approval box the task's own turn would show.
