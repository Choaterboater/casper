# Casper-owned login — bounded design and offline contract review

## Status and recommendation

**Historical Codex-only slice.** The subsequently approved four-provider expansion
is documented in [MULTI_PROVIDER_LOGIN_RESEARCH.md](MULTI_PROVIDER_LOGIN_RESEARCH.md)
and [MULTI_PROVIDER_LOGIN_REVIEW.md](MULTI_PROVIDER_LOGIN_REVIEW.md). Its private
key/callback prompts supersede the device-display-only restrictions below; shared
storage, fresh consent, exclusive ownership and safe diagnostics remain.

**Implemented locally; offline validation and scoped review complete.** The user
approved this provider, device-code-only and shared-store scope. See
[LOGIN_REVIEW.md](LOGIN_REVIEW.md) for the implementation, acceptance evidence,
review and remaining limits. No real login, browser launch, personal credential
operation or live provider trial was performed.

Casper now provides interactive OpenAI Codex device-code login using pinned Pi
**0.85.1** for OAuth and provider-scoped credential persistence. It retains the
existing credential location for this compatibility slice, discloses it before
login and requires fresh confirmation. Casper owns the workflow; Pi remains the
runtime. Users no longer need to launch Pi's CLI for this supported login method.

## 1. Bounded user contract

- `/login` offers **OpenAI Codex — device code** and Cancel. Opening the chooser
  is local and does not start a model session, discover executable extensions,
  create an auth file or contact a provider.
- `/login openai-codex` skips the provider chooser, not consent. Show the resolved
  credential-file destination and explain replacement/shared use before starting.
- Fresh confirmation starts Pi's device-code flow. Display the provider's
  verification URL and one-time code, plus waiting/cancellation guidance.
  The human opens the URL; Casper does not launch a browser automatically.
- No account password, API key, token or redirect URL is entered into Casper in
  this slice. The auth display accepts only cancellation controls; unrelated
  input/pastes are discarded, not echoed, queued or retained in readline history.
- Escape/Ctrl-C cancels login and restores the draft, cursor and command history.
  EOF closes safely; SIGTERM uses the existing CLI shutdown policy. Restoring
  input must not turn buffered data into a command or a later approval.
- After a successful save, update any active parent's local auth snapshot and
  report the outcome. Keep the current conversation/model/default unchanged.
  A fresh conversation still requires `/model`; login does not choose one.
- Busy model/check/workspace work excludes login. Login excludes new prompts,
  model selection and workspace transitions; do not queue them for later.
- One-shot, redirected and `TERM=dumb` use remains guidance-only: no login, file
  creation, network access or consent from pipes. Unsupported providers and extra
  arguments get usage guidance without reflecting argument values or starting Pi.

This is deliberately not an all-provider login hub. Device-code unavailability,
expiry or provider refusal is a visible failure, not permission to fall back to
browser OAuth or a separately billed API provider.

## 2. Credential ownership — explicit compatibility policy

Use the same resolved `<getAgentDir()>/auth.json` that Casper currently consumes,
usually `~/.pi/agent/auth.json`, honoring the runtime's agent-directory override.
Do not read the user's real file during implementation/testing.

Suggested consent wording:

> Sign in to OpenAI Codex using a device code? Successful login will save or
> replace only the openai-codex credential at <resolved path>. This store is
> shared with Pi and Casper's existing parent/child/learning runtimes. Model
> choices and defaults will not change. Continue?

- Construct the writable ModelRuntime **after** consent: its default AuthStorage
  constructor can create an empty auth file even before `login()`.
- Reuse Pi's serialized provider-scoped writes. Preserve unrelated entries;
  do not replace the whole file, import tokens, migrate settings or copy another
  application's credentials. Replacing the selected provider is explicit.
- Preflight the destination as a regular, singly linked, owner-private file in
  real directories. Reject symlink/hardlink redirection and unsafe file modes
  without silently repairing permissions. New files use Pi's owner-only creation
  mode. This preflight is non-atomic; it is not a filesystem sandbox.
- Pi uses locked file writes, not a promised crash-safe atomic transaction or
  rollback mechanism. Storage errors can leave an **unknown** save outcome;
  never tell the user credentials are unchanged without evidence.
