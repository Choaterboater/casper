export const HELP_TEXT = `Casper — your coding companion

  casper                 Start interactive mode
  casper <prompt>        Run one prompt and exit; Casper checks the changes (--no-verify skips)
  casper <folder>        Open that folder
  casper --verbose ...   Detailed evidence receipts instead of the plain receipt
  casper --json ...      Scripting: also --model, --continue, --require-verification (docs/SCRIPTING.md)
  casper mcp check [repo]  Check an MCP server you built: its tests, labels and configs (no tool calls unless --live)
  casper new [name]      Start a new project (Python tool, MCP server, Mist scripts)
  casper update          Update Casper to the newest release, or pull a source checkout (--check only looks)
  /help all              All commands, options and safety details
  /status                Model/auth, integrations and local storage
  /model [model]         Pick a model; Enter remembers globally, Ctrl+S is session-only
  /effort [level|auto]   Pick reasoning effort, or auto per request; --session for temporary
  /model big <model>     Set your big model: Casper offers it when repairs run out
  /plan <request>        Plan first: the model writes a plan and the cases to test, you edit it, then build
  /suggestions [on|off]  List the suggested next steps, or turn them on or off
  /context, /usage       Context estimate, session tokens and cost availability
  /compact               Summarize context (sends a model request)
  /clear, /resume        Fresh conversation or list/resume a saved conversation
  /diff [n|list]         The last task's changes (also outside git); git's view before any task
  /undo, /redo           Put the last task's files back, or back again (no model; docs/UNDO.md)
  /new [name]            Start a new project in ~/Projects (no model)
  /output [n|all]        Full command and output of the n-th latest tool call; all lists every call
  /details [level]       How much work shows: quiet, normal or detailed (no word: the next one)
  /receipt [n|list]      The last receipt (also after a restart), receipt n, or the last 10
  /permissions           Explain actual tool/approval boundaries
  /login                 Provider sign-in or private API-key setup (interactive only)
  /project               Project context and check commands
  /project <name>        Open a project folder inside this one (before the model starts)
  /skills                Skills and trust; /skills diagnostics for warnings
  /verify [checks ...]   Run this project's checks (in the sandbox); /verify repair fixes failures
  /sandbox               What the shell sandbox holds here; /sandbox forget <host>
  /security-review       Run the pinned security tools here, then offer an AI review (asks first)
  /mcp setup network     Set up Casper's network server for Mist, Central and ClearPass (asks first)
  /mcp login             Add, replace or forget a Mist, Central or ClearPass login (you type it)
  /browser               Disposable browser status; website tasks can reproduce bugs
  /services              Declared services: status, logs, start, restart, stop (no model)
  /tasks                 What runs in the background (dev servers, helpers, checks); stop one
  /debug                 Local debugger targets/status; explicit launch approval
  /exit, /quit           Exit

Type a request to work with the model. Native tools can execute code and edit files.
The AI can search the web and read public pages without asking; web: off in ~/.casper/config.yaml turns it off.
Type / for fuzzy command discovery; Tab completes commands and file paths (@).
Shift+Tab cycles reasoning effort, including auto, and remembers where it stops, like /effort.
Shift+Enter (when supported) or Ctrl+J inserts a newline; Up/Down recalls history.
Esc stops active work. Ctrl-C cancels work; idle, it clears a draft; twice on empty exits.
Ctrl+T shows the last step in full (an edit's diff, a command's output). Ctrl+L redraws the screen. See docs/TERMINAL_UX.md for limits.
Enter during work sends your line to the AI (it reads it at its next step) or queues it for after the task;
Esc gives queued lines back. A queued line never answers an approval.
Approvals require a fresh yes. Task completion is not verification.
After the model edits files, Casper runs the project's checks itself and repairs failures (auto
mode), by default, with no command from you; slow checks (a minute or more) are offered as /verify
in interactive sessions instead. --no-verify turns checking off. See docs/VERIFICATION.md.
`;

