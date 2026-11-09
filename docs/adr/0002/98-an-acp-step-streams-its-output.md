# 98. An ACP step streams its output

Date: 2026-11-09. Status: proposed. Extends 79 (an ACP step carries its output) and uses its hiding rules. Over
`casper acp` a running command's card stayed empty until the command ended: a build or a test run of a few minutes
showed nothing, while the terminal's working box showed its latest line all along.

## Decision

- **A running bash or PowerShell step sends its latest lines** as a `tool_call_update` with `status: "in_progress"`,
  its content one fenced text block, and `_meta: { casper: { live: true } }`. Each one replaces the last; the step's
  end (79) replaces them with the whole output. The same lines are not sent twice.
- They come from the runtime's own progress event, at most about two a second per step (the 500 ms throttle the
  terminal already had). The event carries the output so far as Pi keeps it (its last 50 KB or 2,000 lines); the card
  shows its last 2,000 characters, and the terminal its last line as before. PowerShell now sends that event too; the
  terminal still draws it for bash only. Pi's empty first update no longer starts the throttle, so a command's first
  lines are not held back.
- **`acp_live_output: on | off`** in `~/.casper/config.yaml` only (a profile or project is refused), on by default,
  shown in /settings as **Apps show running output**. It is read again at each prompt. A file Casper can't read
  answers off. Off: the output comes when the command ends, as before.

## Guard rails

- **Whole lines.** A first line the runtime cut and a last line still being written are left out, so a secret is
  never half shown. With a truncated mark in view (Casper's own, or one the command printed), the card starts after it
  and the line below it, which may be cut; the check still reads the output above as it is.
- **A last run of key-body lines waits.** Lines shaped like a key's body (one word of base64 characters, maybe after a
  line number), at the bottom of the lines so far, are not shown until a line that is not one comes after them: a
  key's END with no BEGIN, still to come, would hide them all in the final output. A plain word (letters only, in
  lowercase, with one capital first or in capitals, under 16 characters: `first`, `Done`, `PASS`) is no secret and
  shows at once, unless a line shaped like a key's, or a line that was cut, is right above it (a key wrapped short may
  end with one). They are read by the check all the same, so a run that holds stops the step. A list of ids alone
  (`git rev-parse`, ULIDs) shows when a line follows it, or at the end.
- **Hidden as the end is.** Every update goes through the session's hiding (the `--json` redaction and your own
  secrets' exact values), as every other update does. The end's hiding reads the whole output, so lines it would hide
  otherwise than alone are held: a name on a line above (`password:`, `--token`, `Bearer`) whose value is the first
  word below it, and a line that may be part of a value of several lines the session hides only whole (an ACP
  client's MCP value too), read as the output is and as the hiding reads it (no colour codes, a lone carriage return
  a line break).
- **Scrubbed at least as hard as the end, and held when in doubt.** The command's final output is scrubbed
  (`scrubToolOutput`) before the AI and the app see it; these lines are not, so `liveOutputHoldsSecret` checks them at
  once, with Casper's own rules, over the output Pi keeps so far (the lines above the shown ones too). Holding costs
  only the preview: the final scrubbed output is always sent. The lines are held when:
  - **The output is JSON** while /secrets files is on: it starts as JSON, or a shown line is a JSON value's (a
    `"key":` line or a quoted list item). The final's device pass reads an output that is JSON whole string by string,
    with `\n` escapes as line breaks, and hides everything under a secret-named key; partial JSON can't be read that
    way.
  - **A shown line may be a line of a secret of more than one line** (an environment value, a login or a typed
    secret): the final hides such a value only whole, and its last lines may not be out yet. The lines next to it must
    fit the value too, as far as they are in view.
  - **The same rules change a shown line**, each state another line sets taken at its strictest, since that line may
    not be out yet, with the passes run in turn and each alone (one pass can change a line out of view that the
    final leaves, a device rule taking a table header's bar as a value, and the pass after it would then miss that
    column): every line read as a key file's (any line naming one turns that on), the device rules on whatever
    /secrets files says (a key's BEGIN anywhere turns them on) and on a line with a certificate's or public key's
    armor too, every line read as inside a RADIUS/TACACS server and a Junos snmp block, "value" rows read as a token's
    ("tokenid" anywhere), and no certificate's body let through. Two or more base64-character lines of 16 or more
    characters in a row (the latter with a digit and both cases) read as a key's body wrapped short, whose END may
    follow. Where Pi has cut the start (or at a truncated mark), the lines after it may be inside a key or a table
    whose first lines are gone, and the first of them (or the one after the mark) may be only a line's end: a key's
    header lines, and base64-character lines of 20 or more characters (an id of capitals and digits only from 27, past
    a ULID), start a key's body. A table is read both ways the final reads one (the older way, and the way that
    follows rule lines): the older way counts every cell of a row until a line that does not start with a bar; the
    other, until a line with no bar at all, past rule lines, holds every row and every line with a bar after its start
    (psql's rows have none at their ends) from its first cell to its last, a row that reads as a header too (it may be
    a key and value row: `║ password ║ x ║`), however short its cells. Pi's final output is the same keep at the end,
    so it never holds a line the check lost. The same goes for a key's BEGIN that a cut left out: lines after it that
    are not shaped like a key's body stream, and Pi's final has lost that BEGIN too.

  Held lines are not sent, and that step sends nothing more until it ends, scrubbed. What streams: short hashes and ids,
  ULIDs, and ordinary build, test, git, tree and table output (a last line like an id waits for the next line). What may
  hold the preview until the step ends: JSON (`jq`, `curl` of an API, `cat package.json`) while /secrets files is on, a
  line of 40 or more base64 characters (a 40-character commit hash too), after a cut a long path, a table's rows (until
  a line with no bar) and an ASCII tree's lines two levels deep (`|   |-- app.ts`, which may be a Markdown row with no
  last bar), and a value on the line under a secret's name. One limit: a plain word on its own line just above a key's
  body with no BEGIN (the top of that run) streams, though the final output hides it only because of where it sits (the
  END walks up over every line shaped like a key's). The short key lines that used to stream above an END still to come
  now wait for it. Pi keeps at most 50 KB: the check takes a few milliseconds on that much ordinary output (about 75 ms
  on 50 KB of password assignments on one line, where every pass runs) and runs at most twice a second, until a step
  holds.
- **Certificate armor lines.** The final scrub reads a key file's certificate armor line with the device rules (so
  `-----END CERTIFICATE----- snmp-server community X RO` loses its community), and the live check reads it the same
  way.
