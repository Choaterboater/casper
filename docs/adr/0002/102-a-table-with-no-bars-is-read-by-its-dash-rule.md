# 102. A table with no bars is read by its dash rule, and psql's expanded records by their names

Date: 2026-11-10. Status: proposed. Extends the table reading of `scrubToolOutput` (docs/SECRETS.md) and keeps 98 (an
ACP step streams its output) with one more limit. Three layouts a database prints showed a Password column to the AI:
psql's one-column result (a header over a rule of dashes only), psql's expanded display (`\x`: `-[ RECORD 1 ]-`, then
`passwd | X` lines with no bar at their start) and sqlite3's `-header -column` (no bars at all, a rule of one dash run
per column). Each table reading looked for bars or a rule with a cross (`+`, `┼`), so none of them was a table.

## Decision

- **A rule of dashes only, from the line's start, under a header, is a table's.** The header has no bar, each name
  sits over a dash run with nothing in the gaps between runs or past the last, and no name is empty. The names name
  the secret columns as any table's header does (`password`, `token`, `key` ...), and a row's cell is the text under
  its run. The rows run to a blank line, psql's row count (`(2 rows)`) or the next header over a dash rule. This reads
  sqlite3's `-header -column`, psql's `\pset border 0` and PowerShell's `Format-Table`.
- **A value wider than its run** (sqlite3's `.width`, `Format-Table`, whose dashes are only as long as the name) runs
  into the gap after it and moves the cells after it, so from the first such value on, a secret column is hidden to
  the row's end.
- **One dash run is read in psql's shape only:** the header a space in, and each row a space in (the first row that is
  not ends the table). A Markdown setext heading (`Passwords` over `---------`) and a commit message's heading, which
  is indented by four with its rule, are not tables, and neither is the `---` of YAML front matter, a patch or `diff`.
  So sqlite3's one-column output, whose header is not indented, is not read.
- **psql's expanded records.** Under a `-[ RECORD n ]-` line (`+-[ RECORD n ]-+` with border 2, `─[ RECORD n ]─` with
  unicode lines), each line is a column's name, a bar and its value, to a line with no bar. A name that is a header
  word, or holds a secret as in a key and value table (`rolpassword`), hides its value unless the value is a setting
  (`ON`, a small number, a date); so does a value's next line under an empty name (psql ends a line of a value of
  several lines with `+`).
- Each is a reading of its own beside the two there were: a cell any reading hides stays hidden. Linear in the text:
  10,000 rows and lines of 200,000 characters take tens of milliseconds.

## Live output (98)

- The live check runs the same readings. A dash rule whose header may be only a line's end (the first line after a
  cut or a truncated mark), or that is itself that first line, makes every cell of the rows below it a secret's: they
  are held. A psql row with one bar after its start (`         | X`, a value's next line in `\x`) is held after a cut
  as every row with a bar is.
- **The limit.** A cut window of a bar-less table's rows whose header and dash rule are above it streams, though the
  final scrub of the whole output would hide their secret column. Nothing on such a row marks it as a table's: a
  plain column table's rows (`kubectl get pods`, `docker ps`) look the same, and 98 keeps those streaming. Pi's final
  output is the same keep at the end, so it has lost that header too and shows those rows the same way (98 says the
  same of a key's BEGIN that a cut left out). `tests/secrets-live-drift.test.ts` lets these windows through by
  `barlessRowsAfterCut` (`tests/support/live-drift.ts`) only: rows with no bar, a dash rule above the window and a line
  above that rule.

## A finding

A password under a bar-less table's dash rule, or in a psql `\x` record, that reaches the AI while its header is in
the output; a Markdown heading, prose, `diff`, `git log` or YAML front matter line hidden because of a line of dashes.
