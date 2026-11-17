# 108. A task cut short goes on carefully

Date: 2026-11-17. Status: proposed. Builds on 42 (a plain start is a new conversation, with one row to continue the
last), 53 (a first line that refers back) and 51 (walk-away jobs). The idea of noticing a turn that was cut short and
telling the model about it comes from another coding-agent app (T3 Code), which does the same.

## Decision

- **Cut short.** Casper stopped (it crashed or was killed, ran out of memory, the computer restarted, its console
  closed) while the AI's last steps were running. Pi saves the AI's message with its tool calls before they run, and
  each result only when it ends. So the conversation's last AI message asks for steps that have no result, and nothing
  came after them. An Esc is not cut short: Pi records that turn as aborted. A failed reply isn't either: Pi never ran
  its steps. (`src/sessions/cut-short.ts`)
- **Why it matters.** When that conversation goes on, Pi fills each missing result with the error
  `No result provided`. The model may then read a `git push` or a migration that did run as failed, and run it
  again.
- **The start's row.** When the conversation the row offers was cut short, its one key is reworded:
  `Next: 1 Go on with the task that was cut short (push the release, today)`, with the request it worked on and
  its day. There is no second choice, and anything typed still starts a new conversation. The key continues that
  conversation and sends a note as the whole request.
- **The note.** However the conversation is continued (the row, `/continue`, `/resume`, `--continue`, `--resume`,
  or a first line that refers back, decision 53), the next request carries one note before it:

  ```text
  Casper note: Casper closed while this step was running (it crashed, was closed, or the computer restarted), so it has no result:
  - bash: git push origin main
  "No result provided" doesn't mean it failed: it may have run, or may still be running. Before you repeat a step that changes something (a push, a migration, a deploy, a write), check whether it already happened.
  ```

  The note names each step's tool and its command, path or address, trimmed to one line. When it is the whole
  request (the row's key), it adds `Then go on with the task.`
- **Said on screen.** `/continue`, `/resume` and `--continue` print one line before `Ready: …`:
  `[session] Its last task was cut short while bash was running; the AI checks before repeating a step.`
- **Walk-away jobs.** A job that ended with `Casper stopped before the job ended (the computer restarted, or it was
  closed)` and whose conversation was cut short offers the same key in `/jobs show` in its own folder. In another
  folder, `/jobs show` says which folder to start Casper in. The start's row in the job's folder offers it too.
- **Once.** The note goes with the first request that reaches the conversation: once a request follows the entry, the
  conversation no longer ends on it, so neither this Casper nor a later one sends the note again. A request that failed
  before it got there (no sign-in, no key) leaves the conversation cut short, so the next request still carries it.
- **Not while another Casper works in it.** Pi saves the AI's steps before they run, so a conversation another Casper
  in the same folder is working in looks cut short too. While a request runs, a small file beside the conversation
  (`<conversation>.jsonl.running`) holds that Casper's process number, and it is taken away when the request ends. A
  conversation whose mark names a live process that isn't this one is not cut short; a mark left by a Casper that is
  gone doesn't count.
- **Off switch.** `/settings` **Tasks cut short** (`cut_short: false` in `~/.casper/config.yaml`; a project file can't
  set it): the start's row offers its usual Continue, and no line or note is added.

## Why

A crash mid-step is rare, but when it happens the model's own record says the step failed when it may have run.
Repeating a push, a deploy or a migration is the costly mistake. One note costs a few tokens, and only after a turn
was really cut short. Nothing is asked, and a conversation that wasn't cut short is unchanged. It is on by default with an off switch, as
Casper's other features are.

## Guard rails

- No new box, question or choice: the row keeps one key, reworded, and typing still starts a new conversation (42).
- Nothing runs on its own: the row's key, like any key, runs only when you press it.
- Read only until then: the row reads the saved file and starts no model.
- No cost by default: no note, no line and no tokens unless the last turn was cut short.
- Off means off: with `cut_short: false`, nothing in this decision runs.

A finding: a note sent for a conversation that wasn't cut short (an Esc, a finished turn, a request after it, one
another live Casper is working in); the same note sent with two requests that reached the conversation; a note lost
to a request that failed before it got there; a second key on the start's row; a note when nothing continues the
conversation; or any of it with `cut_short: false`.

`tests/cut-short.test.ts` checks the detection on saved files (and that Pi reads the same branch), an Esc, a failed
reply, a request after it, another live Casper's mark and a gone one's, the mark Pi's runtime keeps while a request
runs, the note's words, the note kept after a request that failed before it got there, the off switch, the row and its
key, `/continue`, `--continue`, and a job's pick-up here and in another folder.
