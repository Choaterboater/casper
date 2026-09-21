# Multi-provider login — inspection and proposed scope

## Status

The user approved the full four-provider scope, including browser OAuth, and
requested completion followed by Phase 10. Implementation and offline validation
are recorded in [MULTI_PROVIDER_LOGIN_REVIEW.md](MULTI_PROVIDER_LOGIN_REVIEW.md).
The inspection below preceded implementation; it performed no credential changes,
login/model requests or browser launch. Public GitHub source was fetched into
`/tmp/casper-provider-research/`; installed dependency source was read locally.
No background-agent tool was available, so this is same-agent research.

Casper pins Pi coding-agent **0.85.1**. OMP source was inspected at upstream main
commit **d716bcf60ab0a2e7ece1fdf382c0d143fef1f307**, not assumed to match the
installed compiled `~/.local/bin/omp`. No installed OMP process was disturbed.

## OMP behavior worth borrowing

- One provider chooser, keyboard navigation, scrolling, provider availability and
  credential-source labels. Search activates when the list exceeds visible rows.
  Optional auth validation is separate from mere credential presence. [O1]
- Login temporarily replaces the editor, supports cancellation, provider prompts,
  masked secret entry and manual callback entry. A new input instance prevents
  recovering previous secrets through undo/yank. [O2]
- Completion refreshes the authenticated provider and restores the editor. [O3]

Do not copy OMP wholesale: its dialog automatically opens a browser, renders OSC
links and provider progress, and its controller displays raw failure messages and
performs an online catalog refresh. Those are not Casper's current guarantees.
OMP's credential/account machinery is also different from Pi's one-entry-per-provider
store. [O1–O3, P3]

## Actual pinned Pi support

| Provider | Supported methods | Important behavior |
| --- | --- | --- |
| OpenAI Codex | Browser OAuth or device code | Retain Casper's existing device-code selection; no need to add browser mode. [C1] |
| GitHub Copilot | OAuth device code | Initially asks for an optional Enterprise domain. Then obtains GitHub/Copilot tokens, fetches account models and **can POST model-policy enablement** for unconfigured models. Not just local credential storage. [P4] |
| Anthropic / Claude | API key or Claude Pro/Max browser OAuth | OAuth binds a callback server on port 53692 and races it against manual code/redirect input. Pinned docs say third-party harness usage is billed per token through extra usage, not plan limits; this is a documentation claim, not live account verification. [P5, P8] |
| OpenRouter | API key or browser PKCE authorization | OAuth binds an ephemeral callback port and supports manual input; it mints a permanent user-controlled API key billed from OpenRouter credits, represented by Pi as an OAuth credential. Not a subscription token or free usage. [P6, P8] |

`ModelRuntime.login(providerId, "api_key" | "oauth", interaction)` provides the
shared entry point. Typed prompts include `secret`, `text`, `select`, and
`manual_code`; notifications include `auth_url` and `device_code`. Whole-flow and
per-prompt abort signals both matter. Pi should continue owning transport, token
refresh and serialized persistence. [P1–P3]

A credential commit can precede local synchronization failure. Preserve the current
`saved-needs-refresh` handling and never blindly repeat login. Selecting a new auth
method replaces the same provider entry, not an additional account. [P1, P3, C1]

## Recommended implementation scope

One Casper-owned `/login` chooser with these four providers and Cancel, plus exact
`/login <provider-id>` shortcuts. Method chooser for Claude and OpenRouter:

- **OpenAI Codex:** device code (existing).
- **GitHub Copilot:** device code on github.com; defer custom Enterprise hosts.
- **Anthropic / Claude:** API key or browser sign-in, with extra-usage disclosure.
- **OpenRouter:** API key or browser sign-in, with credit-billing disclosure.

Keep shared `<getAgentDir()>/auth.json`, fresh provider/method-specific consent,
provider-scoped replacement and unchanged model/default/conversation. Opening the
chooser must remain local, lazy and non-mutating. Do not label stored credentials
as verified connectivity. No automatic browser launch, model request, online
post-login catalog refresh, logout, migration, multi-account support or dependency
change.

Implement in two acceptance increments under that agreed scope:

