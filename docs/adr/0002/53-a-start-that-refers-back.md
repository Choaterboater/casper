# 53. A first line that refers back goes to the conversation on offer

Date: 2026-11-01. Status: proposed. Amends 42 (a plain start is a new conversation).

## Decision

- **Refers back:** a short first line (typed, at most 8 words) that refers back to earlier work goes to the conversation
  the start's row offers when that conversation is today's or yesterday's. Examples: `re run test`, `rerun it`,
  `run it again`, `do that again`, `same as before`, `try again`, `fix it`, `finish that`. Casper continues it and sends
  the line there, with one line and no question:
  `[session] Continuing today's conversation (launch omp and Casper for the comparison): "re run test" refers back to it.`
- **Names a check:** a short first line that only names one of the project's checks (`run test`, `lint`) still starts
  the new conversation. Casper says which check it runs:
  `[task] "run test" runs this project's test check (npm run test) in a new conversation.`
  The Next row after it offers `1 Ask in today's conversation instead`, which sends the same words there.
- **`/continue <request>`:** goes back to the last conversation, then sends the request in it.
- **Everything else is unchanged from 42:** any other first line starts the new conversation, and an older
  conversation is never continued on a guess.

## Why

In a real v0.4.3 session the row offered `1 Continue today's conversation (launch omp and Casper for the comparison ·
83 messages)`. The person typed `re run test`, meaning the comparison. Casper started a new conversation and ran the
project's 12 unit tests (45 s), and the receipt said `✓ Checks passed`. His words afterward: "still dont know what it is
doing". He also said "as long as i dont get more and more prompts", so this adds no box or question.

## Guard rails

- Only at the start, only while the row offers a conversation, and only today's or yesterday's.
- A pasted line, a question (`?`), or a line longer than 8 words is never read as referring back.
- The line says what happened, and `/clear` starts a fresh conversation.

Tests: `tests/refers-back.test.ts`.
