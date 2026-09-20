export const HELP_TEXT = `Casper — your coding companion

  casper                 Start interactive mode
  casper <prompt>        Run one prompt and exit
  /help all              All commands, options and safety details
  /status                Model/auth, integrations and local storage
  /model [model]         Pick a model; Enter for this conversation, Ctrl+S to save default
  /login                 Authentication setup guidance (no credentials changed)
  /project               Project context and check commands
  /skills                Skills and trust; /skills diagnostics for warnings
  /verify [checks ...]   Run repository checks (trusted projects only)
  /exit                  Exit

Type a request to work with the model. Native tools can execute code and edit files.
Ctrl-C cancels active work; while idle it clears a draft, or exits if empty.
Enter during work retains your draft; it does not queue a request.
Approvals require a fresh yes. Task completion is not verification.
`;

export const LOGIN_HELP = `Casper uses Pi's provider authentication; this command changes nothing.
For subscription login or an API key, open another terminal. From the Casper
checkout run: bun run node_modules/.bin/pi (the pinned runtime), then use /login.
Select your provider and complete its prompts, then exit Pi and restart Casper.
An already-installed pi command can also manage the same Pi authentication.
Alternatively set your provider's documented environment variable before launch
(e.g. OPENAI_API_KEY for OpenAI API, not a Codex subscription).
Never paste credentials into chat. /status reports the active runtime once started;
credentials configured is not a connection test. Then use /model in Casper;
Casper model defaults are separate from Pi settings. Embedded OAuth is not implemented.
`;

export const FULL_HELP_TEXT = `Casper — your coding companion

Usage:
  casper               Start interactive mode
  casper <prompt>      Run one prompt and exit
  casper learn <repo>  Propose inert learning drafts using a read-only model run
  casper learn list <repo>          List saved drafts locally (no model)
  casper learn inspect <repo> <id>  Inspect a saved draft locally (no model)
  casper --verify ...  Authorize post-task checks and bounded repair
  casper --mcp <name>  Authorize and connect a configured MCP (repeatable)
  casper --lsp <name>  Authorize and start a configured language server (repeatable)
  casper --help        Show help

Local commands:
  /help, /help all                  Short help or this full reference (no model)
  /status                          Runtime model/auth and integration status
  /model [id or provider/id]        Pi model picker; exact matches select directly
  /login                           Authentication setup guidance (no login side effects)
  /project                         Show project context
  /memory                          List human-entered project facts
  /memory remember <fact>          Save an explicit project fact (no model)
  /memory forget <id>              Remove a fact
  /memory outcomes                 Show the latest 20 task outcomes
  /memory accept <id> <yes|no>      Record human acceptance, not test evidence
  /references                      List configured local reference sources
  /references search <id|*> <query> Search reference text locally (no model)
  /tree                            Show named session/workspace branches
  /branch <name>                   Clone this Pi session (isolated by policy)
  /switch <branch>                 Switch session and workspace (confirmation required)
  /switch main apply               Verify/review/apply candidate, then clean up
  /switch main discard             Review/discard candidate, then clean up
  /delegate <explorer|reviewer> <goal>  Run a bounded read-only subagent (uses a model)
  /skills                          List skill metadata and trust
  /skills diagnostics              Inspect discovery/activation warnings
  /skills inspect <id>             Inspect a skill and its content digest
  /skills trust <id> <sha256>       Approve the exact reviewed skill content
  /skills block <id>               Prevent future skill injection
  /mcp                             Show redacted MCP status (no connection)
  /mcp connect <name>               Authorize this server for this process
  /mcp disconnect <name>            Disconnect and revoke process-local consent
  /lsp                             Show language-server status (no startup)
  /lsp connect <name>               Authorize this language server for this process
  /lsp disconnect <name>            Stop this language server
  /visualize repo [dir]             Render repository dependencies locally (no model)
  /verify [checks ...]              Run project checks without a model
  /verify repair [checks ...]       Run checks and authorize bounded repair
  /exit, /quit                     Exit interactive mode; no-op in one-shot mode

Unknown slash commands are rejected locally, never sent to a model.
/model: Enter selects for the conversation; Ctrl+S selects and saves ~/.casper/settings.json.
Esc/Ctrl-C cancel the picker. Plain/redirected terminals list models; use an exact ID to select.
Restored conversations retain their model; missing/unavailable selections block sending.
Without a restored selection or Casper default, choose with /model; no Pi-default fallback.
Switching provider sends subsequent conversation context to that provider.
The picker refreshes local catalogs only; selection does not generate a model response.
Provider-defined credential checks may execute configured key-resolution commands.
Checks: typecheck lint test build (all by default).
Verification executes repository shell commands; use only in trusted projects.
One-shot checks exit 0 on command success, 1 on failure/blocked, 2 on skips/no commands.
Exit 0 does not certify current inputs or behavior; see scoped freshness in the receipt.
MCP connection executes a configured program or contacts its URL. Review its source first.
Non-read MCP calls require exact interactive confirmation; denied in one-shot mode.
Cooked terminal input (TERM=dumb or redirected output) cannot grant exact approval.
Piped line input discards unfinished input at approval transitions; NO_COLOR is supported.
LSP connection executes a configured program. Review .casper/lsp.json first.
LSP rename requires exact interactive approval; one-shot rename is denied.
Session branching/switching and worktree creation/removal require exact interactive approval.
Subagents get read/grep/find/ls only; no edit/write/bash/MCP/LSP or recursive delegation.
Limits: 2 concurrent, 4 delegations per parent prompt; 180 seconds/12 turns/48 tool calls per child.
Children use global Pi model defaults. Reports are advisory; read-only tools are not an OS sandbox.
Learning also uses those defaults; source text may reach the configured provider. No secret detector.
Learning drafts are owner-only plaintext, never active guidance. No promotion is implemented.
Use local directories only; learn cannot be combined with --verify, --mcp or --lsp.
Applying a worktree candidate leaves its reviewed diff uncommitted; Casper never commits or pushes it.
Worktree cleanup unregisters Git state and retains candidate files in a printed recovery directory.
`;
