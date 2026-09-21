# Phase 10A — implementation and scoped review

## Current Phase 10 completion

Browser-first Phase 10A and the subsequently implemented local DAP workflow are
complete within their documented scopes. The latest isolated serial gate passes
**518 tests / 5,345 assertions**, TypeScript clean, including all 38 Phase 10 tests
with installed Chrome and debugpy available. See
[PHASE10_DEBUGGER_REVIEW.md](PHASE10_DEBUGGER_REVIEW.md) and [DEBUGGER.md](DEBUGGER.md).
CasperCloud is reference material only; optional richer clients are not prerequisites.
The browser-only review and historical validation below remain unchanged evidence.

## Historical revalidation after multi-provider login

The user subsequently requested completion of login followed by Phase 10. The
login increment's isolated serial gate passed **500 tests / 5,228 assertions**,
TypeScript clean, 236.60 s; all 20 existing Phase 10 tests ran against installed
Chrome (not skipped). Log: `/tmp/casper-multi-login-final.57YkDB/check.log`.
No browser source changed in that increment. This revalidates browser-first Phase
10A, not unimplemented DAP or optional richer-client features. The user clarified
that CasperCloud is a reference project only, not an integration deliverable.
See [MULTI_PROVIDER_LOGIN_REVIEW.md](MULTI_PROVIDER_LOGIN_REVIEW.md) for scope and
[PHASE10_PLAN.md](PHASE10_PLAN.md) for the remaining product decisions.

## Scope and validation

The user authorized the Puppeteer implementation after the executed comparison
(“do it then and continue”). This review covers `src/browser/`, the browser-specific
app/task/help changes, exact dependency addition, four Phase 10 test files and
browser documentation. Baseline HEAD remains
`d6e24836c1509188f3e298e8ca4caeb134cd031b`. Existing uncommitted login, Phase 9,
verification, user-project and benchmark work is not attributed to this phase.
Review used `git diff d6e2483 -- <tracked scoped files>` and direct reading of new
untracked files; there are no new commits and a three-dot commit diff would omit
this work. The package's existing `netcalc` addition was retained unchanged.

Final isolated serial gate: `bun run check`, **481 passed, 0 failed, 5,068
assertions**, 40 files, **188.36 seconds** test time. TypeScript passed.
Log: `/tmp/casper-phase10-complete.F0oAvy/check.log`.
The environment used a fresh HOME, TMPDIR and Pi directory, an allowlisted PATH,
offline/telemetry flags, and no inherited provider credentials.

The 20 Phase 10 tests account for 99 assertions in the final gate. Browser tests
ran against installed Chrome on this macOS host; they were not skipped. They
explicitly skip when their configured/default browser executable is absent, so
passing non-browser tests elsewhere does not establish browser acceptance.

Evidence includes:

- Real local Save + mobile overflow failure before a controlled source edit, then
  passing replay of the same ID/hash/viewport; later source changes mark it stale.
- Separate visibility/rectangle overlap coverage and unavailable freshness without
  declared inputs.
- Casper application/custom-tool end-to-end fixture, with owned development server,
  source edit callback, replay receipt, server teardown and stale tool rejection.
- A later ordinary task neither exposes the browser tool nor inherits its receipt.
- A real active browser is closed before a worktree destination is exposed; the
  application reports idle afterward, makes no model prompt, and preserves the
  unrelated fixture server. A positive PID control precedes the transition.
- Native screenshot `read` reaches actual Pi provider request image content using
  a local synthetic model-protocol server; this is not a paid/live model trial or
  proof that a model semantically understood the screenshot.
- Normal CLI exit and SIGTERM cleanup, with positive owned-process observations;
  module cancellation, browser crash, navigation timeout/recovery, port collision
  refusal, and preservation of unrelated fixture servers.
- Denied consequential actions have zero fixture effects; exact approval produces
  one effect. Synthetic local actions proceed without that approval.
- Missing executable, invalid arguments, owner-only screenshot modes, redirected
  artifact refusal and post-escaping output budget.