- **Kept together by tests.** `tests/secrets-live-drift.test.ts` runs a collected table of the secrets tests' inputs
  (`tests/fixtures/scrub-cases.json`, with the environment values, logins and typed secrets they used; `bun
  tests/support/scrub-cases.ts` collects it by running those tests, and a listed test file whose strings changed since
  fails the drift test until it is collected again, so a new input can't skip it; it holds the table tests' inputs
  too: mysql, psql, rich and tabulate grids, key and value tables, a table printed straight after another) as a
  command's output, whole and as every window of its whole lines a running command can show (from its start, or cut
  from inside), and each must be held back wherever the final scrub hides part of it; again with a line naming a key
  file before or after the input, for each window without that line. The cases review found (a token after a long hex
  line with a key file named elsewhere, a short line in a key's body, a config line with /secrets files off and a key
  elsewhere, a key's header lines below its BEGIN, a server or snmp block, a table header, "tokenid" below) are held
  in every window, read alone or after the lines above it. So are the next review's (`tests/fixtures/live-leaks.ts`:
  JSON outputs, armor lines with a device secret, a secret of several lines, a key wrapped short with no BEGIN), and
  `tests/acp-live-output.test.ts` sends each through the ACP mapper; so are the third review's (a table whose header a
  live device rule broke, a key's short lines before its END, a printed truncated mark beside a value of several
  lines), and the drift test lets no window through: a last run of key-body lines is read but not shown, as the card
  does. The mapper test also sends the review's values the session's hiding finds only with the line above or whole (a
  value under `password:`, `API token:`, `--password` or `Bearer`, an ACP client's value of several lines), and every
  ordinary output line by line, which never stops the step. Where the final scrub changes the line count (JSON
  written out again, a value of several lines hidden whole), the lines it changed are those outside the longest run of
  lines both share in order. Each input is also put above and below each input that
  sets such a state, and every window of it the final scrub changes is held, read after the lines above it and read
  alone from where Pi's keep starts. In the suite those state inputs are every one that sets a state some other way
  and one table per shape (the characters its rules and rows' ends are drawn with, whether its rows start with a bar,
  its line ends), split over six test files that run at once; `bun tests/support/live-drift-all.ts` puts every table
  in, for a change to `src/secrets` or the live check. The table is a copy: it names the test files it was collected
  from ("from"). A top-level `tests/*.test.ts` file that is not named fails it when its text has `scrubToolOutput(` or
  names a helper under `tests/fixtures` or `tests/support` (its file name, without its extension, in any string: an
  import, a joined path or a path it runs) whose text has `scrubToolOutput(` or names such a helper.
  `tests/acp-live-output.test.ts` checks that every window of a build log, test runs, a tree listing, git log and diff
  output, short folder names, short commit and container ids, ULIDs and a plain column table still streams, read alone
  and after the lines above (an ASCII tree's lines two levels deep right after a cut are held, as above).
- **Not while netconan is in use.** netconan may find more than Casper's own rules and can't run on text shown at
  once, so no running output goes out at all then (79 holds device configs back for the same reason).
- **Not for a hidden command.** A step whose command the start showed changed (a secret typed into it, hidden by the
  command rules or the session's hiding) may print that secret, so it sends nothing until it ends.
- The terminal, `--json` and receipts are unchanged.

## A finding

A live update with a part line, a value the step's end would hide, any update while netconan is in use or with
`acp_live_output: off`, or one for a step whose command was hidden.
