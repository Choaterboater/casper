# Multi-provider login — implementation and scoped review

## Status and contract

Implemented after the user approved the full proposal, including browser OAuth,
and asked to loop until complete before finishing Phase 10. This login increment
is complete; the separate Phase 10 roadmap is not completed by this work.

`/login` now offers:

- **OpenAI Codex:** existing device-code flow.
- **GitHub Copilot:** github.com device-code flow (not Enterprise hosts).
- **Anthropic / Claude:** API key or browser OAuth.
- **OpenRouter:** API key or browser PKCE authorization.

Exact `/login <provider-id>` skips only provider selection. Method choice and fresh
consent remain. Browser opening is manual. API keys and manual authorization
codes/redirects go only into a private, masked, exclusive-input prompt. Account
passwords, command-line secrets, arbitrary providers, automatic fallback, logout,
migration and multi-account support are not added.

Opening the chooser is local and creates no writable auth runtime. After consent,
Pi 0.85.1 owns auth transport, refresh and provider-scoped persistence in the same
resolved shared `auth.json`. No model/session is started merely for login. An
active parent's affected provider is refreshed locally, without changing model,
default, effort or conversation. Saved-but-unsynchronized and uncertain-save
outcomes retain their fail-closed semantics; never retry login blindly.

### Provider-specific disclosures

- Copilot's pinned login implementation can enable account model policies after
  fetching available models. Fresh consent explicitly discloses this remote side
  effect; cancellation cannot undo it.
- Pinned Pi docs describe Claude subscription auth as billed per-token extra usage,
  not plan limits. API keys use separately billed API access. No account eligibility
  or billing terms were validated live.
- OpenRouter browser authorization mints a permanent user-controlled API key billed
  from OpenRouter credits (represented by Pi as an OAuth credential).
- Browser flows start a temporary loopback callback listener. Unsafe callback-host
  overrides are refused before runtime/storage construction. Anthropic's fixed
  port is 53692; OpenRouter uses an ephemeral port. Port conflicts fail safely.

## Evidence

Final isolated serial `bun run check`: **500 pass / 0 fail / 5,228 assertions**,
41 files, **236.60 s**, TypeScript clean.
Log: `/tmp/casper-multi-login-final.57YkDB/check.log`.

Two subsequent focused repeats: **18 pass / 0 fail / 155 assertions** each,
28.75 s and 29.23 s. Logs:
`/tmp/casper-provider-research/login-repeat-{1,2}.log`.

The full gate used fresh HOME/TMPDIR/Pi directories, allowlisted PATH and offline
flags. Individual auth tests spawn isolated processes with synthetic credentials.
External provider transport is intercepted; OAuth callback tests use real local
HTTP listeners. No personal credentials, live authentication, paid model calls,
browser launches for login, dependency installations, commits or pushes occurred.
The full gate also ran existing disposable-browser tests against installed Chrome.

### Covered behavior

- Actual pinned Codex issuance/poll/exchange and Copilot device/token/catalog/policy
  paths, including positive observation of the synthetic model-policy POST.
- Actual pinned Anthropic/OpenRouter OAuth flows through both private manual input
  and real loopback callbacks, with listener-port reuse after completion/cancel.
- API-key persistence for both providers; unrelated entries preserved; no network
  needed to store an API key; no model session created for standalone login.
- Public runtime cancellation before consent, during polling and between UI steps;
  late completion cannot save. Hostile device fields are not rendered.
- Active Codex and non-Codex parent refresh, unchanged conversation selection,
  committed-save sync failure, stale-auth blocking and no blind retry.
- Unsafe file modes, symlinks/hardlinks, output logging, callback-host overrides,
  occupied callback ports and provider refusal fail safely. Raw provider errors,
  keys, tokens and submitted authorization codes never appear on screen.
- API-key expression syntax (`!` commands and `$` interpolation), multiline input,
  oversized unfinished paste and command-argument secrets are rejected safely.
- Real production CLI PTYs: all four providers, method selection, fresh consent,
  split bracketed secret paste without auto-submit, cancellation/EOF/SIGTERM,
  NO_COLOR, TERM=dumb, restored draft/cursor/history and no hidden-input leakage.

## Corrections and review

