# 86. An ACP app steers Casper mid-task

Date: 2026-11-07. Status: proposed. Extends 76 (Casper speaks ACP), 26 and 60. In the terminal a line typed during a
task reaches the AI at its next step, or joins the request when the model has not started. Over `casper acp` an app
had no way to do the same: `session/prompt` is refused while one runs, so a line had to wait for the whole task, or the
person stopped the task to say it.

## Decision

- **`_casper/steer`**, an ACP extension request: `{sessionId, prompt, messageId}`, with the same content blocks as a
  prompt; its pictures, and picture files it names or links, go with it as a prompt's do. The reply is
  `{steered, messageId}`. Casper says it takes one with `agentCapabilities._meta.casper.steer: true` at
  `initialize`; the router passes it to the session it names, as a prompt.
- **The terminal's rules.** While the model works, the line reaches it at its next step (with the same "typed while you
  work" note, decision 26's waits end, decision 60's slow command moves to the background). Before the model's first
  turn (a checklist call, a server starting) it joins the request as a later instruction. Either way it is part of the
  request a repair, review or proof round restates.
- **Refused, `steered: false`**: no prompt running or one being cancelled, a model or effort change being applied, a
  `/` command prompt, a `/` line that is not a picture's path, a prompt that ended (or another that started) before
  the line's turn came, a line the runtime would not take, and a line with pictures before the model starts. The app
  keeps a refused line.
- **A read notice.** When the model reads the line, Casper sends `session/update` `user_message_chunk` with the line's
  words, the app's `messageId` and `_meta.casper.steered: true`: after the model's words so far, before its next. A
  joined line is read with the first request. A line held back by a cancel, or one a prompt ended before reading, gets
  no notice.
- **Nothing is queued in Casper.** A line the model never read is forgotten when the prompt ends: it leaves the
  request rounds restate, and the runtime's unsent lines are dropped. The app sees no notice and still has the line to
  send again. Pi reads a line that waits when its run ends by itself, so this is mostly a stop.
- Lines go to the runtime one at a time, in the order they came. Pi reads them one per step.
- The terminal, `--json` and receipts are unchanged: the new runtime events (`steer_read`, `steer_unsent`) are read
  only by `casper acp`.

## Guard rails

- The line's words are hidden in the notice as the rest of the session's updates are (the `--json` redaction, your
  own secrets and the client's server values). An error's message is hidden too.
- A steered line is part of the request: the auto-mode judge, the acceptance tests and the repair rounds read it, as
  they read a line typed in the terminal. This widens what the judge reads to the app's lines, so it needs the
  owner's review.
- A line is never a command: `/` lines are refused, so no command runs mid-task from the app.
- Finding, accepted: Pi's input handlers (an extension's) may consume a line silently. Casper then says it was steered,
  and no notice comes; the app treats that as unread.
- An older app never sends `_casper/steer` and sees no change; an older Casper answers it Method not found.
