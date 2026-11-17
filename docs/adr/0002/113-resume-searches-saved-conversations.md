# 113. /resume searches the saved conversations' text

Date: 2026-11-17. Status: proposed. Until now `/resume` listed the eight newest saved conversations by title, and
`/resume <id>` took only the start of an ID: an older conversation could be found only by its ID. Pi already reads
every message's text when it lists a folder's sessions (`allMessagesText`); Casper kept only the first message. T3 Code
has a thread search with case and accent folding; this is Casper's form of it, inside the command it already has.

## Decision

- **`/resume <words>` searches.** A conversation matches when its name or messages hold every word, folded for case
  and accents (NFD, marks dropped, lower case: `cafe` finds `Café`). The matches come newest first in `/resume`'s own
  numbered picker, `1 Stay in this conversation` first, each with a short excerpt around its first hit; a one-shot run
  lists them with their IDs. None: `No saved conversation here mentions <words>.` and nothing changes.
- **An ID comes first.** An argument that is all hex and the start of a saved conversation's ID stays an ID, as
  before (an ambiguous one still asks for more of it). Anything else is searched, a hex word that is no ID's start too.
  `casper --resume <id-prefix>` is unchanged.
- **Only while it searches.** The runtime gains an optional `searchConversations(words)`. `RuntimeConversation`, the
  row the start's `1 Continue` row and `/continue` read on each start, does not grow: the text is read for the search
  and dropped, and a hit carries the usual row plus its excerpt.
- **Bounded.** At most the first and last 200,000 characters of each conversation are read. Words are matched first
  on the raw text, so a conversation that lacks one is never scrubbed. Plain ASCII text folds in one pass. The search
  goes newest first and stops at 50 matches (far more than the picker shows; the overflow line says "or more"), pauses
  every few milliseconds so keys still get through, and `Esc` stops it: nothing opens. Words that cannot be an ID skip
  the ID listing, so each file is read once.
- **What is searched.** What you typed and what the AI wrote (Pi's text blocks; tool results are not in it). Casper's
  classification hints before `User request:`, the same in every conversation, are taken out first.
- **Secrets.** A candidate's text goes through the device rules and the always-on pass a read gets, with Casper's
  own values (its logins, typed secrets, secret-named environment values), then the preview redaction every other
  preview uses (`sk-…`, `AKIA…` keys in prose), before it is matched. A hidden secret never matches, `<secret hidden>`
  and `<redacted>` are not words the search finds, and an excerpt only ever shows the scrubbed text.
- **No model call, no tokens.** It runs on your computer, like the listing.

## Guard rails

- `/resume` with no words and `/resume <id>` behave as before; a runtime without `searchConversations` keeps the
  ID-only behaviour.
- `tests/resume-search.test.ts` checks folding, every word, the excerpt, the bound, the hint lines, the secret rules
  (key-shaped values, and Casper's own values passed to the Pi file search), the hit limit and the stop over fixture
  Pi session files; `tests/resume-picker.test.ts` the picker, ID-first, a hex word that is no ID's start, the saved
  network login and the stop signal reaching the search, and the no-match line;
  `tests/resume-search.integration.test.ts` a real one-shot run with no model request.

## A finding

A search that calls a model; a hidden secret that matches or shows in an excerpt; a whole conversation's text kept on
the listing rows or after the search; a hex argument that is an ID's start searched instead of opened; the
conversation you are in offered as a match.