The API-key tracer test first failed with unsupported-provider output, then passed
with the extension. Copilot's first synthetic fixture named a model absent from
the pinned catalog, so it did not exercise policy enablement; the fixture now uses
an actual catalog model and asserts the POST. This was a fixture correction, not a
provider algorithm change.

A new oversized unfinished-paste regression hung until its subprocess deadline.
The display now caps received bytes per step at 32 KiB and cancels before feeding
more data into Pi's paste buffer. Private values are bounded to 8,192 characters;
API keys to 4,096. A separate regression reproduced cancellation during a selector
transition being mislabeled as failure. The transition now returns cancellation
without constructing storage. Both regressions passed after their fixes.

### Standards

No outstanding blocking findings in the bounded increment. Same-agent review only;
no background/independent reviewer tool was available. Review applied existing
runtime-neutral interfaces, ownership boundaries and code-review smell heuristics.
Pi retains provider algorithms/persistence. Casper owns consent, input, allowlists,
disclosures and safe outcomes. No new dependency, generic provider framework or
second token-refresh implementation was introduced. Shared private-input handling
serves API keys and manual codes without using the conversation editor's history.

### Spec

No outstanding blocking findings against the approved four-provider proposal in
[MULTI_PROVIDER_LOGIN_RESEARCH.md](MULTI_PROVIDER_LOGIN_RESEARCH.md). Device-code,
API-key and browser methods are explicit, not a fictional universal OAuth flow.
Local credential availability is not a connectivity check. No raw exception or
credential object crosses the app/runtime result boundary.

Baseline HEAD remains `d6e24836c1509188f3e298e8ca4caeb134cd031b`. Review compared
this session's bounded changes against the pre-edit inventory and directly read
new modules; a commit-only three-dot diff would omit the working-tree increment.
The hash audit found changes only in scoped login/app/types/help/tests/docs files.
Existing browser, verification, user projects, dependency pins and unrelated work
were preserved. `git diff --check` passed. No remote issue tracker is configured;
`/setup-matt-pocock-skills` is optional setup, not required for these local tests.

## Limits

- Synthetic transport proves local behavior, not provider eligibility, network
  interoperability, authorization-server changes or live billing terms.
- Native tools and auth destination preflight are not an OS/filesystem sandbox.
  File safety checks remain non-atomic. Stored credentials are shared with Pi and
  Casper's parent/child/learning runtimes.
- JavaScript strings cannot promise secure memory erasure. External terminal
  recording and process inspection are outside the masked-input guarantee.
  Authorization URLs/device codes intentionally remain visible locally.
- API-key entry accepts bounded printable ASCII literal keys, not secret-manager
  commands or environment expressions. Ordinary configured runtime credential
  resolution retains its separately documented behavior.
- No custom GitHub Enterprise domain, personal browser profile, automatic browser
  launch, logout/revocation, credential migration, live trial or Windows validation.
- Browser callbacks use Pi's listeners and cancellation lifecycle; these are not
  independently reimplemented or a universal guarantee under process SIGKILL.

## Phase 10 follow-through

Subsequent completion: the bounded local DAP workflow is now implemented and
validated alongside browser-first Phase 10A. See
[PHASE10_DEBUGGER_REVIEW.md](PHASE10_DEBUGGER_REVIEW.md): **518 tests / 5,345 assertions**,
TypeScript clean. CasperCloud remains reference material, not an integration gate.
The following paragraph records the earlier checkpoint, not an outstanding DAP gap.

The same final gate revalidated all 20 existing Phase 10A tests (not skipped),
including installed-browser reproduction/replay, screenshots as actual model image
content, worktree transitions and owned-process cleanup. No Phase 10 source changed.

The user's request to finish Phase 10 remains open. The concrete
`PHASE10_SPEC.md` covers the already-completed browser slice; DAP/breakpoint
debugging remains unimplemented. The user subsequently clarified that CasperCloud
is reference material only, not an integration deliverable. The agent's earlier
claim that CasperCloud client scope blocked completion was incorrect. Continue
the authorized Casper work without making reference projects or optional client
ideas completion prerequisites. Do not mark unimplemented features delivered or
install an arbitrary adapter merely to satisfy a historical roadmap.
