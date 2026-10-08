import { type AutocompleteItem, type SlashCommand, visibleWidth } from "@earendil-works/pi-tui";

/** A fixed word after a command's name (`/mcp detail`), with what follows it and what it does. */
export interface Subcommand {
  readonly name: string;
  /** What follows the word, written as in /help all: `<name>`, `[dir]`, `on|off`. */
  readonly args?: string;
  readonly description: string;
  /** The words after this subcommand that run while a task works; without it the subcommand waits for the task. */
  readonly duringWork?: RegExp;
  /** It still runs after a failed cleanup: it inspects or stops what may still be running. */
  readonly afterCleanupError?: true;
}

/** One local command. The menu, autocomplete, the during-work and cleanup rules, the did-you-mean and the check for
 * words a command does not take all read this table; the handlers live in src/app (commands.ts, command-loop.ts). */
export interface CommandSpec {
  readonly name: string;
  readonly description: string;
  /** Other names for the same command; each is listed in the menu too. */
  readonly aliases?: readonly string[];
  /** Runs, but is not in the menu or the did-you-mean (Casper types it for you). */
  readonly hidden?: true;
  /** What may follow the name. With no hint and no subcommands the command takes nothing after its name. */
  readonly argumentHint?: string;
  readonly subcommands?: readonly Subcommand[];
  /** The words after the name ("" for none) that run while a task works, when they start with no subcommand. */
  readonly duringWork?: RegExp;
  /** More forms, beyond the during-work ones, that still run after a failed cleanup. */
  readonly afterCleanupError?: RegExp;
}

const NONE = /^$/;
const ANY = /^[\s\S]*$/;
const SESSION = /^(?:--session)?$/;

