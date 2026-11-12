# 103. An ACP app signs Casper in

Date: 2026-11-12. Status: proposed. Extends 76 (Casper speaks ACP). An app that runs `casper acp` could not sign
Casper in: `initialize` listed no `authMethods`, and a session on a home with no sign-in said "run casper in a terminal
and type /login". An app meant to be set up with no terminal needs the sign-in itself, and Casper's login file must
stay the only place a key is kept, written only by Casper.

## Decision

- **`initialize` lists the ways.** `authMethods` has one entry for each row of `/login`, with the same name, except
  Claude Code plan (its own program runs that sign-in in a terminal). Each has `_meta.casper.provider` and
  `_meta.casper.kind`: `api_key` (the app shows a hidden field), `browser` (the person finishes on the provider's page)
  or `device_code` (the person enters a code on the provider's site).
- **`authenticate { methodId }` runs one**, with the steps `/login` runs: the key is checked with the provider before
  it is saved, and the login file must be a private file of yours. The reply comes once the sign-in is saved, and names
  the provider in `_meta.casper.provider`.
  - **A key** comes in the same request, as `_meta.casper.key`. Casper never asks for it through a form, so it is in
    no update, no permission request and no event. It goes to the provider's check and to the login file. It is not
    written to a reply, to stderr or to a conversation log. Only a key `/login` would take is taken: printable
    characters, no spaces, not starting with `!` and with no `$`.
  - **A refused key** is not saved and not tried again: the reply is an error that says the provider refused it.
  - **A key that could not be checked** (no network) is not saved. `/login` offers "Save without verification" to the
    person at the keyboard; an app's request carries no such choice.
  - **A browser sign-in** opens the browser on this computer, as `/login` does, after the same check that the page is
    the provider's own. Casper tells the app with `_casper/auth/update { methodId, step: "browser", url, opened }`.
  - **A code sign-in** tells the app the code: `_casper/auth/update { methodId, step: "device_code", url, code }`.
- **One sign-in at a time.** A second `authenticate` while one runs is refused. The notification `_casper/auth/cancel`
  stops the running one; a sign-in nobody finishes ends by itself after 15 minutes, as in `/login`.
- **`_casper/auth/status`** replies `{ signIns: [{ provider, type }] }`: names and kinds, never a value. It does not
  create the login file.
- **`_casper/auth/logout { provider }`** removes that provider's saved sign-in and replies `{ removed }`.
- **Errors are Casper's own words.** A failed sign-in is ACP's `-32000` with a plain sentence that says whether
  anything was saved. A provider's or the engine's error text is never passed on, since it can hold what was sent.
- **The router does this, not a session.** Sign-in happens before any session exists. A session started afterwards
  reads the login file as it is then.

## Limits

- A session that is already open keeps the sign-ins it started with until it is opened again.
- A signed-in session with no model in use still sends no model list: the first request picks one. Sending the list
  before a first message is a separate change.
- Sign-ins that other tools left on this computer (Claude Code, Codex CLI, GitHub CLI) are not offered over ACP.
- Claude Code plan is not in the list.

## Guard rails

- `tests/acp-auth.integration.test.ts` runs a real `casper acp` on an empty home. After a key sign-in it reads every
  file under the home and the project, everything Casper wrote to the app, and stderr: the key is in the login file
  and nowhere else, and that file is readable only by its owner.
- The same file checks that a refused key and an unchecked key save nothing, that a refused key is sent to the
  provider once, that a second sign-in is refused while one runs, that a cancel saves nothing, and that a code
  sign-in's tokens reach neither the app nor stderr.