export const LOGIN_HELP = `Provider login requires an interactive Casper terminal.
Run casper, then /login [openai-codex|github-copilot|anthropic|openrouter].
Codex/Copilot use device-code login; Claude and OpenRouter offer API key or browser sign-in.
Use TERM other than dumb and output not redirected.
This guidance changes no credentials. Never paste passwords, tokens or API keys into chat.
Login writes to Casper's credential store (~/.casper/agent) after consent; it does not select a model.
Use /model afterward. Local credential availability is not a connection test.
`;

export const FULL_HELP_TEXT = `Casper — your coding companion

Usage:
  casper               Start interactive mode
  casper <prompt>      Run one prompt and exit; options go before the prompt (quote the whole request to send them as words)
  casper <folder>      Open that folder, like --cd <folder> with no prompt
  casper --version, -v Print the installed version and the path that is running
  casper learn <repo>  Propose inert learning drafts using a read-only model run
  casper learn list <repo>          List saved drafts locally (no model)
  casper learn inspect <repo> <id>  Inspect a draft and its decisions locally
  casper learn promote <repo> <id> <sha256> <number> <disposition> [skill-name]
                                  Record one exact human promotion/ignore decision
  casper mcp check [repo]  Check an MCP server you built: its tests, labels and configs (no tool calls unless --live)
  casper mcp check [repo] [--server <name>] [--live] [--quick] [--strict] [--json] [--env NAME=VALUE]... [-- <start command>...]
                                  Runs the repo's own doctor and tests; only run it on repos you trust
  casper new [name]    Start a new project (Python tool, MCP server, Mist scripts); asks what is missing, then opens Casper there
  casper new <template> <name>  Start a new project in ~/Projects without questions (scripts; casper new --list shows templates)
  casper security [repo] [--json] [--strict] [--install] [--mcp-tools <file>]
                                  Run the security tools on a repo (no model); installs tools only with --install
                                  Exit 0 no problems, 1 problems, 64 usage mistake
  casper update [--check]  Update Casper (no model): an installed release runs the newest release's own installer
                                  on this program's folder; a source checkout pulls with git (fast-forward only)
                                  and runs bun install when its lockfile changed. --check only says what is newer
                                  Exit 0 updated or nothing to do, 1 not finished (the message says what is left), 64 usage mistake
  casper --cd <path> ...  Work in that folder instead of the current directory
  casper --continue ...  Continue this folder's most recent conversation
  casper --resume <id-prefix> ...  Continue the saved conversation whose ID starts with this
  casper --model <provider/model-id[:effort]> ...
                       Use this model for this run only; the saved default is unchanged
  casper --effort <level|auto> ...  Reasoning effort for this run only; not remembered
  casper --max-turns <n> ...  Stop each request after n model turns; the run is incomplete (exit 2)
  casper --verify ...  Casper runs the checks after this run's edits, with bounded repair (auto)
  casper --no-verify   No Casper checks during tasks for this run (off)
  casper --no-sandbox ...  Shell commands and checks run with your own permissions for this run (the receipt says so)
  casper --verbose ... Detailed evidence receipts and per-check lines
  casper --json <prompt>  JSON Lines events on stdout (see docs/SCRIPTING.md); other output to stderr
  casper --json - < f     Read the prompt from stdin (kept out of the process list)
  casper --require-verification <prompt>
                       Implies --verify; changes Casper did not verify exit 3, not 0
  casper --mcp <name>  Authorize and connect your own (user/profile) MCP server (repeatable)
  casper --lsp <name>  Authorize and start your own (user/profile) language server (repeatable)
                       Project-defined servers need interactive /mcp or /lsp connect review
  casper --help, -h    Show help
  casper --licenses    Print third-party license notices

Local commands:
  /help, /help all                  Short help or this full reference (no model)
  /status                           Runtime model/auth and integration status
  /model [id or provider/id]        Model browser; select and remember globally
  /model --session [model]          Select without changing the startup default
  /model @role[:effort]             Select the model a configured role points to
  /model roles                      Show fast/build/reason/review role mappings
  /model role <fast|build|reason|review> <selector|clear>  Save or clear a role mapping
  /model big <selector|clear>       Set or clear your big model (the reason role); asked for when repairs run out
  /plan <request>                   Plan first: blocks changes Casper can see while the model plans; you edit, then build
  /suggestions                      List suggested next steps: on, off or faded (hidden after 3 ignores, 14 days)
  /suggestions on|off [name]        Turn every suggestion, or one, on or off (suggestions: false in config.yaml too)
  /effort [level|auto] [--session]  Supported levels or auto (Casper picks per request); Shift+Tab cycles
  /context                          Estimated context and capability counts
  /usage                            Session tokens, cache share and optional catalog cost estimate
  /compact [instructions]           Summarize context using the model (not a local-only command)
  /clear                            New conversation; no file rollback
  /resume [exact-session-id]        List/resume conversations in the current workspace
  /diff [n|list]                    Task n's changes (default: the last task in this folder), also outside git; list picks one
                                    Before any task in this folder: git status plus tracked diff against HEAD
  /undo [n]                         Put back the files of the last task (or task n); files changed since are left alone
  /redo [n]                         Put an undone task's files back as the task left them
  /new [name]                       Start a new project in ~/Projects (no model); before the model starts, Casper opens it
  /new <template> <name>            The same without questions; /new --list shows the templates
  /output [n]                       Full command and output of a recent tool call (1 = latest; last 20 kept per task)
  /output all                       Every tool call of the last task on its own line (the screen folds them into a summary)
  /details [quiet|normal|detailed]  For this session: failures only, steps folded (default), or every step with small diffs;
                                    display: in ~/.casper/config.yaml sets the default. Ctrl+T shows the last step in full
  /receipt                          Detailed evidence receipt of the last model task (freshness, scope), also after a restart
  /receipt <n>, /receipt list       A saved receipt, or the last 10 (saved with secrets hidden)
  /permissions                      Explain enforcement, not change permission presets
  /sandbox                          What the shell sandbox holds: write folders, private folders, hosts
  /sandbox forget <host>            Forget a host you allowed for this project (Always)
  /login [provider]                 Codex, Copilot, Anthropic or OpenRouter (Casper's credential store)
  /project                          Show project context
  /project <name>                   Open a project folder inside this one, or offer to make it (before the model starts)
  /memory                           List human-entered project facts
  /memory remember <fact>           Save an explicit project fact (no model)
  /memory forget <id>               Remove a fact
  /memory outcomes                  Show the latest 20 task outcomes
  /memory accept <id> <yes|no>      Record human acceptance, not test evidence
  /references                       List configured local reference sources
  /references search <id|*> <query> Search reference text locally (no model)
  /references add [name] [release]  Download a vendor spec repo to search locally (asks first)
  /secrets                          Show what Casper hides from the AI
  /secrets files on|off             Scrub config files and command output (MCP results always)
  /tree                             Show named session/workspace branches
  /branch <name>                    Clone this conversation (isolated by policy)
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
  /mcp setup network                Set up Casper's network server (Mist, Central, ClearPass): 1 Not now · 2 Set it up
  /mcp login [mist|central|clearpass] [forget]  Add, replace or forget a network login; only you type it
  /mcp connect <name>               Connect this server; your own or imported ones can be remembered
  /mcp disconnect <name>            Disconnect and revoke consent for this process
  /mcp reload                       Re-read MCP files; changed servers need consent again
  /mcp writes <name>                Turn writes on for one server (you pick 2 in the box)
  /mcp writes off                   Writes off for every server (ctrl+o does the same)
  /mcp forget <name>                Forget a remembered server; Casper asks again next time
  /mcp junos-show <name> on|off     Let plain Junos show commands run without asking
  /mcp docs                         Docs servers; add a docs-only copy with no credentials
  /lsp                              Show language-server status (no startup)
  /lsp connect <name>               Authorize this language server for this process
  /lsp disconnect <name>            Stop this language server
  /browser                          Local browser status (no model or browser startup)
  /browser open <url>               Open an HTTP(S) page in a disposable browser
  /browser inspect|diagnostics      Bounded observations, not verification
  /browser screenshot|close         Save a viewport PNG or close owned resources
  /services                         Declared services: state and address (no model or startup)
  /services logs <name>             Recent log lines of a service
  /services start|restart|stop <name>  Start (waits for readiness; restarts a stale or crashed one), restart or stop
  /tasks                            What runs in the background, numbered; asks 1 Keep them · 2 Stop 1 ...
  /tasks stop <n>|all               Stop one of them, or all, without the question
  /debug                            Local DAP state and .casper/debug.json targets
  /debug start <target>             Fresh approval for adapter + debuggee execution
  /debug breakpoints <path> <lines|clear>  Replace one file's one-based line list
  /debug threads|stack <thread>     Explicit bounded thread/stack inspection
  /debug scopes <frame>             Inspect scopes using a returned frame handle
  /debug variables <handle>         Inspect values (may contain secrets)
  /debug continue <thread>|stop     Resume or terminate the launched debug session
  /visualize repo [dir]             Render repository dependencies locally (no model)
  /verify [checks ...]              Run this project's checks (in the sandbox), without a model
  /verify repair [checks ...]       Run checks and authorize bounded repair
  /verify add <name>                Save a ready-made check Casper found (Ansible) in .casper/project.yaml
  /verify <lab check>               Run a lab check on your own lab (lab.hosts); asks first, never auto
  /security-review                  Run the pinned security tools here (no model), then offer an AI review:
                                    1 Stop here · 2 Run the AI review, with its cost; Enter spends nothing
  /security-review ai               The same; where Casper can't ask (one-shot, --json), runs the AI review
  /security-review update           Download osv-scanner's advisory data (asks first)
  /security-review ignores          List ignores you approved; approve or remove them
  /exit, /quit                      Exit interactive mode; no-op in one-shot mode

Unknown slash commands are rejected locally, never sent to a model.
/model: Enter selects and saves ~/.casper/settings.json; Ctrl+S selects for this session only.
Exact IDs are remembered too; /model --session <id> opts out.
/effort remembers supported levels per model; /effort <level> --session opts out.
Shift+Tab cycles auto and the model's supported levels and saves the level it stops at, like /effort. One-off --effort never saves.
/effort auto lets Casper pick per request: low for reading/explaining/diagrams, medium for tests and
configuration, high for fixes, features and refactors, from the model's supported levels.
Context is estimated and may be unavailable; cost estimates are not subscription billing.
/clear preserves saved conversations and workspace files. /resume uses exact IDs; /switch uses workspace names.
Esc/Ctrl-C cancel the picker. Plain/redirected terminals list models; use an exact ID to select.
Restored conversations retain their model; missing/unavailable selections block sending.
Without a restored selection or Casper default, choose with /model; there is no other fallback.
Switching provider sends subsequent conversation context to that provider.
The picker refreshes provider catalogs over the network when CASPER_OFFLINE=1 is not set; selection does not generate a model response.
Provider-defined credential checks may execute configured key-resolution commands.
Checks: typecheck lint test build (all configured by default; verification.checks selects).
verification.mode: auto (Casper runs the checks after edits, repairs failures within repair.maxAttempts),
offer (the model may use casper_check; the receipt suggests /verify) or off. Unset: auto, except
that interactive sessions use offer once the checks are measured at 60 s or more.
--verify selects auto and --no-verify selects off for one run. Auto skips checks when no files
changed, and checks whose declared scope misses every changed file. The receipt says why.
Checks run the project's own commands in the shell sandbox where it can run (/sandbox): they write only
the project, temp and package caches, can't read your private folders and reach only listed hosts. Without
the sandbox (Windows, bubblewrap missing, --no-sandbox) they run with your permissions.
One-shot exit codes: 0 pass (or nothing to verify), 1 check failed or blocked, 2 incomplete
(skipped checks, --max-turns reached, or --verify with changes and no checks configured),
3 not verified (--require-verification only), 64 usage error, 130 cancelled.
Exit 0 does not certify behavior beyond the checks; /receipt shows scope and freshness.
MCP connection executes a configured program or contacts its URL. Review its source first.
Servers from ~/.claude.json, ~/.mcp.json and VS Code are listed too; each needs /mcp connect once.
Every MCP server starts with writes off: write and delete tools are hidden. /mcp writes <name>
turns them on; ctrl+o turns them off again. A remembered server always starts with writes off.
A login is read-only only when the product says so (access_check); labels only make things stricter.
Non-read MCP calls require exact interactive confirmation; denied in one-shot mode. The AI can't approve.
Known device secrets (passwords, keys, SNMP communities) in MCP results, config files and config-like
command output are shown to the AI as <secret hidden> (best effort, known formats only); a change
that carries the marker back is refused. See docs/SECRETS.md.
Cooked terminal input (TERM=dumb or redirected output) cannot grant exact approval.
Piped line input discards unfinished input at approval transitions; NO_COLOR is supported.
LSP connection executes a configured program. Review .casper/lsp.json first.
LSP rename requires exact interactive approval; one-shot rename is denied.
Web lookups (web_search, web_fetch) are on by default and never ask. They reach only public https pages
on ports 80 and 443 (http is upgraded), checked again on every redirect; a search or address holding a secret
is refused, never sent. Search is DuckDuckGo by default; web: { provider: brave } uses Brave Search with the key
saved as "brave" in Casper's login file (~/.casper/agent/auth.json), and web: { provider: searxng,
searxngUrl: <address> } your own SearXNG.
web: off in ~/.casper/config.yaml turns them off; a project file can't change web:.
Browser tasks use installed Chrome/Chromium (CASPER_BROWSER_EXECUTABLE overrides detection).
No automatic browser installation, personal profiles, account credentials or arbitrary page scripts.
Synthetic local-project interactions may proceed; consequential/uncertain actions require fresh yes.
One-shot mode cannot grant those approvals. Ordinary external resources are allowed: not isolation.
Browser checks replay immutable scenarios; screenshots alone and model claims are not verification.
Task-owned development servers run the project's code in the shell sandbox (files held; the network is not
limited, so the page can load), and stop with the task.
Saved owner-only screenshots remain in external project state until manually removed; may be sensitive.
See docs/BROWSER.md for limits, input freshness, supported assertions and remaining caveats.
Services from .casper/project.yaml run the project's code in the shell sandbox (files held; the network is not
limited, so you can reach them); they stay up between
prompts and stop on exit, /clear, /resume, /branch and /switch. Ctrl+C cancels only a startup. See docs/SERVICES.md.
Session branching/switching and worktree creation/removal require exact interactive approval.
Subagents get read/grep/find/ls only; no edit/write/bash/MCP/LSP or recursive delegation.
Limits: 2 concurrent, 4 delegations per parent prompt; 180 seconds/12 turns/48 tool calls per child.
Children use Casper roles (explorer→fast, reviewer→review) or the startup default.
Reports are advisory; read-only tools are not an OS sandbox.
Learning uses the startup default; source text may reach the configured provider. No secret scrubbing.
Learning drafts are owner-only plaintext and inert. Promotion is a separate local,
digest-bound human command; it never asks the model to choose or approve.
Use local directories only; learn cannot be combined with --verify, --mcp or --lsp.
Applying a worktree candidate leaves its reviewed diff uncommitted; Casper never commits or pushes it.
Worktree cleanup unregisters Git state and retains candidate files in a printed recovery directory.
`;
