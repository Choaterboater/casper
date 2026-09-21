# Local browser-controller comparison

Date: **2026-09-20**. Executed following the user's “ok compare” approval.
Complements [the broader primary-source survey](../BROWSER_TOOLING_RESEARCH.md).

## Decision recommendation

**Recommend pinned `puppeteer-core` as Casper's first browser controller**, subject
to approval of the production dependency and the normal implementation gates.
It exercised the required local interaction/layout/diagnostic behavior directly
under Bun, with no extra browser daemon or generic MCP permission layer to adapt.
This is a fit judgment, not a universal performance or reliability ranking.

- **agent-browser** is a credible alternative if we choose a ready-made agent CLI:
  richer refs/snapshot commands, fast local interactions and working confirmation
  tokens. It adds daemon/session/configuration lifetime and another policy surface.
- **Chrome DevTools MCP** is strongest for ready-made debugging diagnostics:
  useful structured text, source-linked console stacks and request inspection.
  Its generic MCP tools still need Casper-specific image, permission and evidence
  integration; merely connecting the server is not the agreed product workflow.
- **Playwright was not installed or benchmarked here.** This comparison does not
  establish Puppeteer outperforming Playwright. Playwright remains relevant for
  cross-engine testing; the approved bakeoff was Chrome DevTools MCP versus
  agent-browser versus the Puppeteer baseline.

Do not adopt two browser backends at once. Optional deeper diagnostic integration
can be reconsidered after the first controller works through Casper itself.

## Environment and isolation

- macOS / Apple Silicon; installed **Google Chrome 153.0.8010.53**.
- Node **25.9.0**, Bun **1.4.0**.
- `puppeteer-core` **25.11.0**, `chrome-devtools-mcp` **1.9.0**,
  `agent-browser` **0.38.1**, MCP SDK **1.30.0**.
- Packages installed only into `/tmp/casper-browser-compare.TwvHx3`, with install
  scripts disabled, no browser download and no project dependency/lockfile edits.
  agent-browser's native macOS binary was included in its package; made executable
  directly without running its postinstall/global-shim modification script.
- Per-run HOME/TMPDIR and fresh browser profiles; explicit installed executable.
  The agent-browser profile was a fresh directory inside that run, not personal
  data. MCP telemetry, CrUX requests and update checks disabled.
- Only synthetic localhost pages were deliberately visited. A second localhost
  origin supplied an external script; no blanket network block was configured.
  This does not demonstrate behavior against production services or promise that
  browser internals never perform background networking.
- No live agent/model, credential use, account login, personal browser attachment,
  commit or push. Existing website server PID **56873** stayed alive.

## Executed behavior

The same fixture source was rewritten by the harness to apply a controlled fix:

1. Fill `Name` with synthetic `Ada`, click Save, assert **Still broken**.
2. At a 375 × 700 viewport, assert horizontal overflow: document width exceeds 375.
3. Capture a screenshot, console error/uncaught exception and a request returning
   HTTP 503. Confirm the second-origin script executed.
4. Rewrite the fixture's handler and width rule, reload and repeat the interaction.
5. Assert **Saved Ada**, document width exactly 375 and unchanged viewport.
6. Capture the fixed screenshot; verify PNG signature/dimensions.
7. Attempt a nonexistent element/text wait. Observe a bounded failure, then verify
   that the current page remains usable and still has the expected state.
8. Close and inspect comparison-owned processes; keep the control server alive.

The baseline and wrappers use **harness-authored read-only JavaScript** for layout
metrics. This proves controller access to geometry, not safe unrestricted model
script execution. Screenshots remain supporting evidence, not the pass oracle.

### Recorded runs

| Run set | Puppeteer | Chrome DevTools MCP | agent-browser |
| --- | --- | --- | --- |
| Node, graceful shutdown; three rotated-order repetitions | 3/3 | 3/3 | 3/3 |
| Node, kill owned Chrome then request another observation | 1/1 | 1/1 | 1/1 |
| Bun harness, same browser-crash scenario | 1/1 | 1/1 | 1/1 |
| Total fixture scenarios | **5/5** | **5/5** | **5/5** |

The Bun run imports Puppeteer and the MCP client under Bun. The MCP **server** still
runs under Node; agent-browser uses its native binary. Do not call this a proof
that Chrome DevTools MCP itself runs under Bun.

The initial setup failures and one corrected exploratory run are not counted in
these 15 recorded acceptance scenarios.

## Timings: local harness observations only

Medians of the three Node graceful runs (interaction/screenshot medians include
both before/after operations per run), milliseconds:

| Operation | Puppeteer | Chrome DevTools MCP | agent-browser |
| --- | ---: | ---: | ---: |
| Launch/connect + open fixture + viewport setup | 447 | 1,038 | 702 |
| Fill + click | 72 | 476 | 53 |
| Screenshot saved to file | 53 | 29 | 52 |
| Close | 71 | 95 | 130 |

**Not an apples-to-apples library microbenchmark.** MCP startup includes tool
catalog retrieval and interaction refreshes an accessibility snapshot to obtain
refs; other adapters target known selectors. Puppeteer's inspection was simple
body text, not a replacement for rich agent refs. Native CLI process overhead is
included for agent-browser. The packages/browser were already installed, OS caches
were not reset, and only three repetitions were used. Puppeteer startup ranged
445–764 ms, illustrating warm-up variability. No token, model cost, CPU or memory
ranking is inferred from these figures.

The numbers rule out an obvious multi-second local interaction bottleneck in the
small fixture; they do not predict success on complex websites.

## Rendering evidence

