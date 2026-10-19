# Browser-assisted debugging

**What this is:** Casper can open your web app in a throwaway browser, read the
page, click and type, take screenshots, and record a small repeatable check.
**When you'd use it:** to reproduce a web page bug (for example a button that
does nothing, or a layout that overflows on a phone), fix it, and replay the
same check to see the fix.

## Which browser

Casper uses `puppeteer-core@25.11.0` (a library that drives Chrome) with a
Chrome, Chromium or Edge that is **already installed**. It never downloads a
browser, never uses your personal browser profile, and never attaches to a
browser you have open.

It looks in these places, in order:

- macOS: `/Applications/Google Chrome.app/…`, then `/Applications/Microsoft Edge.app/…`
- Linux: `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`,
  `/usr/bin/chromium`, `/usr/bin/chromium-browser`, `/snap/bin/chromium`
- Windows: Chrome under `ProgramFiles`, `ProgramFiles(x86)` and `LOCALAPPDATA`,
  then Edge under `ProgramFiles` and `ProgramFiles(x86)`

To use another browser, set `CASPER_BROWSER_EXECUTABLE` to its full path; that
always wins. If no browser is found, the browser step fails with a message about
that setting. Nothing is downloaded.

Stopping the browser uses Casper's shared process cleanup: on macOS and Linux it
signals the browser's process group, on Windows it ends the child processes it
has checked. Windows has not yet been tested on a real machine.

## Use

From a trusted local project, ask Casper to debug a website, a browser
interaction, a responsive layout or an overflow problem. When Chrome or Edge is
installed (or `CASPER_BROWSER_EXECUTABLE` is set), the model has the `browser`
tool from the first request in every project, so "fix the spacing on the settings
page" in a web app is not done blind. Without one, it gets the tool only when your
request has an `http://` or `https://` URL or one of these words: browser,
website, webpage, frontend, layout, responsive, overflow, css, puppeteer,
playwright, or when a browser you opened with `/browser open` is ready. Once
offered, the tool stays for the session. Having the tool starts nothing: ordinary
chat and `/browser` status do not start a browser or a model.

To turn the AI's browser off, pick **Browser tool** in `/settings` (it writes
`browser: off` in `~/.casper/config.yaml`). The model is then never offered the
`browser` tool. The page checks after a change still run (they are Casper's own
check, not the AI's browser), and `/browser`, typed by you, still works. A
project file can't turn it back on.

```text
/browser                              status (starts nothing)
/browser open http://127.0.0.1:3000   open a page in a throwaway browser
/browser inspect                      page text and controls
/browser diagnostics                  recent console and network entries
/browser screenshot                   save a PNG of the visible part of the page
/browser close                        close the browser Casper opened
```

These commands do not use a model. When you ask in plain words, the model uses
its normal edit and shell tools plus one `browser` tool. Its actions are
`open`, `inspect`, `diagnostics`, `screenshot`, `viewport`, `click`, `fill`, `press`,
`select`, `serve`, `check`, `replay` and `withdraw`. There is no arbitrary JavaScript/CDP endpoint.
Inspection supplies bounded text and control metadata, including selectors for
IDs; controls without IDs require an explicit CSS selector. Selectors must match
exactly one element for interactions and element assertions.

`fill` replaces the text in a text, search, tel, url, email or number input, or a
textarea, and sets a date, time, datetime-local, month, week, color or range field
the way a picker would. A password field is filled only as a `local-test` on a page
on this computer, so the AI can test a login it built with a made-up test account;
card-number, one-time-code and file fields are not supported. Values must
be nonempty, single-line text, up to 1,024 bytes.
`select` picks an option of a `<select>` by its value, or else its label, and
fires `input` and `change`; `fill` on a `<select>` says to use `select`.
Before `click`, `fill`, `press` or `select`, Casper scrolls the element into view
and waits up to a second for it to settle, so a button below the screen, or one
that grows or fades in once scrolled to, can be used.
A `click`, or a `fill` that types, lands where a person's would: when another
element covers the target's center (a toast, a cookie bar) for more than a
second, the step fails naming it, such as `button "Save" is covered by
div.toast "Saved"`. A label for the field, or a dialog that holds the target,
is not a cover. After the action Casper watches the page for up to 1.5 seconds,
ending once it goes quiet: when a `click` or `press` changed nothing (no page
change, attribute such as `aria-pressed`, new address, focus move, a field
focused to type in, scroll, field state, request, dialog or new tab), the
result has the note `nothing changed after clicking button "Save"`; it is a
note, not a failure. A check's steps share 8 seconds of this watching; a step
whose watch is cut short gets no note. A native `alert`, `confirm`, `prompt` or leave-page dialog
is still dismissed (Cancel, or stay on the page), and the result lists it under
`dialogs`, such as `confirm dialog "Clear this item?": Casper answered Cancel`;
a check lists both under `notes`, by step.
The result also says what the action changed, as a person would see it, under
`changes`: the address it left (`previousUrl`), a new `title`, text that
appeared (`appeared`, such as a toast, an error or a status, up to 400
characters), up to 5 controls added or removed (`controlsAdded`,
`controlsRemoved`, such as `button "Try again"`) and where `focus` moved (not
onto the element the action used, nor the same control drawn again). Casper
compares a short outline of the page's visible text and controls (at most 400
entries) taken before and after; when none of these changed, `changes` is left out.
`press` supports `Enter`, `Tab`, `Escape`, `ArrowUp`, `ArrowDown`, `ArrowLeft`,
`ArrowRight`, `Space` and `Backspace`.

