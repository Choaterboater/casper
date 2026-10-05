import { COMMANDS } from "./commands";
import { WRITES_OFF_MEANING } from "../mcp/presets";
import { UPDATE_HELP } from "../cli-args";
import { NEW_HELP_LINE } from "../new/templates";

export const HELP_TEXT = `Casper — your coding companion

Type a request and press Enter (during a task it steers the AI or waits in the queue). Esc stops work. Type / for every command.
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
Ctrl+T shows the last step in full. Ctrl+C twice on an empty line exits. Approvals always need a fresh yes from you.
`;

export const LOGIN_HELP = `Sign-in needs an interactive terminal. Run casper and type /login.
Never paste keys or tokens into chat.
`;

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
  /status                           Model, sign-in and integration status
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
  /resume [id]                      Pick a saved conversation (or give the start of its ID)
  /diff [n|list]                    Task n's changes (default: the last task in this folder), also outside git; list picks one. Before any task in this folder: git status plus tracked diff against HEAD
  /undo [n]                         Put back the files of the last task (or task n); files changed since are left alone
  /redo [n]                         Put an undone task's files back as the task left them
  /new [name]                       Start a new project in ~/Projects (no model); before the model starts, Casper opens it
  /new <template> <name>            The same without questions; /new --list shows the templates
  /output [n]                       Full command and output of a recent tool call (1 = latest; last 20 kept per task)
  /output all                       Every tool call of the last task on its own line (the screen folds them into a summary)
  /details [quiet|normal|detailed] [--session]  Failures only, steps folded (default), or every step with small diffs; remembered like /effort, --session for this session only. Ctrl+T shows the last step in full
  /settings                         Your switches by number, written to ~/.casper/config.yaml for you: web lookups, the new-version notice, built-in skills, spend notes, spend pause, showing the AI the pages, work shown
  /receipt                          Detailed evidence receipt of the last model task (freshness, scope), also after a restart
  /receipt <n>, /receipt list       A saved receipt, or the last 10 (saved with secrets hidden)
  /permissions                      What each tool may do and when Casper asks you
  /sandbox                          What the shell sandbox holds: write folders, private folders, hosts
  /sandbox forget <host>            Forget a host or machine you allowed for this project (Yes, always)
  /lab                              Your lab devices: lab checks and the lab list use them
  /lab import <file>                Add devices to your lab list from a file (GreenCLI's lab export, or one host per line); asks first
  /login [provider]                 Codex, Copilot, Anthropic or OpenRouter (Casper's credential store)
  /project                          Show project context
  /project <name>                   Open a project folder inside this one, or offer to make it (before the model starts)
  /memory                           List project facts you saved
  /memory remember <fact>           Save a project fact (no model)
  /memory forget <id>               Remove a fact
  /memory outcomes                  Show the latest 20 task outcomes
  /memory accept <id> <yes|no>      Record whether you accept a task's result (this is not test evidence)
  /references                       List configured local reference sources
  /references search <id|*> <query> Search reference text locally (no model)
  /references add [name] [release]  Download a vendor spec repo to search locally (asks first)
  /secrets                          Show what Casper hides from the AI
  /secrets files on|off             Scrub config files and command output (MCP results always)
  /tree                             Show named conversations and their workspaces
  /branch <name>                    Copy this conversation into a named one with its own workspace (asks first)
  /switch <branch>                  Switch to a named conversation and its workspace (asks first)
  /switch main apply                Check, review and apply that workspace's changes, then clean up
  /switch main discard              Review and throw away that workspace's changes, then clean up
  /delegate <explorer|reviewer> <goal>  Run a read-only helper AI on one goal (uses a model)
  /skills                           List skills and whether you trust them
  /skills diagnostics               Show why a skill was skipped or warned about
  /skills inspect <id>              Show a skill and its fingerprint (sha256)
  /skills trust <id>                Show a skill, then 1 No · 2 Trust it (exactly what was shown)
  /skills block <id>                Never use this skill
  /mcp                              Show MCP status, secrets hidden (no connection)
  /mcp setup network                Set up Casper's network server (Mist, Central, ClearPass): 1 Not now · 2 Set it up
  /mcp login [mist|central|clearpass] [forget]  Add, replace or forget a network login; only you type it
  /mcp connect <name>               Connect this server; your own or imported ones can be remembered
  /mcp disconnect <name>            Disconnect and revoke consent for this process
  /mcp reload                       Re-read MCP files; changed servers need consent again
  /mcp writes <name>                Turn writes on for one server (you pick 2 in the box)
  /mcp writes off                   Writes off for every server (ctrl+o does the same)
  /mcp allow <name> [off]           Pick which risky change kinds (firmware, delete, admin) a server may make; off goes back to the defaults
  /mcp forget <name>                Forget a remembered server; Casper asks again next time
  /mcp junos-show <name> on|off     Let plain Junos show commands run without asking
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
  /visualize repo [dir]             Render repository dependencies locally (no model)
  /verify [checks ...]              Run this project's checks (in the sandbox), without a model
  /verify repair [checks ...]       Run checks and authorize bounded repair
  /verify add <name>                Save a ready-made check Casper found (Ansible) in .casper/project.yaml
  /verify <lab check>               Run a lab check on your own lab (lab.hosts); asks first, never auto
  /security-review                  Run the pinned security tools here (no model), then offer an AI review: 1 Stop here · 2 Run the AI review, with its cost; Enter spends nothing
  /security-review ai               The same; where Casper can't ask (one-shot, --json), runs the AI review
  /security-review update           Download osv-scanner's advisory data (asks first)
  /security-review ignores          List ignores you approved; approve or remove them
  /exit, /quit                      Exit interactive mode; no-op in one-shot mode

Unknown slash commands are rejected locally, never sent to a model.
/model: Enter selects and saves ~/.casper/settings.json; Ctrl+S selects for this session only. Exact IDs are remembered too; /model --session <id> opts out.
/effort remembers supported levels per model; /effort <level> --session opts out.
Shift+Tab cycles auto and the model's supported levels and saves the level it stops at, like /effort. One-off --effort never saves.
/effort auto lets Casper pick per request: low for reading/explaining/diagrams, medium for tests and configuration, high for fixes, features and refactors, from the model's supported levels.
Context is estimated and may be unavailable; cost estimates are not subscription billing.
/clear keeps saved conversations and workspace files. /resume takes the start of an ID; /switch uses workspace names.
Esc/Ctrl-C cancel the picker. Plain/redirected terminals list models; use an exact ID to select.
Restored conversations keep their model; a missing or unavailable model blocks sending.
Without a restored selection or Casper default, choose with /model; there is no other fallback.
Switching provider sends the rest of the conversation to that provider.
The picker refreshes provider catalogs over the network when CASPER_OFFLINE=1 is not set; selection does not generate a model response.
Provider-defined credential checks may run configured key-resolution commands.
Keys: Esc stops work. Ctrl-C cancels work; idle, it clears a draft; twice on empty exits. Ctrl+T shows the last step in full (an edit's diff, a command's output). Ctrl+O turns MCP writes off. Ctrl+L redraws the screen. Ctrl+V (Alt+V on Windows) pastes a picture from the clipboard as [image 1]; a dropped picture file works too. Shift+Enter (when supported) or Ctrl+J inserts a newline; Up/Down recalls history. Tab completes commands and file paths (@). Enter during work sends your line to the AI (it reads it at its next step) or queues it for after the task; Esc gives queued lines back. A queued line never answers an approval.
Checks: typecheck lint test build (all configured by default; verification.checks selects).
verification.mode: auto (Casper runs the checks after edits, repairs failures within repair.maxAttempts), offer (the model may use casper_check; the receipt suggests /verify) or off. Unset: auto, except that interactive sessions use offer once the checks are measured at 60 s or more.
--verify selects auto and --no-verify selects off for one run. Auto skips checks when no files changed, and checks whose declared scope misses every changed file. The receipt says why.
Checks run the project's own commands in the shell sandbox where it can run (/sandbox): they write only the project, temp and package caches, can't read your private folders and reach only listed hosts. Without the sandbox (Windows, bubblewrap missing, --no-sandbox) they run with your permissions.
One-shot exit codes: 0 pass (or nothing to verify), 1 check failed or blocked, 2 incomplete (skipped checks, --max-turns reached, or --verify with changes and no checks configured), 3 not verified (--require-verification only), 64 usage error, 130 cancelled.
Exit 0 does not certify behavior beyond the checks; /receipt shows scope and freshness.
MCP connection runs a configured program or contacts its URL. Review its source first.
Servers from ~/.claude.json, ~/.mcp.json and VS Code are listed too; each needs /mcp connect once.
Every MCP server starts with writes off. ${WRITES_OFF_MEANING} /mcp writes <name> turns writes on; ctrl+o turns them off again. A remembered server always starts with writes off.
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
Task-owned development servers run the project's code in the shell sandbox (files held; the network is not limited, so the page can load), and stop with the task.
Saved screenshots (readable only by you) stay in Casper's project folder until you remove them; they may be sensitive.
See docs/BROWSER.md for limits, input freshness, supported assertions and remaining caveats.
Services from .casper/project.yaml run the project's code in the shell sandbox (files held; the network is not limited, so you can reach them); they stay up between prompts and stop on exit, /clear, /resume, /branch and /switch. Ctrl+C cancels only a startup. See docs/SERVICES.md.
/branch, /switch and making or removing a workspace ask you first.
Helpers from /delegate get read/grep/find/ls only; no edit/write/bash/MCP/LSP and no helpers of their own.
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
  const typed = word.replace(/^\//, "").toLowerCase();
  if (!typed) return undefined;
  let best: { name: string; distance: number } | undefined;
  for (const name of [...COMMANDS.map((command) => command.name), "quit"]) {
    const distance = editDistance(typed, name);
    if (distance <= Math.max(1, Math.min(2, Math.floor(name.length / 3))) && (!best || distance < best.distance)) best = { name, distance };
  }
  return best && `/${best.name}`;
}

function editDistance(a: string, b: string): number {
  // Damerau (one swap of neighbours counts as one edit): "sttaus" is one edit from "status".
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
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
  return `Unknown command ${JSON.stringify(command)}.${near ? ` Did you mean ${near}?` : ""} Type /help for local commands.`;
}

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
