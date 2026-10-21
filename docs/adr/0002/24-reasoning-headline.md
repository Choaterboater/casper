# 24. The status row may show a short headline of the model's reasoning

Date: 2026-10-21. Status: accepted (owner's choice).

## Decision

While the model reasons and its provider sends readable reasoning, the status row shows a short headline of it in place
of `Reasoning · 3.0k chars`. The headline is the reasoning summary's latest title (`Planning the port fix · 12s`), or
else its latest finished sentence, at most 60 characters, with secrets hidden and controls neutralized. It is on by
default. **Reasoning headline** in `/settings` (`reasoning_headline: false`) turns it off, and a project file can't set
it.

Before, the row only counted characters, so a long reasoning step looked like a hang. The owner wanted the harness to
show what it is doing.

## Guard rails

- Status row only. The headline never goes to the transcript, the steps pane, the receipt, a saved conversation's
  export, `--json` or the model. It is worked out from the end of the current reasoning block and kept nowhere else.
- Not at `/details quiet`, and not when the provider sends no readable reasoning (encrypted or redacted reasoning). The
  row then says `Reasoning · 3.0k chars` as before.
- One line, at most 60 characters, through the same secret hiding and control-character rules as every other shown line.
- Display only: evidence, receipts, exit codes and what the model receives are unchanged.

## A finding

The headline anywhere but the status row, more than one line or 60 characters of it, a secret in it, or a project file
that turns it on or off.
