# Phase 10A — browser-assisted debugging

**Status:** browser-first implementation authorized by “do it then and continue”
after the tooling comparison. Phase 10A is implemented and validated against real
local fixtures; the as-built contract and limitations are in [BROWSER.md](BROWSER.md).
See [PHASE10_REVIEW.md](PHASE10_REVIEW.md) for the release gate and coverage limitations.
See [PHASE10_PLAN.md](PHASE10_PLAN.md) for the conversation decisions.

The subsequent local DAP contract is also implemented; see [DEBUGGER.md](DEBUGGER.md)
and [PHASE10_DEBUGGER_REVIEW.md](PHASE10_DEBUGGER_REVIEW.md). Together they complete
the scoped Phase 10 debugging work; optional clients are not prerequisites.

## Problem Statement

Casper can edit code and run checks but cannot yet reproduce a website problem
in a managed real browser, inspect browser evidence, and replay the reported
failure after a fix. Users should not have to orchestrate those steps themselves.
A browser screenshot alone must not become a claim that a requested behavior works.

## Solution

Give Casper one browser-assisted debugging workflow for local projects. It uses
a disposable browser, interacts with synthetic test data, gathers bounded browser
and layout evidence, fixes code through existing tools, and replays an explicit
reproduction. Existing verification remains responsible for repository checks.
Ordinary external resources are allowed; consequential external actions need
human approval. Debugging is not an aesthetic redesign feature.

## User Stories

1. As a developer, I want Casper to reproduce a broken local interaction so that
   it fixes an observed failure rather than guessing.
2. As a developer, I want Casper to replay that interaction after an edit so that
   completion has observable evidence.
3. As a developer, I want console errors and failed network requests available
   on demand so that Casper can investigate causes.
4. As a developer, I want bounded page text and element inspection so that Casper
   can identify controls without dumping an entire page into context.
5. As a developer, I want navigation, clicks and synthetic input supported so
   that Casper can exercise real workflows.
6. As a developer, I want viewport-specific layout checks so that overflow and
   overlapping elements can be reproduced.
7. As a developer, I want screenshots tied to the observed URL and viewport so
   that visual evidence has context.
8. As a developer, I want screenshots distinguished from assertions so that
   visual inspection does not masquerade as passing verification.
9. As a developer, I want a fresh browser profile so that my personal sessions,
   saved passwords and browsing data are not reused.
10. As a developer, I want ordinary external resources to load so that testing
    remains representative of normal website use.
11. As a developer, I want approval before real-account access or consequential
    external actions so that a local page cannot silently authorize them.
12. As a developer, I want Casper to ask when effects are uncertain so that
    guessing cannot substitute for consent.
13. As a developer, I want local development servers started only for the
    requested trusted project so that debugging stays task-scoped.
14. As a developer, I want cancellation and shutdown to clean up Casper-owned
    browser/server processes while leaving unrelated processes alone.
15. As a developer, I want unavailable browsers and failed checks reported
    honestly rather than automatically installed or treated as success.
16. As a developer, I want relevant repository checks retained so that a browser
    replay does not replace typechecks, tests or existing verification policy.
17. As a developer, I want edits to invalidate earlier browser conclusions so
    that Casper cannot claim a fix based on pre-edit observations.
18. As a developer, I want ordinary startup to remain lazy so that non-browser
    tasks do not pay browser startup or discovery overhead.

## Implementation Decisions

### Existing behavior to preserve

- Casper owns trust, consent, task lifetime, workspace rebind and shutdown.
- The runtime-neutral custom-tool interface remains the model integration seam.
- Native editing and shell tools remain available. No new autonomous repair loop
  replaces or competes with the existing single post-primary repair owner.
- Browser evidence is separate from repository command verification and human
  acceptance. An overall success claim requires the actual reproduction and
  relevant checks, not tool execution alone.
- No personal browser profile, remote browser attachment, automatic download,
  unrelated process termination or production deployment.

### Selected browser implementation

The subsequent implementation authorization selected exact
`puppeteer-core@25.11.0`, installed with lifecycle scripts disabled. The prior
comparison alone was not production approval. See [browser tooling research](BROWSER_TOOLING_RESEARCH.md)
and [the executed comparison](benchmarks/BROWSER_COMPARISON.md) for the 15 fixture
runs and native confirmation probe. One backend is implemented; this does not
establish superiority over unbenchmarked Playwright. Chrome/Edge discovery uses
installed executables; no browser download is authorized.

The browser module should own lazy launch, fresh temporary profiles, bounded
observations, operation serialization, cancellation and cleanup. Its interface
should support explicit navigation, inspection, interaction, viewport changes,
screenshots and replayable assertions without exposing arbitrary protocol requests
or unrestricted page-script execution to the model.

Actions with known or uncertain consequential effects require fresh confirmation.
Normal resources and read-only browsing do not require blanket network blocking.
This is a behavioral permission policy, not network isolation or a guarantee that
arbitrary page scripts cannot cause side effects. Do not infer harmlessness solely
from a localhost origin or an HTTP method.

Final bounds, screenshot retention, supported assertions, consent semantics and
server lifecycle are documented in [BROWSER.md](BROWSER.md). The implementation
uses native image read rather than changing the runtime-neutral text tool-result
contract. No generalized cloud, debugger or plugin infrastructure was added.

## Testing Decisions

Approved public test interfaces used during implementation:

1. Casper's existing application/custom-tool interface: exercise browser requests,
   human approvals, workspace transitions, cancellation and returned task evidence.
   Use a scripted runtime, never a live model, for deterministic orchestration.
2. The browser module's public interface against a real installed browser and
   disposable localhost fixtures: demonstrate interaction/layout failures before
   fixes and passing replays afterward. No private-method tests or personal sites.

Prior art is the application's LSP, visualization, reference and verification
integration coverage and real CLI/PTY lifecycle tests. Use real browser behavior
for browser correctness; mocks cannot establish it. Tests must distinguish skipped
browser availability from passed acceptance and must use positive cleanup controls.
Typecheck regularly, run focused suites per ticket, then a serial isolated full
gate and separate Standards/Spec review. Independent reviewers are unavailable in
this harness; do not call same-agent passes independent sign-off.

## Out of Scope

DAP/breakpoint debugging, SDK/RPC/CasperCloud integration, remote collaboration,
personal authenticated browser sessions, aesthetic redesign acceptance, autonomous
production changes, browser installation, paid/live model trials, and commits or
pushes. These require separate work and, where applicable, permission.

## Further Notes

No issue tracker is configured. Implementation tickets are local files under
`.scratch/browser-debugging/issues/`, not remote issues. The skill setup command is `/setup-matt-pocock-skills` if tracker integration
is desired; it is not necessary to invent or access a remote tracker for this work.

The broad dirty working tree includes completed Phase 9/login work and unrelated
user projects. Keep those intact. The existing website server is not a test fixture
and must not be stopped or reused without explicit permission.
