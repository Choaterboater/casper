import { closestWord } from "./closest";
import { COMMAND_REGISTRY, parseCommandLine, takesArguments } from "./commands";
import { WRITES_OFF_MEANING } from "../mcp/presets";
import { DOCTOR_HELP, UPDATE_HELP } from "../cli-args";
import { NEW_HELP_LINE } from "../new/templates";

export const HELP_TEXT = `Casper — your coding companion

Type a request and press Enter (during a task it steers the AI or waits in the queue). Start a line with ? to ask on the side. Esc stops work. Type / for every command.
  casper [folder]        Open Casper here, or in that folder
  casper <prompt>        Run one request and exit (options: /help all)
  casper new [name]      Start a new project (casper new --list shows the kinds)
  /model, /effort        Pick the model, and how hard it thinks (Shift+Tab cycles effort)
  /diff, /undo, /redo    See the last task's changes, or put its files back
  /verify, /receipt      Run this project's checks (/verify add saves one Casper found); what the last task did
  /mcp, /lab             Tool servers (writes off until you turn them on); your lab devices
  /mcp setup network     Set up Casper's server for Mist, Central and ClearPass; /mcp login adds a login
  /references            Search vendor specs you downloaded (/references add gets one)
  /resume, /clear        Pick up a saved conversation, or start a fresh one
  /settings              Turn web lookups, spend notes and other switches on or off by number
  /help <word>           Search the help; /help all shows everything
Ctrl+T shows the last step in full. Ctrl+V pastes a picture. Ctrl+C twice on an empty line exits. Approvals always need a fresh yes from you. think hard: or big model: at the start of a request sets that task (/help words).
`;

export const LOGIN_HELP = `Sign-in needs an interactive terminal. Run casper and type /login.
Never paste keys or tokens into chat.
`;

/** The keys, in /help all and /hotkeys. */
export const KEYS_HELP = "Esc stops work. Ctrl+C cancels work; idle, it clears a draft; twice on empty exits. Shift+Tab cycles effort. Ctrl+T shows the last step in full (an edit's diff, a command's output). Ctrl+O turns MCP writes off. Ctrl+L redraws the screen. Ctrl+V (Alt+V on Windows) pastes a picture from the clipboard as [image 1], or the path of a file you copied in Finder, Explorer or a file manager (a picture file goes with the request); a dropped picture file works too. Shift+Enter (when supported) or Ctrl+J inserts a newline; Up/Down recalls history. Tab completes commands and file paths (@). Enter during work sends your line to the AI (it reads it at its next step) or queues it for after the task; Esc gives queued lines back. A queued line never answers an approval.";

/** /hotkeys: the keys, one sentence a line. */
export const HOTKEYS_TEXT = `Keys:\n${KEYS_HELP.split(/(?<=\.) (?=[A-Z])/).map((sentence) => `  ${sentence}`).join("\n")}\n`;