export const COMMAND_REGISTRY: readonly CommandSpec[] = [
  { name: "model", description: "Change model (remembered globally; --session for temporary)", argumentHint: "[provider/id]",
    // The picker or one model; role and big-model changes wait (they save settings).
    duringWork: /^(?:[^\s-]\S*)?$/, subcommands: [
      { name: "--session", args: "[model]", description: "Select without changing the startup default", duringWork: /^(?:[^\s-]\S*)?$/ },
      { name: "roles", description: "Show fast/build/reason/review role mappings", duringWork: NONE },
      { name: "role", args: "<fast|build|reason|review> <selector|clear>", description: "Save or clear a role mapping" },
      { name: "big", args: "<selector|clear>", description: "Set or clear your big model (the reason role)" },
    ] },
  { name: "effort", description: "Reasoning effort, including auto; Shift+Tab cycles and remembers it", argumentHint: "[level|auto] [--session]",
    duringWork: /^(?:[^\s-]\S*(?:\s+--session)?)?$/ },
  { name: "status", description: "Inspect project, model, auth and integrations", duringWork: NONE },
  { name: "help", description: "Find a command; /help all shows the full reference", argumentHint: "[word|all]", duringWork: ANY,
    subcommands: [{ name: "all", description: "The full reference", duringWork: ANY }] },
  { name: "context", description: "Inspect context estimates and capability counts", duringWork: NONE },
  { name: "usage", description: "Inspect session tokens and available cost estimates", duringWork: NONE },
  { name: "compact", description: "Summarize context (sends a model request)", argumentHint: "[instructions]" },
  { name: "clear", description: "Start a fresh conversation; keep files and saved conversations" },
  { name: "resume", description: "Go back to a saved conversation (a numbered list)", argumentHint: "[id]" },
  { name: "diff", description: "The last task's changes: /diff 12, /diff list", argumentHint: "[n|list]", duringWork: /^(?:\d+)?$/,
    subcommands: [{ name: "list", description: "Pick a task's changes from a list", duringWork: NONE }] },
  { name: "undo", description: "Put the last task's files back (no model)", argumentHint: "[n]" },
  { name: "redo", description: "Put an undone task's files back again", argumentHint: "[n]" },
  { name: "new", description: "Start a new project in ~/Projects (no model)", argumentHint: "[name]" },
  { name: "plan", description: "Plan first: the model writes a plan and cases to test, then you build", argumentHint: "<request>" },
  { name: "suggestions", description: "Suggested next steps: list, or turn on or off", subcommands: [
    { name: "on", args: "[name]", description: "Turn every suggestion, or one, on" },
    { name: "off", args: "[name]", description: "Turn every suggestion, or one, off" },
  ] },
  { name: "pane", description: "Steps in a split beside Casper (tmux, iTerm2): /pane on or /pane off, saved", duringWork: NONE, subcommands: [
    { name: "on", description: "Show the steps beside Casper; saved", duringWork: NONE },
    { name: "off", description: "No split; saved", duringWork: NONE },
  ] },
  { name: "details", description: "How much work shows: quiet, normal or detailed, remembered (Ctrl+T: the last step in full)",
    argumentHint: "[quiet|normal|detailed] [--session]", duringWork: SESSION, subcommands: [
      { name: "quiet", args: "[--session]", description: "Failures only", duringWork: SESSION },
      { name: "normal", args: "[--session]", description: "Steps folded (the default)", duringWork: SESSION },
      { name: "detailed", args: "[--session]", description: "Every step with small diffs", duringWork: SESSION },
    ] },
  { name: "settings", description: "Turn web lookups, spend notes, built-in skills and more on or off by number" },
  { name: "output", description: "Full command and output of a recent tool call (/output [n|all])", argumentHint: "[n|all]", duringWork: /^(?:\d+)?$/,
    subcommands: [{ name: "all", description: "Every tool call of the last task on its own line", duringWork: NONE }] },
  { name: "verify", description: "Run repository verification checks", argumentHint: "[checks ...]", subcommands: [
    { name: "repair", args: "[checks ...]", description: "Run checks and authorize bounded repair" },
    { name: "add", args: "<name>", description: "Save a ready-made check Casper found" },
  ] },
  { name: "security-review", description: "Run the pinned security tools here, then offer an AI review (asks first)", subcommands: [
    { name: "ai", description: "The same; where Casper can't ask, runs the AI review" },
    { name: "update", description: "Download osv-scanner's advisory data (asks first)" },
    { name: "ignores", description: "List ignores you approved; approve or remove them" },
  ] },
  { name: "receipt", description: "A saved receipt: /receipt 12, /receipt list", argumentHint: "[n|list]", duringWork: /^(?:\d+)?$/,
    subcommands: [{ name: "list", description: "The last 10 saved receipts", duringWork: NONE }] },
  { name: "project", description: "Inspect project stack, configuration and checks", argumentHint: "[name]", duringWork: NONE },
  { name: "skills", description: "Inspect skill metadata, trust and warnings", duringWork: NONE, subcommands: [
    { name: "diagnostics", description: "Why a skill was skipped or warned about" },
    { name: "inspect", args: "<id>", description: "A skill and its fingerprint (sha256)" },
    { name: "trust", args: "<id>", description: "Show a skill, then 1 No · 2 Trust it" },
    { name: "block", args: "<id>", description: "Never use this skill" },
  ] },
  { name: "pack", description: "Skill packs: add one from a folder or GitHub (asks first), list, remove", subcommands: [
    { name: "add", args: "<folder or link>", description: "Add a skill pack (asks first)" },
    { name: "list", description: "The packs you added" },
    { name: "remove", args: "<name>", description: "Take a pack out" },
  ] },
  { name: "mcp", description: "MCP status; connect, disconnect, writes on/off, forget, docs servers", duringWork: NONE, subcommands: [
    { name: "detail", args: "[name]", description: "The full status of every server, or one (no connection)" },
    { name: "setup", args: "network|ssh", description: "Set up Casper's network server, or a server over ssh" },
    { name: "login", args: "[mist|central|clearpass] [forget]", description: "Add, replace or forget a network login" },
    { name: "connect", args: "<name>", description: "Connect this server" },
    { name: "disconnect", args: "<name>", description: "Disconnect and revoke consent for this process", afterCleanupError: true },
    { name: "reload", description: "Re-read MCP files; changed servers need consent again" },
    { name: "writes", args: "<name>|off", description: "Turn writes on for one server, or off for every server" },
    { name: "allow", args: "<name> [off]", description: "Risky change kinds a server may make" },
    { name: "forget", args: "<name>", description: "Forget a remembered server" },
    { name: "junos-show", args: "<name> on|off", description: "Let plain Junos show commands run without asking" },
    { name: "sandbox", args: "<name> on|off", description: "Run a server Casper knows in the sandbox or not" },
    { name: "docs", description: "Docs servers; add a docs-only copy" },
  ] },
  { name: "lsp", description: "Inspect language-server status; connect or disconnect", duringWork: NONE, subcommands: [
    { name: "connect", args: "<name>", description: "Authorize this language server for this process" },
    { name: "disconnect", args: "<name>", description: "Stop this language server", afterCleanupError: true },
  ] },
  { name: "browser", description: "Inspect a disposable browser; capture a screenshot", afterCleanupError: NONE, subcommands: [
    { name: "open", args: "<url>", description: "Open an HTTP(S) page in a disposable browser" },
    { name: "inspect", description: "What the page shows now" },
    { name: "diagnostics", description: "What the page shows now, with its problems" },
    { name: "screenshot", description: "Save a viewport PNG" },
    { name: "close", description: "Close the browser", afterCleanupError: true },
  ] },
  { name: "services", description: "Declared services: status, logs, start, restart, stop", afterCleanupError: NONE, subcommands: [
    { name: "logs", args: "<name>", description: "Recent log lines of a service", afterCleanupError: true },
    { name: "start", args: "<name>", description: "Start it and wait for readiness" },
    { name: "restart", args: "<name>", description: "Restart it" },
    { name: "stop", args: "<name>", description: "Stop it", afterCleanupError: true },
  ] },
  { name: "preview", description: "Open your web app on a phone on the same Wi-Fi; a public link only after a yes",
    subcommands: [{ name: "stop", description: "Stop sharing it" }] },
  { name: "tasks", description: "What runs in the background (dev servers, helpers, checks); stop one", duringWork: NONE,
    subcommands: [{ name: "stop", args: "<n>|all", description: "Stop one of them, or all", duringWork: /^(?:\d+|all)$/, afterCleanupError: true }] },
  { name: "debug", description: "Inspect local targets; approve launch and debug code", afterCleanupError: NONE, subcommands: [
    { name: "start", args: "<target>", description: "Start the debugger and your program (asks first)" },
    { name: "breakpoints", args: "<path> <lines|clear>", description: "Replace one file's breakpoint lines" },
    { name: "threads", description: "Show threads" },
    { name: "stack", args: "<thread>", description: "One thread's stack" },
    { name: "scopes", args: "<frame>", description: "The scopes of a frame" },
    { name: "variables", args: "<handle>", description: "Show values (may contain secrets)" },
    { name: "continue", args: "<thread>", description: "Resume a thread" },
    { name: "stop", description: "End the debug session", afterCleanupError: true },
  ] },
  // After a failed cleanup /doctor is how you look into it.
  { name: "doctor", description: "Check Casper's own setup and fix what it can (no model, asks first)", afterCleanupError: NONE },
  { name: "permissions", description: "What Casper may do here, and how to be asked less", duringWork: NONE, subcommands: [
    { name: "all", description: "Stop the asking until you quit (session only)" },
    { name: "ask", description: "Ask again" },
    { name: "write", args: "<folder>", description: "Allow a folder for this project" },
    { name: "forget", args: "<folder>", description: "Take a folder back" },
  ] },
  { name: "sandbox", description: "What the shell sandbox holds here; forget a remembered host", duringWork: NONE,
    subcommands: [{ name: "forget", args: "<host>", description: "Forget a host you allowed for this project" }] },
  { name: "allowed", description: "The shell commands you said yes to for this project; forget one", duringWork: NONE,
    subcommands: [{ name: "forget", args: "<n>", description: "Forget one by its number or words, or all of them" }] },
  { name: "lab", description: "Your lab devices; /lab import <file> marks more; /lab ssh off makes ssh to them ask", subcommands: [
    { name: "import", args: "<file>", description: "Add devices to your lab list from a file (asks first)" },
    { name: "ssh", args: "on|off", description: "Whether ssh and scp to lab devices ask first" },
  ] },
  { name: "tree", description: "Inspect named conversations and workspaces", duringWork: NONE },
  { name: "branch", description: "Create a named workspace conversation (requires approval)", argumentHint: "<name>" },
  { name: "switch", description: "Switch named workspace conversation (requires approval)", argumentHint: "<branch> [apply|discard]" },
  { name: "memory", description: "Manage explicit project facts and inspect task outcomes", subcommands: [
    { name: "remember", args: "<fact>", description: "Save a project fact (no model)" },
    { name: "forget", args: "<id>", description: "Remove a fact" },
    { name: "outcomes", description: "The latest 20 task outcomes" },
    { name: "accept", args: "<id> <yes|no>", description: "Record whether you accept a task's result" },
  ] },
  { name: "references", description: "Search local reference projects; add a vendor spec repo", subcommands: [
    { name: "search", args: "<id|*> <query>", description: "Search reference text locally (no model)" },
    { name: "add", args: "[name] [release]", description: "Download a vendor spec repo (asks first)" },
  ] },
  { name: "secrets", description: "Show what Casper hides from the AI", duringWork: NONE,
    subcommands: [{ name: "files", args: "on|off", description: "Scrub config files and command output" }] },
  { name: "visualize", description: "Inspect providers or render repository dependencies",
    subcommands: [{ name: "repo", args: "[dir]", description: "Render repository dependencies locally (no model)" }] },
  { name: "delegate", description: "Ask a bounded read-only subagent (uses a model)", subcommands: [
    { name: "explorer", args: "<goal>", description: "A read-only helper that explores" },
    { name: "reviewer", args: "<goal>", description: "A read-only helper that reviews" },
  ] },
  { name: "crew", description: "A builder does a job in its own copy of the project; you apply it (uses a model)", argumentHint: "[job]", subcommands: [
    { name: "apply", args: "<n>", description: "Apply a crew copy to your folder" },
    { name: "drop", args: "<n>", description: "Throw a crew copy away" },
  ] },
  { name: "login", description: "Set up provider credentials in a private login flow", subcommands: [
    { name: "openai-codex", description: "Sign in to Codex" },
    { name: "github-copilot", description: "Sign in to Copilot" },
    { name: "anthropic", description: "Sign in to Anthropic" },
    { name: "openrouter", description: "Sign in to OpenRouter" },
  ] },
  { name: "exit", description: "Leave Casper", aliases: ["quit"], afterCleanupError: NONE },
  // A receipt's numbered suggestion: Casper types it when you pick one (src/app/suggestions.ts).
  { name: "suggestion", description: "Run a suggested next step", argumentHint: "<id>", hidden: true },
];

