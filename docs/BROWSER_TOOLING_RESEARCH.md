# Browser tooling for Casper: broader comparison

Research snapshot: **2026-09-20**. Design input, not a dependency decision.

**Follow-up:** the user subsequently approved a local comparison. See
[executed comparison](benchmarks/BROWSER_COMPARISON.md) for 15 fixture runs,
confirmation and cleanup evidence, limits, and the resulting recommendation of
Puppeteer for Casper's core controller. The no-install/no-benchmark statements
below describe this earlier research stage, not that subsequent experiment.
The later “do it then and continue” authorization selected pinned
`puppeteer-core@25.11.0` for Phase 10A. See [BROWSER.md](BROWSER.md) and
[PHASE10_REVIEW.md](PHASE10_REVIEW.md) for the actual integration and release gate.

## Scope and confidence

Primary-source survey of **16 alternatives plus OMP's actual implementation**.
Sources are official repositories, official documentation and publisher package
metadata. Repository links below are pinned to inspected revisions. Published
package versions were checked separately: a main-branch README is not proof a
feature ships in a release. Chrome DevTools' key configuration and tools were
also checked at the published package's `gitHead`.

No packages installed, browsers launched, personal profiles accessed, model calls
made, or benchmarks run. No background-agent tool exists in this harness, so the
research was performed directly rather than delegated. Product claims about
speed, token savings and success rates are not Casper measurements.

## Executive recommendation

**Do not approve `playwright-core` solely because it is familiar.** There are two
real decisions: which browser controller to use, and how much ready-made agent
workflow to reuse. A CLI, MCP server, automation library and hosted browser service
are not interchangeable layers.

My revised recommendation is a bounded comparison of:

1. **Chrome DevTools MCP** — first reuse candidate for browser debugging. Existing
   tools cover interactions, console/network inspection, screenshots and performance
   analysis. Casper already owns an MCP broker. [C1][C2][K1]
2. **agent-browser** — strongest alternative to evaluate for an agent-oriented
   command interface: refs, snapshots, JSON output, screenshot/snapshot diffs,
   policy options and a native daemon. Its broad surface needs deliberate
   restriction and lifecycle integration, not blind CLI forwarding. [A1][A2]
3. **A direct library baseline: Puppeteer or Playwright** — more Casper integration
   work, but direct control over task lifetime, bounded outputs and replayable
   assertions. Puppeteer is particularly relevant because OMP actually uses it;
   Playwright is especially relevant if cross-engine testing becomes a requirement.
   Neither is proven better on Casper workloads yet. [P1][P2][W1][O1]

**Playwright CLI is also credible**, especially if adopting a skill-driven shell
workflow instead of a Casper-owned tool. Keep it in the comparison if we choose
that interface; do not conflate it with installing the Playwright library. [W3]

No final winner is justified without the small local acceptance comparison below.
Do not install all surveyed products or build a multi-provider framework first.

## Casper's requirements and existing constraints

Agreed scope is local functional and layout debugging, disposable profiles,
ordinary external resources allowed, approval for consequential or uncertain
external actions, and reproduction-based evidence plus repository checks.
Aesthetic redesign, personal authenticated sessions and cloud deployment are not
the initial slice. [K0]

Two important integration facts change the cost comparison:

- Casper's MCP result normalizer **omits image/audio payloads**, and its custom
  runtime tool interface currently returns text. Connecting a screenshot-capable
  MCP server therefore does not automatically show screenshots to Casper's model.
  A bounded image/artifact handoff or an explicit image-reading route needs real
  testing. A saved path is not proof the model saw the screenshot. [K2][K3]
- The broker asks for confirmation for every classified non-read call. That is not
  the agreed automatic local synthetic-interaction workflow. Any browser-specific
  task authorization must be narrow; do not make all MCP writes automatically
  authorized. Server annotations cannot establish the real-world effects of a
  page interaction. [K1][K0]

These gaps exist regardless of how impressive an upstream browser demo looks.

## Breadth survey

The capability descriptions below come from the linked primary sources. The
**Casper assessment column is engineering judgment**, not a benchmark ranking.

