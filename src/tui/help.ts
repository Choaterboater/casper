export const HELP_TEXT = `Casper — ask for a change, then inspect the evidence.

Start
  casper                  Start interactive mode
  casper <prompt>         Run one prompt and exit
  /login                  Provider sign-in or private API-key setup (interactive only)
  /model [model]          Pick a model; Enter saves globally, Ctrl+S is session-only
  /effort [auto|level]    Automatic or fixed reasoning effort; --session for temporary

Orient
  /status                 Model/auth, integrations and local storage
  /project                Project context and check commands
  /context, /usage        Context estimate, session tokens and cost availability
  /permissions            Actual tool and approval boundaries

Work and check
  /diff                   Tracked changes and untracked file names
  /verify [checks ...]    Run repository checks (trusted projects only)
  /browser                Disposable browser status and website inspection
  /debug                  Local debugger targets/status; explicit launch approval
  /skills                 Skill metadata and trust; /skills diagnostics for warnings

Manage the conversation
  /compact                Summarize context (sends a model request)
  /clear, /resume         Fresh conversation or list/resume a saved conversation
  /exit                   Exit
  /help all               Every command, option and safety detail

Type and navigate
  Type / for fuzzy command discovery; Tab completes commands and file paths (@).
  Shift+Enter (when supported) or Ctrl+J inserts a newline; Up/Down recalls history.
  Ctrl+L redraws the screen. See docs/TERMINAL_UX.md for limits.
  Enter during work retains your draft; it does not queue a request.

Cancel and approve
  Esc stops active work. Ctrl-C cancels work; idle Ctrl-C clears a draft or exits if empty.
  Native tools can execute code and edit files. Approvals require a fresh yes.
  Task completion is not verification.
`;

export const LOGIN_HELP = `1. Run casper in an interactive terminal (TERM other than dumb; output not redirected).
2. Run /login [openai-codex|github-copilot|anthropic|openrouter].
3. After login, choose a model with /model.

Methods
Codex/Copilot use device-code login; Claude/OpenRouter offer API key or browser sign-in.

Privacy and scope
Never paste passwords, tokens or API keys into chat. This guidance changes no credentials.
Login requires consent to the shared Pi/Casper auth store; it does not select a model.
Local credential availability is not a connection test.
`;