/** The command a typed name runs (its own name or an alias), with or without the leading "/". */
export function findCommand(name: string): CommandSpec | undefined {
  const typed = name.replace(/^\//, "");
  return COMMAND_REGISTRY.find((command) => command.name === typed || command.aliases?.includes(typed));
}

/** Whether anything may follow the command's name. */
export function takesArguments(command: CommandSpec): boolean {
  return command.argumentHint !== undefined || Boolean(command.subcommands?.length);
}

/** A typed line read against the table: the command, the words after its name, and the subcommand they start with. */
export function parseCommandLine(line: string): { command: CommandSpec; typed: string; args: string; subcommand?: Subcommand; rest: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(line.trim());
  const command = match && findCommand(match[1]!);
  if (!command) return undefined;
  const args = (match[2] ?? "").trim();
  const first = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args);
  const subcommand = first ? command.subcommands?.find((sub) => sub.name === first[1]) : undefined;
  return { command, typed: match[1]!, args, ...(subcommand ? { subcommand } : {}), rest: subcommand ? (first![2] ?? "").trim() : args };
}

/** This line runs now during a task; every other line waits for the task to end. */
export function runsDuringWork(line: string): boolean {
  const parsed = parseCommandLine(line);
  if (!parsed) return false;
  return parsed.subcommand ? Boolean(parsed.subcommand.duringWork?.test(parsed.rest)) : Boolean(parsed.command.duringWork?.test(parsed.args));
}

