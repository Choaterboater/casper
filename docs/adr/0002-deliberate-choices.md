# 2. Deliberate choices reviewers may flag

Date: 2026-10-11. Status: accepted.

## Context

AI and human reviewers keep reporting the same intended behaviour as security findings: commands that run
without a box, a browser that clicks on its own, a password field that gets filled. Each of these was chosen.
The product rules behind them:

- **On by default, with an off switch.** A feature is on, and your own `~/.casper/config.yaml` (most of them a
  row in `/settings`) turns it off. A project file can't turn any of these on or off for you.
- **No gates for their own sake.** A box asks only where a wrong yes costs something real.
- **Claude Code is the reference for where a box belongs.** What Claude Code does without asking, Casper does
  without asking; where it stops and asks, Casper asks.
- **User freedom over policing.** Safety is a default with an off switch, never a limit on what the user may do.

[SECURITY.md](../SECURITY.md) has the full rules; this list says which parts are on purpose.

## Decision

Each choice below stays as it is. Reviewers read this list before flagging permission or security behaviour.
**A listed choice is not a finding. Its guard rail breaking is.**

### 1. The sandbox is off by default; the shell asks before changing commands

- **What:** at Casper's own start the shell sandbox is off unless `sandbox: on` is in your config (or you type
  `/sandbox on`). The AI's shell then asks `Run this command?` (`1 No · 2 Yes, this once · 3 Yes, for this
  session · 4 Yes, always for this project`) before a command that is neither a plain read nor routine work (item 2).
  `src/sandbox/manager.ts` (`SandboxKind` `default`).
- **Why:** it is the owner's call (2026-10-09). The sandbox broke ordinary work (logins, caches, tools outside
  the project), and asking first is the same protection the user has with any other agent.
- **Same as:** Claude Code's sandbox is opt-in (`/sandbox`); without it Claude Code asks before shell
  commands that change things.
- **Off switch:** `sandbox: on` turns the sandbox on; `sandbox: off` or `--no-sandbox` turns the questions off too.
- **Guard rails:** Enter runs nothing; a run that can't ask refuses (`Not run: shell commands need your OK here…`);
  a command that names a private place (`cat ~/.ssh/config`, `$HOME/.aws/...`) is refused before it runs; ssh and its family ask
  before reaching another machine; the receipt and `/status` say commands were not sandboxed; a project file
  can't loosen the sandbox (`.pi/sandbox.json` is ignored).
- **A finding:** a non-routine, non-read command runs with no box while the sandbox is off; a command naming
  a private place runs; a project file
  turns the sandbox off or adds to the remembered commands; Enter or a run that can't ask runs a command.

### 2. Routine commands run without the "Run this command?" box

- **What:** with no sandbox, routine work runs unasked: everyday git (`add`, `commit`, `switch`, `fetch`, `pull`,
  `merge`, `rebase`, `stash`, a push to a remote the project already has), `gh pr create|view|…`, installs from
  the project's own files (`npm ci`, `bun install`, `pip install -r`), the project's scripts, builds, tests and
  linters, and `mkdir`/`touch`/`cp`/`mv`/`rm` of files in the project. A line counts only when every command on
  it is a read or routine. `src/sandbox/routine.ts`.
- **Why:** a box on `npm test` and `git commit` teaches people to press yes without reading.
- **Same as:** Claude Code's auto mode, which runs routine commands without a prompt and still stops risky ones.
- **Off switch:** **Routine commands** in `/settings` (`routine_commands: false`); a project file can't set it.
- **Guard rails:** still asked: `sudo`, `curl … | sh`, a force push or deleted remote branch, a push to a remote
  the project didn't have, a new package (`npm install left-pad`), `chmod`, `rm` of the project, its `.git` or
  anything outside it, a full path or `..` that leaves the project, copying or committing a private file
  (`cp .env x`), and every program not listed. Options are read as the program reads them (`--forc` is `--force`).
- **A finding:** any of the "still asked" cases runs unasked; one routine command on a line lets a non-routine
  one through (`npm test && rm -rf ~`); a path escapes the project.

### 3. Browser clicks are on by default

- **What:** the AI's browser clicks, types, presses keys and picks options without asking, on any page, a
  labelled Send or Delete button included, so it can test what it built. `actionHold` in `src/browser/session.ts`.
- **Why:** a test that can't press the page's own buttons tests nothing.
- **Same as:** browser-test tools such as Playwright, which coding agents drive to test the pages they build,
  click and type on the page under test; that is what they are for.
- **Off switch:** **Browser clicks** in `/settings` (`browser_clicks: false`); a project can't change it. Off, a
  known label (send, delete, buy, pay, publish, log in…), a page not on this computer, or an action not marked
  `local-test` asks `1 No · 2 Yes, this once · 3 Yes, for this session`.
- **Guard rails:** payment (`cc-*`), one-time-code and file inputs are refused everywhere; cloud metadata
  addresses (`169.254.169.254` and kin) ask first whatever the setting; actions marked consequential are never
  retried; page text is untrusted data, never consent; there is no arbitrary JavaScript endpoint.
- **A finding:** a card, one-time-code or file field gets filled; a metadata address opens with no yes; with
  clicks off, a labelled or non-local action runs unasked; a project file turns clicks on.

### 4. Password fields are filled only for local tests on local pages

- **What:** `fill` types into a password field only when the step is `local-test` and the page is on this
  computer (`localhost`, `127.0.0.1`, `[::1]`), so the AI can test a login it built with a made-up account.
  `src/browser/session.ts` (`A password field is filled only as a local test…`).
- **Why:** login, log-out and admin pages are common work; refusing the field meant they were never tested.
- **Same as:** end-to-end tests (Playwright, Cypress) fill login forms with test accounts as a matter of course.
- **Off switch:** none of its own (**Browser tool** off in `/settings` removes the browser); the rule itself is the limit.
- **Guard rails:** anywhere else a password field is refused; an approval box shows the value as `••••••••`.
- **A finding:** a password is filled on a page not on this computer, or for a step not marked `local-test`;
  the value shows in a box, a log or the receipt.

### 5. Casper's end-of-task replay presses a local labelled button only with clicks on

- **What:** when a task finishes, Casper replays, with no model turn and no question, each browser check that
  ran before a later edit or command. Only pages on this computer and only `local-test` steps; a step whose
  label has a known word (a contact form's Send) runs only with **Browser clicks** on, as it ran for the model.
  `src/browser/session.ts` (`this.unattended`).
- **Why:** a page that still works after the last edit should count as checked without a model turn spent on it.
- **Same as:** CI re-running the project's own end-to-end tests after every change.
- **Off switch:** **Browser clicks** off keeps labelled steps from replaying; the check then stays as it was.
- **Guard rails:** any other step, a page that would need a yes, a busy browser or a replay past its shared
  minute leaves the check as it was (`ran before a later edit or command (replay to count)`); a withdrawn check
  is never replayed; checks from earlier tasks are left alone.
- **A finding:** the replay reaches a page not on this computer, runs a non-`local-test` step, presses a
  labelled button with clicks off, or asks a question.

### 6. The AI may withdraw a browser check it wrote wrong

- **What:** `withdraw` takes a check out of the result, with a required reason. Accepted only when the check's
  last run did not pass and nothing changed since it was recorded: no edit or command after it, and its inputs
  are the same. A check whose recording never finished is recorded by its first finished run. `withdraw` in
  `src/browser/session.ts`.
- **Why:** a typo in an expected text or a selector that was never right would otherwise hold the task at
  failed or incomplete for a page that works.
- **Same as:** no direct Claude Code equivalent; this is Casper's own check system.
- **Off switch:** none; the conditions are the limit.
- **Guard rails:** a passed check, an already withdrawn one, or one with a change after it is refused (`fix the
  page and replay it`), so a page fixed after a failure is replayed, never withdrawn; it stays in the report as
  `withdrawn` and the receipt says `– 1 check withdrawn by the AI: <name> (<reason>)`; it never counts as a pass;
  if every check was withdrawn the task is `Incomplete`; a corrected check is a new one and must pass on its own.
- **A finding:** a check withdrawn after an edit or command; a withdrawn check counted as a pass or missing
  from the receipt; a task with all checks withdrawn reported as complete.

### 7. A new check whose step selector matches several elements is not kept

- **What:** when a step of a new `check` matches more than one element, the check is dropped and the AI is told
  `name one element and record the check again (nothing was recorded)`. One that matches nothing keeps its id (the
  feature may not be built yet). `src/browser/session.ts`.
- **Why:** a selector that matches several things is a check written wrong, not a page that isn't ready; kept, it
  would hold the result at incomplete for good.
- **Same as:** Playwright's strict locators, which fail when a locator matches more than one element.
- **Off switch:** none.
- **Guard rails:** only on `check`, never on `replay`: a recorded check is never dropped for this.
- **A finding:** a replayed or passing check disappears; a dropped check still shows as evidence.

### 8. Web lookups are on by default

- **What:** `web_search` (DuckDuckGo by default) and `web_fetch` run without asking. `DEFAULT_WEB` in
  `src/config/load.ts`.
- **Why:** looking up docs and errors is ordinary coding work.
- **Same as:** Claude Code ships web search and web fetch tools built in.
- **Off switch:** **Web lookups** in `/settings` (`web: false`); a project file can't change `web:`.
- **Guard rails:** public `https` pages only (`http` is upgraded), checked again on every redirect; a search or
  address holding a secret is refused and never sent; private, local and cloud-metadata addresses are refused;
  secrets on a page are hidden before the AI reads it; page text is untrusted data, never instructions.
- **A finding:** a lookup reaches a private, loopback or metadata address (your own `web.searxngUrl` aside, which
  may be on your network); a secret leaves in a query or URL.

### 9. The browser's `serve` runs the project's `package.json` script

- **What:** `serve` runs the trusted project's `dev` or `start` script through a shell on a loopback port, with
  `node_modules/.bin` on PATH, a temporary HOME, no inherited credential environment, Bun auto-install off and
  npm offline. With **Browser clicks** on it starts unasked. `serveHolds` in `src/browser/session.ts`, `src/browser/server.ts`.
- **Why:** the AI has to run the app to test it.
- **Same as:** item 2: in the shell, `npm run dev` is routine work too.
- **Off switch:** **Browser clicks** off: any effect other than `local-test` and any obvious risky command asks.
- **Guard rails:** a script that runs a download through a shell (`curl … | sh`) or uses `sudo` asks even with
  clicks on; no lifecycle hooks and no dependency installer; existing listeners are never killed; one server
  a session, which a repeated `serve` stops and starts again (only Casper's own). `serve` is not a sandbox, and BROWSER.md says so.
- **A finding:** `curl … | sh` or `sudo` in the script starts unasked; the server gets the user's credential
  variables or HOME; a server Casper didn't start is killed.

### 10. `make_picture` uses the user's own Codex CLI, then a free model

- **What:** in order: the user's ChatGPT plan through the `codex` they installed and signed in to (only when
  `codex login status` says ChatGPT, never an API key), then a free OpenRouter model with the user's OpenRouter
  sign-in (or the models in their own `pictures.models`). A paid model runs only when the call names it (the tool
  tells the AI to name one only when the user's request does) or the user listed it in `pictures.models`. `src/pictures/tool.ts`, `src/pictures/codex.ts`.
- **Why:** pictures from what the user already pays for, at no extra cost by default.
- **Same as:** any agent running a CLI the user installed; Casper does not borrow its login.
- **Off switch:** **Pictures the AI makes** in `/settings` (`pictures: off`).
- **Guard rails:** Casper never reads or reuses Codex's sign-in; Codex runs in an empty temp folder under its own
  `-s read-only` sandbox and gets none of Casper's or the shell's keys (only PATH, HOME, user, locale, temp,
  Codex-home, proxy, certificate and Windows system variables); a description holding a secret is never sent; every picture is recorded in the task's
  spend, $0 ones too.
- **A finding:** Codex's token is read or sent by Casper; Codex gets an API key or Casper's keys; a paid model
  runs without being named in the call or listed in `pictures.models`.

### 11. The loop guard skips identical repeated reads

- **What:** the 3rd identical `read`, `grep`, `find` or `ls` with only reads in between gets a note; from the 5th
  it is not run and the earlier result (its first 1,500 characters) is handed back with `Skipped as a repeat`. Any other tool, and each new
  request, resets the count. `src/runtime/loop-guard.ts`.
- **Why:** a model stuck re-reading the same file burns turns and money.
- **Same as:** the code borrows from omp's tool-call loop guard, Gemini CLI's loop detection and opencode.
- **Off switch:** none; only exact repeats with nothing changed are touched.
- **Guard rails:** only those four read tools are counted; edits, the shell, the browser, web, MCP and checks
  are never skipped and reset the count.
- **A finding:** a read skipped after an edit, a shell command or a new request; any non-read tool skipped.

## Consequences

- A review that flags one of these choices without showing its guard rail broken is closed as by design.
- A change to any of these choices updates this list in the same PR.
- A new on-by-default behaviour that reviewers are likely to flag gets an entry here.
