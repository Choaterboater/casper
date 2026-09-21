# Phase 10 — debugger and richer clients

## Current scope correction

The user clarified after the multi-provider login release that **CasperCloud is a
reference project only**. It is not a required client, dependency or integration
workstream. Useful ideas/code may inform Casper where justified; historical
CasperCloud integration statements below and in the complete plan are superseded.
The agent's request to select a CasperCloud integration was a scoping mistake,
not a reason to stop the user's already-authorized Phase 10 work.

**Scoped Phase 10 debugging work is complete:** browser-first Phase 10A plus the
local DAP workflow described in [DEBUGGER.md](DEBUGGER.md). The final isolated gate
passes **518 tests / 5,345 assertions**, TypeScript clean, including all 38 browser
and debugger tests. See [debugger review](PHASE10_DEBUGGER_REVIEW.md). Generic
SDK/RPC and conditional collaboration remain optional; they are not invented
completion prerequisites.

## Historical status

Planning started after the user requested “review then phase 10.” The fresh
Phase 9 review found and corrected one recovery-path symlink bug; the serial gate
passed 461 tests / 4,969 assertions with TypeScript clean. See
[PHASE9_REVIEW.md](PHASE9_REVIEW.md). Independent sign-off remains unavailable.

Update: the user subsequently authorized implementation after the comparison.
The browser-first Phase 10A slice is now implemented; see [BROWSER.md](BROWSER.md)
and [PHASE10_REVIEW.md](PHASE10_REVIEW.md). The broad roadmap below remains
historical planning, not a claim that DAP, richer clients or every later slice is
complete.

## Agreed product direction from the interview

The user wants general-purpose debugging across personal projects, including
websites in a real browser, rather than a DAP-only feature. They agreed:

- Given a reported problem, Casper should reproduce it, inspect relevant evidence,
  fix the code and rerun checks without requiring the human to direct every step.
  It should choose terminal, tests, browser or debugger as needed.
- During that requested local-project task, Casper may start development servers
  and use a disposable browser automatically.
- Ask before installing software, using personal browser sessions/accounts,
  accessing production or performing destructive changes. Preserve unrelated
  running processes.

These requirements informed the implemented behavioral permission policy; see
BROWSER.md for its limits. They are not a network sandbox or a guarantee against
unintended effects of arbitrary page/project code.
The user also agreed:

- First acceptance: reproduce a broken interaction in a local website using a
  real browser, fix the code, and demonstrate the interaction working. Retain
  existing terminal/test debugging; add breakpoint debugging when a concrete task
  needs it, rather than making DAP a prerequisite.
- Casper may navigate, click, type and submit forms with synthetic data in the
  disposable local test environment. Ask before actions affecting real accounts,
  sending messages, making purchases or modifying external data, even when the
  page is served from localhost.
- Completion requires the original reproduction to pass and relevant automated
  checks to pass, with tested behavior and remaining uncertainty reported.
  Screenshots support evidence but do not prove correctness by themselves.

For external services, the user chose ordinary external resources and read-only
browsing to be allowed rather than blocking all external network access. Require
approval for real-account access, purchases, messages or external data changes;
ask before acting when those effects are uncertain. This is a behavioral
permission policy, not a guarantee against unintended network effects. A
fresh browser profile does not itself make external requests harmless.

The user chose one browser workflow with evidence suited to the reported problem:

- Broken behavior: reproduce the interaction, inspect console/network errors,
  fix the code and replay the reproduction.
- Broken layout: reproduce at the affected viewport, inspect screenshots and
  element geometry, fix and compare measurable behavior.
- Aesthetic redesign is a design request, not a bug with an objectively passing
  test, and stays outside the initial acceptance gate.

Behavior and layout debugging belong in the first browser slice. Deeper debugger
capabilities should follow concrete needs that browser/test evidence cannot meet.
The interview led to the approved spec and completed browser-first tickets.
The DAP-first proposal below is historical exploration, not the selected
implementation order.

## Original roadmap and proposed sequence

1. **Local debugger/DAP workflow:** one explicitly configured, human-started
   debug session. First prove lifecycle, bounded inspection and cleanup.
2. **Optional local SDK/RPC interface:** if a concrete Casper workflow warrants it,
   expose task lifecycle while preserving policy, verification and consent.
   CasperCloud is reference material, not the required client or acceptance target.
