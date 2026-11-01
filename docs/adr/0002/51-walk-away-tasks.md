# 51. Walk away: a task keeps going after its terminal closes

Date: 2026-11-01. Status: proposed.

**What:** on macOS and Linux, when the terminal goes away while a task runs (the window or the lid closes, SSH drops,
the tmux window is killed), Casper doesn't quit. The same process stays and the task becomes a *job*:

- **Nothing to turn on, nothing new to answer.** The hang-up (`SIGHUP`, or the terminal's input ending) is the hand-off.
  Saying "keep going after I leave" gets one line that says it will, with no model call; nothing is set.
- **The same session.** The job keeps the yes answers you gave this session, the servers it started and the slow
  commands in the background (they are no longer stopped on a hang-up while a job stays). What it would have written on
  the screen goes to its log, `~/.casper/projects/<key>/jobs/<id>.log`.
- **A box waits for you.** Every box the task would show (approval, host, device change, spend pause, the AI's
  question, Casper's numbered questions) is held in the job's record with its exact words and choices. The job tells
  you (a notification) and waits. The next Casper you open, in any terminal and any folder, shows
  `1 Answer the job's question`; 1 shows the same box, and your answer goes to the job, which carries on. Esc leaves it
  waiting.
- **The result.** At the end the usual receipt is saved (with Undo), the record says done or stopped with the AI's last
  words, a notification says so (Notification Center through `osascript` on macOS, `notify-send` on Linux,
  `notifications: off` silences it), and the job's Casper exits. The next start's row offers
  `See the job's result`: in its folder the receipt with `Next: 1 Show diff · 2 Undo`; elsewhere its lines and the
  folder its Undo is in. "how's my job" or `/jobs` lists them.
- **Limits.** 4 hours of work (time waiting on you doesn't count); a question waits 24 hours; then the task is stopped
  and its receipt and record say why. Spend: your own rules, unchanged (no new cap). One job a folder: a second
  Casper there whose terminal closes mid-task ends as before, so two AIs never edit the same files on their own.
  While a job works in a folder, the start there doesn't offer to continue its conversation.

**Why:** the owner: start a job, close the terminal or the laptop lid or lose SSH, and later, from any terminal, see
that it is done or waiting on him and get the receipt, the answer and the changes with Undo, "as long as i dont get
more and more prompts". Claude Code (background sessions), Codex (cloud tasks) and Copilot CLI (`/delegate`) have a
version of this; before it, only tmux kept Casper alive, and a hang-up killed it with no receipt.

Asked one question at a time, the owner chose: both a hand-off on close and plain words; on this computer (no cloud);
a question waits for him rather than being skipped or stopping the job; a notification and the start's row; 4 hours of
work, 24 hours of waiting, one job a folder and no new spend cap; diff and Undo in the job's folder, the result
anywhere; macOS and Linux now, Windows saying plainly that a closed window stops the task.

Staying in the same process (not starting a new one) is what keeps the session's answers, servers, receipt and Undo
whole: a new process would ask again for what was already allowed and split the task's receipt in two. Windows ends a
console program a few seconds after its window closes, so this can't work there the same way.

## Guard rails

- Nothing is allowed for you. A job never answers a box itself: a held box's only answers are its own choices, given
  in a Casper at a terminal; an answer for another question doesn't count, and words it didn't offer are No (as typed
  words on a box are). The judge, the always-asks list, the sandbox, private places and folder trust apply as at the
  keyboard; the judge allows only what it would allow with you there.
- Passwords and secrets never travel: an ssh, sudo or `casper_secret` box can't be shown on a job, so that login or
  secret is refused, as in a run that can't ask. Nothing secret is written to the job's files.
- The job's files are under `~/.casper/projects/<key>/jobs/`, owner-only (`0700` folder, `0600` files). The AI's
  tools can neither read nor write `~/.casper/projects`, so it can't read a held question or write an answer.
- Only an interactive session with a task running stays. A hang-up with no task, in a one-shot or `--json` run, or on
  Windows ends Casper as before (the other hang-up listeners clean up and hang up again).
- No new box, question or setting in normal use; the row and `/jobs` only offer keys; plain words need no command.

**A finding:** a job that runs a step a box would have asked about without your answer; an answer accepted for a
question other than the one shown, or a label the box didn't offer accepted as a yes; a password or secret written to
a job's files or sent between terminals; a job's files readable or writable by the AI's tools; a job started by a
one-shot or `--json` run, on Windows, or with another job working in the same folder; or a new question added to a
session that never closes its terminal.