1. Four-provider chooser, Copilot device flow and masked API-key entry for Claude
   and OpenRouter. Copilot consent must explicitly disclose Pi's possible account
   model-policy changes; cancellation cannot undo remote changes. If that behavior
   is unacceptable, stop and reconsider rather than silently patching Pi transport.
2. Claude/OpenRouter browser authorization with validated URLs, loopback-only
   callbacks and private manual callback entry. If callback setup fails, report a
   safe failure, never silently switch method/provider. Reject unsafe
   `PI_OAUTH_CALLBACK_HOST` overrides before loading/invoking the OAuth module;
   Anthropic captures that setting at module initialization. [P5, P6]

### Secret-entry boundary

Keys and callback codes/URLs go only into a dedicated exclusive-input prompt—not
slash arguments, chat, editor history, task receipts or diagnostics. Mask input;
replace/discard prompt state after each step. Permit paste only in that prompt,
with explicit submission and bounds; discard pretyped/buffered data at transitions.
Never accept account passwords. Keep raw-output logging refusal and plain-terminal
guidance-only behavior. JS strings cannot promise secure memory erasure.

Pi auth key values support shell-command and environment expressions. Secret entry
must accept literal keys only: reject executable/interpolated config syntax or
encode it using Pi's documented literal escaping, with regression coverage. Do not
turn a pasted key into a credential-resolution command. [P8]

### Tests required before calling it shipped

- Existing Codex, model picker, editor, fresh consent and stale-auth regressions.
- Real PTYs for provider/method selection, masked keys and callback pastes,
  split bracketed paste, no output/history leakage, draft/cursor restoration,
  cancellation/EOF/SIGTERM, NO_COLOR and plain-mode refusal.
- Actual pinned provider paths with intercepted synthetic transport: Copilot
  issuance/poll/token/catalog/policy endpoints, both OAuth callback races, API-key
  persistence, expired/denied/malformed responses and unexpected prompts/URLs.
- Loopback callback lifecycle and cancellation, occupied-port failure, unsafe host
  rejection, late callbacks and per-prompt abort when browser completion wins.
- Isolated file-store preservation, destination safety, provider-specific active
  parent refresh, unchanged model/default/session and committed/uncertain outcomes.
- Serial isolated full gate and scoped Standards/Spec review. No personal account
  trial is implied by this scope.

## Sources

OMP immutable upstream links:

- [O1: provider chooser](https://github.com/can1357/oh-my-pi/blob/d716bcf60ab0a2e7ece1fdf382c0d143fef1f307/packages/tui/src/overlays/oauth-selector.ts)
- [O2: login dialog](https://github.com/can1357/oh-my-pi/blob/d716bcf60ab0a2e7ece1fdf382c0d143fef1f307/packages/tui/src/overlays/login-dialog.ts)
- [O3: selector controller](https://github.com/can1357/oh-my-pi/blob/d716bcf60ab0a2e7ece1fdf382c0d143fef1f307/packages/coding-agent/src/modes/controllers/selector-controller.ts), `#handleOAuthLogin`.

Pinned local primary sources (paths relative to `node_modules/@earendil-works/`):

- P1: `pi-coding-agent/docs/sdk.md`, API Keys and OAuth.
- P2: `pi-coding-agent/examples/sdk/09-api-keys-and-oauth.ts` (read, not executed).
- P3: `pi-ai/dist/auth/types.d.ts`, `AuthInteraction`, `CredentialStore`, `AuthType`.
- P4: `pi-ai/dist/auth/oauth/github-copilot.js`, `loginGitHubCopilot`, `enableGitHubCopilotModels`.
- P5: `pi-ai/dist/providers/anthropic.js`, `pi-ai/dist/auth/oauth/anthropic.js`.
- P6: `pi-ai/dist/providers/openrouter.js`, `pi-ai/dist/auth/oauth/openrouter.js`.
- P7: `pi-ai/dist/auth/helpers.js`, `envApiKeyAuth` (secret prompt, no remote key validation).
- P8: `pi-coding-agent/docs/providers.md`, subscriptions, OpenRouter and key resolution.
- C1: Casper `src/runtime/pi-auth.ts`, `src/tui/login.ts`, `docs/LOGIN_PLAN.md`.

Remaining uncertainty: source support is not proof of provider account eligibility,
current commercial terms or live interoperability. Existing callback cancellation
behavior needs synthetic tests before adopting it. No independent review occurred.
