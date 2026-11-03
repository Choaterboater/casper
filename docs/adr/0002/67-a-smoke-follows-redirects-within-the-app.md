# 67. App smoke follows redirects within the app

Date: 2026-11-03. Status: proposed. Amends 17 (try changed apps before the receipt): its guard rail "Redirects are not
followed" now holds only for a redirect that leaves the app.

## Decision

A tracker build sent signed-out visitors from `/` to `/login` with a 302, as its prompt required. The receipt said
`✗ App smoke: failed · npm run start · GET / → HTTP 302 — HTTP 302, expected 2xx` and Casper exited 1, while every
shared check passed.

- **Within the app, follow it.** A 3xx whose `Location` is on the same origin is followed, at most 5 hops, and the page
  it leads to decides: 2xx passes, anything else fails as before. The receipt says where it went:
  `GET / redirects to /login → HTTP 200`.
- **Off the app, a loop or too many hops fails.** A redirect to another origin is never requested
  (`it redirects off the app, to https://…`); a path seen before is a loop; more than 5 hops fails.

## Guard rails

- Only GET, only the app's own origin (scheme, host and port): no request ever leaves the loopback address Casper
  started the app on.
- The one request budget (10 s) covers every hop. The rest of decision 17 is unchanged: still one smoke, no browser,
  no crawl, never proof of the requested behavior.
- `tests/try-it-before-done.test.ts` covers a redirect to a page, one to a 404, off the app, a loop and too many hops.
