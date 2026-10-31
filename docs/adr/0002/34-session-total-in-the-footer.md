# 34. The footer shows the session's running total beside the task's figure

Date: 2026-10-23. Status: accepted (merged 2026-10-23 in #480).

## Decision

The footer's spend shows the current task's figure and, once an earlier task counted any, the session's running total:
`task 2.1k tok · $0.02 │ session 180k tok · $1.40`. Before, it showed only the task's figure and left session totals
to `/status` and `/usage`.

## Why

The task figure starts again with every request, and stopping a task and typing is a new request. People read that as
the count resetting. The running total never goes down within a session, so it can't look like a reset; the task
figure stays, since it says what the request in front of you costs.

## Guard rails

- On a narrow terminal the session total is the first spend group dropped, before the task's figure; the footer
  never wraps.
- A free model shows tokens only. A subscription keeps `sub ≈`. Money a priced model counted earlier in the session
  still shows after a switch to a free one.
- The total counts only usage a provider reported: a stopped answer whose usage never came is not in it, so it is at
  least this much, never more.
