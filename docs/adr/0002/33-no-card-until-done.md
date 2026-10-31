# 33. No receipt card until the task is done

Date: 2026-10-23. Status: accepted (merged 2026-10-23 in #479).

## Decision

A session showed the receipt card after every task that changed something, ran checks or was not a plain question,
including tasks where the AI's last words asked the person something or said what it does next and stopped. The card
read as a finished task, and its numbered keys looked like the options the AI had just offered. Now:

- When the AI's last message asks you something, or says what it does next and stops, a session shows one line instead
  of the card and its keys: `? Waiting for your answer`, or `Paused — the AI said what it does next; say go, or tell it
  what to change`, with where the changes so far are (`· /receipt 12 shows the 2 files changed so far`).
- The card that ends the work names what changed before your answer (`– Also changed before your answer: 2 files
  (/receipt 12)`); when your answer needs no change, the card shown is the one held back.
- When the card would only say that no files changed (no check ran, nothing changed in the project, outside it or on
  another machine, and nothing needs you), there is no card: the AI's message is the whole result.
- The AI's open items are plain `Still not done:` lines, never checkboxes, and the AI is told to ask with the ask tool,
  not in a question ending its reply, and not to stop just to say what it will do next.

How it decides: a few patterns on the closing words of the AI's last message only (its last paragraph, past a code
block, the open items and a list of options, and only when no tool ran after them). No model call and no extra tool
field, which small local models struggle with.

## Guard rails

- The receipt is saved for every task as before: `/receipt`, `/undo` and `/diff` work on a task that showed the line.
- A failure, a stop, work that did not finish, a secret Casper saw and a risky config line always show their card,
  with the line under it and no keys.
- Changes made before the AI asked are never hidden: the line names their receipt, and the card that ends the work
  names it again.
- A wrong guess costs one line or one card: a finished task that ended with a question shows the line (its card follows
  your next request; `/receipt` has it now), and a missed question shows the card as before.
- One-shot runs, `--json`, exit codes and saved receipts are unchanged; `--verbose` prints the full receipt with the line
  under it.

A finding: a card hidden for a failure, a stop or a secret; a receipt not saved; changes made before the question named
nowhere; or the line after a reply whose closing words neither ask nor say what the AI does next.