## /look: review and polish a page

`/look <command> [page or url]` runs one design pass on a page as an ordinary task, with the
`browser` tool. `/look` alone shows the numbered list (pick one where Casper can ask).

| Command | What it does |
| --- | --- |
| `critique` | Screenshots at 390 and 1280 wide; scores Nielsen's 10 usability heuristics 0 to 4; what works, issues marked P0 to P3, 3 questions. A report: no edits |
| `audit` | `diagnostics`, `inspect`, and checks for no sideways scroll at 390 and no overlap of the header and the content; scores accessibility, performance, theming, responsive and integrity 0 to 4. A report: no edits |
| `polish` | Fixes in this order: broken, missing states, hierarchy and responsive, visual, cleanup |
| `layout` | Spacing, grouping and reading order |
| `type` | Sizes, weights, line length and wrapping |
| `colour` | Theme tokens only, with the contrast worked out for light and dark (`color` works too) |
| `quieter` | Calms a loud page through theme tokens only |
| `adapt` | 390, 768 and 1280 wide: overflow, overlap, 44px tap targets |
| `harden` | Long text (a 200-character string), empty, loading and error states, a check for each |
| `clarify` | Wording only |

- **Which page.** A link you give (`/look audit http://127.0.0.1:5173/`) is used as it is. Otherwise
  Casper finds the page the same way as the [page checks](VERIFICATION.md) after a change: the
  dev server from `services.web` or `package.json` (the AI starts it with `serve`), or the
  project's `index.html` (served with `script: "files"`). A path (`/look adapt /settings`) picks
  the page on it. With none, Casper says so and runs nothing: `There is no page here to look at`.
  A missing `node_modules`, no Chrome or Edge, or the browser tool off in `/settings` is said the
  same way, also with no model call.
- **Only its own instructions.** Each command's instructions are a small file of their own
  (`src/look/<command>.md`, 230 to 450 tokens), added to that one request only. None of them is in
  the fixed prompt, and the next request has none.
- **Fixes end by looking again.** The fixing commands record checks before they edit, then replay
  them and take fresh screenshots; Casper's own end-of-task replay and page checks run as after
  any change. `critique` and `audit` are told to change no files; the receipt shows any that did.
- `/look` waits for a running task, like `/plan`.
- The instructions are adapted and trimmed from
  [pbakaus/impeccable](https://github.com/pbakaus/impeccable)'s command references (Apache-2.0,
  Copyright 2025 Paul Bakaus), shortened and rewritten in Casper's words; the notice is in
  `THIRD_PARTY_NOTICES.txt` (`casper --licenses`).

## Reproduce, fix, replay

The model records a `check` **before editing**. You do not write this JSON
yourself; it shows what a check holds:

```json
{
  "action": "check",
  "scenario": {
    "name": "Save at mobile width",
    "url": "http://127.0.0.1:3000",
    "viewport": { "width": 375, "height": 700 },
    "scope": { "inputs": ["src", "package.json"], "exclude": ["src/generated"] },
    "steps": [
      { "action": "fill", "selector": "#name", "value": "Ada", "impact": "local-test", "reason": "Synthetic fixture name" },
      { "action": "click", "selector": "#save", "impact": "local-test", "reason": "Save synthetic fixture data" }
    ],
    "assertions": [
      { "kind": "text", "selector": "#status", "expected": "Saved Ada" },
      { "kind": "no-horizontal-overflow" }
    ]
  }
}
```

Use `{"action":"replay","id":"<returned-id>"}` after the fix. The scenario is
immutable, identified by ID and SHA-256, and retains its original baseline outcome.
Each execution uses fresh browser storage. IDs last for this task/session only;
there is no durable scenario library. A baseline that never failed is not proof of
reproducing the user's bug.

A check or replay the model runs also brings the page as the steps left it, under
`finalPage`: its title, address, size, the first 1,500 characters of its text and
its first 20 controls (with a selector where they have an id), and a picture of the
visible screen. A model that can see images gets the picture with the result;
another model gets the text only. So the model has no `open`, `inspect` or
`screenshot` to do after its own check. On a crowded page it keeps fewer controls
and less text so the result is never cut, and reading the page never changes the
check's result. These pictures have their own limit (30 a session, apart from the
model's 16 screenshots), are saved with the other browser pictures, and are never
part of the report. `showPages: off` (`/settings`, Show the AI the pages: never)
leaves the picture out; the text still comes. Casper's own end-of-task replays
bring neither.

`{run}` in a `fill` or `select` value becomes a new short value (letters and
digits) on each run, the recording and every replay, so a check that signs up
`user-{run}@example.com` or books a slot passes again on a page that refuses a
repeat. The stored check keeps `{run}`. A replay that fails a check which passed
when recorded and fills a fixed email, user name or name says so: `It passed
before: a sign-up or booking may need a new value each run; use {run} in the
fill value.`