| Candidate | Layer and documented capabilities | Casper assessment |
| --- | --- | --- |
| **Playwright library / Test** | Chromium, Firefox and WebKit automation; locators, contexts, network interception; separate Test runner offers web-first assertions/traces. Installed Chrome/Edge channels supported. [W1][W2] | Strong direct-library candidate for repeatable checks and future cross-engine coverage. Do not import the whole Test runner into Casper just to drive a page. Browser/context control still needs a Casper tool, consent and evidence implementation. |
| **Puppeteer / puppeteer-core** | JavaScript control of Chrome and Firefox via CDP/BiDi; locators, screenshots and isolated browser contexts. `puppeteer-core` does not download Chrome and ignores Puppeteer configuration files/environment configuration. [P1][P2][P3] | Strong direct-library candidate for the current installed-Chrome scope and close to OMP's approach. Do not dismiss it as Chrome-only. Installed-browser compatibility still needs testing. |
| **Chrome DevTools MCP** | Puppeteer-based MCP and CLI; interaction, accessibility snapshots, console/network inspection, screenshots, emulation, performance traces. Officially supports Chrome/Chrome for Testing, not every Chromium derivative. [C1][C2] | First reuse candidate for debugging. Configurable isolation/telemetry and existing Casper MCP transport are useful, but consent, image handling, artifact bounds and cleanup remain integration work. |
| **agent-browser** | Native Rust CLI/daemon using direct CDP; refs, semantic selectors, JSON observations, screenshots/diffs, console/network tools, optional action policy/confirmation, MCP surface. Existing Chrome can be used. [A1][A2] | Serious agent-workflow alternative, not just another wrapper around Playwright in this inspected version. Need to contain persistent daemon lifetime, configuration discovery, eval/auth/plugins and session reuse. |
| **Playwright CLI** | Agent-oriented CLI/skills, element refs, screenshots, console/network commands and named sessions. Profile is in memory by default; headless sessions idle out after an hour. [W3] | Potentially less custom tool code, but Casper must own session selection and cleanup. Never use broad `close-all`/`kill-all` in a shared user environment. Upstream token-efficiency claims need measurement with Casper's already-selective broker. |
| **Playwright MCP** | Accessibility-snapshot-driven MCP automation; isolated mode available, persistent profile is default; screenshots and other browser tools. [W4] | Viable reuse alternative to Chrome DevTools, particularly for Playwright workflows. Not automatically cheaper than CLI, nor automatically a consent/security solution. |
| **Selenium / WebDriver** | Standards-oriented browser automation infrastructure across major browsers. [S1] | Valuable if real browser/vendor coverage, especially a WebDriver ecosystem, is central. Casper would still build the agent observations, tool interface and evidence workflow. No blanket claim that Selenium requires a remote Java server. |
| **WebdriverIO** | Node framework with WebDriver/BiDi and Appium, browser/unit/component tests and local/cloud runners. [S2] | Attractive if browser plus mobile testing is the priority. Broader testing infrastructure than the first local browser tool needs; use existing project suites rather than replace them. |
| **Cypress** | Browser testing product with local installation and project test workflows. [S3] | Good existing-project verification target. Not my first choice for embedding a general agent browser session inside Casper; adopting a second test framework is not required for this feature. |
| **Stagehand** | SDK with model-backed `act`, `observe` and structured `extract`; local-browser and model configuration demonstrated. [G1] | Useful for natural-language automation, but another model-mediated action layer adds consent, cost and evaluation questions when Casper already plans actions. Not inherently cloud-only. |
| **Browser Use** | Distinguishes hosted agent service, CLI for existing agents and open-source agent library with local/cloud browsers. [G2] | Evaluate the specific product, not the brand. The full agent library duplicates part of Casper's orchestration; the CLI can be a different proposition. No requirement to use its hosted model should be inferred from the brand. |
| **Browser Harness** | Browser Use's separate harness connects an LLM to a real browser through CDP; editable agent helpers, personal-browser setup and MCP tooling documented. [G3] | More relevant than the full Browser Use agent for an existing coding assistant, but the documented personal-browser workflow conflicts with our disposable-profile default. Needs a separately proven fresh-session configuration. |
| **Midscene** | Vision-driven GUI actions and assertions, web/mobile/desktop interfaces; integrates with Playwright/Puppeteer and uses configured models. [G4] | Worth revisiting for canvas/icon-heavy or non-DOM UI. Model-judged assertions cannot silently become deterministic verification evidence; extra model calls are outside the first no-live-model implementation gate. |
| **Lightpanda** | New Zig browser with JS/DOM/CDP/BiDi support; explicitly **no graphical rendering engine**. Documented PNG/PDF output is text-only rendering. [E1] | Not a replacement for Chrome when debugging real CSS layout or screenshots. Potential future extraction/automation optimization, not this slice's visual oracle. Upstream speed claims are not relevant proof of layout fidelity. |
| **Browserless** | Browser service with local Docker or hosted offerings, queueing/session tooling, connects through Puppeteer/Playwright. SSPL or commercial license. [H1][H2] | Infrastructure option for later concurrent/remote clients, not a replacement for the automation library or Casper's policy. Additional deployment/licensing review required. |
| **Steel** | Self-hosted/cloud browser API and UI; sessions, screenshots, request logging; Puppeteer/CDP underneath, Node and Docker local setup documented. Apache-2.0 license. [H3][H4] | Useful future browser infrastructure if we need a service. Extra API/server lifecycle for a task-local browser today; still needs an automation client. |

