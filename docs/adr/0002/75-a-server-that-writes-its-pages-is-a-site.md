# 75. A server that writes its own pages is a site, and its build is checked and reviewed

Date: 2026-11-05. Status: proposed. Extends the plain-site rule (v0.2.21) behind page checks; keeps 72 (a build from
scratch is checked, proven and reviewed by default) true for one more shape of build.

## Decision

A homepage build's Express server wrote its three pages itself (`res.send(layout(...))` returning `<!DOCTYPE html>…`)
and had no `index.html`. The plain-site rule asked for an `index.html`, so Casper saw no web project: no page check
ran, nothing passed, and the requirements review that would have caught the build's two missed requirements never
started. The receipt said only `– Not checked — no tests yet`, while the app smoke a moment later started the same app
and got HTTP 200.

- **A site without a page file.** A `dev` or `start` script that runs its own server file (`node server.js`,
  `bun run server.ts`) is a plain site when that file starts a server and holds a whole HTML page (`<!DOCTYPE html` or
  `<html`), as well as when the project has an `index.html`. Bun's `export default { fetch }` (run by `bun`) and Hono's
  `serve()` from `@hono/node-server` count as starting a server here. Casper starts it with `PORT` set and opens `/`.
- **Its `/` is a guess, settled by the server.** HTML in a server file is a sign, not proof: an API may have one page of
  its own (a `/docs` page, an OAuth "close this window" page). While `/` answers 401, 403, 404, 405 or 410 (no page, or
  behind a login), no page check is reported and the receipt is the one with no check planned (`– / answers 404: no page there,
  so this is checked as an app without pages`). The app smoke keeps `/` a guess the same way, so a JSON 404 there is the
  API answering, as before. The checks line says `pages (npm run start, if / has a page)` unless `/` is listed.
- **Settled by a real answer.** Once a page check gets a page or a server error at `/`, it is judged as any page in
  every later round of the task, so a repair that turns a 500 into a 404 still fails. A load that never answered
  settles nothing. "No page" is a mark the page check sets on that round's report, never inferred from missing
  results: a stopped, blocked or repaired check keeps its receipt.
- **Its server file is page code.** With no framework, script edits are server code and open nothing; this server file
  is the exception: a change to it opens `/`, since it is where the pages are written.
- **`start` when `dev` runs the same file through a watcher.** `dev: "nodemon server.js"` is no file Casper runs, so
  `start: "node server.js"` is used. Only the same file: a `dev` of `tsx src/server.ts` beside `start: node
  dist/server.js` keeps today's result, since the start script would run an old build, not the change.

## Guard rails

- Only the file the script runs is read (inside the project, at most 256 KB, as the app smoke reads entry files). HTML in a
  test fixture, a module the server imports or any other file does not make a site.
- No page at a guessed `/` is never a failure or a repair; a page that loads, a 400, a 429 or a server error (5xx) is
  judged as any page is. A `/` the user lists under `pages:` is never a guess.
- A no-page answer from an old dev server Casper could not confirm stopped proves nothing: the check is incomplete, as any page's.
- A server file with no HTML page, and no page file, stays an API: the app smoke is its check, as before.
- Server-rendered pages kept in imported view modules (`src/views/layout.js`) are not detected yet. Declare
  `services.web` and list the pages under `pages:` in `.casper/project.yaml` (for example `pages: [/]`): listed pages
  are opened after any code change.