- Existing environment/config credential sources retain their current precedence.
  No shared Pi model settings, Casper defaults, child model defaults or learning
  defaults change. A credential replacement can affect subsequent use by all
  consumers of that shared store; the consent must say so.

A wholly independent `~/.casper/auth.json` store is a reasonable later product
choice, but requires explicit import/fallback/refresh ownership and migration
policy. Do not add an implicit two-store overlay in this slice.

## 3. Reuse findings against the pinned runtime

The global installation is **0.86.1**; it was not treated as the installed Casper
contract. Both the global guidance and the **0.85.1** installed SDK/provider docs
were read, and implementation facts were checked against the pinned package.

Paths below are relative to `node_modules/@earendil-works/`:

| Evidence | Consequence |
| --- | --- |
| `pi-coding-agent/dist/core/model-runtime.d.ts` | Public `login(providerId, type, interaction)`, metadata listing, scoped local refresh and typed synchronization errors already exist. No legacy AuthStorage login API is needed. |
| `pi-ai/dist/auth/types.d.ts` | `AuthInteraction` carries a whole-flow signal, typed prompts/events and per-prompt signals. Credentials must not escape Casper's runtime adapter. |
| `pi-ai/dist/auth/oauth/openai-codex.js` | The pinned provider offers `browser` and `device_code`; the latter owns device issuance, polling, token exchange and a 15-minute polling window. Casper should not reproduce those algorithms. |
| `pi-coding-agent/dist/core/auth-storage.js` | Construction can create storage; writes lock and merge entries; reads can reload changes from another runtime; mode 0600 applies on creation, not repair of existing modes. |
| `pi-coding-agent/dist/core/model-runtime.js` | Credential mutation precedes local synchronization. `CredentialSynchronizationError` means the credential operation committed. Scoped `refresh({providers, allowNetwork:false})` refreshes that provider's availability. |
| `pi-coding-agent/dist/modes/interactive/components/login-dialog.js` | The stock dialog echoes submitted values, emits URL control sequences and automatically opens a browser. It cannot be reused unchanged for the proposed privacy/consent contract. |
| `src/tui/terminal.ts:modelPickerHost` | Existing exclusive input handoff preserves draft/cursor/history. Reuse its ownership mechanism rather than adding a competing readline instance. |
| `src/runtime/pi.ts`, `pi-models.ts`, `types.ts` | Runtime construction is lazy; model/session policy already has owners. Login must not create a conversation merely to access auth. |

Relevant documentation/examples: pinned `docs/sdk.md`, `docs/providers.md`,
`examples/sdk/09-api-keys-and-oauth.ts`; global `docs/tui.md` for rendering/ownership
principles. The SDK example was read, not executed: it uses default user storage.

### Provider and display restrictions

Use a dedicated, short-lived login ModelRuntime with `modelsPath:null`, no agent
session/resource loader/extensions, no model-network refresh, and the explicitly
consented auth path. This avoids treating an extension's replacement provider
as the built-in Codex login merely because its id matches.

The adapter answers only the pinned Codex method-selection prompt with
`device_code`, after the human has selected and confirmed that exact method.
Unexpected prompts fail closed; there is no generic text/secret/manual-code input
fallback. Do not invoke the browser method, bind its callback port, or honor its
callback-host override in this device-code-only implementation.

Display only validated device-code fields: the expected HTTPS verification URL
(`https://auth.openai.com/codex/device` in the pinned provider) and a bounded,
control-free user code. Reject changed/malformed destinations rather than
sanitizing a dangerous URL into a different usable one. No provider-originated
OSC links or automatic `open`/shell commands. Prefer fixed progress text over
forwarding raw provider messages.

Device codes are intentionally visible locally. Do not put them in model
messages, Pi session JSONL, task outcomes, normal command history or application
diagnostic logs. Screen recording/terminal scrollback cannot be made secret by
Casper. If the chosen renderer enables raw-output debug logging, refuse the flow
until that logging is disabled rather than promising unlogged output.

## 4. Module and seam design

Keep a small runtime-neutral interface, analogous to model selection:

