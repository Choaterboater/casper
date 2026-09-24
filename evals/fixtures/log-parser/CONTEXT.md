# log-parser

Turns the service's `key=value` log lines into structured records.

## Log format

```
2026-01-05T10:00:00Z INFO msg="user login" user=alice latency_ms=12
```

- Each record starts with an ISO-8601 UTC timestamp (`YYYY-MM-DDTHH:MM:SS[.fff]Z`), one space and a level
  (`DEBUG`, `INFO`, `WARN`, `ERROR`), then zero or more `key=value` pairs separated by spaces.
- A value is either bare (no spaces or quotes) or double-quoted; quoted values may contain `\"` and `\\`.
- A line starting with whitespace continues the previous record's `msg` (joined with `\n`, leading
  whitespace removed); for a record without `msg`, the first continuation line becomes the message.
- Lines are separated by `\n` or `\r\n`; blank lines are ignored. Line numbers are 1-based.
- A line that is not a valid record (bad or impossible timestamp, non-`Z` offset, unknown level, a token that
  is not `key=value`, an unterminated quote) is reported as a problem `{ line, reason }` and parsing continues.
  A continuation line whose previous non-blank line is not part of a valid record is also a problem.
- `msg` becomes `message`, `latency_ms` becomes the number `latencyMs` (null unless a non-negative number),
  every other key goes into `fields` as a string; a later duplicate key wins.

## Conventions

- `src/parse.ts` exports `parseLog(text)`. Pure functions only; no I/O.
- Types live in `src/types.ts`.
