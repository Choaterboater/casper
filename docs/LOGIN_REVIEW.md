# Casper-owned `/login` implementation review

## Outcome

The bounded OpenAI Codex device-code slice in [LOGIN_PLAN.md](LOGIN_PLAN.md) is implemented locally and remains uncommitted. Casper now owns `/login` without opening Pi's CLI, accepting secrets, opening a browser, selecting a model, or creating an agent session merely to authenticate.

The command is interactive-terminal only. `/login` offers OpenAI Codex device code and Cancel; `/login openai-codex` skips that chooser but not fresh destination/replacement consent. Plain, redirected and `TERM=dumb` invocations remain guidance-only. Unsupported/extra arguments are rejected without application-level reflection of their values.

## Implementation

- `src/runtime/pi-auth.ts` owns the allowlisted built-in provider flow. It creates a short-lived pinned `ModelRuntime` only after consent, with `modelsPath:null`, no extensions/session/resource loader, no remote catalog refresh, and the resolved shared `<getAgentDir()>/auth.json`.
- The adapter answers only the exact pinned method prompt with `device_code`, accepts only the expected HTTPS verification URL and a bounded control-free code, gates late notifications, forwards no raw provider diagnostics, and classifies committed synchronization failures separately from cancellation.
- Existing auth destinations must be owner-private, singly linked regular files reached through real directories. Symlink/hardlink/unsafe-mode destinations fail without repair. Pi retains locked provider-scoped persistence and preserves unrelated entries. This preflight remains non-atomic, as documented.
- `src/tui/login.ts` borrows the terminal's existing exclusive-input owner. It does not echo or retain pasted/unrelated input, exposes only selection/consent/cancellation controls, restores the prior draft/cursor/history, and handles Escape, Ctrl-C, EOF and shutdown. An EOF hang found during PTY testing was corrected by pausing the lent input before readline ownership returns or closes.
- An existing parent refreshes `openai-codex` locally after a committed save without changing its model, branch, conversation or Casper default. A committed-but-unsynchronized or otherwise uncertain mutation marks that provider stale and blocks its generation/selection until refresh succeeds or Casper restarts.
- `PI_TUI_WRITE_LOG` refuses the flow before terminal/auth ownership. No credential, raw provider exception, account id or token crosses the runtime result boundary.

## Acceptance evidence

All auth/provider responses were synthetic. Tests used temporary HOME/TMPDIR, pinned Pi 0.85.1, `PI_OFFLINE=1`, an intercepted `fetch`, and no personal credential, browser, live OAuth endpoint or model generation.

Focused final login test: **9 tests / 48 assertions**, including:

- no auth/session creation before consent;
- the actual pinned Codex device issuance, polling and exchange code under intercepted transport;
- provider-scoped replacement and unrelated-entry preservation;
- active-parent local refresh with unchanged selection;
- committed save plus failed synchronization and stale-provider blocking;
- cancellation with late provider completion and no late persistence;
- hostile device-code display rejection and diagnostic non-disclosure;
- unsafe mode, hardlink and symlink rejection before transport;
- raw-output logging refusal;
- a production CLI in real PTYs for chooser/consent, paste disposal, URL/code display, 0600 creation, no session creation, draft/cursor/history restoration, Escape, EOF, SIGTERM-before-consent, color/NO_COLOR and `TERM=dumb`.

Three earlier implementation repeats also produced **9 tests / 48 assertions each**. After the shared PTY harness was finalized, `tests/terminal-ux.test.ts` plus `tests/model-selection.test.ts` passed **24 tests / 172 assertions**. Final standalone TypeScript was clean.

The isolated serial `bun run check` passed **450 tests / 4,876 assertions** across 36 files; test portion 149.78 s. That working-tree gate necessarily discovered the user's unrelated netcalc and website tests, so it is evidence that the complete current tree passed, not a review or ownership claim for those projects. The test-only CLI export present during that full gate was subsequently removed in favor of Bun's preload facility; the final source shape and SIGTERM/preload PTY additions were then covered by final TypeScript, login, and terminal/model runs above.

## Scoped review

Single-agent Standards review: **0 findings**. The change keeps provider policy in one internal auth module, terminal mechanics in one terminal module, model freshness with the existing model owner, and app-level command/lifetime exclusion with `CasperApp`. It adds no generic provider framework, token implementation, dependency, browser callback server, secret editor or second runtime-factory owner.

Single-agent Spec review against `LOGIN_PLAN.md`: **0 findings** in the approved first slice. The review checked consent timing, shared-store disclosure, built-in provider identity, device-only prompt restriction, display validation, cancellation/commit classification, parent refresh, stale blocking, model/default preservation, plain-mode behavior and no-session startup. No independent/subagent review was available; this is not Phase 9 promotion.

Preservation comparison against the 192-file pre-edit manifest found changes only in the scoped runtime/app/TUI/help/README/test files plus these new login files. The running tic-tac-toe server and unrelated netcalc, website, acceptance, benchmark, shutdown and planning work were not edited. `git diff --check` passed.

## Limits

No live provider eligibility, real account flow, token validity, model request, browser behavior or Windows terminal behavior was tested. Device codes remain visible in terminal scrollback. Filesystem preflight cannot prevent a concurrent path swap, and provider issuance/local persistence cannot be transactional. Browser OAuth, API keys, logout/revocation, credential migration, custom providers, automatic browser opening and child/learning model defaults remain out of scope.
