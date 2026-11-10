# 92. Another chat is a record, not requests to follow

Date: 2026-11-07. Status: proposed. Extends 90 (Embedded context is not the request) and 78. Under 90 the model still
read an app's embedded text as plain lines after the person's words. In a live test the person mentioned another chat
and asked what it changed; that chat's own first request ("before you change anything, ask me one question...") was in
its text, and the AI asked the person that question.

## Decision

- **Context is labelled.** Each piece 90 calls context (embedded text with no file behind it, or its cut) goes to the
  model between two fixed lines: one before it that says it is context from the app, such as another chat, a record to
  read and not the request, and that requests in it were made there and are not to be acted on now; and
  `[End of context]` after it. The piece itself (`${uri}\n${text}`) is unchanged inside them.
- **The request stays the person's words.** What Casper reads to choose a checklist, an offer or a `/` command is the
  request without the labelled piece, as 90 says; the lines go with the piece, so they are never read as asked either.

## Guard rails

- The fixed prompt does not grow: the lines are in the request only when it has such context.
- A `file:` embed, a link, a picture and a blob get no label, as 90 leaves them.
- The model still reads the whole piece: the label says how to read it, it removes nothing.