export const FULL_HELP_TEXT = `Casper — your coding companion

Usage:
  casper               Start interactive mode
  casper <prompt>      Run one prompt and exit; options go before the prompt (quote the whole request to send them as words)
  casper <folder>      Open that folder, like --cd <folder> with no prompt
  casper --version, -v Print the installed version and the path that is running
  casper learn <repo>  Write learning drafts from a repo using a read-only model run; a draft does nothing until you promote it
  casper learn list <repo>          List saved drafts (no model)
  casper learn inspect <repo> <id>  Show a draft and the decisions made on it
  casper learn promote <repo> <id> <sha256> <number> <disposition> [skill-name]  Record your promote or ignore decision for that exact draft
  casper mcp check [repo]  Check an MCP server you built: its tests, labels and configs (no tool calls unless --live)
  casper mcp check [repo] [--server <name>] [--live] [--quick] [--strict] [--json] [--env NAME=VALUE]... [-- <start command>...]  Runs the repo's own doctor and tests; only run it on repos you trust
  ${NEW_HELP_LINE}
  casper new <template> <name>  Start a new project in ~/Projects without questions (scripts; casper new --list shows templates)
  casper security [repo] [--json] [--strict] [--install] [--mcp-tools <file>]  Run the security tools on a repo (no model); installs tools only with --install. Exit 0 no problems, 1 problems, 64 usage mistake
  casper update [--check]  ${UPDATE_HELP}
  casper doctor        ${DOCTOR_HELP}
  casper --cd <path> ...  Work in that folder instead of the current directory
  casper --continue ...  Continue this folder's most recent conversation
  casper --resume <id-prefix> ...  Continue the saved conversation whose ID starts with this
  casper --model <provider/model-id[:effort]> ...  Use this model for this run only; the saved default is unchanged
  casper --effort <level|auto> ...  Reasoning effort for this run only; not remembered
  casper --max-turns <n> ...  Stop each request after n model turns; the run is incomplete (exit 2)
  casper --verify ...  Casper runs the checks after this run's edits, with bounded repair (auto)
  casper --no-verify   No Casper checks during tasks for this run (off)
  casper --no-sandbox ...  Shell commands and checks run with your own permissions for this run (the receipt says so)
  casper --allow-host <host> ...  Shell commands may reach this host for this run, without asking (repeat for more)
  casper --allow-write <folder> ...  Shell commands and the AI's edits may write this folder for this run
  casper --allow-reach <host> ...  The AI's ssh and scp may reach this machine for this run, without asking
  casper --verbose ... Detailed evidence receipts and per-check lines
  casper --json <prompt>  JSON Lines events on stdout (see docs/SCRIPTING.md); other output to stderr
  casper --json - < f     Read the prompt from stdin (kept out of the process list)
  casper --require-verification <prompt>  Implies --verify; changes Casper did not verify exit 3, not 0
  casper --mcp <name>  Authorize and connect your own (user/profile) MCP server (repeatable)
  casper --lsp <name>  Authorize and start your own (user/profile) language server (repeatable)
                       Project-defined servers need interactive /mcp or /lsp connect review
  casper --help, -h    Show help
  casper --licenses    Print third-party license notices

Local commands:
  /help                             Short help (no model)
  /help all                         This full reference
  /help <word>                      Only the lines that mention that word, like /help mcp
  /status, /project                 Project, model, sign-in and integration status
  /doctor                           Check Casper's own setup (no model): version, config files, sign-in, MCP and language servers, security tools, sandbox, disk, network server; fixes it can make ask first (1 Not now); during a task it only reports
  /model [id or provider/id]        Model browser; select and remember globally; an id no model matches is an error
  /model --session [model]          Select without changing the startup default (--session also goes after the model)
  /model @role[:effort]             Select the model a configured role points to
  /model roles                      Show fast/build/reason/review role mappings
  /model role <fast|build|reason|review> <selector|clear>  Save or clear a role mapping
  /model big <selector|clear>       Set or clear your big model (the reason role); asked for when repairs run out
  /plan <request>                   Plan first: blocks changes Casper can see while the model plans; you edit, then build
  /btw <question>                   A side question, idle or during a task, like a line you start with ? (works with side questions off)
  /suggestions                      List suggested next steps: on, off or faded (hidden after 3 ignores, 14 days)
  /suggestions on|off [name]        Turn every suggestion, or one, on or off (suggestions: false in config.yaml too)
  /effort [level|auto] [--session]  The model's supported levels or auto (Casper picks per request); --session before or after; Shift+Tab cycles; /thinking is the same
  /context                          Estimated context and capability counts
  /usage, /cost                     Session tokens, cache share and optional catalog cost estimate
  /compact [instructions]           Summarize context using the model (not a local-only command)
  /clear, /new                      New conversation; no file rollback
  /resume [id]                      Pick a saved conversation (or give the start of its ID)
  /diff [n|list]                    Task n's changes (default: the last task in this folder), also outside git; list picks one. Before any task in this folder: git status plus tracked diff against HEAD
  /undo [n]                         Put back the files of the last task (or task n); files changed since are left alone
  /redo [n]                         Put an undone task's files back as the task left them
  /output [n]                       Full command and output of a recent tool call (1 = latest; last 20 kept per task)
  /output all                       Every tool call of the last task on its own line (the screen folds them into a summary)
  /details [quiet|normal|detailed] [--session]  Alone: the level now. Failures only, steps folded (default), or every step with small diffs; remembered like /effort, --session (before or after) for this session only. Ctrl+T shows the last step in full
  /settings, /config                Every switch at a glance, then one by number, written to ~/.casper/config.yaml for you: web lookups, browser tool, starter templates, diagram tool, new-version notice, side questions with ?, suggestions, built-in skills, GitHub tool, packs, spend notes, spend pause, prompt cache, local models, page checks, show the AI the pages, work shown, theme, untrusted-text reader, helpers that build, Playwright tests, send Casper's name to OpenRouter, sign-ins from other tools, network server updates, private ssh passwords
  /theme                            Pick the screen's colours (the Theme row of /settings), saved for you
  /hotkeys                          The keys Casper uses
  /copy [n]                         Copy the last answer, or its code block n, to the clipboard
  /export [file]                    Save this conversation to ~/.casper/exports, or to [file] in the project: Markdown, or every message as .jsonl
  /rename <title>                   Name this conversation (the window title and /resume)
  /receipt                          Detailed evidence receipt of the last model task (freshness, scope), also after a restart
  /receipt <n>, /receipt list       A saved receipt, or the last 10 (saved with secrets hidden)
  /permissions                      Whether Casper asks, one line per kind, and a box to stop asking until you quit
  /permissions details              Everything allowed here, where it came from and every way to be asked less
  /permissions all|ask              Stop the shell's questions until you quit (asks first; allowall is the same), or ask them again
  /permissions write|forget <folder>  Allow a folder outside the project for this project, or take it back (remove is the same as forget)
  /sandbox, /sandbox list           What the shell sandbox holds: write folders, private folders, hosts
  /sandbox off, /sandbox on         Turn the shell sandbox off for this session (commands and checks run with your permissions), or back on
  /sandbox forget <host>            Forget a host or machine you allowed for this project (Yes, always); remove is the same
  /allowed, /allowed list           The shell commands you said yes to for this project (saved, and for this session), numbered
  /allowed forget <n>               Forget one by its number, its words (git log) or all of them; Casper asks before running it again; remove is the same
  /lab                              Your lab devices: lab checks and the lab list use them
  /lab import <file>                Add devices to your lab list from a file (GreenCLI's lab export, or one host per line); asks first
  /lab ssh on|off                   Whether ssh and scp to your lab devices ask first (kept for this project)
  /login [codex|copilot|anthropic|openrouter]  Sign in to Codex, Copilot, Anthropic or OpenRouter (Casper's credential store); openai-codex and github-copilot work too
  /logout [provider]                Remove a sign-in Casper saved; /logout alone lists them. Environment variables are unchanged
  /project <name>                   Open a project folder inside this one, or offer to make it (before the model starts); /project alone is /status
  /project new [name]               Start a new project in ~/Projects (no model); before the model starts, Casper opens it
  /project new <template> <name>    The same without questions; /project new --list shows the templates
  /memory, /memory list             List project facts you saved
  /memory remember <fact>           Save a project fact (no model)
  /memory forget <id>               Remove a fact (remove is the same)
  /memory outcomes                  Show the latest 20 task outcomes
  /memory accept <id> <yes|no>      Record whether you accept a task's result (this is not test evidence)
  /references                       List configured local reference sources
  /references search <id|*> <query> Search reference text locally (no model)
  /references add [name] [release]  Download a vendor spec repo to search locally (asks first)
  /secrets                          Show what Casper hides from the AI
  /secrets files on|off             Scrub config files and command output (MCP results always)
  /branch                           Show named conversations and their workspaces
  /branch <name>                    Copy this conversation into a named one with its own workspace and move there (you typed it: no box)
  /switch <branch>                  Switch to a named conversation and its workspace (you typed it: no box)
  /switch main apply                Check, review and apply that workspace's changes, then clean up (asks first)
  /switch main discard              Review and throw away that workspace's changes, then clean up (asks first)
  /delegate <explorer|reviewer> <goal>  Run a read-only helper AI on one goal
  /crew <job>                       The manual way: a builder AI does the job in its own copy; then 1 Keep the copy · 2 Apply to my folder · 3 Throw it away
  /crew                             Crew copies still here; /crew apply <n> or /crew drop <n>
  /skills                           List skills and whether you trust them
  /skills diagnostics               Show why a skill was skipped or warned about
  /skills inspect <id>              Show a skill and its fingerprint (sha256)
  /skills trust <id>                Show a skill, then 1 No · 2 Trust it (exactly what was shown)
  /skills block <id>                Never use this skill
  /pack add <folder or link>        Add a skill pack from a folder or https://github.com/owner/repo@<commit>: shows it, then 1 No · 2 Yes, add it · 3 Show me what's inside
  /pack list                        The packs you added, and any not used because their files changed
  /pack remove <name>               Take a pack out (forget is the same)
  /mcp                              One line per server; on a normal terminal pick one with the arrow keys to connect, disconnect, forget or see details
  /mcp list                         The same as /mcp
  /mcp detail [name]                The full status of every server, or one; secrets hidden (no connection)
  /mcp setup network                Set up Casper's network server (Mist, Central, ClearPass): 1 Not now · 2 Set it up
  /mcp setup ssh [--name <name>] [host] [command]  Add an MCP server that runs on another machine over ssh; writes off
  /mcp login [mist|central|clearpass] [forget]  Add, replace or forget a network login; only you type it
  /mcp connect <name>               Connect this server; your own or imported ones can be remembered
  /mcp disconnect <name>            Disconnect and revoke consent for this process
  /mcp reload                       Re-read MCP files; changed servers need consent again
  /mcp writes <name>                Turn writes on for one server (you pick 2 in the box)
  /mcp writes off                   Writes off for every server (Ctrl+O does the same)
  /mcp allow <name> [off]           Pick which risky change kinds (firmware, delete, admin) a server may make; off goes back to the defaults
  /mcp forget <name>                Forget a remembered server; Casper asks again next time (remove is the same)
  /mcp junos-show <name> on|off     Let plain Junos show commands run without asking
  /mcp sandbox <name> on|off        Run a server Casper knows (its network server) in the sandbox or not; on by default, kept
  /mcp docs                         Docs servers; add a docs-only copy with no credentials
  /lsp                              Show language-server status (no startup)
  /lsp connect <name>               Authorize this language server for this process
  /lsp disconnect <name>            Stop this language server
  /browser                          Local browser status (no model or browser startup)
  /browser open <url>               Open an HTTP(S) page in a disposable browser
  /browser inspect|diagnostics      What the page shows now; this is not a check
  /browser screenshot|close         Save a viewport PNG or close the browser
  /services                         Declared services: state and address (no model or startup)
  /services logs <name>             Recent log lines of a service
  /services start|restart|stop <name>  Start (waits for readiness; restarts a stale or crashed one), restart or stop
  /preview                          Your web app on your network for a phone; asks 1 No · 2 Yes before a public link
  /preview stop                     Stop sharing it
  /tasks                            What runs in the background, numbered; asks 1 Keep them · 2 Stop 1 ...
  /tasks stop <n>|all               Stop one of them, or all, without the question
  /pane [on|off]                    The steps split beside Casper in tmux or iTerm2 (120+ columns); saved
  /debug                            Debugger state and .casper/debug.json targets
  /debug start <target>             Start the debugger and your program (asks first, every time)
  /debug breakpoints <path> <lines|clear>  Replace one file's breakpoint lines (first line is 1)
  /debug threads|stack <thread>     Show threads, or one thread's stack
  /debug scopes <frame>             Show the scopes of a frame from the stack
  /debug variables <handle>         Show values (may contain secrets)
  /debug continue <thread>|stop     Resume, or end the debug session
  /visualize                        The diagram providers and where pictures are saved (no model)
  /visualize repo [dir]             Render repository dependencies locally (no model)
  /verify [checks ...]              Run this project's checks (in the sandbox), without a model
  /verify repair [checks ...]       Run checks and authorize bounded repair
  /verify add <name>                Save a ready-made check Casper found (Ansible) in .casper/project.yaml
  /verify <lab check>               Run a lab check on your own lab (lab.hosts); asks first, never auto
  /security-review                  Run the pinned security tools here (no model), then offer an AI review: 1 Stop here · 2 Run the AI review, with its cost; Enter spends nothing
  /security-review ai               The same; where Casper can't ask (one-shot, --json), runs the AI review
  /security-review update           Download osv-scanner's advisory data (asks first)
  /security-review ignores          List ignores you approved; approve or remove them
  /exit, /quit                      Exit interactive mode (during a task it stops the task first, like Ctrl+C twice); no-op in one-shot mode

Unknown slash commands are rejected locally, never sent to a model.
/model: Enter selects and saves ~/.casper/settings.json; Ctrl+S selects for this session only. Exact IDs are remembered too; /model --session <id> opts out.
During a task, /model and /effort apply from the model's next step; the step already running keeps its model and effort.
During a task every command runs at once, with whatever follows it (/permissions all, /settings, /login, /memory remember ...); a picker or question it opens closes when the task asks you something. Only the ones that would change the task's conversation, workspace or files, or start model work of their own, wait for it: /clear, /new, /resume, /compact, /undo, /redo, /branch <name>, /switch, /project <name>, /project new, /plan, /verify, /security-review, /delegate, /crew. Esc stops the task.
Words you type at the start of a request, then : , or a new line, set that task only and are not sent to the model: think hard (top effort), quick (low effort), big model or use the big model (your big model, the reason role), fast model or use the fast model (your fast role), plan first (like /plan). ultrathink anywhere in your line is top effort too. Casper says what each word did in one line, and again when it goes back. Pasted text never counts, and words never grant permission.
Side questions: a line you start with ? (? what does ECONNRESET mean) goes to your fast model on the side with no tools, idle or during a task. The answer shows as a side answer; it is not added to the conversation and the AI never sees it. /usage counts its cost; /settings turns side questions off. /btw <question> asks the same way and still works with them off, since it is typed on purpose.
/effort remembers supported levels per model; /effort <level> --session opts out.
Shift+Tab cycles auto and the model's supported levels and saves the level it stops at, like /effort. One-off --effort never saves.
/effort auto lets Casper pick per request: low for reading/explaining/diagrams, medium for tests and configuration, high for fixes, features and refactors, from the model's supported levels.
Context is estimated and may be unavailable; cost estimates are not subscription billing.
/clear keeps saved conversations and workspace files. /resume takes the start of an ID; /switch uses workspace names.
Esc or Ctrl+C cancels the picker. Plain/redirected terminals list models; use an exact ID to select.
Restored conversations keep their model; a missing or unavailable model blocks sending.
Without a restored selection or Casper default, choose with /model; there is no other fallback.
Switching provider sends the rest of the conversation to that provider.
The picker refreshes provider catalogs over the network when CASPER_OFFLINE=1 is not set; selection does not generate a model response.
Model servers on this computer (Ollama, LM Studio, llama.cpp, vLLM) show in /model with no sign-in; the picker looks for them again each time it opens. /settings turns that off.
Provider-defined credential checks may run configured key-resolution commands.
Keys: ${KEYS_HELP}
Checks: typecheck lint test build (all configured by default; verification.checks selects).
verification.mode: auto (Casper runs the checks after edits, repairs failures within repair.maxAttempts), offer (the model may use casper_check; the receipt suggests /verify) or off. Unset: auto, except that interactive sessions use offer once the checks are measured at 60 s or more.
--verify selects auto and --no-verify selects off for one run. Auto skips checks when no files changed, and checks whose declared scope misses every changed file. The receipt says why.
Checks run the project's own commands in the shell sandbox where it can run (/sandbox): they write only the project, temp and package caches, can't read your private folders and reach only listed hosts. Without the sandbox (Windows, bubblewrap missing, --no-sandbox) they run with your permissions.
One-shot exit codes: 0 pass (or nothing to verify), 1 check failed or blocked, 2 incomplete (skipped checks, --max-turns reached, or --verify with changes and no checks configured), 3 not verified (--require-verification only), 64 usage error, 130 cancelled.
Exit 0 does not certify behavior beyond the checks; /receipt shows scope and freshness.
MCP connection runs a configured program or contacts its URL. Review its source first.
Casper's network server runs in the sandbox where one runs: it reaches only your login hosts, writes only its cache, and can't read your keys, ~/.casper or projects (/mcp sandbox network off). Other servers run as they are; /mcp says which.
Servers from ~/.claude.json, ~/.mcp.json and VS Code are listed too; each needs /mcp connect once.
Every MCP server starts with writes off. ${WRITES_OFF_MEANING} /mcp writes <name> turns writes on; Ctrl+O turns them off again. A remembered server always starts with writes off.
A login is read-only only when the product says so (access_check); labels only make things stricter.
MCP changes ask you in a numbered box; one-shot runs can't ask, so they are refused. The AI can't approve.
Known device secrets (passwords, keys, SNMP communities) in MCP results, config files and config-like command output are shown to the AI as <secret hidden> (best effort, known formats only); a change that carries the marker back is refused. See docs/SECRETS.md.
A plain terminal (TERM=dumb or output redirected) can't answer approvals.
Piped line input drops unfinished input when a question opens; NO_COLOR is supported.
LSP connection runs a configured program. Review .casper/lsp.json first.
An LSP rename asks you first; one-shot runs can't rename.
Web lookups (web_search, web_fetch) are on by default and never ask. They reach only public https pages on ports 80 and 443 (http is upgraded), checked again on every redirect; a search or address holding a secret is refused, never sent. Search is DuckDuckGo by default; web: { provider: brave } uses Brave Search with the key saved as "brave" in Casper's login file (~/.casper/agent/auth.json), and web: { provider: searxng, searxngUrl: <address> } your own SearXNG.
/settings turns them off (web: off in ~/.casper/config.yaml); a project file can't change web:.
Browser tasks use installed Chrome/Chromium (CASPER_BROWSER_EXECUTABLE overrides detection).
No automatic browser installation, personal profiles, account credentials or arbitrary page scripts.
Clicks and typing on your own local project pages may go ahead; anything with real effects, or unclear, asks you first. One-shot runs can't ask. Ordinary outside resources still load: this is not isolation.
Browser checks replay fixed scenarios; screenshots alone and model claims are not checks.
After a UI change Casper saves a desktop and a phone screenshot of each changed page (no tokens); a model that can see pictures is shown them once to check the look, after one question a session (1 No · 2 Yes, show the AI the pages; /settings: always or never). Advice, never a check.
Each checked page also gets accessibility notes under its line (images with no alt, fields with no label, nameless buttons, low contrast, no lang): notes, never a failure.
Task-owned development servers run the project's code in the shell sandbox (files held; the network is not limited, so the page can load), and stop with the task.
Saved screenshots (readable only by you) stay in Casper's project folder until you remove them; they may be sensitive.
See docs/BROWSER.md for limits, input freshness, supported assertions and remaining caveats.
Services from .casper/project.yaml run the project's code in the shell sandbox (files held; the network is not limited, so you can reach them); they stay up between prompts and stop on exit, /clear, /resume, /branch and /switch. Ctrl+C cancels only a startup. See docs/SERVICES.md.
/switch main apply and /switch main discard ask you first; /branch <name> and /switch <name> run as typed.
Helpers from /delegate get read/grep/find/ls only; no edit/write/bash/MCP/LSP and no helpers of their own.
For a big job with separate parts the AI starts builders itself (up to 3 at once; "run a crew" or "split this up" asks for it, "by yourself" stops it, /settings turns it off).
A builder edits and runs commands only in its own copy (a Git worktree), in the same sandbox; what would ask you is not run and is listed. No MCP, no helpers.
An AI-started builder's change lands in your folder when it ends, uncommitted (/undo takes it back with the task); one that touches a file changed meanwhile stays in its copy for /crew. See docs/CREWS.md.
Limits: 2 at once, 4 per request; 180 seconds/12 turns/48 tool calls each.
Children use Casper roles (explorer→fast, reviewer→review) or the startup default.
Their reports are advice; read-only tools are not an OS sandbox.
Learning uses the startup default; source text may reach the configured provider. No secret scrubbing.
Learning drafts are plain files only you can read, and they do nothing until you promote one. Promoting is your own local command, tied to the draft's exact text (its sha256); the model never chooses or approves.
Use local directories only; learn cannot be combined with --verify, --mcp or --lsp.
Applying a workspace's changes leaves them uncommitted; Casper never commits or pushes them.
Cleanup removes the workspace from git and keeps its files in a recovery folder it prints.
`;