export const FULL_HELP_TEXT = `Casper — full command reference

Start from the shell
  casper                          Start interactive mode
  casper <prompt>                 Run one prompt and exit
  casper --version, -v            Print the installed version
  casper --licenses               Show bundled third-party license notices
  casper --help                   Show quick help

Authorize shell-invoked capabilities
  casper --verify ...             Authorize post-task checks and bounded repair
  casper --mcp <name>             Authorize/connect a configured MCP (repeatable)
  casper --lsp <name>             Authorize/start a language server (repeatable)

Choose a provider and model
  /login [provider]               Codex, Copilot, Anthropic or OpenRouter (shared auth store)
  /model [id or provider/id]      Pi picker; select and remember globally
  /model --session [model]        Select without changing the startup default
  /effort [auto|level] [--session]  Automatic or supported fixed effort; interactive chooser
  /model roles                   Inspect optional fast/build/reason/review mappings
  /model role <role> <selector|clear>  Save or remove an optional role mapping
  /model @role[:effort]           Select a configured role, optionally overriding effort

Inspect the current session
  /help, /help all                Quick help or this full reference (no model)
  /status                        Runtime model/auth and integration status
  /project                       Project context
  /context                       Estimated context and capability counts
  /usage                         Conversation and separate classifier tokens/cost estimates
  /permissions                   Explain enforcement, not change permission presets

Manage conversation context
  /compact [instructions]        Summarize context using the model (not local-only)
  /clear                         New conversation; no file rollback
  /resume [exact-session-id]     List/resume conversations in the current workspace
  /exit, /quit                    Exit interactive mode; no-op in one-shot mode

Inspect changes and run checks
  /diff                          Git status plus tracked diff against HEAD
  /verify [checks ...]           Run project checks without a model
  /verify repair [checks ...]    Run checks and authorize bounded repair
  /visualize                     Inspect providers and artifact settings
  /visualize repo [dir]          Render repository dependencies locally (no model)

Use skills
  /skills                        List skill metadata and trust
  /skills diagnostics             Inspect discovery/activation warnings
  /skills inspect <id>           Inspect a skill and its content digest
  /skills trust <id> <sha256>     Approve the exact reviewed skill content
  /skills block <id>             Prevent future skill injection

Connect integrations
  /mcp                           Redacted MCP status (no connection)
  /mcp connect <name>            Authorize this server for this process
  /mcp disconnect <name>         Disconnect and revoke process-local consent
  /lsp                           Language-server status (no startup)
  /lsp connect <name>            Authorize this language server for this process
  /lsp disconnect <name>         Stop this language server

Inspect a website
  /browser                       Local browser status (no model or browser startup)
  /browser open <url>            Open an HTTP(S) page in a disposable browser
  /browser inspect|diagnostics   Bounded observations, not verification
  /browser screenshot|close      Save a viewport PNG or close owned resources

Debug local code
  /debug                         Local DAP state and .casper/debug.json targets
  /debug start <target>          Fresh approval for adapter + debuggee execution
  /debug breakpoints <path> <lines|clear>  Replace one file's one-based line list
  /debug threads|stack <thread>  Explicit bounded thread/stack inspection
  /debug scopes <frame>          Inspect scopes using a returned frame handle
  /debug variables <handle>      Inspect values (may contain secrets)
  /debug continue <thread>|stop  Resume or terminate the launched debug session

Keep explicit project memory
  /memory                        List human-entered project facts
  /memory remember <fact>        Save an explicit project fact (no model)
  /memory forget <id>            Remove a fact
  /memory outcomes               Show the latest 20 task outcomes
  /memory accept <id> <yes|no>    Record human acceptance, not test evidence

Read reference projects
  /references                    List configured local reference sources
  /references search <id|*> <query>  Search reference text locally (no model)

Work in named workspaces
  /tree                          Named session/workspace branches
  /branch <name>                 Clone this Pi session (isolated by policy)
  /switch <branch>               Switch session/workspace (confirmation required)
  /switch main apply             Verify/review/apply candidate, then clean up
  /switch main discard           Review/discard candidate, then clean up
  /delegate <explorer|reviewer> <goal>  Bounded read-only subagent (uses a model)

Propose learning drafts
  casper learn <repo>             Propose inert drafts using a read-only model run
  casper learn list <repo>        List saved drafts locally (no model)
  casper learn inspect <repo> <id> Inspect a draft and its decisions locally
  casper learn promote <repo> <id> <sha256> <number> <disposition> [skill-name]
                                 Record one exact human promotion/ignore decision

Model selection and data sharing
/model: Enter selects and saves ~/.casper/settings.json; Ctrl+S is session-only.
Exact IDs are remembered too; /model --session <id> opts out. Shared Pi defaults are unchanged.
Optional advanced roles: fast, build, reason and review. No role setup is required.
Role selectors accept exact model IDs, provider/model IDs, @default or @role, optionally with :effort.
Aliases must resolve to a model; unknown, unconfigured or cyclic roles are rejected.
/model role <role> <selector|clear> saves/removes a mapping without changing the current model.
/model @role[:effort] selects that configured role; --session still opts out of saving the default.
Casper never switches model/provider based on prompt keywords.
/effort remembers auto or a supported fixed level per model; --session opts out.
A fixed level disables automatic classification. Auto needs no configured roles.
Auto makes one extra bounded, tool-free classifier call for each request: configured fast role,
otherwise the selected model. Only the current request is sent, not history, skills or diagnostics.
The classifier may use a different provider when fast is configured; the conversation stays on
the selected model. Classification has a 4-second deadline, then falls back to supported effort.
Status shows configured auto separately from actual effort, classification, fallback or unavailable.
Classifier tokens and estimated costs are separate in /usage; failed-request costs are unknown.
Esc/Ctrl-C cancel the picker. Plain/redirected terminals list models; use an exact ID to select.
Restored conversations retain their model; missing/unavailable selections block sending.
Without a restored selection or Casper default, choose with /model; no Pi-default fallback.
Switching provider sends subsequent conversation context to that provider.
The picker refreshes local catalogs only; selection does not generate a model response.
Provider-defined credential checks may execute configured key-resolution commands.

Context and conversation limits
Context is estimated and may be unavailable; cost estimates are not subscription billing.
/clear preserves saved conversations and workspace files.
/resume uses exact IDs; /switch uses workspace names.
Unknown slash commands are rejected locally, never sent to a model.

Verification meaning
Checks: typecheck lint test build (all by default).
Verification executes repository shell commands; use only in trusted projects.
One-shot checks exit 0 on command success, 1 on failure/blocked, 2 on skips/no commands.
Exit 0 does not certify current inputs or behavior; see scoped freshness in the receipt.

Exact approvals and terminal limits
MCP connection executes a configured program or contacts its URL. Review its source first.
Non-read MCP calls require exact interactive confirmation; denied in one-shot mode.
LSP connection executes a configured program. Review .casper/lsp.json first.
LSP rename requires exact interactive approval; one-shot rename is denied.
Cooked terminal input (TERM=dumb or redirected output) cannot grant exact approval.
Piped line input discards unfinished input at approval transitions; NO_COLOR is supported.

Browser scope and privacy
Browser tasks use installed Chrome/Chromium (CASPER_BROWSER_EXECUTABLE overrides detection).
No automatic browser installation, personal profiles, account credentials or arbitrary page scripts.
Synthetic local-project interactions may proceed; consequential/uncertain actions require fresh yes.
One-shot mode cannot grant those approvals. Ordinary external resources are allowed: not isolation.
Browser checks replay immutable scenarios; screenshots alone and model claims are not verification.
Task-owned development scripts run trusted project code, not a sandbox, and stop with the task.
Saved owner-only screenshots remain in external project state until manually removed; may be sensitive.
See docs/BROWSER.md for limits, input freshness, supported assertions and remaining caveats.

Workspace and subagent boundaries
Session branching/switching and worktree creation/removal require exact interactive approval.
Applying a worktree candidate leaves its reviewed diff uncommitted; Casper never commits or pushes it.
Worktree cleanup unregisters Git state and retains candidate files in a printed recovery directory.
Subagents get read/grep/find/ls only; no edit/write/bash/MCP/LSP or recursive delegation.
Limits: 2 concurrent, 4 delegations per parent prompt; 180 seconds/12 turns/48 tool calls per child.
Explorers use fast and reviewers use review when configured, otherwise Casper's default.
Children never use shared Pi defaults.
Reports are advisory; read-only tools are not an OS sandbox.

Learning boundaries
Learning uses Casper's default; source text may reach that provider. No secret detector.
Learning drafts are owner-only plaintext and inert. Promotion is a separate local,
digest-bound human command; it never asks the model to choose or approve.
Use local directories only; learn cannot be combined with --verify, --mcp or --lsp.
`;