```text
AgentRuntime.authenticate?({ provider, terminalHost, signal })
  -> saved (parent auth snapshot ready)
   | saved-needs-refresh
   | cancelled (credential effect none or unknown)
   | failed (safe reason code; credential effect none or unknown)
```

These are proposed outcomes, not new exported code. No result includes a key,
token, raw provider exception, authorization response or account identifier.

**Module:** an internal `src/runtime/pi-auth.ts` owns the allowlisted login flow,
consent/destination checks, interaction guards, SDK invocation, save classification
and safe diagnostics. Pi's ModelRuntime/storage are its implementation; do not
publish a generic provider framework or a second token-refresh implementation.
The true external provider has two justified adapters at its internal seam:
Pi's real provider and scripted offline provider behavior for tests. Local file
persistence is tested with real temporary files, not mocked JSON writes.

**Runtime owner:** `PiRuntime` exposes the optional operation before `start()` and
owns its lifetime. Retain a reference to the active parent catalog so a committed
login can refresh that provider locally. Refuse this capability on a read-only
child runtime. Do not expose it as a model-callable tool.

**App owner:** `CasperApp` keeps command exclusion, command abort and shutdown.
Factor only the lazy adapter acquisition needed to call auth before session
startup; preserve the existing shared construction/drain ownership. Do not call
`ensureRuntime()` unchanged if that creates an agent session or loads extensions.
Do not add another independent app-level runtime factory/promise owner.

**Terminal owner:** reuse/extract the existing exclusive-input routine for the
model picker and auth display, preserving the model picker interface/behavior.
There are now two concrete uses, so shared input ownership earns its depth; a
whole terminal rewrite or general modal/router framework does not. Reuse Pi TUI
primitives only where they meet the contract; do not fork its login dialog.

**Model owner:** `PiModels` retains selection/default policy. A local auth refresh
must not select, save or fork a model. If auth committed but refresh failed, block
sending with the affected provider until local refresh succeeds or Casper is
restarted; expose the saved-but-stale state rather than showing a misleading
missing/ready snapshot. Other selections remain unchanged.

Candidate implementation files: `src/app.ts`, `src/runtime/{types,pi,pi-models}.ts`,
new internal `src/runtime/pi-auth.ts`, `src/tui/{terminal,help}.ts`, focused tests
and README. No dependency update or barrel export is required.

## 5. Cancellation, commit and error contract

1. Before consent: no writable runtime, remote operation or credential mutation.
2. After consent, before credential commit: caller cancellation and the auth
   lifetime signal gate callbacks. Late results cannot save or redraw a closed
   display. SDK cancellation alone does **not** prevent an arbitrary provider
   from invoking old notification callbacks: Casper must gate those too.
3. After credential commit: cancellation is not rollback. Handle exported
   `CredentialSynchronizationError` as **saved-needs-refresh**, even if the
   underlying cause is an abort. Never blindly retry login or delete credentials
   to pretend the earlier operation was cancelled unchanged.
4. Ordinary provider failures: show fixed safe failure categories, not raw
   `error.message`, nested causes, response bodies or serialized error objects.
   The typed synchronization error itself carries a credential object.
5. Storage failure with uncertain effects: explicitly report save outcome unknown;
   fail closed and require inspection/retry rather than claiming unchanged state.
   A bare AbortError is not universal proof of no write. Use effect `none` only
   when the stage is known to precede saving; otherwise report `unknown`.
6. Completion: refresh an already-active parent with
   `refresh({providers:["openai-codex"], allowNetwork:false, signal})`, checking both
   `aborted` and returned errors. This is local availability, not a model request
   or credential-validity guarantee. Configured provider resolution in the normal
   parent runtime retains its existing executable-config caveat.
7. Bound login with the provider's 15-minute device window and a caller-owned
   abort deadline covering initial issuance as well as polling. This is an auth
   operation limit, not a coding-task countdown. All waits must observe disposal;
   retain the existing one-second CLI forced-shutdown deadline.

Token refresh remains Pi's request-time responsibility. No model prompt is sent
as a login health check. Remote issuance/revocation is not transactional with local
storage; cancellation cannot promise that the provider saw no request.

