# 102. A page build finishes its browser checks

Date: 2026-11-10. Status: proposed. Extends 0002 §6 (the AI may withdraw a browser check it wrote wrong), §7 (a new
check whose selector matches several elements is not kept) and [decision 101](101-browser-checks-in-fewer-rounds.md)
(`replaces`), without changing their rules. A build could end with only checks written wrong, answered Cancel or
withdrawn, or with no browser check at all, and nothing asked again: the one finish turn took only checks that never
finished. A replacement that was written wrong too left the first check standing, so even a passing third check left
the task Incomplete.

## Decision

- **One finish turn, four groups.** After Casper's end replay, the one finish turn (a round's turns, in the repair
  phase, "Don't change the app in this turn") now takes, each in its own section of one prompt: checks that never
  finished (today's text, word for word); checks of a page on this computer written wrong or answered Cancel (record a
  corrected check with `replaces: <its id>`; the prompt prints each check's reason, with what matched); a page on this
  computer whose every check was withdrawn (record a correct check of it, without `replaces`); and, for a page build,
  no browser check at all. A check of another site is in neither of the middle two: Casper doesn't replay it, and
  `dialog: "accept"` works only here. The turn's reply does not replace the task's own answer, which its next steps
  and an away job read; it is still read for a claim that the browser checks passed. The
  screen says each in one phrase after `↻ finish: `, joined by `; `. A check whose server is gone, or that couldn't be
  replayed, keeps its reason and gets no turn, as before.
- **A page build is asked for one check.** Only when the task's checks ran in `auto` mode, the request builds or fixes
  something, the access is not read-only, the checks passed with changed pages Casper's page check opened, the browser
  tool is on and Chrome is installed, and the task recorded no browser check: the turn names up to 5 of those pages
  and asks for one check of the main thing the request has a person do there, or one line saying why none can be
  checked in a browser. If none is recorded, the receipt says `– No browser check: Casper asked for one of the changed
  pages and the AI recorded none`. The verdict does not change.
- **A failure from that turn reaches the repair.** A check that started failing in the finish turn, recorded then or
  replayed by the AI (an unfinished one), is replayed with the others after it, and a failure gets the one browser repair turn, if `repair.maxAttempts` has one left. There is no
  second repair and no second finish turn.
- **A replaces chain.** A check recorded with `replaces` that does not pass keeps the link. When it or a later check
  that replaces it passes, by any route (recorded, replayed by the AI or by Casper's end replay, or named in a
  `withdraw`'s `replacedBy`), each check back along the links that is still standing (not passed, not withdrawn) is withdrawn the
  same way, through `withdraw` with `replacedBy` set to the passing check; the first refusal stops the walk and is said
  in the result. The "Not replaced" note says the old check still stands and decides the result, and that replacing
  this check also replaces the old one.
- **Plain words where the AI meets them.** The browser tool's description and its lean form say to recheck with
  `replaces` until one passes. A bare `withdraw` of the last check of a page says no check of that page is left. A new
  check that stopped part way offers `replaces` first, then a bare `withdraw` while nothing has changed; a `replaces`
  refused because the new check tests less says the same, for a check that tests what the request doesn't ask for. A
  new check refused as written wrong whose steps that ran fill a fixed email or name says which ran and that what they
  saved stays in the app (use `{run}`); on a step refused, only the steps before it ran. A check
  answered Cancel says to record it again with `dialog: "accept"` and `replaces`.

## Guard rails

- The `withdraw`, `replacedBy` and `replaces` rules are unchanged, and every link of a chain goes through `withdraw`:
  a replacement must pass, be recorded later, open the same page at the same viewport and test at least as much. Each
  `replaces` step already checks that against the check it replaces, so it holds along the chain.
- One finish turn and one browser repair, as before. No approval box. `browser: off` turns off the tool and the page
  build's request together; `repair.maxAttempts` still bounds the repair.
- The fixed prompt does not grow: the description and its lean form are shorter than before.
- **A finding:** a check withdrawn without a passing replacement after a change, a chain link withdrawn outside
  `withdraw`, a second repair loop or finish turn, or a verdict that the receipt's `No browser check` line changes.
