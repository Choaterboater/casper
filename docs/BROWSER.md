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
`serve`, `check` and `replay`. There is no arbitrary JavaScript/CDP endpoint.
Inspection supplies bounded text and control metadata, including selectors for
IDs; controls without IDs require an explicit CSS selector. Selectors must match
exactly one element for interactions and element assertions.

`fill` replaces the text in a text, search, tel, url, email or number input, or a
textarea, and sets a date, time, datetime-local, month, week, color or range field
the way a picker would; password and file fields are not supported. Values must
be nonempty, single-line text, up to 1,024 bytes.
`press` supports `Enter`, `Tab`, `Escape`, `ArrowUp`, `ArrowDown`, `ArrowLeft`,
`ArrowRight`, `Space` and `Backspace`.

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

Supported assertions:

- `text`: exact comparison of trimmed `textContent` (nonempty expected text).
- `visible`: positive geometry and browser visibility checks.
- `no-horizontal-overflow`: the page's width does not exceed the viewport's; with
  a `selector`, that one element's content fits its box and the element stays
  inside the viewport.
- `no-overlap`: element rectangles do not intersect, with positive geometry;
  the primary element must be visible. This is not pixel/aesthetic acceptance.

Assertions poll for up to one second each. Complex navigation, shadow DOM,
iframes, uploads, authenticated workflows and slow asynchronous readiness are not
comprehensive browser-test-framework replacements.

Browser results get their own `browser` line in the task receipt, apart from
the project checks. In one-shot mode a failed assertion makes the exit code 1,
and an incomplete or stale browser check makes it 2, unless a failed or cancelled
task already set a stronger result. Inspecting a page alone is not a check.

Casper still runs the project's own checks after edits, as usual (see
[VERIFICATION.md](VERIFICATION.md)). A failed browser check does not start
Casper's repair loop; ask the model to fix it and replay the check. A passing
browser check proves only its listed assertions. It does not prove the whole
page is right, that every requirement is met, or that the model's summary is
correct.

Freshness compares declared local inputs before/after replay and at task reporting.
Observed native writes/shell actions invalidate earlier evidence. Missing,
unsupported or over-budget input scope means freshness unavailable. These are
bounded, non-atomic filesystem observations: they do **not** prove which build the
server is serving, that the input scope is complete, or that external state stayed
unchanged. Screenshots and model claims never count as assertion passes.

## Permissions and ownership

Every interaction/server start declares `impact` and a reason. `local-test` is
only for requested, synthetic, nonconsequential work in the trusted local project.
Known consequential labels, nonlocal interactions and `consequential`/`uncertain`
impact ask you first: `1 No · 2 Yes, this once · 3 Yes, for this session` (3: browser
actions don't ask again until Casper exits or the workspace changes). One-shot/cooked input
cannot grant that approval. Personal credential/payment/file inputs are refused. Approval is
repeated on replay; denied actions are not executed and consequential actions are
not automatically retried. An approval preview is rechecked before acting, but
DOM checks and clicks are not an atomic transaction.

**This is a behavioral permission policy, not network isolation or a sandbox.**
Ordinary external resources/read-only navigation work. Local pages and repository
scripts can themselves cause side effects; localhost and HTTP methods do not
establish safety. Labels and model-declared impact are not complete effect
analysis. Page content is untrusted data, not instructions or consent.

**One exception: cloud metadata addresses ask first.** On a cloud machine, a page at
`169.254.169.254` (AWS, Azure, GCP, Oracle), `fd00:ec2::254`, `metadata.google.internal`,
`169.254.170.2` (ECS) or `100.100.100.200` (Alibaba) can hand out that machine's cloud login.
Before the AI's browser reaches one, by opening it, a check's URL, a redirect, a link it clicks,
a frame, a picture, a fetch, or a name that points there, Casper asks once:
`Open 169.254.169.254?` with `1 No · 2 Yes, this once · 3 Yes, for this session` (3 covers that
address only; a yes to other browser actions never does). On a yes the page loads again; on a
no it stays unopened and the result says `notOpened`. A run that can't ask doesn't open it.
LAN, private, loopback and other link-local addresses open as before, with no question. Only
page loads and those addresses pass through Casper on their way out; other traffic does not.

`serve` is the browser tool's own small way to start a dev server. For a server
that should stay up between requests, declare a [managed service](SERVICES.md)
instead.

`serve` runs the exact trusted project's `package.json` `dev` or `start` command
through a shell, with project `node_modules/.bin` on PATH, isolated temporary HOME,
PORT/HOST from the explicit unprivileged loopback HTTP URL, no inherited credential
environment, Bun auto-install disabled and npm offline mode. It does not invoke
package-manager lifecycle hooks. Inspect the script first: these settings do not
sandbox it or prevent code from reading project `.env` files. Obvious risky
commands and uncertain effects require approval; no dependency installer is
provided. Scripts must respect PORT/HOST or already specify the requested port.

Existing listeners are never replaced or killed. Readiness means an HTTP response,
not application correctness or an atomic proof of port ownership. Only Casper-owned processes are targeted: POSIX uses best-effort group signalling,
Windows uses verified descendants. Unconfirmed cleanup blocks replacement. One server is allowed per session. Model-task end,
cancellation, workspace revocation and shutdown close owned resources; manually
opened browsers remain until closed, adopted by a model task or application exit.
After a forced SIGKILL of Casper or a power loss, cleanup may not happen.

## Bounds and artifacts

- Serialized operations; 64 operations and 8 immutable scenarios per session.
- Scenarios: 16 KiB, 12 steps, 1–4 assertions; total arguments: 20,000 bytes.
- Operation deadline: 15 seconds (30 for check/replay), including approval wait;
  navigation/server readiness: 10 seconds.
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

Use native `read` on a returned PNG path to deliver image content to a
vision-capable model. Tests verify actual image content in the Pi provider request,
not merely a path. A text-only model or saved screenshot alone does not establish
that the model viewed/understood it. Model/provider retention policy still applies.


Screenshot file output currently requires macOS/Linux. Windows screenshot capture
cannot use the POSIX artifact bridge; inline diagram fallback does not provide
screenshot files. See [platform support](PLATFORM_SUPPORT.md).
