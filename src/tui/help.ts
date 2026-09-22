export const HELP_TEXT = `Casper — your coding companion

  casper                 Start interactive mode; offers casper_check unless --no-verify
  casper <prompt>        Run one prompt and exit; --verify offers casper_check
  /help all              All commands, options and safety details
  /status                Model/auth, integrations and local storage
  /model [model]         Pick a model; Enter remembers globally, Ctrl+S is session-only
  /effort [level]        Pick supported reasoning effort; --session for temporary
  /context, /usage       Context estimate, session tokens and cost availability
  /compact               Summarize context (sends a model request)
  /clear, /resume        Fresh conversation or list/resume a saved conversation
  /diff                  Current tracked changes and untracked file names
  /output [n]            Full retained output of the last task's n-th most recent tool call
  /permissions           Explain actual tool/approval boundaries
  /login                 Provider sign-in or private API-key setup (interactive only)
  /project               Project context and check commands
  /skills                Skills and trust; /skills diagnostics for warnings
  /verify [checks ...]   Run repository checks (trusted projects only)
  /browser               Disposable browser status; website tasks can reproduce bugs
  /debug                 Local debugger targets/status; explicit launch approval
  /exit, /quit           Exit

Type a request to work with the model. Native tools can execute code and edit files.
Type / for fuzzy command discovery; Tab completes commands and file paths (@).
Shift+Enter (when supported) or Ctrl+J inserts a newline; Up/Down recalls history.
Esc stops active work. Ctrl-C cancels work; idle, it clears a draft or exits if empty.
Ctrl+L redraws the screen. See docs/TERMINAL_UX.md for limits.
Enter during work retains your draft; it does not queue a request.
Approvals require a fresh yes. Task completion is not verification.
Interactive sessions offer the model a casper_check tool for trusted project checks;
nothing runs unless the model selects one. One-shot prompts need --verify.
`;

export const LOGIN_HELP = `Provider login requires an interactive Casper terminal.
Run casper, then /login [openai-codex|github-copilot|anthropic|openrouter].
Codex/Copilot use device-code login; Claude/OpenRouter offer API key or browser sign-in.
Use TERM other than dumb and output not redirected.
This guidance changes no credentials. Never paste passwords, tokens or API keys into chat.
Login requires consent to the shared Pi/Casper auth store; it does not select a model.
Use /model afterward. Local credential availability is not a connection test.
`;

