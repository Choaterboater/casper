# net-tacacs-acct

Builds per-user command history from a tac_plus-style TACACS+ accounting log. Data is synthetic.

## Log format

One record per line, tab-separated:

```
<Mon DD HH:MM:SS>  <nas>  <user>  <port>  <remote>  <start|stop|update>  <attr=value>...
```

The day is space-padded (`Jan  5`). Attribute values may contain spaces and `=`. Command accounting
records carry `cmd=<command> <cr>`; session records have no `cmd`.

## Layout

- `src/record.ts`: `parseRecord(line)` → `AccountingRecord | string` (the string is why it is invalid).
  Done and tested.
- `src/history.ts`: `commandHistory(text, { year })`, the pairing and history.

## History rules

- Only records with a `cmd` attribute are commands; others are ignored (not problems).
- `command` is the `cmd` value without the trailing ` <cr>`, trimmed.
- A `start` and a later `stop` with the same `nas` and `task_id` are one command: time and
  `privLevel` from the start, `elapsedSeconds` from the stop's `elapsed_time`, status `completed`.
- A `stop` with no open start is status `stop-only` (many devices only send stops); its fields all
  come from the stop. A `start` never
  stopped by the end of the log, or replaced by another `start` with the same `nas`/`task_id`, is
  `no-stop`. `update` records are ignored.
- `time` is ISO-8601 UTC in the given year, e.g. `2026-01-05T10:00:01Z`. `privLevel` and
  `elapsedSeconds` are numbers or null.
- Invalid lines become `{ line, reason }` problems (1-based line numbers); blank lines are skipped.
- `users[name]` lists that user's commands sorted by time, ties in log order.
