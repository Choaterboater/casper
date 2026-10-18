# 18. A guessed root may answer 404 for an API

Date: 2026-10-18. Status: proposed.

## Decision

Refines [17](17-try-it-before-done.md). When the completion smoke has no changed page and no declared
`ready.http` path, it requests `/` only as a guess. An API that answers that guess with a JSON 404 or 405
is up and routing, so the smoke passes and the receipt says why: `the API answered; it has no page at /`.
Before this, an API whose contract says unknown routes are 404 always failed the smoke, so the task's
outcome and exit code said failed for a working server.

## Guard rails

- Only for the guessed root. A changed page or a declared readiness path still needs 2xx.
- Only JSON 404/405. An HTML or text 404, any 5xx, a timeout or a startup failure still fails.
- The pass stays a runtime observation, never proof of the requested behavior.