## What OMP actually does

At **OMP v18.2.6**, the package declares `puppeteer-core`; launch code imports it.
The browser facade adds observations/element refs, screenshots, interactions and
per-tab workers/lifecycle. Documentation distinguishes owned headless tabs from
attached/relay user browsers and exposes code execution through its Eval facade.
This is not evidence that OMP just installs Playwright MCP. [O1][O2][O3]

**Transferable design:** give the agent compact observations and real images,
refresh stale refs, and track owned versus attached resources. **Do not blindly
copy:** broad Eval authority, stealth patches, shared daemons, automatic browser
provisioning or personal-browser relay. Those are separate product decisions.
OMP's existing implementation is useful design evidence, not a comparative
reliability benchmark or permission to add OMP as a dependency. [O1][O2][K0]

## Finalist-specific caveats

### Chrome DevTools MCP

At the inspected published revision:

- `--isolated` is opt-in; its default profile persists in a tool-owned cache.
  `--auto-connect` is opt-in. Select an installed Chrome executable and a fresh
  isolated profile, not the user's existing browser. [C3]
- Usage statistics are on by default; performance tools can send trace URLs to
  CrUX. Disable both for our local acceptance comparison, along with update
  checks. This is separate from allowing ordinary website resources. [C1][C3]
- Sensitive-header redaction is opt-in and only covers some headers. Request
  bodies, URLs, screenshots and page text still need careful treatment; there is
  no general secret-detection guarantee. [C2][C3]
- Arbitrary page evaluation is enabled by default; it can be disabled. Disabling
  it also removes a route for measuring layout geometry, so the experiment must
  establish how narrow Casper-owned assertions work without granting the model
  unrestricted evaluation. `--slim` mainly exposes navigation, evaluation and
  screenshots; it is not automatically the safest or sufficient debugging mode.
  [C2][C3]
- Network/console lists support pagination but can return all entries if page
  size is omitted. Enforce limits before collection where possible; downstream
  truncation alone does not bound transport/process memory. [C2][K2]

### agent-browser

The inspected implementation uses a Rust daemon with direct CDP, not a required
Playwright daemon. The npm package declares Node >=24 and has a postinstall step;
its README distinguishes native-daemon requirements from building from source.
Do not equate “native binary” with zero packaging work on Bun. [A1][A2]

Security features are explicitly opt-in. Action categories and policies are useful
mechanisms, not proof that a page button is harmless. For Casper, explicitly select
a unique session/namespace, fresh state, bounded output and cleanup; do not import
personal profiles, restore auth, expose plugins or adopt an existing browser just
because those features are available. Default headless idle timeout is one hour,
which does not satisfy immediate Casper shutdown by itself. [A1]