The existing tic-tac-toe process PID 56873 was preserved and checked separately.
No browser download, personal account/session, live provider, commit or push was
used. Temporary test repositories created by the existing suite are fixtures, not
commits to this working repository.

## Standards review

**No outstanding hard standard violations identified.** No repository-specific
CONTRIBUTING/CODING_STANDARDS/AGENTS/CONTEXT file was found in the inspected root
scope. The review also applied the skill's duplication, naming, data-clump,
responsibility and speculative-abstraction heuristics. The small public browser
facade owns its process/permission/evidence state, delegates process ownership and
scenario parsing, reuses secure artifact and workspace-input helpers, and leaves
native image delivery and the existing repair owner intact. The runtime-neutral
tool result interface was not expanded just for this provider.

This is a same-agent review, not independent sign-off. No sub-agent review tool
was available. No remote issue tracker was configured; tickets remain local.

## Spec review

The browser-first slice implements the agreed inspection, synthetic interaction,
replay, bounded artifact and lifecycle paths. Browser checks remain distinct from
repository verification and human acceptance. DAP, cloud/RPC, collaboration,
aesthetic acceptance and personal authenticated browsing remain deferred.

**No outstanding blocking spec findings identified.** The initially missing
combined real-browser/worktree-transition test was added and passed before the
final gate. It uses the public app seam, a real disposable browser and a temporary
Git worktree, with positive process and unrelated-server controls. All four local
browser-first tickets are now checked off; that does not complete the deferred
Phase 10 debugger/richer-client roadmap.

Other limitations are explicit product bounds, not acceptance claims:

- Selectors, four assertion types and one-second assertion polling are a first
  slice, not a replacement for all browser automation/framework APIs.
- Permission classification depends partly on model declarations and visible
  targets; arbitrary page/repository code is not sandboxed. Local origin alone
  never proves harmless effects. Server environment isolation is not filesystem
  credential isolation.
- Input fingerprints are bounded/non-atomic and cannot certify the served build,
  completeness of the declared scope or external state. Baseline-pass scenarios do
  not establish an observed regression. Screenshots are never assertion passes.
- macOS is exercised; Linux discovery exists but was not release-tested here.
  Windows, forced host SIGKILL/power-loss cleanup and detached/daemonized arbitrary
  project descendants are not guaranteed. No universal browser compatibility or
  live autonomous model-debugging claim is made.

## Corrections made during implementation/review

1. Multiline textarea fill initially replaced only the clicked paragraph. The real
   replay test failed, then passed after selecting the entire field before typing.
2. A killed browser initially retained ready status/pass evidence. A real process
   crash regression failed, then passed after disconnect handling closes the
   session and invalidates evidence. Cleanup also attempts the owned process group
   after its root exits, rather than assuming descendants have exited.
3. Terminal escaping expanded a nominally bounded response to **48,214 bytes**.
   The regression failed at the 16 KiB limit, then passed after measuring the
   delivered encoding and shrinking the bounded envelope as needed.
4. The first full gate found two existing interactive error-display regressions
   (**475 pass / 2 fail**, log `/tmp/casper-phase10-gate.QLqRWy/check.log`). Newly
   aborting the command controller in every `finally` made ordinary errors look
   cancelled. Removing that unconditional abort preserved explicit browser cleanup;
   both existing regressions then passed. No tests were weakened.
5. Review reproduced prior-task browser evidence leaking into a later ordinary
   task. The app regression failed, then passed after discarding closed browser
   state at the next model-task boundary. Final full gate was rerun afterward.

Fixture setup corrections (not production fixes): the Pi protocol fixture needed
Casper-owned model defaults plus the isolated catalog directory; screenshot paths
were parsed from their actual result shape; CLI prompts are positional. The
hanging-page fixture disables Bun's server idle timeout so it actually exercises
the browser's timeout instead of an early server-side close.

See [BROWSER.md](BROWSER.md) for the as-built contract and [PHASE10_SPEC.md](PHASE10_SPEC.md)
for the product requirements. All changes remain uncommitted.
