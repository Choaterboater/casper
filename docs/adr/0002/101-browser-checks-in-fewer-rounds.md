# 101. Browser checks in fewer rounds: listed matches, replaces, whole refusals, 30 steps

Date: 2026-11-09. Status: proposed. Extends 0002 §6 (the AI may withdraw a browser check it wrote wrong) and §7 (a
new check whose selector matches several elements is not kept). The rules of a check stay as they are. What changes
is how many model rounds it takes to follow them: a selector error that said only how many elements matched, a
`withdraw` refused one rule at a time, a replacement that needed a second call to withdraw the old check, and a 12-step
cap that split one form across checks. None of this changes what passes: a broken page fails on every one of these
paths.

## Decision

- **A selector error lists the elements.** When a check's step or assertion selector, or an action's, matches several
  elements, the error lists each one (up to 5): its tag, `data-testid`, first text and a selector that matches it
  alone, from an id or `data-testid` unique on the page or the shortest `tag:nth-of-type` path, with `host >>> inner`
  inside a web component. One that matches nothing lists the elements most like it the same way, under `near:`. §7
  stays: a new check whose selector matches several is still not recorded.
- **A refusal says everything at once.** A `withdraw` refused after a change names the one call that replaces the
  check and all it needs: the same page and viewport, at least as many steps and assertions of each kind (`at least 2
  fill steps, 1 click step and 1 text assertion`), and a pass. A refused `replacedBy` names every reason, not the
  first.
- **`check` takes `replaces: <id>`.** Before anything runs, Casper refuses, recording nothing, a `replaces` naming an
  unknown, passed or withdrawn check, or a scenario of another page or viewport or with fewer steps or assertions of a
  kind. The check then runs as any new check. Once it passes, the old one is withdrawn through `withdraw` with
  `replacedBy` set to it, so every §6 rule applies unchanged; the optional `reason` defaults to `written wrong`. A
  replacement that does not pass stays as a check of its own, the old check stays, and the result says how to finish.
- **30 steps.** A scenario may have up to 30 steps (was 12). The steps still share 8 s of watching for changes, and
  the check its 30 s deadline, so a long check is bounded as before.
- **Schema errors without a copy of the call.** A tool call that fails its schema after Casper's argument repair gets
  Pi's error, each field and what was wrong, without Pi's copy of the whole call.

## Guard rails

- No rule is weaker: a replacement must pass, open the same page (path) at the same viewport and test at least as much,
  through the same code that checks `replacedBy`; a passed or withdrawn check can't be replaced; the receipt names
  both checks as before.
- Every check still runs in full. A passed check is never answered from an earlier run: a server's data, session or
  memory can change with no file changed, so only running it again shows the page as it is now.
- The fixed prompt does not grow: the browser tool's description and its lean form were shortened by what `replaces`
  added.
- **A finding:** a check withdrawn by `replaces` whose replacement did not pass, was of another page or viewport, or
  tested less; a broken page that passes through any of these paths; a schema error that lets the call run.