/** This line still runs after a failed cleanup: what runs during work (it only shows something), and the forms that
 * inspect or stop what may still be running. */
export function runsAfterCleanupError(line: string): boolean {
  const parsed = parseCommandLine(line);
  if (!parsed) return false;
  if (runsDuringWork(line)) return true;
  return parsed.subcommand ? Boolean(parsed.subcommand.afterCleanupError) : Boolean(parsed.command.afterCleanupError?.test(parsed.args));
}

/** For the menu during a task: whether `/name` alone, or `/name subcommand`, runs now (one with words after it runs
 * when they fit its rule). */
export function menuRunsDuringWork(name: string, subcommand?: string): boolean {
  const command = findCommand(name);
  if (!command) return false;
  if (subcommand === undefined) return Boolean(command.duringWork?.test(""));
  return Boolean(command.subcommands?.find((sub) => sub.name === subcommand)?.duringWork);
}

/** The subcommands that complete what is typed after `/name `; none once a whole word or more is typed. */
export function subcommandItems(command: CommandSpec, typed: string): AutocompleteItem[] | null {
  const word = typed.trimStart();
  if (/\s/.test(word)) return null;
  const found = (command.subcommands ?? []).filter((sub) => sub.name.startsWith(word));
  if (!found.length || (found.length === 1 && found[0]!.name === word)) return null;
  return found.map((sub) => ({ value: sub.args ? `${sub.name} ` : sub.name, label: sub.args ? `${sub.name} ${sub.args}` : sub.name, description: sub.description }));
}