/** `casper --help`: the command-line part of the full reference; the slash commands are inside Casper (/help). */
export const CLI_HELP_TEXT = `${FULL_HELP_TEXT.slice(0, FULL_HELP_TEXT.indexOf("\nLocal commands:"))}

Inside Casper, /help lists the commands and /help <word> searches them.
`;

/** Rows of the full reference: a command line with its own continuation lines, or one line of prose. */
function helpEntries(): string[][] {
  const entries: string[][] = [];
  for (const line of FULL_HELP_TEXT.split("\n")) {
    if (!line.trim() || /^(?:Usage|Local commands):$/.test(line) || line.startsWith("Casper — ")) continue;
    // A deeper-indented line continues the row above it.
    if (/^ {6,}\S/.test(line) && entries.length) entries.at(-1)!.push(line);
    else entries.push([line]);
  }
  return entries;
}

/** The command closest to a mistyped one, when it is close enough to be a typo. */
function closestCommand(word: string): string | undefined {
  const names = COMMAND_REGISTRY.filter((command) => !command.hidden).flatMap((command) => [command.name, ...command.aliases ?? []]);
  const near = closestWord(word.replace(/^\//, ""), names);
  return near && `/${near}`;
}

/** `/help <word>`: the lines of the full reference that mention the word, or a plain "nothing" with a did-you-mean. */
export function helpFor(word: string): string {
  const needle = word.trim().toLowerCase();
  const matches = helpEntries().filter((entry) => entry.join(" ").toLowerCase().includes(needle));
  if (matches.length) return `${matches.map((entry) => entry.join("\n")).join("\n")}\n`;
  const near = closestCommand(needle);
  return `[help] Nothing in the help mentions ${JSON.stringify(word.trim())}.${near ? ` Did you mean ${near}?` : ""} /help all shows everything.\n`;
}

/** The error for a slash command Casper doesn't know, with a did-you-mean when one is close. */
export function unknownCommandMessage(command: string): string {
  const near = closestCommand(command);
  const topic = TOPIC_COMMANDS[command.replace(/^\//, "").toLowerCase()];
  return `Unknown command ${JSON.stringify(command)}.${near ? ` Did you mean ${near}?` : topic ? ` ${topic}` : ""} Type /help for local commands.`;
}

/** Why a slash line can't run as typed (an unknown command, or words after one that takes none); undefined when it can. */
export function commandProblem(line: string): string | undefined {
  const parsed = parseCommandLine(line);
  if (!parsed) return unknownCommandMessage(line.trim().split(/\s+/)[0]!);
  // /new was the new-project command; it now starts a new conversation, like Claude Code and Pi.
  if (parsed.typed === "new" && parsed.args) return `/new now starts a new conversation, like /clear. For a new project type /project new ${parsed.args}`;
  if (parsed.args && !takesArguments(parsed.command)) return `Usage: /${parsed.typed}, with nothing after it.`;
  return undefined;
}

/** Words people type as a command for something that lives in another command, and where it is. */
const TOPIC_COMMANDS: Record<string, string> = {
  themes: "Themes are in /theme.", colour: "Themes are in /theme.", colours: "Themes are in /theme.",
  color: "Themes are in /theme.", colors: "Themes are in /theme.",
};

/**
 * Help text laid out for a terminal this wide. A command row whose words run past the edge continues under its own
 * description column; prose wraps at word breaks. With no width (piped or redirected output) the text is unchanged.
 */
export function wrapHelp(text: string, width: number | undefined): string {
  if (!width || width < 30) return text;
  return text.split("\n").map((line) => {
    if (line.length <= width) return line;
    const row = /^( +\S.*? {2,})(\S.*)$/.exec(line);
    const indent = row && row[1]!.length <= width - 20 ? row[1]!.length : (line.match(/^ */)![0].length);
    const head = row && indent === row[1]!.length ? row[1]! : line.slice(0, indent);
    const words = (row && indent === row[1]!.length ? row[2]! : line.slice(indent)).split(/ +/);
    const lines: string[] = [];
    let current = head;
    for (const word of words) {
      const fresh = current.length === indent;
      if (!fresh && current.length + 1 + word.length > width) { lines.push(current); current = " ".repeat(indent) + word; }
      else current += (fresh ? "" : " ") + word;
    }
    lines.push(current);
    return lines.join("\n");
  }).join("\n");
}