3. **Richer browser verification:** explicit checks against a disposable local
   fixture with an isolated browser profile. Assertions are verification evidence;
   screenshots alone are not. Browser/dependency selection needs separate review.
4. **Collaborative/remote use:** conditional on a concrete workflow and an
   authentication/authorization design. No public listener or remote service yet.

Source: [complete plan, Phase 10](CASPER_COMPLETE_PLAN.md#phase-10--debugger-and-richer-clients).
The plan explicitly says to treat post-v1 features independently and justify their
complexity. Do not turn this roadmap into a plugin framework or rewrite CasperApp.

## Original first-slice proposal: local DAP launch and inspection

### Intended user outcome

A human can select a configured local debug target, consent to its exact execution,
observe a stop, inspect bounded stack/variable data, continue and stop the session.
Casper reports actual adapter/process state without calling debugging verification.
A normal coding session pays no debugger startup cost.

### Proposed scope to finalize before implementation

- One session and one local stdio adapter at a time; no attach-to-existing-process,
  TCP listener, remote adapter, automatic installation or automatic launch.
- Explicit configuration selecting executable, arguments and target working
  directory. Project configuration is untrusted input, not permission to execute.
  Consent must identify both adapter execution and the debuggee being launched.
- Lifecycle: idle, starting, running, stopped, closing, closed/failed. Distinguish
  adapter completion from confirmed debuggee cleanup; do not conflate them.
- Initially allow launch, source breakpoints, bounded stack/scopes/variables,
  continue and disconnect. Evaluation, variable mutation, memory access and
  arbitrary adapter requests stay outside the first slice.
- Debug values may contain secrets. No automatic model-context injection,
  persistent raw debug transcript or claim of secret detection. Inspection stays
  explicit; terminal output remains sanitized.
- EOF, cancellation, malformed messages, adapter death and shutdown must drain
  pending requests and clean up only owned processes. Never attach to or stop
  unrelated processes. Debuggee termination semantics must be proven with a
  fixture before advertising cleanup guarantees.

### Implementation approach

Start by checking pinned runtime capabilities and primary DAP documentation,
then study the OMP reference as requested by the complete plan. Do not assume
LSP's JSON-RPC framing/semantics implement DAP merely because both use stdio.
Do not add OMP as a runtime dependency or fork Pi.

Keep lifecycle, request correlation, message limits and process ownership inside
one deep debugger module with a small interface. CLI commands and tests should
cross that same interface. Introduce a production adapter only when a real local
fixture establishes the required behavior. Finalize request deadlines, byte/count
limits, capabilities and configuration precedence in the slice's contract before
writing production code.

Existing seams to evaluate, not automatically refactor:

- `src/app.ts`: command lifetime, trust, cancellation, workspace rebind, shutdown.
- `src/lsp/`: subprocess lifecycle and bounded protocol patterns to study, not a
  DAP transport to reuse without validation.
- `src/runtime/types.ts`: keep Pi implementation details out of Casper interfaces.
- Verification runner: retain existing evidence rules and the single repair owner.

### Acceptance gate

- Deterministic local fixture: initialize/launch, breakpoint stop, bounded stack
  and variables, continue, normal exit and explicit disconnect.
- Invalid configuration, denied consent and ordinary startup spawn nothing.
- Malformed/oversized messages, request timeout, duplicate/late replies and
  unsupported capabilities fail safely without unbounded output or stuck promises.
- Cancellation/shutdown kill and reap owned descendants; unrelated processes stay
  alive. Include positive controls so cleanup tests can detect broken cleanup.
- Terminal-control text is escaped; no raw debug values are injected into prompts.
- Existing terminal, login, model, workspace and verification behavior stays green.
- Typecheck, serial isolated full gate, scoped Standards/Spec review, honest
  independent-review limitation, documentation and handoff.

## Completion boundary

The user's requested login and scoped Phase 10 debugging work are complete.
The local DAP acceptance items above are implemented with a real installed debugpy
adapter and synthetic adversarial fixtures, including a corrected launch/cancellation
cleanup race. No independent reviewer was available. This is not a claim that
all adapters, Windows, autonomous breakpoint use, RPC or collaboration shipped.
Follow actual Casper usage next; do not reopen CasperCloud as an integration.
Paid/live model trials, personal credential use, dependency installation, commits
and pushes still require separate permission.