A check the model wrote wrong (an expected text or a selector that was never
right) can be taken out of the result with
`{"action":"withdraw","id":"<returned-id>","reason":"expected text had a typo"}`.
The reason is required (one line, up to 200 bytes). Casper accepts it only when
the check's last run failed and nothing changed since the check was recorded: no
edit or command after it, and its inputs are the same. Otherwise it refuses and
says why, such as `Code/tool writes observed after this browser check: fix the
page and replay it`, so a page fixed after a failure is replayed, never
withdrawn. A check that still fails when replayed after a change can't be
withdrawn either, since its failure may be real. The way out for a check written
wrong after a change is a replacement: record a corrected check of the same page,
and once it passes, withdraw the old one naming it,
`{"action":"withdraw","id":"<old-id>","reason":"selector too wide","replacedBy":"<new-id>"}`.
Casper accepts that only when the replacement was recorded after the old check,
its latest run passed, and it opens the same page (the same path; the query and
port may differ) at the same viewport, with at least as many steps and assertions
of each kind as the old one, so a check that the page merely loads can't stand in
for one that caught a real bug. The old check's reason then reads
`selector too wide (replaced by "<new name>", <new-id>)`, and the replacement
decides the result in its place. A new check that stops part
way (a step's element is not there yet) still returns its id in the error: replay
it once the page is ready, or withdraw it while no edit or command has run since.
A check whose recording never finished (no server answered yet) is recorded by
its first finished run, so a failure there can be withdrawn like one from a
recording.
A new check whose step selector matches several elements is not kept at all: the
error says how many it matched, and the check is recorded again with one element.
Withdrawing a check that passed is refused, and so is replaying a withdrawn id. A
withdrawn check stays visible: its status is `withdrawn` in the JSON report, with
the reason under `withdrawn`, and the receipt says
`– 1 check withdrawn by the AI: <name> (<reason>)`. It does not fail the task, it
does not count as a pass, and Casper's end-of-task replay skips it. The rule
against swapping a check for an easier one stays: a corrected check is recorded
as a new check and must pass on its own. If every browser check was withdrawn,
the task is incomplete: `– Incomplete — every browser check was withdrawn; none
is left to show the page works`.

Supported assertions:

- `text`: exact comparison of `textContent` (nonempty expected text), with runs of
  spaces and line breaks counted as one space on both sides and the ends trimmed.
- `visible`: positive geometry and browser visibility checks.
- `no-horizontal-overflow`: the page's width does not exceed the viewport's; with
  a `selector`, that one element's content fits its box and the element stays
  inside the viewport.
- `no-overlap`: element rectangles do not intersect, with positive geometry;
  the primary element must be visible. This is not pixel/aesthetic acceptance.

A check's step waits up to 5 seconds for its element while the selector matches
nothing or the one element it matches is disabled, so a time slot or list that
loads later is clicked once it is there; a selector that matches several
elements still fails at once, and the re-check after an approval box does not
wait. Assertions poll for up to one second each. When a selector matches no element,
or a text does not match, the failed assertion also lists under `near` up to 3
real elements on the page most like the one asked for (by id, class, tag or
text), such as `h1#page-title "Hello Casper"`. On a replay it also has a
`hint`: `If the check itself is wrong, record a corrected check of this page and
withdraw this one (replacedBy: its id once it passes); if the page is wrong, fix
it.` (not on the run that records it, or the first finished run of one that never
finished: a check recorded before the edit is meant to fail then). When the
expected text is exactly the text of an element inside the matched one (a whole
confirmation box compared with its heading), the hint on any run is instead `The expected text is
inside this element with other text: point the selector at the element that holds
only it (see near).` It still fails. Complex navigation, shadow DOM,
iframes, uploads, authenticated workflows and slow asynchronous readiness are not
comprehensive browser-test-framework replacements.

Browser results get their own `browser` line in the task receipt, apart from
the project checks. In one-shot mode a failed assertion makes the exit code 1,
and an incomplete or stale browser check makes it 2, unless a failed or cancelled
task already set a stronger result. Inspecting a page alone is not a check.

When a task finishes (not when it fails or is cancelled), Casper replays once,
before the receipt and without asking the model to replay, each check this task recorded or
replayed that ran before a later edit or command, so the model need not replay a
check just to count it. Checks from earlier tasks in the session are left alone.
The fresh result counts: a pass is a pass, a failure is a failure with its
evidence. Only pages on this computer are replayed, and only `local-test` steps;
one whose label has a word such as "send", "buy" or "delete" (a contact form's
Send) only with Browser clicks on, as it ran for the model. Nothing is asked: any
other step, an address that would need a yes, a busy or closed browser, or a replay that can't finish keeps the
check as it was, and the receipt still says `ran before a later edit or command
(replay to count)`. A withdrawn check is never replayed.
A replay (Casper's or the model's) whose page is on a loopback server that no
longer answers (the model started it in a command and stopped it) opens the same
path on the server Casper runs for the project, from `serve` or the page checks,
and the check's `notes` say so: `opened on Casper's server <origin>: nothing
answers at <old origin> any more`. With no server of Casper's up, nothing was
checked: the check becomes incomplete with the reason `Could not check. Nothing
answers at <origin> any more and Casper runs no server for this project; start it
with serve and replay`, neither its old pass nor its old failure. A page on
another computer is never redirected. A line names each check
as it is replayed. All of these replays share one minute; one that runs out of time is given up and the browser
stays open.

If this replay produces a fresh failure and a try remains in `repair.maxAttempts`,
Casper gives the model **one repair turn**, using the same budget as command,
page-note and proof repairs. Incomplete or stale results, and failures from checks
not replayed by this task, do not start that turn. After it, Casper replans and
reruns relevant project checks (fresh scoped passes can still be reused), refreshes
proof/acceptance when applicable, then replays the recorded checks again. A failed
id is retried even if the repair edited nothing, under the same unattended replay
restrictions. There is no second browser repair turn; remaining failures stay failed.
A repair that fails or stops launches no further checks or replay. Final receipt
snapshots include the repair edits.

A screenshot larger than 2000 px or 4.5 MB of base64 is shrunk before it is sent,
as Pi's `read` shrinks pictures, so it stays under the provider's per-image limit.

Casper still runs the project's own checks after edits, as usual (see
[VERIFICATION.md](VERIFICATION.md)). Outside the end-of-task replay described
above, a failed browser check does not start Casper's repair loop; the model fixes
it and replays the check in its turn. A passing
browser check proves only its listed assertions. It does not prove the whole
page is right, that every requirement is met, or that the model's summary is
correct.

Freshness compares declared local inputs before/after replay and at task reporting.
Observed native writes/shell actions invalidate earlier evidence. A check that
names no `scope.inputs` watches the whole project folder, leaving out dependency,
build and cache folders at its top (`node_modules`, `.git`, `dist`, `build`,
`.next`, `.venv` and the like), files the project's git ignores (with no git
repository a `.gitignore` in the project folder is still read), and the app's own
data files, the same ones the [app smoke](VERIFICATION.md) leaves out (`data.json`,
`.jsonl`, `.csv`, `.log`, SQLite; not `package.json` or other manifests and configs).
So an app that saves to `data.json` or `data/db.json` while the check adds a row
keeps the check fresh. A file named in `scope.inputs` counts even when git ignores
it or it holds data. Any edit or command of the model still makes the check stale,
whichever file it touches; what a page or a server the model started earlier writes
to an ignored or data file is not seen. Unsupported or
over-budget input scope (a project too big to watch whole, a file over 1 MiB) means
freshness unavailable, and the check says to name the files the page depends on. These are
bounded, non-atomic filesystem observations: they do **not** prove which build the
server is serving, that the input scope is complete, or that external state stayed
unchanged. Screenshots and model claims never count as assertion passes.

## Permissions and ownership

Every interaction/server start declares `impact` and a reason. Clicks, typing and
key presses run without asking, on any page, a Send or Delete button included, so the
AI can test what it built (**Browser clicks: on** in `/settings`). Turn it off (it writes
`browser_clicks: false` in `~/.casper/config.yaml`; a project can't change it) and a
known consequential label, a nonlocal interaction or `consequential`/`uncertain` impact
asks you first: `1 No · 2 Yes, this once · 3 Yes, for this session`; a run that can't
ask says no, and the refusal names the label word that held a local test (a "Send
message" button holds on `send`). Payment, one-time-code and file inputs are refused, and a password field anywhere but a local test on this computer. Consequential actions are not automatically
retried. DOM checks and clicks are not an atomic transaction.

**This is a behavioral permission policy, not network isolation or a sandbox.**
Ordinary external resources/read-only navigation work. Local pages and repository
scripts can themselves cause side effects; localhost and HTTP methods do not
establish safety. Labels and model-declared impact are not complete effect
analysis. Page content is untrusted data, not instructions or consent.

**One exception: cloud metadata addresses ask first.** On a cloud machine, a page at
`169.254.169.254` (AWS, Azure, GCP, Oracle), `fd00:ec2::254`, `metadata.google.internal`,
`169.254.170.2` (ECS) or `100.100.100.200` (Alibaba) can hand out that machine's cloud login.
Before the AI's browser reaches one, by opening it, a check's URL, a redirect, a link it clicks,
a frame, a picture or a fetch, or a page whose name points there, Casper asks once:
`Open 169.254.169.254?` with `1 No · 2 Yes, this once · 3 Yes, for this session` (3 covers that
address only; a yes to other browser actions never does). On a yes the page loads again; on a
no it stays unopened and the result says `notOpened`. A run that can't ask doesn't open it.
LAN, private, loopback and other link-local addresses open as before, with no question. Only
page loads and those addresses pass through Casper on their way out; other traffic does not.
The automatic page check after a change is not the AI's browser: it loads the project's own
pages as before, with no question, then up to 5 same-origin pages they link to, with a plain GET
and never a form or a link that could sign out, delete or reset something
([VERIFICATION.md](VERIFICATION.md)).

`serve` is the browser tool's own small way to start a dev server. For a server
that should stay up between requests, declare a [managed service](SERVICES.md)
instead. It runs in the same `web` slot as the dev server Casper starts for its
[page checks](SERVICES.md#dev-servers-for-page-checks), so there is one owner: the
page check after the task restarts or reuses that server on the same port rather
than starting a second copy beside it (an app that allows one running copy would
refuse it), and Casper's end-of-task replays then reach the current code. It shows
in `/services` while it runs. A declared `services.web` is left as you wrote it, and
`serve` then runs its own server as before.

`serve` again stops Casper's own earlier server and starts the new one, so after a
change to server code the AI restarts it there instead of starting one in the shell
that Casper can't see or stop. A port something else holds is still refused.

`serve` runs the exact trusted project's `package.json` `dev` or `start` command
through a shell, with project `node_modules/.bin` on PATH, isolated temporary HOME,
PORT/HOST from the explicit unprivileged loopback HTTP URL, no inherited credential
environment, Bun auto-install disabled and npm offline mode. It does not invoke
package-manager lifecycle hooks. Inspect the script first: these settings do not
sandbox it or prevent code from reading project `.env` files. With **Browser
clicks** on (the default) it starts without asking, unless the script runs a
download through a shell (`curl … | sh`) or uses `sudo`; turned off, obvious
risky commands and uncertain effects ask first. No dependency installer is
provided. Scripts must respect PORT/HOST or already specify the requested port.

`serve` with `script: "files"` is for a folder of plain files (an `index.html`, no
`package.json` script). No command runs and nothing asks: Casper itself serves the
project folder on the loopback URL, a folder's `index.html` included, and stops it
with the browser session, so no preview server is left behind. A path or link that
leads out of the project is not found.

Existing listeners are never replaced or killed. Readiness means an HTTP response,
not application correctness or an atomic proof of port ownership. Only Casper-owned processes are targeted: POSIX uses best-effort group signalling,
Windows uses verified descendants. Unconfirmed cleanup blocks replacement. One server runs per session; a repeated `serve` replaces it. Model-task end,
cancellation, workspace revocation and shutdown close owned resources; manually
opened browsers remain until closed, adopted by a model task or application exit.
After a forced SIGKILL of Casper or a power loss, cleanup may not happen.

## Bounds and artifacts

- Serialized operations; 200 operations and 24 immutable scenarios per session (past 24, replay the ids you have).
- Scenarios: 16 KiB, 12 steps, 1–8 assertions; total arguments: 20,000 bytes.
- Operation deadline: 15 seconds (30 for check/replay), including approval wait;
  navigation/server readiness: 10 seconds.
- Chrome that crashes or is killed: checks it passed become stale, the next action says
  `Chrome stopped unexpectedly and Casper started a new one`, and the next open starts a
  fresh Chrome with a new profile (the old page and anything typed into it are gone; the
  server the session started keeps running). Two fresh starts per session; a third crash,
  or a Chrome whose processes can't be confirmed stopped, closes the session as before.
- A first Chrome start that has not answered after 8 seconds is stopped and replaced by one
  fresh start, and the running action's deadline starts again.
- Viewport: 240–1920 × 240–1080; default 1280 × 800.
- Inspection: 8,000 text characters, 40 controls; diagnostics: 30 console and
  30 network entries, 8 KiB server output. Network URL queries/fragments omitted.
- Tool responses: at most 16 KiB **after terminal escaping**, with explicit
  truncation. Raw observations, URLs, logs and screenshots may still be sensitive.
- Viewport-only PNGs: 4 MiB each, 16 per session, saved outside the workspace at
  `<project-state>/browser/<run-id>/<number>.png`, directories 0700/files 0600.
  Symlinked artifact destinations are refused. Saved PNGs persist after close;
  remove that run directory manually when no longer needed. No automatic retention
  cleanup or secret detector is provided.
- Page checks save their own pictures beside them (`page-<n>-desktop.png`,
  `page-<n>-phone.png`, at most 40 per session); they don't count toward the
  model's 16. See "Screenshots" in [VERIFICATION.md](VERIFICATION.md#page-checks).

A screenshot comes back to the model as a picture with the tool's result when
the model can see images, so it needs no extra `read`. A text-only model gets the
saved path and a note that the picture was left out. Tests verify the actual image
in the Pi provider request. Page pixels are untrusted data, like page text. A saved
screenshot alone does not establish that the model understood it. Model/provider
retention policy still applies.


Screenshot file output currently requires macOS/Linux. Windows screenshot capture
cannot use the POSIX artifact bridge; inline diagram fallback does not provide
screenshot files. See [platform support](PLATFORM_SUPPORT.md).
