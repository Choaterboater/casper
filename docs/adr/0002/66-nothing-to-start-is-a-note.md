# 66. Nothing to start is a note, not an unfinished check

Date: 2026-11-02. Status: accepted (merged 2026-11-02 in #580). Amends 17 (try changed apps before the receipt): "recognized apps with no launch
command get an explanation" stays, and that explanation never makes the task Incomplete.

## Decision

A comparison harness's receipt said `⚠ Incomplete: app smoke didn't run: no start/dev command or declared service found
for this app`. The folder had no app of its own: its scripts opened a socket to find a free port, and the app it tests
was a fixture under `tests/fixtures/`. Before, only page files with nothing to start them were a note; an app with a
framework or server code but no launch command made the task Incomplete, and the receipt's proof line then said the
request's cases were not confirmed.

- **Nothing to start is a note.** With no start or dev command and no declared service, the receipt says `App smoke:
  not run — no start/dev command or declared service found for this app` as a grey note, and the headline is what the
  checks say. Casper never guesses a launch command, so there was nothing it could have finished.
- **Tooling is not the app.** A changed script under `scripts/` or `tools/` that opens a socket is not read as the app's
  server, unless the start or dev command runs it. Tests and their fixtures were already never the app.

## Guard rails

- A launch that fails, times out, or whose cleanup is unconfirmed is still not a pass, as decision 17 says.
- A declared service or a start or dev command is still started and checked exactly as before.
- `tests/try-it-before-done.test.ts` covers the harness folder, an app with no launch command, and a framework-less
  server with no launch command.
