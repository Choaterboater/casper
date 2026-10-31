# 17. Try changed apps before the receipt

Date: 2026-10-16. Status: accepted (merged 2026-10-17 in #358).

## Decision

After the last repair, review and final configured command check, a runtime change to a local app,
server or page gets one completion smoke in auto mode. Offer mode starts no automatic app smoke:
the receipt says `App smoke: not run — /verify to try it`, and `/verify` runs it with the other checks.
Casper uses a declared service or the project's own dev/start command, sends one local GET and checks
for HTTP 2xx, then stops the process tree it started. Readiness probes are not additional smoke cases. A fresh page/service result
for the same final files can satisfy the observation without another request, retaining that check's
method, path and result. The smoke starts no suite, route crawl, browser or model repair.

This extends the existing automatic project-command execution in
[decision 2, item 9](../0002-deliberate-choices.md#9-the-browsers-serve-runs-the-projects-packagejson-script)
and replaces session-long ownership only for servers started by automatic checks. Explicitly started
services, browser-tool services and previews keep their original ownership. Before requesting an
already-running preserved service, Casper calls `ensureFresh` so stale task edits restart it once.
It remains preserved, never becomes automatic, and completion cleanup leaves it running. A failed
restart reports not-run with its reason rather than requesting stale code.

## Guard rails

- Only changed runtime files trigger it; documentation, tests and unchanged tasks do not.
- Existing checks-off and pages-off settings disable it, with an explicit receipt note.
- Declared scopes select one service; ambiguous declarations and recognized apps with no launch command
  get an explanation rather than a guessed command. No dependency installation or credential discovery.
- The existing cross-platform managed-process owner supplies loopback ports, the isolated environment,
  sandbox behavior and whole-tree cleanup. No existing listener is killed or replaced.
- A new completion launch waits at most 15 seconds for readiness, then at most 10 seconds for its one
  request. Redirects are not followed. Cancellation still drains its owned processes.
- Startup failure, timeout, changes during the run or unconfirmed cleanup never pass. Receipts name
  them plainly; saved and JSON evidence uses existing preview redaction.
- A pass is a runtime observation only, never proof of the requested behavior or a reason by itself
  to say Verified. No new fixed prompt text or tools are added.