Representative before/after PNGs are saved for all three candidates. All are
375 × 700. Decoded RGB pixels of MCP and agent-browser matched Puppeteer's images
exactly for both states in the first recorded graceful repetition (checked with
Pillow's image difference). PNG file sizes differ; decoded pixels, not compressed
bytes, were compared. Representative screenshots were also opened for inspection.

- [Puppeteer before](browser-comparison/puppeteer-before.png) /
  [after](browser-comparison/puppeteer-after.png)
- [MCP before](browser-comparison/mcp-before.png) /
  [after](browser-comparison/mcp-after.png)
- [agent-browser before](browser-comparison/agent-browser-before.png) /
  [after](browser-comparison/agent-browser-after.png)

This proves capture/display in the **comparison harness**, not screenshot delivery
to Casper's runtime. Casper's text-only custom-tool return and MCP binary omission
still need implementation/testing, regardless of controller choice.

## Permission probe

A separate agent-browser run enabled `--confirm-actions click`. The fixture button
sends a synthetic POST only to the harness server; nothing consequential outside
the fixture exists.

- Click returned `confirmation_required: true` with a `confirmation_id`.
- Before approval: server observed **0** effects.
- Explicit denial: **0** effects.
- New request followed by explicit confirmation: **1** effect.

This validates the native confirmation token mechanism for that category, including
an executed positive control. It **does not** establish semantic detection of real
purchases/messages, cancellation/replay safety of approval tokens, or task-scoped
Casper permissions. Configuring confirmation for every click would be more intrusive
than the agreed synthetic-local-action behavior.

The live Chrome DevTools catalog marked `click`, `fill`, `new_page`,
`evaluate_script` **and `take_screenshot`** as `readOnlyHint: false`. With Casper's
current broker those calls require confirmation. A generic MCP connection therefore
would introduce repeated prompts unless narrowly adapted. Puppeteer has no native
human-consent gate: Casper must own that responsibility, not assume it is provided
by the library.

## Crash and cleanup observations

- Positive control: the process inspection saw owned Chrome processes while every
  run was active. After normal close, or after browser crash followed by close,
  it detected **zero** processes matching the run's temporary paths.
- Puppeteer rejected observation after SIGKILL with a detached-frame error.
- MCP restarted/reconnected its browser, reported that page IDs changed, and
  rejected the old page ID. It did not return the prior passing observation.
- agent-browser relaunched a browser; the old fixture was absent, so the metrics
  request failed on the missing element. It did not return stale success.
- Every run ended with explicit controller cleanup. A final process check found no
  remaining command referencing this comparison's package install. The separate
  fixture control server was alive before harness shutdown; PID 56873 was preserved.

**Limits:** this is not a process-kernel proof of absence of all descendants.
Path-based inspection plus explicit controller close was used, not Casper's actual
CLI lifecycle. We did not kill the host/controller mid-command, validate Windows,
exercise stalled IPC indefinitely or prove cleanup on all cancellation paths.
Those remain implementation acceptance requirements, not passed claims here.

## Setup findings, not product regressions

1. MCP initially refused the screenshot path because it was outside its default
   temporary output root. Adding an explicit `--filesystem-root=<run directory>`
   fixed the fixture. We did not disable path restrictions globally.
2. agent-browser initially rejected the long generated Unix socket path on macOS
   (141 bytes versus a reported maximum of 103). A unique short socket directory
   through `AGENT_BROWSER_SOCKET_DIR` resolved it.
3. Puppeteer diagnostics originally returned live arrays in the exploratory
   harness; changed to a cloned observation before recorded runs so later events
   could not mutate earlier evidence. This was a harness correction, not a browser
   controller bug.

## What this does not settle

- No actual model independently diagnosed or fixed the fixture. The fix was
  controlled harness input, not a claim of agent usefulness.
- No Casper application integration, end-to-end permission classifier, managed
  development-server startup or browser evidence persistence is implemented here.
- No blanket claim about sensitive-data redaction from these synthetic diagnostics.
- No adverse-network stress suite, permission-token attack test, rich SPA/shadow DOM
  coverage or universal frontend/layout correctness.
- No browser-provider production installation is authorized by this report itself.

## Reproduction and permanent evidence

Exploratory scripts (not production modules/tests):

- [`browser-compare.mjs`](browser-compare.mjs)
- [`browser-policy-probe.mjs`](browser-policy-probe.mjs)

On this platform, first install the exact packages above **into an isolated directory**
with `--ignore-scripts`, make the packaged native agent-browser binary executable,
then run:

```sh
node docs/benchmarks/browser-compare.mjs /path/to/isolated-packages 3
BROWSER_COMPARE_CRASH=1 node docs/benchmarks/browser-compare.mjs /path/to/isolated-packages 1
BROWSER_COMPARE_CRASH=1 bun docs/benchmarks/browser-compare.mjs /path/to/isolated-packages 1
node docs/benchmarks/browser-policy-probe.mjs /path/to/isolated-packages
```

Scripts currently target this Mac's Chrome/native-binary/Node executable paths.
They write a `results.json` or `policy-probe.json` to the isolated directory. Archive
results between invocations because the output name is reused. Scenario failures
are recorded as `passed: false`; the exploratory process exit alone is not the gate.
No code invokes browser installation or a global cleanup command.

Saved evidence:

- [Node graceful](browser-comparison/node-graceful.json)
- [Node browser crash](browser-comparison/node-browser-crash.json)
- [Bun browser crash](browser-comparison/bun-browser-crash.json)
- [Native action confirmation](browser-comparison/agent-confirmation.json)
- [Initial setup failures](browser-comparison/setup-failures.json)

Raw evidence contains only synthetic fixture content and local paths/process
metadata. Original logs/profiles remain in the temporary comparison directory and
may disappear; the permanent JSON and representative images above preserve results.