/** The / menu: every command that is not hidden, and each alias on its own row. */
export const COMMANDS: SlashCommand[] = COMMAND_REGISTRY.filter((command) => !command.hidden).flatMap((command) => [
  { name: command.name, description: command.description, ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    ...(command.subcommands?.length ? { getArgumentCompletions: (typed: string) => subcommandItems(command, typed) } : {}) },
  ...(command.aliases ?? []).map((alias) => ({ name: alias, description: `${command.description} (same as /${command.name})` })),
]);

/** Pi's command menu cuts a long description at the column, mid-word and with no mark. Trimmed here first: it ends at
 * a word, with "…". Mirrors Pi's slash-menu layout (a 12-32 column label, two columns of margin); verified against
 * @earendil-works/pi-tui 0.87.0 (SelectList.renderItem). `width` is the menu's width. */
export function fitDescriptions<T extends { value: string; label?: string; description?: string }>(items: readonly T[], width: number): T[] {
  if (width <= 40) return [...items];
  const widest = Math.max(0, ...items.map(item => visibleWidth(item.label || item.value)));
  const column = Math.min(Math.max(widest + 2, 12), 32, width - 6);
  const room = width - 2 - column - 2;
  if (room <= 10) return [...items];
  return items.map(item => {
    const text = item.description;
    if (!text || visibleWidth(text) <= room) return item;
    const cut = text.slice(0, room - 1);
    const space = cut.lastIndexOf(" ");
    return { ...item, description: `${(space > room / 2 ? cut.slice(0, space) : cut).trimEnd()} …` };
  });
}