## 6. Offline evidence obtained in this design phase

A throwaway typed probe exercised the **actual pinned ModelRuntime** with synthetic
provider behavior, in-memory credentials and a temporary auth file. `fetch` was
replaced with a failing guard; its invocation count was **zero**. No actual OAuth
provider login method, model stream, personal credential source or browser was
used. The environment was allowlisted with temporary HOME/TMPDIR and offline Pi
settings. The temp HOME's incidental macOS `Library` directory is not auth state.

**8 checks / 37 assertions passed**, followed by three clean repeats of the final
probe and a clean standalone TypeScript check:

- Codex OAuth metadata/catalog access without creating Pi/Casper auth directories.
- Provider-scoped save, unrelated credential preservation and local availability.
- Pre-aborted login never calls the provider or writes a credential.
- Late provider completion after abort does not persist; raw late notifications
  still reach unguarded callbacks, confirming the adapter guard requirement.
- Abort immediately after a synthetic committed write yields the typed
  synchronization error and leaves the credential saved.
- A failing local catalog refresh leaves credentials saved; a local retry works
  without calling login again.
- Another runtime's auth snapshot stays stale until explicit local refresh.
- Two concurrent provider saves through the real file store preserve both entries;
  a newly created auth file is mode 0600.

The first probe attempt had two harness faults (assuming an entirely empty HOME
and eagerly attaching a rejection matcher before releasing a test operation),
plus an over-broad TypeScript fixture return type caught separately. They were
corrected in the throwaway probe; no SDK/product correction is claimed.

Artifacts: `/tmp/casper-login-design.fxIQY7/probes/auth-contract.test.ts` and
`logs/auth-contract-{03,04,05}.log`, with the final standalone typecheck log.
Temporary artifacts may disappear. This evidence validates SDK assumptions, not
Casper's unimplemented UI, actual Codex polling/exchange or provider eligibility.

## 7. Implementation sequence and stop conditions

Completed in order; implementation evidence is recorded in the review. Each step
stayed in this scope and required its preceding acceptance cases:

1. Add app/runtime characterizations: local `/login` listing/plain-mode guidance,
   no session/extension/model start, exact provider validation, busy exclusion,
   fresh consent and cancellation. Preserve existing `/model` and help behavior.
2. Implement the internal runtime module using scripted provider behavior at the
   external seam. Cover pre-save abort, late notifications, committed-save abort,
   save failure/unknown outcome, local refresh failure and unrelated-entry retention.
3. Add the exclusive device-code display and real PTY tests: cancel/EOF/SIGTERM,
   buffered input/paste disposal, restored draft/cursor/history, NO_COLOR, URL/code
   validation, hostile diagnostics and refusal with output logging/plain terminals.
4. Wire the actual pinned Codex device-code method under offline fixtures that
   intercept transport. Assert issuance/polling/exchange cancellation, expiry,
   pending/slow-down handling and no fallback to browser or another provider.
   Do not replace these tests with a live account trial.
5. Exercise fresh and already-started Casper runtimes, same-conversation auth
   refresh, stale-state blocking and unchanged model/default/branch selection.
6. Run the serial isolated gate and focused repeats, scoped diff review and
   preservation audit. No cleanup assertion/deadline weakening. Update help/README
   only when the command actually ships.

Stop and rescope rather than adding generic secret entry, browser callbacks,
custom provider login, logout/revocation, credential migration, OS keychain work,
model-role/default propagation, automatic browser launch, or live-provider trials.
Logout needs its own shared-store deletion and environment-fallback contract.
Independent Phase 9 review/promotion and Phase 10 remain separate.

## 8. Design review and preservation

The design review rejected direct reuse of the echoing login dialog, narrowed the
slice to device code, made the shared-store effect explicit, separated cancellation
from committed-but-unsynchronized outcomes, and required callback gating plus an
existing-parent refresh. The completed single-agent Standards/Spec review found
no issues in the bounded implementation; no independent reviewer was available.
See [LOGIN_REVIEW.md](LOGIN_REVIEW.md) for current validation and preservation
evidence. No commit, push or live-provider operation was performed.