### Direct libraries and Bun

The published packages declare Node engine requirements (see version snapshot
below). That is not proof of tested Bun compatibility. A direct Bun launch/close
and cancellation test is mandatory before choosing either library. Installed
Chrome auto-updates independently from a pinned controller, so successful launch,
selectors, screenshot and cleanup must be tested together. Playwright explicitly
supports installed Chrome/Edge channels; Puppeteer documents custom executable
selection while its bundled browser gives the strongest version pairing. [W2][P3]

## Published package snapshot — not an installation recommendation

Publisher registry metadata retrieved 2026-09-20; exact-version endpoints are linked.
Main-branch features elsewhere in this note must still be checked against any
chosen release. No package was downloaded for execution.

| Package | Published version observed | Declared Node engine |
| --- | --- | --- |
| [playwright-core](https://registry.npmjs.org/playwright-core/1.63.0) | 1.63.0 | >=20 |
| [puppeteer-core](https://registry.npmjs.org/puppeteer-core/25.11.0) | 25.11.0 | >=22.12.0 |
| [chrome-devtools-mcp](https://registry.npmjs.org/chrome-devtools-mcp/1.9.0) | 1.9.0 | ^20.19.0 or ^22.12.0 or >=23 |
| [agent-browser](https://registry.npmjs.org/agent-browser/0.38.1) | 0.38.1 | >=24 (package metadata) |
| [@playwright/cli](https://registry.npmjs.org/@playwright/cli/0.1.21) | 0.1.21 | >=18 |
| [@playwright/mcp](https://registry.npmjs.org/@playwright/mcp/0.0.82) | 0.0.82 | >=18 |

## Recommended next step: bounded local comparison

**Proposed, not performed or approved as an installation.** Compare Chrome DevTools
MCP and agent-browser against one direct-library baseline. Puppeteer is the
recommended baseline for the present Chrome-only scope; swap/add Playwright if
cross-engine coverage is the deciding requirement. Include Playwright CLI if a
shell/skill interface is preferred over a custom Casper tool.

Use the same disposable local fixtures and installed browser:

1. Broken button: observe failure, apply a controlled fixture fix, replay and prove
   the expected result. This can use a scripted agent without paid inference.
2. Mobile overflow: collect geometry and before/after screenshots at a fixed
   viewport; demonstrate the image reaches the intended consumer.
3. Console exception and failed HTTP request: preserve useful diagnostics while
   excluding fixture secrets and bounding output.
4. Ordinary external-resource behavior: confirm there is no blanket policy block;
   use two localhost fixture origins for deterministic tests, not production data.
5. Consent: local synthetic interactions proceed under task authorization;
   consequential/uncertain actions cannot execute after denial or cancellation.
6. Crash/timeout/shutdown: no owned browser/daemon/server survives; a separate
   control server remains alive. Do not use the user's existing website server.
7. Record startup time, response/output size, repeatability and integration code
   required. Distinguish cold/warm and package overhead from browser overhead.

**Decision rule:** prefer a ready-made controller if it satisfies the same evidence,
permission and lifecycle contract with less Casper code. Choose a direct library
if constraining the wrapper requires more complexity than building the narrow
interface. Reject a candidate that cannot reproduce visual layout faithfully or
whose cleanup/permission behavior cannot be made observable and testable.

No star-count ranking, invented speed comparison or promise of universal website
coverage. Browser execution remains capable of unintended external effects under
the agreed behavioral policy. The provider choice does not erase that limitation.

## Primary sources

### Local repository evidence (uncommitted working tree)

[K0]: PHASE10_PLAN.md
[K1]: ../src/capabilities/broker.ts
[K2]: ../src/capabilities/result.ts
[K3]: ../src/runtime/types.ts

- **K0:** [agreed product direction][K0].
- **K1:** [broker safety classification, confirmation, schema budgets and selective exposure][K1].
- **K2:** [bounded results and explicit binary omission][K2].
- **K3:** [text-returning custom tool interface][K3]; its concrete translation is in
  [`PiRuntime`](../src/runtime/pi.ts), which returns text content for these tools.

### Official repositories and documentation

[W1]: https://github.com/microsoft/playwright/blob/07f1a6154795f055f341b8972086533e8e48b36f/README.md
[W2]: https://github.com/microsoft/playwright/blob/1b025d7e20a026371cd5f98ba0cdce48892737c8/docs/src/browsers.md
[W3]: https://github.com/microsoft/playwright-cli/blob/74354ecc7a43da16d91a9bc54fa8db8283a3fcf5/README.md
[W4]: https://github.com/microsoft/playwright-mcp/blob/f1257a5a67aff872f947fae274759f7d54853862/README.md
[P1]: https://github.com/puppeteer/puppeteer/blob/5cf7e20998ab53ffa0a040d47f644eb82fa3e92a/README.md
[P2]: https://github.com/puppeteer/puppeteer/blob/5cf7e20998ab53ffa0a040d47f644eb82fa3e92a/docs/guides/browser-management.md
[P3]: https://github.com/puppeteer/puppeteer/blob/043cd46e594b39ea77343e221a59724183448059/docs/guides/configuration.md
[C1]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/1cec9cd1a3bbf1895c98fa4b4e0e2da5a36e4075/README.md
[C2]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/1cec9cd1a3bbf1895c98fa4b4e0e2da5a36e4075/docs/tool-reference.md
[C3]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/1cec9cd1a3bbf1895c98fa4b4e0e2da5a36e4075/docs/configuration.md
[A1]: https://github.com/vercel-labs/agent-browser/blob/44583ac8385d814ab98cbf40feec97620376b50e/README.md
[A2]: https://github.com/vercel-labs/agent-browser/blob/44583ac8385d814ab98cbf40feec97620376b50e/package.json
[S1]: https://github.com/SeleniumHQ/selenium/blob/e93424fe4b3199a77954936d8e5055bcc1cf9511/README.md
[S2]: https://github.com/webdriverio/webdriverio/blob/913a56140656f1b5a4e89993e78061e89f88c5d9/README.md
[S3]: https://github.com/cypress-io/cypress/blob/bbcd1ea26b9f1eb95a1a70ee13a6eaeb00466b54/README.md
[G1]: https://github.com/browserbase/stagehand/blob/ea2789ca56e8a7ee154850de37657823c98604f8/README.md
[G2]: https://github.com/browser-use/browser-use/blob/d8110c5ff87ccba887aaa726cdb780f2f84bef8d/README.md
[G3]: https://github.com/browser-use/browser-harness/blob/afbcc381b963040c19627d788e40c7e7663171ee/README.md
[G4]: https://github.com/web-infra-dev/midscene/blob/ea7e4dcf0a078918451b6e3fd4b0e83c87d15e06/README.md
[E1]: https://github.com/lightpanda-io/browser/blob/744bf768c8b0c1c6a368328f0f82fe2a1a9333a2/README.md
[H1]: https://github.com/browserless/browserless/blob/7d4bf6e86311f7db1cf54a36f23398a49cdda7b6/README.md
[H2]: https://github.com/browserless/browserless/blob/7d4bf6e86311f7db1cf54a36f23398a49cdda7b6/LICENSE
[H3]: https://github.com/steel-dev/steel-browser/blob/04f691d3e40677fefbebfc7fac2fcd92c3af4cb6/README.md
[H4]: https://github.com/steel-dev/steel-browser/blob/04f691d3e40677fefbebfc7fac2fcd92c3af4cb6/LICENSE
[O1]: https://github.com/can1357/oh-my-pi/blob/78b753124d11f8dd3ae73e2524125890ff7c977e/docs/tools/browser.md
[O2]: https://github.com/can1357/oh-my-pi/blob/78b753124d11f8dd3ae73e2524125890ff7c977e/packages/coding-agent/src/tools/browser/launch.ts
[O3]: https://github.com/can1357/oh-my-pi/blob/78b753124d11f8dd3ae73e2524125890ff7c977e/packages/coding-agent/package.json

Source downloads/metadata are in `/tmp/casper-browser-research` as temporary
inspection evidence; the pinned links above are the permanent references.
