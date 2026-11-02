# 52. Checks follow their service, and a check whose server is gone is stale, not failed

Date: 2026-11-01. Status: accepted (merged 2026-11-01 in #565).

## Decision

- A browser check recorded on one of Casper's managed services belongs to that service, not to the port it had. While
  the service runs, a replay opens the same path at its current address, made fresh first as a `service` request is,
  and the check's notes say `followed <service> to <origin>`.
- [Decision 5](../0002-deliberate-choices.md) still opens a check whose own server is gone on the server Casper runs
  for the project. A check that passed on its own server and fails there is now stale, not failed: incomplete, with
  the reason `Stale, not failed: the server it ran on (<origin>) is gone, …`, and the receipt says `1 stale, its server
  gone: <name>`. It starts no repair, and the task ends incomplete (exit 2), not failed (exit 1).
- Every repair turn says `Never put test data in the app's settings or data files to make a check pass.` Settings and
  data files changed while checking and repairing (`config/*.yaml`, `.env`, `data.json`, SQLite) are flagged on the
  receipt: `⚠ Checks and repairs changed app settings or data: …; look for test data left in them`.

## Why

In the owner's comparison, the AI's server came back on new ports after restarts. Its checks then replayed on
Casper's server for the project, which held the clean config the AI had (rightly) restored, not the test widgets they
were recorded with. They failed, the repair turn put a test weather widget and two test tiles back into
`config/`, and that test data shipped: it failed two of the six shared checks and the blind review, and the run
exited 1 although the app worked.

## Guard rails

- A check that already failed on its own server stays failed on Casper's server, and still gets its repair turn.
- A pass on Casper's server still counts, as before.
- A stale check is never a pass: the task is incomplete and the receipt names it.
- A check whose service is not running is never started for it; it falls back as decision 5 says.

A finding: a check that failed on its own server reported as stale; a stale check counted as a pass or sent to a
repair turn; a replay opening a page at an address no running service of the check's has.