export const FULL_HELP_TEXT = `Casper — your coding companion

Usage:
  casper               Start interactive mode
  casper <prompt>      Run one prompt and exit
  casper --version, -v Print the installed version and the path that is running
  casper learn <repo>  Propose inert learning drafts using a read-only model run
  casper learn list <repo>          List saved drafts locally (no model)
  casper learn inspect <repo> <id>  Inspect a draft and its decisions locally
  casper learn promote <repo> <id> <sha256> <number> <disposition> [skill-name]
                                  Record one exact human promotion/ignore decision
  casper --verify ...  Offer casper_check and bounded repair to a one-shot prompt
  casper --no-verify   Start interactive mode without casper_check
  casper --mcp <name>  Authorize and connect a configured MCP (repeatable)
  casper --lsp <name>  Authorize and start a configured language server (repeatable)
  casper --help        Show help

Local commands:
  /help, /help all                  Short help or this full reference (no model)
  /status                           Runtime model/auth and integration status
  /model [id or provider/id]        Pi picker; select and remember globally
  /model --session [model]          Select without changing the startup default
  /effort [level] [--session]       Supported reasoning levels; interactive chooser
  /context                          Estimated context and capability counts
  /usage                            Session tokens and optional catalog cost estimate
  /compact [instructions]           Summarize context using the model (not a local-only command)
  /clear                            New conversation; no file rollback
  /resume [exact-session-id]        List/resume conversations in the current workspace
  /diff                             Git status plus tracked diff against HEAD
  /output [n]                       Full bounded output of a recent tool call (1 = latest; last 20 retained per task)
  /permissions                      Explain enforcement, not change permission presets
  /login [provider]                 Codex, Copilot, Anthropic or OpenRouter (shared auth store)
  /project                          Show project context
  /memory                           List human-entered project facts
  /memory remember <fact>           Save an explicit project fact (no model)
  /memory forget <id>               Remove a fact
  /memory outcomes                  Show the latest 20 task outcomes
  /memory accept <id> <yes|no>      Record human acceptance, not test evidence
  /references                       List configured local reference sources
  /references search <id|*> <query> Search reference text locally (no model)
  /tree                             Show named session/workspace branches
  /branch <name>                    Clone this Pi session (isolated by policy)
  /switch <branch>                  Switch session and workspace (confirmation required)
  /switch main apply                Verify/review/apply candidate, then clean up
  /switch main discard              Review/discard candidate, then clean up
  /delegate <explorer|reviewer> <goal>  Run a bounded read-only subagent (uses a model)
  /skills                           List skill metadata and trust
  /skills diagnostics               Inspect discovery/activation warnings
  /skills inspect <id>              Inspect a skill and its content digest
  /skills trust <id> <sha256>       Approve the exact reviewed skill content
  /skills block <id>                Prevent future skill injection
  /mcp                              Show redacted MCP status (no connection)
  /mcp connect <name>               Authorize this server for this process
  /mcp disconnect <name>            Disconnect and revoke process-local consent
  /lsp                              Show language-server status (no startup)
  /lsp connect <name>               Authorize this language server for this process
  /lsp disconnect <name>            Stop this language server
  /browser                          Local browser status (no model or browser startup)
  /browser open <url>               Open an HTTP(S) page in a disposable browser
  /browser inspect|diagnostics      Bounded observations, not verification
  /browser screenshot|close         Save a viewport PNG or close owned resources
  /debug                            Local DAP state and .casper/debug.json targets
  /debug start <target>             Fresh approval for adapter + debuggee execution
  /debug breakpoints <path> <lines|clear>  Replace one file's one-based line list
  /debug threads|stack <thread>     Explicit bounded thread/stack inspection
  /debug scopes <frame>             Inspect scopes using a returned frame handle
  /debug variables <handle>         Inspect values (may contain secrets)
  /debug continue <thread>|stop     Resume or terminate the launched debug session
  /visualize repo [dir]             Render repository dependencies locally (no model)
  /verify [checks ...]              Run project checks without a model
  /verify repair [checks ...]       Run checks and authorize bounded repair
  /exit, /quit                      Exit interactive mode; no-op in one-shot mode

Unknown slash commands are rejected locally, never sent to a model.
/model: Enter selects and saves ~/.casper/settings.json; Ctrl+S selects for this session only.
Exact IDs are remembered too; /model --session <id> opts out. Shared Pi defaults are unchanged.
/effort remembers supported levels per model; /effort <level> --session opts out.
Context is estimated and may be unavailable; cost estimates are not subscription billing.
/clear preserves saved conversations and workspace files. /resume uses exact IDs; /switch uses workspace names.
Esc/Ctrl-C cancel the picker. Plain/redirected terminals list models; use an exact ID to select.
Restored conversations retain their model; missing/unavailable selections block sending.
Without a restored selection or Casper default, choose with /model; no Pi-default fallback.
Switching provider sends subsequent conversation context to that provider.
The picker refreshes local catalogs only; selection does not generate a model response.
Provider-defined credential checks may execute configured key-resolution commands.
Checks: typecheck lint test build (all by default).
Interactive sessions offer casper_check by default: the model may select trusted project
checks; nothing runs automatically and no selection means no Casper verification recorded.
--no-verify withholds the tool; one-shot prompts get it only with --verify.
Verification executes repository shell commands; use only in trusted projects.
One-shot checks exit 0 on command success, 1 on failure/blocked, 2 on skips/no commands.
Exit 0 does not certify current inputs or behavior; see scoped freshness in the receipt.
MCP connection executes a configured program or contacts its URL. Review its source first.
Non-read MCP calls require exact interactive confirmation; denied in one-shot mode.
Cooked terminal input (TERM=dumb or redirected output) cannot grant exact approval.
Piped line input discards unfinished input at approval transitions; NO_COLOR is supported.
LSP connection executes a configured program. Review .casper/lsp.json first.
LSP rename requires exact interactive approval; one-shot rename is denied.
Browser tasks use installed Chrome/Chromium (CASPER_BROWSER_EXECUTABLE overrides detection).
No automatic browser installation, personal profiles, account credentials or arbitrary page scripts.
Synthetic local-project interactions may proceed; consequential/uncertain actions require fresh yes.
One-shot mode cannot grant those approvals. Ordinary external resources are allowed: not isolation.
Browser checks replay immutable scenarios; screenshots alone and model claims are not verification.
Task-owned development scripts run trusted project code, not a sandbox, and stop with the task.
Saved owner-only screenshots remain in external project state until manually removed; may be sensitive.
See docs/BROWSER.md for limits, input freshness, supported assertions and remaining caveats.
Session branching/switching and worktree creation/removal require exact interactive approval.
Subagents get read/grep/find/ls only; no edit/write/bash/MCP/LSP or recursive delegation.
Limits: 2 concurrent, 4 delegations per parent prompt; 180 seconds/12 turns/48 tool calls per child.
Children use global Pi model defaults. Reports are advisory; read-only tools are not an OS sandbox.
Learning also uses those defaults; source text may reach the configured provider. No secret detector.
Learning drafts are owner-only plaintext and inert. Promotion is a separate local,
digest-bound human command; it never asks the model to choose or approve.
Use local directories only; learn cannot be combined with --verify, --mcp or --lsp.
Applying a worktree candidate leaves its reviewed diff uncommitted; Casper never commits or pushes it.
Worktree cleanup unregisters Git state and retains candidate files in a printed recovery directory.
`;
