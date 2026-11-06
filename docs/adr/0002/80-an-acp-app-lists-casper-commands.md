# 80. An ACP app lists Casper's commands

Date: 2026-11-06. Status: proposed. Extends 76 (Casper speaks ACP), 77, 78 and 79. Over `casper acp` a typed
`/status` ran, but its output went to stderr only, so the app showed nothing, and the app's `/` menu did not know
Casper's commands.

## Decision

- **The list.** After the `session/new` or `session/load` reply (a load's after the conversation it replays), Casper
  sends `available_commands_update`: its commands in `/help`'s order, then your own from `~/.casper/commands` that no
  Casper command hides. `name` has no slash; `input.hint` is the argument hint, or the first four subcommands
  (`detail|add|setup|login|…`), and is there only when the command takes words. A prompt sends the list again, before
  its reply, only when it changed (a file you added). The router holds a new session's list until its own reply is
  out, so the client always knows the session first.
- **Left out of the list** (`LEFT_OUT` in `src/acp/commands.ts`, each with its reason), though they still run typed:
  what the app owns (`model`, `effort`, `permissions`, `export`), what changes the conversation or folder (`clear`,
  `new`, `resume`, `continue`, `rewind`, `branch`, `switch`, `project`), what only a terminal has (`pane`, `details`,
  `theme`, `hotkeys`, `exit`, `copy`, `settings`, `login`, `logout`), what does nothing here (`trust`, `suggestions`)
  and `rename`, which comes with the app's chat titles. Hidden commands are never listed.
- **A command is prompt text**, told apart as the terminal does: a leading `/` that is not a picture file's path. Its
  line is not echoed. What the terminal shows for it, until its model speaks, is Casper's reply: one fenced `text`
  block (four backticks, so a ``` line in it does not end it; a line of four or more gets a zero-width space before
  them, so it can't either), a whole line at a time, closed by the next model text, step, check, error or the
  prompt's end. `[image] …` and `[plan] …` lines are notes outside the block. A command
  that is not a task has no receipt line; the reply still carries `_meta.casper.receipt`.
- **An error ends the turn normally.** An unknown command or words it does not take send `[error] …` and reply
  `end_turn` with `_meta.casper.error`, as the terminal prints the error and goes on.
- **Switches are refused in plain words.** `/clear` (and `/new`), `/resume`, `/continue`, `/rewind`, `/switch`,
  `/branch <name>` and `/project <name>` or `/project new …` would move Casper to another conversation or folder
  while the app's chat stays put. Each sends one line saying what to do in the app ("… start a new chat in the app.
  Nothing changed.") and replies `end_turn` with `_meta.casper.refused`, with nothing run. Bare `/branch` and bare
  `/project` only show something, so they run.

## Guard rails

- Every name, description, hint, output line, error and refusal goes through the session's hiding, a whole line at a
  time, so a secret split across two writes is hidden whole. A command whose name hiding would change is left out.
- Boxes are unchanged: a box a command shows reaches the app as every other box does (decision 76).
- Your own command files are read from your home only, as in the terminal; a project's folders never add one.
- `--json`, the screen and receipts are unchanged.
- An app that does not read `available_commands_update` still sends typed commands as before; it now gets their
  output as the reply.
