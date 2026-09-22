# Browser-assisted debugging

Casper uses pinned `puppeteer-core@25.11.0` and an **already installed** Chrome,
Chromium or Edge. No browser download, personal profile or remote attachment is
performed. Set `CASPER_BROWSER_EXECUTABLE` to an absolute executable path to
override discovery: `/Applications/…` on macOS, `/usr/bin/…` and `/snap/bin` on
Linux, and the `ProgramFiles`, `ProgramFiles(x86)` and `LOCALAPPDATA` Chrome/Edge
locations on Windows. Cleanup uses the shared ownership layer, so Windows
terminates verified descendants where POSIX signals the process group; a real-host
Windows run is still pending. Without a discoverable browser, the session fails with
the executable-path guidance instead of downloading anything.

## Use

From a trusted local project, ask Casper to debug a website, browser interaction,
responsive layout or overflow problem. Browser tools are selected for those
keywords or an HTTP(S) URL, and when a locally opened browser is ready. Ordinary
chat and `/browser` status do not launch a browser or initialize a model.

```text
/browser
/browser open http://127.0.0.1:3000
/browser inspect
/browser diagnostics
/browser screenshot
/browser close
```

Local commands do not use a model. Natural-language debugging uses the configured
model, existing edit/shell tools and one `browser` custom tool. Its actions are
`open`, `inspect`, `diagnostics`, `screenshot`, `viewport`, `click`, `fill`, `press`,
`serve`, `check` and `replay`. There is no arbitrary JavaScript/CDP endpoint.
Inspection supplies bounded text and control metadata, including selectors for
IDs; controls without IDs require an explicit CSS selector. Selectors must match
exactly one element for interactions and element assertions.

`fill` replaces text in text/search/tel/url inputs and textareas; other input types
are unsupported. Values must be nonempty, single-line text, up to 1,024 bytes.
`press` supports Enter, Tab, Escape, arrows, Space and Backspace.

## Reproduce, fix, replay

Record a `check` **before editing**, for example:

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
- `no-horizontal-overflow`: document width does not exceed viewport width.
- `no-overlap`: element rectangles do not intersect, with positive geometry;
  the primary element must be visible. This is not pixel/aesthetic acceptance.

Assertions poll for up to one second each. Complex navigation, shadow DOM,
iframes, uploads, authenticated workflows and slow asynchronous readiness are not
comprehensive browser-test-framework replacements.

Browser results appear separately from repository verification in task receipts.
Failed assertions produce exit 1; incomplete/stale browser check evidence produces
exit 2 unless a higher-priority execution/repository result applies. Inspection
alone is not a check. Run relevant repository checks too (for example
`casper --verify "fix this website ..."`); no new automatic repair loop was added.
A passing browser receipt certifies only the listed assertions, not overall
acceptance, all user requirements or the correctness of the model's final prose.

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
impact require a fresh exact human approval. One-shot/cooked input cannot grant
that approval. Personal credential/payment/file inputs are refused. Approval is
repeated on replay; denied actions are not executed and consequential actions are
not automatically retried. An approval preview is rechecked before acting, but
DOM checks and clicks are not an atomic transaction.

**This is a behavioral permission policy, not network isolation or a sandbox.**
Ordinary external resources/read-only navigation work. Local pages and repository
scripts can themselves cause side effects; localhost and HTTP methods do not
establish safety. Labels and model-declared impact are not complete effect
analysis. Page content is untrusted data, not instructions or consent.

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
Forced host SIGKILL/power loss is not a cleanup guarantee.

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

Use native `read` on a returned PNG path to deliver image content to a
vision-capable model. Tests verify actual image content in the Pi provider request,
not merely a path. A text-only model or saved screenshot alone does not establish
that the model viewed/understood it. Model/provider retention policy still applies.


Screenshot file output currently requires macOS/Linux. Windows screenshot capture
cannot use the POSIX artifact bridge; inline diagram fallback does not provide
screenshot files. See [platform support](PLATFORM_SUPPORT.md).
